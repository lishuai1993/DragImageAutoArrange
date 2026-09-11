/**
 * Physical persistence of a composed orientation (P3).
 *
 * Reads the original image bytes, decodes them to a raster source, redraws
 * through a canvas under the composed forward matrix and re-encodes:
 *   png  → lossless re-encode
 *   jpeg → quality 0.95
 *   webp → quality 0.95
 * svg / gif / avif cannot be re-encoded losslessly this way (svg would be
 * rasterised, gif/avif would silently degrade to a PNG), so they are refused
 * here as a final guard — the context menu already greys them out.
 */

import type { App, TFile } from 'obsidian';
import { logger } from '../logger';
import type { OrientationState } from './orientation';
import { stateToMatrix, orientedSize } from './orientation';

const log = logger.channel('transformWriter');

const MIME_AND_QUALITY: Record<string, { mime: string; quality?: number }> = {
    png: { mime: 'image/png' },
    jpg: { mime: 'image/jpeg', quality: 0.95 },
    jpeg: { mime: 'image/jpeg', quality: 0.95 },
    webp: { mime: 'image/webp', quality: 0.95 },
};

/** Formats that can be decoded, rotated and re-encoded losslessly(-ish). */
export function isReEncodableExtension(extension: string): boolean {
    return extension.toLowerCase() in MIME_AND_QUALITY;
}

async function decodeSource(buffer: ArrayBuffer): Promise<CanvasImageSource> {
    const blob = new Blob([buffer]);
    if (typeof createImageBitmap === 'function') {
        try {
            return await createImageBitmap(blob);
        } catch {
            // fall through to the <img> path
        }
    }
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            resolve(img);
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('decode failed'));
        };
        img.src = url;
    });
}

function sourceWidth(src: CanvasImageSource): number {
    const w = (src as unknown as { width?: number; naturalWidth?: number }).width;
    const nw = (src as unknown as { naturalWidth?: number }).naturalWidth;
    return w ?? nw ?? 0;
}

function sourceHeight(src: CanvasImageSource): number {
    const h = (src as unknown as { height?: number; naturalHeight?: number }).height;
    const nh = (src as unknown as { naturalHeight?: number }).naturalHeight;
    return h ?? nh ?? 0;
}

/** Close a decoded ImageBitmap when we own one (the <img> fallback needs none). */
function closeSource(src: CanvasImageSource): void {
    (src as ImageBitmap).close?.();
}

/**
 * Rewrite `file` with its pixels oriented by `state`.  Returns true on success;
 * false when the format is unsupported or decoding/encoding fails.
 */
export async function writeOrientationToFile(
    app: App,
    file: TFile,
    state: OrientationState
): Promise<boolean> {
    const spec = MIME_AND_QUALITY[file.extension.toLowerCase()];
    if (!spec) {
        log.warn('transform write refused: unsupported format', { path: file.path, ext: file.extension });
        return false;
    }

    let buffer: ArrayBuffer;
    try {
        buffer = await app.vault.readBinary(file);
    } catch (e) {
        log.warn('transform write read failed', { path: file.path, error: String(e) });
        return false;
    }

    let src: CanvasImageSource;
    try {
        src = await decodeSource(buffer);
    } catch (e) {
        log.warn('transform write decode failed', { path: file.path, error: String(e) });
        return false;
    }

    try {
        const sw = sourceWidth(src);
        const sh = sourceHeight(src);
        if (!(sw > 0) || !(sh > 0)) {
            log.warn('transform write empty dimensions', { path: file.path, sw, sh });
            return false;
        }

        const m = stateToMatrix(state);
        const [ma, mb, mc, md] = m;
        // Canvas setTransform(a,b,c,d,e,f) applies:
        //   x' = a*x + c*y + e ; y' = b*x + d*y + f
        const { width: dw, height: dh } = orientedSize(state, sw, sh);

        const corners = [
            [0, 0],
            [sw, 0],
            [0, sh],
            [sw, sh],
        ];
        let minX = Infinity;
        let minY = Infinity;
        for (const [x, y] of corners) {
            const ox = ma * x + mb * y;
            const oy = mc * x + md * y;
            if (ox < minX) minX = ox;
            if (oy < minY) minY = oy;
        }
        const tx = -minX;
        const ty = -minY;

        const canvas = createEl('canvas');
        canvas.width = dw;
        canvas.height = dh;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            log.warn('transform write canvas unavailable', { path: file.path });
            return false;
        }
        ctx.setTransform(ma, mc, mb, md, tx, ty);
        ctx.drawImage(src, 0, 0, sw, sh);
        ctx.setTransform(1, 0, 0, 1, 0, 0);

        const blob = await new Promise<Blob | null>((resolve) => {
            canvas.toBlob(resolve, spec.mime, spec.quality);
        });
        if (!blob) {
            log.warn('transform write encode failed', { path: file.path, mime: spec.mime });
            return false;
        }

        const out = await blob.arrayBuffer();
        await app.vault.modifyBinary(file, out);
        log.info('transform write persisted', { path: file.path, turns: state.turns, mirror: state.mirror });
        return true;
    } catch (e) {
        log.warn('transform write failed', { path: file.path, error: String(e) });
        return false;
    } finally {
        closeSource(src);
    }
}
