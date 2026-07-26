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

/** Minimal shape of an Obsidian preview-renderer height-ledger entry
 *  (renderer.sections). Line numbers are 0-based, matching getSectionInfo. */
export interface LedgerSection {
  lineStart: number;
  lineEnd: number;
  height: number;
}

/** Cumulative ledger Y (document-space top offset) for a 0-based source line:
 *  the sum of section heights above the section containing the line. A line in
 *  a blank gap between sections parks at the next section's top. Returns -1
 *  when the line is past the last section or the ledger shape is unusable. */
export function ledgerYForLine(sections: LedgerSection[], line0: number): number {
  if (line0 < 0) return -1;
  let y = 0;
  for (const s of sections) {
    if (typeof s?.height !== "number") return -1;
    if (typeof s?.lineEnd === "number" && line0 <= s.lineEnd) return y;
    y += s.height > 0 ? s.height : 0;
  }
  return -1;
}

/** Estimate a 1-based line's document Y from bare section heights (no lineStart /
 *  lineEnd on individual entries) by guessing which section index the line falls
 *  in and summing the heights of preceding sections. Uses real measured heights
 *  from a fully-rendered warmup snapshot, so it naturally tracks large image
 *  sections — better than the flat line-ratio * totalHeight approximation. */
export function sectionIndexEstimateY(
  heights: number[], totalLines: number, line1: number,
): number {
  if (heights.length === 0 || totalLines <= 0 || line1 <= 0) return -1;
  const line0 = line1 - 1;
  const idx = Math.min(
    Math.max(0, Math.floor((line0 / totalLines) * heights.length)),
    heights.length - 1,
  );
  let y = 0;
  for (let i = 0; i < idx; i++) {
    y += heights[i] > 0 ? heights[i] : 0;
  }
  return y;
}

/** Reverse of ledgerYForLine: map a document-space Y (pixels from content top)
 *  to the approximate 1-based line whose section-top falls at or below Y.
 *  Within a section, line number is linearly interpolated from the height ratio.
 *  Returns -1 when Y is past the last section or sections are unusable. */
export function ledgerLineForY(sections: LedgerSection[], y: number): number {
  if (y < 0 || sections.length === 0) return -1;
  let accumulatedY = 0;
  for (const s of sections) {
    if (typeof s?.height !== "number") return -1;
    if (typeof s?.lineEnd === "number" && typeof s?.lineStart === "number") {
      if (y < accumulatedY + s.height) {
        const lineSpan = s.lineEnd - s.lineStart + 1;
        if (lineSpan <= 0) return s.lineStart + 1; // 1-based
        const ratio = Math.max(0, Math.min(1, (y - accumulatedY) / s.height));
        return s.lineStart + Math.floor(ratio * lineSpan) + 1; // convert 0-based → 1-based
      }
    }
    accumulatedY += s.height > 0 ? s.height : 0;
  }
  return -1;
}

/** Linear extrapolation for a 1-based line that falls beyond all known
 *  sections. Distributes the remaining document height (docH − totalLedgerH)
 *  proportionally across the remaining lines (totalLines − lastLineEnd).
 *  Returns -1 when any input is unusable. */
export function extrapolateLedgerY(
  sections: LedgerSection[], line1: number, totalLines: number, docH: number,
): number {
  const totalH = ledgerTotalHeight(sections);
  if (totalH <= 0 || totalLines <= 0 || docH <= 0 || line1 <= 0) return -1;
  let lastLineEnd = 0;
  for (const s of sections) {
    if (typeof s.lineEnd === "number" && s.lineEnd > lastLineEnd) {
      lastLineEnd = s.lineEnd;
    }
  }
  if (lastLineEnd <= 0 || lastLineEnd >= totalLines) return -1;
  const remainingLines = totalLines - lastLineEnd;
  const offset = line1 - lastLineEnd;
  if (offset <= 0) return -1; // within section range — caller should use ledgerYForLine
  const remainingH = Math.max(0, docH - totalH);
  return totalH + (offset / remainingLines) * remainingH;
}

/** Total ledger height (sum of section heights). -1 on unusable shape. Used to
 *  sanity-check the ledger against the live scrollHeight before trusting it. */
export function ledgerTotalHeight(sections: LedgerSection[]): number {
  let y = 0;
  for (const s of sections) {
    if (typeof s?.height !== "number") return -1;
    y += s.height > 0 ? s.height : 0;
  }
  return y;
}

// ── Scroller ↔ document-space conversions ──────────────────────────────
// Thin, named wrappers over the pixel/ratio arithmetic that was previously
// inlined at ~10 call sites in scrollAnchor.ts. Keeping them here makes the
// coordinate model explicit and unit-testable; the DOM side only supplies the
// measured numbers (rect tops, scrollTop/scrollHeight/clientHeight).

/** Document-space Y (pixels from content top) for an element, given the
 *  element's viewport-space top, the scroller's viewport-space top, and the
 *  scroller's current scrollTop. This is the RM preview coordinate model:
 *  `elTop - scrollerTop + scrollTop`. */
export function clientTopToDocY(elTop: number, scrollerTop: number, scrollTop: number): number {
  return elTop - scrollerTop + scrollTop;
}

/** Fraction (0..1) of the scroll range currently scrolled. Returns 0 when there
 *  is no scrollable range (scrollHeight <= clientHeight). Callers guard the
 *  degenerate clientHeight===0 case separately (they return -1 there). */
export function scrollTopToPct(scrollTop: number, scrollHeight: number, clientHeight: number): number {
  const maxScroll = scrollHeight - clientHeight;
  return maxScroll > 0 ? scrollTop / maxScroll : 0;
}

/** scrollTop that reproduces a scroll fraction (0..1). Inverse of
 *  scrollTopToPct within the scrollable range. */
export function pctToScrollTop(pct: number, scrollHeight: number, clientHeight: number): number {
  return pct * (scrollHeight - clientHeight);
}
