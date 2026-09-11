// ── `img.__diaa_*` marker surface ────────────────────────────────────────
// The context menu reaches back into the rendered image through function and
// value markers attached to the <img> element (imageMarkers.ts installs the
// resize family, the row renderers install the alignment pair). Declaring them
// on `HTMLImageElement` lets both the writers and the reader use the
// documented fields instead of casting every access through `any`.

import type { Alignment } from "./constants";

declare global {
  interface HTMLImageElement {
    /** Current alignment of this image within its row. */
    __diaa_alignment?: Alignment;
    /** Apply an alignment change (undefined clears it). */
    __diaa_onAlign?: ((align: Alignment | undefined) => void) | null;
    /** Whether the context menu should offer resize actions. */
    __diaa_resizeEnabled?: boolean;
    __diaa_naturalWidth?: (() => number) | null;
    __diaa_manualSingle?: (() => boolean) | null;
    __diaa_singleRow?: (() => boolean) | null;
    __diaa_resetTargetWidth?: (() => number) | null;
    /** Resize to a percentage of the natural width. */
    __diaa_onResize?: ((percent: number) => unknown) | null;
    /** Drop a manual single-image width, returning to the natural size. */
    __diaa_resetSingleManual?: (() => unknown) | null;
  }
}

export {};
