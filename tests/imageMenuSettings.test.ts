// Pure-logic tests for the image-menu settings model: default shape, coercion
// of partial / malformed stored data, canonical-order restore for the
// file-operation list, and the one-time migration off the legacy key's fields.
import { describe, it, expect } from 'vitest';
import {
    DEFAULT_IMAGE_MENU_SETTINGS,
    FILE_OPERATION_IDS,
    LEGACY_DATA_KEY,
    coerceSettings,
    migrateLegacySettings,
    restoreDefaultFileOperationOrder,
    type FileOperationItem,
} from '../src/imageMenu/settingsModel';

const visible = (items: FileOperationItem[], id: string): boolean | undefined =>
    items.find(item => item.id === id)?.visible;

describe('coerceSettings', () => {
    it('returns the defaults for undefined input', () => {
        expect(coerceSettings(undefined)).toEqual(DEFAULT_IMAGE_MENU_SETTINGS);
    });

    it('returns the defaults for a non-record input', () => {
        expect(coerceSettings('nonsense')).toEqual(DEFAULT_IMAGE_MENU_SETTINGS);
        expect(coerceSettings([1, 2, 3])).toEqual(DEFAULT_IMAGE_MENU_SETTINGS);
    });

    it('keeps stored booleans and falls back per-field for the rest', () => {
        const out = coerceSettings({ showImageInfo: false });
        expect(out.showImageInfo).toBe(false);
        expect(out.confirmDelete).toBe(DEFAULT_IMAGE_MENU_SETTINGS.confirmDelete);
    });

    it('ignores a non-boolean stored value', () => {
        expect(coerceSettings({ showImageInfo: 'yes' }).showImageInfo).toBe(true);
    });

    it('drops unknown ids and restores the canonical order', () => {
        const out = coerceSettings({
            fileOperationItems: [
                { id: 'deleteImage', visible: false },
                { id: 'notAnOperation', visible: true },
                { id: 'openInNewTab', visible: true },
            ],
        });
        expect(out.fileOperationItems.map(item => item.id)).toEqual([...FILE_OPERATION_IDS]);
        expect(visible(out.fileOperationItems, 'deleteImage')).toBe(false);
        expect(visible(out.fileOperationItems, 'openInNewTab')).toBe(true);
        // A dropped entry and a missing entry both come back visible.
        expect(visible(out.fileOperationItems, 'renameImage')).toBe(true);
    });

    it('treats an explicit false as hidden and anything else as visible', () => {
        const out = coerceSettings({
            fileOperationItems: [{ id: 'renameImage', visible: 0 }],
        });
        expect(visible(out.fileOperationItems, 'renameImage')).toBe(true);
    });
});

describe('restoreDefaultFileOperationOrder', () => {
    it('returns the canonical order, all visible, for an empty input', () => {
        const out = restoreDefaultFileOperationOrder([]);
        expect(out.map(op => op.id)).toEqual([...FILE_OPERATION_IDS]);
        expect(out.every(op => op.visible)).toBe(true);
    });

    it('re-orders a scrambled list to canonical order while preserving visibility', () => {
        const scrambled = [
            { id: 'renameImage' as const, visible: false },
            { id: 'deleteImage' as const, visible: true },
            { id: 'openInNewTab' as const, visible: true },
        ];
        const out = restoreDefaultFileOperationOrder(scrambled);
        expect(out.map(op => op.id)).toEqual([...FILE_OPERATION_IDS]);
        expect(visible(out, 'renameImage')).toBe(false);
        expect(visible(out, 'deleteImage')).toBe(true);
        expect(visible(out, 'openInNewTab')).toBe(true);
        // Only renameImage was toggled off; every other slot is back to visible.
        expect(out.every(op => op.visible || op.id === 'renameImage')).toBe(true);
    });

    it('restoring a reversed full list keeps every operation visible', () => {
        const full = FILE_OPERATION_IDS.map(id => ({ id, visible: true }));
        const reversed = [...full].reverse();
        const out = restoreDefaultFileOperationOrder(reversed);
        expect(out.map(op => op.id)).toEqual([...FILE_OPERATION_IDS]);
        expect(out.every(op => op.visible)).toBe(true);
    });
});

describe('migrateLegacySettings', () => {
    it('reads the legacy field names into the current model', () => {
        const out = migrateLegacySettings({
            showFileInfo: false,
            confirmBeforeDelete: false,
            fileOperations: [
                { id: 'deleteImage', visible: false },
                { id: 'openInNewTab', visible: true },
            ],
        });
        expect(out.showImageInfo).toBe(false);
        expect(out.confirmDelete).toBe(false);
        expect(visible(out.fileOperationItems, 'deleteImage')).toBe(false);
        expect(visible(out.fileOperationItems, 'openInNewTab')).toBe(true);
    });

    it('ignores fields the current model no longer has', () => {
        const out = migrateLegacySettings({
            customResizeSizes: ['50%', '25%'],
            enableWheelZoom: true,
            showFileInfo: true,
        });
        expect(out).toEqual({ ...DEFAULT_IMAGE_MENU_SETTINGS });
    });

    it('falls back to defaults for a non-record legacy value', () => {
        expect(migrateLegacySettings(null)).toEqual(DEFAULT_IMAGE_MENU_SETTINGS);
        expect(migrateLegacySettings('')).toEqual(DEFAULT_IMAGE_MENU_SETTINGS);
    });

    it('keeps the legacy key name confined to the model module', () => {
        expect(LEGACY_DATA_KEY).toBe('pixelPerfectImage');
    });
});
