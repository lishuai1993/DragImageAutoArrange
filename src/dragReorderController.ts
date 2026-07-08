import { CLASSES } from "./constants";
import { computeDividerXPositions, findClosestDividerIndex } from "./layoutEngine";
import { logger } from "./logger";
import { createDragGhost } from "./rowRenderer";

/**
 * Narrow host interface the DragReorderController needs from ImageRowWidget.
 * Array/element accessors return the widget's *current* fields.
 */
export interface DragReorderHost {
  getContainer(): HTMLElement | null;
  getItemEls(): HTMLElement[];
  getImageEls(): HTMLImageElement[];
  getDividerEls(): HTMLElement[];
  getEdgeLeft(): HTMLElement | null;
  getEdgeRight(): HTMLElement | null;
  getGroupLineStart(): number;
  getGap(): number;
  getGhostImageWidth(): number;
  getDragOpacity(): number;
  emitReorder(fromIndex: number, toIndex: number): void;
  emitMergeExternal(insertAtIndex: number, dataTransfer: string): void;
}

/**
 * Wires HTML5 drag-and-drop reordering for a flex row: intra-row reorder,
 * inter-row merge, standalone-image merge, an insert-position hint line, and
 * document-level capture handlers for edge drops outside the container.
 */
export class DragReorderController {
  private docDragOver: ((e: DragEvent) => void) | null = null;
  private docDrop: ((e: DragEvent) => void) | null = null;

  constructor(private host: DragReorderHost) {}

  enable(): void {
    const container = this.host.getContainer();
    if (!container) return;

    const itemEls = this.host.getItemEls();
    for (let i = 0; i < itemEls.length; i++) {
      const item = itemEls[i];
      item.draggable = true;

      item.ondragstart = (e) => {
        e.stopPropagation();
        e.dataTransfer!.effectAllowed = "move";
        // Encode source: group lineStart + index so any target can identify the source line
        const payload = `diaa-row:${this.host.getGroupLineStart()}:${i}`;
        e.dataTransfer!.setData("text/plain", payload);
        // Custom MIME type for dragover detection (Chrome blocks getData in dragover)
        e.dataTransfer!.setData("application/diaa-row", payload);
        item.classList.add(CLASSES.dragging);
        // Configurable opacity: higher dragOpacity = more transparent
        item.style.opacity = String(1 - this.host.getDragOpacity() / 100);

        // Custom fully-opaque ghost that follows cursor via dragover
        const cleanupGhost = createDragGhost(this.host.getImageEls()[i], e, this.host.getGhostImageWidth());
        item.addEventListener("dragend", cleanupGhost, { once: true });

        logger.info("ImageRowWidget dragstart", {
          index: i,
          groupLineStart: this.host.getGroupLineStart(),
          payload,
          targetTag: (e.target as HTMLElement).tagName,
          targetClass: (e.target as HTMLElement).className?.substring?.(0, 40) || "",
        });
      };

      item.ondragend = (e) => {
        e.stopPropagation();
        item.classList.remove(CLASSES.dragging);
        item.style.opacity = "";
        this.hideDividerHint();
      };

      item.ondragover = (e) => {
        e.stopPropagation();
        e.preventDefault();
        e.dataTransfer!.dropEffect = "move";
        this.showDividerHint(e.clientX);
      };

      item.ondragleave = (e) => {
        e.stopPropagation();
      };

      item.ondrop = (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.hideDividerHint();

        const data = e.dataTransfer!.getData("text/plain");
        logger.debug("ImageRowWidget item ondrop", { i, data: data?.substring(0, 60) });

        if (!data) return;

        const insertAt = this.getInsertAt(e.clientX);

        // Flex row source: "diaa-row:<lineStart>:<index>"
        const rowMatch = data.match(/^diaa-row:(\d+):(\d+)$/);
        if (rowMatch) {
          const srcLineStart = parseInt(rowMatch[1], 10);
          const srcIndex = parseInt(rowMatch[2], 10);

          if (srcLineStart === this.host.getGroupLineStart()) {
            // Intra-row reorder (same group)
            const toIndex = srcIndex < insertAt ? insertAt - 1 : insertAt;
            if (srcIndex !== toIndex && srcIndex !== i) {
              this.host.emitReorder(srcIndex, toIndex);
            }
            return;
          }

          // Inter-row: move from another flex row into this one
          logger.info("ImageRowWidget inter-row merge", { i, insertAt, srcLineStart, srcIndex });
          this.host.emitMergeExternal(insertAt, data);
          return;
        }

        // Standalone source: diaa-standalone:<line> (intercepted) or obsidian://open URI
        if (data.startsWith("diaa-standalone:") || data.startsWith("obsidian://open")) {
          logger.info("ImageRowWidget cross-row merge from standalone", { i, insertAt, data: data.substring(0, 60) });
          this.host.emitMergeExternal(insertAt, data);
        }
      };
    }

    // Container-level dragover/drop: catches drops in gaps between items,
    // and provides a unified insert-position hint line.
    container.addEventListener("dragover", (e) => {
      e.stopPropagation();
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
      this.showDividerHint(e.clientX);
    });

    container.addEventListener("dragleave", (e) => {
      // Only hide when truly leaving the container (not moving into a child)
      const target = e.relatedTarget as Node | null;
      if (!target || !container.contains(target)) {
        this.hideDividerHint();
      }
    });

    container.addEventListener("drop", (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.hideDividerHint();
      const data = e.dataTransfer!.getData("text/plain");
      logger.debug("ImageRowWidget container ondrop", { data: data?.substring(0, 60) });
      if (!data) return;

      const rowMatch = data.match(/^diaa-row:(\d+):(\d+)$/);
      const isStandalone = data.startsWith("diaa-standalone:") || data.startsWith("obsidian://open");
      if (rowMatch || isStandalone) {
        const insertAt = this.getInsertAt(e.clientX);
        logger.info("ImageRowWidget cross-row merge (container)", { insertAt });
        this.host.emitMergeExternal(insertAt, data);
      }
    });

    // ── Document-level capture listeners ──
    // When the cursor moves outside the container bounds (e.g. past left/
    // right page edges), container dragover/drop won't fire.  These capture-
    // phase handlers detect when the cursor is near an edge divider position
    // even when outside the container, so edge-insert hints and drops still work.
    this.docDragOver = (e: DragEvent) => {
      const container = this.host.getContainer();
      if (!container) return;
      const types = e.dataTransfer?.types;
      if (!types || !types.includes("text/plain")) return;

      const containerRect = container.getBoundingClientRect();
      if (e.clientY < containerRect.top - 20 || e.clientY > containerRect.bottom + 20) return;

      const widths = this.host.getItemEls().map(el => el.getBoundingClientRect().width);
      const positions = computeDividerXPositions(containerRect.left, widths, this.host.getGap());
      const avgWidth = widths.reduce((s, w) => s + w, 0) / widths.length;
      const threshold = Math.min(avgWidth * 0.4, 80);
      const closestIdx = findClosestDividerIndex(e.clientX, positions, threshold);

      if (closestIdx === 0 || closestIdx === positions.length - 1) {
        e.preventDefault();
        e.dataTransfer!.dropEffect = "move";
        this.showDividerHint(e.clientX);
      }
    };

    this.docDrop = (e: DragEvent) => {
      const container = this.host.getContainer();
      if (!container) return;

      const containerRect = container.getBoundingClientRect();
      if (e.clientY < containerRect.top - 20 || e.clientY > containerRect.bottom + 20) return;

      const data = e.dataTransfer?.getData("text/plain") || "";
      if (!data.startsWith("diaa-row:") && !data.startsWith("diaa-standalone:") && !data.startsWith("obsidian://open")) return;

      const widths = this.host.getItemEls().map(el => el.getBoundingClientRect().width);
      const positions = computeDividerXPositions(containerRect.left, widths, this.host.getGap());
      const avgWidth = widths.reduce((s, w) => s + w, 0) / widths.length;
      const threshold = Math.min(avgWidth * 0.4, 80);
      const closestIdx = findClosestDividerIndex(e.clientX, positions, threshold);

      if (closestIdx !== 0 && closestIdx !== positions.length - 1) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      this.hideDividerHint();

      const insertAt = closestIdx;

      const rowMatch = data.match(/^diaa-row:(\d+):(\d+)$/);
      if (rowMatch) {
        const srcLineStart = parseInt(rowMatch[1], 10);
        const srcIndex = parseInt(rowMatch[2], 10);
        if (srcLineStart === this.host.getGroupLineStart()) {
          const toIndex = srcIndex < insertAt ? insertAt - 1 : insertAt;
          if (srcIndex !== toIndex) {
            this.host.emitReorder(srcIndex, toIndex);
          }
          return;
        }
      }

      this.host.emitMergeExternal(insertAt, data);
    };

    document.addEventListener("dragover", this.docDragOver, true);
    document.addEventListener("drop", this.docDrop, true);
  }

  /**
   * Highlight the divider closest to cursorX during drag-over.
   * Uses existing divider elements for internal positions and
   * absolutely-positioned edge overlays for edge positions.
   */
  private showDividerHint(cursorX: number): void {
    const container = this.host.getContainer();
    const itemEls = this.host.getItemEls();
    if (!container || itemEls.length === 0) return;

    const containerRect = container.getBoundingClientRect();
    const widths = itemEls.map(el => el.getBoundingClientRect().width);

    const positions = computeDividerXPositions(
      containerRect.left,
      widths,
      this.host.getGap()
    );

    const avgWidth = widths.reduce((s, w) => s + w, 0) / widths.length;
    const threshold = Math.min(avgWidth * 0.4, 80);

    const closestIdx = findClosestDividerIndex(cursorX, positions, threshold);

    // Clear previous highlight
    this.hideDividerHint();

    if (closestIdx === null) return;

    const n = positions.length; // n images → n+1 positions
    const dividerEls = this.host.getDividerEls();
    const hasDividers = dividerEls.length > 0;

    const edgeLeft = this.host.getEdgeLeft();
    const edgeRight = this.host.getEdgeRight();
    if (closestIdx > 0 && closestIdx < n - 1 && hasDividers) {
      // Internal position → highlight the corresponding physical divider
      const divIndex = closestIdx - 1; // positions[1] maps to dividerEls[0]
      if (divIndex < dividerEls.length) {
        dividerEls[divIndex].style.backgroundColor = "#4a9eff";
        dividerEls[divIndex].classList.add(CLASSES.dividerActive);
      }
    } else if (closestIdx === 0 && edgeLeft) {
      edgeLeft.style.height = `${containerRect.height}px`;
      edgeLeft.style.display = "";
    } else if (edgeRight) {
      edgeRight.style.height = `${containerRect.height}px`;
      edgeRight.style.display = "";
    }
  }

  /**
   * Compute the insert-at index from cursorX using divider positions.
   * This is the single source of truth for both item-level and container-level
   * drop handlers, ensuring the drop position matches the hint line.
   */
  private getInsertAt(cursorX: number): number {
    const container = this.host.getContainer();
    if (!container) return -1;
    const itemEls = this.host.getItemEls();
    const containerRect = container.getBoundingClientRect();
    const widths = itemEls.map(el => el.getBoundingClientRect().width);
    const positions = computeDividerXPositions(containerRect.left, widths, this.host.getGap());
    const closestIdx = findClosestDividerIndex(cursorX, positions, 60);
    if (closestIdx !== null) return closestIdx;
    // Fallback: binary choice based on container center
    return cursorX < containerRect.left + containerRect.width / 2 ? 0 : itemEls.length;
  }

  /** Clear all drag-over highlight states. */
  private hideDividerHint(): void {
    for (const div of this.host.getDividerEls()) {
      div.style.backgroundColor = "";
      div.classList.remove(CLASSES.dividerActive);
    }
    const edgeLeft = this.host.getEdgeLeft();
    const edgeRight = this.host.getEdgeRight();
    if (edgeLeft) edgeLeft.style.display = "none";
    if (edgeRight) edgeRight.style.display = "none";
  }

  /** Remove document-level capture listeners. */
  destroy(): void {
    if (this.docDragOver) document.removeEventListener("dragover", this.docDragOver, true);
    if (this.docDrop) document.removeEventListener("drop", this.docDrop, true);
    this.docDragOver = null;
    this.docDrop = null;
  }
}
