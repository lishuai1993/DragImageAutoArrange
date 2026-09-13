/**
 * Minimal single-range change turning `before` into `after`: the longest common
 * prefix and suffix are trimmed away, so an edit touching one spot in a long
 * note becomes one small range instead of a whole-document replacement. Feeding
 * CodeMirror a small range is what keeps the viewport anchored — a full-document
 * replace resets the scroll position to the top.
 *
 * Returns null when the texts are identical.
 */
export function minimalTextChange(
  before: string,
  after: string
): { from: number; to: number; insert: string } | null {
  if (before === after) return null;

  const maxPrefix = Math.min(before.length, after.length);
  let start = 0;
  while (start < maxPrefix && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;

  const maxSuffix = Math.min(before.length - start, after.length - start);
  let end = 0;
  while (
    end < maxSuffix &&
    before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)
  ) {
    end += 1;
  }

  return {
    from: start,
    to: before.length - end,
    insert: after.slice(start, after.length - end),
  };
}

/**
 * Offset at which the 0-based `line` of `text` begins — for `line` 0 that is 0,
 * for every later line it is the character right after the preceding newline.
 * A line past the end reports the text length, so callers can subtract one and
 * land on the last line's end.
 */
export function lineStartOffset(text: string, line: number): number {
  let offset = 0;
  for (let i = 0; i < line; i += 1) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  return offset;
}
