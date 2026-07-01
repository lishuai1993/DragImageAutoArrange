import { describe, it, expect, vi, afterEach } from 'vitest';
import { displayNameFromPath, resolveImageSrc, throttle, moveLineInRange } from '../src/utils';

// ── displayNameFromPath ──
describe('displayNameFromPath', () => {
  it('strips extension from simple filename', () => {
    expect(displayNameFromPath('photo.png')).toBe('photo');
  });

  it('strips directory path and extension', () => {
    expect(displayNameFromPath('folder/sub/photo.png')).toBe('photo');
  });

  it('handles filename with no extension', () => {
    expect(displayNameFromPath('photo')).toBe('photo');
  });

  it('handles multiple dots (e.g. archive.tar.gz)', () => {
    expect(displayNameFromPath('archive.tar.gz')).toBe('archive.tar');
  });
});

// ── resolveImageSrc ──
describe('resolveImageSrc', () => {
  it('returns resolved resource path on success', () => {
    const adapter = {
      getResourcePath: (path: string) => `app://local/${path}`,
    };
    expect(resolveImageSrc('img.png', adapter)).toBe('app://local/img.png');
  });

  it('falls back to filename on adapter error', () => {
    const adapter = {
      getResourcePath: (_path: string) => {
        throw new Error('vault not found');
      },
    };
    expect(resolveImageSrc('img.png', adapter)).toBe('img.png');
  });

  it('handles path with subfolder', () => {
    const adapter = {
      getResourcePath: (path: string) => `vault://${path}`,
    };
    expect(resolveImageSrc('assets/photo.jpg', adapter)).toBe('vault://assets/photo.jpg');
  });
});

// ── throttle ──
describe('throttle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls the function after the delay', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const throttled = throttle(fn, 100);

    throttled();
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('skips calls within the delay window', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const throttled = throttle(fn, 100);

    throttled();
    throttled();
    throttled();
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('fires again after delay elapses', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const throttled = throttle(fn, 100);

    throttled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);

    throttled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('passes arguments to the wrapped function', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const throttled = throttle(fn, 100);

    throttled('a', 42);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledWith('a', 42);

    vi.useRealTimers();
  });
});

// ── moveLineInRange ──
describe('moveLineInRange', () => {
  it('moves first line to middle (src < target, the regression scenario)', () => {
    // Simulates: standalone image at line 14 dragged between lines 17-18
    // Lines in range [13..17]: A=src, B, C, D=img0, E=img1
    // Move A (index 0) to between D and E (index 4 in original, 3 after removal)
    const lines = ['A', 'B', 'C', 'D', 'E'];
    const result = moveLineInRange(lines, 0, 4);
    expect(result).toEqual(['B', 'C', 'D', 'A', 'E']);
  });

  it('moves first to middle (src < target, toIndex=2 in 3-element array)', () => {
    // toIndex=2 targets the position of the 3rd element (original index 2).
    // After removing at 0, index 2 shifts to 1 → inserts at position 1.
    const result = moveLineInRange(['A', 'B', 'C'], 0, 2);
    expect(result).toEqual(['B', 'A', 'C']);
  });

  it('moves first to end (src < target, toIndex=3 in 3-element array)', () => {
    // toIndex=3 targets one past the end (after all elements)
    const result = moveLineInRange(['A', 'B', 'C'], 0, 3);
    expect(result).toEqual(['B', 'C', 'A']);
  });

  it('moves last to beginning (src > target)', () => {
    const lines = ['A', 'B', 'C', 'D'];
    const result = moveLineInRange(lines, 3, 0);
    expect(result).toEqual(['D', 'A', 'B', 'C']);
  });

  it('moves last to middle (src > target)', () => {
    const lines = ['A', 'B', 'C', 'D'];
    const result = moveLineInRange(lines, 3, 1);
    expect(result).toEqual(['A', 'D', 'B', 'C']);
  });

  it('same index returns unchanged array', () => {
    const lines = ['A', 'B', 'C'];
    const result = moveLineInRange(lines, 1, 1);
    expect(result).toEqual(['A', 'B', 'C']);
  });

  it('does not mutate the input array', () => {
    const lines = ['A', 'B', 'C'];
    const result = moveLineInRange(lines, 0, 2);
    expect(result).not.toBe(lines);
    expect(lines).toEqual(['A', 'B', 'C']);
  });

  it('two-element: move 0 to before 1 (same as original — no-op)', () => {
    // toIndex=1 targets the position of element 1 (Y).
    // After removing X, Y shifts to 0 → insertAt=0 → X before Y (unchanged)
    const result = moveLineInRange(['X', 'Y'], 0, 1);
    expect(result).toEqual(['X', 'Y']);
  });

  it('two-element swap: move 0 past the end', () => {
    // toIndex=2 targets one past the end → X goes after Y
    const result = moveLineInRange(['X', 'Y'], 0, 2);
    expect(result).toEqual(['Y', 'X']);
  });

  it('two-element swap: 1 → 0', () => {
    const result = moveLineInRange(['X', 'Y'], 1, 0);
    expect(result).toEqual(['Y', 'X']);
  });

  it('empty array returns empty', () => {
    expect(moveLineInRange([], 0, 0)).toEqual([]);
  });
});
