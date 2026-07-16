// ── Pure viewport-anchor classification (no DOM / Obsidian deps) ──────
// Keeps the "which content unit is under the viewport center" decision
// unit-testable, separate from the pixel geometry that lives in
// scrollAnchor.ts. See tests/viewportAnchor.test.ts.

import { logger } from "../logger";

// ── Branded 1-based line number ─────────────────────────────────────
// A plain `number` line can be 0-based (array index) or 1-based (source
// line / CodeMirror `.number`). Mixing the two silently froze RM anchoring
// once (off-by-one). `Line1` makes "1-based source line" a distinct
// compile-time type: passing a raw 0-based index where a Line1 is expected
// is now a type error. The ONLY ways to mint a Line1:
//   - toLine1(zeroBased): the single 0→1 conversion boundary (RM writer).
//   - asLine1(oneBased):  trust an already-1-based source (CM `.number`,
//                         parseInt of a data-diaa-line attribute).
export type Line1 = number & { readonly __line1: unique symbol };

/** Convert a 0-based line index to a 1-based Line1. The ONLY 0→1 boundary. */
export function toLine1(zeroBased: number): Line1 {
  return (zeroBased + 1) as Line1;
}

/** Brand an already-1-based number as Line1 (trusts the caller / source). */
export function asLine1(oneBased: number): Line1 {
  return oneBased as Line1;
}

export type ImageRowIndex = {
  index: number;       // global sequential number, 1-based (image rows only)
  startLine: Line1;    // first source line of this image row (1-based)
  endLine: Line1;      // last source line of this image row (1-based)
};

// ── Image row indexing ──────────────────────────────────────────────

export function buildImageRowIndex(lines: string[], imgRe: RegExp): ImageRowIndex[] {
  // CONTRACT: startLine/endLine are 1-based source line numbers (Line1). Every
  // reader (imgIndexToSelector, captureImageRowRM, the data-diaa-line queries)
  // relies on this, and readingMode.ts must write data-diaa-line in the SAME
  // 1-based space (via toLine1). Do not switch this to 0-based without updating
  // the writer in lockstep.
  const result: ImageRowIndex[] = [];
  let idx = 0;
  let inRow = false;
  let startLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const isImg = imgRe.test(lines[i]);
    if (isImg && !inRow) {
      inRow = true;
      startLine = i + 1;
    } else if (!isImg && inRow) {
      idx++;
      result.push({ index: idx, startLine: asLine1(startLine), endLine: asLine1(i) });
      inRow = false;
    }
  }
  if (inRow) {
    idx++;
    result.push({ index: idx, startLine: asLine1(startLine), endLine: asLine1(lines.length) });
  }

  assertImageRowIndexInvariants(result, lines.length);
  return result;
}

/** Runtime self-check on buildImageRowIndex output. The index feeds every
 *  cross-mode anchor query; a broken invariant (0-based, overlapping, or
 *  non-monotonic ranges) silently corrupts scroll restore, so surface it as a
 *  WARN in log.txt rather than failing invisibly. Invariants:
 *  index contiguous & 1-based · startLine ≥ 1 · endLine ≥ startLine ·
 *  strictly increasing / non-overlapping · endLine ≤ lineCount. */
function assertImageRowIndexInvariants(rows: ImageRowIndex[], lineCount: number): void {
  let prevEnd = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const bad =
      r.index !== i + 1 ||
      r.startLine < 1 ||
      r.endLine < r.startLine ||
      r.startLine <= prevEnd ||
      r.endLine > lineCount;
    if (bad) {
      logger.warn("buildImageRowIndex invariant violated", {
        at: i,
        row: `${r.index}:${r.startLine}-${r.endLine}`,
        prevEnd,
        lineCount,
        rows: rows.map((x) => `${x.index}:${x.startLine}-${x.endLine}`),
      });
      return;
    }
    prevEnd = r.endLine;
  }
}

export type CenterClass =
  // The viewport center sits inside an image row.
  | { kind: "image-row"; imageRowIndex: number }
  // The center sits in a blank gap bracketed by image rows (0 = boundary /
  // non-image neighbor on that side → single-sided gap).
  | { kind: "image-gap"; imgBefore: number; imgAfter: number }
  // Neither: no usable image anchor (e.g. bracketed by text on both sides).
  | { kind: "none" };

/**
 * Classify the source line under the viewport center for Strategy B
 * (image-only viewport). Text viewports are handled earlier by Strategy A,
 * so this only runs when no visible text is present.
 *
 * Accessors are 1-based and only queried across the blank run around the
 * center, so this stays cheap even on large documents (no full-doc scan).
 */
export function classifyCenter(
  lineCount: number,
  isBlank: (line: number) => boolean,
  isImage: (line: number) => boolean,
  imgIndex: ImageRowIndex[],
  centerLine: Line1
): CenterClass {
  const inRow = imgIndex.find(
    (r) => centerLine >= r.startLine && centerLine <= r.endLine
  );
  if (inRow) return { kind: "image-row", imageRowIndex: inRow.index };

  // Scan outward over blank lines to the first non-blank on each side.
  let up = centerLine - 1;
  while (up >= 1 && isBlank(up)) up--;
  let down = centerLine + 1;
  while (down <= lineCount && isBlank(down)) down++;

  // A side only counts as a gap boundary when its nearest non-blank is an
  // image row. A text neighbor (necessarily off-screen, since the viewport
  // has no visible text) leaves that side at 0 → single-sided degrade.
  const upRow =
    up >= 1 && isImage(up)
      ? imgIndex.find((r) => up >= r.startLine && up <= r.endLine)
      : undefined;
  const downRow =
    down <= lineCount && isImage(down)
      ? imgIndex.find((r) => down >= r.startLine && down <= r.endLine)
      : undefined;

  if (upRow && downRow) {
    return { kind: "image-gap", imgBefore: upRow.index, imgAfter: downRow.index };
  }
  if (upRow) return { kind: "image-gap", imgBefore: upRow.index, imgAfter: 0 };
  if (downRow) return { kind: "image-gap", imgBefore: 0, imgAfter: downRow.index };
  return { kind: "none" };
}
