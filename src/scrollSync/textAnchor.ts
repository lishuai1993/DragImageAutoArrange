// ── Pure text-anchor normalization (no DOM / Obsidian deps) ──────────
// The text-based scroll anchor captures the top-of-viewport line's text in one
// mode and searches for it in the other. But LP reads the raw *source* line
// (markdown syntax intact) while RM reads the *rendered* textContent (syntax
// already stripped by Obsidian). A heading like "## Notes" is "## Notes" in LP
// but "Notes" in RM, so a literal substring match misses. normalizeAnchorText
// collapses both sides into the same rendered-plain space.
//
// Correctness note: the two capture/restore sides run this SAME function, so
// the transform only has to be *symmetric*, not a faithful markdown renderer.
// If a rule over-strips (e.g. intraword underscores), both sides strip
// identically and still converge — the substring match is preserved.

// Leading block-level markers, stripped repeatedly so nested prefixes like
// "> - [ ] task" peel off one layer at a time: blockquote chains, ATX
// headings, list bullets, ordered-list numbers, and task checkboxes.
const BLOCK_PREFIX =
  /^\s*(?:>\s?|#{1,6}\s+|[-*+]\s+|\d+\.\s+|\[[ xX]\]\s+)/;

/** Normalize a markdown source line (or rendered textContent) into the
 *  rendered-plain text space used for cross-mode anchor matching. Returns "" for
 *  a line that is nothing but markers (callers skip empty results). */
export function normalizeAnchorText(sourceLine: string): string {
  let s = sourceLine;

  // 1. Peel leading block markers until none remain.
  while (BLOCK_PREFIX.test(s)) s = s.replace(BLOCK_PREFIX, "");

  // 2. Wikilinks (incl. "![[...]]" embeds): "[[target|alias]]" → alias,
  //    "[[target]]" → target — matching RM's rendered display text.
  s = s.replace(/!?\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
    const bar = inner.indexOf("|");
    return bar >= 0 ? inner.slice(bar + 1) : inner;
  });

  // 3. Markdown images/links → their alt/display text (before emphasis, so the
  //    display text's own markers get stripped in step 4).
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

  // 4. Paired inline markers → their content. Multi-char first (bold, strike),
  //    then single-char (italic, code); run sequentially so nested pairs like
  //    "**_x_**" collapse fully.
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/~~([^~]+)~~/g, "$1");
  s = s.replace(/\*([^*]+)\*/g, "$1");
  s = s.replace(/_([^_]+)_/g, "$1");
  s = s.replace(/`([^`]+)`/g, "$1");

  // 5. HTML tags — LP source may include inline HTML that RM renders.
  s = s.replace(/<[^>]+>/g, "");

  // 6. Highlight markers: "==text==" → text.
  s = s.replace(/==([^=]+)==/g, "$1");

  // 7. Footnote references: "[^1]" or "[^label]".
  s = s.replace(/\[\^[^\]]+\]/g, "");

  // 8. Collapse runs of whitespace so RM's rendered spacing and LP's source
  //    spacing compare equal.
  return s.replace(/\s+/g, " ").trim();
}
