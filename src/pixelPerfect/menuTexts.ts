/**
 * 右键菜单与提示语的中文文案。
 *
 * 原先这部分由 Pixel Perfect Image 的多语言框架提供（六份 locale + 运行时按
 * 系统语言挑选），DIA 只消费中文一种，因此收编为内联常量：没有语言切换、
 * 没有键值查找，改文案就是改这一处。
 */

/** 菜单行文案。 */
export const MENU_TEXT = {
  /** 远程图片分组首行，仅作标识、不可点击。 */
  remoteImage: '远程图像',
  copyImageUrl: '复制图像 URL',
  copyImage: '复制图像',
  copyLocalPath: '复制本地路径',
  /** `{size}` 替换为设置里的尺寸原文，如 `25%` 或 `600px`。 */
  resizeTo: '调整大小到 {size}',
  removeCustomSize: '移除自定义尺寸',
  showInFinder: '在访达中显示',
  showInExplorer: '在资源管理器中显示',
  renameImage: '重命名图像',
  deleteImageAndLink: '删除图像和链接',
  openInNewTab: '在新标签页中打开',
  openToTheRight: '在右侧打开',
  openInNewWindow: '在新窗口中打开',
  openInDefaultApp: '用默认应用打开',
} as const;

/** 操作成功提示。 */
export const NOTICE_DONE = {
  imageUrlCopied: '图像 URL 已复制到剪贴板',
  imageCopied: '图像已复制到剪贴板',
  filePathCopied: '文件路径已复制到剪贴板',
  customSizeRemoved: '已移除该图像的自定义尺寸',
  imageRenamed: '图像重命名成功',
  imageAndLinksDeleted: '图像及其链接已删除',
  imageDeleted: '图像已删除',
} as const;

/** 操作失败提示。 */
export const NOTICE_FAILED = {
  couldNotReadDimensions: '无法读取图像尺寸',
  couldNotDetermineSvgDimensions: '无法确定 SVG 尺寸（缺少 width / height / viewBox）',
  couldNotDetermineImageDimensions: '无法确定图像尺寸',
  cannotCopyPath: '无法复制路径——未使用文件系统适配器',
  couldNotLocateImage: '无法找到图像文件',
  failedToRename: '重命名图像失败',
  failedToDelete: '删除图像及链接失败',
  clickInEditorFirst: '请先点击编辑器，再尝试复制',
  imageTooLargeToCopy: '图像过大，无法复制到剪贴板',
  failedToCopyUrl: '复制图像 URL 失败',
  failedToCopyImage: '复制图像到剪贴板失败',
  failedToCopyPath: '复制文件路径失败',
  failedToRemoveSize: '移除自定义尺寸失败',
  failedToOpenExplorer: '打开系统资源管理器失败',
  failedToRenameImage: '重命名图像失败',
  failedToDeleteImage: '删除图像失败',
  failedToOpenInNewTab: '在新标签页中打开图像失败',
  failedToOpenToTheRight: '在右侧打开图像失败',
  failedToOpenInNewWindow: '在新窗口中打开图像失败',
  failedToOpenInDefaultApp: '用默认应用打开失败',
} as const;

/** 需要拼接上下文的失败/进行中提示。 */
export const NOTICE_TEMPLATE = {
  /** `{size}` 替换为尺寸原文。 */
  failedToResizeTo: '将图像调整为 {size} 失败',
  /** `{status}` 替换为 HTTP 状态码。 */
  failedToFetchExternalImage: '获取外部图像失败（HTTP {status}）',
  externalImageNotImage: '该 URL 未返回图片',
  externalImageFetchTimedOut: '获取外部图像超时',
  fetchingLocalNetworkImage: '正在从本地网络地址获取图像',
} as const;

/** 模态框文案（重命名 / 删除确认）。 */
export const MODAL_TEXT = {
  rename: {
    title: '重命名图像',
    renameButton: '重命名',
    cancelButton: '取消',
  },
  delete: {
    title: '删除图像',
    /** `{filename}` 替换为文件名。 */
    confirmMessage: '确定要删除「{filename}」吗？',
    warningMessage: '这会同时删除图像文件，以及当前文档中指向它的全部链接。',
    deleteButton: '删除',
    cancelButton: '取消',
  },
} as const;

/** 设置页中「图片右键菜单」与「文件操作」两组的文案。 */
export const SETTINGS_TEXT = {
  menuGroupHeading: '图片右键菜单设置',
  fileInfo: {
    name: '文件信息',
    desc: '在菜单顶部显示文件名与图像尺寸',
  },
  resizeOptions: {
    name: '调整大小选项',
    desc: '逗号分隔。用 % 表示按原图宽度的百分比（如 25%、50%），用 px 表示固定像素宽（如 600px）',
    placeholder: '例如：25%, 50%, 100%, 600px',
  },
  confirmDelete: {
    name: '删除前确认',
    desc: '删除图像文件前弹出确认框',
  },
  fileOpsGroupHeading: '文件操作设置',
  restoreDefaultOrder: '恢复默认顺序',
  restoreDefaultOrderDesc: '将文件操作恢复为默认排列（保留当前的显示开关状态）',
} as const;
