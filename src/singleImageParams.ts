// ── Single-image markdown params ─────────────────────────────────────────
// A single-image row is persisted as `![[file|S|W]]`:
//   S = a 0/1 flag: 0 = follows the size setting, 1 = manually resized.
//   W = the image's pixel width (item container width == image width).
// The order is S-then-W (swapped vs the multi-image `|W|S`) so Obsidian's native
// reading-mode renderer, which uses the LAST numeric param as the width, renders
// the image at W instead of collapsing to the flag's 0/1 as a height.
//
// Internally we keep the convention flexGrow = W/100 and scale = S/100 (0 → 0.0,
// 1 → 0.01).  `normalizeSingleImageParams` re-maps the swapped markdown parse
// back to that convention so downstream widget/persist code stays unchanged.

import type { ImageGroup } from "./imageDetector";

/** True when the stored scale encodes the single-image manual flag S=1. */
export function isSingleImageManual(scale: number | null): boolean {
  return scale != null && Math.round(scale * 100) === 1;
}

/** Encode the manual flag as a scale value for storage on ImageEmbed.scale. */
export function singleImageScaleFor(manual: boolean): number {
  return manual ? 0.01 : 0;
}

/**
 * Rewrite an image embed line to the single-image `![[file|S|W]]` form.
 * Strips any existing params (|width, |WxH, |W|S, |S|W) then appends |S|W.
 */
export function formatSingleImageLine(
  raw: string,
  widthPx: number,
  sFlag: 0 | 1
): string {
  const w = Math.max(1, Math.round(widthPx));
  const out = raw.replace(/\|[^\]]*(?=\]\])/, "");
  return out.replace(/\]\]/, `|${sFlag}|${w}]]`);
}

/**
 * Re-map a single-image group's params from the swapped markdown form `|S|W`
 * to the internal convention (flexGrow = W/100, scale = S/100, explicitWidth = W).
 * No-op for multi-image groups (they keep `|W|S`).  Mutates the group in place.
 */
export function normalizeSingleImageParams(group: ImageGroup): void {
  if (group.images.length !== 1) return;
  const img = group.images[0];
  const m = img.raw.match(/\|([^\]]*)\]\]/);
  const parts = m ? m[1].split("|") : [];
  const s = parts.length >= 2 ? parseInt(parts[0], 10) : NaN;
  if (parts.length >= 2 && (s === 0 || s === 1)) {
    // Our single-image `|S|W` form (S is a 0/1 flag). W is the real pixel width.
    const w = parseInt(parts[1], 10);
    img.explicitWidth = isFinite(w) ? w : null;
    img.hasExplicitWidth = img.explicitWidth != null;
    img.flexGrow = img.explicitWidth != null && img.explicitWidth > 0 ? img.explicitWidth / 100 : 1;
    img.scale = s === 1 ? 0.01 : 0;
  } else {
    // Anything else on a single-image line — a bare `![[file]]`, a legacy single
    // `|W`, or a multi-image leftover `|W|S` (first param ≥ 2, i.e. a weight, not
    // a single flag) that just became single — has no manual single size yet.
    // Reset to setting-driven; layoutSingleImage will materialize `|0|W`.
    img.explicitWidth = null;
    img.hasExplicitWidth = false;
    img.flexGrow = 1;
    img.scale = null;
  }
}
