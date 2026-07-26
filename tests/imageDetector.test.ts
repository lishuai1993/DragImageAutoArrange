import { describe, it, expect } from 'vitest';
import {
  parseImageLine,
  detectImageGroups,
  isImageLine,
  ImageGroup,
} from '../src/imageParse/imageDetector';
import { buildImageLineRe } from '../src/constants';

const rePng = buildImageLineRe('png,jpg');
const reGif = buildImageLineRe('gif,webp');

// ── parseImageLine ──
describe('parseImageLine', () => {
  it('parses line with explicit width', () => {
    const r = parseImageLine('![[photo.png|200]]', 3, rePng);
    expect(r).not.toBeNull();
    expect(r!.line).toBe(3);
    expect(r!.raw).toBe('![[photo.png|200]]');
    expect(r!.fileName).toBe('photo.png');
    expect(r!.explicitWidth).toBe(200);
    expect(r!.hasExplicitWidth).toBe(true);
    expect(r!.flexGrow).toBe(2); // 200/100
  });

  it('parses line without width', () => {
    const r = parseImageLine('![[photo.png]]', 0, rePng);
    expect(r).not.toBeNull();
    expect(r!.explicitWidth).toBeNull();
    expect(r!.hasExplicitWidth).toBe(false);
    expect(r!.flexGrow).toBe(1);
  });

  it('parses line with dimensions (WxH format)', () => {
    const r = parseImageLine('![[photo.png|800x600]]', 1, rePng);
    expect(r).not.toBeNull();
    expect(r!.explicitWidth).toBe(800);
  });

  it('returns null for non-image line', () => {
    const r = parseImageLine('# Heading', 0, rePng);
    expect(r).toBeNull();
  });

  it('parses image with path', () => {
    const r = parseImageLine('![[folder/photo.jpg|150]]', 2, rePng);
    expect(r).not.toBeNull();
    expect(r!.fileName).toBe('folder/photo.jpg');
  });

  it('parses line without explicit width from raw param', () => {
    // No pipe at all
    const r = parseImageLine('![[img.png]]', 0, rePng);
    expect(r).not.toBeNull();
    expect(r!.explicitWidth).toBeNull();
    expect(r!.flexGrow).toBe(1);
  });

  // ── alignment parsing ──

  it('parses multi-image line with alignment prepended', () => {
    const r = parseImageLine('![[a.png|left|120|50]]', 0, rePng);
    expect(r).not.toBeNull();
    expect(r!.alignment).toBe('left');
    expect(r!.explicitWidth).toBe(120);
    expect(r!.flexGrow).toBe(1.2);
    expect(r!.scale).toBe(0.5);
  });

  it('parses multi-image line with center alignment', () => {
    const r = parseImageLine('![[a.png|center|150|80]]', 0, rePng);
    expect(r!.alignment).toBe('center');
    expect(r!.flexGrow).toBe(1.5);
    expect(r!.scale).toBe(0.8);
  });

  it('parses multi-image line with right alignment', () => {
    const r = parseImageLine('![[a.png|right|200|100]]', 0, rePng);
    expect(r!.alignment).toBe('right');
    expect(r!.flexGrow).toBe(2.0);
    expect(r!.scale).toBe(1.0);
  });

  it('parses single-image line with alignment prepended', () => {
    const r = parseImageLine('![[a.png|left|0|350]]', 0, rePng);
    expect(r).not.toBeNull();
    expect(r!.alignment).toBe('left');
    // parseImageLine uses multi convention (firstNum=explicitWidth, last=scale).
    // normalizeSingleImageParams fixes this later for singles.
    expect(r!.explicitWidth).toBe(0);
    expect(r!.scale).toBe(3.5);
  });

  it('returns undefined alignment when not present', () => {
    const r = parseImageLine('![[a.png|120|50]]', 0, rePng);
    expect(r!.alignment).toBeUndefined();
    expect(r!.explicitWidth).toBe(120);
    expect(r!.scale).toBe(0.5);
  });

  it('parses multi-image line with alignment but no scale (single numeric not double-assigned)', () => {
    const r = parseImageLine('![[a.png|left|120]]', 0, rePng);
    expect(r!.alignment).toBe('left');
    expect(r!.explicitWidth).toBe(120);
    expect(r!.scale).toBeNull(); // only one numeric — not double-assigned, backfill handles it
  });
});

// ── detectImageGroups ──
describe('detectImageGroups', () => {
  it('returns empty for empty text', () => {
    const groups = detectImageGroups('', 10, 'png,jpg');
    expect(groups).toEqual([]);
  });

  it('returns empty for text with no images', () => {
    const groups = detectImageGroups('Just some text\nMore text', 10, 'png,jpg');
    expect(groups).toEqual([]);
  });

  it('single image → one group', () => {
    const groups = detectImageGroups('![[a.png]]', 10, 'png,jpg');
    expect(groups).toHaveLength(1);
    expect(groups[0].images).toHaveLength(1);
    expect(groups[0].images[0].fileName).toBe('a.png');
  });

  it('two consecutive images → one group', () => {
    const groups = detectImageGroups('![[a.png]]\n![[b.png]]', 10, 'png,jpg');
    expect(groups).toHaveLength(1);
    expect(groups[0].images).toHaveLength(2);
  });

  it('images separated by text → multiple groups', () => {
    const groups = detectImageGroups(
      '![[a.png]]\nSome text\n![[b.png]]',
      10,
      'png,jpg'
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].images).toHaveLength(1);
    expect(groups[1].images).toHaveLength(1);
  });

  it('splits oversized groups by maxImagesPerRow', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `![[img${i}.png]]`).join('\n');
    const groups = detectImageGroups(lines, 3, 'png,jpg');
    expect(groups).toHaveLength(2);
    expect(groups[0].images).toHaveLength(3);
    expect(groups[1].images).toHaveLength(2);
  });

  it('groups consecutive images from different extensions', () => {
    const groups = detectImageGroups('![[a.png]]\n![[b.jpg]]', 10, 'png,jpg');
    expect(groups).toHaveLength(1);
    expect(groups[0].images).toHaveLength(2);
  });

  it('respects lineStart/lineEnd positions', () => {
    const text = 'text before\n![[a.png]]\n![[b.png]]\ntext after\n![[c.png]]';
    const groups = detectImageGroups(text, 10, 'png,jpg');
    expect(groups).toHaveLength(2);
    expect(groups[0].lineStart).toBe(1);
    expect(groups[0].lineEnd).toBe(3);
    expect(groups[1].lineStart).toBe(4);
    expect(groups[1].lineEnd).toBe(5);
  });
});

// ── isImageLine ──
describe('isImageLine', () => {
  it('matches valid PNG', () => {
    expect(isImageLine('![[image.png]]', 'png,jpg')).toBe(true);
  });

  it('does not match unsupported extension', () => {
    expect(isImageLine('![[doc.pdf]]', 'png,jpg')).toBe(false);
  });

  it('does not match plain text', () => {
    expect(isImageLine('Hello world', 'png,jpg')).toBe(false);
  });

  it('matches supported GIF', () => {
    expect(isImageLine('![[anim.gif]]', 'gif,webp')).toBe(true);
  });
});
