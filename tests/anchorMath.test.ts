import { describe, it, expect } from 'vitest';
import {
  clamp01, intraRowRatio, gapRatioFromGeom,
  imageRowTargetY, gapJunction, gapTargetY, textTargetY,
  nearestIndexBy, ledgerYForLine, ledgerLineForY, ledgerTotalHeight,
  sectionIndexEstimateY, extrapolateLedgerY, LedgerSection,
  clientTopToDocY, scrollTopToPct, pctToScrollTop,
} from '../src/anchor/anchorMath';

describe('clamp01', () => {
  it('clamps below 0, above 1, passes through inside', () => {
    expect(clamp01(-0.2)).toBe(0);
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(0.3)).toBe(0.3);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(1)).toBe(1);
  });
});

describe('intraRowRatio', () => {
  it('maps center between row top and bottom to [0,1]', () => {
    expect(intraRowRatio(100, 100, 100)).toBe(0);   // at top
    expect(intraRowRatio(150, 100, 100)).toBe(0.5); // at middle
    expect(intraRowRatio(200, 100, 100)).toBe(1);   // at bottom
  });
  it('returns RAW (unclamped) so callers can detect out-of-range geometry', () => {
    expect(intraRowRatio(80, 100, 100)).toBeCloseTo(-0.2, 10);
    expect(intraRowRatio(250, 100, 100)).toBeCloseTo(1.5, 10);
  });
  it('falls back to 0.5 when the row has no measurable height', () => {
    expect(intraRowRatio(150, 100, 0)).toBe(0.5);
    expect(intraRowRatio(150, 100, -20)).toBe(0.5);
  });
});

describe('gapRatioFromGeom', () => {
  it('maps center within the gap span to [0,1]', () => {
    expect(gapRatioFromGeom(100, 100, 200)).toBe(0); // flush top
    expect(gapRatioFromGeom(150, 100, 200)).toBe(0.5);
    expect(gapRatioFromGeom(200, 100, 200)).toBe(1); // flush bottom
  });
  it('returns RAW (unclamped) outside the span', () => {
    expect(gapRatioFromGeom(50, 100, 200)).toBeCloseTo(-0.5, 10);
  });
  it('falls back to 0.5 when the gap has no measurable span', () => {
    expect(gapRatioFromGeom(150, 200, 100)).toBe(0.5); // inverted
    expect(gapRatioFromGeom(150, 100, 100)).toBe(0.5); // zero span
  });
});

describe('imageRowTargetY', () => {
  it('centers the row ratio point in the viewport (RM: inset 0)', () => {
    expect(imageRowTargetY(500, 100, 0.5, 0, 400)).toBe(350);
  });
  it('adds the block→screen inset (LP)', () => {
    expect(imageRowTargetY(500, 100, 0.5, 86, 400)).toBe(436);
  });
  it('floors at 0', () => {
    expect(imageRowTargetY(10, 20, 0, 0, 400)).toBe(0);
  });
});

describe('gapJunction', () => {
  it('interpolates between both edges when two-sided', () => {
    expect(gapJunction(100, 300, 0.5)).toBe(200);
    expect(gapJunction(100, 300, 0)).toBe(100);
    expect(gapJunction(100, 300, 1)).toBe(300);
  });
  it('collapses to the single present edge', () => {
    expect(gapJunction(100, null, 0.5)).toBe(100); // upper row bottom
    expect(gapJunction(null, 300, 0.5)).toBe(300); // lower row top
  });
  it('returns null when neither side is present', () => {
    expect(gapJunction(null, null, 0.5)).toBeNull();
  });
});

describe('gapTargetY', () => {
  it('centers the junction in the viewport (RM: inset 0)', () => {
    expect(gapTargetY(500, 0, 400)).toBe(300);
  });
  it('adds the inset (LP)', () => {
    expect(gapTargetY(500, 86, 400)).toBe(386);
  });
  it('floors at 0', () => {
    expect(gapTargetY(10, 0, 400)).toBe(0);
  });
});

describe('textTargetY', () => {
  it('reproduces the captured distance from the viewport top (RM: inset 0)', () => {
    expect(textTargetY(500, 0, 100)).toBe(400);
  });
  it('adds the inset (LP)', () => {
    expect(textTargetY(500, 86, 100)).toBe(486);
  });
  it('floors at 0', () => {
    expect(textTargetY(50, 0, 100)).toBe(0);
  });
});

describe('nearestIndexBy', () => {
  it('returns the index of the closest key', () => {
    expect(nearestIndexBy([10, 20, 30], 22)).toBe(1);
    expect(nearestIndexBy([10, 20, 30], 29)).toBe(2);
    expect(nearestIndexBy([0.1, 0.5, 0.9], 0.6)).toBe(1);
  });
  it('keeps the earlier index on a tie', () => {
    expect(nearestIndexBy([10, 30], 20)).toBe(0);
  });
  it('handles a single candidate', () => {
    expect(nearestIndexBy([42], 0)).toBe(0);
  });
  it('returns -1 for an empty array', () => {
    expect(nearestIndexBy([], 5)).toBe(-1);
  });
  it('works with negative targets and keys', () => {
    expect(nearestIndexBy([-5, -1, 3], -2)).toBe(1);
  });
});

describe('ledgerYForLine', () => {
  // Sections mirror Obsidian's renderer.sections shape: 0-based contiguous
  // blocks, blank separator lines fall between lineEnd and the next lineStart.
  const sections: LedgerSection[] = [
    { lineStart: 0, lineEnd: 2, height: 100 },
    { lineStart: 4, lineEnd: 4, height: 50 },
    { lineStart: 6, lineEnd: 10, height: 300 },
  ];

  it('returns 0 for a line in the first section', () => {
    expect(ledgerYForLine(sections, 0)).toBe(0);
    expect(ledgerYForLine(sections, 2)).toBe(0);
  });
  it('sums preceding section heights for later sections', () => {
    expect(ledgerYForLine(sections, 4)).toBe(100);
    expect(ledgerYForLine(sections, 6)).toBe(150);
    expect(ledgerYForLine(sections, 10)).toBe(150);
  });
  it('parks a blank-gap line at the next section top', () => {
    expect(ledgerYForLine(sections, 3)).toBe(100);
    expect(ledgerYForLine(sections, 5)).toBe(150);
  });
  it('returns -1 past the last section or for negative lines', () => {
    expect(ledgerYForLine(sections, 11)).toBe(-1);
    expect(ledgerYForLine(sections, -1)).toBe(-1);
  });
  it('returns -1 on unusable shapes', () => {
    expect(ledgerYForLine([], 0)).toBe(-1);
    expect(ledgerYForLine([{ height: 'x' } as unknown as LedgerSection], 5)).toBe(-1);
  });
  it('tolerates gap/spacer entries without lineEnd', () => {
    const secs: LedgerSection[] = [
      { lineStart: 0, lineEnd: 2, height: 100 },
      { height: 20 },                                // gap — no lineEnd
      { lineStart: 4, lineEnd: 4, height: 50 },
      { height: 30 },                                // gap — no lineEnd
      { lineStart: 6, lineEnd: 10, height: 300 },
    ];
    // Line in first section (before any gap)
    expect(ledgerYForLine(secs, 0)).toBe(0);
    // Gap line between section 1 and section 2: parks at section 2's top (100 + 20)
    expect(ledgerYForLine(secs, 3)).toBe(120);
    // Line in section 2: top = 100 + 20 = 120
    expect(ledgerYForLine(secs, 4)).toBe(120);
    // Gap line between section 2 and section 3: parks at section 3's top (120 + 50 + 30)
    expect(ledgerYForLine(secs, 5)).toBe(200);
    // Line in section 3: top = 200
    expect(ledgerYForLine(secs, 6)).toBe(200);
    // Line past all sections
    expect(ledgerYForLine(secs, 11)).toBe(-1);
  });
  it('skips non-positive heights in the cumulative sum', () => {
    const secs: LedgerSection[] = [
      { lineStart: 0, lineEnd: 0, height: -10 },
      { lineStart: 2, lineEnd: 2, height: 40 },
      { lineStart: 4, lineEnd: 4, height: 60 },
    ];
    expect(ledgerYForLine(secs, 2)).toBe(0);
    expect(ledgerYForLine(secs, 4)).toBe(40);
  });
});

describe('ledgerLineForY', () => {
  const sections: LedgerSection[] = [
    { lineStart: 0, lineEnd: 2, height: 100 },
    { lineStart: 4, lineEnd: 4, height: 50 },
    { lineStart: 6, lineEnd: 10, height: 300 },
  ];

  it('maps y to the correct 1-based line', () => {
    expect(ledgerLineForY(sections, 0)).toBe(1);
    expect(ledgerLineForY(sections, 50)).toBe(2);   // halfway through first section → line 2
    expect(ledgerLineForY(sections, 99)).toBe(3);
    expect(ledgerLineForY(sections, 100)).toBe(5);
    expect(ledgerLineForY(sections, 140)).toBe(5);
    expect(ledgerLineForY(sections, 150)).toBe(7);
  });

  it('returns -1 for y past all sections or invalid inputs', () => {
    expect(ledgerLineForY(sections, 451)).toBe(-1);
    expect(ledgerLineForY([], 100)).toBe(-1);
    expect(ledgerLineForY(sections, -1)).toBe(-1);
  });

  it('tolerates gap entries without lineStart/lineEnd', () => {
    const gapped: LedgerSection[] = [
      { lineStart: 0, lineEnd: 2, height: 100 },
      { height: 20 },
      { lineStart: 4, lineEnd: 4, height: 50 },
    ];
    // Y in the gap (110): maps to first line of next section (line 5)
    expect(ledgerLineForY(gapped, 110)).toBe(5);
    // Y in second section
    expect(ledgerLineForY(gapped, 130)).toBe(5);
  });
});

describe('ledgerTotalHeight', () => {
  it('sums positive heights', () => {
    expect(ledgerTotalHeight([
      { lineStart: 0, lineEnd: 1, height: 100 },
      { lineStart: 2, lineEnd: 3, height: 50 },
    ])).toBe(150);
  });
  it('ignores non-positive heights, rejects unusable shapes', () => {
    expect(ledgerTotalHeight([
      { lineStart: 0, lineEnd: 1, height: -5 },
      { lineStart: 2, lineEnd: 3, height: 50 },
    ])).toBe(50);
    expect(ledgerTotalHeight([{ lineStart: 0, lineEnd: 1 }])).toBe(-1);
    expect(ledgerTotalHeight([])).toBe(0);
  });
});

describe('sectionIndexEstimateY', () => {
  // Simulated warmup section heights from a 2805-line document. The heights
  // are non-uniform: section 500-502 simulate a tall image row (~600px),
  // the rest are text-height sections (~30px each).
  const heights = Array.from({ length: 897 }, (_, i) => {
    if (i >= 500 && i <= 502) return 200; // image row
    return 30;
  });
  const totalLines = 2805;
  // Total: 894 * 30 + 3 * 200 = 26820 + 600 = 27420

  it('returns the cumulative height sum up to the estimated section index', () => {
    // Line 1000: idx ≈ floor(999/2805 * 897) = floor(0.356 * 897) = 319
    // sum = 319 * 30 = 9570
    const y = sectionIndexEstimateY(heights, totalLines, 1000);
    expect(y).toBeGreaterThan(9500);
    expect(y).toBeLessThan(9700);
  });

  it('returns 0 for line 1', () => {
    expect(sectionIndexEstimateY(heights, totalLines, 1)).toBe(0);
  });

  it('tall image sections push later lines to higher Y correctly', () => {
    // Line 1570 (= line0=1569): idx = floor(1569/2805*897) = 501 (inside image row)
    // sum up to idx 501 → 501 * 30 = 15030
    const yImage = sectionIndexEstimateY(heights, totalLines, 1570);
    // Line 1585 (= line0=1584): idx = floor(1584/2805*897) = 506 (after image row)
    // sum up to idx 506 → 506 * 30 + 3*200 = ... wait, 500,501,502 are image rows
    // 0-499: 500*30=15000, 500-502: 3*200=600, 503-506: 4*30=120, total=15720
    const yAfter = sectionIndexEstimateY(heights, totalLines, 1585);
    // After image row should be noticeably higher than within it
    expect(yAfter - yImage).toBeGreaterThan(100);
  });

  it('returns -1 for empty input', () => {
    expect(sectionIndexEstimateY([], totalLines, 100)).toBe(-1);
    expect(sectionIndexEstimateY(heights, 0, 100)).toBe(-1);
    expect(sectionIndexEstimateY(heights, totalLines, 0)).toBe(-1);
  });

  it('estimates the last line near total height', () => {
    const y = sectionIndexEstimateY(heights, totalLines, 2805);
    expect(y).toBe(27390);
  });

  it('works with a single section', () => {
    // Single section: all lines belong to section 0, start Y is always 0.
    expect(sectionIndexEstimateY([500], 100, 50)).toBe(0);
    expect(sectionIndexEstimateY([500], 100, 100)).toBe(0);
  });
});

describe('extrapolateLedgerY', () => {
  // A typical document: 3 sections covering lines 1-105, total 4000px docH,
  // 135 total lines. Lines 106-135 are beyond the last section (tail gap).
  const secs: LedgerSection[] = [
    { lineStart: 0, lineEnd: 10, height: 200 },
    { lineStart: 11, lineEnd: 50, height: 1800 },
    { lineStart: 51, lineEnd: 104, height: 2000 },
  ];

  it('returns -1 when line is within section range (caller should use ledgerYForLine)', () => {
    // Line 51 is within section 3 (lineEnd=104), offset <= 0
    const y = extrapolateLedgerY(secs, 51, 135, 5000);
    expect(y).toBe(-1);
  });

  it('extrapolates for a line beyond the last section', () => {
    // Line 127, remainingLines = 135-104 = 31, remainingH = 5000-4000 = 1000
    // offset = 127 - 104 = 23
    const y = extrapolateLedgerY(secs, 127, 135, 5000);
    expect(y).toBeCloseTo(4000 + (23 / 31) * 1000, 0); // ~4742
  });

  it('returns totalH when docH equals total ledger height', () => {
    const y = extrapolateLedgerY(secs, 120, 135, 4000);
    // reminingH = 0, so just totalH = 4000
    expect(y).toBe(4000);
  });

  it('extrapolates for the very last line', () => {
    const y = extrapolateLedgerY(secs, 135, 135, 5000);
    // Last line is at totalH + 30/30 * 1000 = 5000 (bottom of doc)
    expect(y).toBeCloseTo(5000, 0);
  });

  it('returns -1 for empty sections', () => {
    expect(extrapolateLedgerY([], 50, 100, 5000)).toBe(-1);
  });

  it('returns -1 when lastLineEnd >= totalLines', () => {
    const y = extrapolateLedgerY([{ lineStart: 0, lineEnd: 100, height: 4000 }], 50, 100, 5000);
    expect(y).toBe(-1);
  });

  it('returns -1 for unusable inputs', () => {
    expect(extrapolateLedgerY(secs, 0, 135, 5000)).toBe(-1);  // line1 <= 0
    expect(extrapolateLedgerY(secs, 50, 0, 5000)).toBe(-1);   // totalLines <= 0
    expect(extrapolateLedgerY(secs, 50, 135, 0)).toBe(-1);    // docH <= 0
  });

  it('returns -1 when line is at the last section boundary', () => {
    // line at lastLineEnd: offset=0, not beyond → caller should use ledgerYForLine
    const y = extrapolateLedgerY(secs, 104, 135, 5000);
    expect(y).toBe(-1);
  });
});

describe('clientTopToDocY', () => {
  it('converts an element viewport-top into a document-space Y', () => {
    // element 250px down the viewport, scroller top at 100px, scrolled 400px
    // → docY = 250 - 100 + 400 = 550
    expect(clientTopToDocY(250, 100, 400)).toBe(550);
  });
  it('returns the raw scrollTop when the element sits at the scroller top', () => {
    expect(clientTopToDocY(100, 100, 400)).toBe(400);
  });
  it('handles an element above the scroller top (negative offset)', () => {
    expect(clientTopToDocY(80, 100, 400)).toBe(380);
  });
  it('is unaffected by sign of scrollTop', () => {
    expect(clientTopToDocY(250, 100, 0)).toBe(150);
  });
});

describe('scrollTopToPct', () => {
  it('maps scrollTop to a 0..1 fraction of the scroll range', () => {
    // range = 1000 - 400 = 600; scrollTop 300 → 0.5
    expect(scrollTopToPct(300, 1000, 400)).toBe(0.5);
    expect(scrollTopToPct(0, 1000, 400)).toBe(0);
    expect(scrollTopToPct(600, 1000, 400)).toBe(1);
  });
  it('returns 0 when there is no scrollable range', () => {
    expect(scrollTopToPct(0, 400, 400)).toBe(0);   // scrollHeight == clientHeight
    expect(scrollTopToPct(50, 300, 400)).toBe(0);  // clientHeight > scrollHeight
  });
});

describe('pctToScrollTop', () => {
  it('is the inverse of scrollTopToPct within the range', () => {
    expect(pctToScrollTop(0.5, 1000, 400)).toBe(300);
    expect(pctToScrollTop(0, 1000, 400)).toBe(0);
    expect(pctToScrollTop(1, 1000, 400)).toBe(600);
  });
  it('round-trips with scrollTopToPct', () => {
    const scrollHeight = 2500, clientHeight = 700;
    for (const st of [0, 250, 900, 1800]) {
      const pct = scrollTopToPct(st, scrollHeight, clientHeight);
      expect(pctToScrollTop(pct, scrollHeight, clientHeight)).toBeCloseTo(st, 6);
    }
  });
  it('yields 0 when there is no scroll range', () => {
    expect(pctToScrollTop(0.5, 400, 400)).toBe(0);
  });
});
