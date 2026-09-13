/**
 * Generic row builders shared by the menu assembly: a clickable action row, a
 * non-clickable info row, the image info block, and the file-operation block.
 *
 * They write through the `MenuLike` surface only, so nothing here depends on
 * Obsidian's `Menu` API or on the concrete DOM implementation.
 */

import { Notice, type App, type Editor, type TFile } from 'obsidian';
import { logger } from '../logger';
import { assertNever } from '../utils';
import type { MenuLike } from './menuLike';
import {
    FILE_OPERATION_ICONS,
    FILE_OPERATION_LABELS,
    NOTICE_FAILED,
} from './menuLabels';
import type { FileOperationId, ImageMenuSettings } from './settingsModel';
import {
    canPromptRename,
    openInDefaultApp,
    openInNewTab,
    openInNewWindow,
    openToTheRight,
    promptRename,
    showInExplorer,
} from './imageFile';
import { deleteImageReference } from './cutImage';
import type { ImageMenuFacade } from './imageMenuHost';

const log = logger.channel('menuBuilder');

export interface MenuItemOptions {
    icon?: string | null;
    /** Toast shown when the action rejects. */
    failureNotice?: string;
    disabled?: boolean;
    /** Paints the row in the error colour (destructive actions). */
    warning?: boolean;
}

/**
 * A clickable row. The action runs detached from the menu (which closes on
 * click), and a rejection surfaces as a Notice instead of an unhandled
 * rejection — every action here touches the vault, the clipboard or the OS, all
 * of which can refuse.
 */
export function addMenuItem(
    menu: MenuLike,
    title: string,
    handler: () => unknown,
    options: MenuItemOptions = {}
): void {
    const { icon = null, failureNotice, disabled = false, warning = false } = options;

    menu.addItem(item => {
        if (icon) item.setIcon(icon);
        item.setTitle(title);
        if (disabled) item.setDisabled(true);
        if (warning) item.setWarning(true);
        item.onClick(() => {
            void (async () => {
                try {
                    await handler();
                } catch (error) {
                    log.error('LOG_MENU_ACTION_FAILED', { title, error: String(error) });
                    if (failureNotice) new Notice(failureNotice);
                }
            })();
        });
    });
}

/** A non-clickable row carrying information rather than an action. */
export function addInfoMenuItem(menu: MenuLike, title: string, icon: string | null = null): void {
    menu.addItem(item => {
        if (icon) item.setIcon(icon);
        item.setTitle(title);
        item.setDisabled(true);
    });
}

/**
 * The identity block: `name @ zoom%` over the source image's own pixel size.
 *
 * The zoom is how the image is being displayed right now (rendered width over
 * natural width), while the dimension row reports the file's real pixels rather
 * than the on-screen box — so the pair reads as "this file, at this scale".
 *
 * `name` and `icon` come from the caller because a remote image has no vault
 * filename: it shows its URL's last segment under a globe instead.
 */
export function addDimensionsMenuItem(
    menu: MenuLike,
    img: HTMLImageElement,
    name: string,
    icon: string
): void {
    const naturalWidth = img.naturalWidth || 0;
    const naturalHeight = img.naturalHeight || 0;

    addInfoMenuItem(menu, imageInfoTitle(name, img, naturalWidth), icon);
    if (naturalWidth > 0 && naturalHeight > 0) {
        addInfoMenuItem(menu, `${naturalWidth} × ${naturalHeight} px`, 'ruler');
    }
}

function imageInfoTitle(name: string, img: HTMLImageElement, naturalWidth: number): string {
    const renderedWidth = Math.round(img.getBoundingClientRect().width);
    if (naturalWidth > 0 && renderedWidth > 0) {
        return `${name} @ ${Math.round((renderedWidth / naturalWidth) * 100)}%`;
    }
    return name;
}

export interface FileOperationContext {
    app: App;
    facade: ImageMenuFacade;
    img: HTMLImageElement;
    /** The vault file behind the image; null for a remote image with no file. */
    imgFile: TFile | null;
    /** Note the image was clicked in; null when it could not be resolved. */
    noteFile: TFile | null;
    editor: Editor | null;
    /** Whether the reference-removing 「删除」 row may act. */
    canRemoveReference: boolean;
}

/**
 * The file-operation block, in the user's saved order. Rows whose capability is
 * missing on this build (or in this context) still render — greyed — so the
 * menu keeps a stable shape instead of shifting as you move between images.
 */
export function addFileOperationMenuItems(
    menu: MenuLike,
    ctx: FileOperationContext,
    settings: ImageMenuSettings,
    blockDisabled = false
): void {
    for (const item of settings.fileOperationItems) {
        if (!item.visible) continue;
        const id = item.id;

        let disabled = blockDisabled || ctx.imgFile === null;
        if (id === 'renameImage' && !canPromptRename(ctx.app)) disabled = true;
        if (id === 'deleteImage' && (!ctx.canRemoveReference || !ctx.noteFile)) disabled = true;

        addMenuItem(menu, FILE_OPERATION_LABELS[id], () => runFileOperation(id, ctx), {
            icon: FILE_OPERATION_ICONS[id],
            failureNotice: NOTICE_FAILED.fileActionFailed,
            disabled,
            warning: id === 'deleteImage',
        });
    }
}

async function runFileOperation(id: FileOperationId, ctx: FileOperationContext): Promise<void> {
    const { app, imgFile } = ctx;
    if (!imgFile) return;

    switch (id) {
        case 'openInNewTab':
            await openInNewTab(app, imgFile);
            return;
        case 'openToTheRight':
            await openToTheRight(app, imgFile);
            return;
        case 'openInNewWindow':
            await openInNewWindow(app, imgFile);
            return;
        case 'openInDefaultApp':
            await openInDefaultApp(app, imgFile);
            return;
        case 'showInExplorer':
            await showInExplorer(app, imgFile);
            return;
        case 'renameImage':
            await promptRename(app, imgFile);
            return;
        case 'deleteImage': {
            const { noteFile } = ctx;
            if (!noteFile) return;
            await deleteImageReference(ctx.facade, ctx.img, imgFile, noteFile, ctx.editor);
            return;
        }
        default:
            return assertNever(id);
    }
}
