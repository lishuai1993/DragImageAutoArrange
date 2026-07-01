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
  topBarSensitivity: number;
  ghostImageWidth: number;
  dragOpacity: number;
  getResourcePath: (fileName: string) => string;
}

export type ReorderCallback = (fromIndex: number, toIndex: number) => void;
export type ResizeCallback = (imageIndex: number, newFlexGrow: number) => void;
export type ResizeEndCallback = (imageIndex: number, newFlexGrow: number) => void;
export type DividerDragCallback = (leftIndex: number, ratio: number) => void;
export type PersistCallback = () => void;
export type MergeExternalCallback = (insertAtIndex: number, dataTransfer: string) => void;

interface HandleDef {
  el: HTMLElement;
  relX: number; // 0=left, 0.5=center, 1=right (relative to image content rect)
  relY: number; // 0=top, 0.5=center, 1=bottom (relative to image content rect)
}

/**
 * Builds and manages the DOM for a flex row of images.
 */
export class ImageRowWidget {
  container: HTMLElement | null = null;
  private imageEls: HTMLImageElement[] = [];
  private itemEls: HTMLElement[] = [];
  private dividerEls: HTMLElement[] = [];
  private resizeHandles: HTMLElement[][] = [];
  private handleDefs: HandleDef[][] = [];
  private resizeObserver: ResizeObserver | null = null;

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

    // Top hover bar (visual indicator only — pointer-events: none so it
    // never blocks resize handles at the top edge of images).
    const topBar = document.createElement("div");
    topBar.className = CLASSES.topBar;
    this.container.appendChild(topBar);

    // Double-click on container top edge → equalize all image heights
    let topBarDblClickArmed = false;
    this.container.addEventListener("dblclick", (e) => {
      if (!topBarDblClickArmed) return;
      e.preventDefault();
      e.stopPropagation();
      this.snapAllToEquilibrium();
    });

    // Show/hide top bar based on mouse proximity to container top
    const sensitivity = this.options.topBarSensitivity;
    this.container.addEventListener("mousemove", (e) => {
      const rect = this.container!.getBoundingClientRect();
      const offsetY = e.clientY - rect.top;
      if (offsetY <= sensitivity) {
        topBar.style.backgroundColor = "#4a9eff";
        topBarDblClickArmed = true;
      } else {
        topBar.style.backgroundColor = "";
        topBarDblClickArmed = false;
      }
    });
    this.container.addEventListener("mouseleave", () => {
      topBar.style.backgroundColor = "";
      topBarDblClickArmed = false;
    });

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

    // ResizeObserver: auto-update handle positions when ANY layout change
    // occurs (our resize, Obsidian native resize, window resize, etc.)
    this.resizeObserver = new ResizeObserver(() => {
      this.updateAllHandlePositions();
    });
    this.resizeObserver.observe(this.container);
    for (const item of this.itemEls) {
      this.resizeObserver.observe(item);
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
    item.style.height = "100%";
    item.dataset.index = String(index);

    const img = document.createElement("img");
    img.className = CLASSES.imageInner;
    img.alt = image.fileName;
    img.style.display = "block";
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "contain";
    img.style.objectPosition = "left top";
    img.dataset.index = String(index);

    // Set onload BEFORE src so cached images don't fire synchronously
    // before the handler is registered.
    const handleLoad = () => {
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;
      logger.debug("ImageRowWidget img onload", { index, file: image.fileName, naturalWidth: nw, naturalHeight: nh, complete: img.complete });
      this.loadedMetas.set(index, { naturalWidth: nw, naturalHeight: nh });
      this.applyLayout();
      requestAnimationFrame(() => this.updateHandlePositions(index));
    };

    img.onload = handleLoad;

    img.onerror = () => {
      logger.warn("Image load failed in widget", { fileName: image.fileName, index, src: img.src.substring(0, 80) });
      this.loadedMetas.set(index, { naturalWidth: 400, naturalHeight: 300 });
      img.style.backgroundColor = "#f0f0f0";
      img.alt = `[Not found: ${image.fileName}]`;
      this.applyLayout();
    };

    img.src = this.options.getResourcePath(image.fileName);

    // Guard: if the image was already cached and the browser didn't fire
    // onload despite being set before src (Electron/Chromium edge case),
    // handle it here.
    if (img.complete && img.naturalWidth > 0) {
      logger.debug("ImageRowWidget img already complete", { index, file: image.fileName, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight });
      handleLoad();
    }

    item.appendChild(img);
    this.imageEls.push(img);
    this.itemEls.push(item);

    // Resize handles
    if (this.options.enableResize) {
      const handles = this.buildResizeHandles(item, index);
      this.resizeHandles.push(handles);
      item.onmouseenter = () => { this.updateHandlePositions(index); };
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

    // Double-click divider → snap to equal heights
    divider.ondblclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.snapDividerToEquilibrium(leftIndex);
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

  /**
   * Compute the actual rendered image rect within a flex item,
   * accounting for object-fit: contain + object-position: left top.
   */
  private getImageContentRect(index: number): { left: number; top: number; width: number; height: number } | null {
    const item = this.itemEls[index];
    const img = this.imageEls[index];
    if (!item || !img) return null;

    // Force synchronous reflow so clientWidth/clientHeight reflect the
    // most recent style changes (height updates, flex-grow changes, etc.).
    void item.offsetHeight;

    const cw = item.clientWidth;
    const ch = item.clientHeight;
    if (cw === 0 || ch === 0) return null;

    const meta = this.loadedMetas.get(index);
    if (!meta || meta.naturalWidth === 0) return null;

    const imageAspect = meta.naturalWidth / meta.naturalHeight;
    const containerAspect = cw / ch;

    let displayW: number;
    let displayH: number;

    if (imageAspect > containerAspect) {
      // Image is wider — fills full width, height constrained by aspect
      displayW = cw;
      displayH = cw / imageAspect;
    } else {
      // Image is taller — fills full height, width constrained by aspect
      displayH = ch;
      displayW = ch * imageAspect;
    }

    return { left: 0, top: 0, width: displayW, height: displayH };
  }

  /** Reposition resize handles to match the actual image content rect. */
  private updateHandlePositions(index: number): void {
    const rect = this.getImageContentRect(index);
    const defs = this.handleDefs[index];
    if (!rect || !defs) return;

    const SZ = RESIZE_HANDLE_SIZE;
    for (const hd of defs) {
      // Position handles snug INSIDE the image content edges.
      // relX=0 → left edge, relX=1 → right edge, relX=0.5 → horizontal center.
      hd.el.style.left = (hd.relX * (rect.width - SZ)) + "px";
      hd.el.style.top = (hd.relY * (rect.height - SZ)) + "px";
    }
  }

  /** Reposition all resize handles after a layout change. */
  private updateAllHandlePositions(): void {
    for (let i = 0; i < this.itemEls.length; i++) {
      this.updateHandlePositions(i);
    }
  }

  private buildResizeHandles(
    item: HTMLElement,
    index: number
  ): HTMLElement[] {
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
      const handle = document.createElement("div");
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
      let totalG = 0;
      let startFlex = 0;
      let startWidth = 0;
      let startHeight = 0;
      let maxHeight = 2000;
      let scale = 1;
      let nItems = 0;
      handle.onmousedown = (e) => {
        dragging = true;
        item.classList.add(CLASSES.resizing);
        logger.debug("resize-mousedown", { index, timestamp: Date.now(), relX: hd.relX, relY: hd.relY });
        e.preventDefault();
        e.stopPropagation();

        // Snapshot layout state
        const containerRect = this.container!.getBoundingClientRect();
        nItems = this.itemEls.length;
        AW = containerRect.width - (nItems - 1) * this.options.gap;

        totalG = 0;
        const grows: number[] = [];
        for (let j = 0; j < nItems; j++) {
          const g = parseFloat(this.itemEls[j].style.flexGrow || "1");
          grows.push(g);
          totalG += g;
        }
        startFlex = grows[index];
        startWidth = (startFlex / totalG) * AW;
        startHeight = parseFloat(this.container!.style.height || "0");

        // For single-image rows, cap height at the point where the image
        // fills the full container width — beyond that the image won't grow.
        if (nItems === 1) {
          const meta = this.loadedMetas.get(index);
          if (meta && meta.naturalWidth > 0) {
            const aspect = meta.naturalWidth / meta.naturalHeight;
            maxHeight = aspect > 0 ? Math.round(AW / aspect) : 2000;
          }
        }

        // Scale: image-content width to item-width ratio.
        // When object-fit:contain makes the image narrower than the item,
        // a cursor dx maps to a larger item-width change so the handle
        // visually tracks the cursor 1:1.
        const displayRect = this.getImageContentRect(index);
        const displayW = displayRect ? displayRect.width : startWidth;
        scale = displayW > 0 ? startWidth / displayW : 1;
        if (currentOnMove) document.removeEventListener("mousemove", currentOnMove);
        if (currentOnUp) document.removeEventListener("mouseup", currentOnUp);

        currentOnMove = (ev: MouseEvent) => {
          if (!dragging) return;

          // ── Single-image row: direct height scaling (flex-grow is meaningless) ──
          if (nItems === 1) {
            const dx = ev.clientX - e.clientX;
            const dy = ev.clientY - e.clientY;

            const xSign = hd.relX < 0.5 ? -1 : 1;
            const ySign = hd.relY < 0.5 ? -1 : 1;

            // Weighted blend of dx/dy based on handle position.
            // Edge handles track the perpendicular axis only;
            // corner handles average both axes. This eliminates
            // the discontinuous jump that a binary dominant-axis switch causes.
            const wx = 2 * Math.abs(hd.relX - 0.5);
            const wy = 2 * Math.abs(hd.relY - 0.5);
            const SENS = 1;
            const delta = wx + wy > 0
              ? (dx * xSign * wx + dy * ySign * wy) / (wx + wy) * SENS
              : 0;

            const newHeight = Math.max(50, Math.min(maxHeight, Math.round(startHeight + delta)));
            const h = `${newHeight}px`;
            this.container!.style.height = h;
            this.itemEls[0].style.height = h;
            this.imageEls[0].style.height = h;
            this.updateHandlePositions(0);
            return;
          }

          // ── Multi-image row: row-height scaling (dividers stay fixed) ──
          const dy = ev.clientY - e.clientY;
          const ySign = hd.relY < 0.5 ? -1 : 1;
          const wy = 2 * Math.abs(hd.relY - 0.5);
          const wx = 2 * Math.abs(hd.relX - 0.5);
          const sY = 1;
          const yDelta = wx + wy > 0
            ? (dy * ySign * wy) / (wx + wy) * sY
            : 0;
          const newRowHeight = Math.max(50, Math.min(2000, Math.round(startHeight + yDelta)));
          const h = `${newRowHeight}px`;
          this.container!.style.height = h;
          const origH = `${startHeight}px`;
          for (let j = 0; j < this.itemEls.length; j++) {
            if (j === index) {
              this.itemEls[j].style.height = h;
              this.imageEls[j].style.height = h;
            } else {
              this.itemEls[j].style.height = origH;
              this.imageEls[j].style.height = origH;
            }
          }
          this.updateHandlePositions(index);
        };

        currentOnUp = () => {
          dragging = false;
          item.classList.remove(CLASSES.resizing);
          item.classList.remove(CLASSES.itemSnap);

          const finalFlex = parseFloat(item.style.flexGrow || "1");
          logger.debug("resize-mouseup", { index, finalFlex, nItems, timestamp: Date.now() });
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
      hd.el = handle;
      handles.push(handle);
    }

    this.handleDefs.push(defs);

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
    logger.debug("ImageRowWidget applyLayout", { allLoaded, hasExplicitWidth: this.group.images.some((img) => img.hasExplicitWidth), metaCount: metas.filter(m => m.naturalWidth > 0).length, totalImages: this.group.images.length });

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
      // Force reflow so handle positions use the new dimensions
      void this.container.offsetHeight;
      this.updateAllHandlePositions();
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
    if (containerWidth === 0) {
      requestAnimationFrame(() => this.recalculateRowHeight());
      return;
    }

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

    const upperClamp = n === 1 ? 2000 : this.options.defaultRowHeight * 3;
    const clamped = Math.max(
      50,
      Math.min(upperClamp, Math.round(maxHeight))
    );
    this.rowHeight = clamped;

    logger.debug("ImageRowWidget recalculateRowHeight", { containerWidth, availableWidth, grows, totalGrow, maxHeight, clampedRowHeight: clamped, imageCount: n });

    const h = `${clamped}px`;
    this.container.style.height = h;
    for (let i = 0; i < this.itemEls.length; i++) {
      this.itemEls[i].style.height = h;
    }
    for (let i = 0; i < this.imageEls.length; i++) {
      this.imageEls[i].style.height = h;
    }

    this.onLayoutChange?.();
    // Force reflow so handle positions use the new dimensions
    void this.container.offsetHeight;
    this.updateAllHandlePositions();
  }

  /**
   * Double-click on divider: snap the two adjacent images to equal heights.
   */
  private snapDividerToEquilibrium(leftIndex: number): void {
    const lm = this.loadedMetas.get(leftIndex);
    const rm = this.loadedMetas.get(leftIndex + 1);
    if (!lm || !rm || lm.naturalWidth === 0 || rm.naturalWidth === 0) return;

    const la = lm.naturalWidth / lm.naturalHeight;
    const ra = rm.naturalWidth / rm.naturalHeight;

    const leftItem = this.itemEls[leftIndex];
    const rightItem = this.itemEls[leftIndex + 1];
    if (!leftItem || !rightItem) return;

    const total = parseFloat(leftItem.style.flexGrow || "1") + parseFloat(rightItem.style.flexGrow || "1");
    const snapLeft = total * la / (la + ra);
    const snapRight = total - snapLeft;

    leftItem.style.flexGrow = String(snapLeft);
    rightItem.style.flexGrow = String(snapRight);

    this.recalculateRowHeight();

    logger.info("Divider dblclick snap to equilibrium", {
      leftIndex,
      total,
      snapLeft,
      snapRight,
      la,
      ra,
    });
  }

  /**
   * Double-click top bar: snap ALL images in the row to equal heights.
   * Distributes flex-grow proportionally to aspect ratios so every image
   * has the same rendered height.
   */
  private snapAllToEquilibrium(): void {
    const n = this.itemEls.length;
    if (n < 2) return;

    // Gather aspect ratios; all images must be loaded
    const aspects: number[] = [];
    let totalGrow = 0;
    for (let i = 0; i < n; i++) {
      const meta = this.loadedMetas.get(i);
      if (!meta || meta.naturalWidth === 0) return;
      aspects.push(meta.naturalWidth / meta.naturalHeight);
      totalGrow += parseFloat(this.itemEls[i].style.flexGrow || "1");
    }

    const aspectSum = aspects.reduce((s, a) => s + a, 0);
    const grows: number[] = aspects.map((a) => (totalGrow * a) / aspectSum);

    for (let i = 0; i < n; i++) {
      this.itemEls[i].style.flexGrow = String(grows[i]);
    }

    this.recalculateRowHeight();

    logger.info("Top bar dblclick global snap", { totalGrow, aspectSum, grows });
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
        // Configurable opacity: higher dragOpacity = more transparent
        item.style.opacity = String(1 - this.options.dragOpacity / 100);

        // Custom fully-opaque ghost that follows cursor via dragover
        const imgEl = this.imageEls[i];
        if (imgEl && imgEl.naturalWidth > 0) {
          // Hide browser's default semi-transparent ghost with a transparent 1x1 pixel
          const pixel = document.createElement("canvas");
          pixel.width = 1;
          pixel.height = 1;
          pixel.style.cssText = "position:fixed;left:0;top:0;pointer-events:none";
          document.body.appendChild(pixel);
          e.dataTransfer!.setDragImage(pixel, 0, 0);
          setTimeout(() => pixel.remove(), 0);

          // Custom fully-opaque ghost, initially at cursor (with DPR for sharpness)
          const w = this.options.ghostImageWidth;
          const h = (imgEl.naturalHeight / imgEl.naturalWidth) * w;
          const dpr = window.devicePixelRatio || 1;
          const ghost = document.createElement("canvas");
          ghost.width = w * dpr;
          ghost.height = h * dpr;
          ghost.style.width = w + "px";
          ghost.style.height = h + "px";
          ghost.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;width:${w}px;height:${h}px;pointer-events:none;z-index:2147483647`;
          const ctx = ghost.getContext("2d")!;
          ctx.scale(dpr, dpr);
          ctx.drawImage(imgEl, 0, 0, w, h);
          document.body.appendChild(ghost);

          const onDragOver = (ev: DragEvent) => {
            ghost.style.left = ev.clientX + "px";
            ghost.style.top = ev.clientY + "px";
          };
          const onDragEnd = () => {
            document.removeEventListener("dragover", onDragOver, true);
            ghost.remove();
          };
          document.addEventListener("dragover", onDragOver, true);
          item.addEventListener("dragend", onDragEnd, { once: true });
        }

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
        item.style.opacity = "";
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
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.imageEls = [];
    this.itemEls = [];
    this.dividerEls = [];
    this.resizeHandles = [];
    this.handleDefs = [];
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
