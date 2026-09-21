import { ImageMeta } from "../imageParse/imageDetector";
import { SingleImageSizeMode, SINGLE_IMAGE_MIN_WIDTH } from "../constants";
import { quarterTurnFitScale, type OrientationState } from "../imageTransform/orientation";

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
  /** Per-member height as the row paints it — what the row's container has to
   *  hold, and the figure every equality is judged on.  A quarter-turned member
   *  paints its box on its side, scaled down to fit back inside it, so its drawn
   *  height is the box's own width times that fit scale and this is not `boxes`;
   *  it never exceeds the upright member's drawn height, so the row cannot grow. */
  heights: number[];
  /** Per-member layout-box height: the un-rotated bitmap's box, which is what
   *  the <img> is sized to.  Equal to `heights` for every even orientation. */
  boxes: number[];
  maxH: number;
}

/**
 * The coefficient `c` with `drawnHeight = c × itemWidth` for a member.
 *
 * Normally `fill / aspect`: `fill` is the layout box over the slot
 * (`boxW = fill × slotW`), and the width the picture actually paints is that box
 * folded by the turn — the box itself upright or mirrored, `boxW × k / a` at a
 * quarter turn — so the height follows from the bitmap's own ratio.  A quarter
 * turn keeps the bitmap's ratio — the turned rectangle is the upright one on its
 * side — and scales it down (`quarterTurnFitScale`) so it fits inside the very
 * rectangle it came from: `fill / aspect` for a landscape, which keeps its
 * height and narrows, and `fill × aspect` for a portrait, which keeps its width
 * and shortens.  The box is never widened past its slot and the picture is never
 * enlarged or clipped, so the row can only ever get shorter.
 *
 * This is the one place the drawn frame is defined; every model entry point
 * that has to agree on "equal heights" derives from it.
 */
export function drawnHeightCoefficient(
  meta: ImageMeta,
  fill: number,
  orientation: OrientationState | null | undefined
): number {
  const ar = meta.naturalWidth / meta.naturalHeight;
  const a = ar > 0 && Number.isFinite(ar) ? ar : 1;
  const turned = orientation != null && orientation.turns % 2 === 1;
  return turned ? fill * quarterTurnFitScale(a) : fill / a;
}

/**
 * The fill to write back after turning a member from `from` to `to`, given the
 * fill it was drawn with before the turn.
 *
 * A turn may not change the member's container, so the drawn height it had
 * before is the drawn height it keeps.  Per unit slot width that is
 * `drawnHeightCoefficient(meta, fill, from)`, so the fill that reproduces it in
 * the new orientation is that number over the coefficient at fill 1:
 *
 *     fill' = c(fill, from) / c(1, to)
 *
 * Clamped to 1: the whole reason a turn needs a write at all is that a member's
 * box can come out narrower than its slot (a turned portrait keeps its width and
 * shortens), and that is exactly what fill records — but the reverse (a box
 * needing to be *wider* than its slot, e.g. an upright portrait asked to lie
 * down needs `fill = 1 / aspect² > 1`) is not representable, and the turn is the
 * only gesture allowed to make the member shorter.
 */
export function fillForTurn(
  meta: ImageMeta,
  fill: number,
  from: OrientationState | null | undefined,
  to: OrientationState | null | undefined
): number {
  const perFill = drawnHeightCoefficient(meta, 1, to);
  if (!(perFill > 0) || !Number.isFinite(perFill)) return fill;
  return Math.min(1, drawnHeightCoefficient(meta, fill, from) / perFill);
}

/** The coefficient for a member, or null when it has no fill of its own (it
 *  then renders the row fallback rather than a height its grow can steer). */
function memberCoefficient(
  meta: ImageMeta | undefined,
  fill: number | null,
  orientation: OrientationState | null | undefined
): number | null {
  if (!meta || !(meta.naturalWidth > 0) || !(meta.naturalHeight > 0)) return null;
  if (fill == null || !(fill > 0) || fill > 1 || !Number.isFinite(fill)) return null;
  return drawnHeightCoefficient(meta, fill, orientation);
}

/**
 * Compute per-image heights from persisted scale ratios.
 * `scale = imageContentWidth / itemWidth` — a dimensionless ratio that survives
 * container-width changes.  For each image with a valid scale (0 < scale ≤ 1)
 * the height is `round(scale * itemW / aspectRatio)` — a per-image height, so a
 * full-width image (scale = 1) keeps its own `itemW / aspectRatio` instead of
 * the row max.  The *box* is always this — a quarter turn does not move it, it
 * only paints the box on its side, scaled down to fit back inside itself, and
 * `heights` (the figure the row is laid out on) reports that.  Images without a
 * valid scale fall back to the uniform `computeRowHeight` value.  Pure — no DOM.
 */
export function computeScaleBasedHeights(
  flexGrows: number[],
  metas: ImageMeta[],
  scales: Array<number | null>,
  containerWidth: number,
  gap: number,
  defaultRowHeight: number,
  orientations: ReadonlyArray<OrientationState | null> = []
): ScaleBasedHeightsResult {
  return scaleBasedHeights(
    flexGrows, metas, scales, containerWidth, gap, defaultRowHeight, true, orientations
  );
}

/**
 * The scale-based model without the per-image rounding — the frame a *search*
 * over shares reads, and the tie-break between two grid points that paint the
 * same heights.
 *
 * Rounded per-image heights are a staircase: every point inside a band reports
 * the same spread, so a search over them cannot tell a near-miss from an exact
 * hit, and two members can end up a pixel apart while looking "equalised".  The
 * continuous figure is monotone, so it orders the band from the inside.
 * Painting always uses the rounded figures — see `computeScaleBasedHeights`.
 */
export function computeScaleBasedHeightsContinuous(
  flexGrows: number[],
  metas: ImageMeta[],
  scales: Array<number | null>,
  containerWidth: number,
  gap: number,
  defaultRowHeight: number,
  orientations: ReadonlyArray<OrientationState | null> = []
): ScaleBasedHeightsResult {
  return scaleBasedHeights(
    flexGrows, metas, scales, containerWidth, gap, defaultRowHeight, false, orientations
  );
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
  round: boolean,
  orientations: ReadonlyArray<OrientationState | null> = []
): ScaleBasedHeightsResult {
  const n = flexGrows.length;
  const fallback = computeRowHeight(flexGrows, metas, containerWidth, gap, defaultRowHeight);
  let totalG = 0;
  for (let i = 0; i < n; i++) totalG += flexGrows[i];
  const availableWidth = containerWidth - (n - 1) * gap;

  const heights: number[] = [];
  const boxes: number[] = [];
  let maxH = 0;
  for (let i = 0; i < n; i++) {
    const scale = scales[i];
    const meta = metas[i];
    const coef = memberCoefficient(meta, scale, orientations[i]);
    if (coef != null && totalG > 0 && meta) {
      const itemW = (flexGrows[i] / totalG) * availableWidth;
      // The <img> keeps the un-rotated box (it holds the un-rotated bitmap);
      // the row is laid out on what the box *paints*.
      let boxH = (scale! * itemW) / (meta.naturalWidth / meta.naturalHeight);
      if (round) boxH = Math.round(boxH);
      let drawnH = coef * itemW;
      if (round) drawnH = Math.round(drawnH);
      boxes.push(boxH);
      heights.push(drawnH);
      if (drawnH > maxH) maxH = drawnH;
    } else {
      boxes.push(fallback);
      heights.push(fallback);
      if (fallback > maxH) maxH = fallback;
    }
  }
  return { heights, boxes, maxH };
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

/** The weight a member takes in an equal-height split when its fill is unknown:
 *  `1 / coefficient` at fill 1, exactly the weighting `computeGlobalEquilibrium`
 *  applies — `aspect` while upright, and the same `aspect` for a turned
 *  landscape, `1 / aspect` for a turned portrait.  Returns null when the meta
 *  has no usable aspect. */
function dividerWeight(
  meta: ImageMeta,
  orientation: OrientationState | null | undefined
): number | null {
  const coef = drawnHeightCoefficient(meta, 1, orientation);
  if (!Number.isFinite(coef) || !(coef > 0)) return null;
  return 1 / coef;
}

/**
 * Compute equilibrium flex-grow values for two adjacent images
 * so they render at the same height.
 *
 * This is the aspect-only fallback for a divider whose pair the scale-based
 * solve (`computePairEquilibrium`) cannot take — it weighs each side by the
 * model's no-fill coefficient so a quarter-turned member is placed by what it
 * now paints, not by the bitmap's un-rotated ratio.  Pure — no DOM.
 */
export function computeDividerEquilibrium(
  leftMeta: ImageMeta,
  rightMeta: ImageMeta,
  totalFlex: number,
  orientations: ReadonlyArray<OrientationState | null> = []
): { left: number; right: number } {
  const lw = dividerWeight(leftMeta, orientations[0]);
  const rw = dividerWeight(rightMeta, orientations[1]);
  if (lw == null || rw == null || lw + rw === 0) {
    return { left: totalFlex / 2, right: totalFlex / 2 };
  }
  const snapLeft = totalFlex * lw / (lw + rw);
  return { left: snapLeft, right: totalFlex - snapLeft };
}

/** The lowest flex-grow the divider drag lets either side take. */
export const DIVIDER_MIN_GROW = 0.1;
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
  leftIndex: number,
  orientations: ReadonlyArray<OrientationState | null> = []
): { left: number; right: number } {
  const { heights } = computeScaleBasedHeights(
    grows,
    metas,
    scales,
    containerWidth,
    gap,
    defaultRowHeight,
    orientations
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
 * A member's drawn height is `coefficient × grow` (see
 * `drawnHeightCoefficient`), so equal heights ask for a split in the
 * reciprocals of those coefficients — `aspect / fill` while upright (the same
 * thing as `aspect` only while the two fills agree), and `1 / (fill × aspect)`
 * for a turned portrait, whose drawing is the one a turn shrinks short.  The
 * pair's grow sum is held
 * constant (a divider only
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
  leftIndex: number,
  orientations: ReadonlyArray<OrientationState | null> = []
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
      false,
      orientations
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
 * A member's drawn height is `coefficient × grow`, so equal heights ask for
 * weights in `1 / coefficient` — `aspect / fill` while the member is upright
 * (unchanged by a turn on a landscape, which keeps its height), and
 * `1 / (fill × aspect)` for a turned portrait (see `drawnHeightCoefficient`).
 * Passing
 * `scales` (the members' fill ratios,
 * `null` where none is persisted) applies that; omitting it keeps the
 * aspect-only distribution, which is the same answer while every fill agrees.
 * A member with no fill of its own renders the row fallback rather than a height
 * of its own choosing, so it cannot be made to match — it keeps its aspect
 * weight and the filled members share what is left.
 */
export function computeGlobalEquilibrium(
  metas: ImageMeta[],
  totalGrow: number,
  scales?: Array<number | null>,
  orientations: ReadonlyArray<OrientationState | null> = []
): number[] {
  if (metas.length === 0) return [];
  const weights = metas.map((m, i) => {
    const ar = m.naturalWidth / m.naturalHeight;
    const coef = memberCoefficient(m, scales?.[i] ?? null, orientations[i]);
    // Equal *drawn* heights ask for weights in 1/coefficient — the same answer
    // as the aspect weights while every member is upright.
    return coef != null && coef > 0 ? 1 / coef : ar;
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
