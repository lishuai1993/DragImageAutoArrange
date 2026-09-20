// Type-only: the sizing grid below is read by the parse/serialise boundary, so
// this module must not pull the parser in at runtime (it would close a cycle).
import type { ImageMeta } from "../imageParse/imageDetector";
import { computeFlexGrows } from "./layoutEngine";

/**
 * Ensure a flexGrow value is in the safe range [0.1, 10000].
 * NaN / Infinity / negative / zero → return a safe default (1).
 */
export function clampFlexGrow(value: number): number {
  if (!isFinite(value) || value < 0.1) return 1;
  if (value > 10000) return 10000;
  return value;
}

/**
 * Ensure a scale value is in the safe range [0, 1].
 * NaN / Infinity / negative → return 1 (fill item at uniform height).
 */
export function clampScale(value: number): number {
  if (!isFinite(value) || value <= 0) return 1;
  if (value > 1) return 1;
  return value;
}

/** The grid the row grammar persists sizing on: both a member's share and its
 *  fill are written as integer hundredths (`|share码|fill码|`). */
export const SIZING_STEP = 100;

/** A share or fill as the integer hundredths the grammar carries. */
export function sizingCode(value: number): number {
  return Math.round(value * SIZING_STEP);
}

/**
 * A share or fill rounded onto the persisted grid.
 *
 * Every write into the model goes through this, so the geometry a row paints and
 * the geometry its file records are the same numbers.  A solve that lands off the
 * grid would otherwise paint the continuous value and persist the rounded one —
 * the row would then re-render a pixel off after every rebuild, and Reading Mode,
 * which only ever sees the file, off the same amount.
 */
export function quantizeSizing(value: number): number {
  return sizingCode(value) / SIZING_STEP;
}

/**
 * Validate an entire row's flexGrow array.
 * Any invalid entry is replaced with a value recomputed from natural aspect ratios.
 * Returns a new safe array (does not mutate the input).
 */
export function validateRowFlexGrows(
  grows: number[],
  metas: ImageMeta[],
  containerWidth: number,
  gap: number
): number[] {
  const n = grows.length;
  if (n === 0) return [];

  // Compute fallback grows from natural aspect ratios
  let fallbackGrows: number[] | null = null;
  const getFallback = () => {
    if (!fallbackGrows) {
      fallbackGrows = computeFlexGrows(metas);
    }
    return fallbackGrows;
  };

  const result: number[] = [];
  for (let i = 0; i < n; i++) {
    const g = grows[i];
    if (!isFinite(g) || g < 0.1) {
      const fb = getFallback();
      result.push(fb[i] ?? 1);
    } else {
      result.push(g > 10000 ? 10000 : g);
    }
  }
  return result;
}

