import { ImageMeta } from "../imageParse/imageDetector";
import { SingleImageSizeMode, SINGLE_IMAGE_MIN_WIDTH } from "../constants";

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

/**
 * Convert measured item pixel widths into flex-grow weights.
 * Normalizes so the smallest positive width maps to flex-grow 1, rounded to two
 * decimals — mirroring `computeFlexGrows` but keyed on rendered widths instead of
 * aspect ratios.  Used when an image moves between rows: each row's flex-grows are
 * recomputed from current item widths so proportions stay consistent across rows.
 * Non-positive widths fall back to flex-grow 1.  Pure — no DOM.
 */
export function computeFlexGrowsFromWidths(widths: number[]): number[] {
  if (widths.length === 0) return [];
  const positive = widths.filter((w) => w > 0);
  const min = positive.length > 0 ? Math.min(...positive) : 1;
  return widths.map((w) => (w > 0 ? Math.round((w / min) * 100) / 100 : 1));
}

/**
 * Compute the width (px) a setting-driven single-image row (S=0) takes across
 * the page.
 * - "natural": the image's own pixel width, shrunk to fit the container.
 * - "fixed": a user-specified width, clamped to [SINGLE_IMAGE_MIN_WIDTH, containerWidth].
 * Both widths are read in the same frame the row stores — the page, not the
 * layout box behind it (transformPreview.ts) — so the "natural" figure handed in
 * comes from `orientedSize`, the bitmap's width as the orientation displays it.
 * Returns 0 when dimensions are unknown.  Pure.
 */
export function computeSingleImageWidth(
  mode: SingleImageSizeMode,
  fixedWidth: number,
  naturalWidth: number,
  containerWidth: number
): number {
  if (naturalWidth <= 0 || containerWidth <= 0) return 0;
  if (mode === "fixed") {
    return Math.round(Math.min(Math.max(fixedWidth, SINGLE_IMAGE_MIN_WIDTH), containerWidth));
  }
  // natural: the image's real pixel width, shrunk to fit the container.
  return Math.round(Math.min(naturalWidth, containerWidth));
}


/**
 * Calculate the row height for a flexbox-based image row.
 *
 * Given the flex-grow values, image natural dimensions, and container width,
 * computes the max height across all images and clamps it to valid bounds.
 * This is the pure calculation core of `recalculateRowHeight`.
 *
 * `gap` is the space one junction between adjacent items consumes — the
 * container's flex gap plus anything sitting in it (a divider is a real flex
 * child, so it costs a gap on each side).  It is not the CSS `gap` value; callers
 * that render dividers must pass the wider figure, or every item is given more
 * width than it is painted with.
 */
export function computeRowHeight(
  flexGrows: number[],
  metas: ImageMeta[],
  containerWidth: number,
  gap: number,
  defaultRowHeight: number
): number {
  const n = flexGrows.length;
  if (n === 0) return 50;

  const availableWidth = containerWidth - (n - 1) * gap;

  let totalGrow = 0;
  for (let i = 0; i < n; i++) {
    totalGrow += flexGrows[i];
  }
  if (totalGrow === 0) return 50;

  let maxHeight = 0;
  for (let i = 0; i < n; i++) {
    const meta = metas[i];
    if (!meta || meta.naturalWidth === 0) continue;
    const w = (flexGrows[i] / totalGrow) * availableWidth;
    const h = w / (meta.naturalWidth / meta.naturalHeight);
    maxHeight = Math.max(maxHeight, h);
  }

  const upperClamp = n === 1 ? 2000 : defaultRowHeight * 3;
  return Math.max(50, Math.min(upperClamp, Math.round(maxHeight)));
}

/** Result of computeScaleBasedHeights: per-image pixel heights + the tallest. */
export interface ScaleBasedHeightsResult {
  heights: number[];
  maxH: number;
}

/**
 * Compute per-image heights from persisted scale ratios.
 * `scale = imageContentWidth / itemWidth` — a dimensionless ratio that survives
 * container-width changes.  For each image with a valid scale (0 < scale ≤ 1)
 * the height is `round(scale * itemW / aspectRatio)` — a per-image height, so a
 * full-width image (scale = 1) keeps its own `itemW / aspectRatio` instead of
 * the row max.  Images without a valid scale fall back to the uniform
 * `computeRowHeight` value.  Pure — no DOM.
 */
export function computeScaleBasedHeights(
  flexGrows: number[],
  metas: ImageMeta[],
  scales: Array<number | null>,
  containerWidth: number,
  gap: number,
  defaultRowHeight: number
): ScaleBasedHeightsResult {
  return scaleBasedHeights(flexGrows, metas, scales, containerWidth, gap, defaultRowHeight, true);
}

/**
 * The scale-based model, optionally left unrounded.
 *
 * Solving for the split that equalises two members needs the *continuous*
 * height: rounded per-image heights are a staircase, so a search over them can
 * only report "somewhere in the flat band", and the two members then round to
 * heights up to a pixel apart.  Unrounded, the difference is monotone with a
 * single exact zero, and the split found there rounds to the same pixel on both
 * sides.  Painting always uses the rounded figures.
 */
function scaleBasedHeights(
  flexGrows: number[],
  metas: ImageMeta[],
  scales: Array<number | null>,
  containerWidth: number,
  gap: number,
  defaultRowHeight: number,
  round: boolean
): ScaleBasedHeightsResult {
  const n = flexGrows.length;
  const fallback = computeRowHeight(flexGrows, metas, containerWidth, gap, defaultRowHeight);
  let totalG = 0;
  for (let i = 0; i < n; i++) totalG += flexGrows[i];
  const availableWidth = containerWidth - (n - 1) * gap;

  const heights: number[] = [];
  let maxH = 0;
  for (let i = 0; i < n; i++) {
    const scale = scales[i];
    const meta = metas[i];
    let imageH: number;
    if (scale != null && scale > 0 && scale <= 1 && totalG > 0 && meta && meta.naturalHeight > 0) {
      const itemW = (flexGrows[i] / totalG) * availableWidth;
      const ar = meta.naturalWidth / meta.naturalHeight;
      imageH = (scale * itemW) / ar;
      if (round) imageH = Math.round(imageH);
    } else {
      imageH = fallback;
    }
    heights.push(imageH);
    if (imageH > maxH) maxH = imageH;
  }
  return { heights, maxH };
}

/**
 * Compute each image's height in a flex row individually.
 * Unlike `computeRowHeight` which returns the max across all images,
 * this returns per-image heights — revealing that images with different
 * aspect ratios naturally have different heights in the same row.
 *
 * Used to verify that changing one image's flex-grow doesn't spuriously
 * reset another image's height (the other image's height shifts only by
 * the proportional change in totalGrow).
 */
export function computeIndividualHeights(
  flexGrows: number[],
  metas: ImageMeta[],
  containerWidth: number,
  gap: number
): number[] {
  const n = flexGrows.length;
  if (n === 0) return [];

  const availableWidth = containerWidth - (n - 1) * gap;
  let totalGrow = 0;
  for (const g of flexGrows) totalGrow += g;
  if (totalGrow === 0) return flexGrows.map(() => 0);

  return flexGrows.map((g, i) => {
    const meta = metas[i];
    if (!meta || meta.naturalWidth === 0) return 0;
    const w = (g / totalGrow) * availableWidth;
    return Math.round(w / (meta.naturalWidth / meta.naturalHeight));
  });
}

/**
 * Compute the actual rendered image rect within a container,
 * accounting for object-fit: contain + object-position: left top.
 *
 * Returns null if dimensions are invalid or meta is not loaded.
 */
export function computeImageContentRect(
  itemWidth: number,
  itemHeight: number,
  meta: ImageMeta
): { left: number; top: number; width: number; height: number } | null {
  if (itemWidth === 0 || itemHeight === 0) return null;
  if (!meta || meta.naturalWidth === 0) return null;

  const imageAspect = meta.naturalWidth / meta.naturalHeight;
  const containerAspect = itemWidth / itemHeight;

  let displayW: number;
  let displayH: number;

  if (imageAspect > containerAspect) {
    displayW = itemWidth;
    displayH = itemWidth / imageAspect;
  } else {
    displayH = itemHeight;
    displayW = itemHeight * imageAspect;
  }

  return { left: 0, top: 0, width: displayW, height: displayH };
}

/**
 * Compute equilibrium flex-grow values for two adjacent images
 * so they render at the same height.
 */
export function computeDividerEquilibrium(
  leftMeta: ImageMeta,
  rightMeta: ImageMeta,
  totalFlex: number
): { left: number; right: number } {
  const la = leftMeta.naturalWidth / leftMeta.naturalHeight;
  const ra = rightMeta.naturalWidth / rightMeta.naturalHeight;
  if (isNaN(la) || isNaN(ra) || la + ra === 0) {
    return { left: totalFlex / 2, right: totalFlex / 2 };
  }
  const snapLeft = totalFlex * la / (la + ra);
  return { left: snapLeft, right: totalFlex - snapLeft };
}

/** The lowest flex-grow the divider drag lets either side take. */
const DIVIDER_MIN_GROW = 0.1;
/** Two members count as equal when the solved heights differ by no more than
 *  this.  The split is solved on unrounded heights, so it normally lands on an
 *  exact zero; the slack exists only for a member whose height comes from the
 *  row fallback, which is a rounded staircase the bisection cannot split. */
const PAIR_EQUAL_TOLERANCE_PX = 1;

/**
 * Rendered heights of two adjacent members at a given flex-grow split, on the
 * same model `recalculateRowHeight` paints from — per-image fill ratios, the
 * row-wide grow divisor and the fallback for members without a fill all come
 * from `computeScaleBasedHeights`.  Pure — no DOM.
 */
export function computePairHeights(
  grows: number[],
  metas: ImageMeta[],
  scales: Array<number | null>,
  containerWidth: number,
  gap: number,
  defaultRowHeight: number,
  leftIndex: number
): { left: number; right: number } {
  const { heights } = computeScaleBasedHeights(
    grows,
    metas,
    scales,
    containerWidth,
    gap,
    defaultRowHeight
  );
  return { left: heights[leftIndex] ?? 0, right: heights[leftIndex + 1] ?? 0 };
}

/** Where a pair renders at the same height, and what that height is. */
export interface PairEquilibrium {
  left: number;
  right: number;
  height: number;
}

/**
 * Solve the flex-grow split that renders two adjacent members at the same
 * height, on the same model `computePairHeights` reads.
 *
 * A member's drawn height is `fill × grow / aspect`, so equal heights ask for a
 * split in `aspect / fill` — not in `aspect`, which is the same thing only while
 * the two fills agree.  The pair's grow sum is held constant (a divider only
 * redistributes between its neighbours), and the left height rises with the left
 * grow while the right falls, so the difference is monotone and bisection
 * converges.  The search runs on unrounded heights (see `scaleBasedHeights`), so
 * the split it returns is the one the row actually paints at.
 *
 * Returns null when no split can equalise the pair: a member whose height comes
 * from the row fallback rather than its own grow (no fill of its own) may not
 * respond to the split at all, and a pair that is already equal everywhere has
 * nothing to snap to.  Pure — no DOM.
 */
export function computePairEquilibrium(
  grows: number[],
  metas: ImageMeta[],
  scales: Array<number | null>,
  containerWidth: number,
  gap: number,
  defaultRowHeight: number,
  leftIndex: number
): PairEquilibrium | null {
  const pairTotal = grows[leftIndex] + grows[leftIndex + 1];
  const lo = DIVIDER_MIN_GROW;
  const hi = pairTotal - DIVIDER_MIN_GROW;
  if (!(hi > lo)) return null;

  const at = (leftGrow: number) => {
    const candidate = grows.slice();
    candidate[leftIndex] = leftGrow;
    candidate[leftIndex + 1] = pairTotal - leftGrow;
    const { heights } = scaleBasedHeights(
      candidate,
      metas,
      scales,
      containerWidth,
      gap,
      defaultRowHeight,
      false
    );
    const left = heights[leftIndex] ?? 0;
    const right = heights[leftIndex + 1] ?? 0;
    return { diff: left - right, left, right };
  };

  const atLo = at(lo);
  const atHi = at(hi);
  if (atLo.diff === atHi.diff) return null;
  if (atLo.diff > 0 || atHi.diff < 0) return null;

  let a = lo;
  let b = hi;
  for (let i = 0; i < 60 && b - a > 1e-6; i++) {
    const mid = (a + b) / 2;
    if (at(mid).diff < 0) a = mid;
    else b = mid;
  }
  const left = (a + b) / 2;
  const best = at(left);
  if (Math.abs(best.diff) > PAIR_EQUAL_TOLERANCE_PX) return null;
  return { left, right: pairTotal - left, height: (best.left + best.right) / 2 };
}

/**
 * Compute equilibrium flex-grow values for all images in a row
 * so every image renders at the same height.
 *
 * A member's drawn height is `fill × grow / aspect`, so equal heights in a row
 * whose fills differ ask for weights in `aspect / fill`.  Passing `scales` (the
 * members' fill ratios, `null` where none is persisted) applies that; omitting
 * it keeps the aspect-only distribution, which is the same answer while every
 * fill agrees.  A member with no fill of its own renders the row fallback rather
 * than a height of its own choosing, so it cannot be made to match — it keeps
 * its aspect weight and the filled members share what is left.
 */
export function computeGlobalEquilibrium(
  metas: ImageMeta[],
  totalGrow: number,
  scales?: Array<number | null>
): number[] {
  if (metas.length === 0) return [];
  const weights = metas.map((m, i) => {
    const ar = m.naturalWidth / m.naturalHeight;
    const fill = scales?.[i] ?? null;
    return fill != null && fill > 0 ? ar / fill : ar;
  });
  const weightSum = weights.reduce((s, w) => s + w, 0);
  if (weightSum === 0 || isNaN(weightSum)) {
    const uniform = totalGrow / metas.length;
    return metas.map(() => uniform);
  }
  return weights.map((w) => (totalGrow * w) / weightSum);
}

/**
 * Convert a target image height back to the flex-grow value that would
 * produce that height in a flex row, given the sum of other images'
 * flex-grows and the available container width.
 *
 * Derived from the flex layout equation:
 *   height_i = (flexGrow_i / totalFlexGrow) * availableWidth / aspect_i
 *
 * Solving for flexGrow_i:
 *   flexGrow_i = (targetHeight * otherSum) / (availableWidth / aspect - targetHeight)
 *
 * Returns a large sentinel (1e9) when the target height is unattainable
 * (image would need more width than available).
 */
export function imageHeightToFlexGrow(
  targetHeight: number,
  meta: ImageMeta,
  otherFlexGrowSum: number,
  availableWidth: number
): number {
  if (
    meta.naturalWidth === 0 ||
    meta.naturalHeight === 0 ||
    availableWidth <= 0 ||
    targetHeight <= 0
  ) {
    return 1;
  }

  const aspect = meta.naturalWidth / meta.naturalHeight;
  const denom = availableWidth / aspect - targetHeight;

  if (denom <= 0) return 1e9;

  return (targetHeight * otherFlexGrowSum) / denom;
}

/**
 * Compute the X-coordinates of all divider/insertion positions for a flex row.
 *
 * For n images there are n+1 insertion points:
 *   position 0 = containerLeft                        (before first image)
 *   position i = right edge of image[i-1] + gap/2     (between images, 1 <= i < n)
 *   position n = containerLeft + totalWidth           (after last image)
 *
 * These positions are used to place the blue hint line and to determine
 * the insertAt index during drag-and-drop across rows.
 */
export function computeDividerXPositions(
  containerLeft: number,
  imageWidths: number[],
  gap: number
): number[] {
  if (imageWidths.length === 0) return [containerLeft];

  const positions: number[] = [containerLeft];
  let x = containerLeft;
  for (let i = 0; i < imageWidths.length; i++) {
    x += imageWidths[i];
    if (i < imageWidths.length - 1) {
      positions.push(x + gap / 2);
      x += gap;
    }
  }
  positions.push(x);
  return positions;
}

/**
 * Find the index of the divider position closest to cursorX.
 *
 * Returns the divider index if the distance is within `threshold` pixels,
 * otherwise returns null (cursor is not near any divider).
 */
export function findClosestDividerIndex(
  cursorX: number,
  dividerPositions: number[],
  threshold: number
): number | null {
  let closestIdx: number | null = null;
  let minDist = Infinity;
  for (let i = 0; i < dividerPositions.length; i++) {
    const dist = Math.abs(cursorX - dividerPositions[i]);
    if (dist < minDist) {
      minDist = dist;
      closestIdx = i;
    }
  }
  return minDist <= threshold ? closestIdx : null;
}

/**
 * Find the insert-at index for a drag-and-drop operation.
 *
 * Uses divider positions to locate the exact insertion point when the cursor
 * is near a divider, falling back to a binary choice (left/right half of the
 * container) when far from any divider.
 *
 * This is the single source of truth for drop target calculation, ensuring
 * the drop position matches the drag-over hint line.
 */
export function findInsertIndex(
  cursorX: number,
  containerLeft: number,
  imageWidths: number[],
  gap: number,
  threshold: number
): number {
  const positions = computeDividerXPositions(containerLeft, imageWidths, gap);
  const closestIdx = findClosestDividerIndex(cursorX, positions, threshold);
  if (closestIdx !== null) return closestIdx;

  const totalWidth = imageWidths.reduce((s, w) => s + w, 0) + (imageWidths.length - 1) * gap;
  return cursorX < containerLeft + totalWidth / 2 ? 0 : imageWidths.length;
}
