/**
 * Surface and source classification for a right-clicked image: which markdown
 * view owns it, and whether it is an external URL, a vector, or a vault file.
 *
 * These read only the DOM (plus the workspace leaf list), so they stay valid in
 * both Live Preview and Reading Mode.
 */

import { MarkdownView, type App } from 'obsidian';

/**
 * The markdown view whose DOM contains `el`, or null when the element lives on
 * another surface (canvas, a file-explorer preview, a popped-out window's own
 * document…). Callers use null as "this surface is not ours — let the native
 * menu through".
 */
export function findMarkdownViewForElement(app: App, el: Element): MarkdownView | null {
    for (const leaf of app.workspace.getLeavesOfType('markdown')) {
        const view = leaf.view;
        if (view instanceof MarkdownView && view.containerEl?.contains(el)) return view;
    }
    return null;
}

/** Candidate sources of an image, most-authoritative first. */
function sources(img: HTMLImageElement): string[] {
    return [img.currentSrc, img.src, img.getAttribute('src') ?? ''].filter(Boolean);
}

/** The best http(s) URL for this image, or '' when it is not a remote image. */
export function getBestHttpImageSource(img: HTMLImageElement): string {
    for (const candidate of sources(img)) {
        if (/^https?:\/\//i.test(candidate)) return candidate;
    }
    return '';
}

/** True when the image is loaded from an external http(s) URL. */
export function isRemoteImage(img: HTMLImageElement): boolean {
    return getBestHttpImageSource(img) !== '';
}

/**
 * Display name for a remote image: the last segment of its URL path, falling
 * back to the host and finally to the raw URL — a remote image has no vault
 * filename, but the menu's identity row wants something to show.
 */
export function remoteImageName(url: string): string {
    try {
        const parsed = new URL(url);
        const segment = parsed.pathname.split('/').filter(Boolean).pop();
        if (segment) return decodeURIComponent(segment);
        return parsed.host || url;
    } catch {
        return url;
    }
}

/**
 * True for vector sources — by extension, or an inline `data:image/svg+xml` URI.
 * SVG is excluded from the bitmap-only actions (copy/cut of the pixels).
 */
export function isSvgSource(img: HTMLImageElement): boolean {
    for (const candidate of sources(img)) {
        if (/^data:image\/svg\+xml/i.test(candidate)) return true;
        if (/\.svg($|[?#])/i.test(candidate)) return true;
    }
    return false;
}
