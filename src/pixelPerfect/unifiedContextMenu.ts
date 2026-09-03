import { FileSystemAdapter, Notice, Platform, type App, type TFile } from 'obsidian';
import { strings } from '../vendor/pixelPerfectImage/i18n';
import { parseResizeSize } from '../vendor/pixelPerfectImage/ui/settings';
import {
    findMarkdownViewForElement,
    getBestHttpImageSource,
    getImageSourceCandidates,
    isRemoteImage
} from '../vendor/pixelPerfectImage/utils/utils';
import { DomMenu, closeAllMenus, createMenuRowEl, attachHoverSubmenu } from './menuUi';
import type { PixelPerfectFacade } from './pixelPerfectHost';
import {
  composeOrientation,
  IDENTITY_STATE,
  isIdentityOrientation,
  type TransformOp,
} from '../imageTransform/orientation';
import {
  getPendingState,
  setPendingTransform,
  clearPendingTransform,
} from '../imageTransform/transformStore';
import {
  applyOrientationPreview,
  clearOrientationPreview,
} from '../imageTransform/transformPreview';

type AlignValue = 'left' | 'center' | 'right';

/**
 * Target for the rotate / flip group (P3): the <img> that receives the CSS
 * preview, its resolved vault file (persistence path + format gating) and the
 * active markdown note (whose close triggers the single disk write).
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

/** True when the DIA Live Preview renderer attached a resize surface to img. */
function diaResizeEnabled(img: HTMLImageElement): boolean {
    return (img as any).__diaa_resizeEnabled === true && typeof (img as any).__diaa_onResize === 'function';
}

/** Natural pixel width of a DIA-managed image, read live (0 when unknown). */
function diaNaturalWidth(img: HTMLImageElement): number {
    const fn = (img as any).__diaa_naturalWidth;
    if (typeof fn === 'function') return Number(fn()) || 0;
    return img.naturalWidth || 0;
}

function diaIsManualSingle(img: HTMLImageElement): boolean {
    const fn = (img as any).__diaa_manualSingle;
    return typeof fn === 'function' ? Boolean(fn()) : false;
}

/**
 * Formats the rotate/flip disk write cannot preserve: svg (vector), gif and avif
 * (canvas re-encode would silently fall back to PNG). Those rows render greyed.
 */
function isTransformFormatUnsupported(file: TFile): boolean {
    return file.extension.toLowerCase() === 'svg'
        || file.extension.toLowerCase() === 'gif'
        || file.extension.toLowerCase() === 'avif';
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

    attachHoverSubmenu(parentRow, () => {
        const sub = new DomMenu();
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
        return sub;
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

/**
 * "Copy path ▸" hover submenu for local (DIA-managed) images: Obsidian URL,
 * vault-relative path, and absolute filesystem path. The Obsidian URL is built
 * by hand because Obsidian exposes no `getObsidianUrl` API.
 */
function addCopyPathSubmenu(menu: DomMenu, app: App, facade: PixelPerfectFacade, imgFile: TFile): void {
    const parentRow = createMenuRowEl(strings.menu.copyLocalPath, 'link', true);
    menu.appendRowEl(parentRow);

    attachHoverSubmenu(parentRow, () => {
        const sub = new DomMenu();
        const vaultEncoded = encodeURIComponent(app.vault.getName());
        const fileEncoded = encodeURIComponent(imgFile.path);

        facade.menuService.addMenuItem(
            sub,
            'Obsidian URL',
            'lucide-globe',
            async () => {
                await navigator.clipboard.writeText(`obsidian://open?vault=${vaultEncoded}&file=${fileEncoded}`);
                new Notice(strings.notices.imageUrlCopied);
            },
            strings.notices.failedToCopyUrl
        );
        facade.menuService.addMenuItem(
            sub,
            '基于库的相对路径',
            'lucide-file-text',
            async () => {
                await navigator.clipboard.writeText(imgFile.path);
                new Notice(strings.notices.filePathCopied);
            },
            strings.notices.failedToCopyPath
        );
        facade.menuService.addMenuItem(
            sub,
            '绝对路径',
            'lucide-hard-drive',
            async () => {
                const adapter = app.vault.adapter;
                if (!(adapter instanceof FileSystemAdapter)) {
                    new Notice(strings.notices.cannotCopyPath);
                    return;
                }
                await navigator.clipboard.writeText(adapter.getFullPath(imgFile.path));
                new Notice(strings.notices.filePathCopied);
            },
            strings.notices.failedToCopyPath
        );
        return sub;
    });
}

/**
 * Add the PP "resize to X%" presets (from the shared `customResizeSizes`
 * setting) for a DIA-managed image. Only percentage entries make sense on DIA
 * flex rows — an absolute px entry has no meaning for a weighted member — so px
 * entries are skipped. Writes route through the renderer's `__diaa_onResize`,
 * which handles single-image (`S=1` pixel width) and multi-member (flex-weight
 * rebalance) semantics. Returns true when any row was added.
 */
function addDiaManagedResizeSizes(menu: DomMenu, facade: PixelPerfectFacade, img: HTMLImageElement, modeDisabled: boolean): boolean {
    if (!diaResizeEnabled(img)) return false;
    const natural = diaNaturalWidth(img);
    const sizes = facade.host.settings.customResizeSizes;
    let added = false;

    for (const sizeStr of sizes) {
        const parsed = parseResizeSize(sizeStr);
        if (!parsed || parsed.unit !== '%') continue;
        const rectW = img.getBoundingClientRect().width;
        const shownPct = natural > 0 && rectW > 0 ? Math.round((rectW / natural) * 100) : null;
        const disabled = modeDisabled || natural <= 0 || (shownPct !== null && shownPct === parsed.amount);
        if (!added) {
            menu.addSeparator();
            added = true;
        }
        facade.menuService.addMenuItem(
            menu,
            strings.menu.resizeTo.replace('{size}', sizeStr),
            parsed.amount === 100 ? 'image' : 'percent',
            async () => (img as any).__diaa_onResize(parsed.amount),
            strings.notices.failedToResizeTo.replace('{size}', sizeStr),
            disabled
        );
    }
    return added;
}

/** "Remove custom size": flip a manual single-image row back to setting-driven. */
function addDiaRemoveCustomSize(menu: DomMenu, facade: PixelPerfectFacade, img: HTMLImageElement, modeDisabled: boolean): void {
    if (typeof (img as any).__diaa_resetSingleManual !== 'function') return;
    if (!diaIsManualSingle(img)) return;
    facade.menuService.addMenuItem(
        menu,
        strings.menu.removeCustomSize,
        'reset',
        async () => (img as any).__diaa_resetSingleManual(),
        strings.notices.failedToRemoveSize,
        modeDisabled
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

/** The five rotate/flip operations offered in the transform submenu. */
const TRANSFORM_ACTIONS: Array<{ label: string; op: TransformOp }> = [
    { label: '向左旋转 90°', op: 'rotate90ccw' },
    { label: '向右旋转 90°', op: 'rotate90cw' },
    { label: '旋转 180°', op: 'rotate180' },
    { label: '水平翻转', op: 'flipHorizontal' },
    { label: '垂直翻转', op: 'flipVertical' },
];

function applyTransformOp(
    img: HTMLImageElement,
    imagePath: string,
    notePath: string,
    op: TransformOp
): void {
    const current = getPendingState(imagePath) ?? IDENTITY_STATE;
    const next = composeOrientation(current, op);
    setPendingTransform(imagePath, notePath, next);
    applyOrientationPreview(img, next);
}

function resetTransform(img: HTMLImageElement, imagePath: string): void {
    clearPendingTransform(imagePath);
    clearOrientationPreview(img);
}

/**
 * Middle group — rotate / flip (P3). Renders a "旋转 / 翻转 ▸" hover submenu that
 * composes each click onto the image's in-session orientation (CSS preview) and
 * records it for the single cumulative disk write when the note closes. When
 * `disabled` (Reading Mode, or an svg/gif/avif that cannot be re-encoded) the
 * whole group renders greyed-out. Returns true when a row was appended.
 */
function addTransformGroup(
    menu: DomMenu,
    target: TransformTarget,
    disabled: boolean
): boolean {
    const imgFile = target.resolved?.imgFile ?? null;
    const imagePath = imgFile?.path ?? '';
    const notePath = target.activeFile?.path ?? '';
    if (!imgFile || !imagePath) return false;

    const parentRow = createMenuRowEl('旋转 / 翻转', 'rotate-cw', true);
    menu.appendRowEl(parentRow);
    if (disabled) {
        parentRow.classList.add('diaa-menu-item-disabled');
        return true;
    }

    const img = target.img;
    attachHoverSubmenu(parentRow, () => {
        const sub = new DomMenu();
        for (const action of TRANSFORM_ACTIONS) {
            sub.addItem(item => {
                item.setTitle(action.label);
                item.onClick(() => applyTransformOp(img, imagePath, notePath, action.op));
            });
        }
        const state = getPendingState(imagePath) ?? IDENTITY_STATE;
        if (!isIdentityOrientation(state)) {
            sub.addSeparator();
            sub.addItem(item => {
                item.setTitle('重置旋转');
                item.onClick(() => resetTransform(img, imagePath));
            });
        }
        return sub;
    });
    return true;
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
    const isReadingMode =
        mdView?.getMode() === 'preview' ||
        Boolean(img.closest('.markdown-preview-view'));
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
        await facade.menuService.addRemoteResizeMenuItems(menu, img, activeFile, url, isReadingMode);
    } else {
        const resolved = activeFile
            ? await facade.host.fileService.getImageFileWithErrorHandling(img, false, activeFile)
            : null;
        const currentWidth = resolved
            ? facade.host.imageService.getCurrentImageWidth(resolved.activeFile, resolved.imgFile)
            : null;

        // Top: filename/dimensions info first, then the DIA per-image alignment
        // and rotate/flip actions clustered beneath it (alignment sits directly
        // above the rotate/flip group).
        if (resolved && facade.host.settings.showFileInfo) {
            await facade.menuService.addDimensionsMenuItem(menu, img, resolved, currentWidth);
        }
        if (managed) addAlignSubmenu(menu, img);
        const hasTop = managed || (resolved !== null && facade.host.settings.showFileInfo);

        // Middle: rotate / flip (P3). Editing is Live-Preview/Source only, so the
        // group renders greyed-out in Reading Mode and for formats (svg/gif/avif)
        // that cannot be re-encoded when the note closes.
        const transformDisabled =
            isReadingMode || (resolved !== null && isTransformFormatUnsupported(resolved.imgFile));
        let transformAdded = false;
        if (resolved) {
            transformAdded = addTransformGroup(
                menu,
                { img, resolved, activeFile },
                transformDisabled
            );
        }

        // Bottom: PP actions — copy image/path always; size items only meaningful
        // when an editor can persist them, so they grey out in Reading Mode too.
        if (resolved) {
            if (hasTop || transformAdded) menu.addSeparator();
            const svg = resolved.imgFile.extension.toLowerCase() === 'svg' || isSvgSource(img);
            if (managed) {
                if (!svg) addCopyImage(menu, facade, img);
                addCopyPathSubmenu(menu, app, facade, resolved.imgFile);
                addDiaManagedResizeSizes(menu, facade, img, isReadingMode);
                addDiaRemoveCustomSize(menu, facade, img, isReadingMode);
            } else {
                await facade.menuService.addResizeMenuItems(menu, img, resolved, currentWidth, isReadingMode);
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
