import { ImageMeta } from "./imageDetector";
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

