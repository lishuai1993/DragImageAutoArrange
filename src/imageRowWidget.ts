import { CLASSES, DIVIDER_WIDTH, RESIZE_HANDLE_SIZE, DEFAULT_SETTINGS, SINGLE_IMAGE_MIN_WIDTH, SingleImageSizeMode } from "./constants";
import { ImageGroup, ImageEmbed, ImageMeta } from "./imageDetector";
import { computeFlexGrows, computeUniformHeight, computeRowHeight, computeImageContentRect, computeDividerEquilibrium, computeGlobalEquilibrium, computeScaleBasedHeights, computeSingleImageWidth } from "./layoutEngine";
import { resolveImageSrc, alignmentToCSS } from "./utils";
import { logger } from "./logger";
import { clampFlexGrow, clampScale, validateRowFlexGrows } from "./parameterValidator";
import { isSingleImageManual, singleImageScaleFor, formatSingleImageLine } from "./singleImageParams";
import { stripObsidianClasses, neutralizeWrappers } from "./rowRenderer";
import { DividerController, DividerHost } from "./dividerController";
import { ResizeHandleController, ResizeHost, HandleDef } from "./resizeHandleController";
import { DragReorderController, DragReorderHost } from "./dragReorderController";

function mkRowKey(sourcePath: string, _lineStart: number, fileNames: string[]): string {
  const sorted = [...fileNames].sort().join(",");
  return `${sourcePath}:${sorted}`;
}

/** Serialize the preserved sizes map into a plain object for persistence. */
export function exportPreservedSizes(): Record<string, MultiImageSizeData> {
  const result: Record<string, MultiImageSizeData> = {};
  for (const [key, val] of preservedMultiImageSizes) {
    result[key] = val;
  }
  return result;
}

/** Restore the preserved sizes map from a previously exported plain object. */
export function importPreservedSizes(data: Record<string, MultiImageSizeData>): void {
  for (const [key, val] of Object.entries(data)) {
    // Skip old line-based keys ("path:digits"): new format is "path:file1,file2,..."
    const suffix = key.split(":").pop()!;
    if (/^\d+$/.test(suffix)) continue;
    if (val && val.images && val.items) {
      preservedMultiImageSizes.set(key, val as MultiImageSizeData);
    }
  }
}

/** Preserved multi-image inline style dimensions keyed by "sourcePath:sortedFileNames".
 *  Saved on destroy, restored in applyLayout before any other layout path,
 *  so corner-handle per-image height adjustments survive widget recreation. */
export const preservedMultiImageSizes = new Map<string, MultiImageSizeData>();

export interface ImageRowOptions {
  defaultRowHeight: number;
  gap: number;
  enableDividers: boolean;
  enableResize: boolean;
  snapSensitivity: number;
  topBarSensitivity: number;
  ghostImageWidth: number;
  dragOpacity: number;
  alignment: "left" | "center" | "right";
  singleImageSizeMode: SingleImageSizeMode;
  singleImageWidth: number;
  getResourcePath: (fileName: string) => string;
  sourcePath: string;
}

/**
 * Coerce widget options to safe values so the constructor never throws on
 * malformed input.  Non-finite numerics fall back to DEFAULT_SETTINGS, an
 * invalid alignment falls back to "left", and a missing sourcePath becomes "".
 */
export function sanitizeOptions(options: ImageRowOptions): ImageRowOptions {
  const o = (options ?? {}) as Partial<ImageRowOptions>;
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && isFinite(v) ? v : fallback;
  const align = o.alignment;
  const sizeMode = o.singleImageSizeMode;
  return {
    defaultRowHeight: num(o.defaultRowHeight, DEFAULT_SETTINGS.defaultRowHeight),
    gap: num(o.gap, DEFAULT_SETTINGS.gapSize),
    enableDividers: o.enableDividers ?? DEFAULT_SETTINGS.enableDividers,
    enableResize: o.enableResize ?? DEFAULT_SETTINGS.enableResize,
    snapSensitivity: num(o.snapSensitivity, DEFAULT_SETTINGS.snapSensitivity),
    topBarSensitivity: num(o.topBarSensitivity, DEFAULT_SETTINGS.topBarSensitivity),
    ghostImageWidth: num(o.ghostImageWidth, DEFAULT_SETTINGS.ghostImageWidth),
    dragOpacity: num(o.dragOpacity, DEFAULT_SETTINGS.dragOpacity),
    alignment: align === "left" || align === "center" || align === "right" ? align : "left",
    singleImageSizeMode: sizeMode === "natural" || sizeMode === "fixed" ? sizeMode : "natural",
    singleImageWidth: Math.max(
      SINGLE_IMAGE_MIN_WIDTH,
      num(o.singleImageWidth, DEFAULT_SETTINGS.singleImageWidth)
    ),
    getResourcePath: typeof o.getResourcePath === "function" ? o.getResourcePath : (fileName: string) => fileName,
    sourcePath: typeof o.sourcePath === "string" ? o.sourcePath : "",
  };
}

export interface MultiImageSizeData {
  images: Array<{ styleW: string; styleH: string }>;
  items: Array<{ flexGrow: string; styleH: string }>;
  containerStyleH: string;
  /** file path + lineStart uniquely identify the row across sessions */
  filePath: string;
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
export class ImageRowWidget implements DividerHost, ResizeHost, DragReorderHost {
  container: HTMLElement | null = null;
  private imageEls: HTMLImageElement[] = [];
  private itemEls: HTMLElement[] = [];
  private dividerEls: HTMLElement[] = [];
  private resizeHandles: HTMLElement[][] = [];
  private handleDefs: HandleDef[][] = [];
  private resizeObserver: ResizeObserver | null = null;
  private classMutationObservers: MutationObserver[] = [];
  private edgeLeft: HTMLElement | null = null;
  private edgeRight: HTMLElement | null = null;

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
  /** Per-image indices whose scale ratios have been updated and need persistence. */
  _scaleDirtyImages: Set<number> = new Set();

  private dividerController: DividerController;
  private resizeController: ResizeHandleController;
  private dragReorderController: DragReorderController;

  constructor(group: ImageGroup, options: ImageRowOptions) {
    this.group = group;
    this.options = sanitizeOptions(options);
    this.rowHeight = this.options.defaultRowHeight;
    this.dividerController = new DividerController(this);
    this.resizeController = new ResizeHandleController(this);
    this.dragReorderController = new DragReorderController(this);
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

  // ── Host interface accessors (return current fields; never cache the arrays) ──
  getItemEls(): HTMLElement[] {
    return this.itemEls;
  }
  getLoadedMeta(index: number): ImageMeta | undefined {
    return this.loadedMetas.get(index);
  }
  getSnapSensitivity(): number {
    return this.options.snapSensitivity;
  }
  getImageCount(): number {
    return this.group.images.length;
  }
  emitDividerDrag(leftIndex: number, ratio: number): void {
    this.dividerDragCallback?.(leftIndex, ratio);
  }
  getContainer(): HTMLElement | null {
    return this.container;
  }
  getImageEls(): HTMLImageElement[] {
    return this.imageEls;
  }
  getGap(): number {
    return this.options.gap;
  }
  notifyLayoutChange(): void {
    this.onLayoutChange?.();
  }
  emitResizeEnd(index: number, flexGrow: number): void {
    this.resizeEndCallback?.(index, flexGrow);
  }
  setImageScale(index: number, scale: number): void {
    this.group.images[index].scale = clampScale(scale);
    this._scaleDirtyImages.add(index);
  }
  /**
   * Persist a single image's manually-resized width as `|W|1` (S=1 = manual).
   * Width lives on the data model (item CSS flex-grow is clobbered by "0 0 auto").
   */
  setSingleImageWidth(widthPx: number): void {
    const img = this.group.images[0];
    if (!img) return;
    img.flexGrow = Math.max(0.1, widthPx / 100);
    img.scale = singleImageScaleFor(true);
    img.hasExplicitWidth = true;
    this.persistCallback?.();
  }
  getDividerEls(): HTMLElement[] {
    return this.dividerEls;
  }
  getEdgeLeft(): HTMLElement | null {
    return this.edgeLeft;
  }
  getEdgeRight(): HTMLElement | null {
    return this.edgeRight;
  }
  getGroupLineStart(): number {
    return this.group.lineStart;
  }
  getGhostImageWidth(): number {
    return this.options.ghostImageWidth;
  }
  getDragOpacity(): number {
    return this.options.dragOpacity;
  }
  emitReorder(fromIndex: number, toIndex: number): void {
    this.reorderCallback?.(fromIndex, toIndex);
  }
  emitMergeExternal(insertAtIndex: number, dataTransfer: string): void {
    this.mergeExternalCallback?.(insertAtIndex, dataTransfer);
  }

  getCurrentFlexGrows(): number[] {
    // Single images store width in the data model (item flex-grow is "0 0 auto").
    if (this.group.images.length === 1) {
      return [this.group.images[0].flexGrow];
    }
    return this.itemEls.map((el) => parseFloat(el.style.flexGrow || "1"));
  }

  /** Update alignment in-place without recreating the widget. */
  updateAlignment(alignment: "left" | "center" | "right"): void {
    const css = alignmentToCSS(alignment);
    this.options.alignment = alignment;
    if (this.container) {
      this.container.style.setProperty("justify-content", css.justifyContent, "important");
    }
    for (let i = 0; i < this.imageEls.length; i++) {
      const img = this.imageEls[i];
      const item = this.itemEls[i];
      // Level 1: position img element within item
      if (item) {
        item.style.display = "flex";
        item.style.setProperty("justify-content", css.justifyContent, "important");
        item.style.alignItems = "flex-start";
      }
      // Level 2: position image content within img element
      img.style.setProperty("object-position", css.objectPosition, "important");
    }
  }

  /** Map the global alignment setting to CSS object-position value. */
  getObjectPosition(): string {
    return alignmentToCSS(this.options.alignment).objectPosition;
  }

  /**
   * Re-apply alignment CSS to container + all items + all img elements.
   * Called at the end of every layout path.
   *
   * Two-level alignment:
   *   Level 1 (item):   use flex justify-content on each item to position
   *                      the img element within the item. This is the
   *                      visible effect when the img is narrower than its
   *                      item (e.g. after corner-handle resize).
   *   Level 2 (img):    set object-position on the img so the image content
   *                      is positioned within the img element (visible when
   *                      the image content is narrower than the img element).
   */
  private applyAlignmentToAll(): void {
    const css = alignmentToCSS(this.options.alignment);
    logger.debug("applyAlignmentToAll", {
      settingsAlignment: this.options.alignment,
      cssObjectPosition: css.objectPosition,
      imageCount: this.imageEls.length,
    });
    if (this.container) {
      this.container.style.setProperty("justify-content", css.justifyContent, "important");
    }
    for (let i = 0; i < this.imageEls.length; i++) {
      const img = this.imageEls[i];
      const item = this.itemEls[i];
      // Level 1: position img element within its item via flex
      if (item) {
        item.style.display = "flex";
        item.style.setProperty("justify-content", css.justifyContent, "important");
        item.style.alignItems = "flex-start";
      }
      // Level 2: position image content within img element
      img.style.objectFit = "contain";
      img.style.setProperty("object-position", css.objectPosition, "important");
      // Neutralize any Obsidian wrapper (.image-resize-container) inserted
      // between the item and the img.  Obsidian may set inline flex/alignment
      // on the wrapper that overrides our item-level justify-content.  Using
      // an inline !important ensures we win the cascade.
      if (this.container) {
        neutralizeWrappers(img, this.container, this.itemEls);
      }
      // Obsidian also applies alignment classes (image-position-center etc.)
      // directly to the IMG element.  These can set margin:auto or similar
      // that overrides the item's flex justify-content.  Strip them.
      const imgClassBefore = img.className;
      stripObsidianClasses(img);
      const imgClassAfter = img.className;
      logger.debug("applyAlignmentToAll per-image", {
        index: i,
        settingsAlignment: this.options.alignment,
        writtenObjectPosition: img.style.objectPosition,
        expectedObjectPosition: css.objectPosition,
        imgClassBefore,
        imgClassAfter,
        classesStripped: imgClassBefore !== imgClassAfter,
        hasWrapper: img.parentElement !== item,
        wrapperTag: img.parentElement !== item ? img.parentElement?.tagName : null,
        wrapperClass: img.parentElement !== item ? img.parentElement?.className : null,
      });
    }
    // Delayed check: what does the browser ACTUALLY render?
    // Inline "right top" with !important should win, but if computed
    // stays "left top", something is overriding it after our write.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (let i = 0; i < this.imageEls.length; i++) {
          const img = this.imageEls[i];
          if (!img || !img.isConnected) continue;
          const cs = getComputedStyle(img);
          const rect = img.getBoundingClientRect();
          const itemRect = this.itemEls[i]?.getBoundingClientRect();
          const meta = this.loadedMetas.get(i);
          logger.debug("applyAlignmentToAll COMPUTED check", {
            index: i,
            settingsAlignment: this.options.alignment,
            inlineOP: img.style.objectPosition,
            inlineOF: img.style.objectFit,
            inlineW: img.style.width,
            inlineH: img.style.height,
            computedOP: cs.objectPosition,
            computedOF: cs.objectFit,
            imgRenderedW: Math.round(rect.width),
            imgRenderedH: Math.round(rect.height),
            itemRenderedW: itemRect ? Math.round(itemRect.width) : 0,
            naturalW: meta?.naturalWidth ?? 0,
            naturalH: meta?.naturalHeight ?? 0,
          });
        }
      });
    });
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
    // Apply alignment — use "important" to prevent CSS (Obsidian or our own) from overriding
    this.container.style.setProperty("justify-content", alignmentToCSS(this.options.alignment).justifyContent, "important");
    this.container.style.width = "100%";
    this.container.style.overflow = "hidden";
    this.container.style.position = "relative";

    // Edge indicators: absolutely-positioned lines that render above images
    // so they are always visible when the cursor targets the left/right edges.
    const makeEdge = (side: "left" | "right") => {
      const el = document.createElement("div");
      el.style.cssText = `display:none;position:absolute;top:0;bottom:0;width:${DIVIDER_WIDTH}px;${side}:0;background-color:#4a9eff;border-radius:2px;pointer-events:none;z-index:10`;
      this.container!.appendChild(el);
      return el;
    };
    this.edgeLeft = makeEdge("left");
    this.edgeRight = makeEdge("right");

    // Top hover bar (visual indicator only — pointer-events: none so it
    // never blocks resize handles at the top edge of images).
    const topBar = document.createElement("div");
    topBar.className = CLASSES.topBar;
    this.container.appendChild(topBar);

    // Double-click on container top edge → equalize all image heights.
    // Uses real-time cursor position check instead of a mousemove-armed flag,
    // which was fragile at the sensitivity boundary.
    const sensitivity = this.options.topBarSensitivity;
    this.container.addEventListener("dblclick", (e) => {
      const rect = this.container!.getBoundingClientRect();
      const offsetY = e.clientY - rect.top;
      logger.debug("BALANCE topBar dblclick received", {
        clientY: e.clientY,
        containerTop: rect.top,
        offsetY,
        sensitivity,
        passed: offsetY <= sensitivity,
        imageCount: this.group.images.length,
        targetTag: (e.target as HTMLElement)?.tagName,
        targetClass: (e.target as HTMLElement)?.className,
      });
      if (offsetY > sensitivity) return;
      e.preventDefault();
      e.stopPropagation();
      this.snapAllToEquilibrium();
    });

    // Show/hide top bar based on mouse proximity to container top
    this.container.addEventListener("mousemove", (e) => {
      const rect = this.container!.getBoundingClientRect();
      const offsetY = e.clientY - rect.top;
      topBar.style.backgroundColor = offsetY <= sensitivity ? "#4a9eff" : "";
    });
    this.container.addEventListener("mouseleave", () => {
      topBar.style.backgroundColor = "";
    });

    const images = this.group.images;
    this.imageEls = [];
    this.itemEls = [];
    this.dividerEls = [];
    this.resizeHandles = [];

    for (let i = 0; i < images.length; i++) {
      // Divider before image (except first)
      if (i > 0 && this.options.enableDividers) {
        const divider = this.dividerController.build(i - 1);
        this.container.appendChild(divider);
        this.dividerEls.push(divider);
      }

      const item = this.buildImageItem(images[i], i);
      this.container.appendChild(item);
    }

    // Set single-image base sizing immediately so it never appears at a wrong
    // size before the image loads and applyLayout computes the real width.
    if (images.length === 1) {
      this.imageEls[0].style.width = "auto";
      this.imageEls[0].style.height = `${this.options.defaultRowHeight}px`;
      this.itemEls[0].style.flex = "0 0 auto";
      this.itemEls[0].style.height = "";
      this.container.style.height = "";
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
    // Always apply alignment, even before images load.  Otherwise on tab
    // switch (when cached images may not fire onload) the items have no
    // flex alignment and Obsidian's image-position-center class takes over.
    this.applyAlignmentToAll();
    // Obsidian may asynchronously add alignment classes to the img after
    // our synchronous calls return.  Schedule a deferred re-application so
    // we catch and strip any late-arriving classes (e.g. on tab switch
    // where cached images fire onload synchronously).
    requestAnimationFrame(() => {
      this.applyAlignmentToAll();
    });

    return this.container;
  }

  private buildImageItem(image: ImageEmbed, index: number): HTMLElement {
    const item = document.createElement("div");
    item.className = CLASSES.imageItem;
    item.style.flex = `${image.flexGrow} 1 0%`;
    item.style.flexGrow = `${image.flexGrow}`;
    item.style.position = "relative";
    item.style.overflow = "hidden";
    item.style.minWidth = "50px";
    item.style.minHeight = "0";
    item.style.height = "100%";
    item.dataset.index = String(index);

    const img = document.createElement("img");
    img.className = CLASSES.imageInner;
    img.alt = image.fileName;
    // Prevent Obsidian from wrapping this img in .image-resize-container,
    // which causes DOM mutations on hover that produce visual flashing.
    img.contentEditable = "false";
    img.style.display = "block";
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "contain";
    img.style.setProperty("object-position", this.getObjectPosition(), "important");
    logger.debug("buildImageItem object-position", {
      index,
      file: image.fileName,
      settingsAlignment: this.options.alignment,
      writtenObjectPosition: img.style.objectPosition,
    });
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

    // Watch for Obsidian asynchronously modifying the img element.
    // Obsidian adds alignment CSS classes AND may set inline styles
    // (e.g. height/width) directly via JS.  When detected, strip the
    // classes and restore our inline height to match the item.
    const classObserver = new MutationObserver((mutations) => {
      let needsClassStrip = false;
      let needsStyleRestore = false;
      for (const m of mutations) {
        if (m.type === "attributes" && m.attributeName === "class") {
          needsClassStrip = true;
        }
        if (m.type === "attributes" && m.attributeName === "style") {
          needsStyleRestore = true;
        }
      }
      if (!needsClassStrip && !needsStyleRestore) return;

      classObserver.disconnect();
      for (const m of mutations) {
        if (m.type !== "attributes") continue;
        const t = m.target as HTMLElement;
        if (m.attributeName === "class") {
          const before = t.className;
          stripObsidianClasses(t);
          if (before !== t.className) {
            logger.debug("MutationObserver stripped Obsidian classes", {
              index,
              before,
              after: t.className,
            });
          }
        }
        if (m.attributeName === "style") {
          // Obsidian may set inline styles (e.g. height) on the img.
          // Restore the correct height from the item element.
          const imgEl = t as HTMLImageElement;
          const itemH = item.style.height;
          if (itemH && imgEl.style.height !== itemH) {
            logger.debug("MutationObserver restoring img height from item", {
              index,
              obsidianSet: imgEl.style.height,
              restored: itemH,
            });
            imgEl.style.height = itemH;
            imgEl.style.width = "auto";
            imgEl.style.objectFit = "contain";
            imgEl.style.setProperty("object-position", this.getObjectPosition(), "important");
          }
        }
      }
      classObserver.observe(img, { attributes: true, attributeFilter: ["class", "style"] });
    });
    classObserver.observe(img, { attributes: true, attributeFilter: ["class", "style"] });
    this.classMutationObservers.push(classObserver);

    // Diagnostic: log img class right after DOM insertion to detect if
    // Obsidian's MutationObserver has already wrapped/re-classed it.
    logger.debug("buildImageItem post-append", {
      index,
      file: image.fileName,
      imgClass: img.className,
      imgParentTag: img.parentElement?.tagName,
      imgParentClass: img.parentElement?.className,
      parentIsItem: img.parentElement === item,
    });

    // Resize handles
    if (this.options.enableResize) {
      const { handles, defs } = this.resizeController.buildHandles(item, index);
      this.resizeHandles.push(handles);
      this.handleDefs.push(defs);
      item.onmouseenter = () => { this.updateHandlePositions(index); };
    }

    return item;
  }

  /**
   * Compute the actual rendered image rect within a flex item,
   * accounting for object-fit: contain + object-position: left top.
   */
  getImageContentRect(index: number): { left: number; top: number; width: number; height: number } | null {
    const item = this.itemEls[index];
    const img = this.imageEls[index];
    if (!item || !img) return null;

    // Obsidian may asynchronously wrap the img in .image-resize-container
    // with alignment classes (e.g. image-position-center) that override our
    // item-level flex alignment.  Force display:contents on any wrapper so
    // the img behaves as a direct flex child of the item.
    neutralizeWrappers(img, item, [item]);
    // Obsidian may also add alignment classes directly to the IMG element
    // (not just the wrapper).  These set margin:auto etc. that override
    // the flex container's justify-content.  Strip them here (defense in
    // depth — applyAlignmentToAll also does this, but Obsidian may add them
    // asynchronously after that runs).
    stripObsidianClasses(img);

    // ── Diagnostic: trace full ancestor chain from img up to item ──
    const ancestorChain: Array<{ tag: string; class: string; computedDisplay: string; computedJustify: string; isItem: boolean }> = [];
    let el: HTMLElement | null = img;
    while (el && el !== item.parentElement) {
      const cs = getComputedStyle(el);
      ancestorChain.push({
        tag: el.tagName,
        class: el.className?.toString() || "",
        computedDisplay: cs.display,
        computedJustify: cs.justifyContent,
        isItem: el === item,
      });
      if (el === item) break;
      el = el.parentElement;
    }
    // Also log computed styles on the img and item directly
    const imgCS = getComputedStyle(img);
    const itemCS = getComputedStyle(item);
    logger.debug("getImageContentRect ANCESTOR CHAIN", {
      index,
      imgComputedDisplay: imgCS.display,
      imgComputedJustify: imgCS.justifyContent,
      imgComputedObjectPosition: imgCS.objectPosition,
      imgComputedObjectFit: imgCS.objectFit,
      imgInlineDisplay: img.style.display,
      imgInlineObjectPosition: img.style.objectPosition,
      itemComputedDisplay: itemCS.display,
      itemComputedJustify: itemCS.justifyContent,
      itemInlineDisplay: item.style.display,
      itemInlineJustify: item.style.getPropertyValue("justify-content"),
      alignmentSetting: this.options.alignment,
      chain: ancestorChain,
    });

    // Force synchronous reflow so clientWidth/clientHeight reflect the
    // most recent style changes (height updates, flex-grow changes, etc.).
    void item.offsetHeight;

    const meta = this.loadedMetas.get(index);
    if (!meta || meta.naturalWidth === 0) return null;

    // Use the img element's own dimensions (not the item's), because the
    // img may be narrower/taller than the item when flex-aligned or when
    // its inline width/height differ from the item.
    const iw = img.clientWidth;
    const ih = img.clientHeight;
    const contentRect = computeImageContentRect(iw, ih, meta);
    if (!contentRect) return null;

    // Use getBoundingClientRect to compute the img's offset from the item.
    // Prefer this over img.offsetLeft/offsetTop because offsetParent may be
    // a wrapper element inserted by Obsidian rather than the item itself.
    const itemRect = item.getBoundingClientRect();
    const imgRect = img.getBoundingClientRect();
    const offsetLeft = imgRect.left - itemRect.left;
    const offsetTop = imgRect.top - itemRect.top;

    const result = {
      left: contentRect.left + offsetLeft,
      top: contentRect.top + offsetTop,
      width: contentRect.width,
      height: contentRect.height,
    };
    logger.debug("getImageContentRect", {
      index,
      itemW: item.clientWidth,
      itemH: item.clientHeight,
      imgW: img.clientWidth,
      imgH: img.clientHeight,
      // Diagnostic: check if Obsidian inserted a wrapper between item and img
      imgParentTag: img.parentElement?.tagName ?? "none",
      imgParentClass: img.parentElement?.className ?? "none",
      offsetParentTag: (img.offsetParent as HTMLElement)?.tagName ?? "none",
      offsetParentClass: (img.offsetParent as HTMLElement)?.className ?? "none",
      imgParentIsItem: img.parentElement === item,
      offsetParentIsItem: img.offsetParent === item,
      // Old API (unreliable when wrapper present)
      domOffsetLeft: img.offsetLeft,
      domOffsetTop: img.offsetTop,
      // New API (getBoundingClientRect delta — always accurate)
      rectOffsetLeft: offsetLeft,
      rectOffsetTop: offsetTop,
      contentLeft: contentRect.left,
      contentTop: contentRect.top,
      contentW: contentRect.width,
      contentH: contentRect.height,
      resultLeft: result.left,
      resultTop: result.top,
    });
    return result;
  }

  /** Reposition resize handles to match the actual image content rect. */
  updateHandlePositions(index: number): void {
    const rect = this.getImageContentRect(index);
    const defs = this.handleDefs[index];
    if (!rect || !defs) return;

    const SZ = RESIZE_HANDLE_SIZE;
    for (const hd of defs) {
      // Position handles snug INSIDE the image content edges.
      // relX=0 → left edge, relX=1 → right edge, relX=0.5 → horizontal center.
      // Add rect.left / rect.top to account for the img element's offset
      // within the item (e.g. when flex justify-content pushes it right).
      hd.el.style.left = (rect.left + hd.relX * (rect.width - SZ)) + "px";
      hd.el.style.top = (rect.top + hd.relY * (rect.height - SZ)) + "px";
    }

    // Diagnostic: compare our computed rect with the browser's actual
    // rendered positions of the img element and the first handle.
    const img = this.imageEls[index];
    const item = this.itemEls[index];
    const imgRect = img?.getBoundingClientRect();
    const itemRect = item?.getBoundingClientRect();
    const firstHandle = defs[0]?.el;
    const hCS = firstHandle ? getComputedStyle(firstHandle) : null;
    const hRect = firstHandle?.getBoundingClientRect();
    logger.debug("updateHandlePositions", {
      index,
      // Our computed content rect (target)
      rectLeft: rect.left,
      rectTop: rect.top,
      rectW: rect.width,
      rectH: rect.height,
      // img element actual rendered rect (relative to item)
      imgOffsetLeft: img?.offsetLeft,
      imgOffsetTop: img?.offsetTop,
      imgClientW: img?.clientWidth,
      imgClientH: img?.clientHeight,
      // img & item absolute positions (for cross-check)
      imgAbsLeft: Math.round(imgRect?.left ?? 0),
      imgAbsTop: Math.round(imgRect?.top ?? 0),
      imgAbsW: Math.round(imgRect?.width ?? 0),
      imgAbsH: Math.round(imgRect?.height ?? 0),
      itemAbsLeft: Math.round(itemRect?.left ?? 0),
      itemAbsTop: Math.round(itemRect?.top ?? 0),
      itemAbsW: Math.round(itemRect?.width ?? 0),
      itemAbsH: Math.round(itemRect?.height ?? 0),
      // First handle: our inline write vs browser computed vs browser rect
      h1InlineLeft: defs[0]?.el.style.left,
      h1InlineTop: defs[0]?.el.style.top,
      h1ComputedLeft: hCS?.left,
      h1ComputedTop: hCS?.top,
      h1RectLeft: Math.round(hRect?.left ?? 0),
      h1RectTop: Math.round(hRect?.top ?? 0),
      handleCount: defs.length,
    });
  }

  /** Reposition all resize handles after a layout change. */
  private updateAllHandlePositions(): void {
    for (let i = 0; i < this.itemEls.length; i++) {
      this.updateHandlePositions(i);
    }
  }

  /**
   * Size and render a single-image row, and keep its markdown in sync as
   * `![[file|W|S]]`.  W = the rendered pixel width; S = 0 (follows the size
   * setting) or 1 (manually resized).  Manual (S=1) images use their stored W;
   * S=0 images derive W from the current setting.  When the resulting `|W|S`
   * differs from the parsed line, a deferred markdown write is scheduled.
   * Returns the rendered image height (px).
   */
  private layoutSingleImage(containerWidth: number): number {
    const img = this.group.images[0];
    const meta = this.loadedMetas.get(0);
    if (!meta || meta.naturalWidth <= 0 || meta.naturalHeight <= 0) return this.rowHeight;
    const aspect = meta.naturalWidth / meta.naturalHeight;
    const manual = isSingleImageManual(img.scale);

    let widthPx: number;
    if (manual) {
      widthPx = Math.min(Math.max(1, Math.round(img.flexGrow * 100)), Math.round(containerWidth));
    } else {
      widthPx = computeSingleImageWidth(
        this.options.singleImageSizeMode,
        this.options.singleImageWidth,
        meta.naturalWidth,
        containerWidth
      );
    }
    const imageH = Math.max(1, Math.round(widthPx / aspect));

    this.imageEls[0].style.objectFit = "contain";
    this.imageEls[0].style.setProperty("object-position", this.getObjectPosition(), "important");
    this.imageEls[0].style.height = `${imageH}px`;
    this.imageEls[0].style.width = "auto";
    this.itemEls[0].style.height = "";
    this.itemEls[0].style.flex = "0 0 auto";
    if (this.container) this.container.style.height = "";

    // Update the data model and materialize `|W|S` into markdown when it drifts.
    const sFlag: 0 | 1 = manual ? 1 : 0;
    img.flexGrow = Math.max(0.1, widthPx / 100);
    img.scale = singleImageScaleFor(manual);
    img.hasExplicitWidth = true;
    const target = formatSingleImageLine(img.raw, widthPx, sFlag);
    if (target !== img.raw) {
      img.raw = target;
      requestAnimationFrame(() => this.persistCallback?.());
    }

    this.rowHeight = imageH;
    return imageH;
  }

  /**
   * Recalculate layout based on loaded image dimensions.
   */
  private applyLayout(): void {
    if (!this.container || this.group.images.length === 0) return;
    try {

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
      // ── Restore preserved multi-image dimensions first (before any
      // other layout path), so corner-handle per-image height adjustments
      // survive widget recreation (e.g. alignment change).
      if (this.group.images.length > 1) {
        const key = mkRowKey(this.options.sourcePath, this.group.lineStart, this.group.images.map(i => i.fileName));
        const preserved = preservedMultiImageSizes.get(key);
        if (preserved && preserved.images.length === metas.length) {
          // Skip stale entries saved before applyLayout ever ran (all images
          // still at the "100%" default from build()).  Without this guard
          // a previously-poisoned preserved map would permanently lock the
          // widget into uniform sizing.
          const isStale = preserved.images.every(
            (pi) => pi.styleW === "100%" && pi.styleH === "100%"
          );
          if (!isStale) {
          // When scale data exists in markdown, the scale branch in
          // recalculateRowHeight is authoritative.  Preserved pixel sizes
          // may be stale (e.g. saved by an older plugin version), so skip
          // them and let the scale-based layout recompute correct heights.
          const hasScale = this.group.images.some(img => img.scale != null);
          if (!hasScale) {
          // Apply saved inline style values directly — no recomputation
          // Use item height as the authoritative height for both item and
          // image to prevent mismatch (item.style.height may have been
          // updated by a subsequent layout pass while img.style.height was
          // not, or vice versa).
          for (let i = 0; i < this.imageEls.length && i < preserved.items.length; i++) {
            this.imageEls[i].style.width = preserved.images[i].styleW;
            this.imageEls[i].style.height = preserved.items[i].styleH;
          }
          for (let i = 0; i < this.itemEls.length && i < preserved.items.length; i++) {
            this.itemEls[i].style.flexGrow = preserved.items[i].flexGrow;
            this.itemEls[i].style.height = preserved.items[i].styleH;
            this.group.images[i].flexGrow = parseFloat(preserved.items[i].flexGrow) || 1;
          }
          this.container.style.height = preserved.containerStyleH;
          this.rowHeight = parseFloat(preserved.containerStyleH) || this.options.defaultRowHeight;
          // Don't delete the entry — it acts as a lock preventing subsequent
          // applyLayout/recalculateRowHeight calls from overwriting with uniform heights.
          // It will be overwritten by the next destroy() when the widget is torn down.
          logger.debug("ImageRowWidget layout restored from preserved", {
            preservedSizes: preserved.images.map((pi) => `${pi.styleW}x${pi.styleH}`),
          });
          this.applyAlignmentToAll();
          this.onLayoutChange?.();
          void this.container!.offsetHeight;
          this.updateAllHandlePositions();
          requestAnimationFrame(() => this._logRenderedState("LivePreview"));
          return;
          } // !hasScale
          // hasScale: delete stale preserved entry so recalculateRowHeight
          // can recompute heights from up-to-date scale ratios.
          preservedMultiImageSizes.delete(key);
          } // !isStale
        }
      }

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
      // ── Single-image row ──
      if (this.group.images.length === 1 && this.imageEls[0] && this.itemEls[0]) {
        const imageH = this.layoutSingleImage(containerWidth);
        logger.debug("ImageRowWidget layout applied (single)", {
          containerWidth, imageH,
          alignment: this.options.alignment,
          manual: isSingleImageManual(this.group.images[0].scale),
        });
        this.onLayoutChange?.();
        void this.container.offsetHeight;
        this.updateAllHandlePositions();
        requestAnimationFrame(() => this._logRenderedState("LivePreview"));
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
      const h = `${result.rowHeight}px`;
      this.container.style.height = h;

      const rawGrows = computeFlexGrows(metas);
      const grows = validateRowFlexGrows(rawGrows, metas, containerWidth, this.options.gap);
      for (let i = 0; i < this.itemEls.length && i < grows.length; i++) {
        this.itemEls[i].style.flexGrow = String(grows[i]);
        this.group.images[i].flexGrow = grows[i];
      }
      // Auto-backfill: images without explicit |width or |scale in markdown
      // get their computed flex-grow and scale persisted.
      if (this.group.images.some((img) => !img.hasExplicitWidth || img.scale == null)) {
        for (let i = 0; i < this.group.images.length; i++) {
          this.group.images[i].hasExplicitWidth = true;
          this._scaleDirtyImages.add(i);
        }
        // Compute scale ratios after layout settles (RAF so DOM is painted).
        requestAnimationFrame(() => {
          for (let i = 0; i < this.group.images.length; i++) {
            if (this.group.images[i].scale != null) continue;
            const cr = this.getImageContentRect(i);
            const ir = this.itemEls[i]?.getBoundingClientRect();
            if (cr && cr.width > 0 && ir && ir.width > 0) {
              this.group.images[i].scale = clampScale(cr.width / ir.width);
            }
          }
          this.persistCallback?.();
        });
      }
      for (let i = 0; i < this.itemEls.length; i++) {
        this.itemEls[i].style.height = h;
      }
      for (let i = 0; i < this.imageEls.length; i++) {
        this.imageEls[i].style.height = h;
        this.imageEls[i].style.width = "auto";
      }

      logger.debug("ImageRowWidget layout applied", {
        containerWidth,
        rowHeight: result.rowHeight,
        flexGrows: grows,
        imageCount: metas.length,
      });
      this.applyAlignmentToAll();
      this.onLayoutChange?.();
      // Force reflow so handle positions use the new dimensions
      void this.container.offsetHeight;
      this.updateAllHandlePositions();
      requestAnimationFrame(() => this._logRenderedState("LivePreview"));
    } else {
      // Use a sensible default until images load
      this.container.style.height = `${this.options.defaultRowHeight}px`;
    }
    } catch (e) {
      logger.error("ImageRowWidget applyLayout error", { error: String(e), stack: (e as Error)?.stack ?? "no stack" });
      this.applyUniformFallback();
    }
  }

  /** Minimal safe layout used when applyLayout throws: uniform default height. */
  private applyUniformFallback(): void {
    if (!this.container) return;
    const h = `${this.options.defaultRowHeight}px`;
    this.container.style.height = h;
    for (const item of this.itemEls) item.style.height = h;
    for (const img of this.imageEls) {
      img.style.height = h;
      img.style.width = "auto";
    }
  }

  /**
   * Recalculate the flex container height after divider/resize drag so that
   * all images display fully without clipping.  Uses current flex-grow values
   * and natural aspect ratios — the tallest image determines the row height.
   */
  recalculateRowHeight(): void {
    if (!this.container || this.itemEls.length === 0) return;
    try {

    const containerWidth = this.container.getBoundingClientRect().width;
    // Snapshot pre-change dimensions for jitter diagnostics.
    const _beforeItemH = this.itemEls.map(el => el.style.height);
    const _beforeImgH = this.imageEls.map(el => el.style.height);
    const _beforeFlexG = this.itemEls.map(el => el.style.flexGrow);
    const _beforeContainerH = this.container.style.height;
    logger.debug("BALANCE recalculateRowHeight entry", {
      hasContainer: !!this.container,
      itemCount: this.itemEls.length,
      containerWidth,
      currentHeights: _beforeItemH,
      currentImgHeights: _beforeImgH,
      currentFlexGrows: _beforeFlexG,
      currentContainerH: _beforeContainerH,
    });
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
    const grows: number[] = [];
    const metas: ImageMeta[] = [];
    for (let i = 0; i < n; i++) {
      const raw = this.itemEls[i].style.flexGrow;
      const g = parseFloat(raw || "1");
      // Single-image rows use flex="0 0 auto" so flexGrow is 0, but
      // height calculation still needs a positive grow value.  Force 1.
      grows[i] = n === 1 ? 1 : g;
      metas[i] = this.loadedMetas.get(i)!;
    }

    const clamped = computeRowHeight(
      grows,
      metas,
      containerWidth,
      this.options.gap,
      this.options.defaultRowHeight
    );
    this.rowHeight = clamped;

    logger.debug("ImageRowWidget recalculateRowHeight", { containerWidth, rawInlineFlexGrow: this.itemEls.map(el => el.style.flexGrow), parsedGrows: grows, imageCount: n, clampedRowHeight: clamped });

    // ── Auto-fill missing flexGrow for images without |width in markdown ──
    // When some images have explicit |width and others don't (e.g. after
    // markdown corruption), the default flexGrow=1 can be severely wrong.
    // Compute a proportional flexGrow from natural aspect ratio so the image
    // renders at the same height as the rest of the row.
    if (n > 1) {
      const someExplicit = this.group.images.some(img => img.hasExplicitWidth);
      const someMissing = this.group.images.some(img => !img.hasExplicitWidth);
      if (someExplicit && someMissing && clamped > 0) {
        let explicitSum = 0;
        let missingArSum = 0;
        for (let i = 0; i < n; i++) {
          if (this.group.images[i].hasExplicitWidth) {
            explicitSum += grows[i];
          } else {
            const m = metas[i];
            missingArSum += m.naturalWidth / m.naturalHeight;
          }
        }
        const AW = containerWidth - (n - 1) * this.options.gap;
        const denom = AW - clamped * missingArSum;
        if (denom > 0 && missingArSum > 0) {
          const k = clamped * explicitSum / denom;
          for (let i = 0; i < n; i++) {
            if (!this.group.images[i].hasExplicitWidth) {
              const ar = metas[i].naturalWidth / metas[i].naturalHeight;
              grows[i] = k * ar;
              this.itemEls[i].style.flexGrow = String(grows[i]);
              this.itemEls[i].style.flex = `${grows[i]} 1 0%`;
              this.group.images[i].flexGrow = grows[i];
            }
          }
          logger.debug("ImageRowWidget autoFillMissingFlexGrow", {
            originalGrows: this.itemEls.map(el => el.style.flexGrow).slice(0, n),
            adjustedGrows: grows,
            explicitSum,
            missingArSum,
            k,
          });
        }
      }
      // Auto-backfill: persist newly-computed flexGrows and scales.
      if (someMissing || this.group.images.some(img => img.scale == null)) {
        for (let i = 0; i < n; i++) {
          this.group.images[i].hasExplicitWidth = true;
          this._scaleDirtyImages.add(i);
        }
        // Compute scale ratios after layout settles.
        requestAnimationFrame(() => {
          for (let i = 0; i < n; i++) {
            if (this.group.images[i].scale != null) continue;
            const cr = this.getImageContentRect(i);
            const ir = this.itemEls[i]?.getBoundingClientRect();
            if (cr && cr.width > 0 && ir && ir.width > 0) {
              this.group.images[i].scale = cr.width / ir.width;
            }
          }
          this.persistCallback?.();
        });
      }
    }

    const h = `${clamped}px`;
    // For single-image rows.
    if (n === 1) {
      this.layoutSingleImage(containerWidth);
    } else if (preservedMultiImageSizes.has(mkRowKey(this.options.sourcePath, this.group.lineStart, this.group.images.map(i => i.fileName)))) {
      // Preserved per-image heights are active — don't overwrite with uniform h.
      // Just update container height to match the tallest item.
      let maxH = 0;
      for (let i = 0; i < this.itemEls.length; i++) {
        const ih = parseFloat(this.itemEls[i].style.height || "0");
        if (ih > maxH) maxH = ih;
      }
      if (maxH > 0) this.container.style.height = `${maxH}px`;
    } else if (n > 1 && this.group.images.some((img) => img.scale != null)) {
      // Restore per-image heights from scale ratios persisted in markdown.
      // scale = imageContentWidth / itemWidth, a dimensionless ratio that
      // survives container-width changes across sessions.
      const scales = this.group.images.map((img) => img.scale);
      const { heights, maxH } = computeScaleBasedHeights(
        grows, metas, scales, containerWidth, this.options.gap, this.options.defaultRowHeight
      );
      for (let i = 0; i < n; i++) {
        const hPx = `${heights[i]}px`;
        this.imageEls[i].style.height = hPx;
        this.imageEls[i].style.width = "auto";
        this.itemEls[i].style.height = hPx;
      }
      this.container.style.height = `${maxH}px`;
      logger.debug("ImageRowWidget scale-based heights restored", {
        scales: this.group.images.map((img) => Math.round((img.scale ?? 0) * 100)),
        heights: this.imageEls.map((el) => el.style.height),
        containerH: `${maxH}px`,
      });
    } else {
      this.container.style.height = h;
      for (let i = 0; i < this.itemEls.length; i++) {
        this.itemEls[i].style.height = h;
      }
      for (let i = 0; i < this.imageEls.length; i++) {
        this.imageEls[i].style.height = h;
        // Let the image take its intrinsic width from the natural
        // aspect ratio so that flex justify-content alignment within
        // the item is visible (without "auto", width stays 100% and
        // the img fills the item, hiding any alignment offset).
        this.imageEls[i].style.width = "auto";
      }
    }

    // Diagnose jitter: log any dimension changes caused by this recalc.
    const _afterItemH = this.itemEls.map(el => el.style.height);
    const _afterImgH = this.imageEls.map(el => el.style.height);
    const _afterFlexG = this.itemEls.map(el => el.style.flexGrow);
    const _afterContainerH = this.container.style.height;
    const _diffs: Array<{ idx: number; itemH: string; imgH: string; flexG: string }> = [];
    for (let _i = 0; _i < _beforeItemH.length; _i++) {
      if (_beforeItemH[_i] !== _afterItemH[_i] || _beforeImgH[_i] !== _afterImgH[_i] || _beforeFlexG[_i] !== _afterFlexG[_i]) {
        _diffs.push({
          idx: _i,
          itemH: `${_beforeItemH[_i]} → ${_afterItemH[_i]}`,
          imgH: `${_beforeImgH[_i]} → ${_afterImgH[_i]}`,
          flexG: `${_beforeFlexG[_i]} → ${_afterFlexG[_i]}`,
        });
      }
    }
    if (_diffs.length > 0) {
      logger.debug("BALANCE recalculateRowHeight DIMENSION CHANGES", {
        diffs: _diffs,
        containerH: `${_beforeContainerH} → ${_afterContainerH}`,
      });
    }

    this.applyAlignmentToAll();
    this.onLayoutChange?.();
    // Force reflow so handle positions use the new dimensions
    void this.container.offsetHeight;
    this.updateAllHandlePositions();
    requestAnimationFrame(() => this._logRenderedState("LivePreview"));
    } catch (e) {
      logger.error("ImageRowWidget recalculateRowHeight error", { error: String(e), stack: (e as Error)?.stack ?? "no stack" });
      // Leave current DOM unchanged on error.
    }
  }

  private _logRenderedState(mode: string): void {
    if (!this.container) return;
    const containerRect = this.container.getBoundingClientRect();
    const containerStyle = this.container.style;
    const images = this.imageEls.map((img, i) => {
      const imgRect = img.getBoundingClientRect();
      const itemRect = this.itemEls[i]?.getBoundingClientRect() ?? imgRect;
      const computed = window.getComputedStyle(img);
      return {
        index: i,
        imgRect: { x: Math.round(imgRect.x), y: Math.round(imgRect.y), w: Math.round(imgRect.width), h: Math.round(imgRect.height) },
        itemRect: { x: Math.round(itemRect.x), y: Math.round(itemRect.y), w: Math.round(itemRect.width), h: Math.round(itemRect.height) },
        imgStyle: {
          width: computed.width,
          height: computed.height,
          objectFit: computed.objectFit,
          objectPosition: computed.objectPosition,
        },
        natural: { w: img.naturalWidth, h: img.naturalHeight },
        scale: this.group.images[i]?.scale ?? null,
      };
    });
    logger.info("RENDER_COMPARE " + mode, {
      containerRect: { x: Math.round(containerRect.x), y: Math.round(containerRect.y), w: Math.round(containerRect.width), h: Math.round(containerRect.height) },
      containerStyle: { height: containerStyle.height, justifyContent: containerStyle.justifyContent },
      alignment: this.options.alignment,
      images,
    });
  }

  /**
   * Double-click on divider: snap the two adjacent images to equal heights.
   */
  snapDividerToEquilibrium(leftIndex: number): void {
    logger.debug("BALANCE snapDividerToEquilibrium entry", {
      leftIndex,
      loadedMetasSize: this.loadedMetas.size,
      itemElsLength: this.itemEls.length,
    });

    const lm = this.loadedMetas.get(leftIndex);
    const rm = this.loadedMetas.get(leftIndex + 1);
    if (!lm || !rm || lm.naturalWidth === 0 || rm.naturalWidth === 0) {
      logger.debug("BALANCE snapDividerToEquilibrium GUARD FAIL: metas not ready", {
        hasLm: !!lm,
        hasRm: !!rm,
        lmNaturalW: lm?.naturalWidth,
        rmNaturalW: rm?.naturalWidth,
      });
      return;
    }

    const leftItem = this.itemEls[leftIndex];
    const rightItem = this.itemEls[leftIndex + 1];
    if (!leftItem || !rightItem) {
      logger.debug("BALANCE snapDividerToEquilibrium GUARD FAIL: items missing");
      return;
    }

    const total = parseFloat(leftItem.style.flexGrow || "1") + parseFloat(rightItem.style.flexGrow || "1");
    const { left, right } = computeDividerEquilibrium(lm, rm, total);

    leftItem.style.flexGrow = String(left);
    rightItem.style.flexGrow = String(right);

    // Sync in-memory state before persisting
    this.group.images[leftIndex].flexGrow = clampFlexGrow(left);
    this.group.images[leftIndex + 1].flexGrow = clampFlexGrow(right);

    // Set scales to 1 so images fill their items, and recalculateRowHeight's
    // scale branch uses the else-clause (clamped uniform height) for these images.
    // Using 1 (not null) prevents auto-backfill from re-computing scales.
    this.group.images[leftIndex].scale = 1;
    this.group.images[leftIndex + 1].scale = 1;
    this.group.images[leftIndex].hasExplicitWidth = true;
    this.group.images[leftIndex + 1].hasExplicitWidth = true;
    this._scaleDirtyImages.add(leftIndex);
    this._scaleDirtyImages.add(leftIndex + 1);

    // Set left and right images to uniform height; other images keep
    // their current per-image heights. Don't delete preserved sizes and
    // don't call recalculateRowHeight — that would recompute ALL heights.
    const n = this.itemEls.length;
    const allGrows: number[] = [];
    const allMetas: ImageMeta[] = [];
    for (let i = 0; i < n; i++) {
      allGrows[i] = parseFloat(this.itemEls[i].style.flexGrow || "1");
      const m = this.loadedMetas.get(i);
      if (!m || m.naturalWidth === 0) return;
      allMetas[i] = m;
    }
    const containerWidth = this.container!.getBoundingClientRect().width;
    const clamped = computeRowHeight(allGrows, allMetas, containerWidth, this.options.gap, this.options.defaultRowHeight);
    const hPx = `${clamped}px`;
    this.itemEls[leftIndex].style.height = hPx;
    this.itemEls[leftIndex + 1].style.height = hPx;
    this.imageEls[leftIndex].style.height = hPx;
    this.imageEls[leftIndex + 1].style.height = hPx;
    this.imageEls[leftIndex].style.width = "auto";
    this.imageEls[leftIndex + 1].style.width = "auto";
    let maxH = clamped;
    for (let j = 0; j < n; j++) {
      if (j === leftIndex || j === leftIndex + 1) continue;
      const h = parseFloat(this.itemEls[j].style.height || "0");
      if (h > maxH) maxH = h;
    }
    this.container!.style.height = `${maxH}px`;

    // Persist to markdown — triggers widget rebuild, but preserved sizes
    // (still intact) restore per-image heights for unaffected images.
    logger.debug("BALANCE snapDividerToEquilibrium calling persistCallback", {
      hasPersist: !!this.persistCallback,
    });
    this.persistCallback?.();

    logger.info("Divider dblclick snap to equilibrium", {
      leftIndex,
      total,
      snapLeft: left,
      snapRight: right,
    });
  }

  /**
   * Double-click top bar: snap ALL images in the row to equal heights.
   * Distributes flex-grow proportionally to aspect ratios so every image
   * has the same rendered height.
   */
  private snapAllToEquilibrium(): void {
    const n = this.itemEls.length;
    logger.debug("BALANCE snapAllToEquilibrium entry", {
      imageCount: n,
      loadedMetasSize: this.loadedMetas.size,
    });
    if (n < 2) {
      logger.debug("BALANCE snapAllToEquilibrium GUARD FAIL: n < 2");
      return;
    }

    const metas: ImageMeta[] = [];
    let totalGrow = 0;
    for (let i = 0; i < n; i++) {
      const meta = this.loadedMetas.get(i);
      if (!meta || meta.naturalWidth === 0) {
        logger.debug("BALANCE snapAllToEquilibrium GUARD FAIL: meta not ready", {
          index: i,
          hasMeta: !!meta,
          naturalW: meta?.naturalWidth,
        });
        return;
      }
      metas.push(meta);
      totalGrow += parseFloat(this.itemEls[i].style.flexGrow || "1");
    }

    const rawGrows = computeGlobalEquilibrium(metas, totalGrow);
    const containerWidth = this.container!.getBoundingClientRect().width;
    const grows = validateRowFlexGrows(rawGrows, metas, containerWidth, this.options.gap);

    for (let i = 0; i < n; i++) {
      this.itemEls[i].style.flexGrow = String(grows[i]);
      this.group.images[i].flexGrow = grows[i];
      // Set scale to 1 so images fill their items, and recalculateRowHeight's
      // scale branch uses the else-clause (clamped uniform height).  Using 1
      // (not null) prevents auto-backfill from re-computing scales.
      this.group.images[i].scale = 1;
      this.group.images[i].hasExplicitWidth = true;
      this._scaleDirtyImages.add(i);
    }

    // Compute uniform row height with updated flexGrow distribution.
    const allGrows2: number[] = [];
    const allMetas2: ImageMeta[] = [];
    for (let i = 0; i < n; i++) {
      allGrows2[i] = parseFloat(this.itemEls[i].style.flexGrow || "1");
      const m = this.loadedMetas.get(i);
      if (!m || m.naturalWidth === 0) return;
      allMetas2[i] = m;
    }
    const containerWidth2 = this.container!.getBoundingClientRect().width;
    const clamped2 = computeRowHeight(allGrows2, allMetas2, containerWidth2, this.options.gap, this.options.defaultRowHeight);
    const hPx2 = `${clamped2}px`;
    for (let i = 0; i < n; i++) {
      this.itemEls[i].style.height = hPx2;
      this.imageEls[i].style.height = hPx2;
      this.imageEls[i].style.width = "auto";
    }
    this.container!.style.height = hPx2;

    // Persist to markdown — triggers widget rebuild, but preserved sizes
    // (still intact) restore the uniform heights correctly.
    logger.debug("BALANCE snapAllToEquilibrium calling persistCallback", {
      hasPersist: !!this.persistCallback,
    });
    this.persistCallback?.();

    logger.info("Top bar dblclick global snap", { totalGrow, grows });
  }

  /**
   * Update the flex-grow values from an external source (e.g., after reorder).
   */
  updateFlexGrows(grows: number[]): void {
    // Skip if unchanged to avoid unnecessary reflow + onLayoutChange feedback loop.
    if (this.flexGrows.length === grows.length &&
        this.flexGrows.every((g, i) => g === grows[i])) {
      logger.debug("BALANCE updateFlexGrows SKIPPED (unchanged)", {
        flexGrows: this.flexGrows,
        incoming: grows,
      });
      return;
    }
    logger.debug("BALANCE updateFlexGrows applying", {
      oldFlexGrows: this.flexGrows,
      newFlexGrows: grows,
      currentDOM: this.itemEls.map(el => el.style.flexGrow),
    });
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
    this.dragReorderController.enable();
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
    for (const obs of this.classMutationObservers) obs.disconnect();
    this.classMutationObservers = [];
    this.dragReorderController.destroy();
    // Single-image sizes are persisted to markdown as `|W|S`, so no in-memory
    // preservation is needed across widget recreation.
    // Preserve multi-image inline styles so the new widget (e.g. after
    // alignment change) restores the same visual sizes — including
    // per-image height adjustments made by corner handles.
    // Guard: skip if layout was never applied (all item heights still at
    // the initial "100%" default from build()), to avoid poisoning the
    // preserved map with pre-layout values when the widget is destroyed
    // before applyLayout could run (e.g. plugin starts in Reading Mode).
    // Only save preserved sizes when the row has NO scale data.
    // When scale ratios exist in markdown, per-image heights are derived
    // from them on next load — preserved pixel values would be stale.
    const hasScale = this.group.images.some(img => img.scale != null);
    if (this.group.images.length > 1 && this.imageEls.length > 0
        && this.itemEls.some((el) => el.style.height && el.style.height !== "100%")
        && !hasScale) {
      const data: MultiImageSizeData = {
        images: this.imageEls.map((img, i) => ({
          styleW: img.style.width,
          // Use item height as authoritative — see applyLayout preserved-path comment.
          styleH: this.itemEls[i]?.style.height ?? img.style.height,
        })),
        items: this.itemEls.map((item) => ({
          flexGrow: item.style.flexGrow,
          styleH: item.style.height,
        })),
        containerStyleH: this.container?.style.height ?? "",
        filePath: this.options.sourcePath,
      };
      preservedMultiImageSizes.set(mkRowKey(this.options.sourcePath, this.group.lineStart, this.group.images.map(i => i.fileName)), data);
    }
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
