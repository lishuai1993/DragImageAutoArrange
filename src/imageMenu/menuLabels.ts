/**
 * Every user-facing string the image menu renders or toasts. Centralised so the
 * wording can be reviewed — and translated — in one place instead of being
 * scattered across the row builders.
 *
 * The text is stored as `{ zh, en }` pairs and the tables below are handed to
 * `localize()`, which resolves each entry when it is read. A menu is built on
 * every right-click, so every read happens after the language is settled and
 * `MENU_TEXT.transform` stays an ordinary string expression — the row builders
 * need no knowledge of the language at all.
 */

import { localize, t } from '../i18n/language';
import type { FileOperationId } from './settingsModel';

export const MENU_TEXT = localize({
    remoteImage: { zh: '远程图像', en: 'Remote image' },
    copyImage: { zh: '复制图像', en: 'Copy image' },
    copyImageUrl: { zh: '复制图像 URL', en: 'Copy image URL' },
    copyPath: { zh: '复制路径', en: 'Copy path' },
    obsidianUrl: { zh: 'Obsidian URL', en: 'Obsidian URL' },
    vaultRelativePath: { zh: '基于库的相对路径', en: 'Vault-relative path' },
    absolutePath: { zh: '绝对路径', en: 'Absolute path' },
    alignImage: { zh: '对齐图像', en: 'Align image' },
    alignLeft: { zh: '左对齐', en: 'Left' },
    alignCenter: { zh: '居中', en: 'Center' },
    alignRight: { zh: '右对齐', en: 'Right' },
    alignReset: { zh: '重置为默认对齐', en: 'Reset to default' },
    transform: { zh: '旋转 / 翻转', en: 'Rotate / Flip' },
    transformReset: { zh: '重置旋转', en: 'Reset rotation' },
    resetToSettingWidth: { zh: '重置为设置宽度', en: 'Reset to setting width' },
    resetToNaturalWidth: {
        zh: '重置为自然尺寸（设置项「单图尺寸」当前为原始尺寸模式）',
        en: 'Reset to natural size (the “Single image size” setting is currently in Natural mode)',
    },
    rotate90ccw: { zh: '向左旋转 90°', en: 'Rotate 90° left' },
    rotate90cw: { zh: '向右旋转 90°', en: 'Rotate 90° right' },
    rotate180: { zh: '旋转 180°', en: 'Rotate 180°' },
    flipHorizontal: { zh: '水平翻转', en: 'Flip horizontally' },
    flipVertical: { zh: '垂直翻转', en: 'Flip vertically' },
    disableContextMenu: { zh: '关闭 DIAA 图片右键菜单', en: 'Disable DIAA image menu' },
});

export const NOTICE_DONE = localize({
    imageCopied: { zh: '图像已复制到剪贴板', en: 'Image copied to the clipboard' },
    imageUrlCopied: { zh: '图像 URL 已复制到剪贴板', en: 'Image URL copied to the clipboard' },
    filePathCopied: { zh: '路径已复制到剪贴板', en: 'Path copied to the clipboard' },
    contextMenuEnabled: { zh: '图片右键菜单已开启', en: 'Image context menu enabled' },
});

/**
 * The notice for switching the master switch off, one entry per line. Split
 * rather than joined because a newline inside a notice's text is only a line
 * break if the platform's CSS says so; the caller renders these as elements.
 * The command label comes from the caller, so this copy module never depends on
 * the module that defines the command, and `copied` says whether the clipboard
 * hand-off worked — the notice may not promise something that did not happen.
 */
export function contextMenuDisabledLines(command: string, copied: boolean): string[] {
    return [
        t({ zh: '图片右键菜单已关闭', en: 'Image context menu turned off' }),
        t(
            {
                zh: '开启命令「{command}」{tail}',
                en: 'The command that turns it back on, “{command}”, {tail}',
            },
            {
                command,
                tail: t(
                    copied
                        ? { zh: '已复制到剪贴板', en: 'has been copied to the clipboard' }
                        : {
                              zh: '复制到剪贴板失败，可手动记下该名称',
                              en: 'could not be copied — note the name down by hand',
                          }
                ),
            }
        ),
        t({
            zh: '在「设置 → 快捷键」中搜索该命令并绑定快捷键，即可随时重新开启。',
            en: 'Search for it in Settings → Hotkeys, bind a hotkey, and you can turn the menu back on whenever you like.',
        }),
    ];
}

export const NOTICE_FAILED = localize({
    failedToCopyImage: { zh: '复制图像失败', en: 'Failed to copy the image' },
    failedToCopyUrl: { zh: '复制图像 URL 失败', en: 'Failed to copy the image URL' },
    failedToCopyPath: { zh: '复制路径失败', en: 'Failed to copy the path' },
    cannotCopyPath: {
        zh: '当前环境无法取得绝对路径',
        en: 'An absolute path is not available in this environment',
    },
    fileActionFailed: { zh: '操作失败', en: 'Operation failed' },
    resetWidthFailed: { zh: '重置宽度失败', en: 'Failed to reset the width' },
    transformFailed: { zh: '旋转 / 翻转失败', en: 'Rotate / flip failed' },
});

/** Row label per file-operation id, in the canonical order. */
export const FILE_OPERATION_LABELS: Record<FileOperationId, string> = localize({
    openInNewTab: { zh: '在新标签页中打开', en: 'Open in new tab' },
    openToTheRight: { zh: '在右侧打开', en: 'Open to the right' },
    openInNewWindow: { zh: '在新窗口中打开', en: 'Open in new window' },
    openInDefaultApp: { zh: '使用默认应用打开', en: 'Open in default app' },
    showInExplorer: { zh: '在访达中显示', en: 'Show in Finder' },
    renameImage: { zh: '重命名', en: 'Rename' },
    deleteImage: { zh: '删除', en: 'Delete' },
});

/** Row icon per file-operation id. */
export const FILE_OPERATION_ICONS: Record<FileOperationId, string> = {
    openInNewTab: 'file-plus',
    openToTheRight: 'panel-right',
    openInNewWindow: 'app-window',
    openInDefaultApp: 'external-link',
    showInExplorer: 'folder-open',
    renameImage: 'pencil',
    deleteImage: 'trash-2',
};
