export const CSS_PREFIX = "drag-img";

export const CLASSES = {
  row: `${CSS_PREFIX}-row`,
  imageItem: `${CSS_PREFIX}-item`,
  imageInner: `${CSS_PREFIX}-img`,
  divider: `${CSS_PREFIX}-divider`,
  resizeHandle: `${CSS_PREFIX}-resize-handle`,
  dropIndicator: `${CSS_PREFIX}-drop-indicator`,
  dragging: `${CSS_PREFIX}-dragging`,
  placeholder: `${CSS_PREFIX}-placeholder`,
  dividerActive: `${CSS_PREFIX}-divider-active`,
  dividerSnap: `${CSS_PREFIX}-divider-snap`,
  itemSnap: `${CSS_PREFIX}-snap`,
  topBar: `${CSS_PREFIX}-top-bar`,
  resizing: `${CSS_PREFIX}-resizing`,
} as const;

export type Alignment = "left" | "center" | "right";

/** How a single-image row is sized: at the image's natural size (shrunk to the
 *  container width when wider) or at a fixed user-specified width. */
export type SingleImageSizeMode = "natural" | "fixed";

export const DEFAULT_SETTINGS = {
  defaultRowHeight: 200,
  maxImagesPerRow: 10,
  gapSize: 4,
  snapSensitivity: 3,
  enableDragReorder: true,
  enableResize: true,
  enableDividers: true,
  imageExtensions: "png,jpg,jpeg,gif,webp,svg,bmp,avif",
  topBarSensitivity: 12,
  ghostImageWidth: 120,
  dragOpacity: 60,
  alignment: "left" as Alignment,
  singleImageSizeMode: "natural" as SingleImageSizeMode,
  singleImageWidth: 400,
  enableReadingModeContextMenu: true,
  menuScalePercent: 100,
} as const;

export const SINGLE_IMAGE_MIN_WIDTH = 100;

export const DIVIDER_WIDTH = 4;
export const RESIZE_HANDLE_SIZE = 10;

export function buildImageLineRe(extensions: string): RegExp {
  const extList = extensions.split(",").map(s => s.trim()).filter(Boolean).join("|");
  // Format: ![[filename|width]] or ![[filename|WxH]] or ![[filename|width|WxH]]
  // Match anything between | and ]] (Obsidian dimensions, plugin width, or both)
  return new RegExp(
    `^\\s*!\\[\\[([^\\]]+\\.(?:${extList}))(?:\\|([^\\]]*))?\\]\\]\\s*$`,
    "i"
  );
}
