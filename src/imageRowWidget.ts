import { CLASSES, DIVIDER_WIDTH, RESIZE_HANDLE_SIZE } from "./constants";
import { ImageGroup, ImageEmbed, ImageMeta } from "./imageDetector";
import { computeFlexGrows, computeUniformHeight } from "./layoutEngine";
import { resolveImageSrc } from "./utils";
import { logger } from "./logger";

export interface ImageRowOptions {
  defaultRowHeight: number;
  gap: number;
  enableDividers: boolean;
  enableResize: boolean;
  snapSensitivity: number;
  getResourcePath: (fileName: string) => string;
}

export type ReorderCallback = (fromIndex: number, toIndex: number) => void;
export type ResizeCallback = (imageIndex: number, newFlexGrow: number) => void;
export type ResizeEndCallback = (imageIndex: number, newFlexGrow: number) => void;
export type DividerDragCallback = (leftIndex: number, ratio: number) => void;
export type PersistCallback = () => void;
export type MergeExternalCallback = (insertAtIndex: number, dataTransfer: string) => void;

/**
 * Builds and manages the DOM for a flex row of images.
 */
export class ImageRowWidget {
  container: HTMLElement | null = null;
  private imageEls: HTMLImageElement[] = [];
  private itemEls: HTMLElement[] = [];
  private dividerEls: HTMLElement[] = [];
  private resizeHandles: HTMLElement[][] = [];

  private group: ImageGroup;
  private options: ImageRowOptions;
  private reorderCallback: ReorderCallback | null = null;
  private resizeCallback: ResizeCallback | null = null;
  private resizeEndCallback: ResizeEndCallback | null = null;
  private dividerDragCallback: DividerDragCallback | null = null;
  private persistCallback: PersistCallback | null = null;
  private mergeExternalCallback: MergeExternalCallback | null = null;

  private loadedMetas: Map<number, ImageMeta> = new Map();
  private rowHeight: number;
  private flexGrows: number[] = [];
  onLayoutChange: (() => void) | null = null;

  constructor(group: ImageGroup, options: ImageRowOptions) {
    this.group = group;
    this.options = options;
    this.rowHeight = options.defaultRowHeight;
  }

  onReorder(cb: ReorderCallback): void {
    this.reorderCallback = cb;
  }
  onResize(cb: ResizeCallback): void {
    this.resizeCallback = cb;
  }
  onResizeEnd(cb: ResizeEndCallback): void {
    this.resizeEndCallback = cb;
  }
  onDividerDrag(cb: DividerDragCallback): void {
    this.dividerDragCallback = cb;
  }
  onPersist(cb: PersistCallback): void {
    this.persistCallback = cb;
  }
  onMergeExternal(cb: MergeExternalCallback): void {
    this.mergeExternalCallback = cb;
  }
  getCurrentFlexGrows(): number[] {
    return this.itemEls.map((el) => parseFloat(el.style.flexGrow || "1"));
  }

  /**
   * Create and return the root DOM element.
   */
  build(): HTMLElement {
    logger.debug("ImageRowWidget build", {
      imageCount: this.group.images.length,
      files: this.group.images.map((i) => i.fileName),
      options: {
        defaultRowHeight: this.options.defaultRowHeight,
        gap: this.options.gap,
        enableDividers: this.options.enableDividers,
        enableResize: this.options.enableResize,
      },
    });

    this.container = document.createElement("div");
    this.container.className = CLASSES.row;
    this.container.dataset.lineStart = String(this.group.lineStart);
    this.container.dataset.lineEnd = String(this.group.lineEnd);
    this.container.style.display = "flex";
    this.container.style.alignItems = "flex-start";
    this.container.style.gap = `${this.options.gap}px`;
    this.container.style.width = "100%";
    this.container.style.overflow = "hidden";

    const images = this.group.images;
    this.imageEls = [];
    this.itemEls = [];
    this.dividerEls = [];
    this.resizeHandles = [];

    for (let i = 0; i < images.length; i++) {
      // Divider before image (except first)
      if (i > 0 && this.options.enableDividers) {
        const divider = this.buildDivider(i - 1);
        this.container.appendChild(divider);
        this.dividerEls.push(divider);
      }

      const item = this.buildImageItem(images[i], i);
      this.container.appendChild(item);
    }

    // Initial layout pass — will be refined as images load
    this.applyLayout();

    return this.container;
  }

  private buildImageItem(image: ImageEmbed, index: number): HTMLElement {
    const item = document.createElement("div");
    item.className = CLASSES.imageItem;
    item.style.flex = `${image.flexGrow} 1 0%`;
    item.style.position = "relative";
    item.style.overflow = "hidden";
    item.style.minWidth = "50px";
    item.style.minHeight = "0";
    item.style.flexShrink = "0";
    item.style.height = "100%";
    item.dataset.index = String(index);

    const img = document.createElement("img");
    img.className = CLASSES.imageInner;
    img.src = this.options.getResourcePath(image.fileName);
    img.alt = image.fileName;
    img.style.display = "block";
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "contain";
    img.style.objectPosition = "top";
    img.dataset.index = String(index);

    img.onload = () => {
      this.loadedMetas.set(index, {
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
      });
      this.applyLayout();
    };

    img.onerror = () => {
      logger.warn("Image load failed in widget", {
        fileName: image.fileName,
        index,
        src: img.src,
      });
      this.loadedMetas.set(index, {
        naturalWidth: 400,
        naturalHeight: 300,
      });
      img.style.backgroundColor = "#f0f0f0";
      img.alt = `[Not found: ${image.fileName}]`;
    };

    item.appendChild(img);
    this.imageEls.push(img);
    this.itemEls.push(item);

    // Resize handles
    if (this.options.enableResize) {
      const handles = this.buildResizeHandles(item, index);
      this.resizeHandles.push(handles);
    }

    return item;
  }

  private buildDivider(leftIndex: number): HTMLElement {
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

    // Divider drag
    let dragging = false;
    let startX = 0;
    let startLeftFlex = 0;
    let startRightFlex = 0;
    let currentOnMove: ((e: MouseEvent) => void) | null = null;
    let currentOnUp: (() => void) | null = null;

    divider.onmousedown = (e) => {
      dragging = true;
      startX = e.clientX;
      const leftItem = this.itemEls[leftIndex];
      const rightItem = this.itemEls[leftIndex + 1];
      startLeftFlex = parseFloat(leftItem?.style.flexGrow || "1");
      startRightFlex = parseFloat(rightItem?.style.flexGrow || "1");
      e.preventDefault();

      // Keep divider visible throughout the drag
      divider.classList.add(CLASSES.dividerActive);

      // Register fresh listeners for each drag session
      if (currentOnMove) document.removeEventListener("mousemove", currentOnMove);
      if (currentOnUp) document.removeEventListener("mouseup", currentOnUp);

      currentOnMove = (ev: MouseEvent) => {
        if (!dragging) return;
        const dx = ev.clientX - startX;
        if (Math.abs(dx) < 3) return;

        const leftItem = this.itemEls[leftIndex];
        const rightItem = this.itemEls[leftIndex + 1];
        if (!leftItem || !rightItem) return;

        const sensitivity = 0.5;
        let newLeft = Math.max(0.1, startLeftFlex + dx * sensitivity * 0.01);
        const total = startLeftFlex + startRightFlex;
        let newRight = total - newLeft;

        // Enforce minimum on both sides
        if (newRight < 0.1) { newRight = 0.1; newLeft = total - 0.1; }
        if (newLeft < 0.1) { newLeft = 0.1; newRight = total - 0.1; }

        // Snap: when adjacent image heights are nearly equal, lock to equilibrium.
        // Snap zone = equilibriumHeight × snapSensitivity%.
        // Condition |leftH - rightH| < eqHeight × snapFactor simplifies to
        //   |newLeft/la - newRight/ra| < total/(la+ra) × snapFactor
        const snapFactor = this.options.snapSensitivity / 100;
        if (snapFactor > 0) {
          const lm = this.loadedMetas.get(leftIndex);
          const rm = this.loadedMetas.get(leftIndex + 1);
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

        this.recalculateRowHeight();

        if (this.dividerDragCallback) {
          const ratio = newLeft / (newLeft + newRight);
          this.dividerDragCallback(leftIndex, ratio);
        }
      };

      currentOnUp = () => {
        dragging = false;
        divider.classList.remove(CLASSES.dividerActive);
        divider.classList.remove(CLASSES.dividerSnap);
        document.removeEventListener("mousemove", currentOnMove!);
        document.removeEventListener("mouseup", currentOnUp!);
        currentOnMove = null;
        currentOnUp = null;
        this.persistCallback?.();
      };

      document.addEventListener("mousemove", currentOnMove);
      document.addEventListener("mouseup", currentOnUp, { once: true });
    };

    divider._destroy = () => {
      if (currentOnMove) document.removeEventListener("mousemove", currentOnMove);
      if (currentOnUp) document.removeEventListener("mouseup", currentOnUp);
    };

    return divider;
  }

  private buildResizeHandles(
    item: HTMLElement,
    index: number
  ): HTMLElement[] {
    const handles: HTMLElement[] = [];
    const positions: Array<{
      top?: string; bottom?: string; left?: string; right?: string;
      cursor: string;
    }> = [
      { top: "0", left: "0", cursor: "nw-resize" },
      { top: "0", right: "0", cursor: "ne-resize" },
      { bottom: "0", left: "0", cursor: "sw-resize" },
      { bottom: "0", right: "0", cursor: "se-resize" },
    ];

    for (const pos of positions) {
      const handle = document.createElement("div");
      handle.className = CLASSES.resizeHandle;
      handle.style.position = "absolute";
      handle.style.width = `${RESIZE_HANDLE_SIZE}px`;
      handle.style.height = `${RESIZE_HANDLE_SIZE}px`;
      handle.style.borderRadius = "50%";
      handle.style.backgroundColor = "#4a9eff";
      handle.style.visibility = "hidden";
      handle.style.zIndex = "2";
      handle.style.cursor = pos.cursor;
      if (pos.top !== undefined) handle.style.top = pos.top;
      if (pos.bottom !== undefined) handle.style.bottom = pos.bottom;
      if (pos.left !== undefined) handle.style.left = pos.left;
      if (pos.right !== undefined) handle.style.right = pos.right;

      // Show handles on hover — use visibility instead of opacity to avoid
      // creating a new stacking context, which can shift flex+object-fit images.
      item.onmouseenter = () => {
        for (const h of handles) h.style.visibility = "visible";
      };
      item.onmouseleave = () => {
        for (const h of handles) h.style.visibility = "hidden";
      };

      // Resize drag
      let dragging = false;
      let startX = 0;
      let startFlex = 0;
      let currentOnMove: ((e: MouseEvent) => void) | null = null;
      let currentOnUp: (() => void) | null = null;

      handle.onmousedown = (e) => {
        dragging = true;
        startX = e.clientX;
        startFlex = parseFloat(item.style.flexGrow || "1");
        e.preventDefault();
        e.stopPropagation();

        // Register fresh listeners for each drag session
        if (currentOnMove) document.removeEventListener("mousemove", currentOnMove);
        if (currentOnUp) document.removeEventListener("mouseup", currentOnUp);

        currentOnMove = (ev: MouseEvent) => {
          if (!dragging) return;
          const dx = ev.clientX - startX;
          if (Math.abs(dx) < 3) return;
          let newFlex = Math.max(0.1, startFlex + dx * 0.01);

          // Snap to neighbor when heights become equal.
          // Snap zone = equilibriumHeight × snapSensitivity%.
          // Simplifies to height-based comparison: |curH - neighborH| < eqH × snapFactor
          const snapFactor = this.options.snapSensitivity / 100;
          if (snapFactor > 0) {
            const cm = this.loadedMetas.get(index);
            if (cm && cm.naturalWidth > 0) {
              const ca = cm.naturalWidth / cm.naturalHeight;
              let bestTarget: number | null = null;
              let bestScore = Infinity;

              // Check left neighbor
              if (index > 0) {
                const lm = this.loadedMetas.get(index - 1);
                if (lm && lm.naturalWidth > 0) {
                  const la = lm.naturalWidth / lm.naturalHeight;
                  const lf = parseFloat(this.itemEls[index - 1].style.flexGrow || "1");
                  const target = lf * ca / la;
                  // Height diff scaled: |newFlex/ca - lf/la| vs (lf/la) × snapFactor
                  const heightDiff = Math.abs(newFlex / ca - lf / la);
                  const snapThreshold = (lf / la) * snapFactor;
                  const score = snapThreshold > 0 ? heightDiff / snapThreshold : Infinity;
                  if (score < bestScore) { bestScore = score; bestTarget = target; }
                }
              }

              // Check right neighbor
              if (index < this.itemEls.length - 1) {
                const rm = this.loadedMetas.get(index + 1);
                if (rm && rm.naturalWidth > 0) {
                  const ra = rm.naturalWidth / rm.naturalHeight;
                  const rf = parseFloat(this.itemEls[index + 1].style.flexGrow || "1");
                  const target = rf * ca / ra;
                  const heightDiff = Math.abs(newFlex / ca - rf / ra);
                  const snapThreshold = (rf / ra) * snapFactor;
                  const score = snapThreshold > 0 ? heightDiff / snapThreshold : Infinity;
                  if (score < bestScore) { bestScore = score; bestTarget = target; }
                }
              }

              if (bestTarget !== null && bestScore < 1) {
                newFlex = bestTarget;
                item.classList.add(CLASSES.itemSnap);
              } else {
                item.classList.remove(CLASSES.itemSnap);
              }
            }
          }

          item.style.flexGrow = String(newFlex);
          this.recalculateRowHeight();
        };

        currentOnUp = () => {
          dragging = false;
          item.classList.remove(CLASSES.itemSnap);
          const finalFlex = parseFloat(item.style.flexGrow || "1");
          if (this.resizeEndCallback) {
            this.resizeEndCallback(index, finalFlex);
          }
          document.removeEventListener("mousemove", currentOnMove!);
          document.removeEventListener("mouseup", currentOnUp!);
          currentOnMove = null;
          currentOnUp = null;
          this.persistCallback?.();
        };

        document.addEventListener("mousemove", currentOnMove);
        document.addEventListener("mouseup", currentOnUp, { once: true });
      };

      handle._destroy = () => {
        if (currentOnMove) document.removeEventListener("mousemove", currentOnMove);
        if (currentOnUp) document.removeEventListener("mouseup", currentOnUp);
      };

      item.appendChild(handle);
      handles.push(handle);
    }

    return handles;
  }

  /**
   * Recalculate layout based on loaded image dimensions.
   */
  private applyLayout(): void {
    if (!this.container || this.group.images.length === 0) return;

    const metas: ImageMeta[] = [];
    for (let i = 0; i < this.group.images.length; i++) {
      const meta = this.loadedMetas.get(i);
      if (meta) {
        metas.push(meta);
      } else {
        metas.push({ naturalWidth: 0, naturalHeight: 0 });
      }
    }

    const allLoaded = metas.every((m) => m.naturalWidth > 0);

    if (allLoaded) {
      // When flex-grows were loaded from markdown |width, use the current
      // distribution to calculate max height (avoids overwriting user adjustments).
      if (this.group.images.some((img) => img.hasExplicitWidth)) {
        this.recalculateRowHeight();
        return;
      }

      const containerWidth = this.container.getBoundingClientRect().width;
      // Element not in DOM yet — retry after layout
      if (containerWidth === 0) {
        requestAnimationFrame(() => this.applyLayout());
        return;
      }
      const result = computeUniformHeight(
        metas,
        containerWidth,
        this.options.gap,
        50,
        this.options.defaultRowHeight * 3
      );
      this.rowHeight = result.rowHeight;
      const h = `${this.rowHeight}px`;
      this.container.style.height = h;

      const grows = computeFlexGrows(metas);
      for (let i = 0; i < this.itemEls.length && i < grows.length; i++) {
        this.itemEls[i].style.flexGrow = String(grows[i]);
        this.group.images[i].flexGrow = grows[i];
      }
      for (let i = 0; i < this.itemEls.length; i++) {
        this.itemEls[i].style.height = h;
      }
      for (let i = 0; i < this.imageEls.length; i++) {
        this.imageEls[i].style.height = h;
      }

      logger.debug("ImageRowWidget layout applied", {
        containerWidth,
        rowHeight: result.rowHeight,
        flexGrows: grows,
        imageCount: metas.length,
      });
      this.onLayoutChange?.();
    } else {
      // Use a sensible default until images load
      this.container.style.height = `${this.options.defaultRowHeight}px`;
    }
  }

  /**
   * Recalculate the flex container height after divider/resize drag so that
   * all images display fully without clipping.  Uses current flex-grow values
   * and natural aspect ratios — the tallest image determines the row height.
   */
  private recalculateRowHeight(): void {
    if (!this.container || this.itemEls.length === 0) return;

    const containerWidth = this.container.getBoundingClientRect().width;
    if (containerWidth === 0) return;

    // Guard: all images must be loaded (we need natural dimensions)
    for (let i = 0; i < this.group.images.length; i++) {
      const meta = this.loadedMetas.get(i);
      if (!meta || meta.naturalWidth === 0) return;
    }

    const n = this.itemEls.length;
    const availableWidth = containerWidth - (n - 1) * this.options.gap;

    let totalGrow = 0;
    const grows: number[] = [];
    for (let i = 0; i < n; i++) {
      const g = parseFloat(this.itemEls[i].style.flexGrow || "1");
      grows.push(g);
      totalGrow += g;
    }

    let maxHeight = 0;
    for (let i = 0; i < n; i++) {
      const meta = this.loadedMetas.get(i)!;
      const w = (grows[i] / totalGrow) * availableWidth;
      const h = w / (meta.naturalWidth / meta.naturalHeight);
      maxHeight = Math.max(maxHeight, h);
    }

    const clamped = Math.max(
      50,
      Math.min(this.options.defaultRowHeight * 3, Math.round(maxHeight))
    );
    this.rowHeight = clamped;

    const h = `${clamped}px`;
    this.container.style.height = h;
    for (let i = 0; i < this.itemEls.length; i++) {
      this.itemEls[i].style.height = h;
    }
    for (let i = 0; i < this.imageEls.length; i++) {
      this.imageEls[i].style.height = h;
    }

    this.onLayoutChange?.();
  }

  /**
   * Update the flex-grow values from an external source (e.g., after reorder).
   */
  updateFlexGrows(grows: number[]): void {
    this.flexGrows = grows;
    for (let i = 0; i < this.itemEls.length && i < grows.length; i++) {
      this.itemEls[i].style.flexGrow = String(grows[i]);
    }
    this.recalculateRowHeight();
  }

  /**
   * Call when the container width changes (e.g., window resize).
   */
  onContainerResize(): void {
    this.applyLayout();
  }

  /**
   * Enable drag reorder on the images in this row.
   * Call after build() and after setting onReorder callback.
   */
  enableDragReorder(): void {
    if (!this.container) return;

    for (let i = 0; i < this.itemEls.length; i++) {
      const item = this.itemEls[i];
      item.draggable = true;

      item.ondragstart = (e) => {
        e.stopPropagation();
        e.dataTransfer!.effectAllowed = "move";
        // Encode source: group lineStart + index so any target can identify the source line
        const payload = `diaa-row:${this.group.lineStart}:${i}`;
        e.dataTransfer!.setData("text/plain", payload);
        // Custom MIME type for dragover detection (Chrome blocks getData in dragover)
        e.dataTransfer!.setData("application/diaa-row", payload);
        item.classList.add(CLASSES.dragging);
        logger.info("ImageRowWidget dragstart", {
          index: i,
          groupLineStart: this.group.lineStart,
          payload,
          targetTag: (e.target as HTMLElement).tagName,
          targetClass: (e.target as HTMLElement).className?.substring?.(0, 40) || "",
        });
      };

      item.ondragend = (e) => {
        e.stopPropagation();
        item.classList.remove(CLASSES.dragging);
        for (const el of this.itemEls) {
          el.style.borderLeft = "";
          el.style.borderRight = "";
        }
      };

      item.ondragover = (e) => {
        e.stopPropagation();
        e.preventDefault();
        e.dataTransfer!.dropEffect = "move";
        const rect = item.getBoundingClientRect();
        const mid = rect.left + rect.width / 2;

        for (const el of this.itemEls) {
          el.style.borderLeft = "";
          el.style.borderRight = "";
        }
        if (e.clientX < mid) {
          item.style.borderLeft = "3px solid #4a9eff";
        } else {
          item.style.borderRight = "3px solid #4a9eff";
        }
      };

      item.ondragleave = (e) => {
        e.stopPropagation();
        item.style.borderLeft = "";
        item.style.borderRight = "";
      };

      item.ondrop = (e) => {
        e.stopPropagation();
        e.preventDefault();
        item.style.borderLeft = "";
        item.style.borderRight = "";

        const data = e.dataTransfer!.getData("text/plain");
        logger.debug("ImageRowWidget item ondrop", { i, data: data?.substring(0, 60) });

        if (!data) return;

        const rect = item.getBoundingClientRect();
        const mid = rect.left + rect.width / 2;
        const insertAt = e.clientX < mid ? i : i + 1;

        // Flex row source: "diaa-row:<lineStart>:<index>"
        const rowMatch = data.match(/^diaa-row:(\d+):(\d+)$/);
        if (rowMatch) {
          const srcLineStart = parseInt(rowMatch[1], 10);
          const srcIndex = parseInt(rowMatch[2], 10);

          if (srcLineStart === this.group.lineStart) {
            // Intra-row reorder (same group)
            const toIndex = srcIndex < insertAt ? insertAt - 1 : insertAt;
            if (srcIndex !== toIndex && srcIndex !== i && this.reorderCallback) {
              this.reorderCallback(srcIndex, toIndex);
            }
            return;
          }

          // Inter-row: move from another flex row into this one
          if (this.mergeExternalCallback) {
            logger.info("ImageRowWidget inter-row merge", { i, insertAt, srcLineStart, srcIndex });
            this.mergeExternalCallback(insertAt, data);
          }
          return;
        }

        // Standalone source: diaa-standalone:<line> (intercepted) or obsidian://open URI
        if ((data.startsWith("diaa-standalone:") || data.startsWith("obsidian://open")) && this.mergeExternalCallback) {
          logger.info("ImageRowWidget cross-row merge from standalone", { i, insertAt, data: data.substring(0, 60) });
          this.mergeExternalCallback(insertAt, data);
        }
      };
    }

    // Container-level fallback: accept drops that land between items or on the row background
    if (this.container) {
      this.container.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer!.dropEffect = "move";
      });

      this.container.addEventListener("drop", (e) => {
        e.preventDefault();
        const data = e.dataTransfer!.getData("text/plain");
        logger.debug("ImageRowWidget container ondrop", { data: data?.substring(0, 60) });
        if (!data) return;

        // Only handle non-intra-row drops at container level (intra-row is item-level)
        const rowMatch = data.match(/^diaa-row:(\d+):(\d+)$/);
        const isStandalone = data.startsWith("diaa-standalone:") || data.startsWith("obsidian://open");
        if ((rowMatch || isStandalone) && this.mergeExternalCallback) {
          const containerRect = this.container!.getBoundingClientRect();
          const mid = containerRect.left + containerRect.width / 2;
          const insertAt = e.clientX < mid ? 0 : this.itemEls.length;
          logger.info("ImageRowWidget cross-row merge (container)", { insertAt });
          this.mergeExternalCallback(insertAt, data);
        }
      });
    }
  }

  /**
   * Clean up all event listeners.
   */
  destroy(): void {
    for (const divider of this.dividerEls) {
      if (divider._destroy) divider._destroy();
    }
    for (const handles of this.resizeHandles) {
      for (const h of handles) {
        if (h._destroy) h._destroy();
      }
    }
    this.imageEls = [];
    this.itemEls = [];
    this.dividerEls = [];
    this.resizeHandles = [];
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
  }
}

// Extend HTMLElement to hold destroy functions (not exported)
declare global {
  interface HTMLElement {
    _destroy?: () => void;
  }
}
