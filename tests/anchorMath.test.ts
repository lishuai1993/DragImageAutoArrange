import { describe, it, expect } from 'vitest';
import {
  clamp01, intraRowRatio, gapRatioFromGeom,
  imageRowTargetY, gapJunction, gapTargetY, textTargetY,
  nearestIndexBy,
} from '../src/scrollSync/anchorMath';

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
