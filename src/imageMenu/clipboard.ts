/**
 * Put an image's bitmap on the system clipboard.
 *
 * The clipboard is where a copy's cost lands, and a lossless PNG is the most
 * expensive thing to put there: a re-encoded photo runs to tens of megabytes and
 * takes hundreds of milliseconds to encode — and the *receiving* app pays again
 * to read it, which is what a laggy paste actually is. So the format handed over
 * is chosen from the source, and the canvas is avoided entirely wherever the
 * original bytes will do:
 *
 *   png        → the original bytes, as `image/png`
 *   jpg/jpeg   → the original bytes, as `image/jpeg`
 *   webp/avif  → JPEG re-encode (lossy family, and ~10× smaller than PNG) —
 *                unless the source is transparent, which JPEG cannot carry
 *   bmp/gif    → PNG re-encode (lossless family, may carry transparency)
 *   unknown    → PNG re-encode
 *
 * A remote image follows the same rules but has to be fetched first: `requestUrl`
 * runs in the main process, so it is the only route that isn't blocked by CORS. A
 * bitmap decoded from those bytes is same-origin as far as the canvas is
 * concerned, so it can be re-encoded without tainting.
 *
 * Two writers stand behind that table. The Web clipboard's `ClipboardItem` carries
 * several flavours at once, which is how a `text/plain` reference rides along for
 * the paste handler to read — but this Chromium refuses `image/jpeg` on it outright
 * ("Type image/jpeg not supported on write"). JPEG therefore goes through Electron's
 * native clipboard, and since that writer replaces the whole pasteboard per call,
 * its reference waits in memory instead of on the clipboard (nativeClipboard.ts).
 * Everything else stays on the Web clipboard, where flavour and reference are both
 * cheap. A JPEG source's own bytes are only worth reading when the native writer is
 * there to take them; without it the canvas produces a PNG instead.
 *
 * Every copy emits one `LOG_CLIPBOARD_COPY` line carrying the source's pixels and
 * byte count, the time spent encoding, the time spent writing to the pasteboard,
 * the route taken, and the output's mime and size.
 */

import { requestUrl, type App, type TFile } from 'obsidian';
import { logger } from '../logger';
import {
    forgetReference,
    nativeJpegAvailable,
    rememberReference,
    writeJpeg,
} from './nativeClipboard';

const log = logger.channel('clipboard');

const PNG = 'image/png';
const JPEG = 'image/jpeg';

/** Media type per vault extension. A plain lookup — the pass-through and
 *  re-encode decisions read from it but live in `passthroughOf` / `reencodeMime`. */
const MEDIA_TYPE: Record<string, string> = {
    png: PNG,
    jpg: JPEG,
    jpeg: JPEG,
    webp: 'image/webp',
    avif: 'image/avif',
    bmp: 'image/bmp',
    gif: 'image/gif',
};

/** Formats a lossy re-encode may stand in for, since the source already lost
 *  information and JPEG is the smallest flavour every desktop app reads. */
const LOSSY_MEDIA: ReadonlySet<string> = new Set(['image/webp', 'image/avif']);

/** Side of the square the alpha probe reduces the source to. */
const ALPHA_PROBE_SIZE = 32;

interface RawImage {
    bytes: ArrayBuffer;
    mime: string;
}

/** An encoded clipboard payload together with the size of the bitmap behind it,
 *  carried as one value so the cost log can name the output bytes and the pixels
 *  from a single place. `mime` is what was actually produced, which the canvas is
 *  free to change from what was asked for. */
interface Raster {
    blob: Blob;
    mime: string;
    width: number;
    height: number;
}

/** What one copy was of, for the cost log: where the pixels came from, the
 *  source's own format, and its intrinsic size when that is knowable without
 *  decoding. */
interface CopyContext {
    /** Vault path, remote URL, or `element` for a rendered image. */
    source: string;
    /** The source's own format, as a file extension or a media type. */
    format: string;
    /** Intrinsic size as `W×H`, or `unknown` until the canvas reports it. */
    pixels: string;
    reference?: string;
}

/** The media type named by a content-type header or an extension, or null. Media
 *  types are case-insensitive, and the parameters after `;` say nothing about the
 *  format. */
export function normalizeMediaType(token: string | null): string | null {
    if (!token) return null;
    const base = token.split(';')[0].trim().toLowerCase();
    return MEDIA_TYPE[base] ?? (base || null);
}

/** MIME that can go to the clipboard untouched, or null when the source needs the
 *  canvas. */
function passthroughOf(mediaType: string | null): string | null {
    return mediaType === PNG || mediaType === JPEG ? mediaType : null;
}

/** MIME a vault file can be copied as untouched, or null when it needs the canvas. */
export function nativeMimeOf(file: TFile): string | null {
    return passthroughOf(mediaTypeOfFile(file));
}

/** The media type of a vault file, or null for an extension we don't model. */
export function mediaTypeOfFile(file: TFile): string | null {
    return MEDIA_TYPE[file.extension.toLowerCase()] ?? null;
}

/** Map a response content-type onto a MIME that can be passed through, or null. */
export function passthroughMime(contentType: string | null): string | null {
    return passthroughOf(normalizeMediaType(contentType));
}

/** The flavour a source must be re-encoded as, when its own bytes won't do. */
export function reencodeMime(mediaType: string | null): string {
    return mediaType !== null && LOSSY_MEDIA.has(mediaType) ? JPEG : PNG;
}

/**
 * What the canvas should encode for: JPEG for the lossy family, but only where the
 * native writer can actually put a JPEG on the pasteboard. Without it the Web
 * clipboard would refuse the flavour, so PNG is the only thing that lands.
 */
export function canvasTargetMime(mediaType: string | null, nativeJpeg: boolean): string {
    return reencodeMime(mediaType) === JPEG && nativeJpeg ? JPEG : PNG;
}

/** Draw a decoded source onto a correctly-sized canvas. */
function drawToCanvas(
    source: CanvasImageSource,
    width: number,
    height: number
): HTMLCanvasElement {
    const canvas = createEl('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    ctx.drawImage(source, 0, 0, width, height);
    return canvas;
}

/**
 * Whether the source holds any non-opaque pixel.
 *
 * Sampled on a 32×32 reduction rather than the full bitmap. Downscaling averages
 * alpha, so a transparent region shrinks but never vanishes, and the check errs
 * towards "has alpha" — the safe direction, since that only costs a larger PNG,
 * whereas a missed transparency would flatten to black in JPEG.
 */
function hasTransparency(source: CanvasImageSource): boolean {
    const probe = createEl('canvas');
    probe.width = ALPHA_PROBE_SIZE;
    probe.height = ALPHA_PROBE_SIZE;
    const ctx = probe.getContext('2d');
    if (!ctx) return true;
    ctx.drawImage(source, 0, 0, ALPHA_PROBE_SIZE, ALPHA_PROBE_SIZE);
    const { data } = ctx.getImageData(0, 0, ALPHA_PROBE_SIZE, ALPHA_PROBE_SIZE);
    for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 255) return true;
    }
    return false;
}

/**
 * Encode a decoded source, reporting the mime actually produced. A JPEG request
 * for a transparent image becomes a PNG — JPEG cannot carry alpha, so honouring it
 * would flatten to black — and the caller must know, since the two go to different
 * clipboard writers.
 */
async function encode(
    source: CanvasImageSource,
    width: number,
    height: number,
    mime: string
): Promise<{ blob: Blob; mime: string }> {
    const target = mime === JPEG && hasTransparency(source) ? PNG : mime;
    const canvas = drawToCanvas(source, width, height);
    const blob = await new Promise<Blob | null>(resolve =>
        canvas.toBlob(resolve, target, target === JPEG ? 0.95 : undefined)
    );
    if (!blob) throw new Error('image encoding failed');
    return { blob, mime: target };
}

/** Read the on-screen pixels of `img` back out. */
async function rasterizeElement(img: HTMLImageElement, mime: string): Promise<Raster> {
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!(width > 0 && height > 0)) {
        throw new Error('image has no intrinsic size');
    }
    const { blob, mime: actual } = await encode(img, width, height, mime);
    return { blob, mime: actual, width, height };
}

/** Re-encode already-fetched bytes, for a remote format we can't pass through. */
async function rasterizeBytes(bytes: ArrayBuffer, type: string, mime: string): Promise<Raster> {
    const bitmap = await createImageBitmap(new Blob([bytes], { type }));
    try {
        const { blob, mime: actual } = await encode(bitmap, bitmap.width, bitmap.height, mime);
        return { blob, mime: actual, width: bitmap.width, height: bitmap.height };
    } finally {
        bitmap.close();
    }
}

interface WriteResult {
    route: string;
    mime: string;
    bytes: number;
}

/** The Web clipboard: one `ClipboardItem` carrying the bitmap, plus the reference
 *  as a `text/plain` flavour for the paste handler to read. */
async function writeWeb(blob: Blob, mime: string, context: CopyContext): Promise<WriteResult> {
    forgetReference();
    const payload: Record<string, Blob | string> = { [mime]: blob };
    if (context.reference) payload['text/plain'] = context.reference;
    await navigator.clipboard.write([new ClipboardItem(payload)]);
    return { route: 'web', mime, bytes: blob.size };
}

/**
 * Write the payload through whichever clipboard can take it, arming the reference
 * memory when the writer leaves no text flavour to carry it instead.
 *
 * `reencodePng` is the last resort for the corner where the native write fails
 * after the canvas has already produced a JPEG: the Web clipboard will not take
 * that flavour either, so a PNG is re-encoded rather than losing the copy.
 */
async function writePayload(
    blob: Blob,
    mime: string,
    context: CopyContext,
    reencodePng: () => Promise<Raster>
): Promise<WriteResult> {
    if (mime === JPEG && nativeJpegAvailable()) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (writeJpeg(bytes)) {
            rememberReference(context.reference, bytes);
            return { route: 'native-jpeg', mime: JPEG, bytes: blob.size };
        }
        log.warn('LOG_CLIPBOARD_NATIVE_REFUSED');
        const png = await reencodePng();
        return writeWeb(png.blob, png.mime, context);
    }
    return writeWeb(blob, mime, context);
}

/**
 * Stage the payload — the source's own bytes where they will do, the canvas where
 * they will not — and hand it to a writer.
 */
async function copyImage(
    original: RawImage | null,
    canvasMime: string,
    rasterize: (mime: string) => Promise<Raster>,
    context: CopyContext
): Promise<void> {
    const started = Date.now();
    let encodeMs = 0;

    const reencode = async (mime: string): Promise<Raster> => {
        const at = Date.now();
        const out = await rasterize(mime);
        encodeMs += Date.now() - at;
        return out;
    };

    let blob: Blob;
    let mime: string;
    let dims: { width: number; height: number } | null = null;

    if (original) {
        blob = new Blob([original.bytes], { type: original.mime });
        mime = original.mime;
    } else {
        const raster = await reencode(canvasMime);
        blob = raster.blob;
        mime = raster.mime;
        dims = { width: raster.width, height: raster.height };
    }

    const writeAt = Date.now();
    const written = await writePayload(blob, mime, context, () => reencode(PNG));
    const writeMs = Date.now() - writeAt;

    log.info('LOG_CLIPBOARD_COPY', {
        source: context.source,
        format: context.format,
        pixels: dims ? `${dims.width}×${dims.height}` : context.pixels,
        sourceBytes: original?.bytes.byteLength ?? null,
        route: written.route,
        mime: written.mime,
        encodeMs,
        writeMs,
        outBytes: written.bytes,
        totalMs: Date.now() - started,
    });
}

/** The `content-type` header of a response, or null. */
function responseContentType(headers: Record<string, string> | undefined): string | null {
    if (!headers) return null;
    const key = Object.keys(headers).find(k => k.toLowerCase() === 'content-type');
    if (!key) return null;
    return (headers[key] ?? '') || null;
}

/** A vault file's bytes, or null when they can't be read (deleted, unreadable) —
 *  in which case the on-screen pixels are still worth copying. */
async function readRaw(app: App, file: TFile, mime: string): Promise<RawImage | null> {
    try {
        return { bytes: await app.vault.readBinary(file), mime };
    } catch {
        return null;
    }
}

/** Whether a pass-through MIME is usable as-is: a PNG always, a JPEG only where
 *  the native writer can take it. */
function passthroughUsable(passthrough: string | null, nativeJpeg: boolean): boolean {
    return passthrough === PNG || (passthrough === JPEG && nativeJpeg);
}

export interface CopyImageOptions {
    /** Text flavour placed alongside the bitmap, so an editor paste can land as a
     *  reference rather than a duplicate attachment. Where the native writer is
     *  used it has no text flavour to carry this, so it is remembered instead. */
    reference?: string;
    /** The vault file behind `img`. A PNG or JPEG file goes to the clipboard
     *  byte-for-byte, which skips the canvas re-encode and puts a far smaller
     *  payload on the pasteboard than a re-encoded PNG would. */
    vaultSource?: { app: App; file: TFile };
}

/**
 * Resolves once the bitmap sits on the clipboard; rejects when the image cannot
 * be read or the clipboard refuses the write, so callers can surface a failure
 * notice instead of silently doing nothing.
 */
export async function copyImageToClipboard(
    img: HTMLImageElement,
    { reference, vaultSource }: CopyImageOptions = {}
): Promise<void> {
    const mediaType = vaultSource ? mediaTypeOfFile(vaultSource.file) : null;
    const passthrough = passthroughOf(mediaType);
    const nativeJpeg = nativeJpegAvailable();

    let original: RawImage | null = null;
    if (vaultSource && passthroughUsable(passthrough, nativeJpeg)) {
        original = await readRaw(vaultSource.app, vaultSource.file, passthrough as string);
    }

    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;

    await copyImage(
        original,
        canvasTargetMime(mediaType, nativeJpeg),
        mime => rasterizeElement(img, mime),
        {
            source: vaultSource ? `vault:${vaultSource.file.path}` : 'element',
            format: vaultSource ? vaultSource.file.extension.toLowerCase() : 'unknown',
            pixels: width > 0 && height > 0 ? `${width}×${height}` : 'unknown',
            reference,
        }
    );
}

/** Same, for an image whose pixels live behind an http(s) URL. */
export async function copyRemoteImageToClipboard(
    url: string,
    reference?: string
): Promise<void> {
    const response = await requestUrl({ url });
    const bytes = response.arrayBuffer;
    const contentType = responseContentType(response.headers);
    const mediaType = normalizeMediaType(contentType);
    const passthrough = passthroughOf(mediaType);
    const nativeJpeg = nativeJpegAvailable();

    await copyImage(
        passthroughUsable(passthrough, nativeJpeg)
            ? { bytes, mime: passthrough as string }
            : null,
        canvasTargetMime(mediaType, nativeJpeg),
        mime => rasterizeBytes(bytes, contentType ?? '', mime),
        {
            source: url,
            format: mediaType ?? 'unknown',
            pixels: 'unknown',
            reference,
        }
    );
}
