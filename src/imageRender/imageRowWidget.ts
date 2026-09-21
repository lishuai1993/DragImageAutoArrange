import { CLASSES, DIVIDER_WIDTH, RESIZE_HANDLE_SIZE, DEFAULT_SETTINGS, SINGLE_IMAGE_MIN_WIDTH, SingleImageSizeMode, computeInterItemSpace } from "../constants";
import { ImageMeta, RowGroup } from "../imageParse/imageDetector";
import { RowImage, write as writeRowImage } from "../imageParse/rowParams";
import { DIVIDER_MIN_GROW, computeFlexGrows, computeUniformHeight, computeRowHeight, computeImageContentRect, computeDividerEquilibrium, computeGlobalEquilibrium, computeScaleBasedHeights, computeScaleBasedHeightsContinuous, computeSingleImageWidth, computePairEquilibrium, computePairHeights, drawnHeightCoefficient } from "../imageLayout/layoutEngine";
import { alignmentToCSS, isNarrowViewport, onNarrowViewportChange, setStyleImportant } from "../utils";
import { logger } from "../logger";
const log = logger.channel("imageRowWidget");
import { SIZING_STEP, clampFlexGrow, clampScale, quantizeSizing, validateRowFlexGrows } from "../imageLayout/parameterValidator";
import * as scrollDiag from "../scrollSync/scrollDiag";
import { stripObsidianClasses, neutralizeWrappers } from "./rowRenderer";
import { attachDiaImageMarkers } from "./imageMarkers";
import { applyOrientationPreview, boxForScreenWidth, displayedImageSize } from "../imageTransform/transformPreview";
import { orientationWord, orientedSize, quarterTurnFitScale, type OrientationState } from "../imageTransform/orientation";
import { emitSnapshot, hasChanged, isGeometryProbeEnabled } from "../diagnostics/probe";
import { round2, snapshotPayload, type MemberFrames } from "../diagnostics/rowSnapshot";
import { DividerController, DividerHost } from "../interaction/dividerController";
import { ResizeHandleController, ResizeHost, HandleDef } from "../interaction/resizeHandleController";
import { DragReorderController, DragReorderHost } from "../interaction/dragReorderController";

function mkRowKey(sourcePath: string, _lineStart: number, fileNames: string[]): string {
  const sorted = [...fileNames].sort().join(",");
  return `${sourcePath}:${sorted}`;
}

/** Read the current left/right sidebar widths from the workspace DOM (diagnostic
 *  only).  Returns pixel width, or 0 when the split is collapsed, or -1 when the
 *  element is not present.  Used to correlate layout/flicker events with sidebar
 *  state — sidebars change the editor content width, which drives row heights. */
export function getSidebarWidths(): { left: number; right: number } {
  const measure = (sel: string): number => {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) return -1;
    if (el.classList.contains("is-collapsed")) return 0;
    return Math.round(el.getBoundingClientRect().width);
  };
  return {
    left: measure(".workspace-split.mod-left-split"),
    right: measure(".workspace-split.mod-right-split"),
  };
}

/** Reliable editor content width: the `.cm-content` ancestor is always laid out
 *  and reports a correct width even when an individual (detached / mid-reflow)
 *  widget container measures 0.  Diagnostic use — to verify it can replace the
 *  unreliable per-widget getBoundingClientRect width.  Returns 0 if unavailable. */
export function getEditorContentWidth(container: HTMLElement | null): number {
  if (!container) return 0;
  const content = container.closest<HTMLElement>(".cm-content");
  return content ? Math.round(content.getBoundingClientRect().width) : 0;
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
      preservedMultiImageSizes.set(key, val);
    }
  }
}

/** Preserved multi-image inline style dimensions keyed by "sourcePath:sortedFileNames".
 *  Saved on destroy, restored in applyLayout before any other layout path,
 *  so corner-handle per-image height adjustments survive widget recreation. */
export const preservedMultiImageSizes = new Map<string, MultiImageSizeData>();

/** Cache the last successfully rendered pixel dimensions (container height +
 *  per-item / per-image sizes).  key = mkRowKey(sourcePath, lineStart, fileNames).
 *
 *  On widget rebuild during scroll the container is momentarily detached from the
 *  layout tree (measured width 0), so every layout-changed path defers to rAF.
 *  The rebuild frame therefore starts at defaultRowHeight (200 px) while the real
 *  height (e.g. 755 px) only arrives one frame later — a visible jump.
 *
 *  This cache is applied synchronously in build() (pure CSS assignment, no
 *  computation / no dispatch) so the very first frame already has the correct
 *  dimensions.  The subsequent rAF-based recalculateRowHeight computes the same
 *  values (container width is unchanged during scroll) and the layoutChanged
 *  guard skips the onLayoutChange dispatch — zero visible flicker. */
const lastRenderedSizes = new Map<string, {
  containerH: string;
  itemHs: string[];
  /** Item widths, which a quarter-turned lone row sets to the drawing rather
   *  than leaving to the image box. */
  itemWs: string[];
  imgHs: string[];
  imgWs: string[];
  atWidth: number;
}>();

/** Document-uniform editor content width from the most recent successful layout
 *  (all image rows share the same `.cm-line` content width).  Used ONLY to scale
 *  the cached pixel heights in build() when the editor width has changed since
 *  they were cached (e.g. after opening the right sidebar) — never fed into a
 *  layout computation. */
let lastMeasuredWidth = 0;

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

/** A rectangle, as the browser and `getImageContentRect` report them. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The rect the resize handles hug: the content rect normally, and the img's own
 * measured rect after a quarter turn.
 *
 * A quarter turn swaps the drawn content's width and height (and a fit scale may
 * shrink it further), so `contentRect` — computed from the box with no transform
 * in mind — would have the handles wrap the un-rotated
 * image: a portrait handle frame around a landscape picture. The img's own rect
 * already has the transform applied, and the drawn content fills that box (it
 * is sized to the image's aspect), so measuring it is both exact and free of
 * any second guess at the transform. It is returned in item coordinates, the
 * space the handles are placed in.
 */
export function handleRect(
  contentRect: Rect,
  imgRect: Rect,
  itemRect: Rect,
  turned: boolean
): Rect {
  if (!turned) return contentRect;
  return {
    left: imgRect.left - itemRect.left,
    top: imgRect.top - itemRect.top,
    width: imgRect.width,
    height: imgRect.height,
  };
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
  /** The divider a resize drag has lit as its equilibrium bar, so the next side
   *  can take the light off it — and so teardown can put it out. */
  private resizeSnapDivider: HTMLElement | null = null;
  private resizeHandles: HTMLElement[][] = [];
  private handleDefs: HandleDef[][] = [];
  private resizeObserver: ResizeObserver | null = null;
  /** The members' inline flex geometry as it stood before the narrow-screen
   *  media query took the layout over; null while the JS layout is in charge. */
  private narrowSaved: Array<{ flex: string; flexGrow: string; width: string; height: string }> | null = null;
  private narrowUnsub: (() => void) | null = null;
  private classMutationObservers: MutationObserver[] = [];
  private edgeLeft: HTMLElement | null = null;
  private edgeRight: HTMLElement | null = null;

  private group: RowGroup;
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
  /** A single (non-manual) row's last materialised pixel width, kept because the
   *  single-follow model carries no width (it follows the setting) yet the
   *  persisted `|0|W` still needs the derived width that layoutSingleImage chose. */
  private singleWidthPx = 0;
  /** A quarter-turned single row's layout-box height and the fit scale its
   *  drawing carries, both as laid out by `layoutSingleImage`.  Kept so the
   *  transform replay, the mutation observer and the resize drag can reproduce
   *  the same drawing without re-measuring a box the turn itself obscures. */
  private singleImgBoxH = 0;
  private singleScale = 1;
  /** The container width the last layout pass solved at, so a backfill can tell
   *  whether the DOM it is about to measure is still the frame that pass made. */
  private lastLayoutWidthPx = 0;
  /** Diagnostics (temporary): the layout box height and drawn height the layout
   *  engine asked for, and the last value our own code put on the img.  Keeping
   *  the two apart is what tells a wrong write apart from a clobbered one. */
  private modelBoxH = new Map<number, number>();
  private modelDrawn = new Map<number, number>();
  private imgBoxWitness = new Map<number, { value: number; writer: string }>();
  private snapshotTimer: number | null = null;
  private snapshotReason = "";
  onLayoutChange: (() => void) | null = null;
  /** Per-image indices whose scale ratios have been updated and need persistence. */
  _scaleDirtyImages: Set<number> = new Set();

  private dividerController: DividerController;
  private resizeController: ResizeHandleController;
  private dragReorderController: DragReorderController;

  constructor(group: RowGroup, options: ImageRowOptions) {
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
  getDefaultRowHeight(): number {
    return this.options.defaultRowHeight;
  }
  /** Live width of the row, as `recalculateRowHeight` measures it. */
  getRowWidth(): number {
    return this.container ? this.container.getBoundingClientRect().width : 0;
  }
  /** A member's fill ratio (null = none) — the scale the rendered-height model
   *  reads, exposed so the divider can solve its snap on the same model. */
  getFill(index: number): number | null {
    const img = this.group.images[index];
    return img ? this.fillOf(img) : null;
  }
  getOrientation(index: number): OrientationState | null {
    return this.group.images[index]?.orientation ?? null;
  }
  getSingleWidthPx(): number {
    const d = this.group.images[0]?.display;
    return d && d.kind === "single-manual" ? d.widthPx : this.singleWidthPx;
  }
  /** This group is a single-image row (model declares the kind). */
  private isSingleRow(): boolean {
    return this.group.kind === "single";
  }
  /** True when a member's orientation is an odd quarter turn, i.e. its drawn
   *  image has swapped width and height. */
  isTurnedImage(index: number): boolean {
    return (this.group.images[index]?.orientation.turns ?? 0) % 2 === 1;
  }
  /** Every member's orientation, in item order — the frame the height model
   *  reads, since a quarter turn changes how tall a member paints. */
  private orientationsOf(): Array<OrientationState | null> {
    return this.group.images.map((img) => img.orientation);
  }
  /**
   * What a member paints out of a `boxHeight` layout box, at uniform fill: the
   * box itself upright, and on a quarter turn the box repainted on its side and
   * scaled down (`quarterTurnFitScale`) to fit back inside itself — the box's
   * own width times `aspect²` for a portrait, the box's own height for a
   * landscape.  A turn may change the size but never the ratio, and it only ever
   * shrinks, so a member can never paint taller than it did upright.
   */
  private drawnFromBox(boxHeight: number, index: number): number {
    const meta = this.loadedMetas.get(index);
    const member = this.group.images[index];
    if (!meta || !(meta.naturalWidth > 0) || !(meta.naturalHeight > 0) || !member) return boxHeight;
    const ar = meta.naturalWidth / meta.naturalHeight;
    return Math.round(boxHeight * drawnHeightCoefficient(meta, 1, member.orientation) * ar);
  }
  /**
   * The layout box a member needs in order to paint `drawnHeight` — the inverse
   * of `drawnFromBox`, and the identity for every member that is not turned,
   * whose box and drawing are one rectangle.  A resize drag drives the drawing
   * (it is the rectangle the handles hug and the one the cell takes), so it
   * needs this to put the box back on the img.
   */
  boxHeightForDrawn(drawnHeight: number, index: number): number {
    const meta = this.loadedMetas.get(index);
    const member = this.group.images[index];
    if (!meta || !(meta.naturalWidth > 0) || !(meta.naturalHeight > 0) || !member) return Math.round(drawnHeight);
    const ar = meta.naturalWidth / meta.naturalHeight;
    const perBox = drawnHeightCoefficient(meta, 1, member.orientation) * ar;
    return perBox > 0 ? Math.round(drawnHeight / perBox) : Math.round(drawnHeight);
  }
  /** Current container width in px, or 0 when it cannot be measured. */
  private containerWidthPx(): number {
    return this.container ? Math.round(this.container.getBoundingClientRect().width) : 0;
  }
  /** The manual flag of a single row, by type not sentinel. */
  private isSingleManual(): boolean {
    const d = this.group.images[0]?.display;
    return this.isSingleRow() && d?.kind === "single-manual";
  }
  /**
   * The width this single image currently takes on the page — the screen frame,
   * from the model rather than measured off a container that may be transiently
   * narrow, and so the number a turn has to move by one aspect to hold the
   * picture's size. A manual row carries it in `display.widthPx`; a follow row
   * derives it from the setting, which for natural mode needs the bitmap.
   * Null for anything but a single row, or when that derivation has no answer.
   */
  private currentScreenWidth(): number | null {
    if (!this.isSingleRow()) return null;
    const img = this.group.images[0];
    if (!img) return null;
    if (img.display.kind === "single-manual") return img.display.widthPx;
    if (this.options.singleImageSizeMode === "fixed") {
      return Math.max(SINGLE_IMAGE_MIN_WIDTH, Math.round(this.options.singleImageWidth));
    }
    const meta = this.loadedMetas.get(0);
    if (!meta || meta.naturalWidth <= 0 || meta.naturalHeight <= 0) return null;
    return Math.round(orientedSize(img.orientation, meta.naturalWidth, meta.naturalHeight).width);
  }
  /** A member's live flex share: multi rows carry it in display.share; a single
   *  manual row maps its pixel width back to the flex-grammar value (W/100) the
   *  DOM used to seed. */
  private shareOf(img: RowImage): number {
    return img.display.kind === "multi"
      ? img.display.share
      : (img.display.kind === "single-manual" ? img.display.widthPx / 100 : 1);
  }
  /** A member's fill ratio (null = default).  Single rows have no fill. */
  private fillOf(img: RowImage): number | null {
    return img.display.kind === "multi" ? img.display.fill : null;
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
  /** The space one junction between two of this row's items occupies in px:
   *  what the layout model must divide off before handing widths out.  Equals
   *  the CSS gap, plus a divider's width and one more gap when dividers render —
   *  they are real flex children sitting in the junction. */
  getInterItemSpace(): number {
    return computeInterItemSpace(this.options.gap, this.options.enableDividers);
  }
  notifyLayoutChange(): void {
    this.onLayoutChange?.();
  }
  emitResizeEnd(index: number, flexGrow: number): void {
    this.resizeEndCallback?.(index, flexGrow);
    // Persist immediately so Reading Mode picks up the current scale + flexGrow
    // without needing a widget-destroy cycle (which may race with RM's file read).
    this.persistCallback?.();
  }
  setImageScale(index: number, scale: number): void {
    const img = this.group.images[index];
    if (img && img.display.kind === "multi") img.display.fill = quantizeSizing(clampScale(scale));
    this._scaleDirtyImages.add(index);
  }
  /**
   * The equilibrium bar a resize drag shows: the divider on one side of `index`,
   * which is the junction between the two members the snap has just equalised.
   * `dividerEls[k]` is built by `build(k)` and sits before member `k + 1`, so the
   * junction on a member's left is `index - 1` and the one on its right is
   * `index` itself.
   *
   * One bar at a time: the light is taken off whichever divider held it before,
   * which covers both a drag crossing to the other side of the member and a
   * teardown.  A null side is the teardown form and has no junction of its own —
   * it only puts out what is lit.
   */
  setResizeSnapSide(index: number, side: "left" | "right" | null): boolean {
    const junction = side === "left" ? index - 1 : side === "right" ? index : -1;
    const divider = junction >= 0 ? this.dividerEls[junction] : undefined;

    const lit = this.resizeSnapDivider;
    if (lit && lit !== divider) lit.classList.remove(CLASSES.dividerSnap);
    this.resizeSnapDivider = divider ?? null;

    if (!divider) return false;
    divider.classList.toggle(CLASSES.dividerSnap, side !== null);
    return true;
  }
  /**
   * Persist a single image's manually-resized width as `|1|W` (S=1 = manual).
   * `screenWidthPx` is the width the picture takes across the page, not the
   * width of the box it is laid out in — the two differ whenever a quarter turn
   * has the box painted on its side.  Width lives on the display model (item CSS
   * flex-grow is clobbered by "0 0 auto").
   */
  setSingleImageWidth(screenWidthPx: number): void {
    const img = this.group.images[0];
    if (!img) return;
    const w = Math.max(1, Math.round(screenWidthPx));
    img.display = { kind: "single-manual", widthPx: w };
    img.hasSizing = true;
    this.singleWidthPx = w;

    // Immediate visual feedback.  CodeMirror's widget eq() compares single rows by
    // manual flag only, not widthPx, so a menu-driven resize used to stay frozen
    // until a source↔Live-Preview round trip rebuilt the widget.  Re-run the
    // single-row layout so the new width paints right away.
    const container = this.container;
    if (container) {
      const preHeight = container.style.height;
      const containerWidth = container.getBoundingClientRect().width;
      if (containerWidth > 0) this.layoutSingleImage(containerWidth);
      if (container.style.height !== preHeight) this.onLayoutChange?.();
    }
    // layoutSingleImage schedules a deferred write; persist synchronously too so
    // the |1|W still lands even if the widget is torn down before that frame.
    this.persistCallback?.();
  }

  /** Return a manual-width single row to setting-driven (`S=1 → S=0`). */
  resetSingleManualWidth(): void {
    if (!this.isSingleRow()) return;
    const img = this.group.images[0];
    img.display = { kind: "single-follow" };

    // Immediate visual feedback.  Mirror setSingleImageWidth: flipping the manual
    // flag alone used to freeze the image at its old manual width until a
    // source↔Live-Preview round trip rebuilt the widget, while the model already
    // read "follow" — leaving the 100%-resize item and the reset item greyed at
    // the same time. Re-run the single-row layout so the follow width paints now.
    const container = this.container;
    if (container) {
      const preHeight = container.style.height;
      const containerWidth = container.getBoundingClientRect().width;
      if (containerWidth > 0) this.layoutSingleImage(containerWidth);
      if (container.style.height !== preHeight) this.onLayoutChange?.();
    }
    // layoutSingleImage schedules a deferred write; persist synchronously too so
    // the |0|W still lands even if the widget is torn down before that frame.
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
    if (this.isSingleRow()) {
      return [this.getSingleWidthPx() / 100];
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
      // Level 1: position img element within item.  A quarter-turned single row
      // is centred instead: its item is already exactly the drawn picture, so
      // the un-rotated box has to sit centred inside it regardless of alignment.
      const turned = this.isSingleRow() && this.isTurnedImage(i);
      if (item) {
        item.setCssStyles({ display: "flex" });
        item.style.setProperty("justify-content", turned ? "center" : css.justifyContent, "important");
        item.setCssStyles({ alignItems: turned ? "center" : "flex-start" });
      }
      // Level 2: position image content within img element
      img.style.setProperty("object-position", css.objectPosition, "important");
    }
  }

  /** Map the global alignment setting to CSS object-position value. */
  getObjectPosition(index?: number): string {
    const align = index != null
      ? (this.group.images[index]?.alignment ?? this.options.alignment)
      : this.options.alignment;
    return alignmentToCSS(align).objectPosition;
  }

  /** The height the img's layout box should carry, for the mutation observer to
   *  restore when a third party writes its own inline style, or null when there
   *  is nothing to police.  Upright it is the item's height — item and img box
   *  are the same rectangle.  A quarter turn is the exception: the item hugs the
   *  *drawn* picture while the img keeps the un-rotated box, so the box height is
   *  the one the layout recorded.  Restoring the item's height instead would
   *  erase that box and shrink the drawing with it — the observer fires on our
   *  own writes too, so this is a self-inflicted overwrite whenever the two
   *  rectangles disagree. */
  private expectedImgBoxHeight(index: number): string | null {
    // A resize drag *is* the writer while it runs: it re-derives the box from
    // the pointer on every mousemove. Policing it against the model here would
    // restore the box the layout solved for and undo the drag — visibly so on a
    // turned member, where the two never coincide during the drag. The drag's own
    // inline value is the expectation for as long as it owns the row.
    if (this.itemEls.some((el) => el?.classList.contains(CLASSES.resizing))) {
      return this.imageEls[index]?.style.height || null;
    }
    if (this.isSingleRow() && this.isTurnedImage(index) && this.singleImgBoxH > 0) {
      return `${this.singleImgBoxH}px`;
    }
    if (this.isTurnedImage(index)) {
      const boxH = this.modelBoxH.get(index);
      if (boxH != null && boxH > 0) return `${boxH}px`;
    }
    return this.itemEls[index]?.style.height || null;
  }

  // ── Diagnostics (temporary) ────────────────────────────────────────────
  // Every write to an img's layout-box height funnels through here so the
  // snapshot can tell the value the layout chose from one a third party put
  // back; `recordGeometry` keeps the layout engine's own numbers beside it.

  private setImgBoxHeight(index: number, value: string | number, writer: string): void {
    const img = this.imageEls[index];
    if (!img) return;
    const css = typeof value === "number" ? `${value}px` : value;
    img.style.height = css;
    const px = parseFloat(css);
    this.imgBoxWitness.set(index, { value: Number.isFinite(px) ? px : 0, writer });
    if (hasChanged(`imgH:${this.group.lineStart}:${index}`, { css, writer })) {
      log.debug("img box height written", {
        index,
        writer,
        css,
        modelBoxH: this.modelBoxH.get(index) ?? null,
        itemH: this.itemEls[index]?.style.height ?? null,
      });
    }
  }

  private recordGeometry(index: number, boxH: number, drawn: number): void {
    this.modelBoxH.set(index, boxH);
    this.modelDrawn.set(index, drawn);
  }

  /** A resize drag's own rectangle, recorded as the model for one member. See
   *  ResizeHost.noteDragGeometry: the drag is a legitimate writer of the box, and
   *  a model left at the last layout pass's value would be read as "the drag
   *  wrote something foreign" by the next pass and every restore in between. */
  noteDragGeometry(index: number, boxHeight: number, drawnHeight: number): void {
    this.recordGeometry(index, boxHeight, drawnHeight);
  }

  /** Whether a member's rendered frame may be read back into the note as its
   *  fill ratio — `content width / item width`, i.e. the layout box over the
   *  column's width.  (How wide the picture *paints* is a separate figure: at a
   *  quarter turn only `k / a` of that box is painted.)  The ratio means that
   *  only while the frame is the one the layout
   *  pass produced: the picture has loaded, the container is still the width the
   *  pass solved for, and the img still carries the box the pass wrote.  A frame
   *  that fails any of these draws a picture nobody asked for, and freezing its
   *  ratio would pin that accident on the member for good. */
  private fillFrameTrustworthy(index: number): boolean {
    const img = this.imageEls[index];
    const meta = this.loadedMetas.get(index);
    if (!img || !meta) return false;
    if (!img.complete || meta.naturalWidth <= 0 || meta.naturalHeight <= 0) return false;
    const layoutW = this.lastLayoutWidthPx;
    const nowW = this.containerWidthPx();
    if (layoutW <= 0 || nowW <= 0 || Math.abs(nowW - layoutW) > 1) return false;
    const modelBoxH = this.modelBoxH.get(index);
    if (modelBoxH == null || modelBoxH <= 0) return false;
    return Math.abs(img.clientHeight - modelBoxH) <= 1;
  }

  private measureMemberGeometry(index: number): MemberFrames | null {
    const img = this.imageEls[index];
    const item = this.itemEls[index];
    const member = this.group.images[index];
    if (!img || !item || !member) return null;
    const meta = this.loadedMetas.get(index);
    const aspect = meta && meta.naturalWidth > 0 && meta.naturalHeight > 0
      ? meta.naturalWidth / meta.naturalHeight
      : 1;
    const boxH = this.modelBoxH.get(index) ?? 0;
    const witness = this.imgBoxWitness.get(index) ?? null;
    const itemRect = item.getBoundingClientRect();
    const imgRect = img.getBoundingClientRect();
    const styleW = parseFloat(img.style.width);
    const styleItemW = parseFloat(item.style.width);
    return {
      label: `${index}:${member.fileName}`,
      model: {
        fill: this.fillOf(member),
        share: this.shareOf(member),
        word: orientationWord(member.orientation),
        aspect: Number(aspect.toFixed(4)),
        boxW: Number((boxH * aspect).toFixed(2)),
        boxH,
        drawn: this.modelDrawn.get(index) ?? 0,
        expectedScale: this.isSingleRow() && this.isTurnedImage(index) ? this.singleScale : null,
      },
      wrote: {
        imgW: Number.isFinite(styleW) ? styleW : null,
        imgH: witness ? witness.value : null,
        itemW: Number.isFinite(styleItemW) ? styleItemW : null,
        itemH: parseFloat(item.style.height) || null,
        imgTransform: img.style.transform,
      },
      measured: {
        itemW: round2(itemRect.width),
        itemH: round2(itemRect.height),
        imgClientW: img.clientWidth,
        imgClientH: img.clientHeight,
        paintW: round2(imgRect.width),
        paintH: round2(imgRect.height),
        paintOffsetX: round2(imgRect.left - itemRect.left),
        paintOffsetY: round2(imgRect.top - itemRect.top),
        transform: getComputedStyle(img).transform,
        display: getComputedStyle(img).display,
      },
    };
  }

  /** Coalesce a settle burst into one snapshot, taken after layout has stopped
   *  moving — inside a timer, never during a CodeMirror update. */
  private scheduleRowSnapshot(reason: string): void {
    if (!isGeometryProbeEnabled()) return;
    this.snapshotReason = reason;
    if (this.snapshotTimer !== null) return;
    this.snapshotTimer = window.setTimeout(() => {
      this.snapshotTimer = null;
      this.emitRowSnapshot();
    }, 200);
  }

  private emitRowSnapshot(): void {
    if (!this.container) return;
    const members: Array<Record<string, unknown>> = [];
    for (let i = 0; i < this.group.images.length; i++) {
      const frames = this.measureMemberGeometry(i);
      if (frames) members.push(snapshotPayload(frames));
    }
    emitSnapshot(`row:${this.options.sourcePath}:${this.group.lineStart}`, "DIAAGEO row", {
      side: "LP",
      reason: this.snapshotReason,
      line: this.group.lineStart,
      kind: this.group.kind,
      containerW: this.containerWidthPx(),
      viewportW: this.getRowWidth(),
      members,
    });
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
    log.debug("applyAlignmentToAll", {
      settingsAlignment: this.options.alignment,
      imageCount: this.imageEls.length,
    });
    if (this.container) {
      // Container-level alignment: for single-image rows the container
      // positions the sole item (which has flex:0 0 auto), so per-image
      // alignment must be used.  Multi-image rows fill the container via
      // flex-grow; the global setting is a sensible fallback there.
      const singleAlign = this.isSingleRow() ? this.group.images[0]?.alignment : undefined;
      const containerAlign = singleAlign ?? this.options.alignment;
      const globalCSS = alignmentToCSS(containerAlign);
      this.container.style.setProperty("justify-content", globalCSS.justifyContent, "important");
    }
    for (let i = 0; i < this.imageEls.length; i++) {
      const img = this.imageEls[i];
      const item = this.itemEls[i];
      // Per-image alignment overrides row-level global
      const perImageAlign = this.group.images[i]?.alignment ?? this.options.alignment;
      const css = alignmentToCSS(perImageAlign);
      // Level 1: position img element within its item via flex
      if (item) {
        item.setCssStyles({ display: "flex" });
        // The item is sized to the drawing itself, which a quarter turn paints
        // as a different rectangle from its layout box, so that box — still
        // holding the un-rotated bitmap, and what the transform measures — is
        // centred inside it. A lone image's item *is* the picture, so alignment
        // has no say there; a row member still positions its picture in the slot.
        const turned = this.isTurnedImage(i);
        const centred = this.isSingleRow() && turned;
        item.style.setProperty("justify-content", centred ? "center" : css.justifyContent, "important");
        item.setCssStyles({ alignItems: turned ? "center" : "flex-start" });
      }
      // Level 2: position image content within img element
      img.setCssStyles({ objectFit: "contain" });
      img.style.setProperty("object-position", css.objectPosition, "important");
      // Neutralize any Obsidian wrapper (.image-wrapper) inserted
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
      // Only log a change, not every frame: this runs on each layout pass.
      if (hasChanged(`align:${this.group.lineStart}:${i}`, {
        perImageAlign,
        writtenObjectPosition: img.style.objectPosition,
        imgClassAfter,
        wrapper: img.parentElement?.className ?? null,
      })) {
        log.debug("applyAlignmentToAll per-image", {
          index: i,
          perImageAlign,
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
    }
    // Delayed check: what does the browser ACTUALLY render?
    // Inline "right top" with !important should win, but if computed
    // stays "left top", something is overriding it after our write.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        for (let i = 0; i < this.imageEls.length; i++) {
          const img = this.imageEls[i];
          if (!img || !img.isConnected) continue;
          const cs = getComputedStyle(img);
          const rect = img.getBoundingClientRect();
          const itemRect = this.itemEls[i]?.getBoundingClientRect();
          const meta = this.loadedMetas.get(i);
          log.debug("applyAlignmentToAll COMPUTED check", {
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
  build(currentEditorWidth?: number): HTMLElement {
    log.debug("ImageRowWidget build", {
      imageCount: this.group.images.length,
      files: this.group.images.map((i) => i.fileName),
      options: {
        defaultRowHeight: this.options.defaultRowHeight,
        gap: this.options.gap,
        enableDividers: this.options.enableDividers,
        enableResize: this.options.enableResize,
      },
    });

    this.container = createDiv();
    this.container.className = CLASSES.row;
    this.container.dataset.lineStart = String(this.group.lineStart);
    this.container.dataset.lineEnd = String(this.group.lineEnd);
    this.container.setCssStyles({ display: "flex" });
    this.container.setCssStyles({ alignItems: "flex-start" });
    this.container.style.gap = `${this.options.gap}px`;
    // Apply alignment — use "important" to prevent CSS (Obsidian or our own) from overriding
    this.container.style.setProperty("justify-content", alignmentToCSS(this.options.alignment).justifyContent, "important");
    this.container.setCssStyles({ width: "100%" });
    this.container.setCssStyles({ overflow: "hidden" });
    this.container.setCssStyles({ position: "relative" });

    // Edge indicators: absolutely-positioned lines that render above images
    // so they are always visible when the cursor targets the left/right edges.
    const makeEdge = (side: "left" | "right") => {
      const el = createDiv();
      el.style.cssText = `display:none;position:absolute;top:0;bottom:0;width:${DIVIDER_WIDTH}px;${side}:0;background-color:#4a9eff;border-radius:2px;pointer-events:none;z-index:10`;
      this.container!.appendChild(el);
      return el;
    };
    this.edgeLeft = makeEdge("left");
    this.edgeRight = makeEdge("right");

    // Top hover bar (visual indicator only — pointer-events: none so it
    // never blocks resize handles at the top edge of images).
    const topBar = createDiv();
    topBar.className = CLASSES.topBar;
    this.container.appendChild(topBar);

    // Double-click on container top edge → equalize all image heights.
    // Uses real-time cursor position check instead of a mousemove-armed flag,
    // which was fragile at the sensitivity boundary.
    const sensitivity = this.options.topBarSensitivity;
    this.container.addEventListener("dblclick", (e) => {
      const rect = this.container!.getBoundingClientRect();
      const offsetY = e.clientY - rect.top;
      log.debug("BALANCE topBar dblclick received", {
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
      topBar.setCssStyles({ backgroundColor: "" });
    });

    const images = this.group.images;
    this.imageEls = [];
    this.itemEls = [];
    this.dividerEls = [];
    this.resizeSnapDivider = null;
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
    if (this.isSingleRow()) {
      this.imageEls[0].setCssStyles({ width: "auto" });
      this.imageEls[0].style.height = `${this.options.defaultRowHeight}px`;
      // Cap width to the container so a cached (wide-editor) height restored on
      // scroll-in rebuild can never overflow a narrow editor and get left-right
      // clipped; object-fit:contain then degrades it to a vertical letterbox
      // until recalc lands the exact height. A quarter turn is exempt: there the
      // item is sized to the drawing, so the box is legitimately wider than it.
      this.imageEls[0].setCssStyles({ maxWidth: this.isTurnedImage(0) ? "none" : "100%" });
      this.itemEls[0].setCssStyles({ flex: "0 0 auto" });
      this.itemEls[0].setCssStyles({ height: "" });
      this.itemEls[0].setCssStyles({ maxWidth: "100%" });
      this.container.setCssStyles({ height: "" });
    }

    // Restore last rendered pixel dimensions so the very first frame after a
    // scroll-in rebuild already has the correct height (zero flicker).  Pure
    // CSS assignment — no layout computation, no dispatch, no persist.
    {
      const key = mkRowKey(this.options.sourcePath, this.group.lineStart, this.group.images.map(i => i.fileName));
      const cached = lastRenderedSizes.get(key);
      if (cached && cached.itemHs.length === this.itemEls.length) {
        // If the editor width has changed since the cache was written (e.g. the
        // right sidebar was opened), scale the cached heights by the available-
        // width ratio.  Multi-image scale-row heights are ~linear in container
        // width (the only non-linear term is the fixed inter-item gap), so the
        // scaled values land within a sub-pixel of what recalculateRowHeight
        // will compute next frame — no visible jump.  Single-image height is a
        // clamped (non-linear) function of width, so we never scale it (n>1 only).
        //
        // Current-width source: prefer the value the caller measured this frame
        // (LivePreview passes view.contentDOM width — always laid out, current
        // even while this widget is still detached in toDOM). Fall back to the
        // .cm-content ancestor (valid once attached, e.g. Reading Mode), then to
        // the module-global lastMeasuredWidth. lastMeasuredWidth alone is stale:
        // it reflects the *previous* recalc's width, so after a sidebar resize it
        // still reads the old (wide) width and the cached wide heights get
        // restored verbatim into a now-narrow editor — the scroll-up flicker.
        const n = this.itemEls.length;
        const gapTotal = (n - 1) * this.getInterItemSpace();
        const curWidth =
          (currentEditorWidth && currentEditorWidth > 0)
            ? currentEditorWidth
            : (getEditorContentWidth(this.container) || lastMeasuredWidth);
        let k = 1;
        if (n > 1 && curWidth > 0 && cached.atWidth > 0 && curWidth !== cached.atWidth) {
          const curAvail = curWidth - gapTotal;
          const cachedAvail = cached.atWidth - gapTotal;
          if (curAvail > 0 && cachedAvail > 0) k = curAvail / cachedAvail;
        }
        const scaleH = (v: string): string => {
          if (k === 1) return v;
          const px = parseFloat(v);
          return isFinite(px) ? `${Math.round(px * k)}px` : v;
        };
        for (let i = 0; i < this.itemEls.length; i++) {
          const cachedImgH = cached.imgHs[i];
          const cachedItemH = scaleH(cached.itemHs[i]);
          if (cachedImgH) this.setImgBoxHeight(i, scaleH(cachedImgH), "cached");
          if (cached.imgWs[i]) this.imageEls[i].style.width = cached.imgWs[i];
          this.itemEls[i].style.height = cachedItemH;
          // Only a real pair is worth recording: a missing cache entry leaves
          // the height unset, and a zero model would read as a violation.
          const boxH = cachedImgH ? parseFloat(scaleH(cachedImgH)) : NaN;
          const drawnH = parseFloat(cachedItemH);
          if (Number.isFinite(boxH) && boxH > 0 && Number.isFinite(drawnH) && drawnH > 0) {
            this.recordGeometry(i, boxH, drawnH);
          }
          // Widths ride along for the same reason: a quarter-turned lone item is
          // sized to the drawing, and letting it rebuild at the image box's width
          // would put the picture off-centre for the one frame before layout.
          if (cached.itemWs?.[i]) this.itemEls[i].style.width = cached.itemWs[i];
        }
        this.container.style.height = scaleH(cached.containerH);
        log.debug("ImageRowWidget restored cached rendered sizes", {
          containerH: cached.containerH,
          itemHs: cached.itemHs,
          cachedAtWidth: cached.atWidth,
          curWidth,
          currentEditorWidth,
          lastMeasuredWidth,
          scale: k,
          sidebars: getSidebarWidths(),
        });
      }
    }

    // ResizeObserver: keep handle positions in sync on ANY layout change
    // (our resize, Obsidian native resize, window resize, etc.), and re-run the
    // full row layout whenever the *editor width* changes. The container is
    // width:100%, so its measured width equals the editor content width — a
    // change there means a sidebar was dragged / toggled and every mounted row
    // must re-lay-out to match the new width (otherwise rows that CM6 didn't
    // recreate keep their old-width heights and render out of sync).
    let lastObservedWidth = currentEditorWidth && currentEditorWidth > 0
      ? Math.round(currentEditorWidth)
      : 0;
    this.resizeObserver = new ResizeObserver(() => {
      this.updateAllHandlePositions();
      const w = this.container
        ? Math.round(this.container.getBoundingClientRect().width)
        : 0;
      // Width guard: recalc only when the width actually changed. recalc mutates
      // heights (not container width), so its own resize callback re-enters here
      // with an unchanged width and is filtered out — no feedback loop. Height-
      // only changes (image load, our own layout) never trigger a recalc here.
      if (w > 0 && w !== lastObservedWidth) {
        lastObservedWidth = w;
        this.recalculateRowHeight();
      }
    });
    this.resizeObserver.observe(this.container);
    for (const item of this.itemEls) {
      this.resizeObserver.observe(item);
    }

    // Narrow-screen hand-off: crossing the breakpoint re-runs the layout, which
    // either stands down (narrow — the media query owns the row) or takes the
    // geometry back from the stash.  Both directions happen in
    // syncNarrowViewport, called from the layout's own entry.
    this.narrowUnsub = onNarrowViewportChange(() => {
      if (this.syncNarrowViewport()) return;
      this.recalculateRowHeight();
    });

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
    window.requestAnimationFrame(() => {
      this.applyAlignmentToAll();
    });

    return this.container;
  }

  private buildImageItem(image: RowImage, index: number): HTMLElement {
    const item = createDiv();
    item.className = CLASSES.imageItem;
    const seedGrow = this.shareOf(image);
    item.style.flex = `${seedGrow} 1 0%`;
    item.style.flexGrow = `${seedGrow}`;
    item.setCssStyles({ position: "relative" });
    item.setCssStyles({ overflow: "hidden" });
    item.setCssStyles({ minWidth: "50px" });
    item.setCssStyles({ minHeight: "0" });
    item.setCssStyles({ height: "100%" });
    item.dataset.index = String(index);

    const img = createEl("img");
    img.className = CLASSES.imageInner;
    img.alt = image.fileName;
    // Prevent Obsidian from wrapping this img in its resizable-image wrapper,
    // which causes DOM mutations on hover that produce visual flashing.
    img.contentEditable = "false";
    img.setCssStyles({ display: "block" });
    img.setCssStyles({ width: "100%" });
    img.setCssStyles({ height: "100%" });
    img.setCssStyles({ objectFit: "contain" });
    img.style.setProperty("object-position", this.getObjectPosition(index), "important");
    log.debug("buildImageItem object-position", {
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
      log.debug("ImageRowWidget img onload", { index, file: image.fileName, naturalWidth: nw, naturalHeight: nh, complete: img.complete });
      this.loadedMetas.set(index, { naturalWidth: nw, naturalHeight: nh });
      this.applyLayout();
      window.requestAnimationFrame(() => this.updateHandlePositions(index));
    };

    img.onload = handleLoad;

    img.onerror = () => {
      log.warn("Image load failed in widget", { fileName: image.fileName, index, src: img.src.substring(0, 80) });
      this.loadedMetas.set(index, { naturalWidth: 400, naturalHeight: 300 });
      img.setCssStyles({ backgroundColor: "#f0f0f0" });
      img.alt = `[Not found: ${image.fileName}]`;
      this.applyLayout();
    };

    img.src = this.options.getResourcePath(image.fileName);

    // Guard: if the image was already cached and the browser didn't fire
    // onload despite being set before src (Electron/Chromium edge case),
    // handle it here.
    if (img.complete && img.naturalWidth > 0) {
      log.debug("ImageRowWidget img already complete", { index, file: image.fileName, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight });
      handleLoad();
    }

    item.appendChild(img);
    this.imageEls.push(img);
    this.itemEls.push(item);

    // Store alignment callback on the img element so the document-level
    // contextmenu handler (main.ts) can read it at capture phase, which
    // runs before any other plugin's handler.
    img.__diaa_alignment = image.alignment;
    img.__diaa_onAlign = (newAlign: "left" | "center" | "right" | undefined) => {
      image.alignment = newAlign;
      img.__diaa_alignment = newAlign;
      this.applyAlignmentToAll();
      this.persistCallback?.();
    };

    // Context-menu reset-width surface. Live Preview drives real persistence
    // through the widget method; Reading Mode attaches a read-only surface via
    // the shared helper so its row renders greyed out.
    attachDiaImageMarkers(img, {
      manualSingle: () => this.isSingleManual(),
      resetTarget: () => ({
        mode: this.options.singleImageSizeMode,
        width: this.options.singleImageWidth,
      }),
      resetSingleManual: () => this.resetSingleManualWidth(),
      screenWidth: () => this.currentScreenWidth(),
      // A turn may not resize the member's container, so it rewrites the fill
      // instead — this is where the menu reads the fill it was drawn with.
      memberFill: () => this.fillOf(image),
    });

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
            log.debug("MutationObserver stripped Obsidian classes", {
              index,
              before,
              after: t.className,
            });
          }
        }
        if (m.attributeName === "style") {
          // Obsidian may set inline styles (e.g. height) on the img.
          // Restore the height the layout chose for the img's layout box.
          const imgEl = t as HTMLImageElement;
          const expectedH = this.expectedImgBoxHeight(index);
          if (expectedH && imgEl.style.height !== expectedH) {
            log.debug("MutationObserver restoring img height", {
              index,
              obsidianSet: imgEl.style.height,
              restored: expectedH,
              // Which value the restore came from: the engine's box height
              // (either turn case) or whatever the item happens to be now.
              source: this.isTurnedImage(index)
                ? (this.isSingleRow() ? "singleImgBoxH" : "modelBoxH")
                : "itemHeight",
              modelBoxH: this.modelBoxH.get(index) ?? null,
            });
            this.setImgBoxHeight(index, expectedH, "class-observer");
            imgEl.setCssStyles({ width: "auto" });
            imgEl.setCssStyles({ objectFit: "contain" });
            imgEl.style.setProperty("object-position", this.getObjectPosition(index), "important");
          }
        }
      }
      classObserver.observe(img, { attributes: true, attributeFilter: ["class", "style"] });
    });
    classObserver.observe(img, { attributes: true, attributeFilter: ["class", "style"] });
    this.classMutationObservers.push(classObserver);

    // Diagnostic: log img class right after DOM insertion to detect if
    // Obsidian's MutationObserver has already wrapped/re-classed it.
    log.debug("buildImageItem post-append", {
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

    // Obsidian may asynchronously wrap the img in its own wrapper
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
    log.debug("getImageContentRect ANCESTOR CHAIN", {
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
    if (hasChanged(`contentRect:${this.group.lineStart}:${index}`, {
      iw, ih, offsetLeft, offsetTop, width: result.width, height: result.height,
      parent: img.parentElement?.className ?? null,
    })) log.debug("getImageContentRect", {
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

  /**
   * The rect the resize handles hug. Same as `getImageContentRect` except on an
   * odd quarter turn, where the drawn image has swapped width and height — see
   * `handleRect`.
   *
   * The drag math keeps reading `getImageContentRect`: it resizes the layout
   * box, which is always the un-rotated one, so the handles' rect is only for
   * placing the handles.
   */
  getHandleRect(index: number): Rect | null {
    const contentRect = this.getImageContentRect(index);
    const item = this.itemEls[index];
    const img = this.imageEls[index];
    if (!contentRect || !item || !img) return null;
    return handleRect(
      contentRect,
      img.getBoundingClientRect(),
      item.getBoundingClientRect(),
      this.isTurnedImage(index)
    );
  }

  /**
   * Replay the orientation of a lone image and re-fit its item to what is
   * drawn, as `layoutSingleImage` does — for a resize drag, where the layout
   * pass that would normally do this only runs at the end.
   *
   * The item is sized to the drawing, so a step that changes the box has to
   * re-derive both the drawing's size and the fit scale from the new box before
   * either is written; the box height is read straight off the inline style the
   * drag just set. The handles then sit on the drawing, because `getHandleRect`
   * measures the transformed img.
   */
  syncItemToDrawing(index: number): void {
    const img = this.imageEls[index];
    const item = this.itemEls[index];
    if (!img || !item) return;
    const member = this.group.images[index];
    if (!member || !this.isSingleRow() || !this.isTurnedImage(index)) {
      // A row member carries the quarter-turn fit as the scale, as
      // `applyOrientationTransforms` does; an even turn reads no scale, so a lone
      // upright image is unaffected.
      if (member) {
        applyOrientationPreview(img, member.orientation, { scale: this.memberTurnScale(index) });
      }
      item.setCssStyles({ width: "", height: "" });
      return;
    }
    const boxH = parseFloat(img.style.height || "0");
    const meta = this.loadedMetas.get(index);
    const aspect = meta && meta.naturalHeight > 0 ? meta.naturalWidth / meta.naturalHeight : 1;
    const boxW = Math.max(1, Math.round(boxH * aspect));
    const shown = displayedImageSize(boxW, boxH, member.orientation, this.containerWidthPx());
    applyOrientationPreview(img, member.orientation, { scale: shown.scale });
    this.singleImgBoxH = boxH;
    this.singleScale = shown.scale;
    this.rowHeight = Math.max(1, Math.round(shown.height));
    item.setCssStyles({
      width: `${Math.max(1, Math.round(shown.width))}px`,
      height: `${Math.max(1, Math.round(shown.height))}px`,
    });
  }

  /** Reposition resize handles to match the actual image content rect. */
  updateHandlePositions(index: number): void {
    const rect = this.getHandleRect(index);
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
    log.debug("updateHandlePositions", {
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
   * `![[file|rot|align|S|W]]`.  W is the width the picture takes on the page —
   * the *screen* width — not the width of the box it is laid out in; the two
   * differ by one aspect whenever a quarter turn has the box painted on its
   * side (`boxForScreenWidth`).  S = 0 (follows the size setting) or 1
   * (manually resized).  Manual (S=1) rows use their stored screen width; S=0
   * rows derive it from the setting.  When the resulting line differs from the
   * parsed one, a deferred markdown write is scheduled.  Returns the rendered
   * image height (px).
   */
  private layoutSingleImage(containerWidth: number): number {
    const img = this.group.images[0];
    const meta = this.loadedMetas.get(0);
    if (!meta || meta.naturalWidth <= 0 || meta.naturalHeight <= 0) return this.rowHeight;
    const aspect = meta.naturalWidth / meta.naturalHeight;
    const manual = this.isSingleManual();
    const turned = this.isTurnedImage(0);
    const state = this.group.images[0].orientation;
    // "Natural" in the screen frame: a quarter turn swaps the bitmap's own
    // width and height, so a 2:1 landscape reads as half as wide turned as it
    // does upright.
    const naturalScreenW = orientedSize(state, meta.naturalWidth, meta.naturalHeight).width;

    // Intended screen width — deliberately NOT clamped to the (possibly
    // transient) container width. Persisting this instead of the clamped render
    // width keeps `|S|W` stable across scroll/re-layout; otherwise a
    // momentarily-narrow container on widget rebuild rewrites W every frame and
    // churns the document (the scroll flicker).
    let intendedScreenW: number;
    if (manual) {
      intendedScreenW = img.display.kind === "single-manual" ? img.display.widthPx : 1;
    } else if (this.options.singleImageSizeMode === "fixed") {
      intendedScreenW = Math.max(SINGLE_IMAGE_MIN_WIDTH, Math.round(this.options.singleImageWidth));
    } else {
      intendedScreenW = Math.round(naturalScreenW);
    }

    // Rendered screen width: clamp to the container so the picture always fits.
    // The setting-driven branch is the old computation — only the "natural
    // width" it shrinks has moved to the screen frame.
    let renderScreenW: number;
    if (manual) {
      renderScreenW = Math.min(intendedScreenW, Math.round(containerWidth));
    } else {
      renderScreenW = computeSingleImageWidth(
        this.options.singleImageSizeMode,
        this.options.singleImageWidth,
        naturalScreenW,
        containerWidth
      );
    }
    renderScreenW = Math.max(1, renderScreenW);

    // The box that draws that width, and the size it ends up drawn at. The item
    // is meant to be the picture, not the box around it: normally the two are
    // the same; a quarter turn swaps the drawing's width and height, so the item
    // takes the swapped size and, when that width would overrun the page, a
    // uniform fit scale brings the whole picture back to page width. The img
    // keeps the un-rotated box — it has to, it holds the un-rotated bitmap — and
    // is centred in the item by applyAlignmentToAll.
    const box = boxForScreenWidth(renderScreenW, aspect, state);
    const imageW = Math.max(1, Math.round(box.width));
    const imageH = Math.max(1, Math.round(box.height));
    const shown = displayedImageSize(
      imageW,
      imageH,
      state,
      Math.max(1, Math.round(containerWidth))
    );

    this.imageEls[0].setCssStyles({ objectFit: "contain" });
    this.imageEls[0].style.setProperty("object-position", this.getObjectPosition(0), "important");
    this.setImgBoxHeight(0, imageH, "single");
    this.recordGeometry(0, imageH, Math.max(1, Math.round(shown.height)));
    this.imageEls[0].setCssStyles({ width: "auto" });
    // With the item sized to the drawing, the layout box may legitimately be
    // wider than the item; letting max-width clamp it would re-letterbox the
    // bitmap and change what is drawn.
    this.imageEls[0].setCssStyles({ maxWidth: turned ? "none" : "100%" });
    this.itemEls[0].setCssStyles({ flex: "0 0 auto" });
    this.itemEls[0].setCssStyles({ maxWidth: "100%" });
    this.itemEls[0].setCssStyles({
      width: turned ? `${Math.max(1, Math.round(shown.width))}px` : "",
      height: turned ? `${Math.max(1, Math.round(shown.height))}px` : "",
    });
    // Hand the drawing's own numbers to the transform replay and the observer,
    // so neither has to measure a box the turn has already obscured.
    this.singleImgBoxH = imageH;
    this.singleScale = shown.scale;
    if (this.container) this.container.setCssStyles({ height: "" });

    // Update the data model and materialize `|S|W` into markdown when it drifts.
    // Persist the container-independent intended width so it stays stable.
    this.singleWidthPx = intendedScreenW;
    img.display = manual
      ? { kind: "single-manual", widthPx: intendedScreenW }
      : { kind: "single-follow" };
    img.hasSizing = true;
    const align = img.alignment ?? this.options.alignment;
    const target = writeRowImage({ ...img, alignment: align }, { followWidthPx: intendedScreenW });
    if (target !== img.raw) {
      img.raw = target;
      window.requestAnimationFrame(() => this.persistCallback?.());
    }

    // The row is as tall as the picture is drawn, which a quarter turn swaps.
    this.rowHeight = Math.max(1, Math.round(shown.height));
    return this.rowHeight;
  }

  /**
   * Reconcile the row with the narrow-screen media query, and report whether the
   * caller should stand down.
   *
   * Below the breakpoint the media query re-flows the row with CSS alone; the
   * inline pixel heights and per-item flex this widget writes would outrank it
   * and pin the row to its desktop geometry, so they are stashed and cleared on
   * the way in, and put back before the row is re-laid-out on the way out.  The
   * images then follow their item's width, which the re-flow has made 45 %
   * wide, instead of letterboxing a desktop pixel height inside it.
   *
   * Returns true while the viewport is narrow, i.e. while the stylesheet owns
   * the geometry and no inline value may be written.
   */
  private syncNarrowViewport(): boolean {
    if (!isNarrowViewport()) {
      if (this.narrowSaved) {
        const saved = this.narrowSaved;
        this.narrowSaved = null;
        for (let i = 0; i < this.itemEls.length && i < saved.length; i++) {
          const s = saved[i];
          this.itemEls[i].style.flex = s.flex;
          this.itemEls[i].style.flexGrow = s.flexGrow;
          this.itemEls[i].style.width = s.width;
          this.itemEls[i].style.height = s.height;
        }
      }
      return false;
    }

    if (!this.narrowSaved) {
      this.narrowSaved = this.itemEls.map((el) => ({
        flex: el.style.flex,
        flexGrow: el.style.flexGrow,
        width: el.style.width,
        height: el.style.height,
      }));
      this.container?.style.removeProperty("height");
      for (const el of this.itemEls) {
        el.style.removeProperty("flex");
        el.style.removeProperty("flex-grow");
        el.style.removeProperty("width");
        el.style.removeProperty("height");
      }
      // The item's width now comes from the media query, so the image follows it
      // and takes its height from its own aspect ratio — the desktop pixel
      // height would letterbox it inside a 45 %-wide item.  object-fit and
      // object-position are left alone: alignment still applies.
      for (const img of this.imageEls) {
        setStyleImportant(img, "width", "100%");
        setStyleImportant(img, "height", "auto");
      }
    }
    return true;
  }

  /**
   * Recalculate layout based on loaded image dimensions.
   */
  private applyLayout(): void {
    if (!this.container || this.group.images.length === 0) return;
    try {
    if (this.syncNarrowViewport()) return;

    // Snapshot container height before layout so we can skip onLayoutChange
    // when nothing actually changed (avoids the same feedback cascade that
    // updateFlexGrows already guards against).
    const preLayoutContainerH = this.container.style.height;

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
    log.debug("ImageRowWidget applyLayout", { allLoaded, hasSizing: this.group.images.some((img) => img.hasSizing), metaCount: metas.filter(m => m.naturalWidth > 0).length, totalImages: this.group.images.length });

    if (allLoaded) {
      // ── Restore preserved multi-image dimensions first (before any
      // other layout path), so corner-handle per-image height adjustments
      // survive widget recreation (e.g. alignment change).
      if (this.group.images.length > 1) {
        const key = mkRowKey(this.options.sourcePath, this.group.lineStart, this.group.images.map(i => i.fileName));
        const preserved = preservedMultiImageSizes.get(key);
        scrollDiag.note("preserved 缓存查询", {
          hit: !!preserved,
          savedImages: preserved?.images.length ?? 0,
          metas: metas.length,
          savedContainerH: preserved?.containerStyleH ?? "-",
        });
        if (preserved && preserved.images.length === metas.length) {
          // Skip stale entries saved before applyLayout ever ran (all images
          // still at the "100%" default from build()).  Without this guard
          // a previously-poisoned preserved map would permanently lock the
          // widget into uniform sizing.
          const isStale = preserved.images.every(
            (pi) => pi.styleW === "100%" && pi.styleH === "100%"
          );
          if (isStale) {
            scrollDiag.note("preserved 判为 stale（全 100%），跳过复用");
          }
          if (!isStale) {
          // When scale data exists in markdown, the scale branch in
          // recalculateRowHeight is authoritative.  Preserved pixel sizes
          // may be stale (e.g. saved by an older plugin version), so skip
          // them and let the scale-based layout recompute correct heights.
          const hasFill = this.group.images.some(img => this.fillOf(img) != null);
          scrollDiag.note("preserved 复用判定", {
            hasFill,
            branch: hasFill ? "hasFill→交由 recalculateRowHeight" : "复用像素尺寸",
          });
          if (!hasFill) {
          // Apply saved inline style values directly — no recomputation.
          // Each rectangle is restored from its own record: the item carries the
          // drawing and the img the box it is folded inside, which a quarter turn
          // makes two different rectangles.  (Upright they are one, so this is
          // the old behaviour with a name for each half.)
          for (let i = 0; i < this.imageEls.length && i < preserved.items.length; i++) {
            const boxH = parseFloat(preserved.images[i].styleH) || parseFloat(preserved.items[i].styleH);
            this.imageEls[i].style.width = preserved.images[i].styleW;
            this.setImgBoxHeight(i, boxH, "preserved");
            this.recordGeometry(i, boxH, parseFloat(preserved.items[i].styleH) || boxH);
          }
          for (let i = 0; i < this.itemEls.length && i < preserved.items.length; i++) {
            this.itemEls[i].style.flexGrow = preserved.items[i].flexGrow;
            this.itemEls[i].style.height = preserved.items[i].styleH;
            const g = parseFloat(preserved.items[i].flexGrow) || 1;
            const m = this.group.images[i];
            if (m.display.kind === "multi") m.display.share = quantizeSizing(g);
          }
          this.container.style.height = preserved.containerStyleH;
          this.rowHeight = parseFloat(preserved.containerStyleH) || this.options.defaultRowHeight;
          // Don't delete the entry — it acts as a lock preventing subsequent
          // applyLayout/recalculateRowHeight calls from overwriting with uniform heights.
          // It will be overwritten by the next destroy() when the widget is torn down.
          log.debug("ImageRowWidget layout restored from preserved", {
            preservedSizes: preserved.images.map((pi) => `${pi.styleW}x${pi.styleH}`),
          });
          this.applyAlignmentToAll();
          scrollDiag.note("preserved 复用完成（容器高度同步还原）", {
            pre: preLayoutContainerH || "(empty)",
            post: this.container.style.height,
          });
          if (this.container.style.height !== preLayoutContainerH) {
            this.onLayoutChange?.();
          }
          void this.container.offsetHeight;
          this.updateAllHandlePositions();
          this.backfillMissingParams();
          window.requestAnimationFrame(() => this._logRenderedState("LivePreview"));
          return;
          } // !hasScale
          // hasScale: delete stale preserved entry so recalculateRowHeight
          // can recompute heights from up-to-date scale ratios.
          scrollDiag.note("preserved 条目删除（hasFill：交回重算）", { key });
          preservedMultiImageSizes.delete(key);
          } // !isStale
        }
      }

      // When flex-grows were loaded from markdown |width, use the current
      // distribution to calculate max height (avoids overwriting user adjustments).
      if (this.group.images.some((img) => img.hasSizing)) {
        this.recalculateRowHeight();
        this.backfillMissingParams();
        return;
      }

      const containerWidth = this.container.getBoundingClientRect().width;
      // Element not in DOM yet — retry after layout
      if (containerWidth === 0) {
        window.requestAnimationFrame(() => this.applyLayout());
        return;
      }
      this.lastLayoutWidthPx = containerWidth;
      // ── Single-image row ──
      if (this.isSingleRow() && this.imageEls[0] && this.itemEls[0]) {
        const imageH = this.layoutSingleImage(containerWidth);
        log.debug("ImageRowWidget layout applied (single)", {
          containerWidth, imageH,
          alignment: this.options.alignment,
          manual: this.isSingleManual(),
        });
        if (this.container.style.height !== preLayoutContainerH) {
          this.onLayoutChange?.();
        }
        void this.container.offsetHeight;
        this.updateAllHandlePositions();
        this.backfillMissingParams();
        this.applyAlignmentToAll();
        window.requestAnimationFrame(() => this._logRenderedState("LivePreview"));
        return;
      }

      const result = computeUniformHeight(
        metas,
        containerWidth,
        this.getInterItemSpace(),
        50,
        this.options.defaultRowHeight * 3
      );
      this.rowHeight = result.rowHeight;
      const h = `${result.rowHeight}px`;

      const rawGrows = computeFlexGrows(metas);
      const grows = validateRowFlexGrows(rawGrows, metas, containerWidth, this.getInterItemSpace());
      for (let i = 0; i < this.itemEls.length && i < grows.length; i++) {
        this.itemEls[i].style.flexGrow = String(grows[i]);
        const gImg = this.group.images[i];
        if (gImg.display.kind === "multi") gImg.display.share = quantizeSizing(grows[i]);
      }
      // Auto-backfill: images without explicit |width, |scale, or |alignment
      // in markdown get their computed params persisted.
      if (this.group.images.some((img) => {
        const fill = img.display.kind === "multi" ? img.display.fill : null;
        return !img.hasSizing || fill == null || img.alignment == null;
      })) {
        for (let i = 0; i < this.group.images.length; i++) {
          this.group.images[i].hasSizing = true;
          this._scaleDirtyImages.add(i);
          if (this.group.images[i].alignment == null) {
            this.group.images[i].alignment = this.options.alignment;
            if (this.imageEls[i]) this.imageEls[i].__diaa_alignment = this.options.alignment;
          }
        }
        // Compute scale ratios after layout settles (RAF so DOM is painted).
        window.requestAnimationFrame(() => {
          for (let i = 0; i < this.group.images.length; i++) {
            const mi = this.group.images[i];
            if (mi.display.kind !== "multi" || mi.display.fill != null) continue;
            if (!this.fillFrameTrustworthy(i)) continue;
            const cr = this.getImageContentRect(i);
            const ir = this.itemEls[i]?.getBoundingClientRect();
            if (cr && cr.width > 0 && ir && ir.width > 0) {
              mi.display.fill = quantizeSizing(clampScale(cr.width / ir.width));
            }
          }
          this.persistCallback?.();
        });
      }
      // The item takes the drawing, not the box: upright the two are the same
      // rectangle, and a turned member's cell follows what it paints so its
      // column lines up with the others instead of holding a taller box.
      let rowCellH = 0;
      for (let i = 0; i < this.imageEls.length; i++) {
        const drawn = this.drawnFromBox(result.rowHeight, i);
        this.setImgBoxHeight(i, h, "applyLayout-uniform");
        this.recordGeometry(i, result.rowHeight, drawn);
        this.imageEls[i].setCssStyles({ width: "auto" });
        if (this.itemEls[i]) this.itemEls[i].style.height = `${drawn}px`;
        if (drawn > rowCellH) rowCellH = drawn;
      }
      this.container.style.height = `${rowCellH > 0 ? rowCellH : result.rowHeight}px`;

      log.debug("ImageRowWidget layout applied", {
        containerWidth,
        rowHeight: result.rowHeight,
        flexGrows: grows,
        imageCount: metas.length,
      });
      this.applyAlignmentToAll();
      if (this.container.style.height !== preLayoutContainerH) {
        this.onLayoutChange?.();
      }
      // Force reflow so handle positions use the new dimensions
      void this.container.offsetHeight;
      window.requestAnimationFrame(() => this._logRenderedState("LivePreview"));
    } else {
      // Use a sensible default until images load.  Prefer the last rendered
      // container height (cached from a previous successful layout) so the
      // rebuild frame keeps the correct height instead of snapping to 200px.
      const key = mkRowKey(this.options.sourcePath, this.group.lineStart, this.group.images.map(i => i.fileName));
      const cachedH = lastRenderedSizes.get(key)?.containerH;
      this.container.style.height = cachedH || `${this.options.defaultRowHeight}px`;
    }
    } catch (e) {
      log.error("ImageRowWidget applyLayout error", { error: String(e), stack: (e as Error)?.stack ?? "no stack" });
      this.applyUniformFallback();
    } finally {
      // Every layout pass ends by re-applying each member's rotate/flip
      // orientation. The rotation now lives in the row text, but the transform
      // itself is still CSS on the <img>: a rebuild recreates that node and
      // drops the transform, so it is replayed here — after the forced reflow
      // above, so client dims are current for the quarter-turn fit-scale.
      this.applyOrientationTransforms();
      // Handles last, and after the transform: they sit on the *drawn* box on a
      // quarter turn, which the browser only measures once the transform is on
      // the element.
      this.updateAllHandlePositions();
      this.scheduleRowSnapshot("applyLayout");
    }
  }

  /** Replay every member's orientation as a CSS transform on its <img>.  A
   *  quarter-turned single row hands over the explicit fit scale its item was
   *  sized with; a row member gets the fit that folds the turned rectangle back
   *  inside the rectangle it came from (`quarterTurnFitScale`, the same number
   *  `drawnHeightCoefficient` is built on), so it keeps its height and narrows
   *  or keeps its width and shortens, and the row never grows.
   *  (Only odd turns read the scale, so a non-turned image is unaffected.) */
  private applyOrientationTransforms(): void {
    for (let i = 0; i < this.imageEls.length; i++) {
      const member = this.group.images[i];
      if (!member) continue;
      if (this.isSingleRow() && this.isTurnedImage(i)) {
        applyOrientationPreview(this.imageEls[i], member.orientation, { scale: this.singleScale });
      } else {
        applyOrientationPreview(this.imageEls[i], member.orientation, {
          scale: this.memberTurnScale(i),
        });
      }
    }
  }

  /** The scale a quarter turn applies to a row member's drawing: the fit of the
   *  turned rectangle inside its own un-rotated one, and 1 before the bitmap
   *  reports a size. */
  private memberTurnScale(index: number): number {
    const meta = this.loadedMetas.get(index);
    if (!meta || !(meta.naturalWidth > 0) || !(meta.naturalHeight > 0)) return 1;
    return quarterTurnFitScale(meta.naturalWidth / meta.naturalHeight);
  }

  /**
   * Validate and backfill missing markdown params from rendered state or
   * defaults.  Alignment comes from the global setting; share/fill/W come from
   * current rendered values.  Schedules a RAF persist when changes are made.
   */
  private backfillMissingParams(): void {
    const images = this.group.images;
    const n = images.length;
    let changed = false;

    for (let i = 0; i < n; i++) {
      const img = images[i];

      if (img.alignment == null) {
        img.alignment = this.options.alignment;
        if (this.imageEls[i]) this.imageEls[i].__diaa_alignment = this.options.alignment;
        changed = true;
      }

      if (n === 1) {
        // Single-image: S flag → setting-driven follow. layoutSingleImage
        // materialises the |S|W tail and derived width; nothing left to measure.
        if (img.display.kind !== "single-manual") {
          if (img.display.kind !== "single-follow") img.display = { kind: "single-follow" };
          if (!img.hasSizing) {
            img.hasSizing = true;
            changed = true;
          }
        }
      } else if (img.display.kind === "multi") {
        // A multi member's slots are filled from the rendered layout.  A lone
        // numeric is read as the share code (the first slot), so a legacy
        // `|left|120` keeps its 1.2 instead of being reset to uniform; the fill
        // code follows from the rendered content-vs-item width ratio.  An
        // unmeasurable fill (image not loaded yet, or a broken link) stays null
        // — the row then materialises without that one slot and picks it up on
        // a later pass, rather than pinning a made-up ratio.
        if (!img.hasSizing && this.itemEls[i]) {
          const fg = parseFloat(this.itemEls[i].style.flexGrow || String(img.display.share));
          img.display.share = quantizeSizing(clampFlexGrow(fg));
          img.hasSizing = true;
          changed = true;
        }
        if (img.display.fill == null && this.itemEls[i] && this.fillFrameTrustworthy(i)) {
          const cr = this.getImageContentRect(i);
          const ir = this.itemEls[i].getBoundingClientRect();
          if (cr && ir && cr.width > 0 && ir.width > 0) {
            img.display.fill = quantizeSizing(clampScale(cr.width / ir.width));
            changed = true;
          }
        }
      }
    }

    if (changed) {
      this.applyAlignmentToAll();
      scrollDiag.note("backfill 有改动 → 排入 RAF 持久化", {
        images: images.length,
      });
      window.requestAnimationFrame(() => this.persistCallback?.());
    }
  }

  /** Minimal safe layout used when applyLayout throws: uniform default height. */
  private applyUniformFallback(): void {
    if (!this.container) return;
    const h = `${this.options.defaultRowHeight}px`;
    this.container.style.height = h;
    for (const item of this.itemEls) item.style.height = h;
    for (let i = 0; i < this.imageEls.length; i++) {
      this.setImgBoxHeight(i, h, "uniform-fallback");
      this.recordGeometry(i, this.options.defaultRowHeight, this.options.defaultRowHeight);
      this.imageEls[i].setCssStyles({ width: "auto" });
    }
  }

  /**
   * Recalculate the flex container height after divider/resize drag so that
   * all images display fully without clipping.  Uses current flex-grow values
   * and natural aspect ratios — the tallest image determines the row height.
   */
  recalculateRowHeight(): void {
    if (!this.container || this.itemEls.length === 0) return;
    if (this.syncNarrowViewport()) return;
    try {

    const containerWidth = this.container.getBoundingClientRect().width;
    // Snapshot pre-change dimensions for jitter diagnostics.
    const _beforeItemH = this.itemEls.map(el => el.style.height);
    const _beforeImgH = this.imageEls.map(el => el.style.height);
    const _beforeFlexG = this.itemEls.map(el => el.style.flexGrow);
    const _beforeContainerH = this.container.style.height;
    log.debug("BALANCE recalculateRowHeight entry", {
      hasContainer: !!this.container,
      itemCount: this.itemEls.length,
      containerWidth,
      sidebars: getSidebarWidths(),
      currentHeights: _beforeItemH,
      currentImgHeights: _beforeImgH,
      currentFlexGrows: _beforeFlexG,
      currentContainerH: _beforeContainerH,
    });
    if (containerWidth === 0) {
      window.requestAnimationFrame(() => this.recalculateRowHeight());
      return;
    }
    // Record the document-uniform width so build() can scale stale cached
    // heights if the editor width has changed since they were cached.
    lastMeasuredWidth = containerWidth;
    this.lastLayoutWidthPx = containerWidth;

    // FLICKER_DIAG: capture the transient PAINTED state right before recalc
    // changes anything — this is the frame the user sees flicker on.  Compare
    // the rendered image widths/heights against the real container width and
    // the reliable content-DOM width to confirm whether the widget was showing
    // dimensions sized for a *different* (wider) editor width.
    {
      const cRect = this.container.getBoundingClientRect();
      const imgs = this.imageEls.map((el) => {
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), styleH: el.style.height };
      });
      const ancW = (sel: string): number => {
        const el = this.container?.closest(sel) as HTMLElement | null;
        return el ? Math.round(el.getBoundingClientRect().width) : -1;
      };
      log.debug("FLICKER_DIAG transient@recalc", {
        lineStart: this.group.lineStart,
        imageCount: this.imageEls.length,
        containerRectW: Math.round(cRect.width),
        containerRectH: Math.round(cRect.height),
        cmContentW: ancW(".cm-content"),
        cmScrollerW: ancW(".cm-scroller"),
        cmEditorW: ancW(".cm-editor"),
        lastMeasuredWidth,
        sidebars: getSidebarWidths(),
        imgs,
      });
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
      this.getInterItemSpace(),
      this.options.defaultRowHeight
    );
    this.rowHeight = clamped;

    log.debug("ImageRowWidget recalculateRowHeight", { containerWidth, rawInlineFlexGrow: this.itemEls.map(el => el.style.flexGrow), parsedGrows: grows, imageCount: n, clampedRowHeight: clamped });

    // ── Auto-fill missing flexGrow for images without |width in markdown ──
    // When some images have explicit |width and others don't (e.g. after
    // markdown corruption), the default flexGrow=1 can be severely wrong.
    // Compute a proportional flexGrow from natural aspect ratio so the image
    // renders at the same height as the rest of the row.
    if (n > 1) {
      const someExplicit = this.group.images.some(img => img.hasSizing);
      const someMissing = this.group.images.some(img => !img.hasSizing);
      if (someExplicit && someMissing && clamped > 0) {
        let explicitSum = 0;
        let missingCoefSum = 0;
        for (let i = 0; i < n; i++) {
          if (this.group.images[i].hasSizing) {
            explicitSum += grows[i];
          } else {
            // Per unit of item width, at the fill this row is about to give the
            // member.  A quarter turn's unit is the fit of the turned rectangle
            // inside its own box — the bitmap's aspect for a portrait, which
            // asks for less width than its ratio would, and 1 / aspect for a
            // landscape, the same as upright.
            missingCoefSum += drawnHeightCoefficient(metas[i], 1, this.group.images[i].orientation);
          }
        }
        const AW = containerWidth - (n - 1) * this.getInterItemSpace();
        const denom = AW - clamped * missingCoefSum;
        if (denom > 0 && missingCoefSum > 0) {
          const k = clamped * explicitSum / denom;
          for (let i = 0; i < n; i++) {
            if (!this.group.images[i].hasSizing) {
              const coef = drawnHeightCoefficient(metas[i], 1, this.group.images[i].orientation);
              grows[i] = k * coef;
              this.itemEls[i].style.flexGrow = String(grows[i]);
              this.itemEls[i].style.flex = `${grows[i]} 1 0%`;
              const mi = this.group.images[i];
              if (mi.display.kind === "multi") mi.display.share = quantizeSizing(grows[i]);
            }
          }
          log.debug("ImageRowWidget autoFillMissingFlexGrow", {
            originalGrows: this.itemEls.map(el => el.style.flexGrow).slice(0, n),
            adjustedGrows: grows,
            explicitSum,
            missingCoefSum,
            k,
          });
        }
      } else if (someMissing && clamped > 0) {
        // Nothing in the row is persisted yet — a freshly merged pair, most
        // often.  There is no split to honour, so seed the row at its own
        // equilibrium instead of leaving every member on the uniform flex-grow
        // they start from: equal *drawn* heights are what merging two pictures
        // is meant to give, and a quarter-turned member takes the width its
        // painted frame asks for.
        const totalGrow = grows.reduce((s, g) => s + g, 0);
        const seedFills = this.group.images.map((img) => this.fillOf(img) ?? 1);
        const seeded = computeGlobalEquilibrium(
          metas, totalGrow, seedFills, this.orientationsOf()
        );
        for (let i = 0; i < n; i++) {
          const g = quantizeSizing(clampFlexGrow(seeded[i] ?? 1));
          grows[i] = g;
          this.itemEls[i].style.flexGrow = String(g);
          this.itemEls[i].style.flex = `${g} 1 0%`;
          const mi = this.group.images[i];
          if (mi.display.kind === "multi") mi.display.share = g;
        }
        log.debug("ImageRowWidget seedNewRowEquilibrium", { totalGrow, seeded: [...grows] });
      }
      // Auto-backfill: persist newly-computed flexGrows and scales.
      if (someMissing || this.group.images.some(img => this.fillOf(img) == null)) {
        for (let i = 0; i < n; i++) {
          this.group.images[i].hasSizing = true;
          this._scaleDirtyImages.add(i);
        }
        // Compute scale ratios after layout settles.
        window.requestAnimationFrame(() => {
          for (let i = 0; i < n; i++) {
            const mi = this.group.images[i];
            if (mi.display.kind !== "multi" || mi.display.fill != null) continue;
            const cr = this.getImageContentRect(i);
            const ir = this.itemEls[i]?.getBoundingClientRect();
            if (cr && cr.width > 0 && ir && ir.width > 0) {
              mi.display.fill = quantizeSizing(clampScale(cr.width / ir.width));
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
      // Preserved per-image sizes are active — don't overwrite with uniform h.
      // Just update the container height to match the tallest cell; those
      // preserved sizes are cell heights (the restore writes the same value to
      // the item and to the <img> box), so the tallest one is the row height.
      let maxH = 0;
      for (let i = 0; i < this.itemEls.length; i++) {
        const ih = parseFloat(this.itemEls[i].style.height || "0");
        if (ih > maxH) maxH = ih;
      }
      if (maxH > 0) this.container.style.height = `${maxH}px`;
    } else if (n > 1 && this.group.images.some((img) => this.fillOf(img) != null)) {
      // Restore per-image heights from fill ratios persisted in markdown.
      // fill = imageContentWidth / itemWidth, a dimensionless ratio that
      // survives container-width changes across sessions.
      const scales = this.group.images.map((img) => this.fillOf(img));
      const { heights, boxes } = computeScaleBasedHeights(
        grows, metas, scales, containerWidth, this.getInterItemSpace(),
        this.options.defaultRowHeight, this.orientationsOf()
      );
      for (let i = 0; i < n; i++) {
        // The <img> carries the un-rotated box; the item takes what the member
        // actually paints.  The two are the same rectangle upright — as this
        // formula gives: a member's drawing *is* its box until a turn folds it —
        // and a quarter turn is the one case they part, the drawing landing
        // inside the box scaled by `quarterTurnFitScale`.  Sizing the cell on the
        // drawing is what makes a balanced row line up: every column hugs its own
        // picture, so equal drawn heights put every picture on one baseline and
        // leave nothing below them.
        this.setImgBoxHeight(i, boxes[i], "scale-branch");
        this.recordGeometry(i, boxes[i], heights[i]);
        this.imageEls[i].setCssStyles({ width: "auto" });
        this.itemEls[i].style.height = `${heights[i]}px`;
      }
      // The row is its tallest cell, and every cell is its member's drawing.
      const rowCellH = heights.length > 0 ? Math.max(...heights) : clamped;
      this.container.style.height = `${rowCellH}px`;
      log.debug("ImageRowWidget scale-based heights restored", {
        scales: this.group.images.map((img) => Math.round((this.fillOf(img) ?? 0) * 100)),
        boxes: this.imageEls.map((el) => el.style.height),
        cells: heights,
        containerH: `${rowCellH}px`,
      });
    } else {
      // No member carries a fill: every box is the uniform height, and a quarter
      // turn stands its box on its side, scaled down to fit back inside it.  The
      // cell follows that drawing, exactly as it does in the scale branch, so a
      // turned member's column hugs its picture instead of holding a taller box
      // around it.
      let rowCellH = 0;
      for (let i = 0; i < this.imageEls.length; i++) {
        const drawn = this.drawnFromBox(clamped, i);
        this.setImgBoxHeight(i, h, "uniform-branch");
        this.recordGeometry(i, clamped, drawn);
        // Let the image take its intrinsic width from the natural
        // aspect ratio so that flex justify-content alignment within
        // the item is visible (without "auto", width stays 100% and
        // the img fills the item, hiding any alignment offset).
        this.imageEls[i].setCssStyles({ width: "auto" });
        if (this.itemEls[i]) this.itemEls[i].style.height = `${drawn}px`;
        if (drawn > rowCellH) rowCellH = drawn;
      }
      this.container.style.height = `${rowCellH > 0 ? rowCellH : clamped}px`;
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
    const layoutChanged = _diffs.length > 0 || _beforeContainerH !== _afterContainerH;
    if (layoutChanged && hasChanged(`dims:${this.group.lineStart}`, {
      diffs: _diffs,
      containerH: `${_beforeContainerH} → ${_afterContainerH}`,
    })) {
      log.debug("BALANCE recalculateRowHeight DIMENSION CHANGES", {
        diffs: _diffs,
        containerH: `${_beforeContainerH} → ${_afterContainerH}`,
      });
    }

    this.applyAlignmentToAll();
    // Only notify CodeMirror when the layout actually changed.  An unconditional
    // dispatch re-enters buildDecorations → layout → onLayoutChange, a feedback
    // cascade of forced full-layout refreshes (the scroll flicker).  Mirrors the
    // guard already present in updateFlexGrows.
    if (layoutChanged) this.onLayoutChange?.();
    // Force reflow so handle positions use the new dimensions
    void this.container.offsetHeight;
    this.updateAllHandlePositions();
    // Cache the rendered pixel dimensions so the next rebuild (e.g. scroll-in
    // with container temporarily detached) can start from the correct height
    // instead of defaultRowHeight, eliminating the transient flash.
    {
      const key = mkRowKey(this.options.sourcePath, this.group.lineStart, this.group.images.map(i => i.fileName));
      lastRenderedSizes.set(key, {
        containerH: this.container.style.height,
        itemHs: this.itemEls.map(el => el.style.height),
        itemWs: this.itemEls.map(el => el.style.width),
        imgHs: this.imageEls.map(el => el.style.height),
        imgWs: this.imageEls.map(el => el.style.width),
        atWidth: containerWidth,
      });
    }
    this.scheduleRowSnapshot("recalculateRowHeight");
    window.requestAnimationFrame(() => this._logRenderedState("LivePreview"));
    } catch (e) {
      log.error("ImageRowWidget recalculateRowHeight error", { error: String(e), stack: (e as Error)?.stack ?? "no stack" });
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
        fill: this.group.images[i] ? this.fillOf(this.group.images[i]) : null,
      };
    });
    log.debug("RENDER_COMPARE " + mode, {
      containerRect: { x: Math.round(containerRect.x), y: Math.round(containerRect.y), w: Math.round(containerRect.width), h: Math.round(containerRect.height) },
      containerStyle: { height: containerStyle.height, justifyContent: containerStyle.justifyContent },
      alignment: this.options.alignment,
      images,
    });
  }

  /**
   * Drawn heights the row's model gives a pair at the given split.  The grid
   * snap below picks its candidate by this, so the choice is made on the same
   * model the row paints from rather than on the grow values alone.
   */
  private pairDrawnHeights(
    grows: number[],
    metas: ImageMeta[],
    scales: Array<number | null>,
    containerWidth: number,
    leftIndex: number,
    left: number,
    right: number
  ): { left: number; right: number } {
    const candidate = grows.slice();
    candidate[leftIndex] = left;
    candidate[leftIndex + 1] = right;
    return computePairHeights(
      candidate,
      metas,
      scales,
      containerWidth,
      this.getInterItemSpace(),
      this.options.defaultRowHeight,
      leftIndex,
      this.orientationsOf()
    );
  }

  /**
   * Land a solved split on the grid the file persists on, choosing the grid
   * neighbours that keep the pair closest to equal drawn heights.
   *
   * The solve is continuous; the row grammar is hundredths.  Rounding each side
   * independently would leave the members up to a step apart — the difference
   * only shows up as "equalised here, a pixel off there".  The scan runs along
   * the pair's own total, which is what a divider holds constant: it
   * redistributes width between its two neighbours and never takes any from the
   * rest of the row.
   */
  private snapPairToGrid(
    grows: number[],
    metas: ImageMeta[],
    scales: Array<number | null>,
    containerWidth: number,
    leftIndex: number,
    left: number,
    right: number
  ): { left: number; right: number } {
    const total = left + right;
    const spread = (l: number, r: number): number => {
      const h = this.pairDrawnHeights(grows, metas, scales, containerWidth, leftIndex, l, r);
      return Math.abs(h.left - h.right);
    };
    const onGrid = (v: number): number | null => {
      const q = quantizeSizing(v);
      return q >= DIVIDER_MIN_GROW ? q : null;
    };

    let bestL: number | null = null;
    let bestR: number | null = null;
    let best = Infinity;
    for (let dl = -2; dl <= 2; dl++) {
      const l = onGrid(left + dl / SIZING_STEP);
      if (l === null) continue;
      const r = onGrid(total - l);
      if (r === null) continue;
      const s = spread(l, r);
      if (s < best) {
        best = s;
        bestL = l;
        bestR = r;
      }
    }
    return bestL === null || bestR === null ? { left, right } : { left: bestL, right: bestR };
  }

  /**
   * Land a row-wide solve on the persisted grid by sweeping the *scale* of the
   * continuous solution, not a neighbourhood of grid points.
   *
   * A row's shares are only meaningful as a ratio: the model lays each member out
   * at `(g_i / Σg) × availableWidth`, so multiplying every share by the same
   * factor changes nothing on screen while shifting where the per-image rounding
   * lands.  That degree of freedom is the whole point — the grid point that paints
   * four equal heights can sit several grid steps away from the rounded
   * equilibrium, and *every* single step towards it is worse than standing still,
   * so a local descent stalls at the seed (the visible "middle two a pixel short"
   * row).  Sweeping the scale finds it by construction: candidates keep the
   * continuous solution's ratios, so the unrounded model is equal along the whole
   * sweep and the search only has to move the per-image rounding off the seed.
   *
   * The ratios are recomputed here from `metas`/`scales`/the incoming total rather
   * than read off the incoming `grows`: those are the pre-snap values and may
   * still carry a stale user intent, while the equilibrium is the aspect/fill
   * shape the gesture asked for.
   *
   * Two grid points can paint the same heights; the tie is broken on the
   * unrounded model, which says which of them is actually the closer to equal —
   * and the sweep adopts the first point that is not beatable, so the smallest
   * scale painting an exact match wins.
   */
  private snapAllToGrid(
    grows: number[],
    metas: ImageMeta[],
    scales: Array<number | null>,
    containerWidth: number
  ): number[] {
    const gap = this.getInterItemSpace();
    const orientations = this.orientationsOf();
    const span = (hs: number[]): number =>
      hs.length === 0 ? 0 : Math.max(...hs) - Math.min(...hs);
    const spread = (gs: number[]): { painted: number; exact: number } => ({
      painted: span(computeScaleBasedHeights(
        gs, metas, scales, containerWidth, gap, this.options.defaultRowHeight, orientations
      ).heights),
      exact: span(computeScaleBasedHeightsContinuous(
        gs, metas, scales, containerWidth, gap, this.options.defaultRowHeight, orientations
      ).heights),
    });
    const better = (
      a: { painted: number; exact: number },
      b: { painted: number; exact: number }
    ): boolean =>
      a.painted < b.painted || (a.painted === b.painted && a.exact < b.exact - 1e-9);

    const fallback = grows.map((g) => Math.max(DIVIDER_MIN_GROW, quantizeSizing(g)));
    if (grows.length === 0) return fallback;

    let total = 0;
    for (const g of grows) total += g;
    const cont = computeGlobalEquilibrium(metas, total, scales, orientations);
    let contSum = 0;
    for (const c of cont) contSum += c;
    if (!(contSum > 0)) return fallback;
    const ratios = cont.map((c) => c / contSum);
    const rMax = Math.max(...ratios);
    if (!(rMax > 0)) return fallback;

    // The scale is the largest member's grid value; the sweep spans half to
    // double it, which is far more than any rounding disagreement needs.
    let maxShare = 0;
    for (const g of grows) if (g > maxShare) maxShare = g;
    const m0 = Math.max(DIVIDER_MIN_GROW, quantizeSizing(maxShare));
    const lo = Math.round(0.5 * m0 * SIZING_STEP);
    const hi = Math.round(2 * m0 * SIZING_STEP);

    let best: { painted: number; exact: number } | null = null;
    let bestGrows: number[] | null = null;
    for (let code = lo; code <= hi; code++) {
      const m = code / SIZING_STEP;
      const candidate = ratios.map((r) =>
        Math.max(DIVIDER_MIN_GROW, quantizeSizing((r / rMax) * m))
      );
      const s = spread(candidate);
      if (best === null || better(s, best)) {
        best = s;
        bestGrows = candidate;
      }
    }
    return bestGrows ?? fallback;
  }

  /**
   * Double-click on divider: snap the two adjacent images to equal heights.
   */
  snapDividerToEquilibrium(leftIndex: number): void {
    log.debug("BALANCE snapDividerToEquilibrium entry", {
      leftIndex,
      loadedMetasSize: this.loadedMetas.size,
      itemElsLength: this.itemEls.length,
    });

    const n = this.itemEls.length;
    if (leftIndex < 0 || leftIndex + 1 >= n) {
      log.debug("BALANCE snapDividerToEquilibrium GUARD FAIL: pair out of range", { leftIndex, n });
      return;
    }
    if (!this.container) {
      log.debug("BALANCE snapDividerToEquilibrium GUARD FAIL: not built");
      return;
    }
    const containerWidth = this.container.getBoundingClientRect().width;
    if (!(containerWidth > 0)) {
      log.debug("BALANCE snapDividerToEquilibrium GUARD FAIL: no container width");
      return;
    }

    const grows: number[] = [];
    const metas: ImageMeta[] = [];
    const scales: Array<number | null> = [];
    for (let i = 0; i < n; i++) {
      const m = this.loadedMetas.get(i);
      if (!m || m.naturalWidth === 0 || m.naturalHeight === 0) {
        log.debug("BALANCE snapDividerToEquilibrium GUARD FAIL: metas not ready", {
          index: i,
          hasMeta: !!m,
          naturalW: m?.naturalWidth,
        });
        return;
      }
      metas[i] = m;
      const parsed = parseFloat(this.itemEls[i]?.style.flexGrow || "1");
      grows[i] = isFinite(parsed) ? parsed : 1;
      // Only the pair this divider owns is re-proportioned, and it is solved at
      // its natural proportion: the two pictures fill the slots they are handed,
      // so the split follows their aspect ratios outright.  The rest of the row
      // keeps whatever fill it carries — a divider re-splits its own junction,
      // it does not reach across the row.
      scales[i] = i === leftIndex || i === leftIndex + 1
        ? 1
        : this.fillOf(this.group.images[i]);
    }

    const total = grows[leftIndex] + grows[leftIndex + 1];

    // Solve on the model the row paints from — the same solve the divider drag
    // snaps to, so the two gestures land on identical geometry.  The pair's
    // fills are 1 by the line above, which is what makes "equal drawn heights"
    // and "the split follows the aspect ratios" the same equation.
    let left: number;
    let right: number;
    let model = "render";
    const pair = computePairEquilibrium(
      grows,
      metas,
      scales,
      containerWidth,
      this.getInterItemSpace(),
      this.options.defaultRowHeight,
      leftIndex,
      this.orientationsOf()
    );
    if (pair) {
      left = pair.left;
      right = pair.right;
    } else {
      // Nothing on the row's model equalises this pair: a member that isn't
      // laid out on the size model — the row fallback instead of a height its
      // grow can steer — or a ratio past the divider's reach.  Land on the
      // no-fill split, which is where the render model above puts a pair whose
      // fills agree — and, like the model, read each side through its turn.
      const orientations = this.orientationsOf();
      const aspect = computeDividerEquilibrium(
        metas[leftIndex],
        metas[leftIndex + 1],
        total,
        [orientations[leftIndex], orientations[leftIndex + 1]]
      );
      left = aspect.left;
      right = aspect.right;
      model = "aspect-fallback";
    }

    // Land the split on the grid the file persists on before painting it.  The
    // solve is continuous; the row grammar is hundredths.  Painting the
    // continuous value and persisting the rounded one would make the two sides
    // drift apart by up to a step on the next rebuild, which is exactly the
    // "equalised here, not equal there" gap — so the committed split is the one
    // both the screen and the file carry.
    const snapped = this.snapPairToGrid(
      grows, metas, scales, containerWidth, leftIndex, left, right
    );
    left = snapped.left;
    right = snapped.right;
    model += "+grid";

    this.itemEls[leftIndex].style.flexGrow = String(clampFlexGrow(left));
    this.itemEls[leftIndex + 1].style.flexGrow = String(clampFlexGrow(right));

    // Sync in-memory state before persisting.  Both members of the pair lose
    // their fill: the split was solved with the pair at 1, and the row reads
    // the fills back from the note on every rebuild — keeping one would paint
    // the picture narrow inside the slot the split just gave it.
    const leftImg = this.group.images[leftIndex];
    const rightImg = this.group.images[leftIndex + 1];
    if (leftImg.display.kind === "multi") {
      leftImg.display.share = quantizeSizing(clampFlexGrow(left));
      leftImg.display.fill = 1;
      leftImg.hasSizing = true;
    }
    if (rightImg.display.kind === "multi") {
      rightImg.display.share = quantizeSizing(clampFlexGrow(right));
      rightImg.display.fill = 1;
      rightImg.hasSizing = true;
    }

    // Hand the sizing to the row's own pass rather than pinning heights here.
    // It paints each picture from the split, so the members stay flush to their
    // items — a pinned height would shrink the picture inside its item and open
    // the gap between the two — and the row ends up the height every other pass
    // already agrees on.
    this.recalculateRowHeight();

    // Persist to markdown — triggers widget rebuild, but preserved sizes
    // (still intact) restore per-image heights for unaffected images.
    log.debug("BALANCE snapDividerToEquilibrium calling persistCallback", {
      hasPersist: !!this.persistCallback,
    });
    this.persistCallback?.();

    log.info("Divider dblclick snap to equilibrium", {
      leftIndex,
      total,
      snapLeft: left,
      snapRight: right,
      model,
    });
  }

  /**
   * Double-click top bar: snap ALL images in the row to equal heights.
   *
   * The balance is struck on the pictures' own aspect ratios, so each member
   * ends up filling the slot it is given: the solve runs with every fill taken
   * as 1, and weights go in `aspect`.  Feeding a member's own fill in instead
   * is what let equal heights coexist with a blank — the member was handed a
   * *wider* slot to compensate for drawing at `fill × slot`, and the picture
   * then sat in the middle of it with the rest empty.  The gesture therefore
   * also retires the fills it balances: they are written back as 1, because the
   * row re-reads them from the note on every rebuild and a fill left behind
   * would put the blank straight back.  Sizing is left to the row's own pass,
   * exactly as the divider double-click does, so both gestures and the divider
   * drag agree on geometry.
   */
  private snapAllToEquilibrium(): void {
    const n = this.itemEls.length;
    log.debug("BALANCE snapAllToEquilibrium entry", {
      imageCount: n,
      loadedMetasSize: this.loadedMetas.size,
    });
    if (n < 2) {
      log.debug("BALANCE snapAllToEquilibrium GUARD FAIL: n < 2");
      return;
    }
    if (!this.container) {
      log.debug("BALANCE snapAllToEquilibrium GUARD FAIL: not built");
      return;
    }

    const metas: ImageMeta[] = [];
    const scales: Array<number | null> = [];
    let totalGrow = 0;
    for (let i = 0; i < n; i++) {
      const meta = this.loadedMetas.get(i);
      if (!meta || meta.naturalWidth === 0 || meta.naturalHeight === 0) {
        log.debug("BALANCE snapAllToEquilibrium GUARD FAIL: meta not ready", {
          index: i,
          hasMeta: !!meta,
          naturalW: meta?.naturalWidth,
        });
        return;
      }
      metas.push(meta);
      // Every member the gesture balances is taken at its natural proportion —
      // a retired fill is 1, and one that was never set is 1 too, so the row is
      // solved on aspect ratios alone.
      scales.push(1);
      totalGrow += parseFloat(this.itemEls[i].style.flexGrow || "1");
    }

    const rawGrows = computeGlobalEquilibrium(metas, totalGrow, scales, this.orientationsOf());
    const containerWidth = this.container.getBoundingClientRect().width;
    // Same two steps as the divider double-click: solve continuously, then land
    // the split on the grid the file persists on — otherwise the equality the
    // user just asked for is a step off everywhere it is re-read.
    const grows = this.snapAllToGrid(
      validateRowFlexGrows(rawGrows, metas, containerWidth, this.getInterItemSpace()),
      metas,
      scales,
      containerWidth
    );

    for (let i = 0; i < n; i++) {
      this.itemEls[i].style.flexGrow = String(grows[i]);
      const mi = this.group.images[i];
      if (mi.display.kind === "multi") {
        mi.display.share = quantizeSizing(grows[i]);
        // Retire the member's own fill: the row reads it back from the note on
        // every rebuild, so leaving it behind would restore the blank.
        mi.display.fill = 1;
        mi.hasSizing = true;
      }
    }

    this.recalculateRowHeight();
    this.scheduleRowSnapshot("snapAllToEquilibrium");

    // Persist to markdown — triggers widget rebuild, but preserved sizes
    // (still intact) restore the uniform heights correctly.
    log.debug("BALANCE snapAllToEquilibrium calling persistCallback", {
      hasPersist: !!this.persistCallback,
    });
    this.persistCallback?.();

    log.info("Top bar dblclick global snap", { totalGrow, grows });
  }

  /**
   * Update the flex-grow values from an external source (e.g., after reorder).
   */
  updateFlexGrows(grows: number[]): void {
    // Skip if unchanged to avoid unnecessary reflow + onLayoutChange feedback loop.
    if (this.flexGrows.length === grows.length &&
        this.flexGrows.every((g, i) => g === grows[i])) {
      log.debug("BALANCE updateFlexGrows SKIPPED (unchanged)", {
        flexGrows: this.flexGrows,
        incoming: grows,
      });
      return;
    }
    log.debug("BALANCE updateFlexGrows applying", {
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
    if (this.snapshotTimer !== null) {
      window.clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    for (const divider of this.dividerEls) {
      if (divider._destroy) divider._destroy();
    }
    for (const handles of this.resizeHandles) {
      for (const h of handles) {
        if (h._destroy) h._destroy();
      }
    }
    this.resizeSnapDivider = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.narrowUnsub?.();
    this.narrowUnsub = null;
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
    // Only save preserved sizes when the row has NO fill data.
    // When fill ratios exist in markdown, per-image heights are derived
    // from them on next load — preserved pixel values would be stale.
    const hasFill = this.group.images.some(img => this.fillOf(img) != null);
    if (this.group.images.length > 1 && this.imageEls.length > 0
        && this.itemEls.some((el) => el.style.height && el.style.height !== "100%")
        && !hasFill) {
      const data: MultiImageSizeData = {
        images: this.imageEls.map((img, i) => ({
          styleW: img.style.width,
          // The img's own box, not the item's — a turned member's item hugs the
          // drawing, so the item's height is not this rectangle.
          styleH: img.style.height || this.itemEls[i]?.style.height || "",
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
    this.resizeSnapDivider = null;
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
