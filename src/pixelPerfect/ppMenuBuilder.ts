import { FileSystemAdapter, type App, Notice, Platform, type TFile } from 'obsidian';
import { logger } from '../logger';
import type { MenuLike } from './menuLike';
import { isSvgSource, isUserVisibleError } from './imageSourceUtils';
import {
  copyImageToClipboard,
  getCurrentExternalImageWidth,
  getCurrentImageWidth,
  getRasterNaturalDimensions,
  parseWidthFromImageAlt,
  readImageDimensions,
  removeExternalImageWidth,
  removeImageWidth,
  resizeExternalImage,
  resizeImage,
} from './imageOps';
import { deleteImageAndLink, openInDefaultApp, renameImage, showInSystemExplorer } from './fileOps';
import { MENU_TEXT, NOTICE_DONE, NOTICE_FAILED, NOTICE_TEMPLATE } from './menuTexts';
import {
  getFileOperationName,
  parseResizeSize,
  type PixelPerfectImageSettings,
} from './ppSettingsModel';

const log = logger.channel('menuBuilder');

/**
 * 把「复制图像 / 尺寸信息 / 缩放预设 / 文件操作」这些菜单行填进任意
 * {@link MenuLike} 菜单。
 *
 * 每条失败路径都带自己的提示语：菜单项点击是 async 的，若不加 catch，失败
 * 会变成静默的 unhandled rejection，用户只看到「点了没反应」。所以统一走
 * {@link createMenuClickHandler} 包一层，日志落盘 + 一句 Notice。
 */

/** 包一层点击处理：动作失败时记日志并提示，而不是抛进虚空。 */
export function createMenuClickHandler(action: () => Promise<void>, errorMessage: string): () => void {
  return () => {
    void action().catch(error => {
      log.error('LOG_MENU_ACTION_FAILED', { errorMessage, error: String(error) });
      new Notice(isUserVisibleError(error) ? error.message : errorMessage);
    });
  };
}

/**
 * 一行普通菜单项。`disabled` 只置灰不隐藏，保证菜单布局稳定；
 * `isWarning` 走 Obsidian 的危险色（如删除）。
 */
export function addMenuItem(
  menu: MenuLike,
  title: string,
  icon: string,
  action: () => Promise<void>,
  errorMessage: string,
  disabled = false,
  isWarning = false
): void {
  menu.addItem(item => {
    item.setTitle(title).setIcon(icon).setDisabled(disabled);
    if (isWarning) item.setWarning(true);
    item.onClick(createMenuClickHandler(action, errorMessage));
  });
}

/** 纯信息行：不可点击，仅用来展示文件名 / 尺寸。 */
export function addInfoMenuItem(menu: MenuLike, title: string, icon: string): void {
  menu.addItem(item => {
    item.setTitle(title).setIcon(icon).setDisabled(true);
  });
}

/** 「复制图像」行，带成功提示。 */
function addCopyImageMenuItem(menu: MenuLike, img: HTMLImageElement): void {
  addMenuItem(
    menu,
    MENU_TEXT.copyImage,
    'copy',
    async () => {
      await copyImageToClipboard(img);
      new Notice(NOTICE_DONE.imageCopied);
    },
    NOTICE_FAILED.failedToCopyImage
  );
}

/** 「复制本地路径」行：复制绝对文件系统路径。 */
function addCopyLocalPathItem(menu: MenuLike, app: App, imgFile: TFile): void {
  addMenuItem(
    menu,
    MENU_TEXT.copyLocalPath,
    'link',
    async () => {
      const adapter = app.vault.adapter;
      if (!(adapter instanceof FileSystemAdapter)) {
        new Notice(NOTICE_FAILED.cannotCopyPath);
        return;
      }
      await navigator.clipboard.writeText(adapter.getFullPath(imgFile.path));
      new Notice(NOTICE_DONE.filePathCopied);
    },
    NOTICE_FAILED.failedToCopyPath
  );
}

/**
 * 顶部两行信息：`文件名 @ 缩放%` 与 `真实宽 × 真实高 px`。
 * 缩放百分比只在链接里设了宽度时才有意义，未设置则不显示 ` @ ..%`。
 */
export async function addDimensionsMenuItem(
  menu: MenuLike,
  app: App,
  img: HTMLImageElement,
  resolved: { activeFile: TFile; imgFile: TFile },
  currentWidth: number | null,
  settings: PixelPerfectImageSettings
): Promise<void> {
  if (!settings.showFileInfo) return;

  try {
    const isSvg = resolved.imgFile.extension.toLowerCase() === 'svg' || isSvgSource(img);

    let width: number;
    let height: number;
    const rasterDimensions = isSvg ? null : getRasterNaturalDimensions(img);
    if (rasterDimensions) {
      ({ width, height } = rasterDimensions);
    } else {
      ({ width, height } = await readImageDimensions(app, resolved.imgFile));
    }

    const widthOverride = currentWidth ?? getCurrentImageWidth(app, resolved.activeFile, resolved.imgFile);
    const currentScale = widthOverride !== null ? Math.round((widthOverride / width) * 100) : null;
    const scaleText = currentScale !== null ? ` @ ${currentScale}%` : '';

    addInfoMenuItem(menu, `${resolved.imgFile.name}${scaleText}`, 'image-file');
    addInfoMenuItem(menu, `${width} × ${height} px`, 'info');
  } catch (error) {
    log.error('LOG_READ_DIMENSIONS_FAILED', { error: String(error) });
    new Notice(isUserVisibleError(error) ? error.message : NOTICE_FAILED.couldNotReadDimensions);
  }
}

/**
 * 尺寸预设块（库内图片）：先「复制图像 / 复制本地路径」，再按设置里的
 * `customResizeSizes` 逐条给出缩放行，最后在设过宽度时给出「移除自定义尺寸」。
 * 当前尺寸那一行置灰，避免重复点击。
 */
export async function addResizeMenuItems(
  menu: MenuLike,
  app: App,
  img: HTMLImageElement,
  resolved: { activeFile: TFile; imgFile: TFile } | null,
  currentWidth: number | null | undefined,
  settings: PixelPerfectImageSettings,
  disableResize = false
): Promise<void> {
  if (!resolved) {
    if (!isSvgSource(img)) addCopyImageMenuItem(menu, img);
    return;
  }

  const { imgFile } = resolved;
  const isSvg = imgFile.extension.toLowerCase() === 'svg' || isSvgSource(img);
  const customWidth =
    currentWidth !== undefined
      ? currentWidth
      : getCurrentImageWidth(app, resolved.activeFile, resolved.imgFile);

  // 复制位图对 SVG 无意义（画布拿到的是空位图），故跳过。
  if (!isSvg) {
    addCopyImageMenuItem(menu, img);
    menu.addSeparator();
  }

  addCopyLocalPathItem(menu, app, imgFile);
  menu.addSeparator();

  let actualWidth: number | null = isSvg ? null : (getRasterNaturalDimensions(img)?.width ?? null);
  if (actualWidth === null) {
    try {
      actualWidth = (await readImageDimensions(app, imgFile)).width;
    } catch {
      actualWidth = null;
    }
  }
  const currentScale =
    customWidth !== null && actualWidth !== null ? Math.round((customWidth / actualWidth) * 100) : null;

  for (const sizeStr of settings.customResizeSizes) {
    const parsed = parseResizeSize(sizeStr);
    if (!parsed) continue;

    const { amount: value, unit } = parsed;
    const isPercentage = unit === '%';
    const disabled =
      disableResize ||
      (isPercentage
        ? isSvg && actualWidth === null
          ? true
          : currentScale === value
        : customWidth === value);
    const icon = isPercentage ? (value === 100 ? 'image' : 'percent') : 'ruler';

    addMenuItem(
      menu,
      MENU_TEXT.resizeTo.replace('{size}', sizeStr),
      icon,
      () => resizeImage(app, img, value, !isPercentage, resolved.activeFile),
      NOTICE_TEMPLATE.failedToResizeTo.replace('{size}', sizeStr),
      disabled
    );
  }

  if (customWidth !== null) {
    addMenuItem(
      menu,
      MENU_TEXT.removeCustomSize,
      'reset',
      async () => {
        await removeImageWidth(app, imgFile, resolved.activeFile);
        new Notice(NOTICE_DONE.customSizeRemoved);
      },
      NOTICE_FAILED.failedToRemoveSize,
      disableResize
    );
  }
}

/**
 * 尺寸块（外域图片）：宽度写在 markdown 链接的 alt 参数里，按 URL 匹配。
 * 缩放的百分比基准是该图的固有宽度；未加载出来时 `isSvg && actualWidth === null`
 * 的百分比行置灰，避免按一个猜出来的基准写死宽度。
 */
export async function addRemoteResizeMenuItems(
  menu: MenuLike,
  app: App,
  img: HTMLImageElement,
  activeFile: TFile,
  imageUrl: string,
  settings: PixelPerfectImageSettings,
  disableResize = false
): Promise<void> {
  const isSvg = isSvgSource(img);
  const customWidth = parseWidthFromImageAlt(img) ?? getCurrentExternalImageWidth(app, activeFile, imageUrl);

  const actualWidth = isSvg ? null : (getRasterNaturalDimensions(img)?.width ?? null);
  const currentScale =
    customWidth !== null && actualWidth !== null ? Math.round((customWidth / actualWidth) * 100) : null;

  for (const sizeStr of settings.customResizeSizes) {
    const parsed = parseResizeSize(sizeStr);
    if (!parsed) continue;

    const { amount: value, unit } = parsed;
    const isPercentage = unit === '%';
    const disabled =
      disableResize ||
      (isPercentage
        ? isSvg && actualWidth === null
          ? true
          : currentScale === value
        : customWidth === value);
    const icon = isPercentage ? (value === 100 ? 'image' : 'percent') : 'ruler';

    addMenuItem(
      menu,
      MENU_TEXT.resizeTo.replace('{size}', sizeStr),
      icon,
      () => resizeExternalImage(app, activeFile, imageUrl, img, value, !isPercentage),
      NOTICE_TEMPLATE.failedToResizeTo.replace('{size}', sizeStr),
      disabled
    );
  }

  if (customWidth !== null) {
    addMenuItem(
      menu,
      MENU_TEXT.removeCustomSize,
      'reset',
      async () => {
        await removeExternalImageWidth(app, activeFile, imageUrl);
        new Notice(NOTICE_DONE.customSizeRemoved);
      },
      NOTICE_FAILED.failedToRemoveSize,
      disableResize
    );
  }
}

/**
 * 文件操作块（桌面端专有）：在新标签页 / 右侧 / 新窗口 / 默认应用打开、在
 * 系统文件管理器中显示、重命名、删除。按设置里的顺序与开关渲染。
 */
export function addFileOperationMenuItems(
  menu: MenuLike,
  app: App,
  imgFile: TFile | null,
  settings: PixelPerfectImageSettings
): void {
  if (Platform.isMobile || !imgFile) return;

  const visibleOperations = settings.fileOperations.filter(operation => operation.visible);
  if (visibleOperations.length === 0) return;

  menu.addSeparator();
  const isMac = Platform.isMacOS;

  for (const operation of visibleOperations) {
    switch (operation.id) {
      case 'openInNewTab':
        addMenuItem(
          menu,
          getFileOperationName(operation.id),
          'lucide-file-plus',
          async () => {
            await app.workspace.openLinkText(imgFile.path, '', true);
          },
          NOTICE_FAILED.failedToOpenInNewTab
        );
        break;
      case 'openToTheRight':
        addMenuItem(
          menu,
          getFileOperationName(operation.id),
          'lucide-separator-vertical',
          async () => {
            const leaf = app.workspace.getLeaf('split', 'vertical');
            await leaf.openFile(imgFile);
            app.workspace.setActiveLeaf(leaf);
          },
          NOTICE_FAILED.failedToOpenToTheRight
        );
        break;
      case 'openInNewWindow':
        addMenuItem(
          menu,
          getFileOperationName(operation.id),
          'lucide-app-window',
          async () => {
            const leaf = app.workspace.getLeaf('window');
            await leaf.openFile(imgFile);
            app.workspace.setActiveLeaf(leaf);
          },
          NOTICE_FAILED.failedToOpenInNewWindow
        );
        break;
      case 'openInDefaultApp':
        addMenuItem(
          menu,
          getFileOperationName(operation.id),
          'image',
          () => openInDefaultApp(app, imgFile),
          NOTICE_FAILED.failedToOpenInDefaultApp
        );
        break;
      case 'showInExplorer':
        addMenuItem(
          menu,
          isMac ? MENU_TEXT.showInFinder : MENU_TEXT.showInExplorer,
          isMac ? 'lucide-app-window-mac' : 'lucide-app-window',
          () => showInSystemExplorer(app, imgFile),
          NOTICE_FAILED.failedToOpenExplorer
        );
        break;
      case 'renameImage':
        addMenuItem(
          menu,
          getFileOperationName(operation.id),
          'pencil',
          () => renameImage(app, imgFile),
          NOTICE_FAILED.failedToRenameImage
        );
        break;
      case 'deleteImage':
        addMenuItem(
          menu,
          getFileOperationName(operation.id),
          'lucide-trash',
          () => deleteImageAndLink(app, imgFile, settings),
          NOTICE_FAILED.failedToDeleteImage,
          false,
          true
        );
        break;
    }
  }
}
