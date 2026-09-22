/**
 * @vitest-environment jsdom
 *
 * Pins the contract between *building* a Reading-Mode row and *sizing* it.
 *
 * `wrapAsFlexRow` collects one image per member, but the sizing pass walks
 * `embeds.length` and its load gate counts entries in `metas`.  When a member
 * carries no `<img>` — an unresolved link, or one Obsidian has not attached the
 * image to yet — those counts disagree: a row used to be built anyway, the tail
 * members were handed `undefined` flex and height, and the gate waited on a
 * `load` event no element could ever fire, so the sizing pass never ran at all
 * and the row sat at the pre-sizing default with nothing in the log.
 *
 * A row built into a section Obsidian has not attached yet hits the other half:
 * the sizing pass reads a zero width, and the retry used to be armed only while
 * the row was *already* connected — so a detached row gave up permanently the
 * moment it was built, which is exactly the moment its width is missing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { wrapAsFlexRow, waitForImagesThenWrap } from '../src/imageRender/rmFlexRow';
import type { ImageRowOptions } from '../src/types';
import type { ImageMeta } from '../src/imageParse/imageDetector';

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = MockResizeObserver;

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

/**
 * Frames are queued rather than run, so a test decides when the row's sizing
 * pass gets its next look — the retry under test is a *later* frame, and running
 * it eagerly inside `requestAnimationFrame` would hide the very gap it covers.
 */
interface ManualRaf {
  flush(maxRounds?: number): void;
  queued(): number;
}

function installManualRaf(): ManualRaf {
  let queue: FrameRequestCallback[] = [];
  (window as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = (
    cb: FrameRequestCallback
  ): number => {
    queue.push(cb);
    return queue.length;
  };
  return {
    flush(maxRounds = 500) {
      let rounds = 0;
      while (queue.length > 0 && rounds < maxRounds) {
        const batch = queue;
        queue = [];
        for (const cb of batch) cb(0);
        rounds++;
      }
    },
    queued: () => queue.length,
  };
}

/**
 * Two image-only embeds in one paragraph — the shape the Reading-Mode processor
 * hands to `wrapAsFlexRow`.  `withImage: false` models the member whose target
 * did not resolve: the embed carries its `src` (which is what `isImageEmbed`
 * reads) but Obsidian never gave it an `<img>`.
 */
function buildEmbeds(
  opts: { withImage?: boolean[]; host?: HTMLElement } = {}
): HTMLElement[] {
  const withImage = opts.withImage ?? [true, true];
  const host = opts.host ?? document.body.createDiv({ cls: 'markdown-preview-view' });
  const block = host.createEl('p');
  return METAS.map((meta, i) => {
    const embed = block.createDiv({ cls: 'internal-embed' });
    if (withImage[i]) {
      const img = embed.createEl('img');
      Object.defineProperty(img, 'naturalWidth', { value: meta.naturalWidth, configurable: true });
      Object.defineProperty(img, 'naturalHeight', { value: meta.naturalHeight, configurable: true });
      img.src = `mock://${i}.webp`;
    } else {
      embed.setAttribute('src', `图片集/不存在-${i}.webp`);
      embed.addClass('mod-empty-attachment');
    }
    return embed;
  });
}

function inlineStyles(el: HTMLElement): string {
  return el.getAttribute('style') ?? '';
}

/**
 * A container that is deliberately *not* in the document — the state Obsidian's
 * post-processor can hand a section to, and the one in which a row measures
 * zero width. Built through the DOM helper (which appends) and then detached.
 */
function detachedHost(): HTMLElement {
  const host = document.body.createDiv();
  host.remove();
  return host;
}

describe('Reading-Mode row: build-vs-size member contract', () => {
  let raf: ManualRaf;

  beforeEach(() => {
    document.body.innerHTML = '';
    raf = installManualRaf();
    // A wide viewport, so the hand-off branch never masks the sizing pass. The
    // width follows connectivity: an element Obsidian has not attached measures
    // zero, which is the condition the retry exists for.
    (window as unknown as { matchMedia: unknown }).matchMedia = () => ({
      matches: false,
      media: '',
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    });
    Element.prototype.getBoundingClientRect = function (): DOMRect {
      const width = this.isConnected ? 900 : 0;
      return {
        x: 0, y: 0, top: 0, left: 0, right: width, bottom: 200,
        width, height: 200, toJSON() {},
      };
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('still builds and sizes a row when every member has an <img>', () => {
    const embeds = buildEmbeds();
    wrapAsFlexRow(embeds, OPTIONS);
    raf.flush();

    const row = document.querySelector<HTMLElement>('.diaa-row');
    expect(row).not.toBeNull();
    expect(row!.style.height).not.toBe('');
    for (const embed of embeds) {
      expect(embed.style.height).not.toBe('');
      // The desync of a short member list showed up here as a literal value:
      // the write loop indexed past the end of the sizing arrays.
      expect(inlineStyles(embed)).not.toContain('undefined');
    }
  });

  it('builds no row when a member never got an <img>', () => {
    const embeds = buildEmbeds({ withImage: [true, false] });
    wrapAsFlexRow(embeds, OPTIONS);
    raf.flush();

    expect(document.querySelector('.diaa-row')).toBeNull();
    for (const embed of embeds) {
      expect(embed.style.height).toBe('');
      expect(inlineStyles(embed)).not.toContain('undefined');
    }
  });

  it('leaves the row alone when the 5 s wait gives up on a member', async () => {
    vi.useFakeTimers();
    const embeds = buildEmbeds({ withImage: [true, false] });

    void waitForImagesThenWrap(embeds, OPTIONS);
    await vi.advanceTimersByTimeAsync(5000);

    expect(document.querySelector('.diaa-row')).toBeNull();
  });

  it('sizes a row whose width arrives only after Obsidian attaches it', () => {
    const host = detachedHost();
    const embeds = buildEmbeds({ host });
    wrapAsFlexRow(embeds, OPTIONS);

    const row = host.querySelector<HTMLElement>('.diaa-row');
    expect(row).not.toBeNull();
    expect(row!.isConnected).toBe(false);

    // The sizing pass runs once while the section is still detached — this is
    // the frame that used to end it: a zero width with no retry armed.
    raf.flush(1);
    // `width: 100%` is the pre-sizing state the row build leaves behind; the
    // sizing pass is what swaps it to `auto` and writes the row's height.
    for (const img of Array.from(row!.querySelectorAll('img'))) {
      expect(img.style.width).toBe('100%');
    }

    document.body.appendChild(host);
    raf.flush();

    expect(row!.style.height).not.toBe('');
    for (const embed of embeds) expect(embed.style.height).not.toBe('');
    for (const img of Array.from(row!.querySelectorAll('img'))) {
      expect(img.style.width).toBe('auto');
    }
  });

  it('stops waiting once the frame budget for a width is spent', () => {
    const host = detachedHost();
    const embeds = buildEmbeds({ host });
    wrapAsFlexRow(embeds, OPTIONS);

    raf.flush();

    // A row that is never attached must not keep a frame queued forever.
    expect(raf.queued()).toBe(0);
  });
});
