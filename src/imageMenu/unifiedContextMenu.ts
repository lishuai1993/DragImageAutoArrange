/**
 * Assembly of the image right-click menu.
 *
 * One sequence serves every image, whatever its origin: identity rows, the
 * image's own clipboard actions, its own operations (align / rotate / flip /
 * reset width), then the file-operation block. A row is greyed when the
 * capability it needs is missing — never hidden — so the menu keeps the same
 * shape and the same row positions whether the image is DIAA-managed, rendered
 * by Obsidian itself, or remote.
 *
 * The menu is a DOM menu (`DomMenu`) rather than Obsidian's `Menu`, because the
 * caret rows need hover submenus, which the native API has no notion of.
 */

import { FileSystemAdapter, Notice, Platform, type App, type Editor, type TFile } from 'obsidian';
import {
    applyOrientationState,
    findEmbedLine,
    lineOrientation,
    resetOrientationOnLine,
    type OrientationSizing,
} from './orientationEdit';
import { MENU_TEXT, NOTICE_DONE, NOTICE_FAILED } from './menuLabels';
import { viewOfElement } from './quietWrite';
import {
    findMarkdownViewForElement,
    getBestHttpImageSource,
    isRemoteImage,
    isSvgSource,
    remoteImageName,
} from './imageSource';
import { copyImageToClipboard, copyRemoteImageToClipboard } from './clipboard';
import { resolveImageFile } from './imageFile';
import {
    addDimensionsMenuItem,
    addFileOperationMenuItems,
    addMenuItem,
    type FileOperationContext,
} from './menuBuilder';
import { DomMenu, closeAllMenus, createMenuRowEl, attachHoverSubmenu } from './menuUi';
import type { SingleResetTarget } from '../imageRender/imageMarkers';
import type { ImageMenuFacade } from './imageMenuHost';
import {
    cutImage,
    cutMenuItemEnabled,
    resolveClickedSourceLine,
    CUT_IMAGE_FAILED,
    CUT_IMAGE_ICON,
    CUT_IMAGE_TITLE,
} from './cutImage';
import {
    composeOrientation,
    IDENTITY_STATE,
    isIdentityOrientation,
    type OrientationState,
    type TransformOp,
} from '../imageTransform/orientation';
import { pinScreenWidthForTurn } from '../imageTransform/transformPreview';
import type { EditorView } from '@codemirror/view';
import * as scrollDiag from '../scrollSync/scrollDiag';

type AlignValue = 'left' | 'center' | 'right';

export interface UnifiedMenuContext {
    app: App;
    facade: ImageMenuFacade;
}

/** Everything the assembly needs to decide each row's availability. */
interface ImageCapabilities {
    /** Vault file behind the image; null for a remote image or one that won't resolve. */
    imgFile: TFile | null;
    /** Note the image was clicked in; null when it could not be resolved. */
    noteFile: TFile | null;
    editor: Editor | null;
    /** The renderer attached DIAA's alignment channel to this image. */
    managed: boolean;
    /** src is an external http(s) URL. */
    remote: boolean;
    /** Vector source — excluded from the bitmap-only rows. */
    svg: boolean;
    readingMode: boolean;
    /** The remote image's own URL ('' for a vault image). */
    url: string;
}

// Guards against two async menu builds racing each other (rapid right-clicks).
let buildSeq = 0;

/** Current per-image alignment + the DIAA callback that persists it. */
function diaaAlignment(img: HTMLImageElement): {
    alignment: AlignValue | undefined;
    onAlign?: (a: AlignValue | undefined) => void;
} {
    const alignment = img.__diaa_alignment;
    const onAlign = img.__diaa_onAlign ?? undefined;
    return { alignment, onAlign };
}

/** True when this image is the sole member of a manually-sized single row. */
function diaIsManualSingle(img: HTMLImageElement): boolean {
    const fn = img.__diaa_manualSingle;
    return typeof fn === 'function' ? Boolean(fn()) : false;
}

/** What the size setting resolves to, or null when the renderer attached no
 *  such marker (an image DIAA never laid out). */
function diaResetTarget(img: HTMLImageElement): SingleResetTarget | null {
    const fn = img.__diaa_resetTarget;
    return typeof fn === 'function' ? fn() : null;
}

/**
 * The reset-width row's label, as the size setting currently reads. Fixed mode
 * names the number the row returns to; natural mode names the mode instead,
 * because there the reset returns each image to its own pixel size — a figure
 * that differs per image and so cannot be shown on a shared row.
 */
function resetWidthLabel(target: SingleResetTarget | null): string {
    if (!target) return MENU_TEXT.resetToSettingWidth;
    if (target.mode === 'fixed') {
        return `${MENU_TEXT.resetToSettingWidth} ${Math.round(target.width)}`;
    }
    return MENU_TEXT.resetToNaturalWidth;
}

/** Add a divider only when there is something above it and it is not one already. */
function addSeparatorIfNeeded(menu: DomMenu): void {
    const last = menu.rootEl.lastElementChild;
    if (last && !last.classList.contains('diaa-menu-sep')) menu.addSeparator();
}

/**
 * "Align image ▸" hover submenu. Writes go through the callback the renderer
 * (Live Preview CM dispatch / Reading Mode rmAlignStore buffer) attached to the
 * image, so DIAA's own persist path is untouched. An image with no such callback
 * renders the row greyed, keeping its position in the stack.
 */
function addAlignSubmenu(menu: DomMenu, img: HTMLImageElement): void {
    const { alignment, onAlign } = diaaAlignment(img);

    const parentRow = createMenuRowEl(MENU_TEXT.alignImage, 'align-left', true);
    menu.appendRowEl(parentRow);
    if (!onAlign) {
        parentRow.classList.add('diaa-menu-item-disabled');
        return;
    }

    attachHoverSubmenu(parentRow, () => {
        const sub = new DomMenu();
        const options: Array<{ label: string; value: AlignValue | undefined }> = [
            { label: MENU_TEXT.alignLeft, value: 'left' },
            { label: MENU_TEXT.alignCenter, value: 'center' },
            { label: MENU_TEXT.alignRight, value: 'right' },
        ];
        for (const option of options) {
            const checked = alignment === option.value;
            sub.addItem(item => {
                if (checked) item.setIcon('check');
                item.setTitle(option.label);
                item.onClick(() => onAlign(option.value));
            });
        }
        sub.addSeparator();
        const resetChecked = alignment === undefined;
        sub.addItem(item => {
            if (resetChecked) item.setIcon('check');
            item.setTitle(MENU_TEXT.alignReset);
            item.onClick(() => onAlign(undefined));
        });
        return sub;
    });
}

/**
 * "Copy image" — put the bitmap on the clipboard, and alongside it a text
 * flavour so an editor paste can land as a reference rather than a duplicate
 * attachment. `run` varies with the pixel source: a remote image has to be
 * fetched, a rendered one is drawn straight off the element.
 */
function addCopyImage(menu: DomMenu, run: () => Promise<void>, disabled: boolean): void {
    addMenuItem(
        menu,
        MENU_TEXT.copyImage,
        async () => {
            await run();
            new Notice(NOTICE_DONE.imageCopied);
        },
        { icon: 'copy', failureNotice: NOTICE_FAILED.failedToCopyImage, disabled }
    );
}

/**
 * "Cut image": copies the bitmap, then drops one reference — and the file too
 * when nothing else in the vault points at it.
 *
 * Enabled only where the target reference can be pinned down and the note may be
 * rewritten (see `cutMenuItemEnabled`); every other image renders the row greyed.
 */
function addCutImageItem(
    menu: DomMenu,
    facade: ImageMenuFacade,
    img: HTMLImageElement,
    target: { imgFile: TFile; noteFile: TFile; editor: Editor | null } | null,
    disabled: boolean
): void {
    addMenuItem(
        menu,
        CUT_IMAGE_TITLE,
        () => {
            if (!target) return;
            return cutImage(facade, img, target.imgFile, target.noteFile, target.editor);
        },
        { icon: CUT_IMAGE_ICON, failureNotice: CUT_IMAGE_FAILED, disabled }
    );
}

/**
 * "Copy path ▸" hover submenu: Obsidian URL, vault-relative path, and absolute
 * filesystem path. Greyed as a whole without a vault file — the caret is kept so
 * the row occupies the same slot a remote image fills with "复制图像 URL".
 * The Obsidian URL is built by hand because Obsidian exposes no `getObsidianUrl`.
 */
function addCopyPathSubmenu(menu: DomMenu, app: App, imgFile: TFile | null): void {
    const parentRow = createMenuRowEl(MENU_TEXT.copyPath, 'link', true);
    menu.appendRowEl(parentRow);
    if (!imgFile) {
        parentRow.classList.add('diaa-menu-item-disabled');
        return;
    }

    attachHoverSubmenu(parentRow, () => {
        const sub = new DomMenu();
        const vaultEncoded = encodeURIComponent(app.vault.getName());
        const fileEncoded = encodeURIComponent(imgFile.path);

        addMenuItem(
            sub,
            MENU_TEXT.obsidianUrl,
            async () => {
                await navigator.clipboard.writeText(
                    `obsidian://open?vault=${vaultEncoded}&file=${fileEncoded}`
                );
                new Notice(NOTICE_DONE.imageUrlCopied);
            },
            { icon: 'lucide-globe', failureNotice: NOTICE_FAILED.failedToCopyUrl }
        );
        addMenuItem(
            sub,
            MENU_TEXT.vaultRelativePath,
            async () => {
                await navigator.clipboard.writeText(imgFile.path);
                new Notice(NOTICE_DONE.filePathCopied);
            },
            { icon: 'lucide-file-text', failureNotice: NOTICE_FAILED.failedToCopyPath }
        );
        addMenuItem(
            sub,
            MENU_TEXT.absolutePath,
            async () => {
                const adapter = app.vault.adapter;
                if (!(adapter instanceof FileSystemAdapter)) {
                    new Notice(NOTICE_FAILED.cannotCopyPath);
                    return;
                }
                await navigator.clipboard.writeText(adapter.getFullPath(imgFile.path));
                new Notice(NOTICE_DONE.filePathCopied);
            },
            { icon: 'lucide-hard-drive', failureNotice: NOTICE_FAILED.failedToCopyPath }
        );
        return sub;
    });
}

/** "Copy image URL" — a remote image's stand-in for the path submenu. */
function addCopyUrl(menu: DomMenu, url: string, disabled: boolean): void {
    addMenuItem(
        menu,
        MENU_TEXT.copyImageUrl,
        async () => {
            await navigator.clipboard.writeText(url);
            new Notice(NOTICE_DONE.imageUrlCopied);
        },
        { icon: 'link', failureNotice: NOTICE_FAILED.failedToCopyUrl, disabled }
    );
}

/**
 * "重置为设置宽度 {W}" / "重置为自然尺寸（…）": flip a manual single-image row back
 * to setting-driven (S=1 → S=0), so it re-derives its width from the size
 * setting. The label names whatever that setting currently resolves to, read
 * live from the renderer. Always rendered; enabled only for a manual single row
 * outside Reading Mode.
 */
function addResetToSettingWidthItem(
    menu: DomMenu,
    img: HTMLImageElement,
    disabled: boolean
): void {
    addMenuItem(
        menu,
        resetWidthLabel(diaResetTarget(img)),
        () => { img.__diaa_resetSingleManual?.(); },
        { icon: 'reset', failureNotice: NOTICE_FAILED.resetWidthFailed, disabled }
    );
}

/** The five rotate/flip operations offered in the transform submenu. */
const TRANSFORM_ACTIONS: Array<{ label: string; op: TransformOp }> = [
    { label: MENU_TEXT.rotate90ccw, op: 'rotate90ccw' },
    { label: MENU_TEXT.rotate90cw, op: 'rotate90cw' },
    { label: MENU_TEXT.rotate180, op: 'rotate180' },
    { label: MENU_TEXT.flipHorizontal, op: 'flipHorizontal' },
    { label: MENU_TEXT.flipVertical, op: 'flipVertical' },
];

/**
 * Where a rotate/flip gets written: the editor, the source line the image sits
 * on, and the orientation that line currently declares. Null when no line can
 * be pinned down — without one there is nothing to rewrite.
 */
interface TransformTarget {
    editor: Editor;
    line: number;
    state: OrientationState;
    /** The element that was right-clicked: the renderer hangs its live width
     *  off it, which a frame-changing turn has to move. */
    img: HTMLImageElement;
    /** The line's text before the write — the diag probe's pre-write snapshot. */
    lineText: string;
    /** CodeMirror view behind the editor: the scroll-jump probe reads it, and
     *  the write uses it to hold the viewport. */
    view: EditorView | null;
}

/** The link targets an embed of `file` may spell, most specific first. */
function embedTargets(file: TFile): string[] {
    const stem = file.name.replace(/\.[^.]+$/, '');
    return [
        file.path,
        file.name,
        stem,
        encodeURIComponent(file.path),
        encodeURIComponent(file.name),
    ];
}

/**
 * Resolve the line to write to.  A DIAA-managed image carries its row anchor, so
 * the line is exact.  An image on a text-bearing line carries none — there the
 * line is found by content, and only when exactly one line holds exactly one
 * embed of this file; anything ambiguous is refused rather than guessed at.
 */
function resolveTransformTarget(
    img: HTMLImageElement,
    imgFile: TFile | null,
    editor: Editor | null
): TransformTarget | null {
    if (!editor) return null;
    const text = editor.getValue();
    const line = resolveClickedSourceLine(img)
        ?? (imgFile ? findEmbedLine(text, embedTargets(imgFile)) : null);
    if (line === null) return null;
    const lines = text.split('\n');
    if (line < 0 || line >= lines.length) return null;
    return {
        editor,
        line,
        state: lineOrientation(lines[line]),
        img,
        lineText: lines[line],
        view: viewOfElement(img),
    };
}

/**
 * The width a frame-changing turn has to write for the picture to come out the
 * size it went in at.
 *
 * A lone image's `W` is the width it takes on the page, while the layout box it
 * is drawn from holds the un-rotated bitmap; a quarter turn repaints that box on
 * its side, so the page width moves by one aspect when the box is held put.
 * Holding the box put is what "rotating does not resize" means.  Null when the
 * turn leaves the box's handedness alone (180° and both flips — the width is
 * already right), when the marked element is not a lone row, or when the bitmap
 * has not loaded and so has no aspect to convert by.
 *
 * The width comes from the renderer's model, never from a measurement: a box
 * clamped by a transiently-narrow container would write that clamp into the note.
 */
function pinnedSizing(
    target: TransformTarget,
    next: OrientationState
): OrientationSizing | undefined {
    const screenWidth = target.img.__diaa_screenWidth?.() ?? null;
    if (screenWidth === null) return undefined;
    const { naturalWidth, naturalHeight } = target.img;
    if (!(naturalWidth > 0 && naturalHeight > 0)) return undefined;
    const moved = pinScreenWidthForTurn(
        screenWidth,
        naturalWidth / naturalHeight,
        target.state,
        next
    );
    return moved === null ? undefined : { sFlag: '1', widthPx: Math.max(1, Math.round(moved)) };
}

function applyTransformOp(target: TransformTarget, op: TransformOp): void {
    const next = composeOrientation(target.state, op);
    scrollDiag.openRotationWindow(target.view, target.line, target.lineText);
    const sizing = pinnedSizing(target, next);
    const ok = applyOrientationState(target.editor, target.line, next, target.view, sizing);
    scrollDiag.note('op applied', { op, ok, sizing });
    if (!ok) {
        new Notice(NOTICE_FAILED.transformFailed);
    }
}

/** Rewrite the line's orientation back to identity — explicitly, since a line
 *  that carries the slot keeps it (`|orig|…`) rather than silently dropping it. */
function resetTransform(target: TransformTarget): void {
    scrollDiag.openRotationWindow(target.view, target.line, target.lineText);
    // Returning to the original orientation unwinds a quarter turn too, so it
    // moves the page width by the same aspect the turn did.
    const sizing = pinnedSizing(target, IDENTITY_STATE);
    const ok = resetOrientationOnLine(target.editor, target.line, target.view, sizing);
    scrollDiag.note('reset applied', { ok, sizing });
    if (!ok) {
        new Notice(NOTICE_FAILED.transformFailed);
    }
}

/**
 * "旋转 / 翻转 ▸" — composes each click onto the orientation the target line
 * declares and writes the word straight back into that line, so the rotation
 * rides in the note text: undoable, synced, and free of any re-encode of the
 * image file. Format is no longer a reason to grey the row out. A "重置旋转"
 * row joins the submenu once the line is no longer identity. Greyed in Reading
 * Mode and whenever no writable line can be pinned down.
 */
function addTransformGroup(menu: DomMenu, target: TransformTarget | null, disabled: boolean): void {
    const parentRow = createMenuRowEl(MENU_TEXT.transform, 'rotate-cw', true);
    menu.appendRowEl(parentRow);
    if (disabled || !target) {
        parentRow.classList.add('diaa-menu-item-disabled');
        return;
    }

    attachHoverSubmenu(parentRow, () => {
        const sub = new DomMenu();
        for (const action of TRANSFORM_ACTIONS) {
            sub.addItem(item => {
                item.setTitle(action.label);
                item.onClick(() => applyTransformOp(target, action.op));
            });
        }
        if (!isIdentityOrientation(target.state)) {
            sub.addSeparator();
            sub.addItem(item => {
                item.setTitle(MENU_TEXT.transformReset);
                item.onClick(() => resetTransform(target));
            });
        }
        return sub;
    });
}

/**
 * Build + show the context menu for a right-clicked image inside a markdown note.
 * The caller has already confirmed the target is a note image and suppressed the
 * native menu, so this function owns showing entirely.
 */
export async function openUnifiedImageMenu(
    event: MouseEvent,
    img: HTMLImageElement,
    { app, facade }: UnifiedMenuContext
): Promise<void> {
    const seq = ++buildSeq;
    closeAllMenus();
    const mdView = findMarkdownViewForElement(app, img);
    const activeFile = mdView?.file ?? null;
    const readingMode =
        mdView?.getMode() === 'preview' ||
        Boolean(img.closest('.markdown-preview-view'));
    const settings = facade.settings;

    const remote = isRemoteImage(img);
    const url = remote ? getBestHttpImageSource(img) : '';
    const imgFile = !remote && activeFile
        ? resolveImageFile(app, img, activeFile.path)
        : null;
    const noteFile = activeFile;
    const svg = isSvgSource(img) || imgFile?.extension.toLowerCase() === 'svg';

    const cap: ImageCapabilities = {
        imgFile,
        noteFile,
        editor: mdView?.editor ?? null,
        managed: Boolean(img.__diaa_onAlign),
        remote,
        svg,
        readingMode,
        url,
    };
    const target = cap.imgFile && cap.noteFile
        ? { imgFile: cap.imgFile, noteFile: cap.noteFile, editor: cap.editor }
        : null;

    const menu = new DomMenu();

    // ── Group 1: identity + clipboard ──────────────────────────────────────
    if (settings.showImageInfo) {
        addDimensionsMenuItem(
            menu,
            img,
            remote ? remoteImageName(url) : (imgFile?.name ?? ''),
            remote ? 'globe' : 'image'
        );
    }

    addCutImageItem(
        menu,
        facade,
        img,
        target,
        svg || !cutMenuItemEnabled(cap.managed, readingMode)
    );
    addCopyImage(
        menu,
        remote
            ? () => copyRemoteImageToClipboard(url, url)
            : () => copyImageToClipboard(img, {
                reference: imgFile ? `![[${imgFile.path}]]` : undefined,
                vaultSource: imgFile ? { app, file: imgFile } : undefined,
            }),
        svg
    );
    // Same slot either way: a vault image offers its paths, a remote one its URL.
    if (remote) {
        addCopyUrl(menu, url, false);
    } else {
        addCopyPathSubmenu(menu, app, imgFile);
    }

    // ── Group 2: the image's own operations, no dividers inside ────────────
    addSeparatorIfNeeded(menu);
    addAlignSubmenu(menu, img);
    // A rotation is a note edit, so the row needs a writable line: the image's
    // own DIAA anchor, or — for an image on a text-bearing line — the one
    // unambiguous embed line the upgrade path can rewrite into a row.
    const transformTarget = readingMode ? null : resolveTransformTarget(img, imgFile, cap.editor);
    addTransformGroup(menu, transformTarget, readingMode);
    addResetToSettingWidthItem(
        menu,
        img,
        readingMode || !cap.managed || !diaIsManualSingle(img)
    );

    // ── Group 3: file operations ───────────────────────────────────────────
    if (!Platform.isMobile) {
        const ctx: FileOperationContext = {
            app,
            facade,
            img,
            imgFile,
            noteFile,
            editor: cap.editor,
            canRemoveReference: cutMenuItemEnabled(cap.managed, readingMode),
        };
        addSeparatorIfNeeded(menu);
        addFileOperationMenuItems(menu, ctx, settings, remote);
    }

    if (seq !== buildSeq) return;
    if (!menu.rootEl.hasChildNodes()) return;
    menu.showAt(event.clientX, event.clientY);
}
