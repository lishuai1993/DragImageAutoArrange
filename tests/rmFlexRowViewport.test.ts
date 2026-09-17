/**
 * @vitest-environment jsdom
 *
 * Pins the Reading-Mode row's narrow-screen hand-off.
 *
 * Below the breakpoint the media query wraps the row and sizes it with CSS, so
 * the pixel heights the sizing pass writes inline must be cleared — an inline
 * height outranks any stylesheet declaration, `!important` or not, and would
 * keep the row at its desktop geometry.  The images are handed back as
 * `width: 100%; height: auto` so they follow their item's new width instead of
 * letterboxing a desktop height inside a 45 %-wide item.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { wrapAsFlexRow } from '../src/imageRender/rmFlexRow';
import type { ImageRowOptions } from '../src/types';
import type { ImageMeta } from '../src/imageParse/imageDetector';

// jsdom lacks ResizeObserver — polyfill so the row's size observer can attach.
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = MockResizeObserver;

// The sizing pass is scheduled on rAF; running it synchronously keeps the whole
// row build inside the test's own call.  It is safe here because the row is
// given a non-zero width and images that already report their natural size, so
// the retry paths that would otherwise re-queue are never taken.
function runRafImmediately(): void {
  window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    cb(0);
    return 0;
  };
}

interface MediaStub {
  set(narrow: boolean): void;
}

function stubMatchMedia(initiallyNarrow: boolean): MediaStub {
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
  (window as unknown as { matchMedia: unknown }).matchMedia = () => list;
  return {
    set(next: boolean) {
      narrow = next;
      for (const cb of listeners) cb({ matches: next } as MediaQueryListEvent);
    },
  };
}

const OPTIONS: ImageRowOptions = {
  defaultRowHeight: 200,
  gap: 4,
  enableDividers: true,
  enableResize: true,
  snapSensitivity: 3,
  topBarSensitivity: 12,
  ghostImageWidth: 120,
  dragOpacity: 60,
  alignment: 'left',
  getResourcePath: (fn) => `mock://${fn}`,
};

const METAS: ImageMeta[] = [
  { naturalWidth: 500, naturalHeight: 654 },
  { naturalWidth: 800, naturalHeight: 1200 },
];

/** Two image embeds in one image-only paragraph — the shape `wrapAsFlexRow`
 *  collects into a row — with images that already report their natural size. */
function buildEmbeds(): HTMLElement[] {
  const view = document.body.createDiv({ cls: 'markdown-preview-view' });
  const block = view.createEl('p');
  return METAS.map((meta, i) => {
    const embed = block.createDiv({ cls: 'internal-embed' });
    const img = embed.createEl('img');
    Object.defineProperty(img, 'naturalWidth', { value: meta.naturalWidth, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: meta.naturalHeight, configurable: true });
    img.src = `mock://${i}.webp`;
    return embed;
  });
}

describe('Reading-Mode row narrow viewport hand-off', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    runRafImmediately();
    // Every element reports a laid-out row width so the sizing pass proceeds.
    // Both patches hold for the whole file — the assertions read inline styles
    // only, so nothing below depends on jsdom's own rect or frame timing.
    Element.prototype.getBoundingClientRect = function (): DOMRect {
      return {
        x: 0, y: 0, top: 0, left: 0, right: 900, bottom: 200,
        width: 900, height: 200, toJSON() {},
      };
    };
  });

  afterEach(() => {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });

  function wrap(): { row: HTMLElement; embeds: HTMLElement[]; imgs: HTMLImageElement[] } {
    const embeds = buildEmbeds();
    wrapAsFlexRow(embeds, OPTIONS);
    const row = document.querySelector<HTMLElement>('.diaa-row')!;
    const imgs = Array.from(row.querySelectorAll<HTMLImageElement>('img'));
    return { row, embeds, imgs };
  }

  it('writes pixel heights while the viewport is wide', () => {
    stubMatchMedia(false);
    const { row, embeds, imgs } = wrap();

    expect(row.style.height).not.toBe('');
    for (const embed of embeds) expect(embed.style.height).not.toBe('');
    for (const img of imgs) {
      expect(img.style.width).toBe('auto');
      expect(img.style.height).not.toBe('');
      expect(img.classList.contains('diaa-img-auto')).toBe(true);
    }
  });

  it('hands the row to the stylesheet below the breakpoint and takes it back above', () => {
    const media = stubMatchMedia(false);
    const { row, embeds, imgs } = wrap();
    const wideHeight = row.style.height;
    expect(wideHeight).not.toBe('');

    media.set(true);
    expect(row.style.height).toBe('');
    for (const embed of embeds) expect(embed.style.height).toBe('');
    for (const img of imgs) {
      expect(img.style.width).toBe('100%');
      expect(img.style.height).toBe('auto');
    }

    media.set(false);
    expect(row.style.height).toBe(wideHeight);
    for (const img of imgs) expect(img.style.width).toBe('auto');
  });

  it('clears the pixel heights when the row is built already narrow', () => {
    stubMatchMedia(true);
    const { row, embeds, imgs } = wrap();

    expect(row.style.height).toBe('');
    for (const embed of embeds) expect(embed.style.height).toBe('');
    for (const img of imgs) {
      expect(img.style.width).toBe('100%');
      expect(img.style.height).toBe('auto');
    }
  });
});
