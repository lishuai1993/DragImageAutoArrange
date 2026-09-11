// Pure-logic tests for the Pixel Perfect settings helpers surfaced to the DIA
// settings tab: default-order restore for the file-operation list and preset
// sanitization. Rendered with the obsidian mock via the vitest resolve alias.
import { describe, it, expect } from 'vitest';
import {
    restoreDefaultFileOperationOrder,
    sanitizeResizeSizes,
    FILE_OPERATION_IDS,
} from '../src/pixelPerfect/ppSettingsModel';

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
        expect(out.find(op => op.id === 'renameImage')?.visible).toBe(false);
        expect(out.find(op => op.id === 'deleteImage')?.visible).toBe(true);
        expect(out.find(op => op.id === 'openInNewTab')?.visible).toBe(true);
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

describe('sanitizeResizeSizes', () => {
    it('keeps valid entries, drops duplicates and malformed / zero input', () => {
        expect(sanitizeResizeSizes(['50%', '50%', '600px', 'abc', '25%', '0%'])).toEqual([
            '50%',
            '600px',
            '25%',
        ]);
    });
});
