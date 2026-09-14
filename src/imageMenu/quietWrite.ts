/**
 * Writing a note edit without dragging the viewport along.
 *
 * A programmatic write through the editor API doesn't only change the text: it
 * carries a "reveal the caret" scroll request, which CodeMirror applies on the
 * next scheduled measure.  A right-click never moves the caret, so on an image
 * the caret usually sits somewhere else in the note — and when that request
 * lands, the viewport jumps to it.
 *
 * The write is therefore answered with a scroll request of our own: the
 * snapshot CodeMirror already knows how to take (`EditorView.scrollSnapshot`),
 * which restores the scroll offset the viewport had.  Both requests are in play
 * before the measure runs, and the later one wins, so the only move that ever
 * happens is to where the viewport already is.  Writing through the editor's
 * own path (rather than dispatching the change ourselves) is deliberate: undo
 * grouping and the editor's bookkeeping stay as they were.
 *
 * The snapshot is used rather than a hand-built `y: "start"` request because a
 * snapshot's offset is measured and restored in the *same* coordinate space
 * (block coordinates), so it cancels the `lpInset` — the gap Obsidian leaves
 * above `.cm-content` for the inline title and properties.  A request built
 * from `lineBlockAtHeight` mixes block coordinates with the on-screen ones
 * CodeMirror applies them in, and lands short by exactly that inset, shifting
 * the viewport on every write.
 *
 * Ordering is load-bearing.  The snapshot is taken *before* the write: it is a
 * reading of the viewport as it stands, and the write is what invalidates the
 * height map it reads.
 */

import type { Editor } from 'obsidian';
import { ChangeSet } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/** A single-range replacement, as `minimalTextChange` produces. */
export interface TextChange {
    from: number;
    to: number;
    insert: string;
}

/** The viewport, as it stood before the write. */
interface ViewportHold {
    /** The request the write is answered with: restores the scroll offset held
     *  at capture time, in the coordinates CodeMirror itself measures in. */
    effect: ReturnType<EditorView['scrollSnapshot']>;
    /** Document length the effect's position belongs to, so the change can map it. */
    docLength: number;
}

/** The live editor view hosting `el`, or null when it is outside one. */
export function viewOfElement(el: HTMLElement): EditorView | null {
    try {
        const host = el.closest<HTMLElement>('.cm-content') ?? el.closest<HTMLElement>('.cm-editor') ?? el;
        return EditorView.findFromDOM(host);
    } catch {
        return null;
    }
}

/** Write `change` into `editor` as one undoable edit that leaves the viewport
 *  where the user put it.  Pass the view when one is known. */
export function writeQuietly(view: EditorView | null, editor: Editor, change: TextChange): void {
    const hold = view ? captureHold(view) : null;
    editor.replaceRange(change.insert, editor.offsetToPos(change.from), editor.offsetToPos(change.to));
    if (view && hold) releaseHold(view, hold, change);
}

/** Read the viewport's anchor.  Must run before the write — see the header. */
function captureHold(view: EditorView): ViewportHold | null {
    try {
        return { effect: view.scrollSnapshot(), docLength: view.state.doc.length };
    } catch {
        // Reading the layout is only legal outside an update cycle.  Off it, do
        // without the hold rather than disturb the write.
        return null;
    }
}

/** Answer the write with the snapshot, its position mapped through `change` so
 *  it still names the block it was taken for. */
function releaseHold(view: EditorView, hold: ViewportHold, change: TextChange): void {
    try {
        const mapped = hold.effect.map(
            ChangeSet.of({ from: change.from, to: change.to, insert: change.insert }, hold.docLength)
        );
        if (mapped) view.dispatch({ effects: mapped });
    } catch {
        // A hold that cannot be taken must not break the write that landed.
    }
}
