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
} as const;

export const DEFAULT_SETTINGS = {
  enabled: true,
  defaultRowHeight: 200,
  maxImagesPerRow: 10,
  gapSize: 4,
  enableDragReorder: true,
  enableResize: true,
  enableDividers: true,
  imageExtensions: "png,jpg,jpeg,gif,webp,svg,bmp,avif",
} as const;

export const MIN_IMAGE_WIDTH = 50;
export const DIVIDER_WIDTH = 4;
export const RESIZE_HANDLE_SIZE = 8;
export const RESIZE_DEBOUNCE_MS = 100;

export function buildImageLineRe(extensions: string): RegExp {
  const extList = extensions.split(",").map(s => s.trim()).filter(Boolean).join("|");
  // Format: ![[filename|width]] — width is INSIDE [[...]], before ]]
  return new RegExp(
    `^\\s*!\\[\\[([^\\]]+\\.(?:${extList}))(?:\\|(\\d+))?\\]\\]\\s*$`,
    "i"
  );
}
