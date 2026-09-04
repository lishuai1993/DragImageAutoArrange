import { describe, it, expect } from 'vitest';
import { buildImageRowIndex, toLine1, ImageRowIndex } from '../src/anchor/viewportAnchor';
import { detectRowGroups } from '../src/imageParse/imageDetector';
import { buildImageLineRe } from '../src/constants';

const EXTS = 'png,jpg,jpeg,gif,webp,svg,bmp,avif';
const RE = buildImageLineRe(EXTS);

// Fixture: text / blank / [a,b] / blank / text / [c,d,e] / blank / [f]
// (0-based line comments make the base explicit).
const doc = [
  '# Title',              // 0 text
  '',                     // 1 blank
  '![[a.png]]',           // 2 img row 1
  '![[b.png]]',           // 3 img row 1
  '',                     // 4 blank
  'some text',            // 5 text
  '![[c.png|left|120|50]]',// 6 img row 2
  '![[d.png]]',           // 7 img row 2
  '![[e.png]]',           // 8 img row 2
  '',                     // 9 blank
  '![[f.png]]',           // 10 img row 3 (last line, closes at EOF)
];

/** Independent re-derivation of the invariants (separate from the module's own
 *  self-check) so a broken buildImageRowIndex fails a test, not just a WARN. */
function assertInvariants(rows: ImageRowIndex[], lineCount: number) {
  let prevEnd = 0;
  rows.forEach((r, i) => {
    expect(r.index).toBe(i + 1);              // contiguous, 1-based
    expect(r.startLine).toBeGreaterThanOrEqual(1); // 1-based
    expect(r.endLine).toBeGreaterThanOrEqual(r.startLine); // ordered
    expect(r.startLine).toBeGreaterThan(prevEnd);  // strictly increasing / no overlap
    expect(r.endLine).toBeLessThanOrEqual(lineCount);
    prevEnd = r.endLine;
  });
}

describe('buildImageRowIndex', () => {
  it('produces 1-based, ordered, non-overlapping, contiguous rows', () => {
    const rows = buildImageRowIndex(doc, RE);
    expect(rows.map(r => `${r.index}:${r.startLine}-${r.endLine}`)).toEqual([
      '1:3-4', '2:7-9', '3:11-11',
    ]);
    assertInvariants(rows, doc.length);
  });

  it('closes an image row that runs to the end of the document', () => {
    const rows = buildImageRowIndex(['![[a.png]]', '![[b.png]]'], RE);
    expect(rows).toEqual([{ index: 1, startLine: 1, endLine: 2 }]);
    assertInvariants(rows, 2);
  });

  it('returns no rows for an image-free document', () => {
    expect(buildImageRowIndex(['# Title', '', 'text'], RE)).toEqual([]);
  });

  // CONTRACT: every RowImage.line (0-based, from detectRowGroups), once passed
  // through toLine1, must land inside the [startLine, endLine] of the row it
  // belongs to. This is the exact off-by-one that silently froze RM anchoring;
  // pin it in CI.
  it('every parsed image (0-based) maps via toLine1 into its row range', () => {
    const rows = buildImageRowIndex(doc, RE);
    const inSomeRow = (line1: number) =>
      rows.some(r => line1 >= r.startLine && line1 <= r.endLine);

    const images = detectRowGroups(doc.join('\n'), 10, EXTS).flatMap(g => g.images);
    expect(images.map(img => img.line)).toEqual([2, 3, 6, 7, 8, 10]); // a..f
    for (const img of images) {
      expect(inSomeRow(toLine1(img.line))).toBe(true); // toLine1 lands in a row
    }
  });
});
