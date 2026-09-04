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

/** True when the image is the sole member of a single-image row. */
function diaIsSingleRow(img: HTMLImageElement): boolean {
    const fn = (img as any).__diaa_singleRow;
    return typeof fn === 'function' ? Boolean(fn()) : true;
}

/** Pixel width a manual single row adopts when reset to the size setting. */
function diaResetTargetWidth(img: HTMLImageElement): number {
    const fn = (img as any).__diaa_resetTargetWidth;
    return typeof fn === 'function' ? Math.round(Number(fn()) || 0) : 0;
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
 * "调整为原图宽度的... ▸" hover submenu for a DIA-managed image: one caret
 * parent row that opens into the numeric percentage presets from the shared
 * `customResizeSizes` setting. Only percentage entries make sense — an absolute
 * px entry has no meaning for a row member — so px entries are skipped and each
 * child shows the bare percentage (e.g. `25%`). Writes route through the
 * renderer's `__diaa_onResize`.
 *
 * Gate (per user spec): the presets act on a single-image row in Live Preview
 * only, so the parent greys out for multi-member rows (divider drag is the
 * resize path there) and for Reading Mode's read-only surface.
 */
function addDiaResizeSizesSubmenu(
    menu: DomMenu,
    facade: PixelPerfectFacade,
    img: HTMLImageElement,
    modeDisabled: boolean
): boolean {
    if (!diaResizeEnabled(img)) return false;
    const natural = diaNaturalWidth(img);
    const singleRow = diaIsSingleRow(img);
    const amounts = facade.host.settings.customResizeSizes
        .map(parseResizeSize)
        .filter((parsed): parsed is NonNullable<typeof parsed> => parsed !== null && parsed.unit === '%')
        .map(parsed => parsed.amount);
    if (amounts.length === 0) return false;

    const parentRow = createMenuRowEl('调整为原图宽度的...', 'percent', true);
    menu.appendRowEl(parentRow);
    if (modeDisabled || !singleRow || natural <= 0) {
        parentRow.classList.add('diaa-menu-item-disabled');
        return true;
    }

    attachHoverSubmenu(parentRow, () => {
        const sub = new DomMenu();
        const rectW = img.getBoundingClientRect().width;
        const shownPct = natural > 0 && rectW > 0 ? Math.round((rectW / natural) * 100) : null;
        const resize = (img as any).__diaa_onResize as ((pct: number) => unknown) | undefined;
        for (const amount of amounts) {
            sub.addItem(item => {
                if (shownPct !== null && shownPct === amount) item.setDisabled(true);
                item.setTitle(`${amount}%`);
                item.onClick(() => {
                    if (typeof resize !== 'function') return;
                    Promise.resolve()
                        .then(() => resize(amount))
                        .catch(() => new Notice(strings.notices.failedToResizeTo.replace('{size}', `${amount}%`)));
                });
            });
        }
        return sub;
    });
    return true;
}

/**
 * "重置为设置宽度 {W}": flip a manual single-image row back to setting-driven
 * (S=1 → S=0).  Always visible on DIA-managed images so the affordance is stable;
 * enabled only when the image is a manual single row in Live Preview and a reset
 * target width is known — every other case renders greyed and does nothing.
 */
function addDiaResetToSettingItem(menu: DomMenu, facade: PixelPerfectFacade, img: HTMLImageElement, modeDisabled: boolean): void {
    if (typeof (img as any).__diaa_resetSingleManual !== 'function') return;
    const target = diaResetTargetWidth(img);
    const enabled = !modeDisabled && diaIsManualSingle(img) && target > 0;
    facade.menuService.addMenuItem(
        menu,
        `重置为设置宽度 ${target}`,
        'reset',
        async () => (img as any).__diaa_resetSingleManual(),
        '重置宽度失败',
        !enabled
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

        // Group 1 — identity + clipboard at the very top: filename / dimensions
        // info (setting-gated), then for DIA-managed images "copy image" and
        // "copy local path". All image operations live in group 2, so the four of
        // them stay in one contiguous block with a single divider above it.
        if (resolved && facade.host.settings.showFileInfo) {
            await facade.menuService.addDimensionsMenuItem(menu, img, resolved, currentWidth);
        }
        let hadGroup1 = resolved !== null && facade.host.settings.showFileInfo;
        if (resolved && managed) {
            const svg = resolved.imgFile.extension.toLowerCase() === 'svg' || isSvgSource(img);
            if (!svg) {
                addCopyImage(menu, facade, img);
                hadGroup1 = true;
            }
            addCopyPathSubmenu(menu, app, facade, resolved.imgFile);
            hadGroup1 = true;
        }

        // Editing is Live-Preview/Source only, so rotate / flip renders greyed-out
        // in Reading Mode and for formats (svg/gif/avif) that cannot be re-encoded
        // when the note closes.
        const transformDisabled =
            isReadingMode || (resolved !== null && isTransformFormatUnsupported(resolved.imgFile));

        if (managed) {
            // Group 2 — the four image operations as one contiguous block with no
            // internal separators: alignment → rotate / flip → resize preset →
            // reset to the setting width.
            if (hadGroup1) menu.addSeparator();
            addAlignSubmenu(menu, img);
            if (resolved) {
                addTransformGroup(menu, { img, resolved, activeFile }, transformDisabled);
                addDiaResizeSizesSubmenu(menu, facade, img, isReadingMode);
                addDiaResetToSettingItem(menu, facade, img, isReadingMode);
            }
        } else if (resolved) {
            // Non-DIA images: rotate / flip, then the PP resize items (their copy
            // image / copy local path rows and dividers are self-contained) under
            // a single divider.
            const transformAdded = addTransformGroup(
                menu,
                { img, resolved, activeFile },
                transformDisabled
            );
            if (hadGroup1 || transformAdded) menu.addSeparator();
            await facade.menuService.addResizeMenuItems(menu, img, resolved, currentWidth, isReadingMode);
        }
        if (resolved && !Platform.isMobile) {
            facade.menuService.addFileOperationMenuItems(menu, resolved.imgFile);
        }
    }

    if (seq !== buildSeq) return;
    if (!menu.rootEl.hasChildNodes()) return;
    menu.showAt(event.clientX, event.clientY);
}
