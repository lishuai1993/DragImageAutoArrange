/**
 * Tests for the Electron-clipboard module: the byte fingerprint that identifies a
 * JPEG this plugin put on the pasteboard, and the reference memory that rides on it
 * in place of the text flavour `writeBuffer` cannot leave behind.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fingerprintMatches, fingerprintOf } from '../src/imageMenu/nativeClipboard';

const payloadOf = (length: number, offset = 0): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (i + offset) % 256);

describe('fingerprint', () => {
  it('keeps the length and both ends of the payload', () => {
    const fp = fingerprintOf(Uint8Array.from([1, 2, 3, 4, 5]));
    expect(fp.length).toBe(5);
    expect(fp.head).toEqual([1, 2, 3, 4, 5]);
    expect(fp.tail).toEqual([1, 2, 3, 4, 5]);
  });

  it('accepts the exact bytes it was taken from', () => {
    const payload = payloadOf(100);
    expect(fingerprintMatches(fingerprintOf(payload), payload)).toBe(true);
  });

  it('rejects a payload of a different length', () => {
    expect(fingerprintMatches(fingerprintOf(payloadOf(100)), payloadOf(101))).toBe(false);
  });

  it('rejects a payload that differs at either end', () => {
    const fp = fingerprintOf(payloadOf(100));
    const headOff = payloadOf(100);
    headOff[0] = 255;
    const tailOff = payloadOf(100);
    tailOff[99] = 255;

    expect(fingerprintMatches(fp, headOff)).toBe(false);
    expect(fingerprintMatches(fp, tailOff)).toBe(false);
  });

  it('copes with payloads shorter than one fingerprint window', () => {
    const fp = fingerprintOf(Uint8Array.from([9]));
    expect(fingerprintMatches(fp, Uint8Array.from([9]))).toBe(true);
    expect(fingerprintMatches(fp, Uint8Array.from([8]))).toBe(false);
  });
});

interface Write {
  format: string;
  bytes: Uint8Array;
}

/** A stand-in Electron clipboard whose board holds whatever was written last. */
interface ClipboardStub {
  board: Uint8Array | null;
  writes: Write[];
  writeBuffer(format: string, bytes: Uint8Array): void;
  readBuffer(): Uint8Array | null;
}

function installNative(initial: Uint8Array | null = null): ClipboardStub {
  const stub: ClipboardStub = {
    board: initial,
    writes: [],
    writeBuffer(format, bytes) {
      this.writes.push({ format, bytes });
      this.board = bytes;
    },
    readBuffer: () => stub.board,
  };
  (window as unknown as { require?: unknown }).require = (id: string) =>
    id === 'electron' ? { clipboard: stub } : undefined;
  return stub;
}

/** A fresh module instance, so its one-shot `require` probe re-runs. */
async function nativeModule(): Promise<typeof import('../src/imageMenu/nativeClipboard')> {
  vi.resetModules();
  return import('../src/imageMenu/nativeClipboard');
}

const originalRequire = (window as unknown as { require?: unknown }).require;

afterEach(() => {
  (window as unknown as { require?: unknown }).require = originalRequire;
});

describe('nativeJpegAvailable', () => {
  it('is false when the renderer hands over no require', async () => {
    (window as unknown as { require?: unknown }).require = undefined;
    const mod = await nativeModule();
    expect(mod.nativeJpegAvailable()).toBe(false);
  });

  it('is false when require yields no clipboard', async () => {
    (window as unknown as { require?: unknown }).require = () => undefined;
    const mod = await nativeModule();
    expect(mod.nativeJpegAvailable()).toBe(false);
  });

  it('is true once require yields an Electron clipboard', async () => {
    installNative();
    const mod = await nativeModule();
    expect(mod.nativeJpegAvailable()).toBe(true);
  });

  it('refuses to write without a native clipboard', async () => {
    (window as unknown as { require?: unknown }).require = undefined;
    const mod = await nativeModule();
    expect(mod.writeJpeg(Uint8Array.from([1, 2, 3]))).toBe(false);
  });

  it('writes JPEG bytes under the pasteboard UTI', async () => {
    const stub = installNative();
    const mod = await nativeModule();

    expect(mod.writeJpeg(Uint8Array.from([1, 2, 3]))).toBe(true);
    expect(stub.writes).toHaveLength(1);
    expect(stub.writes[0].format).toBe('public.jpeg');
  });
});

describe('reference memory', () => {
  it('recalls a reference only while the pasteboard still holds its bytes', async () => {
    const payload = payloadOf(64);
    const stub = installNative();
    const mod = await nativeModule();

    mod.rememberReference('![[a.png]]', payload);
    // Nothing written yet, so the board holds nothing of ours.
    expect(mod.recallReference()).toBeNull();

    mod.writeJpeg(payload);
    expect(mod.recallReference()).toBe('![[a.png]]');

    // A copy from another app reads back different bytes.
    stub.board = payloadOf(64, 1);
    expect(mod.recallReference()).toBeNull();
  });

  it('recalls nothing after the memory is forgotten', async () => {
    const payload = payloadOf(64);
    installNative();
    const mod = await nativeModule();

    mod.rememberReference('![[a.png]]', payload);
    mod.writeJpeg(payload);
    mod.forgetReference();
    expect(mod.recallReference()).toBeNull();
  });

  it('arms nothing for a copy that carries no reference', async () => {
    const payload = payloadOf(64);
    const stub = installNative();
    const mod = await nativeModule();

    mod.rememberReference(undefined, payload);
    mod.writeJpeg(payload);
    expect(stub.writes).toHaveLength(1);
    expect(mod.recallReference()).toBeNull();
  });
});
