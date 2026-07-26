import { describe, it, expect } from 'vitest';
import { classifyCenter, ImageRowIndex } from '../src/anchor/viewportAnchor';

const IMG = /!\[\[.*\.(?:png|jpg|jpeg|gif|webp|svg|bmp|avif)/i;

function run(lines: string[], imgIndex: ImageRowIndex[], centerLine: number) {
  const isBlank = (n: number) => lines[n - 1].trim() === '';
  const isImage = (n: number) => IMG.test(lines[n - 1]);
  return classifyCenter(lines.length, isBlank, isImage, imgIndex, centerLine);
}

// Doc A: text / blank / [a,b] / blank×2 / [c] / blank / text
const docA = [
  '# Title',      // 1 text
  '',             // 2 blank
  '![[a.png]]',   // 3 img row 1
  '![[b.png]]',   // 4 img row 1
  '',             // 5 blank
  '',             // 6 blank
  '![[c.png]]',   // 7 img row 2
  '',             // 8 blank
  'tail text',    // 9 text
];
const idxA: ImageRowIndex[] = [
  { index: 1, startLine: 3, endLine: 4 },
  { index: 2, startLine: 7, endLine: 7 },
];

describe('classifyCenter', () => {
  it('center inside an image row → image-row', () => {
    expect(run(docA, idxA, 3)).toEqual({ kind: 'image-row', imageRowIndex: 1 });
    expect(run(docA, idxA, 4)).toEqual({ kind: 'image-row', imageRowIndex: 1 });
    expect(run(docA, idxA, 7)).toEqual({ kind: 'image-row', imageRowIndex: 2 });
  });

  it('center in a pure blank gap between two image rows → two-sided image-gap', () => {
    expect(run(docA, idxA, 5)).toEqual({ kind: 'image-gap', imgBefore: 1, imgAfter: 2 });
    expect(run(docA, idxA, 6)).toEqual({ kind: 'image-gap', imgBefore: 1, imgAfter: 2 });
  });

  it('text neighbor above (off-screen) → single-sided gap anchored below', () => {
    // line 2 blank; up=1 is text, down=3 is image row 1
    expect(run(docA, idxA, 2)).toEqual({ kind: 'image-gap', imgBefore: 0, imgAfter: 1 });
  });

  it('text neighbor below (off-screen) → single-sided gap anchored above', () => {
    // line 8 blank; up=7 image row 2, down=9 text
    expect(run(docA, idxA, 8)).toEqual({ kind: 'image-gap', imgBefore: 2, imgAfter: 0 });
  });

  // Doc B: blank×2 / [a] / blank / [b] / blank  (document boundaries, no text)
  const docB = ['', '', '![[a.png]]', '', '![[b.png]]', ''];
  const idxB: ImageRowIndex[] = [
    { index: 1, startLine: 3, endLine: 3 },
    { index: 2, startLine: 5, endLine: 5 },
  ];

  it('center above the first image row (top boundary) → single-sided gap below', () => {
    expect(run(docB, idxB, 1)).toEqual({ kind: 'image-gap', imgBefore: 0, imgAfter: 1 });
  });

  it('center below the last image row (bottom boundary) → single-sided gap above', () => {
    expect(run(docB, idxB, 6)).toEqual({ kind: 'image-gap', imgBefore: 2, imgAfter: 0 });
  });

  it('center in the mid blank of boundary doc → two-sided gap', () => {
    expect(run(docB, idxB, 4)).toEqual({ kind: 'image-gap', imgBefore: 1, imgAfter: 2 });
  });

  it('single blank line between adjacent image rows → two-sided gap', () => {
    const lines = ['![[a.png]]', '', '![[b.png]]'];
    const idx: ImageRowIndex[] = [
      { index: 1, startLine: 1, endLine: 1 },
      { index: 2, startLine: 3, endLine: 3 },
    ];
    expect(run(lines, idx, 2)).toEqual({ kind: 'image-gap', imgBefore: 1, imgAfter: 2 });
  });

  it('blank bracketed by text on both sides → none', () => {
    const lines = ['text before', '', 'text after'];
    expect(run(lines, [], 2)).toEqual({ kind: 'none' });
  });
});
