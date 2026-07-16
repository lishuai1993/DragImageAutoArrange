import { describe, it, expect } from 'vitest';
import {
  ViewportAnchor,
  setActiveAnchor, getActiveAnchor,
  setRMLastAnchor, getRMLastAnchor, setLPLastAnchor, getLPLastAnchor,
  setImageRowIndex, getImageRowIndex, invalidateImageRowIndex,
  getFallbackPct, setFallbackPct, getLastFallbackPct, setLastFallbackPct,
  getLastMode, setLastMode, getLastDocH, setLastDocH,
  getImageLineRe, setImageLineRe,
} from '../src/scrollSync/anchorStore';
import { asLine1, ImageRowIndex } from '../src/scrollSync/viewportAnchor';

const rowAnchor = (i: number): ViewportAnchor => ({
  kind: 'image-row', imageRowIndex: i, intraRowRatio: 0.5,
});

describe('anchorStore', () => {
  it('active anchor roundtrips and clears', () => {
    setActiveAnchor(rowAnchor(1));
    expect(getActiveAnchor()).toEqual(rowAnchor(1));
    setActiveAnchor(null);
    expect(getActiveAnchor()).toBeNull();
  });

  it('keeps RM and LP last-anchor slots isolated (no cross-talk)', () => {
    setRMLastAnchor(rowAnchor(2), 'a.md');
    setLPLastAnchor(rowAnchor(9), 'b.md');

    expect(getRMLastAnchor()).toEqual({ anchor: rowAnchor(2), file: 'a.md' });
    expect(getLPLastAnchor()).toEqual({ anchor: rowAnchor(9), file: 'b.md' });

    // Overwriting one slot must not touch the other.
    setRMLastAnchor(null, 'a.md');
    expect(getRMLastAnchor()).toEqual({ anchor: null, file: 'a.md' });
    expect(getLPLastAnchor()).toEqual({ anchor: rowAnchor(9), file: 'b.md' });
  });

  it('image row index: set / get / invalidate contract', () => {
    const idx: ImageRowIndex[] = [
      { index: 1, startLine: asLine1(3), endLine: asLine1(4) },
    ];
    setImageRowIndex('note.md', idx);
    expect(getImageRowIndex('note.md')).toBe(idx);

    invalidateImageRowIndex('note.md');
    expect(getImageRowIndex('note.md')).toBeUndefined();

    // Invalidating an absent key is a no-op (no throw).
    expect(() => invalidateImageRowIndex('missing.md')).not.toThrow();
  });

  it('fallback percentages roundtrip independently', () => {
    setFallbackPct(0.25);
    setLastFallbackPct(0.75);
    expect(getFallbackPct()).toBe(0.25);
    expect(getLastFallbackPct()).toBe(0.75);
  });

  it('mode + docH tracking roundtrips', () => {
    setLastMode('preview');
    setLastDocH(1234);
    expect(getLastMode()).toBe('preview');
    expect(getLastDocH()).toBe(1234);
  });

  it('image-line regex override roundtrips', () => {
    const custom = /custom/;
    setImageLineRe(custom);
    expect(getImageLineRe()).toBe(custom);
  });
});
