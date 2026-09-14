/**
 * Writing a rotate/flip into the note, where the orientation lives.
 *
 * A rotation is a note edit, not a file rewrite: the word is composed onto
 * whatever the target line already says and written back through a minimal
 * single-range replacement, so it lands on CodeMirror's undo stack and undoes
 * in one step.  Keeping the viewport put takes more than a small range — the
 * write carries a scroll request aimed at the caret — so the replacement goes
 * through `quietWrite`.
 *
 * Two shapes of target line are handled.  A row line — nothing but the embed —
 * takes the word in its parameter slot.  A line that carries other text is not
 * a row at all and cannot hold row params, so it is *upgraded*: the paragraph
 * is split into text / embed-on-its-own-line / text, which is the only way an
 * image on such a line can keep rotation available.  The split is confined to
 * lines where the embed is unambiguous and the line is a plain paragraph.
 */

import type { Editor } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import {
    composeOrientation,
    IDENTITY_STATE,
    isOrientationWord,
    orientationWord,
    parseOrientationWord,
    type OrientationState,
    type TransformOp,
} from '../imageTransform/orientation';
import { embedParamString } from '../imageParse/embedRaw';
import { minimalTextChange } from './noteEdit';
import { writeQuietly } from './quietWrite';

/** A line whose whole content is one image embed, with at most surrounding
 *  whitespace — the only shape that can carry row parameters. */
const ROW_LINE = /^(\s*)(!\[\[([^\]|#\n]+?)(?:\|([^\]\n]*))?\]\])(\s*)$/;

const EMBED = /!\[\[([^\]|#\n]+?)(?:\|([^\]\n]*))?\]\]/g;

/** Block-quote, table, heading, fence or list-item lines are off limits: the
 *  split would either break the block's own syntax or change its meaning. */
function isStructuredLine(line: string): boolean {
    const t = line.trimStart();
    if (/^(>|\||#|```|~~~)/.test(t)) return true;
    return /^([-*+]|\d+[.)])\s/.test(t);
}

/** The orientation a line currently declares; identity when it declares none. */
export function lineOrientation(line: string): OrientationState {
    return parseOrientationWord(embedParamString(line)) ?? IDENTITY_STATE;
}

/** Replace (or introduce) the orientation word, leaving every other param in
 *  place and in order.  The word always leads: Obsidian reads the LAST number
 *  as the width, so it can never sit between numbers. */
function withOrientation(params: string, state: OrientationState): string {
    const tokens = params === '' ? [] : params.split('|');
    const rest = isOrientationWord(tokens[0]) ? tokens.slice(1) : tokens;
    return [orientationWord(state), ...rest].filter((p) => p !== '').join('|');
}

/** Split a text-bearing paragraph so the embed stands on its own line, then
 *  orient it.  Null when the line cannot be upgraded safely. */
function upgradeLine(line: string, state: OrientationState): string | null {
    if (isStructuredLine(line)) return null;
    const embeds = [...line.matchAll(EMBED)];
    if (embeds.length !== 1) return null;

    const match = embeds[0];
    const start = match.index ?? 0;
    const embed = `![[${match[1]}|${withOrientation(match[2] ?? '', state)}]]`;

    const prefix = line.slice(0, start).replace(/\s+$/, '');
    const suffix = line.slice(start + match[0].length).replace(/^\s+/, '');
    const indent = /^\s*/.exec(line)?.[0] ?? '';
    return [prefix, indent + embed, suffix].filter((s) => s !== '').join('\n');
}

/** The line rewritten to declare `state`, or null when it cannot be done. */
export function setLineOrientation(line: string, state: OrientationState): string | null {
    const row = ROW_LINE.exec(line);
    if (row) {
        const [, lead, , target, params = '', trail] = row;
        return `${lead}![[${target}|${withOrientation(params, state)}]]${trail}`;
    }
    return upgradeLine(line, state);
}

/** The line as it reads after `op`, or null when nothing can be done to it. */
export function applyOpToLine(line: string, op: TransformOp): string | null {
    return setLineOrientation(line, composeOrientation(lineOrientation(line), op));
}

/** Whole-document rewrite for one line.  Null when the line is out of range or
 *  the operation would leave it unchanged. */
export function rewriteLineTo(
    text: string,
    line0: number,
    state: OrientationState
): string | null {
    const lines = text.split('\n');
    if (line0 < 0 || line0 >= lines.length) return null;
    const next = setLineOrientation(lines[line0], state);
    if (next === null || next === lines[line0]) return null;
    lines[line0] = next;
    return lines.join('\n');
}

/**
 * The 0-based line holding the one embed of `targets`, or null when no line —
 * or more than one — does.  The uniqueness requirement is what makes the
 * content-based lookup safe enough to write through: an ambiguous match is
 * refused rather than guessed at.
 */
export function findEmbedLine(text: string, targets: readonly string[]): number | null {
    const wanted = new Set(targets);
    const hits: number[] = [];
    text.split('\n').forEach((line, i) => {
        const embeds = [...line.matchAll(EMBED)];
        if (embeds.length !== 1) return;
        if (wanted.has(embeds[0][1].trim())) hits.push(i);
    });
    return hits.length === 1 ? hits[0] : null;
}

/** Write `state` onto line `line0` as one undoable editor transaction. */
export function applyOrientationState(
    editor: Editor,
    line0: number,
    state: OrientationState,
    view: EditorView | null = null
): boolean {
    const before = editor.getValue();
    const after = rewriteLineTo(before, line0, state);
    if (after === null) return false;
    const change = minimalTextChange(before, after);
    if (!change) return false;
    // Leave the caret where CodeMirror maps it, and pin the viewport: the write
    // itself would otherwise scroll the caret into view.
    writeQuietly(view, editor, change);
    return true;
}

/** Compose `op` onto the line's current orientation and write it back. */
export function applyOrientationOp(
    editor: Editor,
    line0: number,
    op: TransformOp,
    view: EditorView | null = null
): boolean {
    const lines = editor.getValue().split('\n');
    if (line0 < 0 || line0 >= lines.length) return false;
    return applyOrientationState(
        editor,
        line0,
        composeOrientation(lineOrientation(lines[line0]), op),
        view
    );
}

/** Return the line to its original orientation, keeping the slot explicit. */
export function resetOrientationOnLine(
    editor: Editor,
    line0: number,
    view: EditorView | null = null
): boolean {
    return applyOrientationState(editor, line0, IDENTITY_STATE, view);
}
