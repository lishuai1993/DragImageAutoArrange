// ── Pure viewport-anchor classification (no DOM / Obsidian deps) ──────
// Keeps the "which content unit is under the viewport center" decision
// unit-testable, separate from the pixel geometry that lives in
// scrollAnchor.ts. See tests/viewportAnchor.test.ts.

export type ImageRowIndex = {
  index: number;       // global sequential number, 1-based (image rows only)
  startLine: number;   // first source line of this image row (1-based)
  endLine: number;     // last source line of this image row (1-based)
};

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
  centerLine: number
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
