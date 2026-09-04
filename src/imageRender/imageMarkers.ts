/**
 * Shared attachment of the context-menu image surface markers.
 *
 * Live Preview's `ImageRowWidget.buildImageItem` passes real closures so the
 * unified menu can drive resize/persist; Reading Mode has no persist channel,
 * so readingMode.ts / rmFlexRow.ts pass `null` for the action callbacks and the
 * rows render greyed-out but inert (menu assembly disables them in RM anyway).
 */

export interface DiaImageMarkerOptions {
    resizeEnabled: boolean;
    naturalWidth: () => number;
    manualSingle: () => boolean;
    /** True when the image belongs to a single-image row (vs a multi-member row). */
    singleRow: () => boolean;
    /** Pixel width a manual single row adopts when reset to the size setting. */
    resetTargetWidth: () => number;
    /** Real resize closure (LP), or null for a read-only surface (RM). */
    onResize: ((pct: number) => void) | null;
    /** Real remove-custom-size closure (LP), or null for read-only (RM). */
    resetSingleManual: (() => void) | null;
}

export function attachDiaImageMarkers(
    img: HTMLImageElement,
    opts: DiaImageMarkerOptions
): void {
    (img as any).__diaa_resizeEnabled = opts.resizeEnabled === true;
    (img as any).__diaa_naturalWidth = () => opts.naturalWidth();
    (img as any).__diaa_manualSingle = () => opts.manualSingle();
    (img as any).__diaa_singleRow = () => opts.singleRow();
    (img as any).__diaa_resetTargetWidth = () => opts.resetTargetWidth();
    const resize = opts.onResize ?? (() => undefined);
    (img as any).__diaa_onResize = (pct: number): void => {
        resize(pct);
    };
    const reset = opts.resetSingleManual ?? (() => undefined);
    (img as any).__diaa_resetSingleManual = (): void => {
        reset();
    };
}
