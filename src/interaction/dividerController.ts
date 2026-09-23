import { CLASSES } from "../constants";
import { ImageMeta } from "../imageParse/imageDetector";
import { logger } from "../logger";
const log = logger.channel("divider");
import type { OrientationState } from "../imageTransform/orientation";
import { clampFlexGrow } from "../imageLayout/parameterValidator";
import {
  computePairEquilibrium,
  computePairHeights,
  type PairEquilibrium,
} from "../imageLayout/layoutEngine";

/**
 * Narrow host interface the DividerController needs from ImageRowWidget.
 * Accessors return the widget's *current* fields (never cache the returned
 * arrays — the widget resets them on destroy()).
 */
export interface DividerHost {
  getItemEls(): HTMLElement[];
  getLoadedMeta(index: number): ImageMeta | undefined;
  getSnapSensitivity(): number;
  getImageCount(): number;
  /** A member's persisted fill ratio (null = none): the scale the row's
   *  rendered-height model reads. */
  getFill(index: number): number | null;
  /** A member's rotate/flip — the model needs it because a quarter turn
   *  repaints the member's box on its side, so what it *draws* is no longer its
   *  box height. */
  getOrientation(index: number): OrientationState | null;
  /** Live width of the row, as `recalculateRowHeight` measures it. */
  getRowWidth(): number;
  /** Space one junction between adjacent items occupies, dividers included —
   *  the figure the row's layout math divides off.  Not the CSS `gap`. */
  getInterItemSpace(): number;
  getDefaultRowHeight(): number;
  snapDividerToEquilibrium(leftIndex: number): void;
  recalculateRowHeight(): void;
  emitDividerDrag(leftIndex: number, ratio: number): void;
  /** The drag is over and its shares are final: write them to the note.  The
   *  mousemove only ever touched the DOM, so without this the gesture leaves no
   *  document change behind — and then there is nothing for a Cmd+Z to undo. */
  emitDividerDragEnd(leftIndex: number): void;
}

/**
 * Builds a draggable divider between two adjacent flex items.
 * Drag adjusts the two neighbours' flex-grow while keeping their sum constant;
 * double-click snaps the pair to equal heights.
 */
export class DividerController {
  constructor(private host: DividerHost) {}

  /**
   * The pair's rendered heights at a candidate split, plus the split that
   * equalises them — both solved on the model the row actually paints from, so
   * per-image fill ratios and the row-wide grow divisor are accounted for.
   * Null while any of the row's measurements is missing; the drag then runs
   * without a snap zone rather than show an indicator it cannot back up.
   */
  private evaluatePair(
    leftIndex: number,
    candidateLeft: number,
    candidateRight: number
  ): { heights: { left: number; right: number }; equilibrium: PairEquilibrium | null } | null {
    const itemEls = this.host.getItemEls();
    if (itemEls.length < 2) return null;
    const containerWidth = this.host.getRowWidth();
    if (!(containerWidth > 0)) return null;

    const grows: number[] = [];
    const metas: ImageMeta[] = [];
    const scales: Array<number | null> = [];
    const orientations: Array<OrientationState | null> = [];
    for (let i = 0; i < itemEls.length; i++) {
      const parsed = parseFloat(itemEls[i]?.style.flexGrow || "1");
      grows[i] = isFinite(parsed) ? parsed : 1;
      const meta = this.host.getLoadedMeta(i);
      if (!meta || meta.naturalWidth === 0 || meta.naturalHeight === 0) return null;
      metas[i] = meta;
      scales[i] = this.host.getFill(i);
      orientations[i] = this.host.getOrientation(i);
    }
    grows[leftIndex] = candidateLeft;
    grows[leftIndex + 1] = candidateRight;

    const gap = this.host.getInterItemSpace();
    const defaultRowHeight = this.host.getDefaultRowHeight();
    return {
      heights: computePairHeights(
        grows,
        metas,
        scales,
        containerWidth,
        gap,
        defaultRowHeight,
        leftIndex,
        orientations
      ),
      equilibrium: computePairEquilibrium(
        grows,
        metas,
        scales,
        containerWidth,
        gap,
        defaultRowHeight,
        leftIndex,
        orientations
      ),
    };
  }

  build(leftIndex: number): HTMLElement {
    // Every visual property of the divider lives in the `.diaa-divider` rule;
    // only the index it acts on has to travel on the element.
    const divider = createDiv();
    divider.className = CLASSES.divider;
    divider.dataset.leftIndex = String(leftIndex);

    // Double-click divider → snap to equal heights
    divider.ondblclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      log.debug("BALANCE divider dblclick received", {
        leftIndex,
        totalImages: this.host.getImageCount(),
      });
      this.host.snapDividerToEquilibrium(leftIndex);
    };

    // Divider drag
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startLeftFlex = 0;
    let startRightFlex = 0;
    let currentOnMove: ((e: MouseEvent) => void) | null = null;
    let currentOnUp: (() => void) | null = null;

    divider.onmousedown = (e) => {
      try {
      dragging = true;
      moved = false;
      startX = e.clientX;
      const itemEls = this.host.getItemEls();
      const leftItem = itemEls[leftIndex];
      const rightItem = itemEls[leftIndex + 1];
      startLeftFlex = parseFloat(leftItem?.style.flexGrow || "1");
      startRightFlex = parseFloat(rightItem?.style.flexGrow || "1");
      e.preventDefault();

      // Keep divider visible throughout the drag
      divider.classList.add(CLASSES.dividerActive);

      // Register fresh listeners for each drag session
      if (currentOnMove) document.removeEventListener("mousemove", currentOnMove);
      if (currentOnUp) document.removeEventListener("mouseup", currentOnUp);

      currentOnMove = (ev: MouseEvent) => {
        try {
        if (!dragging) return;
        const dx = ev.clientX - startX;
        if (Math.abs(dx) < 3) return;
        moved = true;

        const itemEls = this.host.getItemEls();
        const leftItem = itemEls[leftIndex];
        const rightItem = itemEls[leftIndex + 1];
        if (!leftItem || !rightItem) return;

        const sensitivity = 0.5;
        let newLeft = clampFlexGrow(startLeftFlex + dx * sensitivity * 0.01);
        const total = startLeftFlex + startRightFlex;
        let newRight = total - newLeft;

        // Enforce minimum on both sides
        if (newRight < 0.1) { newRight = 0.1; newLeft = total - 0.1; }
        if (newLeft < 0.1) { newLeft = 0.1; newRight = total - 0.1; }
        newLeft = clampFlexGrow(newLeft);
        newRight = clampFlexGrow(newRight);

        // Snap: lock to the split at which these two render at the same height.
        // The heights are read from the row's own model, not from the aspect
        // ratios: a member's drawn height is `fill × grow / aspect`, so equal
        // aspects are equal heights only while the two fills agree.  Zero
        // sensitivity (or a pair nothing can equalise) means no snap zone.
        const snapFactor = this.host.getSnapSensitivity() / 100;
        const pair = this.evaluatePair(leftIndex, newLeft, newRight);
        let snapped = false;
        if (pair && pair.equilibrium && snapFactor > 0) {
          const diff = Math.abs(pair.heights.left - pair.heights.right);
          if (diff < pair.equilibrium.height * snapFactor) {
            newLeft = pair.equilibrium.left;
            newRight = pair.equilibrium.right;
            snapped = true;
          }
        }
        divider.classList.toggle(CLASSES.dividerSnap, snapped);

        leftItem.style.flexGrow = String(newLeft);
        rightItem.style.flexGrow = String(newRight);

        this.host.recalculateRowHeight();

        const ratio = newLeft / (newLeft + newRight);
        this.host.emitDividerDrag(leftIndex, ratio);
        } catch (e) {
          log.error("ImageRowWidget divider mousemove error", { error: String(e) });
          // Silently terminate the drag and clean up listeners.
          dragging = false;
          divider.classList.remove(CLASSES.dividerActive);
          divider.classList.remove(CLASSES.dividerSnap);
          if (currentOnMove) document.removeEventListener("mousemove", currentOnMove);
          if (currentOnUp) document.removeEventListener("mouseup", currentOnUp);
          currentOnMove = null;
          currentOnUp = null;
        }
      };

      currentOnUp = () => {
        try {
        dragging = false;
        divider.classList.remove(CLASSES.dividerActive);
        divider.classList.remove(CLASSES.dividerSnap);
        document.removeEventListener("mousemove", currentOnMove!);
        document.removeEventListener("mouseup", currentOnUp!);
        currentOnMove = null;
        currentOnUp = null;
        // Press-to-release is one transaction, the same as a handle drag's
        // emitResizeEnd.  A press that never moved wrote nothing to the DOM, so
        // there is no change to record and the note is left alone.
        if (moved) this.host.emitDividerDragEnd(leftIndex);
        } catch (e) {
          log.error("ImageRowWidget divider mouseup error", { error: String(e) });
        }
      };

      document.addEventListener("mousemove", currentOnMove);
      document.addEventListener("mouseup", currentOnUp, { once: true });
      } catch (e) {
        log.error("ImageRowWidget divider mousedown error", { error: String(e) });
        dragging = false;
        divider.classList.remove(CLASSES.dividerActive);
      }
    };

    divider._destroy = () => {
      if (currentOnMove) document.removeEventListener("mousemove", currentOnMove);
      if (currentOnUp) document.removeEventListener("mouseup", currentOnUp);
    };

    return divider;
  }
}
