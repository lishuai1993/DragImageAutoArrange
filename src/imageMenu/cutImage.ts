import { Notice, type Editor, type TFile } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { logger } from '../logger';
import { parseEmbedParams, stripSizingKeepOrientation } from '../imageParse/embedRaw';
import { isOrientationWord } from '../imageTransform/orientation';
import { trashFile } from '../utils';
import { lineStartOffset, minimalTextChange } from './noteEdit';
import { copyImageToClipboard } from './clipboard';
import { forgetReference } from './nativeClipboard';
import { planImageLinkRemoval, removeImageLinkOccurrences } from './noteLinks';
import { viewOfElement, writeQuietly } from './quietWrite';
import { confirmDelete } from './imageFile';
import type { ImageMenuFacade } from './imageMenuHost';

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

export const DELETE_IMAGE_FAILED = '删除图像引用失败';
/** The last reference is gone, so the image file went to the trash. */
export const DELETE_IMAGE_DONE = '已删除图像引用（文件已移入回收站）';
/** The note has no link we could remove — nothing was changed. */
export const DELETE_IMAGE_NO_REF = '未在当前笔记中找到该图像引用，未做任何更改';
/** The reference went, but other references (or a declined prompt) kept the file. */
export function deleteImageKeptNotice(remaining: number): string {
  return `仅已删除当前引用（文件保留，仍被 ${remaining} 处引用）`;
}
/** The reference went but the user declined the file deletion. */
export const DELETE_IMAGE_CANCELLED = '已删除当前引用（文件保留）';

/**
 * Whether a reference-removing row may act. Removing a reference rewrites the
 * note, so it is confined to the one case where both the target line is knowable
 * and editing is allowed: a DIAA-managed image in Live Preview, whose row anchors
 * give the exact source line. Reading Mode must not touch note content at all,
 * and a non-DIAA image has no anchor to resolve — both render greyed instead.
 *
 * Shared by 「剪切图像」 and the 「删除」 file-operation row, which differ only in
 * what happens around the removal.
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
 * 0-based source line of the clicked image, from the anchors DIAA already writes
 * to the DOM: Reading Mode tags the embed with `data-diaa-line` (1-based, so
 * subtract one), Live Preview tags the row container with `data-line-start` and
 * each image with `index`. Returns null for an image with no DIAA marker — an
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

/** 0-based source line of the clicked image, or null when it carries no DIAA
 *  anchor (an image Obsidian rendered outside any row). */
export function resolveClickedSourceLine(img: HTMLImageElement): number | null {
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
  let offset = isOrientationWord(parts[0]) ? 1 : 0;
  const align = parts[offset] === 'left' || parts[offset] === 'center' || parts[offset] === 'right';
  if (align) offset += 1;
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
      // Sizing belongs to the row the survivor is leaving; its orientation
      // belongs to the image, so it stays.
      const bare = stripSizingKeepOrientation(lines[start]);
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
  facade: ImageMenuFacade,
  imgFile: TFile,
  noteFile: TFile,
  editor: Editor | null,
  view: EditorView | null,
  line: number | null
): Promise<{ found: number; removed: number }> {
  const opts = { max: 1, line, afterRemoval: normalizeRowAfterRemoval };
  if (!editor) {
    log.debug('LOG_CUT_NO_EDITOR', { note: noteFile.path });
    return removeImageLinkOccurrences(facade.app, imgFile, opts);
  }

  const before = editor.getValue();
  const planned = planImageLinkRemoval(facade.app, before, imgFile, noteFile, opts);
  const change = minimalTextChange(before, planned.next);
  if (change) {
    writeQuietly(view, editor, change);
    if (line !== null) {
      editor.setCursor(editor.offsetToPos(Math.max(0, lineStartOffset(before, line) - 1)));
    }
  }
  return { found: planned.found, removed: planned.removed };
}

interface ReferenceOutcome {
  found: number;
  removed: number;
  remaining: number;
  deleteFile: boolean;
}

/**
 * The part 「剪切图像」 and 「删除」 have in common: remove exactly one reference —
 * the clicked one when its source line is known, otherwise the note's first —
 * and report how many references the vault still holds, so the caller can decide
 * whether the file survives.
 */
async function removeOneReference(
  facade: ImageMenuFacade,
  img: HTMLImageElement,
  imgFile: TFile,
  noteFile: TFile,
  editor: Editor | null
): Promise<ReferenceOutcome> {
  const line = resolveClickedSourceLine(img);
  const other = countOtherRefs(facade.app.metadataCache.resolvedLinks, imgFile.path, noteFile.path);
  const { found, removed } = await removeReferenceFromNote(
    facade,
    imgFile,
    noteFile,
    editor,
    viewOfElement(img),
    line
  );
  const { remaining, deleteFile } = decideCut({ other, liveInCurrent: found, removed });

  log.debug('LOG_REFERENCE_REMOVAL', {
    img: imgFile.path,
    note: noteFile.path,
    line,
    other,
    liveInCurrent: found,
    removed,
    remaining,
    deleteFile,
  });
  return { found, removed, remaining, deleteFile };
}

/**
 * Cut = copy the bitmap to the clipboard, then drop exactly one reference to
 * the image. The file is trashed only when no reference anywhere survives.
 *
 * Ordering is load-bearing: the copy runs first and a failed copy aborts the
 * whole operation, so a delete can never outrun a clipboard that never got the
 * image.
 *
 * The copy carries the reference like 「复制图像」 does, so a paste back into a
 * vault lands as a link and a paste anywhere else as an attachment. That is only
 * sound because paste re-checks the vault: the file survives the common case
 * (other references remain), and where it does not, the link has nothing left to
 * resolve to and the paste degrades to an attachment on its own.
 */
export async function cutImage(
  facade: ImageMenuFacade,
  img: HTMLImageElement,
  imgFile: TFile,
  noteFile: TFile,
  editor: Editor | null
): Promise<void> {
  try {
    await copyImageToClipboard(img, {
      reference: `![[${imgFile.path}]]`,
      vaultSource: { app: facade.app, file: imgFile },
    });
  } catch {
    new Notice(CUT_IMAGE_FAILED);
    return;
  }

  let outcome: ReferenceOutcome;
  try {
    outcome = await removeOneReference(facade, img, imgFile, noteFile, editor);
  } catch {
    new Notice(CUT_IMAGE_FAILED);
    return;
  }

  if (outcome.removed === 0) {
    new Notice(CUT_IMAGE_NO_REF);
    return;
  }
  if (!outcome.deleteFile) {
    new Notice(cutImageKeptNotice(outcome.remaining));
    return;
  }

  // The file is about to leave the vault, so the reference the copy armed now
  // names nothing: drop it rather than leave it for a paste to find.
  forgetReference();
  await trashFile(facade.app, imgFile);
  new Notice(CUT_IMAGE_DONE);
}

/**
 * Delete = drop exactly one reference to the image, then trash the file when
 * that was the vault's last one. Same removal as 「剪切图像」, minus the clipboard
 * and plus a confirmation: the native delete prompt is asked right before the
 * file would go, so declining it leaves the file in place while the removal the
 * user asked for still stands.
 */
export async function deleteImageReference(
  facade: ImageMenuFacade,
  img: HTMLImageElement,
  imgFile: TFile,
  noteFile: TFile,
  editor: Editor | null
): Promise<void> {
  let outcome: ReferenceOutcome;
  try {
    outcome = await removeOneReference(facade, img, imgFile, noteFile, editor);
  } catch {
    new Notice(DELETE_IMAGE_FAILED);
    return;
  }

  if (outcome.removed === 0) {
    new Notice(DELETE_IMAGE_NO_REF);
    return;
  }
  if (!outcome.deleteFile) {
    new Notice(deleteImageKeptNotice(outcome.remaining));
    return;
  }

  if (facade.settings.confirmDelete) {
    const confirmed = await confirmDelete(facade.app, imgFile);
    if (!confirmed) {
      new Notice(DELETE_IMAGE_CANCELLED);
      return;
    }
  }

  await trashFile(facade.app, imgFile);
  new Notice(DELETE_IMAGE_DONE);
}
