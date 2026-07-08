import { CLASSES, DIVIDER_WIDTH } from "./constants";
import { ImageMeta } from "./imageDetector";
import { logger } from "./logger";
import { clampFlexGrow } from "./parameterValidator";

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
  snapDividerToEquilibrium(leftIndex: number): void;
  recalculateRowHeight(): void;
  emitDividerDrag(leftIndex: number, ratio: number): void;
}

/**
 * Builds a draggable divider between two adjacent flex items.
 * Drag adjusts the two neighbours' flex-grow while keeping their sum constant;
 * double-click snaps the pair to equal heights.
 */
export class DividerController {
  constructor(private host: DividerHost) {}

  build(leftIndex: number): HTMLElement {
    const divider = document.createElement("div");
    divider.className = CLASSES.divider;
    divider.style.flex = "0 0 auto";
    divider.style.width = `${DIVIDER_WIDTH}px`;
    divider.style.cursor = "col-resize";
    divider.style.alignSelf = "stretch";
    divider.style.backgroundColor = "transparent";
    divider.style.transition = "background-color 0.15s";
    divider.dataset.leftIndex = String(leftIndex);

    divider.onmouseenter = () => {
      divider.style.backgroundColor = "#4a9eff";
    };
    divider.onmouseleave = () => {
      divider.style.backgroundColor = "transparent";
    };

    // Double-click divider → snap to equal heights
    divider.ondblclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      logger.debug("BALANCE divider dblclick received", {
        leftIndex,
        totalImages: this.host.getImageCount(),
      });
      this.host.snapDividerToEquilibrium(leftIndex);
    };

    // Divider drag
    let dragging = false;
    let startX = 0;
    let startLeftFlex = 0;
    let startRightFlex = 0;
    let currentOnMove: ((e: MouseEvent) => void) | null = null;
    let currentOnUp: (() => void) | null = null;

    divider.onmousedown = (e) => {
      try {
      dragging = true;
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

        // Snap: when adjacent image heights are nearly equal, lock to equilibrium.
        // Snap zone = equilibriumHeight × snapSensitivity%.
        // Condition |leftH - rightH| < eqHeight × snapFactor simplifies to
        //   |newLeft/la - newRight/ra| < total/(la+ra) × snapFactor
        const snapFactor = this.host.getSnapSensitivity() / 100;
        if (snapFactor > 0) {
          const lm = this.host.getLoadedMeta(leftIndex);
          const rm = this.host.getLoadedMeta(leftIndex + 1);
          if (lm && rm && lm.naturalWidth > 0 && rm.naturalWidth > 0) {
            const la = lm.naturalWidth / lm.naturalHeight;
            const ra = rm.naturalWidth / rm.naturalHeight;
            const snapLeft = total * la / (la + ra);
            const snapRight = total - snapLeft;
            const heightDiff = Math.abs(newLeft / la - newRight / ra);
            const snapThreshold = total / (la + ra) * snapFactor;
            if (heightDiff < snapThreshold) {
              newLeft = snapLeft;
              newRight = snapRight;
              divider.classList.add(CLASSES.dividerSnap);
            } else {
              divider.classList.remove(CLASSES.dividerSnap);
            }
          }
        }

        leftItem.style.flexGrow = String(newLeft);
        rightItem.style.flexGrow = String(newRight);

        this.host.recalculateRowHeight();

        const ratio = newLeft / (newLeft + newRight);
        this.host.emitDividerDrag(leftIndex, ratio);
        } catch (e) {
          logger.error("ImageRowWidget divider mousemove error", { error: String(e) });
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
        } catch (e) {
          logger.error("ImageRowWidget divider mouseup error", { error: String(e) });
        }
      };

      document.addEventListener("mousemove", currentOnMove);
      document.addEventListener("mouseup", currentOnUp, { once: true });
      } catch (e) {
        logger.error("ImageRowWidget divider mousedown error", { error: String(e) });
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
