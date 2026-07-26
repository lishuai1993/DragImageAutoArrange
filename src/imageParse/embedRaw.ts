// ── Image-embed raw-line string transforms ─────────────────────────────
// Small, pure string helpers over the `![[file|params...]]` embed line text.
// Centralizing the fragile pipe-param regexes keeps live-preview, reading-mode,
// single-image and widget code in lock-step if the persisted embed format ever
// changes. No DOM / Obsidian deps — unit-testable in isolation.

/** Strip every pipe param from an embed line, returning the bare `![[file]]`.
 *  Removes the run between the first `|` and the closing `]]` (handles |width,
 *  |WxH, |W|S, |alignment|S|W, etc.). Idempotent on an already-bare line. */
export function stripEmbedParams(raw: string): string {
  return raw.replace(/\|[^\]]*(?=\]\])/, "");
}

/** Split an embed line's pipe params into their string parts, or null when the
 *  line carries no `|params` section (a bare `![[file]]`).
 *  `![[a|W|S]]` → ["W","S"]; `![[a]]` → null; `![[a|]]` → [""]. */
export function parseEmbedParams(raw: string): string[] | null {
  const m = raw.match(/\|([^\]]*)\]\]/);
  return m ? m[1].split("|") : null;
}
