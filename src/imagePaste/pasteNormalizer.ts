/**
 * Keep a pasted image DIAA-shaped.
 *
 * DIAA hosts a row as a run of consecutive lines, each holding exactly one
 * embed (`buildImageLineRe`). Obsidian inserts a pasted embed at the caret
 * with no line-boundary guard, so pasting at the start or end of a line that
 * already holds an embed yields `![[a]]![[b]]` — a line no row parser sees,
 * which silently falls back to Obsidian's inline rendering. That is why the
 * correction is structural: split the line back into one embed per line.
 *
 * Structure alone is not enough. A pasted reference carries the params of the
 * row it came from, and the same numeric slot means different things per row
 * kind (multi `|W|S` vs single `|S|W`). A single-form line that has just become
 * a row member is read as a near-zero share; a multi-form line that has just
 * become a single row is read as neither S nor W. So every group the paste
 * touched is re-checked and a form mismatch is reset to bare (orientation
 * kept) — the same transition `convertOrphanedMultiSinglesToBare` performs for
 * a drag, applied at the paste boundary.
 *
 * The paste itself is not intercepted (a native attachment paste is Obsidian's
 * own async insert). Instead the paste is only marked, and the first editor
 * change that follows it — the insert, whenever it lands — triggers the check.
 * The editors of both Live Preview and Source mode are the same CodeMirror
 * editor, so one path covers both; Reading Mode has no editable surface and is
 * skipped.
 */

import { MarkdownView, type App, type Editor, type MarkdownFileInfo } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { buildImageEmbedRe, combinedMediaExtensions } from "../constants";
import { logger } from "../logger";
import { findMarkdownViewForElement } from "../imageMenu/imageSource";
import { writeQuietly } from "../imageMenu/quietWrite";
import { parseEmbedParams, stripSizingKeepOrientation } from "../imageParse/embedRaw";
import { detectRowGroups } from "../imageParse/imageDetector";
import { isSingleFormSizing, slotOffset } from "../imageParse/rowParams";
import { editorCmOf } from "../obsidianInternals";

const log = logger.channel("pasteNormalize");

/** How long a paste stays "the change to come". A native attachment paste has
 *  to write the file before it can insert the embed, so the change is not
 *  synchronous; a second is ample, and the flag expiring only means the next
 *  change is not attributed to this paste. */
const PASTE_FLAG_MS = 2000;

export interface PasteNormalizeSettings {
  maxImagesPerRow: number;
  imageExtensions: string;
  videoExtensions: string;
}

/** The corrected document and where the pasted embed now sits. */
export interface PasteFix {
  text: string;
  /** Line holding the pasted embed in `text`, for caret placement. */
  caretLine: number;
}

/** The embeds on one line, in order, with their offsets. */
function embedsOnLine(
  line: string,
  extensions: string
): Array<{ text: string; start: number; end: number }> {
  const re = buildImageEmbedRe(extensions);
  const out: Array<{ text: string; start: number; end: number }> = [];
  for (const match of line.matchAll(re)) {
    const start = match.index ?? 0;
    out.push({ text: match[0], start, end: start + match[0].length });
  }
  return out;
}

/** The line's indentation, so each piece of a split keeps it. */
function indentOf(line: string): string {
  return /^\s*/.exec(line)?.[0] ?? "";
}

/**
 * Split a line that is nothing but two or more embeds into one embed per line.
 * Returns null when the line is not such a run — a single embed, or prose
 * sharing the line, is left for the caller (and for Obsidian) to keep.
 */
export function splitConcatenatedEmbeds(line: string, extensions: string): string[] | null {
  const embeds = embedsOnLine(line, extensions);
  if (embeds.length < 2) return null;

  // Whatever is not an embed must be whitespace, or this is prose the plugin
  // must not reflow.
  let rest = "";
  let cursor = 0;
  for (const embed of embeds) {
    rest += line.slice(cursor, embed.start);
    cursor = embed.end;
  }
  rest += line.slice(cursor);
  if (rest.trim() !== "") return null;

  const indent = indentOf(line);
  return embeds.map((embed) => indent + embed.text);
}

/**
 * Put the embed the paste just created on a line of its own, leaving the text
 * it landed against where it was. The caret after an insert sits at the end of
 * the inserted text, so the pasted embed is the one ending at or before the
 * caret. Returns null when the line holds no such embed, or the embed is
 * already alone on the line.
 */
export function isolateEmbedAtCaret(
  line: string,
  caretCh: number,
  extensions: string
): string[] | null {
  const embeds = embedsOnLine(line, extensions);
  if (embeds.length !== 1) return null;

  const embed = embeds[0];
  if (caretCh < embed.end) return null;

  const before = line.slice(0, embed.start);
  const after = line.slice(embed.end);
  const splitBefore = before.trim() !== "";
  const splitAfter = after.trim() !== "";
  if (!splitBefore && !splitAfter) return null;

  const out: string[] = [];
  if (splitBefore) out.push(before.trimEnd());
  out.push(indentOf(line) + embed.text);
  if (splitAfter) out.push(after.trimStart());
  return out;
}

/** Whether a single row carries sizing that is not its clean `|S|W`. */
function hasForeignSizing(raw: string): boolean {
  const parts = parseEmbedParams(raw);
  if (!parts) return false;
  const offset = slotOffset(parts);
  if (parts.length <= offset) return false;
  if (isSingleFormSizing(raw)) return false;
  return true;
}

/**
 * The corrected text, or null when the paste left nothing to correct.
 *
 * `caretLine`/`caretCh` describe the caret right after the insert; `text` is
 * the whole document at that moment. Both come from the same read so the line
 * and column always refer to each other.
 */
export function normalizePastedText(
  text: string,
  caretLine: number,
  caretCh: number,
  maxImagesPerRow: number,
  extensions: string
): PasteFix | null {
  const lines = text.split("\n");
  if (caretLine < 0 || caretLine >= lines.length) return null;
  const line = lines[caretLine];

  let replacement = splitConcatenatedEmbeds(line, extensions);
  let pasted: number;
  if (replacement) {
    // The pasted embed is the last one ending at or before the caret.
    const embeds = embedsOnLine(line, extensions);
    let index = 0;
    embeds.forEach((embed, i) => {
      if (embed.end <= caretCh) index = i;
    });
    pasted = index;
  } else {
    replacement = isolateEmbedAtCaret(line, caretCh, extensions);
    if (!replacement) return null;
    const at = replacement.findIndex((l) => embedsOnLine(l, extensions).length > 0);
    pasted = at < 0 ? 0 : at;
  }

  const nextLines = [
    ...lines.slice(0, caretLine),
    ...replacement,
    ...lines.slice(caretLine + 1),
  ];
  const affectedStart = caretLine;
  const affectedEnd = caretLine + replacement.length - 1;

  // A group the paste touched may now mix the two param grammars: the new
  // members came from wherever the reference was copied, and an adjacent line
  // that was a single row a moment ago just became a member. Only mismatches
  // are reset, so a well-formed row the paste merely joined keeps its params.
  const groups = detectRowGroups(nextLines.join("\n"), maxImagesPerRow, extensions);
  for (const group of groups) {
    if (group.lineEnd <= affectedStart || group.lineStart > affectedEnd) continue;
    for (const image of group.images) {
      const raw = nextLines[image.line];
      if (raw === undefined) continue;
      const mismatch = group.kind === "multi" ? isSingleFormSizing(raw) : hasForeignSizing(raw);
      if (!mismatch) continue;
      // Sizing belongs to the row being left; an orientation stays with the
      // image. Same rule a drag off a row applies.
      nextLines[image.line] = stripSizingKeepOrientation(raw);
    }
  }

  return { text: nextLines.join("\n"), caretLine: caretLine + pasted };
}

/**
 * Write the fix as the smallest single replacement that turns `before` into
 * `fix.text`, so it is one undo step. `writeQuietly` keeps the viewport put.
 */
function applyPasteFix(
  view: EditorView | null,
  editor: Editor,
  before: string,
  fix: PasteFix
): void {
  const oldLines = before.split("\n");
  const newLines = fix.text.split("\n");

  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start += 1;
  }
  let endOld = oldLines.length - 1;
  let endNew = newLines.length - 1;
  while (endOld >= start && endNew >= start && oldLines[endOld] === newLines[endNew]) {
    endOld -= 1;
    endNew -= 1;
  }
  if (start > endOld && start > endNew) return;

  const offsets = [0];
  for (let i = 0; i < oldLines.length; i += 1) offsets.push(offsets[i] + oldLines[i].length + 1);
  const from = start < oldLines.length ? offsets[start] : before.length;
  const to = endOld >= start ? offsets[endOld] + oldLines[endOld].length : from;
  const insert = endNew >= start ? newLines.slice(start, endNew + 1).join("\n") : "";

  writeQuietly(view, editor, { from, to, insert });

  const lineIndex = Math.min(Math.max(fix.caretLine, 0), editor.lineCount() - 1);
  editor.setCursor({ line: lineIndex, ch: (editor.getLine(lineIndex) ?? "").length });
}

/** Run the check against the document as it now stands. */
function normalizeNow(
  view: MarkdownView,
  getSettings: () => PasteNormalizeSettings
): void {
  const editor: Editor | undefined = view.editor;
  if (!editor) return;
  if (view.getMode?.() === "preview") return;

  const settings = getSettings();
  const extensions = combinedMediaExtensions(
    settings.imageExtensions,
    settings.videoExtensions
  );
  const cursor = editor.getCursor();
  const before = editor.getValue();
  const fix = normalizePastedText(
    before,
    cursor.line,
    cursor.ch,
    settings.maxImagesPerRow,
    extensions
  );
  if (!fix || fix.text === before) return;

  log.debug("PASTE_NORMALIZED", { line: cursor.line, ch: cursor.ch });
  applyPasteFix(editorCmOf(view), editor, before, fix);
}

/**
 * Watch pastes for the plugin's lifetime; returns the uninstall.
 *
 * The paste event is only a marker: what it changed is observed through the
 * editor change that follows, because Obsidian's own attachment insert is
 * asynchronous and never passes through this plugin. The correction itself
 * runs a tick later — a change dispatched from inside the editor's update
 * cycle is rejected by CodeMirror.
 */
export function installPasteNormalizer(
  app: App,
  getSettings: () => PasteNormalizeSettings
): () => void {
  let pending: { editor: Editor; view: MarkdownView; timer: number } | null = null;

  const clearPending = (): void => {
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pending = null;
  };

  const onPaste = (event: ClipboardEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const view = findMarkdownViewForElement(app, target);
    if (!view) return;
    if (view.getMode?.() === "preview") return;
    const editor = view.editor;
    if (!editor) return;
    clearPending();
    pending = { editor, view, timer: window.setTimeout(clearPending, PASTE_FLAG_MS) };
  };

  const onEditorChange = (
    editor: Editor,
    _info: MarkdownView | MarkdownFileInfo
  ): void => {
    if (!pending || pending.editor !== editor) return;
    const { view } = pending;
    clearPending();
    window.setTimeout(() => normalizeNow(view, getSettings), 0);
  };

  document.addEventListener("paste", onPaste, true);
  const ref = app.workspace.on("editor-change", onEditorChange);
  return () => {
    clearPending();
    document.removeEventListener("paste", onPaste, true);
    app.workspace.offref(ref);
  };
}
