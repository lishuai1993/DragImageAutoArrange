import { Platform } from 'obsidian';
import { MENU_TEXT } from './menuTexts';

/**
 * DIA 侧真正消费的 Pixel Perfect 设置项，连同它们的默认值、持久化归一化与
 * 显示名。原 PP 设置对象里本案不消费的字段（滚轮缩放、Cmd/Ctrl + 点击、
 * 关于页）在收编时一并去掉，读盘时也不再回写。
 */

/** 文件操作菜单项，顺序即默认展示顺序。 */
export const FILE_OPERATION_IDS = [
  'openInNewTab',
  'openToTheRight',
  'openInNewWindow',
  'openInDefaultApp',
  'showInExplorer',
  'renameImage',
  'deleteImage',
] as const;

export type FileOperationId = (typeof FILE_OPERATION_IDS)[number];

export interface FileOperationConfig {
  id: FileOperationId;
  visible: boolean;
}

export interface PixelPerfectImageSettings {
  /** 菜单顶部是否显示「文件名 @ 缩放%」与「宽 × 高 px」两行信息。 */
  showFileInfo: boolean;
  /** 多图行 / 单图行的尺寸预设原文，形如 `['25%', '50%', '100%', '600px']`。 */
  customResizeSizes: string[];
  /** 文件操作菜单项的显示开关与顺序。 */
  fileOperations: FileOperationConfig[];
  /** 删除图像前是否弹确认框。 */
  confirmBeforeDelete: boolean;
}

/** 尺寸预设的单位。 */
export type ResizeSizeUnit = 'px' | '%';

/** 尺寸预设定长 500px：外部图片尚未加载出固有宽度时按此换算百分比。 */
export const DEFAULT_EXTERNAL_IMAGE_FALLBACK_WIDTH_PX = 500;

function createDefaultFileOperations(): FileOperationConfig[] {
  return FILE_OPERATION_IDS.map(id => ({ id, visible: true }));
}

export const DEFAULT_SETTINGS: PixelPerfectImageSettings = {
  showFileInfo: true,
  customResizeSizes: ['25%', '50%', '100%'],
  fileOperations: createDefaultFileOperations(),
  confirmBeforeDelete: true,
};

const fileOperationIdSet = new Set<string>(FILE_OPERATION_IDS);

function isFileOperationId(value: unknown): value is FileOperationId {
  return typeof value === 'string' && fileOperationIdSet.has(value);
}

/**
 * 把持久化过的文件操作配置归一化：丢弃非法项与重复项，再按默认顺序补齐缺失
 * 项，使后续版本新增的操作仍然可被发现。不修改入参。
 */
export function reconcileFileOperations(value: unknown): FileOperationConfig[] {
  if (!Array.isArray(value)) return createDefaultFileOperations();

  const reconciled: FileOperationConfig[] = [];
  const seen = new Set<FileOperationId>();

  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;

    const { id, visible } = entry as Record<string, unknown>;
    if (!isFileOperationId(id) || typeof visible !== 'boolean' || seen.has(id)) continue;

    seen.add(id);
    reconciled.push({ id, visible });
  }

  for (const id of FILE_OPERATION_IDS) {
    if (!seen.has(id)) reconciled.push({ id, visible: true });
  }

  return reconciled;
}

/** 尺寸预设条目的文件名。 */
export function getFileOperationName(id: FileOperationId): string {
  switch (id) {
    case 'openInNewTab':
      return MENU_TEXT.openInNewTab;
    case 'openToTheRight':
      return MENU_TEXT.openToTheRight;
    case 'openInNewWindow':
      return MENU_TEXT.openInNewWindow;
    case 'openInDefaultApp':
      return MENU_TEXT.openInDefaultApp;
    case 'showInExplorer':
      return Platform.isMacOS ? MENU_TEXT.showInFinder : MENU_TEXT.showInExplorer;
    case 'renameImage':
      return MENU_TEXT.renameImage;
    case 'deleteImage':
      return MENU_TEXT.deleteImageAndLink;
  }
}

function hasDefaultFileOperationOrder(operations: readonly FileOperationConfig[]): boolean {
  return (
    operations.length === FILE_OPERATION_IDS.length &&
    operations.every((operation, index) => operation.id === FILE_OPERATION_IDS[index])
  );
}

/** 把文件操作恢复成默认顺序，同时保留各项目前的显示开关。 */
export function restoreDefaultFileOperationOrder(
  operations: readonly FileOperationConfig[]
): FileOperationConfig[] {
  const visibilityById = new Map(
    operations.map(operation => [operation.id, operation.visible] as const)
  );
  return FILE_OPERATION_IDS.map(id => ({
    id,
    visible: visibilityById.get(id) ?? true,
  }));
}

/** 文件操作是否已处于默认顺序（用于置灰「恢复默认顺序」）。 */
export function isDefaultFileOperationOrder(operations: readonly FileOperationConfig[]): boolean {
  return hasDefaultFileOperationOrder(operations);
}

/** 解析单条尺寸预设，形如 `25%` / `600px`；不合法返回 null。 */
export function parseResizeSize(value: string): { amount: number; unit: ResizeSizeUnit } | null {
  const match = value.trim().match(/^([1-9]\d*)(px|%)$/i);
  if (!match) return null;
  return { amount: Number.parseInt(match[1], 10), unit: match[2].toLowerCase() as ResizeSizeUnit };
}

/** 清洗尺寸预设列表：去空、去非法、去重，并统一为小写。 */
export function sanitizeResizeSizes(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized) continue;
    if (!parseResizeSize(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

/**
 * 从任意持久化内容中取出本案消费的设置字段。未知字段（旧版 PP 的滚轮缩放、
 * Cmd/Ctrl + 点击等）被丢弃，不再回写。
 */
export function coerceSettings(stored: unknown): PixelPerfectImageSettings {
  const raw = stored && typeof stored === 'object' && !Array.isArray(stored)
    ? (stored as Record<string, unknown>)
    : {};

  return {
    showFileInfo: typeof raw.showFileInfo === 'boolean' ? raw.showFileInfo : DEFAULT_SETTINGS.showFileInfo,
    customResizeSizes: sanitizeResizeSizes(
      Array.isArray(raw.customResizeSizes)
        ? raw.customResizeSizes.filter((item): item is string => typeof item === 'string')
        : DEFAULT_SETTINGS.customResizeSizes
    ),
    fileOperations: reconcileFileOperations(raw.fileOperations),
    confirmBeforeDelete:
      typeof raw.confirmBeforeDelete === 'boolean'
        ? raw.confirmBeforeDelete
        : DEFAULT_SETTINGS.confirmBeforeDelete,
  };
}
