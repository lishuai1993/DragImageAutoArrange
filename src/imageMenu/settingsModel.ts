/**
 * Settings model for the image right-click menu: the three persisted knobs, the
 * fixed set of file-operation rows, and the one-time migration off the previous
 * key/field names.
 *
 * All of this is pure data work (no Obsidian API), so it is unit-testable and
 * the host only has to do the read-modify-write around it.
 */

export type FileOperationId =
    | 'openInNewTab'
    | 'openToTheRight'
    | 'openInNewWindow'
    | 'openInDefaultApp'
    | 'showInExplorer'
    | 'renameImage'
    | 'deleteImage';

export interface FileOperationItem {
    id: FileOperationId;
    visible: boolean;
}

export interface ImageMenuSettings {
    /** Render the filename / dimension info rows at the top of the menu. */
    showImageInfo: boolean;
    /** Ask before a delete that would remove the image file itself. */
    confirmDelete: boolean;
    /** File-operation rows in display order; order and visibility are user-set. */
    fileOperationItems: FileOperationItem[];
}

/** Canonical file-operation order, also the order a fresh install renders. */
export const FILE_OPERATION_IDS: FileOperationId[] = [
    'openInNewTab',
    'openToTheRight',
    'openInNewWindow',
    'openInDefaultApp',
    'showInExplorer',
    'renameImage',
    'deleteImage',
];

export const DEFAULT_IMAGE_MENU_SETTINGS: ImageMenuSettings = {
    showImageInfo: true,
    confirmDelete: true,
    fileOperationItems: FILE_OPERATION_IDS.map(id => ({ id, visible: true })),
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileOperationId(value: unknown): value is FileOperationId {
    return typeof value === 'string' && (FILE_OPERATION_IDS as string[]).includes(value);
}

/**
 * Canonical order + one entry per known operation. A stored entry keeps its own
 * visibility; an operation with no stored entry (fresh field, or one dropped by
 * an older version) comes back visible rather than silently disappearing.
 */
export function restoreDefaultFileOperationOrder(
    items: ReadonlyArray<{ id: FileOperationId; visible: boolean }>
): FileOperationItem[] {
    return FILE_OPERATION_IDS.map(id => ({
        id,
        visible: items.find(item => item.id === id)?.visible ?? true,
    }));
}

function coerceFileOperationItems(value: unknown): FileOperationItem[] {
    if (!Array.isArray(value)) return restoreDefaultFileOperationOrder([]);
    const stored: Array<{ id: FileOperationId; visible: boolean }> = [];
    for (const entry of value) {
        if (!isRecord(entry) || !isFileOperationId(entry.id)) continue;
        stored.push({ id: entry.id, visible: entry.visible !== false });
    }
    return restoreDefaultFileOperationOrder(stored);
}

/** Shape a stored (or missing) settings object into a complete settings value. */
export function coerceSettings(stored: unknown): ImageMenuSettings {
    const raw = isRecord(stored) ? stored : {};
    return {
        showImageInfo:
            typeof raw.showImageInfo === 'boolean'
                ? raw.showImageInfo
                : DEFAULT_IMAGE_MENU_SETTINGS.showImageInfo,
        confirmDelete:
            typeof raw.confirmDelete === 'boolean'
                ? raw.confirmDelete
                : DEFAULT_IMAGE_MENU_SETTINGS.confirmDelete,
        fileOperationItems: coerceFileOperationItems(raw.fileOperationItems),
    };
}

/**
 * Key the image-menu settings occupied before the module was rewritten. It is
 * read once during migration and dropped afterwards, so any occurrence of that
 * name in the source is confined to this file.
 */
export const LEGACY_DATA_KEY = 'pixelPerfectImage';

/** Old field name → new field name, for the one-time migration. */
const LEGACY_FIELD_NAMES = {
    showImageInfo: 'showFileInfo',
    confirmDelete: 'confirmBeforeDelete',
    fileOperationItems: 'fileOperations',
} as const;

/**
 * Read a pre-rewrite settings object (the value stored under `LEGACY_DATA_KEY`)
 * into the current model. Fields the current model no longer has — the resize
 * presets and the wheel-zoom family — are dropped rather than carried along.
 */
export function migrateLegacySettings(legacy: unknown): ImageMenuSettings {
    const raw = isRecord(legacy) ? legacy : {};
    return coerceSettings({
        showImageInfo: raw[LEGACY_FIELD_NAMES.showImageInfo],
        confirmDelete: raw[LEGACY_FIELD_NAMES.confirmDelete],
        fileOperationItems: raw[LEGACY_FIELD_NAMES.fileOperationItems],
    });
}
