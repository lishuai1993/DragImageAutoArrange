/**
 * Land a copied image reference as a reference.
 *
 * 「复制图像」 leaves the reference somewhere behind the bitmap, and this module is
 * what picks it back up on paste. Which container holds it depends on the route the
 * copy took (clipboard.ts):
 *
 *   Web clipboard  the reference rides along as a `text/plain` flavour, beside the
 *                  bitmap. Obsidian's editor would take the bitmap and mint a
 *                  duplicate attachment, ignoring the text, so the paste is
 *                  intercepted before that happens.
 *   native JPEG    `writeBuffer` replaces the whole pasteboard per call, so no text
 *                  flavour survives it; the reference waits in memory and is
 *                  confirmed by matching the pasteboard's own bytes
 *                  (nativeClipboard.ts).
 *
 * Either source is only trusted when it names an image that exists in this vault
 * right now. That test is safe to apply broadly — only a copy made here or a copy
 * taken out of a note puts such text on the clipboard, and for both, inserting the
 * reference is the wanted result; a bitmap off the web, an unrelated string, or a
 * path that resolves only in some other vault fails the lookup or the embed shape
 * and falls through to Obsidian untouched. Reading the vault also settles the
 * dangling case for free: a cut that trashed its last reference leaves nothing for
 * the lookup to find, so the paste degrades to an attachment instead of linking to
 * a file that is gone.
 */

import { MarkdownView, TFile, type App, type Editor } from 'obsidian';
import { findMarkdownViewForElement } from './imageSource';
import { recallReference } from './nativeClipboard';

/**
 * The link target of an embed line, or null when the text is not one lone embed.
 * Accepts the parametric forms (`![[a.png|left|0|400]]`) and heading/anchor
 * fragments, since those are what a copy out of a note carries; rejects anything
 * with text around it, which is not something a paste should be hijacked for.
 */
export function embedLinkTarget(text: string): string | null {
    const match = /^!\[\[([^\]|#]+?)\s*(?:[|#][\s\S]*)?\]\]$/.exec(text.trim());
    return match ? match[1].trim() : null;
}

/** Resolve an embed's link target to a vault image, or null when it names no
 *  such file — or names a note, which is a reference in its own right and owes
 *  this module nothing. */
export function resolveVaultImage(app: App, linkTarget: string, sourcePath: string): TFile | null {
    const file = app.metadataCache.getFirstLinkpathDest(linkTarget, sourcePath);
    if (!(file instanceof TFile)) return null;
    return file.extension.toLowerCase() === 'md' ? null : file;
}

/**
 * The reference this paste carries, or null when it carries none. The text flavour
 * is tried first because it is free; only when it is absent — which is exactly the
 * native-JPEG case, where the write left no text flavour at all — is the pasteboard
 * read back to check the remembered bytes.
 */
function referenceForPaste(event: ClipboardEvent): string | null {
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text) return embedLinkTarget(text) ? text.trim() : null;
    const recalled = recallReference();
    return recalled && embedLinkTarget(recalled) ? recalled.trim() : null;
}

/** Take the paste over: park the reference in place of whatever the editor would
 *  have done with the bitmap. */
function insertReference(event: ClipboardEvent, editor: Editor, reference: string): void {
    event.preventDefault();
    event.stopPropagation();
    editor.replaceSelection(reference);
}

/**
 * Insert the reference when this paste is one, leaving the event untouched
 * otherwise. Returns whether the paste was handled.
 */
export function handleReferencePaste(app: App, event: ClipboardEvent): boolean {
    const { target } = event;
    if (!(target instanceof Element)) return false;
    const view = findMarkdownViewForElement(app, target);
    if (!(view instanceof MarkdownView) || !view.editor) return false;
    // Reading Mode has no editable surface; only the editor's own paste counts.
    if (view.getMode?.() === 'preview') return false;

    const reference = referenceForPaste(event);
    if (!reference) return false;
    const linkTarget = embedLinkTarget(reference);
    if (!linkTarget) return false;

    if (!resolveVaultImage(app, linkTarget, view.file?.path ?? '')) return false;

    insertReference(event, view.editor, reference);
    return true;
}

/** Watch pastes for the plugin's lifetime; returns the uninstall. */
export function installReferencePaste(app: App): () => void {
    const onPaste = (event: ClipboardEvent): void => {
        handleReferencePaste(app, event);
    };
    document.addEventListener('paste', onPaste, true);
    return () => document.removeEventListener('paste', onPaste, true);
}
