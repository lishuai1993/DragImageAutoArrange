import { CLASSES, DIVIDER_WIDTH, RESIZE_HANDLE_SIZE } from "./constants";
import { ImageGroup, ImageEmbed, ImageMeta } from "./imageDetector";
import { computeFlexGrows, computeUniformHeight, computeRowHeight, computeImageContentRect, computeDividerEquilibrium, computeGlobalEquilibrium, computeDividerXPositions, findClosestDividerIndex } from "./layoutEngine";
import { resolveImageSrc, alignmentToCSS } from "./utils";
import { logger } from "./logger";

/**
 * Preserved single-image rendered sizes keyed by group lineStart.
 * When a widget is destroyed (e.g. due to alignment change) the current
 * image size is stored here.  The new widget picks it up in applyLayout()
 * so the image keeps the same rendered dimensions.
 */
const preservedImageSizes = new Map<number, { width: number; height: number }>();

function mkRowKey(sourcePath: string, lineStart: number): string {
  return `${sourcePath}:${lineStart}`;
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
    if (val && val.images && val.items) {
      preservedMultiImageSizes.set(key, val as MultiImageSizeData);
    }
  }
}

/** Preserved multi-image inline style dimensions keyed by "sourcePath:lineStart".
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
  getResourcePath: (fileName: string) => string;
  sourcePath: string;
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
  private classMutationObservers: MutationObserver[] = [];
  private edgeLeft: HTMLElement | null = null;
  private edgeRight: HTMLElement | null = null;
  private docDragOver: ((e: DragEvent) => void) | null = null;
  private docDrop: ((e: DragEvent) => void) | null = null;

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
  /** True when resize has updated scale ratios that need persistence. */
  _scaleDirty = false;

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
  private getObjectPosition(): string {
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
      if (img.parentElement && img.parentElement !== item) {
        img.parentElement.style.setProperty("display", "contents", "important");
      }
      // Obsidian also applies alignment classes (image-position-center etc.)
      // directly to the IMG element.  These can set margin:auto or similar
      // that overrides the item's flex justify-content.  Strip them.
      const imgClassBefore = img.className;
      img.classList.remove("image-position-center", "image-position-left", "image-position-right", "image-converter-aligned", "image-no-wrap");
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
      el.style.cssText = `display:none;position:absolute;top:0;bottom:0;width:3px;${side}:0;background-color:#4a9eff;pointer-events:none;z-index:10`;
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

    // Set single-image base sizing immediately so it never appears at a wrong size.
    if (images.length === 1) {
      const preserved = preservedImageSizes.get(this.group.lineStart);
      const h = preserved ? preserved.height : this.options.defaultRowHeight;
      const w = preserved ? `${preserved.width}px` : "auto";
      this.imageEls[0].style.width = w;
      this.imageEls[0].style.height = `${h}px`;
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
          t.classList.remove(
            "image-position-center", "image-position-left", "image-position-right",
            "image-converter-aligned", "image-no-wrap"
          );
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

    // Obsidian may asynchronously wrap the img in .image-resize-container
    // with alignment classes (e.g. image-position-center) that override our
    // item-level flex alignment.  Force display:contents on any wrapper so
    // the img behaves as a direct flex child of the item.
    if (img.parentElement && img.parentElement !== item) {
      img.parentElement.style.setProperty("display", "contents", "important");
    }
    // Obsidian may also add alignment classes directly to the IMG element
    // (not just the wrapper).  These set margin:auto etc. that override
    // the flex container's justify-content.  Strip them here (defense in
    // depth — applyAlignmentToAll also does this, but Obsidian may add them
    // asynchronously after that runs).
    img.classList.remove("image-position-center", "image-position-left", "image-position-right", "image-converter-aligned", "image-no-wrap");

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
  private updateHandlePositions(index: number): void {
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
      let startDisplayH = 0;
      let startItemHeights: number[] = [];
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
        // Container height may be auto for single-image rows; fall back to
        // the actual rendered height from getBoundingClientRect.
        const explicitH = parseFloat(this.container!.style.height || "");
        startHeight = isNaN(explicitH) ? containerRect.height : explicitH;

        // Sync: ensure all image inline heights match their item heights.
        // A prior resize or layout pass may have left imageEls[i].style.height
        // out of sync with itemEls[i].style.height, causing the image to be
        // clipped (item has overflow:hidden) or letterboxed (image shorter).
        for (let j = 0; j < nItems; j++) {
          const itemH = this.itemEls[j].style.height;
          if (itemH && itemH !== this.imageEls[j].style.height) {
            logger.debug("resize-mousedown syncing img height to item", {
              index: j,
              itemH,
              imgHBefore: this.imageEls[j].style.height,
            });
            this.imageEls[j].style.height = itemH;
          }
        }

        // Snapshot each image's current item height so resizing one
        // image doesn't overwrite manual height adjustments on others.
        startItemHeights = [];
        for (let j = 0; j < nItems; j++) {
          const h = parseFloat(this.itemEls[j].style.height || "0");
          startItemHeights[j] = h > 0 ? h : startHeight;
        }
        logger.debug("resize-mousedown snapshot", {
          index,
          startItemHeights: [...startItemHeights],
          itemStyleH: this.itemEls.map(el => el.style.height),
          imgStyleH: this.imageEls.map(el => el.style.height),
          imgStyleW: this.imageEls.map(el => el.style.width),
          itemRects: this.itemEls.map(el => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; }),
          imgRects: this.imageEls.map(el => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; }),
        });

        // For single-image rows, cap height at the point where the image
        // fills the full container width — beyond that the image won't grow.
        // In zoom mode (beyond fill-width), we switch to object-fit: cover
        // so the image and container "lock" and grow together.
        const meta = this.loadedMetas.get(index);
        const fillWidthH = meta && meta.naturalWidth > 0
          ? Math.round(AW * meta.naturalHeight / meta.naturalWidth)
          : startHeight;

        // Scale: image-content width to item-width ratio.
        // When object-fit:contain makes the image narrower than the item,
        // a cursor dx maps to a larger item-width change so the handle
        // visually tracks the cursor 1:1.
        const displayRect = this.getImageContentRect(index);
        const displayW = displayRect ? displayRect.width : startWidth;
        startDisplayH = displayRect ? displayRect.height : startHeight;
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
            const wx = 2 * Math.abs(hd.relX - 0.5);
            const wy = 2 * Math.abs(hd.relY - 0.5);
            const SENS = 1;
            const delta = wx + wy > 0
              ? (dx * xSign * wx + dy * ySign * wy) / (wx + wy) * SENS
              : 0;

            const newHeight = Math.max(50, Math.min(2000, Math.round(startHeight + delta)));

            if (newHeight <= fillWidthH) {
              // Normal mode: image height directly controls rendered size.
              // width:auto preserves aspect ratio; flex:0 0 auto lets item
              // shrink to image size so justify-content alignment is visible.
              this.imageEls[0].style.objectFit = "contain";
              this.imageEls[0].style.setProperty("object-position", this.getObjectPosition(), "important");
              this.imageEls[0].style.width = "auto";
              this.imageEls[0].style.height = `${newHeight}px`;
              this.itemEls[0].style.height = "";
              this.itemEls[0].style.flex = "0 0 auto";
              this.container!.style.height = "";
            } else {
              // Zoom mode: image and container "locked" together beyond fill-width.
              // Switch to object-fit:cover so the image fills the element height,
              // allowing growth past the width-constrained boundary.
              this.imageEls[0].style.objectFit = "cover";
              this.imageEls[0].style.setProperty("object-position", "center", "important");
              this.imageEls[0].style.height = `${newHeight}px`;
              this.itemEls[0].style.height = `${newHeight}px`;
              this.container!.style.height = `${newHeight}px`;
            }

            // Force synchronous reflow so the container's height is
            // recalculated before CodeMirror's dispatch reads it.
            void this.container!.offsetHeight;
            this.updateHandlePositions(0);
            logger.debug("resize-mousemove (single)", {
              newHeight, fillWidthH, zoom: newHeight > fillWidthH,
              containerH: this.container!.getBoundingClientRect().height,
            });
            this.onLayoutChange?.();
            return;
          }

          // ── Multi-image row: direct image-height scaling (dividers stay fixed) ──
          const dy = ev.clientY - e.clientY;
          const ySign = hd.relY < 0.5 ? -1 : 1;
          const wy = 2 * Math.abs(hd.relY - 0.5);
          const wx = 2 * Math.abs(hd.relX - 0.5);
          const sY = 1;
          const yDelta = wx + wy > 0
            ? (dy * ySign * wy) / (wx + wy) * sY
            : 0;
          // Use image content height as delta baseline — not container height.
          // This eliminates the dead zone that occurs when container is taller
          // than the image (e.g. from a prior resize).
          const targetImageH = Math.max(50, Math.min(2000, Math.round(startDisplayH + yDelta)));
          const imageH = `${targetImageH}px`;
          this.imageEls[index].style.height = imageH;
          this.itemEls[index].style.height = imageH;
          // Preserve each non-dragged image's original height (may differ
          // from container height due to prior manual resizes).
          let otherMax = 0;
          for (let j = 0; j < this.itemEls.length; j++) {
            if (j === index) continue;
            const h = `${startItemHeights[j]}px`;
            this.itemEls[j].style.height = h;
            this.imageEls[j].style.height = h;
            otherMax = Math.max(otherMax, startItemHeights[j]);
          }
          const containerH = Math.max(targetImageH, otherMax);
          this.container!.style.height = `${containerH}px`;
          this.updateHandlePositions(index);
          // Diagnostic: detect image/item height mismatch that would cause clipping.
          // item.style.overflow = "hidden" clips images whose rendered size exceeds the item.
          const mismatches: { j: number; itemH: number; imgH: number; imgW: number; itemW: number }[] = [];
          for (let j = 0; j < this.itemEls.length; j++) {
            const ir = this.itemEls[j].getBoundingClientRect();
            const imr = this.imageEls[j].getBoundingClientRect();
            if (Math.abs(ir.height - imr.height) > 1 || Math.abs(ir.width - imr.width) > 1) {
              mismatches.push({ j, itemH: Math.round(ir.height), imgH: Math.round(imr.height), imgW: Math.round(imr.width), itemW: Math.round(ir.width) });
            }
          }
          if (mismatches.length > 0) {
            logger.warn("resize-mousemove image/item mismatch (clipping risk)", {
              activeIndex: index,
              targetImageH,
              containerH,
              startItemHeights: [...startItemHeights],
              mismatches,
            });
          }
          this.onLayoutChange?.();
        };

        currentOnUp = () => {
          dragging = false;
          item.classList.remove(CLASSES.resizing);
          item.classList.remove(CLASSES.itemSnap);

          // ── Persist scale ratio ──
          // Compute image-content-width / item-width ratio.  This captures the
          // resize state as a dimensionless number that survives container-width
          // changes.  Persisted to markdown as ![[file|flexGrow|scale]].
          if (nItems > 1) {
            const itemRect = this.itemEls[index].getBoundingClientRect();
            const contentRect = this.getImageContentRect(index);
            if (itemRect.width > 0 && contentRect && contentRect.width > 0) {
              const scale = contentRect.width / itemRect.width;
              this.group.images[index].scale = scale;
              // Mark dirty so destroy() knows to persist
              this._scaleDirty = true;
              logger.debug("resize-mouseup scale saved", {
                index,
                scale: Math.round(scale * 100),
                contentW: Math.round(contentRect.width),
                itemW: Math.round(itemRect.width),
              });
            }
          }

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
      // ── Restore preserved multi-image dimensions first (before any
      // other layout path), so corner-handle per-image height adjustments
      // survive widget recreation (e.g. alignment change).
      if (this.group.images.length > 1) {
        const key = mkRowKey(this.options.sourcePath, this.group.lineStart);
        const preserved = preservedMultiImageSizes.get(key);
        if (preserved && preserved.images.length === metas.length) {
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
          return;
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
        const meta = metas[0];
        const aspect = meta.naturalWidth / meta.naturalHeight;
        const fillWidthH = Math.max(50, Math.min(2000, Math.round(containerWidth / aspect)));
        // Restore the previous rendered size if this widget was recreated
        // (e.g. after an alignment change). Otherwise compute from defaults.
        const preserved = preservedImageSizes.get(this.group.lineStart);
        let imageH: number;
        let imageWStyle: string;
        if (preserved) {
          imageH = preserved.height;
          imageWStyle = `${preserved.width}px`;
          preservedImageSizes.delete(this.group.lineStart);
        } else {
          imageH = Math.min(this.options.defaultRowHeight, fillWidthH);
          imageWStyle = "auto";
        }
        this.imageEls[0].style.objectFit = "contain";
        this.imageEls[0].style.setProperty("object-position", this.getObjectPosition(), "important");
        this.imageEls[0].style.height = `${imageH}px`;
        this.imageEls[0].style.width = imageWStyle;
        this.itemEls[0].style.height = "";
        this.itemEls[0].style.flex = "0 0 auto";
        this.container.style.height = "";
        this.group.images[0].flexGrow = 1;
        this.rowHeight = imageH;

        logger.debug("ImageRowWidget layout applied (single)", {
          containerWidth, aspect, fillWidthH, imageH, imageWStyle,
          alignment: this.options.alignment,
          restored: !!preserved,
        });
        this.onLayoutChange?.();
        void this.container.offsetHeight;
        this.updateAllHandlePositions();
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
    }

    const h = `${clamped}px`;
    // For single-image rows.
    if (n === 1) {
      this.imageEls[0].style.objectFit = "contain";
      this.imageEls[0].style.setProperty("object-position", this.getObjectPosition(), "important");
      // Restore previous rendered size if available, otherwise compute from defaults.
      const preserved = preservedImageSizes.get(this.group.lineStart);
      if (preserved) {
        this.imageEls[0].style.height = `${preserved.height}px`;
        this.imageEls[0].style.width = `${preserved.width}px`;
      } else {
        const constrainH = Math.min(this.options.defaultRowHeight, Math.max(50, clamped));
        this.imageEls[0].style.height = `${constrainH}px`;
        this.imageEls[0].style.width = "auto";
      }
      this.itemEls[0].style.height = "";
      this.itemEls[0].style.flex = "0 0 auto";
      this.container.style.height = "";
    } else if (preservedMultiImageSizes.has(mkRowKey(this.options.sourcePath, this.group.lineStart))) {
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
      let totalG = 0;
      for (let i = 0; i < n; i++) totalG += grows[i];
      const AW = containerWidth - (n - 1) * this.options.gap;
      let maxH = 0;
      for (let i = 0; i < n; i++) {
        const scale = this.group.images[i].scale;
        let imageH: number;
        if (scale != null && scale > 0 && scale < 1) {
          const itemW = (grows[i] / totalG) * AW;
          const meta = this.loadedMetas.get(i)!;
          const ar = meta.naturalWidth / meta.naturalHeight;
          imageH = Math.round(scale * itemW / ar);
        } else {
          imageH = clamped;
        }
        const hPx = `${imageH}px`;
        this.imageEls[i].style.height = hPx;
        this.imageEls[i].style.width = "auto";
        this.itemEls[i].style.height = hPx;
        maxH = Math.max(maxH, imageH);
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

    this.applyAlignmentToAll();
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

    const leftItem = this.itemEls[leftIndex];
    const rightItem = this.itemEls[leftIndex + 1];
    if (!leftItem || !rightItem) return;

    const total = parseFloat(leftItem.style.flexGrow || "1") + parseFloat(rightItem.style.flexGrow || "1");
    const { left, right } = computeDividerEquilibrium(lm, rm, total);

    leftItem.style.flexGrow = String(left);
    rightItem.style.flexGrow = String(right);

    this.recalculateRowHeight();

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
    if (n < 2) return;

    const metas: ImageMeta[] = [];
    let totalGrow = 0;
    for (let i = 0; i < n; i++) {
      const meta = this.loadedMetas.get(i);
      if (!meta || meta.naturalWidth === 0) return;
      metas.push(meta);
      totalGrow += parseFloat(this.itemEls[i].style.flexGrow || "1");
    }

    const grows = computeGlobalEquilibrium(metas, totalGrow);

    for (let i = 0; i < n; i++) {
      this.itemEls[i].style.flexGrow = String(grows[i]);
    }

    this.recalculateRowHeight();

    logger.info("Top bar dblclick global snap", { totalGrow, grows });
  }

  /**
   * Update the flex-grow values from an external source (e.g., after reorder).
   */
  updateFlexGrows(grows: number[]): void {
    // Skip if unchanged to avoid unnecessary reflow + onLayoutChange feedback loop.
    if (this.flexGrows.length === grows.length &&
        this.flexGrows.every((g, i) => g === grows[i])) {
      return;
    }
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

    // Container-level dragover/drop: catches drops in gaps between items,
    // and provides a unified insert-position hint line.
    if (this.container) {
      this.container.addEventListener("dragover", (e) => {
        e.stopPropagation();
        e.preventDefault();
        e.dataTransfer!.dropEffect = "move";
        this.showDividerHint(e.clientX);
      });

      this.container.addEventListener("dragleave", (e) => {
        // Only hide when truly leaving the container (not moving into a child)
        const target = e.relatedTarget as Node | null;
        if (!target || !this.container!.contains(target)) {
          this.hideDividerHint();
        }
      });

      this.container.addEventListener("drop", (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.hideDividerHint();
        const data = e.dataTransfer!.getData("text/plain");
        logger.debug("ImageRowWidget container ondrop", { data: data?.substring(0, 60) });
        if (!data) return;

        const rowMatch = data.match(/^diaa-row:(\d+):(\d+)$/);
        const isStandalone = data.startsWith("diaa-standalone:") || data.startsWith("obsidian://open");
        if ((rowMatch || isStandalone) && this.mergeExternalCallback) {
          const insertAt = this.getInsertAt(e.clientX);
          logger.info("ImageRowWidget cross-row merge (container)", { insertAt });
          this.mergeExternalCallback(insertAt, data);
        }
      });
    }

    // ── Document-level capture listeners ──
    // When the cursor moves outside the container bounds (e.g. past left/
    // right page edges), container dragover/drop won't fire.  These capture-
    // phase handlers detect when the cursor is near an edge divider position
    // even when outside the container, so edge-insert hints and drops still work.
    this.docDragOver = (e: DragEvent) => {
      if (!this.container) return;
      const types = e.dataTransfer?.types;
      if (!types || !types.includes("text/plain")) return;

      const containerRect = this.container.getBoundingClientRect();
      if (e.clientY < containerRect.top - 20 || e.clientY > containerRect.bottom + 20) return;

      const widths = this.itemEls.map(el => el.getBoundingClientRect().width);
      const positions = computeDividerXPositions(containerRect.left, widths, this.options.gap);
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
      if (!this.container) return;

      const containerRect = this.container.getBoundingClientRect();
      if (e.clientY < containerRect.top - 20 || e.clientY > containerRect.bottom + 20) return;

      const data = e.dataTransfer?.getData("text/plain") || "";
      if (!data.startsWith("diaa-row:") && !data.startsWith("diaa-standalone:") && !data.startsWith("obsidian://open")) return;

      const widths = this.itemEls.map(el => el.getBoundingClientRect().width);
      const positions = computeDividerXPositions(containerRect.left, widths, this.options.gap);
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
        if (srcLineStart === this.group.lineStart) {
          const toIndex = srcIndex < insertAt ? insertAt - 1 : insertAt;
          if (srcIndex !== toIndex && this.reorderCallback) {
            this.reorderCallback(srcIndex, toIndex);
          }
          return;
        }
      }

      if (this.mergeExternalCallback) {
        this.mergeExternalCallback(insertAt, data);
      }
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
    if (!this.container || this.itemEls.length === 0) return;

    const containerRect = this.container.getBoundingClientRect();
    const widths = this.itemEls.map(el => el.getBoundingClientRect().width);

    const positions = computeDividerXPositions(
      containerRect.left,
      widths,
      this.options.gap
    );

    const avgWidth = widths.reduce((s, w) => s + w, 0) / widths.length;
    const threshold = Math.min(avgWidth * 0.4, 80);

    const closestIdx = findClosestDividerIndex(cursorX, positions, threshold);

    // Clear previous highlight
    this.hideDividerHint();

    if (closestIdx === null) return;

    const n = positions.length; // n images → n+1 positions
    const hasDividers = this.dividerEls.length > 0;

    if (closestIdx > 0 && closestIdx < n - 1 && hasDividers) {
      // Internal position → highlight the corresponding physical divider
      const divIndex = closestIdx - 1; // positions[1] maps to dividerEls[0]
      if (divIndex < this.dividerEls.length) {
        this.dividerEls[divIndex].style.backgroundColor = "#4a9eff";
        this.dividerEls[divIndex].classList.add(CLASSES.dividerActive);
      }
    } else if (closestIdx === 0 && this.edgeLeft) {
      this.edgeLeft.style.height = `${containerRect.height}px`;
      this.edgeLeft.style.display = "";
    } else if (this.edgeRight) {
      this.edgeRight.style.height = `${containerRect.height}px`;
      this.edgeRight.style.display = "";
    }
  }

  /**
   * Compute the insert-at index from cursorX using divider positions.
   * This is the single source of truth for both item-level and container-level
   * drop handlers, ensuring the drop position matches the hint line.
   */
  private getInsertAt(cursorX: number): number {
    const containerRect = this.container!.getBoundingClientRect();
    const widths = this.itemEls.map(el => el.getBoundingClientRect().width);
    const positions = computeDividerXPositions(containerRect.left, widths, this.options.gap);
    const closestIdx = findClosestDividerIndex(cursorX, positions, 60);
    if (closestIdx !== null) return closestIdx;
    // Fallback: binary choice based on container center
    return cursorX < containerRect.left + containerRect.width / 2 ? 0 : this.itemEls.length;
  }

  /** Clear all drag-over highlight states. */
  private hideDividerHint(): void {
    for (const div of this.dividerEls) {
      div.style.backgroundColor = "";
      div.classList.remove(CLASSES.dividerActive);
    }
    if (this.edgeLeft) this.edgeLeft.style.display = "none";
    if (this.edgeRight) this.edgeRight.style.display = "none";
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
    if (this.docDragOver) document.removeEventListener("dragover", this.docDragOver, true);
    if (this.docDrop) document.removeEventListener("drop", this.docDrop, true);
    this.docDragOver = null;
    this.docDrop = null;
    // Preserve single-image rendered size so the new widget (e.g. after
    // alignment change) can restore the same dimensions.
    if (this.group.images.length === 1 && this.imageEls[0]) {
      const rect = this.imageEls[0].getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        preservedImageSizes.set(this.group.lineStart, {
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
    }
    // Preserve multi-image inline styles so the new widget (e.g. after
    // alignment change) restores the same visual sizes — including
    // per-image height adjustments made by corner handles.
    if (this.group.images.length > 1 && this.imageEls.length > 0) {
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
      preservedMultiImageSizes.set(mkRowKey(this.options.sourcePath, this.group.lineStart), data);
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
