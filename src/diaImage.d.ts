// ── `img.__diaa_*` marker surface ────────────────────────────────────────
// The context menu reaches back into the rendered image through function and
// value markers attached to the <img> element (imageMarkers.ts installs the
// reset-width family, the row renderers install the alignment pair). Declaring
// them on `HTMLImageElement` lets both the writers and the reader use the
// documented fields instead of casting every access through `any`.

import type { Alignment, SingleImageSizeMode } from "./constants";

declare global {
  interface HTMLImageElement {
    /** Current alignment of this image within its row. */
    __diaa_alignment?: Alignment;
    /** Apply an alignment change (undefined clears it). */
    __diaa_onAlign?: ((align: Alignment | undefined) => void) | null;
    /** Whether this image is a manually-sized single row. */
    __diaa_manualSingle?: (() => boolean) | null;
    /** The size setting's mode and width, which the reset-width row's label
     *  reads: fixed mode names the width, natural mode names the mode instead.
     *  Mirrors `SingleResetTarget` in imageMarkers.ts. */
    __diaa_resetTarget?: (() => { mode: SingleImageSizeMode; width: number }) | null;
    /** Drop a manual single-image width, returning to the setting-driven size. */
    __diaa_resetSingleManual?: (() => unknown) | null;
    /** The width this image currently takes on the page, or null when the
     *  renderer cannot say. Mirrors `screenWidth` in imageMarkers.ts. */
    __diaa_screenWidth?: (() => number | null) | null;
    /** The fill this multi-row member is drawn with, or null when the image is
     *  not a row member. Mirrors `memberFill` in imageMarkers.ts. */
    __diaa_memberFill?: (() => number | null) | null;
  }
}

export {};
