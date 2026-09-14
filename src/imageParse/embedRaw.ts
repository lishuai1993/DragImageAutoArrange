// ── Image-embed raw-line string transforms ─────────────────────────────
// Small, pure string helpers over the `![[file|params...]]` embed line text.
// Centralizing the fragile pipe-param regexes keeps live-preview, reading-mode,
// single-image and widget code in lock-step if the persisted embed format ever
// changes. No DOM / Obsidian deps — unit-testable in isolation.

import { isOrientationWord } from "../imageTransform/orientation";

/** Strip every pipe param from an embed line, returning the bare `![[file]]`.
 *  Removes the run between the first `|` and the closing `]]` (handles |width,
 *  |WxH, |W|S, |alignment|S|W, etc.). Idempotent on an already-bare line. */
export function stripEmbedParams(raw: string): string {
  return raw.replace(/\|[^\]]*(?=\]\])/, "");
}

/** Strip every pipe param *except* a leading orientation word. Sizing params
 *  (share / fill / S / W) and the alignment word describe a row the image is
 *  leaving, so they go; the orientation describes the image itself, so it
 *  survives the departure — multi member → standalone and reference removal
 *  both run through here. Falls back to `stripEmbedParams` when the line
 *  carries no orientation word. Idempotent. */
export function stripSizingKeepOrientation(raw: string): string {
  const first = embedParamString(raw).split("|", 1)[0];
  if (!isOrientationWord(first)) return stripEmbedParams(raw);
  return raw.replace(/\|[^\]]*(?=\]\])/, `|${first}`);
}

/** The raw `|`-joined param section of an embed line, or '' when it carries
 *  none. The single place that knows how to delimit the param run. */
export function embedParamString(raw: string): string {
  const m = raw.match(/\|([^\]]*)\]\]/);
  return m ? m[1] : "";
}

/** Split an embed line's pipe params into their string parts, or null when the
 *  line carries no `|params` section (a bare `![[file]]`).
 *  `![[a|W|S]]` → ["W","S"]; `![[a]]` → null; `![[a|]]` → [""]. */
export function parseEmbedParams(raw: string): string[] | null {
  const m = raw.match(/\|([^\]]*)\]\]/);
  return m ? m[1].split("|") : null;
}
