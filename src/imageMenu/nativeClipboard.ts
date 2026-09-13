/**
 * Electron's own clipboard, for the one job the Web clipboard cannot do here.
 *
 * `navigator.clipboard` refuses `image/jpeg` on this Chromium ("Type image/jpeg
 * not supported on write", measured), so any source that wants a JPEG flavour — a
 * JPEG file, or a webp/avif re-encode — would otherwise be handed over as a
 * lossless PNG. For a 1920×1440 photo that is 5.5 MB against 1.0 MB as JPEG, and
 * the receiving app pays again to read it. Electron's `writeBuffer` takes the bytes
 * under a real pasteboard type, so the compact flavour lands as-is.
 *
 * The catch, also measured: `writeBuffer` replaces the whole pasteboard on every
 * call, so a `text/plain` reference cannot ride along (writing text after the image
 * leaves only the text; reversing the order loses the image instead). The reference
 * is therefore kept in memory here and confirmed at paste time by matching the
 * clipboard's own bytes. That is a stronger test than the text flavour ever was —
 * anyone can put an `![[…]]` string on the clipboard, but only our own write
 * reproduces these bytes.
 *
 * The plugin ships `isDesktopOnly: true`, and the module is probed at runtime
 * rather than assumed, so a sandbox that withholds `require` degrades to the Web
 * clipboard instead of failing.
 */

import { Platform } from 'obsidian';
import { logger } from '../logger';

const log = logger.channel('nativeClipboard');

/** macOS pasteboard type for JPEG. */
const JPEG_UTI = 'public.jpeg';

/** Bytes sampled from each end of a payload to identify it. */
const FINGERPRINT_BYTES = 32;

interface ElectronClipboard {
    writeBuffer(format: string, buffer: unknown): void;
    readBuffer(format: string): Uint8Array | null;
}

interface ElectronModule {
    clipboard: ElectronClipboard;
}

/** `undefined` = not probed yet, `null` = probed and unavailable. */
let probed: ElectronModule | null | undefined;

function electron(): ElectronModule | null {
    if (probed !== undefined) return probed;
    let found: ElectronModule | null = null;
    try {
        if (Platform.isDesktopApp) {
            const req = (window as unknown as { require?: (id: string) => unknown }).require;
            const mod = typeof req === 'function'
                ? (req('electron') as Partial<ElectronModule> | undefined)
                : undefined;
            if (mod?.clipboard?.writeBuffer) found = mod as ElectronModule;
        }
    } catch {
        found = null;
    }
    probed = found;
    return probed;
}

/** Whether a JPEG can reach the pasteboard on this install. */
export function nativeJpegAvailable(): boolean {
    return electron() !== null;
}

/** `writeBuffer` insists on a real Node Buffer (`node::Buffer::HasInstance`). */
function nodeBuffer(bytes: Uint8Array): unknown {
    const ctor = (window as unknown as { Buffer?: { from(input: Uint8Array): unknown } }).Buffer;
    return ctor ? ctor.from(bytes) : bytes;
}

/** Put JPEG bytes on the pasteboard. False when this install has no native clipboard. */
export function writeJpeg(bytes: Uint8Array): boolean {
    const el = electron();
    if (!el) return false;
    try {
        el.clipboard.writeBuffer(JPEG_UTI, nodeBuffer(bytes));
        return true;
    } catch (error) {
        log.warn('LOG_NATIVE_CLIPBOARD_WRITE_FAILED', { error: String(error) });
        return false;
    }
}

function readJpeg(): Uint8Array | null {
    const el = electron();
    if (!el) return null;
    try {
        const bytes = el.clipboard.readBuffer(JPEG_UTI);
        return bytes && bytes.length > 0 ? bytes : null;
    } catch {
        return null;
    }
}

/** Length plus both ends of a payload — enough to recognise our own write. */
export interface Fingerprint {
    length: number;
    head: number[];
    tail: number[];
}

export function fingerprintOf(bytes: Uint8Array): Fingerprint {
    return {
        length: bytes.length,
        head: [...bytes.slice(0, FINGERPRINT_BYTES)],
        tail: [...bytes.slice(-FINGERPRINT_BYTES)],
    };
}

export function fingerprintMatches(fp: Fingerprint, bytes: Uint8Array): boolean {
    if (bytes.length !== fp.length) return false;
    const head = bytes.slice(0, fp.head.length);
    const tail = bytes.slice(bytes.length - fp.tail.length);
    return head.every((b, i) => b === fp.head[i]) && tail.every((b, i) => b === fp.tail[i]);
}

/** The reference the last native write carried, with the bytes that identify it. */
let remembered: { reference: string; fingerprint: Fingerprint } | null = null;

/** Arm (or, for a copy with no reference such as a cut, disarm) the memory. */
export function rememberReference(reference: string | undefined, bytes: Uint8Array): void {
    remembered = reference ? { reference, fingerprint: fingerprintOf(bytes) } : null;
}

/** Disarm — the reference no longer names anything worth inserting. */
export function forgetReference(): void {
    remembered = null;
}

/**
 * The remembered reference, but only when the clipboard still holds the exact
 * bytes we put there. A stale memory (a copy from another app, a write since) reads
 * back different bytes and yields null, so a paste can never be mis-hijacked.
 */
export function recallReference(): string | null {
    if (!remembered) return null;
    const bytes = readJpeg();
    if (!bytes || !fingerprintMatches(remembered.fingerprint, bytes)) return null;
    return remembered.reference;
}
