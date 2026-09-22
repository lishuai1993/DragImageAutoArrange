import { CLASSES, RESIZE_HANDLE_SIZE } from "../constants";
import { ImageMeta } from "../imageParse/imageDetector";
import { logger } from "../logger";
import * as scrollDiag from "../scrollSync/scrollDiag";
const log = logger.channel("resize");

/** Crop anchor for a zoomed image: centred on both axes, whatever the alignment
 *  setting says.  It has to be claimed inline with `!important` — the alignment
 *  pass owns `object-position` on the same element under the same priority, so
 *  neither a plain declaration nor a stylesheet rule could take it back. */
const ZOOM_CROP_ANCHOR = "center";

export interface HandleDef {
  el: HTMLElement;
  relX: number; // 0=left, 0.5=center, 1=right (relative to image content rect)
  relY: number; // 0=top, 0.5=center, 1=bottom (relative to image content rect)
}

/**
 * Narrow host interface the ResizeHandleController needs from ImageRowWidget.
 * Array accessors return the widget's *current* fields; geometry helpers
 * (getImageContentRect/updateHandlePositions) live on the widget because they
 * are shared with the layout core.
 */
export interface ResizeHost {
  getContainer(): HTMLElement | null;
  /** 0-based first line of the row the item belongs to (diagnostics window). */
  getGroupLineStart(): number;
  getItemEls(): HTMLElement[];
  getImageEls(): HTMLImageElement[];
  /** Space one junction between adjacent items occupies, dividers included —
   *  the row width left to the items.  Not the CSS `gap`. */
  getInterItemSpace(): number;
  /** Percent of a neighbour's height within which the drag counts as reaching
   *  it.  The same figure the divider drag snaps on. */
  getSnapSensitivity(): number;
  getLoadedMeta(index: number): ImageMeta | undefined;
  getImageContentRect(index: number): { left: number; top: number; width: number; height: number } | null;
  getObjectPosition(): string;
  updateHandlePositions(index: number): void;
  /** True when an odd quarter turn is drawn for this member, i.e. what is on
   *  screen is smaller than (and not the same shape as) the image's layout box. */
  isTurnedImage(index: number): boolean;
  /** The layout-box height that paints as `drawnHeight` for this member — the
   *  identity unless it is turned, where the drawing is the box scaled down. */
  boxHeightForDrawn(drawnHeight: number, index: number): number;
  /** The drawn height at which this member's layout box exactly fills its cell —
   *  the far end of a resize drag.  Past it a taller box only spills out of the
   *  cell (the picture is clipped) while the row keeps growing, so the drag is
   *  void there.  0 when the row cannot say: no bitmap, or no measured cell. */
  maxDrawnHeight(index: number): number;
  /** Record the box a drag just wrote for one member, so the layout model holds
   *  the drag's rectangle rather than the one the last layout pass solved for.
   *  A member's model box is otherwise only ever written by a layout pass, and
   *  the first pass after a drag would treat the drag's own box as foreign. */
  noteDragGeometry(index: number, boxHeight: number, drawnHeight: number): void;
  /** Replay that member's orientation against the box as it now stands and
   *  re-fit a lone image's item to the drawing. */
  syncItemToDrawing(index: number): void;
  notifyLayoutChange(): void;
  emitResizeEnd(index: number, flexGrow: number): void;
  setImageScale(index: number, scale: number): void;
  setSingleImageWidth(widthPx: number): void;
  /**
   * Light the equilibrium bar on the divider at one side of `index`, or clear
   * the one this drag lit (`side === null`).  Returns false when the row has no
   * divider there to light — the dividers are switched off — which the drag
   * reads as "this row cannot show a snap" and honours by not snapping: a height
   * that locks with nothing on screen to explain it is worse than no snapping.
   */
  setResizeSnapSide(index: number, side: "left" | "right" | null): boolean;
}

/** Which neighbour a resize drag has locked onto, and the height it asks for. */
type SnapSide = "left" | "right";

/**
 * Builds the 8 resize handles (4 corners + 4 edge midpoints) for a flex item
 * and wires their drag behaviour (feedforward width/height scaling with scale
 * persistence on mouseup).  Returns the created handles plus their HandleDef
 * array, which the widget stores for handle-position updates.
 */
export class ResizeHandleController {
  constructor(private host: ResizeHost) {}

  /**
   * Which neighbour's snap zone the pointer has reached, if any, and the height
   * that side asks for.
   *
   * `previous` is the side the drag locked on last time.  A zone that still
   * holds the pointer keeps its claim, and that is the whole of "whichever zone
   * the drag reached first wins" — leaving a zone drops the claim, and the next
   * move resolves a fresh one.  Deciding purely on proximity instead would let a
   * drag that is sitting in one zone flip to the other and back.
   *
   * With no claim to keep: the reached side takes it, and when both zones hold
   * the pointer at once — the two neighbours closer together than two zones —
   * the nearer target wins, an exact tie falling left.  The tie is geometrically
   * meaningless (both sides ask for the same height and differ only in which
   * divider lights), so the rule only has to be deterministic.
   *
   * A side whose neighbour has no height of its own — the row has not laid that
   * member out yet — never claims, and neither does one standing above this
   * member's `ceiling`: a box may not grow wider than its cell, so that height
   * cannot be reached at all, and a bar lit for it would announce an equality
   * the row cannot show.
   *
   * That exclusion is one pixel shy of exact, by construction: the ceiling and
   * the neighbour's height are the *same* length put through two different
   * roundings — the drag's own, and the height model's `Math.round` — so a
   * neighbour that *is* the equality can sit a pixel above the ceiling.  The
   * band is `ceiling + 1` rather than `ceiling` so that the equality the bar
   * exists to announce is not the thing it throws away.
   */
  private resolveSnapSide(
    index: number,
    rawHeight: number,
    zone: number,
    neighbourHeights: readonly number[],
    previous: SnapSide | null,
    ceiling: number
  ): { side: SnapSide | null; height: number } {
    const targets: Array<{ side: SnapSide; height: number }> = [];
    if (index > 0) targets.push({ side: "left", height: neighbourHeights[index - 1] });
    if (index + 1 < neighbourHeights.length) {
      targets.push({ side: "right", height: neighbourHeights[index + 1] });
    }

    const reached = targets.filter(
      (t) =>
        zone > 0 &&
        t.height > 0 &&
        t.height <= ceiling + 1 &&
        Math.abs(rawHeight - t.height) <= t.height * zone
    );
    if (reached.length === 0) return { side: null, height: rawHeight };
    const kept = reached.find((t) => t.side === previous);
    if (kept) return kept;

    let best = reached[0];
    for (const t of reached) {
      if (Math.abs(rawHeight - t.height) < Math.abs(rawHeight - best.height)) best = t;
    }
    return best;
  }

  buildHandles(
    item: HTMLElement,
    index: number
  ): { handles: HTMLElement[]; defs: HandleDef[] } {
    const handles: HTMLElement[] = [];

    const defs: HandleDef[] = [
      { el: null!, relX: 0, relY: 0 },     // nw corner
      { el: null!, relX: 1, relY: 0 },     // ne corner
      { el: null!, relX: 0, relY: 1 },     // sw corner
      { el: null!, relX: 1, relY: 1 },     // se corner
      { el: null!, relX: 0.5, relY: 0 },   // n edge midpoint
      { el: null!, relX: 0.5, relY: 1 },   // s edge midpoint
      { el: null!, relX: 0, relY: 0.5 },   // w edge midpoint
      { el: null!, relX: 1, relY: 0.5 },   // e edge midpoint
    ];

    const cursors = ["nw-resize", "ne-resize", "sw-resize", "se-resize",
      "n-resize", "s-resize", "w-resize", "e-resize"];

    for (let i = 0; i < defs.length; i++) {
      const hd = defs[i];
      const handle = createDiv();
      handle.className = CLASSES.resizeHandle;
      // Use setProperty with "important" to defend against Obsidian CSS
      // that may apply !important overrides inside .cm-embed-block elements.
      const important = (k: string, v: string) => handle.style.setProperty(k, v, "important");
      important("position", "absolute");
      important("width", `${RESIZE_HANDLE_SIZE}px`);
      important("height", `${RESIZE_HANDLE_SIZE}px`);
      important("border-radius", "2px");
      important("background-color", "#4a9eff");
      important("border", "1px solid white");
      important("z-index", "2");
      handle.style.cursor = cursors[i];

      // Resize drag — feedforward: compute target flex-grow directly
      // from cursor position so the handle follows the cursor 1:1 without
      // overshoot/oscillation.
      //
      // In a multi-image row the drag also snaps: a neighbour's height the
      // pointer comes within a zone of pulls the picture onto it and lights that
      // side's divider.  `snappedSide` is the side that claim currently sits on,
      // remembered across moves so the bar tracks a drag that leaves one zone for
      // the other rather than flickering; cleared with the drag.
      let dragging = false;
      let snappedSide: SnapSide | null = null;
      /** Whether a multi-image drag has changed the height it was given.  A drag
       *  the ceiling holds still — or a click that never moved — writes nothing. */
      let moved = false;
      /** Whether the drag has taken this member to the ceiling, i.e. to the
       *  height where its box spans the cell.  That height *is* 满格, so it is
       *  recorded as exactly 1 rather than as the ratio a measurement implies —
       *  the box height's own rounding leaves the box a hair inside the cell, and
       *  the measurement would report 99 for what is meant to be full. */
      let atCeiling = false;
      let currentOnMove: ((e: MouseEvent) => void) | null = null;
      let currentOnUp: (() => void) | null = null;

      // Capture layout state at mousedown for width-based feedforward.
      // Converts cursor dx → item width change → flex-grow, so left/right
      // handles scale symmetrically despite the nonlinear flex→width mapping.
      let AW = 0;
      let startHeight = 0;
      let startDisplayH = 0;
      let startItemHeights: number[] = [];
      let nItems = 0;
      handle.onmousedown = (e) => {
        try {
        dragging = true;
        snappedSide = null;
        moved = false;
        atCeiling = false;
        item.classList.add(CLASSES.resizing);
        log.debug("resize-mousedown", { index, timestamp: Date.now(), relX: hd.relX, relY: hd.relY });
        // TEMP-DIAG（拖拽缩放 → Cmd+Z 取证）：手柄拖拽落了盘就产生一次文档变更，
        // 若紧随其后的撤销没被这条路径消化，画面会停在拖拽结果上而笔记已还原。
        // 开一段长观测窗罩住随后的 Cmd+Z —— keydown、逐帧 scrollTop 与 widget 的
        // eq/toDOM 判定都会落到日志里。诊断完即删。
        scrollDiag.openViewportWatchFor(handle, 30000, this.host.getGroupLineStart());
        e.preventDefault();
        e.stopPropagation();

        // Snapshot layout state
        const containerRect = this.host.getContainer()!.getBoundingClientRect();
        nItems = this.host.getItemEls().length;
        AW = containerRect.width - (nItems - 1) * this.host.getInterItemSpace();

        // Container height may be auto for single-image rows; fall back to
        // the actual rendered height from getBoundingClientRect.
        const explicitH = parseFloat(this.host.getContainer()!.style.height || "");
        startHeight = isNaN(explicitH) ? containerRect.height : explicitH;

        // Sync: ensure all image inline heights match their item heights.
        // A prior resize or layout pass may have left imageEls[i].style.height
        // out of sync with itemEls[i].style.height, causing the image to be
        // clipped (item has overflow:hidden) or letterboxed (image shorter).
        // Skipped for a quarter-turned image, where the two are meant to differ:
        // what is on screen is drawn from the box, and the item hugs the drawing.
        for (let j = 0; j < nItems; j++) {
          if (this.host.isTurnedImage(j)) continue;
          const itemH = this.host.getItemEls()[j].style.height;
          if (itemH && itemH !== this.host.getImageEls()[j].style.height) {
            log.debug("resize-mousedown syncing img height to item", {
              index: j,
              itemH,
              imgHBefore: this.host.getImageEls()[j].style.height,
            });
            this.host.getImageEls()[j].style.height = itemH;
          }
        }

        // Snapshot each image's current item height so resizing one
        // image doesn't overwrite manual height adjustments on others.
        startItemHeights = [];
        for (let j = 0; j < nItems; j++) {
          const h = parseFloat(this.host.getItemEls()[j].style.height || "0");
          startItemHeights[j] = h > 0 ? h : startHeight;
        }
        log.debug("resize-mousedown snapshot", {
          index,
          startItemHeights: [...startItemHeights],
          itemStyleH: this.host.getItemEls().map(el => el.style.height),
          imgStyleH: this.host.getImageEls().map(el => el.style.height),
          imgStyleW: this.host.getImageEls().map(el => el.style.width),
          itemRects: this.host.getItemEls().map(el => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; }),
          imgRects: this.host.getImageEls().map(el => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; }),
        });

        // For single-image rows, cap height at the point where the image
        // fills the full container width — beyond that the image won't grow.
        // In zoom mode (beyond fill-width), we switch to object-fit: cover
        // so the image and container "lock" and grow together.
        const meta = this.host.getLoadedMeta(index);
        const aspect = meta && meta.naturalWidth > 0 && meta.naturalHeight > 0
          ? meta.naturalWidth / meta.naturalHeight
          : 1;
        const fillWidthH = meta && meta.naturalWidth > 0
          ? Math.round(AW * meta.naturalHeight / meta.naturalWidth)
          : startHeight;

        // The height the pointer drives. A quarter turn swaps the drawing, so a
        // turned item hugs the drawn picture and *that* is what the handle should
        // track — not the un-rotated layout box getImageContentRect reports.
        // Everywhere else the two coincide, and the item's own rect is the drawn
        // one — in a lone row because layout fits the item to the picture, and in
        // a row member because its cell is the rectangle it paints.
        const displayRect = this.host.isTurnedImage(index)
          ? (this.host.getItemEls()[index]?.getBoundingClientRect() ?? null)
          : this.host.getImageContentRect(index);
        startDisplayH = displayRect ? displayRect.height : startHeight;
        if (currentOnMove) document.removeEventListener("mousemove", currentOnMove);
        if (currentOnUp) document.removeEventListener("mouseup", currentOnUp);

        currentOnMove = (ev: MouseEvent) => {
          try {
          if (!dragging) return;

          // ── Single-image row: direct height scaling (flex-grow is meaningless) ──
          if (nItems === 1) {
            const dx = ev.clientX - e.clientX;
            const dy = ev.clientY - e.clientY;

            const xSign = hd.relX < 0.5 ? -1 : 1;
            const ySign = hd.relY < 0.5 ? -1 : 1;

            // Weighted blend of dx/dy based on handle position.
            const wx = 2 * Math.abs(hd.relX - 0.5);
            const wy = 2 * Math.abs(hd.relY - 0.5);
            const SENS = 1;
            const delta = wx + wy > 0
              ? (dx * xSign * wx + dy * ySign * wy) / (wx + wy) * SENS
              : 0;

            // The baseline is the image's own box, not the row's height: after a
            // quarter turn the row hugs the drawing and is the shorter of the
            // two, while this drag grows the box the image is drawn from.
            //
            // A quarter turn swaps the two, so the height the pointer drives is
            // the *drawn* one; divide the aspect out to get the box height the
            // img is laid out from. A turned row never zooms — its width is
            // already capped to the page, so a taller box can no longer widen
            // the picture.
            const turned = this.host.isTurnedImage(0);
            const targetDisplayed = Math.max(50, Math.min(2000, Math.round(startDisplayH + delta)));
            const newHeight = turned
              ? Math.max(50, Math.min(2000, Math.round(targetDisplayed / aspect)))
              : targetDisplayed;

            if (!turned && newHeight > fillWidthH) {
              // Zoom mode: image and container "locked" together beyond fill-width.
              // Switch to object-fit:cover so the image fills the element height,
              // allowing growth past the width-constrained boundary.  A turned
              // row never reaches here: its width is already capped to the page,
              // so a taller box can no longer widen the picture.
              this.host.getImageEls()[0].setCssStyles({ objectFit: "cover" });
              this.host
                .getImageEls()[0]
                .style.setProperty("object-position", ZOOM_CROP_ANCHOR, "important");
              this.host.getImageEls()[0].style.height = `${newHeight}px`;
              this.host.getItemEls()[0].style.height = `${newHeight}px`;
              this.host.getContainer()!.style.height = `${newHeight}px`;
            } else {
              // Normal mode: image height directly controls rendered size.
              // width:auto preserves aspect ratio; flex:0 0 auto lets item
              // shrink to image size so justify-content alignment is visible.
              // The item is then re-fitted to the drawing, which is what a
              // turned row needs — its box and its drawing differ in size.
              this.host.getImageEls()[0].setCssStyles({ objectFit: "contain" });
              this.host.getImageEls()[0].style.setProperty("object-position", this.host.getObjectPosition(), "important");
              this.host.getImageEls()[0].setCssStyles({ width: "auto" });
              this.host.getImageEls()[0].style.height = `${newHeight}px`;
              this.host.getItemEls()[0].setCssStyles({ flex: "0 0 auto" });
              this.host.getContainer()!.setCssStyles({ height: "" });
              this.host.syncItemToDrawing(0);
            }

            // Force synchronous reflow so the container's height is
            // recalculated before CodeMirror's dispatch reads it.
            void this.host.getContainer()!.offsetHeight;
            this.host.updateHandlePositions(0);
            log.debug("resize-mousemove (single)", {
              newHeight, fillWidthH, zoom: newHeight > fillWidthH,
              containerH: this.host.getContainer()!.getBoundingClientRect().height,
            });
            this.host.notifyLayoutChange();
            return;
          }

          // ── Multi-image row: direct image-height scaling (dividers stay fixed) ──
          const dx = ev.clientX - e.clientX;
          const dy = ev.clientY - e.clientY;
          const ySign = hd.relY < 0.5 ? -1 : 1;
          const xSign = hd.relX < 0.5 ? -1 : 1;
          const wy = 2 * Math.abs(hd.relY - 0.5);
          const wx = 2 * Math.abs(hd.relX - 0.5);
          const s = 1;
          // wy > 0: vertical/corner handles use dy; wy === 0: horizontal handles use dx.
          const yDelta = wy > 0
            ? (dy * ySign * wy) / (wx + wy) * s
            : dx * xSign * s;
          // Use image content height as delta baseline — not container height.
          // This eliminates the dead zone that occurs when container is taller
          // than the image (e.g. from a prior resize).
          //
          // The drag stops where the box fills the cell (`fill = 1`): past that a
          // taller box only spills out of the cell, so the picture is clipped and
          // the row grows with nothing on screen to show for it.  The pointer's
          // request is clamped first, and the snap then runs on the clamped value
          // — a neighbour above the ceiling is unreachable by construction and so
          // never claims a bar.
          //
          // Rounded, and deliberately the same `Math.round` the height model
          // applies to the height this member paints at fill 1: a ceiling that
          // took a different rounding of that one length would disagree with the
          // row by a pixel, and a neighbour standing on the row's figure would be
          // read as standing above the drag's.
          const maxDrawn = this.host.maxDrawnHeight(index);
          const ceiling = maxDrawn > 0 ? Math.round(maxDrawn) : Infinity;
          const rawH = Math.max(50, Math.min(2000, Math.round(startDisplayH + yDelta), ceiling));

          // A neighbour standing at the height the pointer asks for — within the
          // snap zone, the same relative band the divider drag uses — claims the
          // drag: that side's divider lights up and the picture is painted at
          // exactly the neighbour's height.  The lock goes on the painted value
          // only; `rawH` stays what the pointer says, so the drag can walk out of
          // a zone it walked into.  A row with no divider to light refuses the
          // claim (see `setResizeSnapSide`), and the drag runs unsnapped.
          const zone = this.host.getSnapSensitivity() / 100;
          const reached = this.resolveSnapSide(
            index, rawH, zone, startItemHeights, snappedSide, ceiling
          );
          const side = this.host.setResizeSnapSide(index, reached.side) ? reached.side : null;
          if (side !== snappedSide) {
            log.debug("resize-snap", { index, rawH, side, targetH: reached.height, ceiling });
          }
          snappedSide = side;
          // 满格 is an equality every member can reach, so the drag snaps to it
          // the way it snaps to a neighbour — silently, because it is not a
          // neighbour and has no divider of its own to light.  A neighbour's
          // claim wins where the two zones overlap: that one is a deliberate
          // equality with visible feedback, and it is the nearer target there.
          const nearFull =
            !side && Number.isFinite(ceiling) && ceiling - rawH <= ceiling * zone;
          const targetDrawnH = side ? reached.height : nearFull ? ceiling : rawH;
          atCeiling = Number.isFinite(ceiling) && targetDrawnH >= ceiling;
          // Did this drag move anything at all? A drag pinned at the ceiling from
          // its first move never does, and must leave the note alone.
          moved = moved || targetDrawnH !== Math.round(startDisplayH);

          // The pointer drives the *drawing*: that is what the handles hug, and
          // that is what the cell is.  Only the img's layout box has to be
          // derived back out of it, and only a turn makes them differ — writing
          // the drawn height straight onto the box (as this did) moved a turned
          // member's cell without moving the picture at all.
          const boxH = this.host.boxHeightForDrawn(targetDrawnH, index);
          const imageH = `${boxH}px`;
          this.host.getImageEls()[index].style.height = imageH;
          this.host.getItemEls()[index].style.height = `${targetDrawnH}px`;
          this.host.noteDragGeometry(index, boxH, targetDrawnH);
          // Preserve each non-dragged image's original height (may differ
          // from container height due to prior manual resizes).  Those are cell
          // heights, which is the unit the row is measured in.
          let otherMax = 0;
          for (let j = 0; j < this.host.getItemEls().length; j++) {
            if (j === index) continue;
            const h = `${startItemHeights[j]}px`;
            this.host.getItemEls()[j].style.height = h;
            const otherBoxH = this.host.boxHeightForDrawn(startItemHeights[j], j);
            this.host.getImageEls()[j].style.height = `${otherBoxH}px`;
            this.host.noteDragGeometry(j, otherBoxH, startItemHeights[j]);
            otherMax = Math.max(otherMax, startItemHeights[j]);
          }
          const containerH = Math.max(targetDrawnH, otherMax);
          this.host.getContainer()!.style.height = `${containerH}px`;
          this.host.updateHandlePositions(index);
          // Diagnostic: detect image/item height mismatch that would cause clipping.
          // item.style.overflow = "hidden" clips images whose rendered size exceeds the item.
          const mismatches: { j: number; itemH: number; imgH: number; imgW: number; itemW: number }[] = [];
          for (let j = 0; j < this.host.getItemEls().length; j++) {
            const ir = this.host.getItemEls()[j].getBoundingClientRect();
            const imr = this.host.getImageEls()[j].getBoundingClientRect();
            if (Math.abs(ir.height - imr.height) > 1 || Math.abs(ir.width - imr.width) > 1) {
              mismatches.push({ j, itemH: Math.round(ir.height), imgH: Math.round(imr.height), imgW: Math.round(imr.width), itemW: Math.round(ir.width) });
            }
          }
          if (mismatches.length > 0) {
            log.warn("resize-mousemove image/item mismatch (clipping risk)", {
              activeIndex: index,
              targetDrawnH,
              containerH,
              startItemHeights: [...startItemHeights],
              mismatches,
            });
          }
          this.host.notifyLayoutChange();
          } catch (err) {
            log.error("ImageRowWidget resize mousemove error", { error: String(err) });
            // Silently terminate the drag and clean up listeners.
            dragging = false;
            snappedSide = null;
            this.host.setResizeSnapSide(index, null);
            item.classList.remove(CLASSES.resizing);
            if (currentOnMove) document.removeEventListener("mousemove", currentOnMove);
            if (currentOnUp) document.removeEventListener("mouseup", currentOnUp);
            currentOnMove = null;
            currentOnUp = null;
          }
        };

        currentOnUp = () => {
          try {
          dragging = false;
          snappedSide = null;
          this.host.setResizeSnapSide(index, null);
          item.classList.remove(CLASSES.resizing);

          // ── Persist scale ratio ──
          // Compute image-content-width / item-width ratio.  This captures the
          // resize state as a dimensionless number that survives container-width
          // changes.  Persisted to markdown as ![[file|flexGrow|scale]].
          //
          // Only for a drag that moved: one held at the ceiling records a picture
          // exactly where it was, and writing its ratio would stamp an explicit
          // 满格 (`|100`) onto a member that keeps its default for no gain.
          if (nItems > 1) {
            if (moved) {
              const itemRect = this.host.getItemEls()[index].getBoundingClientRect();
              const contentRect = this.host.getImageContentRect(index);
              if (itemRect.width > 0 && contentRect && contentRect.width > 0) {
                // A drag that ended at the ceiling is 满格 by definition.  The
                // measured ratio is not: the box height is an integer, so the box
                // lands a hair inside the cell and the quotient reads 99 for a
                // cell the picture visibly fills.  Record the ceiling as 1.
                const scale = atCeiling ? 1 : contentRect.width / itemRect.width;
                this.host.setImageScale(index, scale);
                log.debug("resize-mouseup scale saved", {
                  index,
                  scale: Math.round(scale * 100),
                  contentW: Math.round(contentRect.width),
                  itemW: Math.round(itemRect.width),
                  atCeiling,
                });
              }
            }
          } else {
            // ── Single-image row: persist the manual screen width as |1|W ──
            // The stored number is the width the picture takes across the page,
            // and `getImageContentRect` measures the layout box — which a
            // quarter turn paints on its side, putting the page width under its
            // height.  Only in normal mode (image ≤ container width; container
            // height is cleared).  Zoom mode (image enlarged past container
            // width) isn't representable as a capped width, so it isn't
            // persisted.
            const isZoom = !!this.host.getContainer()?.style.height;
            const contentRect = this.host.getImageContentRect(0);
            if (!isZoom && contentRect) {
              const screenW = this.host.isTurnedImage(0)
                ? contentRect.height
                : contentRect.width;
              if (screenW > 0) {
                this.host.setSingleImageWidth(Math.round(screenW));
                log.debug("resize-mouseup single width saved", {
                  widthPx: Math.round(screenW),
                  turned: this.host.isTurnedImage(0),
                });
              }
            }
          }

          const finalFlex = parseFloat(item.style.flexGrow || "1");
          log.debug("resize-mouseup", { index, finalFlex, nItems, moved, timestamp: Date.now() });
          // A lone row always has its width to write; a multi-image row only when
          // the drag actually moved something.
          if (nItems === 1 || moved) this.host.emitResizeEnd(index, finalFlex);
          document.removeEventListener("mousemove", currentOnMove!);
          document.removeEventListener("mouseup", currentOnUp!);
          currentOnMove = null;
          currentOnUp = null;
          } catch (err) {
            log.error("ImageRowWidget resize mouseup error", { error: String(err) });
            if (currentOnMove) document.removeEventListener("mousemove", currentOnMove);
            if (currentOnUp) document.removeEventListener("mouseup", currentOnUp);
            currentOnMove = null;
            currentOnUp = null;
          }
        };

        document.addEventListener("mousemove", currentOnMove);
        document.addEventListener("mouseup", currentOnUp, { once: true });
        } catch (err) {
          log.error("ImageRowWidget resize mousedown error", { error: String(err) });
          dragging = false;
          item.classList.remove(CLASSES.resizing);
        }
      };

      handle._destroy = () => {
        if (currentOnMove) document.removeEventListener("mousemove", currentOnMove);
        if (currentOnUp) document.removeEventListener("mouseup", currentOnUp);
        // A widget torn down mid-drag leaves its bar lit; the divider it sits on
        // is about to be dropped along with the rest of the row.
        if (snappedSide) {
          snappedSide = null;
          this.host.setResizeSnapSide(index, null);
        }
      };

      item.appendChild(handle);
      hd.el = handle;
      handles.push(handle);
    }

    return { handles, defs };
  }
}
