import { logger } from "../logger";

const log = logger.channel("rmImageClick");

/**
 * Reading Mode image preview gesture: single-click → double-click.
 *
 * Obsidian's native Reading-Mode handler opens an image's preview overlay on a
 * single click, and exposes no public API to open it programmatically.  To make
 * the gesture a double click without losing the preview, this module:
 *
 *   1. suppresses every single click that lands on a Reading-Mode <img> at the
 *      document capture phase (so the native preview no longer opens on one click);
 *   2. on the browser's native `dblclick`, re-dispatches one synthetic `click` to
 *      the same image and lets it through, handing the event back to Obsidian's
 *      own preview listener.
 *
 * Obsidian's listener runs before ours when it is also document-capture (older
 * registration), and after ours when bubble-phase — the synthetic click is not
 * suppressed either way.  The only failure mode is Obsidian rejecting untrusted
 * (synthetic) events; if that surfaces in testing, the fallback is a DIAA-owned
 * lightbox that renders the image full-size.
 */
export function installReadingModeImageDoubleClickZoom(
    isEnabled: () => boolean
): () => void {
    let allowSyntheticClick = false;

    const imageFromEvent = (ev: Event): HTMLImageElement | null => {
        const t = ev.target;
        if (!(t instanceof Element)) return null;
        const img = t.tagName === "IMG" ? t : t.closest("img");
        if (!(img instanceof HTMLImageElement)) return null;
        if (!img.closest(".markdown-preview-view")) return null;
        return img;
    };

    const onCaptureClick = (ev: MouseEvent): void => {
        if (!isEnabled()) return;
        if (allowSyntheticClick) {
            // The synthetic re-open click from onDblClick — pass it to Obsidian.
            allowSyntheticClick = false;
            return;
        }
        if (!imageFromEvent(ev)) return;
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
    };

    const onCaptureDblClick = (ev: MouseEvent): void => {
        if (!isEnabled()) return;
        const img = imageFromEvent(ev);
        if (!img) return;
        log.info("RM double-click opens image preview", {
            src: (img.currentSrc || img.src || "").substring(0, 80),
        });
        // Suppress Obsidian's own dblclick handlers (e.g. open-in-app) so a double
        // click yields exactly one preview, then hand the preview open back to
        // Obsidian's single-click listener via one synthetic click.
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        allowSyntheticClick = true;
        img.dispatchEvent(
            new MouseEvent("click", {
                bubbles: true,
                cancelable: true,
                view: window,
                detail: 1,
            })
        );
    };

    document.addEventListener("click", onCaptureClick, true);
    document.addEventListener("dblclick", onCaptureDblClick, true);
    return () => {
        document.removeEventListener("click", onCaptureClick, true);
        document.removeEventListener("dblclick", onCaptureDblClick, true);
    };
}
