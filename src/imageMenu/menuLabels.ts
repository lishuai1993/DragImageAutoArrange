/**
 * Every user-facing string the image menu renders or toasts. Centralised so the
 * wording can be reviewed (and translated) in one place instead of being
 * scattered across the row builders.
 */

import type { FileOperationId } from './settingsModel';

export const MENU_TEXT = {
    remoteImage: '远程图像',
    copyImage: '复制图像',
    copyImageUrl: '复制图像 URL',
    copyPath: '复制路径',
    obsidianUrl: 'Obsidian URL',
    vaultRelativePath: '基于库的相对路径',
    absolutePath: '绝对路径',
    alignImage: 'Align image',
    alignLeft: 'Left',
    alignCenter: 'Center',
    alignRight: 'Right',
    alignReset: 'Reset to default',
    transform: '旋转 / 翻转',
    transformReset: '重置旋转',
    resetToSettingWidth: '重置为设置宽度',
    resetToNaturalWidth: '重置为自然尺寸（设置项「单图尺寸」当前为Natural模式）',
    rotate90ccw: '向左旋转 90°',
    rotate90cw: '向右旋转 90°',
    rotate180: '旋转 180°',
    flipHorizontal: '水平翻转',
    flipVertical: '垂直翻转',
} as const;

export const NOTICE_DONE = {
    imageCopied: '图像已复制到剪贴板',
    imageUrlCopied: '图像 URL 已复制到剪贴板',
    filePathCopied: '路径已复制到剪贴板',
} as const;

export const NOTICE_FAILED = {
    failedToCopyImage: '复制图像失败',
    failedToCopyUrl: '复制图像 URL 失败',
    failedToCopyPath: '复制路径失败',
    cannotCopyPath: '当前环境无法取得绝对路径',
    fileActionFailed: '操作失败',
    resetWidthFailed: '重置宽度失败',
    transformFailed: '旋转 / 翻转失败',
} as const;

/** Row label per file-operation id, in the canonical order. */
export const FILE_OPERATION_LABELS: Record<FileOperationId, string> = {
    openInNewTab: '在新标签页中打开',
    openToTheRight: '在右侧打开',
    openInNewWindow: '在新窗口中打开',
    openInDefaultApp: '使用默认应用打开',
    showInExplorer: '在访达中显示',
    renameImage: '重命名',
    deleteImage: '删除',
};

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
