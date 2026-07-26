import { describe, it, expect } from 'vitest';
import {
  isSingleImageManual,
  singleImageScaleFor,
  formatSingleImageLine,
  normalizeSingleImageParams,
} from '../src/imageParse/singleImageParams';
import type { ImageGroup, ImageEmbed } from '../src/imageParse/imageDetector';

function embed(raw: string): ImageEmbed {
  return {
    line: 0,
    raw,
    fileName: 'a.webp',
    explicitWidth: null,
    hasExplicitWidth: false,
    flexGrow: 1,
    scale: null,
  };
}

function group(...raws: string[]): ImageGroup {
  const images = raws.map((r, i) => ({ ...embed(r), line: i }));
  return { lineStart: 0, lineEnd: images.length, images };
}

describe('isSingleImageManual', () => {
  it('is true only when the stored scale encodes S=1 (round(scale*100)===1)', () => {
    expect(isSingleImageManual(0.01)).toBe(true);
  });

  it('is false for S=0 (scale 0), null, and multi-image scales', () => {
    expect(isSingleImageManual(0)).toBe(false);
    expect(isSingleImageManual(null)).toBe(false);
    expect(isSingleImageManual(1)).toBe(false);    // multi leftover |W|100
    expect(isSingleImageManual(0.48)).toBe(false); // multi leftover |W|48
  });
});

describe('singleImageScaleFor', () => {
  it('maps the manual flag to a stored scale slot', () => {
    expect(singleImageScaleFor(true)).toBe(0.01);
    expect(singleImageScaleFor(false)).toBe(0);
  });

  it('round-trips through isSingleImageManual', () => {
    expect(isSingleImageManual(singleImageScaleFor(true))).toBe(true);
    expect(isSingleImageManual(singleImageScaleFor(false))).toBe(false);
  });
});

describe('formatSingleImageLine (|S|W order)', () => {
  it('adds |S|W to a bare embed', () => {
    expect(formatSingleImageLine('![[a.webp]]', 350, 0)).toBe('![[a.webp|0|350]]');
    expect(formatSingleImageLine('![[a.webp]]', 700, 1)).toBe('![[a.webp|1|700]]');
  });

  it('replaces existing single params', () => {
    expect(formatSingleImageLine('![[a.webp|350]]', 700, 1)).toBe('![[a.webp|1|700]]');
    expect(formatSingleImageLine('![[a.webp|0|350]]', 700, 1)).toBe('![[a.webp|1|700]]');
  });

  it('replaces multi-image leftover params (|W|S)', () => {
    expect(formatSingleImageLine('![[a.webp|114|100]]', 300, 0)).toBe('![[a.webp|0|300]]');
  });

  it('rounds and floors the width to at least 1', () => {
    expect(formatSingleImageLine('![[a.webp]]', 349.6, 1)).toBe('![[a.webp|1|350]]');
    expect(formatSingleImageLine('![[a.webp]]', 0, 0)).toBe('![[a.webp|0|1]]');
  });

  it('preserves surrounding text and leading whitespace', () => {
    expect(formatSingleImageLine('  ![[a.webp|1|50]]', 200, 0)).toBe('  ![[a.webp|0|200]]');
  });

  it('adds alignment prepended to S|W', () => {
    expect(formatSingleImageLine('![[a.webp]]', 350, 0, 'left')).toBe('![[a.webp|left|0|350]]');
    expect(formatSingleImageLine('![[a.webp]]', 700, 1, 'center')).toBe('![[a.webp|center|1|700]]');
  });

  it('replaces existing params with alignment', () => {
    expect(formatSingleImageLine('![[a.webp|0|350]]', 700, 1, 'right')).toBe('![[a.webp|right|1|700]]');
    expect(formatSingleImageLine('![[a.webp|left|0|350]]', 500, 0, 'center')).toBe('![[a.webp|center|0|500]]');
  });

  it('omits alignment when undefined', () => {
    expect(formatSingleImageLine('![[a.webp]]', 350, 0)).toBe('![[a.webp|0|350]]');
  });
});

describe('normalizeSingleImageParams', () => {
  it('maps manual |S|W (S=1) to flexGrow=W/100, scale=0.01', () => {
    const g = group('![[a.webp|1|350]]');
    normalizeSingleImageParams(g);
    const img = g.images[0];
    expect(img.explicitWidth).toBe(350);
    expect(img.hasExplicitWidth).toBe(true);
    expect(img.flexGrow).toBeCloseTo(3.5);
    expect(isSingleImageManual(img.scale)).toBe(true);
  });

  it('maps setting-driven |S|W (S=0) to flexGrow=W/100, scale=0', () => {
    const g = group('![[a.webp|0|420]]');
    normalizeSingleImageParams(g);
    const img = g.images[0];
    expect(img.explicitWidth).toBe(420);
    expect(img.flexGrow).toBeCloseTo(4.2);
    expect(img.scale).toBe(0);
    expect(isSingleImageManual(img.scale)).toBe(false);
  });

  it('treats a bare embed as setting-driven (no explicit width)', () => {
    const g = group('![[a.webp]]');
    normalizeSingleImageParams(g);
    const img = g.images[0];
    expect(img.hasExplicitWidth).toBe(false);
    expect(img.explicitWidth).toBe(null);
    expect(img.flexGrow).toBe(1);
    expect(img.scale).toBe(null);
  });

  it('resets a multi-image leftover |W|S (first param ≥ 2) to setting-driven', () => {
    // A line that just left a multi-image row keeps `|W|S` (weight, scale). As a
    // now-single group it must NOT be read as a manual single — reset fully.
    const g = group('![[a.webp|150|100]]');
    normalizeSingleImageParams(g);
    const img = g.images[0];
    expect(img.hasExplicitWidth).toBe(false);
    expect(img.explicitWidth).toBe(null);
    expect(img.flexGrow).toBe(1);
    expect(img.scale).toBe(null);
    expect(isSingleImageManual(img.scale)).toBe(false);
  });

  it('resets a legacy single-param |W to setting-driven', () => {
    const g = group('![[a.webp|600]]');
    normalizeSingleImageParams(g);
    const img = g.images[0];
    expect(img.hasExplicitWidth).toBe(false);
    expect(img.scale).toBe(null);
  });

  it('leaves multi-image groups untouched (keeps |W|S semantics)', () => {
    const g = group('![[a.webp|740|48]]', '![[b.webp|100|60]]');
    const before = g.images.map((i) => ({ ...i }));
    normalizeSingleImageParams(g);
    expect(g.images[0]).toEqual(before[0]);
    expect(g.images[1]).toEqual(before[1]);
  });

  // ── alignment in single-image params ──

  it('maps |left|1|350 to alignment=left, flexGrow=3.5, scale=0.01', () => {
    const g = group('![[a.webp|left|1|350]]');
    normalizeSingleImageParams(g);
    const img = g.images[0];
    expect(img.alignment).toBe('left');
    expect(img.explicitWidth).toBe(350);
    expect(img.flexGrow).toBeCloseTo(3.5);
    expect(isSingleImageManual(img.scale)).toBe(true);
  });

  it('maps |center|0|420 to alignment=center, S=0 (setting-driven)', () => {
    const g = group('![[a.webp|center|0|420]]');
    normalizeSingleImageParams(g);
    const img = g.images[0];
    expect(img.alignment).toBe('center');
    expect(img.explicitWidth).toBe(420);
    expect(img.scale).toBe(0);
    expect(isSingleImageManual(img.scale)).toBe(false);
  });

  it('maps |right|0|300 to alignment=right', () => {
    const g = group('![[a.webp|right|0|300]]');
    normalizeSingleImageParams(g);
    expect(g.images[0].alignment).toBe('right');
    expect(g.images[0].explicitWidth).toBe(300);
  });

  it('handles alignment-only without S|W (resets to setting-driven)', () => {
    const g = group('![[a.webp|left]]');
    normalizeSingleImageParams(g);
    const img = g.images[0];
    expect(img.alignment).toBe('left');
    expect(img.hasExplicitWidth).toBe(false);
    expect(img.scale).toBe(null);
  });
});
