import type { LogLevel } from "./logger";

export const CSS_PREFIX = "diaa";

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
  /** Reading-Mode row image sized by height, keeping its aspect ratio. */
  imgAuto: `${CSS_PREFIX}-img-auto`,
  /** Standalone image extracted from a text block, shrink-wrapped. */
  rowInline: `${CSS_PREFIX}-row-inline`,
  /** Obsidian wrapper element neutralized to `display: contents`. */
  contents: `${CSS_PREFIX}-contents`,
  /** The bullet list the switch-off notice renders inside its notice element. */
  noticeList: `${CSS_PREFIX}-notice-list`,
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
  enableReadingModeDoubleClickZoom: true,
  menuScalePercent: 100,
  logLevel: "ERROR" as LogLevel,
  logToFile: false,
  geometryProbe: false,
} as const;

export const SINGLE_IMAGE_MIN_WIDTH = 100;

export const DIVIDER_WIDTH = 4;
export const RESIZE_HANDLE_SIZE = 10;

/**
 * Space one junction between two adjacent flex items occupies, in px.
 *
 * A divider is a real flex child, so a junction carrying one costs the
 * container's flex gap on *both* sides of it plus the divider's own width.
 * Layout math must subtract this per junction — not the bare CSS `gap` — or
 * every item is handed more width than it is painted with, and the row's
 * computed heights run ahead of the pictures by the difference.
 */
export function computeInterItemSpace(gap: number, dividers: boolean): number {
  return dividers ? 2 * gap + DIVIDER_WIDTH : gap;
}

export function buildImageLineRe(extensions: string): RegExp {
  const extList = extensions.split(",").map(s => s.trim()).filter(Boolean).join("|");
  // Format: ![[filename|width]] or ![[filename|WxH]] or ![[filename|width|WxH]]
  // Match anything between | and ]] (Obsidian dimensions, plugin width, or both)
  return new RegExp(
    `^\\s*!\\[\\[([^\\]]+\\.(?:${extList}))(?:\\|([^\\]]*))?\\]\\]\\s*$`,
    "i"
  );
}

/**
 * Every image embed a line holds, wherever it sits in the line (`![[a.png]]`,
 * `- ![[a.png|400]]`, `文字 ![[a.png|center]] 文字`).  Groups: 1 = file name,
 * 2 = the param run, absent on a bare embed.  Global, so callers walk one
 * reference at a time — `buildImageLineRe` only sees the rows DIAA hosts, while
 * a reference embedded in prose is still a reference the maintenance passes
 * have to account for.
 */
export function buildImageEmbedRe(extensions: string): RegExp {
  const extList = extensions.split(",").map(s => s.trim()).filter(Boolean).join("|");
  return new RegExp(`!\\[\\[([^\\]|]+\\.(?:${extList}))(?:\\|([^\\]]*))?\\]\\]`, "gi");
}
