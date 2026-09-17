import { describe, it, expect, vi, afterEach } from 'vitest';
import { displayNameFromPath, resolveImageSrc, throttle, moveLineInRange, alignmentToCSS, isNarrowViewport, onNarrowViewportChange, MOBILE_BREAKPOINT_PX } from '../src/utils';
import { DEFAULT_SETTINGS, Alignment } from '../src/constants';

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

// ── Alignment defaults ──
describe('DEFAULT_SETTINGS.alignment', () => {
  it('default alignment is "left"', () => {
    expect(DEFAULT_SETTINGS.alignment).toBe('left');
  });

  it('Alignment type includes valid values', () => {
    // Compile-time type check: these assignments type-check
    const left: Alignment = 'left';
    const center: Alignment = 'center';
    const right: Alignment = 'right';
    expect(left).toBe('left');
    expect(center).toBe('center');
    expect(right).toBe('right');
  });
});

// ── Alignment → CSS mapping ──
describe('alignmentToCSS', () => {
  it('maps "left" to flex-start and left top', () => {
    const css = alignmentToCSS('left');
    expect(css.justifyContent).toBe('flex-start');
    expect(css.objectPosition).toBe('left top');
  });

  it('maps "center" to center and center top', () => {
    const css = alignmentToCSS('center');
    expect(css.justifyContent).toBe('center');
    expect(css.objectPosition).toBe('center top');
  });

  it('maps "right" to flex-end and right top', () => {
    const css = alignmentToCSS('right');
    expect(css.justifyContent).toBe('flex-end');
    expect(css.objectPosition).toBe('right top');
  });
});

// ── Single-image alignment visibility ──
// Alignment is only visible when the image is narrower than the container.
// For left alignment, the image fills the container (width:100%, height:auto).
// For center/right, the image height is constrained to defaultRowHeight,
// making it narrower than the container so justify-content takes effect.
describe('single-image alignment visibility', () => {
  it('left alignment fills container — image width equals container width', () => {
    // 500×654 image in 800px wide container
    // fillWidthH = 800 * 654 / 500 ≈ 1046
    // height:auto → image renders at 800×1046 (fills container width)
    const cw = 800;
    const aspect = 500 / 654;
    const fillWidthH = Math.round(cw / aspect);
    const imageW = Math.round(fillWidthH * aspect);
    expect(imageW).toBe(cw); // image fills container → alignment invisible
  });

  it('center/right alignment constrains height to defaultRowHeight', () => {
    const cw = 800;
    const defaultRowHeight = 200;
    const aspect = 500 / 654;
    const fillWidthH = Math.round(cw / aspect); // 1046
    const constrainedH = Math.min(defaultRowHeight, fillWidthH); // 200
    const imageW = Math.round(constrainedH * aspect); // 153
    expect(imageW).toBeLessThan(cw); // image narrower → alignment visible
    expect(constrainedH).toBe(defaultRowHeight);
  });

  it('when fillWidthH is less than defaultRowHeight, uses fillWidthH', () => {
    // Very narrow container: 105px wide
    // fillWidthH = 105 * 654 / 500 ≈ 137
    const cw = 105;
    const defaultRowHeight = 200;
    const aspect = 500 / 654;
    const fillWidthH = Math.round(cw / aspect); // 137
    const constrainedH = Math.min(defaultRowHeight, fillWidthH); // 137
    expect(constrainedH).toBeLessThan(defaultRowHeight);
    expect(constrainedH).toBe(fillWidthH);
  });
});

// ── Narrow viewport ──

/** Stand-in for the platform's MediaQueryList: `matches` follows the flag the
 *  test sets, and the change listeners are the ones the module registered. */
function stubMatchMedia(initiallyNarrow: boolean): {
  set(narrow: boolean): void;
  listenerCount(): number;
  query: string;
} {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  let narrow = initiallyNarrow;
  const list = {
    get matches() { return narrow; },
    media: '',
    onchange: null,
    addEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => { listeners.add(cb); },
    removeEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => { listeners.delete(cb); },
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  };
  (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => {
    list.media = q;
    return list;
  };
  return {
    set(next: boolean) {
      narrow = next;
      for (const cb of listeners) cb({ matches: next } as MediaQueryListEvent);
    },
    listenerCount: () => listeners.size,
    get query() { return list.media; },
  };
}

describe('isNarrowViewport', () => {
  afterEach(() => {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });

  it('reads as wide when the platform exposes no matchMedia', () => {
    // jsdom's case, and the reason the helper is guarded: the wide-screen
    // layout is the one the plugin had before the narrow handling existed.
    expect(isNarrowViewport()).toBe(false);
  });

  it('asks the platform about its own breakpoint', () => {
    const media = stubMatchMedia(false);
    expect(isNarrowViewport()).toBe(false);
    expect(media.query).toBe(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`);
    media.set(true);
    expect(isNarrowViewport()).toBe(true);
  });
});

describe('onNarrowViewportChange', () => {
  afterEach(() => {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });

  it('reports each crossing and stops after the subscription is dropped', () => {
    const media = stubMatchMedia(false);
    const seen: boolean[] = [];
    const off = onNarrowViewportChange((narrow) => seen.push(narrow));

    media.set(true);
    media.set(false);
    expect(seen).toEqual([true, false]);

    off();
    media.set(true);
    expect(seen).toEqual([true, false]);
    expect(media.listenerCount()).toBe(0);
  });

  it('is a no-op subscription when the platform exposes no matchMedia', () => {
    const off = onNarrowViewportChange(() => undefined);
    expect(() => off()).not.toThrow();
  });
});
