/**
 * Tests for the clipboard format rules: which sources are handed to the
 * pasteboard unchanged (skipping the canvas re-encode), and what the canvas
 * re-encodes the rest as.
 */
import { describe, it, expect, vi } from 'vitest';
import { TFile } from 'obsidian';
import {
  canvasTargetMime,
  mediaTypeOfFile,
  nativeMimeOf,
  normalizeMediaType,
  passthroughMime,
  reencodeMime,
} from '../src/imageMenu/clipboard';

vi.mock('obsidian', () => {
  class MockTFile {
    extension = '';
  }
  return {
    TFile: MockTFile,
    requestUrl: vi.fn(),
    Platform: { isDesktopApp: true, isMobile: false },
  };
});

function file(extension: string): TFile {
  const f = new TFile();
  f.extension = extension;
  return f;
}

describe('nativeMimeOf', () => {
  it('passes PNG and both JPEG spellings straight through', () => {
    expect(nativeMimeOf(file('png'))).toBe('image/png');
    expect(nativeMimeOf(file('jpg'))).toBe('image/jpeg');
    expect(nativeMimeOf(file('jpeg'))).toBe('image/jpeg');
  });

  it('is case-insensitive', () => {
    expect(nativeMimeOf(file('PNG'))).toBe('image/png');
    expect(nativeMimeOf(file('JpEg'))).toBe('image/jpeg');
  });

  it('routes formats Chromium will not take as-is to the canvas', () => {
    for (const ext of ['webp', 'gif', 'avif', 'bmp', 'svg']) {
      expect(nativeMimeOf(file(ext))).toBeNull();
    }
  });
});

describe('mediaTypeOfFile', () => {
  it('names every format we model, pass-through or not', () => {
    expect(mediaTypeOfFile(file('webp'))).toBe('image/webp');
    expect(mediaTypeOfFile(file('avif'))).toBe('image/avif');
    expect(mediaTypeOfFile(file('gif'))).toBe('image/gif');
    expect(mediaTypeOfFile(file('PNG'))).toBe('image/png');
  });

  it('returns null for an extension it does not model', () => {
    expect(mediaTypeOfFile(file('tiff'))).toBeNull();
  });
});

describe('passthroughMime', () => {
  it('passes PNG and JPEG content types through', () => {
    expect(passthroughMime('image/png')).toBe('image/png');
    expect(passthroughMime('image/jpeg')).toBe('image/jpeg');
  });

  it('drops charset and casing', () => {
    expect(passthroughMime('image/png; charset=utf-8')).toBe('image/png');
    expect(passthroughMime('IMAGE/JPEG;charset=binary')).toBe('image/jpeg');
  });

  it('routes everything else to the canvas', () => {
    expect(passthroughMime('image/webp')).toBeNull();
    expect(passthroughMime('image/svg+xml')).toBeNull();
    expect(passthroughMime('text/html')).toBeNull();
    expect(passthroughMime('')).toBeNull();
    expect(passthroughMime(null)).toBeNull();
  });
});

describe('normalizeMediaType', () => {
  it('strips parameters and casing, and maps an extension to its type', () => {
    expect(normalizeMediaType('IMAGE/WEBP')).toBe('image/webp');
    expect(normalizeMediaType('image/avif; codecs=av01')).toBe('image/avif');
    expect(normalizeMediaType('webp')).toBe('image/webp');
    expect(normalizeMediaType('  PNG  ')).toBe('image/png');
  });

  it('returns null for nothing at all', () => {
    expect(normalizeMediaType('')).toBeNull();
    expect(normalizeMediaType(null)).toBeNull();
  });
});

describe('reencodeMime', () => {
  it('re-encodes the lossy family as JPEG, which JPEG cannot do transparently', () => {
    expect(reencodeMime('image/webp')).toBe('image/jpeg');
    expect(reencodeMime('image/avif')).toBe('image/jpeg');
  });

  it('keeps PNG for the lossless family and for anything unrecognised', () => {
    expect(reencodeMime('image/gif')).toBe('image/png');
    expect(reencodeMime('image/bmp')).toBe('image/png');
    expect(reencodeMime('image/png')).toBe('image/png');
    expect(reencodeMime(null)).toBe('image/png');
  });
});

describe('canvasTargetMime', () => {
  it('encodes the lossy family as JPEG only where a native writer can take it', () => {
    expect(canvasTargetMime('image/webp', true)).toBe('image/jpeg');
    expect(canvasTargetMime('image/avif', true)).toBe('image/jpeg');
    // Without the native writer the Web clipboard refuses image/jpeg outright,
    // so a JPEG request would put nothing on the pasteboard.
    expect(canvasTargetMime('image/webp', false)).toBe('image/png');
    expect(canvasTargetMime('image/avif', false)).toBe('image/png');
  });

  it('keeps PNG for everything the lossy family does not cover', () => {
    for (const mediaType of ['image/gif', 'image/bmp', 'image/png', 'image/jpeg', null]) {
      expect(canvasTargetMime(mediaType, true)).toBe('image/png');
    }
  });
});
