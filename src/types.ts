// ── Shared types ─────────────────────────────────────────────────────────
// Extracted from imageRowWidget.ts so reading mode can import types
// without depending on live-preview widget code.

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
  maxImagesPerRow: number;
  imageExtensions: string;
  getResourcePath: (fileName: string) => string;
  sourcePath: string;
}

export interface MultiImageSizeData {
  images: Array<{ styleW: string; styleH: string }>;
  items: Array<{ flexGrow: string; styleH: string }>;
  containerStyleH: string;
  filePath: string;
}
