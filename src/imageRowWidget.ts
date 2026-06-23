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
  getResourcePath: (fileName: string) => string;
}

export type ReorderCallback = (fromIndex: number, toIndex: number) => void;
export type ResizeCallback = (imageIndex: number, newFlexGrow: number) => void;
export type ResizeEndCallback = (imageIndex: number, newFlexGrow: number) => void;
export type DividerDragCallback = (leftIndex: number, ratio: number) => void;

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
    img.draggable = false; // We handle drag on the item level
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
        const newLeft = Math.max(0.1, startLeftFlex + dx * sensitivity * 0.01);
        const total = startLeftFlex + startRightFlex;
        const newRight = Math.max(0.1, total - newLeft);

        leftItem.style.flexGrow = String(newLeft);
        rightItem.style.flexGrow = String(newRight);

        if (this.dividerDragCallback) {
          const ratio = newLeft / (newLeft + newRight);
          this.dividerDragCallback(leftIndex, ratio);
        }
      };

      currentOnUp = () => {
        dragging = false;
        document.removeEventListener("mousemove", currentOnMove!);
        document.removeEventListener("mouseup", currentOnUp!);
        currentOnMove = null;
        currentOnUp = null;
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
      handle.style.opacity = "0";
      handle.style.transition = "opacity 0.15s";
      handle.style.zIndex = "2";
      handle.style.cursor = pos.cursor;
      if (pos.top !== undefined) handle.style.top = pos.top;
      if (pos.bottom !== undefined) handle.style.bottom = pos.bottom;
      if (pos.left !== undefined) handle.style.left = pos.left;
      if (pos.right !== undefined) handle.style.right = pos.right;

      // Show handles on hover
      item.onmouseenter = () => {
        for (const h of handles) h.style.opacity = "1";
      };
      item.onmouseleave = () => {
        for (const h of handles) h.style.opacity = "0";
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
          const newFlex = Math.max(0.1, startFlex + dx * 0.01);
          item.style.flexGrow = String(newFlex);
        };

        currentOnUp = () => {
          dragging = false;
          const finalFlex = parseFloat(item.style.flexGrow || "1");
          if (this.resizeEndCallback) {
            this.resizeEndCallback(index, finalFlex);
          }
          document.removeEventListener("mousemove", currentOnMove!);
          document.removeEventListener("mouseup", currentOnUp!);
          currentOnMove = null;
          currentOnUp = null;
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
      this.container.style.height = `${this.rowHeight}px`;

      // Update flex-grow on each item to match aspect ratios for equal height
      const grows = computeFlexGrows(metas);
      for (let i = 0; i < this.itemEls.length && i < grows.length; i++) {
        this.itemEls[i].style.flexGrow = String(grows[i]);
        this.group.images[i].flexGrow = grows[i];
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
   * Update the flex-grow values from an external source (e.g., after reorder).
   */
  updateFlexGrows(grows: number[]): void {
    this.flexGrows = grows;
    for (let i = 0; i < this.itemEls.length && i < grows.length; i++) {
      this.itemEls[i].style.flexGrow = String(grows[i]);
    }
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
        e.dataTransfer!.setData("text/plain", String(i));
        item.classList.add(CLASSES.dragging);
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

        const fromIndex = parseInt(e.dataTransfer!.getData("text/plain"), 10);
        if (isNaN(fromIndex) || fromIndex === i) return;

        const rect = item.getBoundingClientRect();
        const mid = rect.left + rect.width / 2;
        const insertAt = e.clientX < mid ? i : i + 1;
        const toIndex = fromIndex < insertAt ? insertAt - 1 : insertAt;

        if (fromIndex !== toIndex && this.reorderCallback) {
          this.reorderCallback(fromIndex, toIndex);
        }
      };
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
