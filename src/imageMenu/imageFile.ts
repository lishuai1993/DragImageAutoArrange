/**
 * Turning a rendered `<img>` back into its vault file, and running the plain
 * file actions the menu offers (open elsewhere, reveal, rename, delete).
 *
 * The resolution walks the resource URL the renderer put on the element, so it
 * works the same for a row-owned image and for one Obsidian rendered on its own
 * — no dependency on the row anchors, which only the cut/delete path needs.
 *
 * The desktop actions below are runtime-only members (or newer than this
 * plugin's `minAppVersion`), so every one is reached through a structural type
 * and capability-probed instead of being called directly: on a build without
 * them the row reports a failure notice rather than throwing.
 */

import { TFile, type App, type TAbstractFile } from 'obsidian';
import { logger } from '../logger';

const log = logger.channel('imageFile');

/** Obsidian's App surface for "open with default app" / "reveal in OS explorer". */
interface DesktopFileActions {
    openWithDefaultApp?(path: string): Promise<void> | void;
    showInFolder?(path: string, isFolder?: boolean): Promise<void> | void;
}

/** FileManager members that exist at runtime but not in the public typings. */
interface PromptCapableFileManager {
    promptForFileRename?(file: TAbstractFile): Promise<void> | void;
    promptForDeletion?(file: TAbstractFile): Promise<boolean>;
}

/** Vault-relative path encoded in a rendered image's resource URL, if any. */
function vaultRelativePath(src: string): string | null {
    if (!src) return null;
    const appUrl = /^app:\/\/[^/]+\/(.+)$/.exec(src);
    const raw = appUrl ? appUrl[1] : /^[a-z][a-z0-9+.-]*:/i.test(src) ? null : src;
    if (!raw) return null;

    const withoutFragment = raw.split(/[?#]/)[0];
    try {
        return decodeURIComponent(withoutFragment);
    } catch {
        return withoutFragment;
    }
}

/**
 * The vault file behind a rendered image, or null when its source cannot be
 * mapped back into the vault (an absolute `file://` URL, a surface whose src was
 * replaced after load, a file that is no longer there).
 */
export function resolveImageFile(
    app: App,
    img: HTMLImageElement,
    sourcePath: string
): TFile | null {
    const src = img.currentSrc || img.src || '';
    const relative = vaultRelativePath(src);

    if (relative) {
        const direct = app.vault.getAbstractFileByPath(relative);
        if (direct instanceof TFile) return direct;

        const byName = app.metadataCache.getFirstLinkpathDest(
            relative.split('/').pop() ?? relative,
            sourcePath
        );
        if (byName instanceof TFile) return byName;
    }

    log.debug('LOG_IMAGE_UNRESOLVED', { src });
    return null;
}

/** Whether the running Obsidian exposes the native rename prompt. */
export function canPromptRename(app: App): boolean {
    const fileManager = app.fileManager as unknown as PromptCapableFileManager | undefined;
    return typeof fileManager?.promptForFileRename === 'function';
}

export async function openInNewTab(app: App, file: TFile): Promise<void> {
    await app.workspace.getLeaf('tab').openFile(file);
}

export async function openToTheRight(app: App, file: TFile): Promise<void> {
    await app.workspace.getLeaf('split', 'vertical').openFile(file);
}

export async function openInNewWindow(app: App, file: TFile): Promise<void> {
    await app.workspace.getLeaf('window').openFile(file);
}

export async function openInDefaultApp(app: App, file: TFile): Promise<void> {
    const actions = app as unknown as DesktopFileActions;
    if (typeof actions.openWithDefaultApp !== 'function') {
        throw new Error('openWithDefaultApp is unavailable in this build');
    }
    await actions.openWithDefaultApp(file.path);
}

export async function showInExplorer(app: App, file: TFile): Promise<void> {
    const actions = app as unknown as DesktopFileActions;
    if (typeof actions.showInFolder !== 'function') {
        throw new Error('showInFolder is unavailable in this build');
    }
    await actions.showInFolder(file.path, false);
}

/** Rename through Obsidian's own prompt, so link updates follow user settings. */
export async function promptRename(app: App, file: TFile): Promise<void> {
    const fileManager = app.fileManager as unknown as PromptCapableFileManager;
    if (typeof fileManager.promptForFileRename !== 'function') {
        throw new Error('promptForFileRename is unavailable in this build');
    }
    await fileManager.promptForFileRename(file);
}

/**
 * Native delete confirmation. Returns true when the prompt is missing, so a
 * build without it keeps the action working rather than silently doing nothing.
 */
export async function confirmDelete(app: App, file: TFile): Promise<boolean> {
    const fileManager = app.fileManager as unknown as PromptCapableFileManager;
    if (typeof fileManager.promptForDeletion !== 'function') return true;
    return fileManager.promptForDeletion(file);
}
