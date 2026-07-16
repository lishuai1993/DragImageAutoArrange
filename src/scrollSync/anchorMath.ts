// ── Pure scroll-anchor geometry (no DOM / Obsidian deps) ─────────────
// The pixel math for capturing a viewport-center ratio and turning a stored
// anchor back into a scrollTop. Extracted from scrollAnchor.ts so the
// arithmetic is unit-testable in isolation; the DOM adapter there only
// measures geometry and reads/writes scrollTop.
//
// Ratio functions return the RAW (unclamped) value on purpose: the caller
// compares raw against clamp01(raw) to detect out-of-[0,1] geometry (a sign
// the measured layout drifted) and log it, while still using the clamped
// value. Keeping clamping out of the pure layer preserves that signal.

/** Clamp to [0, 1]. */
export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Intra-row center ratio (0 = row top, 1 = row bottom). RAW / unclamped.
 *  Falls back to 0.5 when the row has no measurable height. */
export function intraRowRatio(centerScreen: number, rowTop: number, rowH: number): number {
  if (rowH <= 0) return 0.5;
  return (centerScreen - rowTop) / rowH;
}

/** Center ratio within a blank gap (0 = flush against the upper row's bottom,
 *  1 = flush against the lower row's top). RAW / unclamped. Falls back to 0.5
 *  when the gap has no measurable span. */
export function gapRatioFromGeom(centerScreen: number, upBottom: number, downTop: number): number {
  const span = downTop - upBottom;
  if (span <= 0) return 0.5;
  return (centerScreen - upBottom) / span;
}

/** scrollTop that places the row's `ratio` point at the viewport vertical
 *  center. `inset` converts block coords to on-screen coords (RM passes 0). */
export function imageRowTargetY(
  rowTop: number, rowH: number, ratio: number, inset: number, clientH: number
): number {
  return Math.max(0, rowTop + inset + rowH * ratio - clientH / 2);
}

/** The gap "junction" line the center should sit on. Returns null when neither
 *  side is present (unrestorable). Single-sided collapses to that side's edge:
 *  upper row's bottom or lower row's top. */
export function gapJunction(
  upBottom: number | null, downTop: number | null, gapRatio: number
): number | null {
  if (upBottom != null && downTop != null) return upBottom + gapRatio * (downTop - upBottom);
  if (upBottom != null) return upBottom;
  if (downTop != null) return downTop;
  return null;
}

/** scrollTop that places a gap junction at the viewport vertical center. */
export function gapTargetY(junction: number, inset: number, clientH: number): number {
  return Math.max(0, junction + inset - clientH / 2);
}

/** scrollTop that reproduces a text line's captured distance from the viewport
 *  top. `inset` converts block coords to on-screen coords (RM passes 0). */
export function textTargetY(lineTop: number, inset: number, anchorOffset: number): number {
  return Math.max(0, lineTop + inset - anchorOffset);
}

/** Index of the element in `keys` closest to `target` (ties keep the earlier).
 *  Returns -1 for an empty array. Used to disambiguate multiple text-anchor
 *  matches by a position key (line number, pixel top, or doc ratio). */
export function nearestIndexBy(keys: number[], target: number): number {
  let bestIdx = -1, bestDist = Infinity;
  for (let i = 0; i < keys.length; i++) {
    const d = Math.abs(keys[i] - target);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  return bestIdx;
}
