import { ImageMeta } from "./imageDetector";

export interface LayoutResult {
  /** Computed uniform row height in px */
  rowHeight: number;
  /** Rendered width of each image in px */
  imageWidths: number[];
  /** Total row width consumed (images + gaps), in px */
  totalWidth: number;
}

/**
 * Calculate the uniform height for a row of images that fills the container.
 *
 * Formula:
 *   sum(h * (w_i / h_i)) + (n-1) * gap = containerWidth
 *   h = (containerWidth - (n-1) * gap) / sum(w_i / h_i)
 *
 * Each image at height h has width = h * (w_i / h_i) = h * aspectRatio.
 */
export function computeUniformHeight(
  metas: ImageMeta[],
  containerWidth: number,
  gap: number,
  minHeight: number,
  maxHeight: number
): LayoutResult {
  const n = metas.length;
  if (n === 0) {
    return { rowHeight: minHeight, imageWidths: [], totalWidth: 0 };
  }

  // Sum of aspect ratios (width / height)
  let sumAspect = 0;
  for (const meta of metas) {
    if (meta.naturalWidth > 0 && meta.naturalHeight > 0) {
      sumAspect += meta.naturalWidth / meta.naturalHeight;
    } else {
      // Fallback for images that haven't loaded yet: assume 4:3
      sumAspect += 4 / 3;
    }
  }

  // Default container width
  const effectiveWidth = containerWidth > 0 ? containerWidth : 800;

  const totalGap = (n - 1) * gap;
  const h = (effectiveWidth - totalGap) / sumAspect;

  // Clamp height
  const rowHeight = Math.max(minHeight, Math.min(maxHeight, Math.round(h)));

  // Calculate individual widths at the final rowHeight
  const imageWidths: number[] = [];
  for (const meta of metas) {
    if (meta.naturalWidth > 0 && meta.naturalHeight > 0) {
      imageWidths.push(
        Math.round(rowHeight * (meta.naturalWidth / meta.naturalHeight))
      );
    } else {
      imageWidths.push(Math.round(rowHeight * (4 / 3)));
    }
  }

  const totalWidth = imageWidths.reduce((s, w) => s + w, 0) + totalGap;

  return { rowHeight, imageWidths, totalWidth };
}

/**
 * Return flex-grow values proportional to natural aspect ratios.
 * These are used in CSS flex layout for responsive rows.
 */
export function computeFlexGrows(metas: ImageMeta[]): number[] {
  if (metas.length === 0) return [];

  // Calculate aspect ratios
  const aspects = metas.map((m) =>
    m.naturalWidth > 0 && m.naturalHeight > 0
      ? m.naturalWidth / m.naturalHeight
      : 4 / 3
  );

  // Normalize so the smallest aspect ratio maps to flex-grow 1
  const minAspect = Math.min(...aspects);
  return aspects.map((a) => Math.round((a / minAspect) * 100) / 100);
}
