import { CLASSES, RESIZE_HANDLE_SIZE } from "../constants";
import { ImageMeta } from "../imageParse/imageDetector";
import { logger } from "../logger";
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
  getItemEls(): HTMLElement[];
  getImageEls(): HTMLImageElement[];
  /** Space one junction between adjacent items occupies, dividers included —
   *  the row width left to the items.  Not the CSS `gap`. */
  getInterItemSpace(): number;
  getLoadedMeta(index: number): ImageMeta | undefined;
  getImageContentRect(index: number): { left: number; top: number; width: number; height: number } | null;
  getObjectPosition(): string;
  updateHandlePositions(index: number): void;
  /** True when an odd quarter turn is drawn for this member, i.e. what is on
   *  screen is smaller than (and not the same shape as) the image's layout box. */
  isTurnedImage(index: number): boolean;
  /** Replay that member's orientation against the box as it now stands and
   *  re-fit a lone image's item to the drawing. */
  syncItemToDrawing(index: number): void;
  notifyLayoutChange(): void;
  emitResizeEnd(index: number, flexGrow: number): void;
  setImageScale(index: number, scale: number): void;
  setSingleImageWidth(widthPx: number): void;
}

/**
 * Builds the 8 resize handles (4 corners + 4 edge midpoints) for a flex item
 * and wires their drag behaviour (feedforward width/height scaling with scale
 * persistence on mouseup).  Returns the created handles plus their HandleDef
 * array, which the widget stores for handle-position updates.
 */
export class ResizeHandleController {
  constructor(private host: ResizeHost) {}

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
      let dragging = false;
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
        item.classList.add(CLASSES.resizing);
        log.debug("resize-mousedown", { index, timestamp: Date.now(), relX: hd.relX, relY: hd.relY });
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
        // turned single row hugs the drawn picture and *that* is what the handle
        // should track — not the un-rotated layout box getImageContentRect
        // reports. Everywhere else the two coincide.
        const turnedSingle = nItems === 1 && this.host.isTurnedImage(0);
        const displayRect = turnedSingle
          ? (this.host.getItemEls()[0]?.getBoundingClientRect() ?? null)
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
          const targetImageH = Math.max(50, Math.min(2000, Math.round(startDisplayH + yDelta)));
          const imageH = `${targetImageH}px`;
          this.host.getImageEls()[index].style.height = imageH;
          this.host.getItemEls()[index].style.height = imageH;
          // Preserve each non-dragged image's original height (may differ
          // from container height due to prior manual resizes).
          let otherMax = 0;
          for (let j = 0; j < this.host.getItemEls().length; j++) {
            if (j === index) continue;
            const h = `${startItemHeights[j]}px`;
            this.host.getItemEls()[j].style.height = h;
            this.host.getImageEls()[j].style.height = h;
            otherMax = Math.max(otherMax, startItemHeights[j]);
          }
          const containerH = Math.max(targetImageH, otherMax);
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
              targetImageH,
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
            item.classList.remove(CLASSES.resizing);
            item.classList.remove(CLASSES.itemSnap);
            if (currentOnMove) document.removeEventListener("mousemove", currentOnMove);
            if (currentOnUp) document.removeEventListener("mouseup", currentOnUp);
            currentOnMove = null;
            currentOnUp = null;
          }
        };

        currentOnUp = () => {
          try {
          dragging = false;
          item.classList.remove(CLASSES.resizing);
          item.classList.remove(CLASSES.itemSnap);

          // ── Persist scale ratio ──
          // Compute image-content-width / item-width ratio.  This captures the
          // resize state as a dimensionless number that survives container-width
          // changes.  Persisted to markdown as ![[file|flexGrow|scale]].
          if (nItems > 1) {
            const itemRect = this.host.getItemEls()[index].getBoundingClientRect();
            const contentRect = this.host.getImageContentRect(index);
            if (itemRect.width > 0 && contentRect && contentRect.width > 0) {
              const scale = contentRect.width / itemRect.width;
              this.host.setImageScale(index, scale);
              log.debug("resize-mouseup scale saved", {
                index,
                scale: Math.round(scale * 100),
                contentW: Math.round(contentRect.width),
                itemW: Math.round(itemRect.width),
              });
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
          log.debug("resize-mouseup", { index, finalFlex, nItems, timestamp: Date.now() });
          this.host.emitResizeEnd(index, finalFlex);
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
      };

      item.appendChild(handle);
      hd.el = handle;
      handles.push(handle);
    }

    return { handles, defs };
  }
}
