import { FileSystemAdapter, Notice, Platform, type App, type TFile } from 'obsidian';
import { strings } from '../vendor/pixelPerfectImage/i18n';
import {
    findMarkdownViewForElement,
    getBestHttpImageSource,
    getImageSourceCandidates,
    isRemoteImage
} from '../vendor/pixelPerfectImage/utils/utils';
import { DomMenu, closeAllMenus, createMenuRowEl } from './menuUi';
import type { PixelPerfectFacade } from './pixelPerfectHost';

type AlignValue = 'left' | 'center' | 'right';

/**
 * Merge seam for the rotate / flip group (P3). Receives everything a transform
 * needs; leaves the middle section empty until that milestone lands.
 */
interface TransformTarget {
    img: HTMLImageElement;
    resolved: { activeFile: TFile; imgFile: TFile } | null;
    activeFile: TFile | null;
}

export interface UnifiedMenuContext {
    app: App;
    facade: PixelPerfectFacade;
}

// Guards against two async menu builds racing each other (rapid right-clicks).
let buildSeq = 0;

function isDiaManaged(img: HTMLImageElement): boolean {
    return Boolean((img as any).__diaa_onAlign);
}

function isSvgSource(img: HTMLImageElement): boolean {
    return getImageSourceCandidates(img).some(src => {
        const normalized = src.trim().toLowerCase();
        if (!normalized) return false;
        if (normalized.startsWith('data:image/svg+xml') || normalized.includes('image/svg+xml')) return true;
        return normalized.split(/[?#]/, 1)[0].endsWith('.svg');
    });
}

/** Current per-image alignment + the DIA callback that persists it. */
function diaaAlignment(img: HTMLImageElement): { alignment: AlignValue | undefined; onAlign?: (a: AlignValue | undefined) => void } {
    const alignment = (img as any).__diaa_alignment as AlignValue | undefined;
    const onAlign = (img as any).__diaa_onAlign as ((a: AlignValue | undefined) => void) | undefined;
    return { alignment, onAlign };
}

/**
 * "Align image ▸" hover submenu (native look via DOM, since Obsidian's Menu
 * API has no submenu support). Writes go through the callback the renderer
 * (Live Preview CM dispatch / Reading Mode rmAlignStore buffer) attached to
 * the image, so DIA's own persist path is untouched.
 */
function addAlignSubmenu(menu: DomMenu, img: HTMLImageElement): void {
    const { alignment, onAlign } = diaaAlignment(img);
    if (!onAlign) return;

    const parentRow = createMenuRowEl('Align image', 'align-left', true);
    menu.appendRowEl(parentRow);

    let sub: DomMenu | null = null;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;

    const clearHide = (): void => {
        if (hideTimer !== null) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
    };
    const hideSub = (): void => {
        clearHide();
        sub?.close();
        sub = null;
    };
    const showSub = (): void => {
        clearHide();
        if (sub) return;
        sub = new DomMenu();
        const options: Array<{ label: string; value: AlignValue | undefined }> = [
            { label: 'Left', value: 'left' },
            { label: 'Center', value: 'center' },
            { label: 'Right', value: 'right' },
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
            item.setTitle('Reset to default');
            item.onClick(() => onAlign(undefined));
        });
        sub.rootEl.addEventListener('mouseenter', clearHide);
        sub.rootEl.addEventListener('mouseleave', () => {
            hideTimer = setTimeout(hideSub, 250);
        });
        sub.showBeside(parentRow.getBoundingClientRect());
    };

    parentRow.addEventListener('mouseenter', showSub);
    parentRow.addEventListener('mouseleave', () => {
        hideTimer = setTimeout(hideSub, 250);
    });
    parentRow.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (sub) hideSub();
        else showSub();
    });
}

// ── PP-style action items driven through MenuService (native PP semantics) ──
function addCopyImage(menu: DomMenu, facade: PixelPerfectFacade, img: HTMLImageElement): void {
    facade.menuService.addMenuItem(
        menu,
        strings.menu.copyImage,
        'copy',
        async () => {
            await facade.host.imageService.copyImageToClipboard(img);
            new Notice(strings.notices.imageCopied);
        },
        strings.notices.failedToCopyImage
    );
}

function addCopyLocalPath(menu: DomMenu, app: App, facade: PixelPerfectFacade, imgFile: TFile): void {
    facade.menuService.addMenuItem(
        menu,
        strings.menu.copyLocalPath,
        'link',
        async () => {
            const adapter = app.vault.adapter;
            if (!(adapter instanceof FileSystemAdapter)) {
                new Notice(strings.notices.cannotCopyPath);
                return;
            }
            const fullPath = adapter.getFullPath(imgFile.path);
            await navigator.clipboard.writeText(fullPath);
            new Notice(strings.notices.filePathCopied);
        },
        strings.notices.failedToCopyPath
    );
}

function addCopyUrl(menu: DomMenu, facade: PixelPerfectFacade, url: string): void {
    facade.menuService.addMenuItem(
        menu,
        strings.menu.copyImageUrl,
        'link',
        async () => {
            await navigator.clipboard.writeText(url);
            new Notice(strings.notices.imageUrlCopied);
        },
        strings.notices.failedToCopyUrl
    );
}

/** Middle section — rotate / flip are added here in P3. Returns true when rows were added. */
function addTransformGroup(_menu: DomMenu, _target: TransformTarget): boolean {
    // P3: left/right rotate + horizontal/vertical flip (CSS preview in-session,
    // single cumulative disk overwrite on tab close).
    return false;
}

/**
 * Build + show the unified context menu for any image inside a markdown note:
 *   top    — DIA per-image alignment (hover submenu) + filename/dimension info
 *   middle — rotate / flip (P3)
 *   bottom — PP resize sizes, copy, and file operations
 * The caller has already confirmed the target is a note image and suppressed
 * the native menu, so this function owns showing entirely.
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
    const remote = isRemoteImage(img);
    const managed = isDiaManaged(img);

    const menu = new DomMenu();

    if (remote) {
        if (!activeFile) return;
        const url = getBestHttpImageSource(img);
        facade.menuService.addInfoMenuItem(menu, strings.menu.remoteImage, 'globe');
        if (!isSvgSource(img)) addCopyImage(menu, facade, img);
        addCopyUrl(menu, facade, url);
        menu.addSeparator();
        await facade.menuService.addRemoteResizeMenuItems(menu, img, activeFile, url);
    } else {
        const resolved = activeFile
            ? await facade.host.fileService.getImageFileWithErrorHandling(img, false, activeFile)
            : null;
        const currentWidth = resolved
            ? facade.host.imageService.getCurrentImageWidth(resolved.activeFile, resolved.imgFile)
            : null;

        // Top: DIA alignment + (optionally) filename/dimensions info.
        if (managed) addAlignSubmenu(menu, img);
        if (resolved && facade.host.settings.showFileInfo) {
            await facade.menuService.addDimensionsMenuItem(menu, img, resolved, currentWidth);
        }
        const hasTop = managed || (resolved !== null && facade.host.settings.showFileInfo);

        // Middle: rotate / flip (P3). Empty for now, so it adds no separator yet.
        let transformAdded = false;
        if (resolved) {
            transformAdded = addTransformGroup(menu, { img, resolved, activeFile });
        }

        // Bottom: PP actions — copy image/path always; PP size items only on
        // native (non-DIA) embeds (their |param format is PP's). DIA flex rows
        // get their own flex-route resize in P4, so no size items here yet.
        if (resolved) {
            if (hasTop || transformAdded) menu.addSeparator();
            const svg = resolved.imgFile.extension.toLowerCase() === 'svg' || isSvgSource(img);
            if (managed) {
                if (!svg) addCopyImage(menu, facade, img);
                addCopyLocalPath(menu, app, facade, resolved.imgFile);
            } else {
                await facade.menuService.addResizeMenuItems(menu, img, resolved, currentWidth);
            }
            if (!Platform.isMobile) {
                facade.menuService.addFileOperationMenuItems(menu, resolved.imgFile);
            }
        }
    }

    if (seq !== buildSeq) return;
    if (!menu.rootEl.hasChildNodes()) return;
    menu.showAt(event.clientX, event.clientY);
}
