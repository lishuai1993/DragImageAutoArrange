import { Notice, type Editor, type TFile } from 'obsidian';
import { logger } from '../logger';
import { parseEmbedParams, stripEmbedParams } from '../imageParse/embedRaw';
import { lineStartOffset, minimalTextChange } from './noteEdit';
import type { PixelPerfectFacade } from './pixelPerfectHost';

const log = logger.channel('cutImage');

/** Right-click row label — sits directly above 「复制图像」. */
export const CUT_IMAGE_TITLE = '剪切图像';
export const CUT_IMAGE_ICON = 'scissors';
export const CUT_IMAGE_FAILED = '剪切图像失败';
/** The cut removed the vault's last reference, so the file went to the trash. */
export const CUT_IMAGE_DONE = '图像已剪切到剪贴板（本地文件已删除）';
/** The note has no link we could remove — only the clipboard was touched. */
export const CUT_IMAGE_NO_REF = '未在当前笔记中找到该图片引用，仅复制到剪贴板';
/** The reference was cut but other references remain, so the file stays. */
export function cutImageKeptNotice(remaining: number): string {
  return `仅剪切图像引用（文件仍被 ${remaining} 处引用）`;
}

/**
 * Whether the 「剪切图像」 row may act. Cut rewrites the note, so it is confined
 * to the one case where both the target line is knowable and editing is allowed:
 * a DIA-managed image in Live Preview, whose row anchors give the exact source
 * line. Reading Mode must not touch note content at all, and a non-DIA image has
 * no anchor to resolve — both render the row greyed instead.
 */
export function cutMenuItemEnabled(managed: boolean, readingMode: boolean): boolean {
  return managed && !readingMode;
}

export interface CutDecision {
  /** References to the image left after this cut. */
  remaining: number;
  deleteFile: boolean;
}

/**
 * Whether this cut may delete the file. Only a cut that actually removed a
 * reference can conclude anything — a failed locate (`removed === 0`) means we
 * never saw the note's own link, so its "nothing else references this" verdict
 * is worthless and the file must stay.
 */
export function decideCut(input: {
  other: number;
  liveInCurrent: number;
  removed: number;
}): CutDecision {
  const remaining = input.other + Math.max(0, input.liveInCurrent - input.removed);
  return { remaining, deleteFile: input.removed > 0 && remaining <= 0 };
}

/** References to `imgPath` held by every note except `notePath`. */
export function countOtherRefs(
  resolvedLinks: Record<string, Record<string, number>> | null | undefined,
  imgPath: string,
  notePath: string
): number {
  if (!resolvedLinks || typeof resolvedLinks !== 'object') return 0;
  let other = 0;
  for (const [sourcePath, targets] of Object.entries(resolvedLinks)) {
    if (sourcePath === notePath) continue;
    const count = targets?.[imgPath];
    if (count && count > 0) other += count;
  }
  return other;
}

/**
 * 0-based source line of the clicked image, from the anchors DIA already writes
 * to the DOM: Reading Mode tags the embed with `data-diaa-line` (1-based, so
 * subtract one), Live Preview tags the row container with `data-line-start` and
 * each image with `index`. Returns null for an image with no DIA marker — an
 * Obsidian-rendered image that belongs to no row — which makes the caller fall
 * back to the note's first matching reference.
 */
export function sourceLineFromMarkers(
  rowLineStart: string | undefined,
  index: string | undefined,
  line1: string | undefined
): number | null {
  if (line1 != null) {
    const n = parseInt(line1, 10);
    if (Number.isFinite(n) && n > 0) return n - 1;
  }
  if (rowLineStart != null) {
    const start = parseInt(rowLineStart, 10);
    if (Number.isFinite(start)) {
      const i = index != null ? parseInt(index, 10) : 0;
      return start + (Number.isFinite(i) && i >= 0 ? i : 0);
    }
  }
  return null;
}

function resolveClickedSourceLine(img: HTMLImageElement): number | null {
  const lineHost = img.closest?.<HTMLElement>('[data-diaa-line]');
  const rowHost = img.closest?.<HTMLElement>('[data-line-start]');
  return sourceLineFromMarkers(
    rowHost?.dataset.lineStart,
    img.dataset?.index,
    lineHost?.getAttribute('data-diaa-line') ?? undefined
  );
}

/**
 * True for an image line still carrying multi-row params. The clean single form
 * is `|S|W` with S ∈ {0,1} (optionally behind an alignment word); anything else
 * — a leftover flex weight such as `|150|100|` — is a multi-row leftover, which
 * single-image semantics would mis-read.
 */
function isMultiMemberLine(raw: string): boolean {
  const parts = parseEmbedParams(raw);
  if (!parts) return false;
  const align = parts[0] === 'left' || parts[0] === 'center' || parts[0] === 'right';
  const offset = align ? 1 : 0;
  const first = parseInt(parts[offset], 10);
  if (parts.length > offset + 1 && (first === 0 || first === 1)) return false;
  return true;
}

/**
 * Tidies up the note around the line a reference was just cut from.
 *
 * Two things happen, both scoped to that spot:
 *
 * 1. The line the reference occupied is dropped when nothing is left on it. A
 *    row is a run of consecutive lines, so leaving a blank line behind would
 *    split what remains into two rows.
 * 2. A row that shrank to a single image is rewritten to the bare `![[file]]`
 *    form — the same identity transition the flex-row → standalone drag
 *    performs (`convertOrphanedMultiSinglesToBare`) — so the survivor
 *    re-derives its setting-driven width instead of being read under
 *    single-image semantics with multi-row params still attached.
 *
 * A row that keeps ≥2 members needs nothing: its params are relative weights,
 * which flex-grow redistributes on its own.
 */
export function normalizeRowAfterRemoval(content: string, removedLine: number | null): string {
  if (removedLine === null) return content;
  const lines = content.split('\n');

  const at = Math.min(removedLine, lines.length - 1);
  if (at >= 0 && lines[at] !== undefined && lines[at].trim() === '') {
    lines.splice(at, 1);
  }

  const anchor = [Math.min(removedLine, lines.length - 1), removedLine - 1].find(
    i => i >= 0 && i < lines.length && isMultiMemberLine(lines[i])
  );
  if (anchor !== undefined) {
    let start = anchor;
    while (start - 1 >= 0 && isMultiMemberLine(lines[start - 1])) start -= 1;
    let end = anchor;
    while (end + 1 < lines.length && isMultiMemberLine(lines[end + 1])) end += 1;
    if (end - start + 1 === 1) {
      const bare = stripEmbedParams(lines[start]);
      if (bare !== lines[start]) lines[start] = bare;
    }
  }

  return lines.join('\n');
}

/**
 * Drops the one reference `line` points at, preferring the live editor: an
 * editor-backed change is a single small CodeMirror transaction, so it lands on
 * the undo stack and the viewport stays put. Writing through the vault instead
 * (no editor to hand) works but is neither undoable nor scroll-stable, so it
 * remains a fallback. The caret is parked at the end of the line above the
 * removal, where the image used to sit.
 */
async function removeReferenceFromNote(
  facade: PixelPerfectFacade,
  imgFile: TFile,
  noteFile: TFile,
  editor: Editor | null,
  line: number | null
): Promise<{ found: number; removed: number }> {
  const opts = { max: 1, line, afterRemoval: normalizeRowAfterRemoval };
  if (!editor) {
    log.debug('LOG_CUT_NO_EDITOR', { note: noteFile.path });
    return facade.host.linkService.removeImageLinkOccurrences(imgFile, opts);
  }

  const before = editor.getValue();
  const planned = facade.host.linkService.planImageLinkRemoval(before, imgFile, noteFile, opts);
  const change = minimalTextChange(before, planned.next);
  if (change) {
    editor.replaceRange(
      change.insert,
      editor.offsetToPos(change.from),
      editor.offsetToPos(change.to)
    );
    if (line !== null) {
      editor.setCursor(editor.offsetToPos(Math.max(0, lineStartOffset(before, line) - 1)));
    }
  }
  return { found: planned.found, removed: planned.removed };
}

/**
 * Cut = copy the bitmap to the clipboard, then drop exactly one reference to
 * the image (the clicked one when its source line is known, otherwise the
 * note's first). The file is trashed only when no reference anywhere survives.
 *
 * Ordering is load-bearing: the copy runs first and a failed copy aborts the
 * whole operation, so a delete can never outrun a clipboard that never got the
 * image.
 */
export async function cutImage(
  facade: PixelPerfectFacade,
  img: HTMLImageElement,
  imgFile: TFile,
  noteFile: TFile,
  editor: Editor | null
): Promise<void> {
  try {
    await facade.host.imageService.copyImageToClipboard(img);
  } catch {
    new Notice(CUT_IMAGE_FAILED);
    return;
  }

  const app = facade.host.app;
  const line = resolveClickedSourceLine(img);
  const other = countOtherRefs(app.metadataCache.resolvedLinks, imgFile.path, noteFile.path);

  let found = 0;
  let removed = 0;
  try {
    const result = await removeReferenceFromNote(facade, imgFile, noteFile, editor, line);
    found = result.found;
    removed = result.removed;
  } catch {
    new Notice(CUT_IMAGE_FAILED);
    return;
  }

  const { remaining, deleteFile } = decideCut({ other, liveInCurrent: found, removed });
  log.debug('LOG_CUT_REFS', {
    img: imgFile.path,
    note: noteFile.path,
    line,
    other,
    liveInCurrent: found,
    removed,
    remaining,
    deleteFile,
  });

  if (removed === 0) {
    new Notice(CUT_IMAGE_NO_REF);
    return;
  }
  if (!deleteFile) {
    new Notice(cutImageKeptNotice(remaining));
    return;
  }

  await app.fileManager.trashFile(imgFile);
  new Notice(CUT_IMAGE_DONE);
}
