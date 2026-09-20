/**
 * Shared attachment of the context-menu image surface markers.
 *
 * Live Preview's `ImageRowWidget.buildImageItem` passes a real closure so the
 * unified menu can reset a manual width; Reading Mode has no persist channel, so
 * readingMode.ts / rmFlexRow.ts pass `null` and the row renders greyed-out but
 * inert (menu assembly disables it in RM anyway).
 */

import type { SingleImageSizeMode } from "../constants";

/** What the size setting currently resolves to, for the reset-width row's label.
 *  `mode` decides what the row reads as: fixed names the width, natural names
 *  the mode instead — its reset result is a per-image pixel count, so no single
 *  number could stand for it. */
export interface SingleResetTarget {
    mode: SingleImageSizeMode;
    width: number;
}

export interface DiaImageMarkerOptions {
    /** True when this image is the sole member of a manually-sized single row. */
    manualSingle: () => boolean;
    /** The size setting's mode and width. */
    resetTarget: () => SingleResetTarget;
    /** Real remove-custom-size closure (LP), or null for read-only (RM). */
    resetSingleManual: (() => void) | null;
    /** The width this image currently takes on the page, or null when the
     *  renderer cannot say (not a single row, or the bitmap has not loaded).
     *  A rotation that turns the layout box on its side has to move this number
     *  to leave the picture the size it was. */
    screenWidth: (() => number | null) | null;
    /** The fill this row member is drawn with, or null when this image is not a
     *  multi-row member. A turn may not resize the member's container, so the
     *  fill is what has to be rewritten to hold the drawn height — the multi-row
     *  counterpart of `screenWidth`. */
    memberFill: (() => number | null) | null;
}

export function attachDiaImageMarkers(
    img: HTMLImageElement,
    opts: DiaImageMarkerOptions
): void {
    img.__diaa_manualSingle = () => opts.manualSingle();
    img.__diaa_resetTarget = () => opts.resetTarget();
    const reset = opts.resetSingleManual ?? (() => undefined);
    img.__diaa_resetSingleManual = (): void => {
        reset();
    };
    const screenWidth = opts.screenWidth;
    img.__diaa_screenWidth = screenWidth ? () => screenWidth() : null;
    const memberFill = opts.memberFill;
    img.__diaa_memberFill = memberFill ? () => memberFill() : null;
}
