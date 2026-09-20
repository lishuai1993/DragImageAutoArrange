/**
 * @vitest-environment jsdom
 *
 * Pins the two inline writes Reading Mode owns that used to live in styles.css
 * as `!important` rules:
 *
 *  - the row item's fixed styling (margin / padding / overflow / min-width /
 *    position / display / align-items), which Obsidian's own embed rules also
 *    set, so only an inline declaration outranks them;
 *  - the shrink-wrap on an embed pulled out of a mixed text+image block, where
 *    Obsidian's `.internal-embed` rule outranks a plugin class on specificity.
 *
 * The values are constants, so the stylesheet carrying them bought nothing that
 * writing them here does not — and the test is what keeps the move honest.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  wrapAsFlexRow,
  applyStandaloneAlignment,
  applyStandaloneSize,
} from '../src/imageRender/rmFlexRow';
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

/** What every row item must carry inline, whatever the row's own numbers are.
 *  The zero shorthands are written as `0` and read back as `0px` — that is
 *  jsdom's CSSOM normalizing them, not the plugin writing something else. */
const ITEM_STYLE: Array<[string, string]> = [
  ['margin', '0px'],
  ['padding', '0px'],
  ['overflow', 'hidden'],
  ['min-width', '50px'],
  ['position', 'relative'],
  ['display', 'flex'],
  ['align-items', 'flex-start'],
];

/** Two image embeds in one image-only paragraph — the shape `wrapAsFlexRow`
 *  collects into a row — with images that already report their natural size. */
function buildEmbeds(
  metas: ImageMeta[] = METAS,
  words: Array<string | null> = [],
  scales: Array<number | null> = []
): HTMLElement[] {
  const view = document.body.createDiv({ cls: 'markdown-preview-view' });
  const block = view.createEl('p');
  return metas.map((meta, i) => {
    const embed = block.createDiv({ cls: 'internal-embed' });
    const img = embed.createEl('img');
    Object.defineProperty(img, 'naturalWidth', { value: meta.naturalWidth, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: meta.naturalHeight, configurable: true });
    img.src = `mock://${i}.webp`;
    if (words[i]) embed.setAttribute('data-diaa-orientation', words[i]);
    if (scales[i] != null) embed.setAttribute('data-diaa-scale', String(scales[i]));
    return embed;
  });
}

const PORTRAIT = (): ImageMeta => ({ naturalWidth: 500, naturalHeight: 654 });
const LANDSCAPE = (): ImageMeta => ({ naturalWidth: 1600, naturalHeight: 900 });

function boxHeight(embed: HTMLElement): number {
  return parseInt(embed.querySelector('img')!.style.height, 10);
}

function itemHeight(embed: HTMLElement): number {
  return parseInt(embed.style.height, 10);
}

describe('Reading-Mode row item styling', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    runRafImmediately();
    // Every element reports a laid-out row width so the sizing pass proceeds.
    // The patch holds for the whole file — the assertions read inline styles
    // only, so nothing below depends on jsdom's own rect.
    Element.prototype.getBoundingClientRect = function (): DOMRect {
      return {
        x: 0, y: 0, top: 0, left: 0, right: 900, bottom: 200,
        width: 900, height: 200, toJSON() {},
      };
    };
  });

  it('writes the item styling inline, with priority', () => {
    const embeds = buildEmbeds();
    wrapAsFlexRow(embeds, OPTIONS);

    for (const embed of embeds) {
      for (const [prop, value] of ITEM_STYLE) {
        expect(embed.style.getPropertyValue(prop), prop).toBe(value);
        expect(embed.style.getPropertyPriority(prop), prop).toBe('important');
      }
    }
  });

  it('leaves the per-row values to the sizing pass', () => {
    const embeds = buildEmbeds();
    wrapAsFlexRow(embeds, OPTIONS);

    // flex / justify-content are computed per row and still written by the
    // build itself; their being inline is what makes the stylesheet's absence
    // safe here.
    expect(embeds[0].style.flex).not.toBe('');
    expect(embeds[0].style.justifyContent).not.toBe('');
  });
});

describe('Standalone embed shrink-wrap', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  /** `<p>文字<br>![[img]]</p>` — a block that holds both text and an image, so
   *  the image is extracted into its own wrapper instead of aligning the block. */
  function buildMixedBlock(): { embed: HTMLElement; block: HTMLElement } {
    const view = document.body.createDiv({ cls: 'markdown-preview-view' });
    const block = view.createEl('p');
    block.appendChild(document.createTextNode('文字'));
    block.createEl('br');
    const embed = block.createDiv({ cls: 'internal-embed' });
    embed.createEl('img');
    return { embed, block };
  }

  it('shrink-wraps the extracted embed inline', () => {
    const { embed } = buildMixedBlock();
    applyStandaloneAlignment(embed, 'center');

    expect(embed.style.getPropertyValue('display')).toBe('inline-block');
    expect(embed.style.getPropertyPriority('display')).toBe('important');
    expect(embed.classList.contains('diaa-row-inline')).toBe(true);
    // Its wrapper is what text-align acts on, so the extraction has to happen.
    expect(embed.parentElement?.getAttribute('data-diaa-standalone')).toBe('true');
  });

  it('shrink-wraps a pure image block through the same path', () => {
    const view = document.body.createDiv({ cls: 'markdown-preview-view' });
    const block = view.createEl('p');
    const embed = block.createDiv({ cls: 'internal-embed' });
    embed.createEl('img');

    applyStandaloneAlignment(embed, 'left');

    expect(embed.style.getPropertyValue('display')).toBe('inline-block');
    expect(embed.classList.contains('diaa-row-inline')).toBe(true);
  });
});

/** The row geometry the sizing pass writes, in Reading Mode. */
function inSizedRow(): void {
  document.body.innerHTML = '';
  runRafImmediately();
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return {
      x: 0, y: 0, top: 0, left: 0, right: 900, bottom: 200,
      width: 900, height: 200, toJSON() {},
    };
  };
}

describe('Reading-Mode row junction width', () => {
  beforeEach(inSizedRow);

  it('reserves the same junction the widget does', () => {
    const embeds = buildEmbeds();
    wrapAsFlexRow(embeds, OPTIONS);
    // Dividers are off in Reading Mode, but the *figure* has to match the
    // widget's: gap 4 plus a 4px divider costing a gap on each side = 12.  The
    // row's height model divides this off, so a narrower gap here would draw
    // the same note's pictures at a different size per mode.
    expect(embeds[0].parentElement!.style.gap).toBe('12px');
  });

  it('is the bare gap once dividers are switched off', () => {
    const embeds = buildEmbeds();
    wrapAsFlexRow(embeds, { ...OPTIONS, enableDividers: false });
    expect(embeds[0].parentElement!.style.gap).toBe('4px');
  });
});

describe('Reading-Mode quarter-turn heights', () => {
  beforeEach(inSizedRow);

  it('folds a turned portrait inside its box and lets the cell follow it', () => {
    const embeds = buildEmbeds([PORTRAIT(), PORTRAIT()], ['r90', 'r90']);
    wrapAsFlexRow(embeds, OPTIONS);
    const row = embeds[0].parentElement!;
    for (const embed of embeds) {
      // The turn stands the box up and folds the drawing back inside it, so the
      // painted height is the box's own width (box × aspect) scaled by the
      // 500:654 fit: box × aspect².  A portrait keeps its width and *shortens*,
      // and the cell shortens with it — the column is what is on screen, so a
      // balanced row can line its pictures up on one baseline.
      expect(boxHeight(embed)).toBe(581);
      expect(itemHeight(embed)).toBe(340);
      expect(embed.style.alignItems).toBe('center');
      const img = embed.querySelector('img')!;
      expect(img.style.transform).toBe(`scale(${500 / 654}) rotate(90deg)`);
    }
    // Both members agree, so the row is that one height — not the 581px boxes.
    expect(parseInt(row.style.height, 10)).toBe(340);
  });

  it('keeps a turned landscape at its box height — the row does not grow', () => {
    const embeds = buildEmbeds([LANDSCAPE(), LANDSCAPE()], ['r90', 'r90']);
    wrapAsFlexRow(embeds, OPTIONS);
    for (const embed of embeds) {
      // Same rule the other way up: the turned rectangle folded into the one it
      // came from lands exactly on that rectangle's height, so a landscape keeps
      // the height it had and only narrows.  Centring then puts the (smaller)
      // box back on the item's centre.
      expect(itemHeight(embed)).toBe(boxHeight(embed));
      expect(embed.style.alignItems).toBe('center');
    }
  });

  it('carries that fit as the transform scale, so nothing is ever enlarged', () => {
    const embeds = buildEmbeds([LANDSCAPE(), LANDSCAPE()], ['r90', 'r90']);
    wrapAsFlexRow(embeds, OPTIONS);
    // The row hands over the same number the model's drawn height is built on —
    // min(aspect, 1/aspect), i.e. 900/1600 here — and the CSS function list reads
    // right-to-left as scale ∘ rotate.
    const img = embeds[0].querySelector('img')!;
    expect(img.style.transform).toBe(`scale(${900 / 1600}) rotate(90deg)`);
  });

  it('gives an upright member its box height, uncentred', () => {
    const embeds = buildEmbeds([PORTRAIT(), PORTRAIT()]);
    wrapAsFlexRow(embeds, OPTIONS);
    for (const embed of embeds) {
      expect(itemHeight(embed)).toBe(boxHeight(embed));
      expect(embed.style.alignItems).toBe('flex-start');
    }
  });

  it('applies the same rule in the fill-driven branch', () => {
    const embeds = buildEmbeds([PORTRAIT(), PORTRAIT()], ['r90', null], [0.5, 0.5]);
    wrapAsFlexRow(embeds, OPTIONS);
    const row = embeds[0].parentElement!;
    // Both cells are their own drawing, turned or upright; the turn only decides
    // what the box paints, so the turned column's cell is the shorter one and
    // the box it is folded inside stays behind it.
    expect(itemHeight(embeds[0])).toBe(170);
    expect(boxHeight(embeds[0])).toBe(290);
    expect(embeds[0].style.alignItems).toBe('center');
    expect(itemHeight(embeds[1])).toBe(boxHeight(embeds[1]));
    expect(embeds[1].style.alignItems).toBe('flex-start');
    expect(parseInt(row.style.height, 10)).toBe(290);
  });

  /** What a member paints out of a uniform box: the box itself upright, and on a
   *  quarter turn the box folded inside itself — aspect² for a portrait,
   *  unchanged for a landscape, whose fit cancels its aspect. */
  function drawnFromBox(box: number, meta: ImageMeta, turned: boolean): number {
    const a = meta.naturalWidth / meta.naturalHeight;
    const coef = turned ? Math.min(a, 1 / a) : 1 / a;
    return Math.round(box * coef * a);
  }

  it('takes its height from the tallest cell, whatever orientation the members take', () => {
    // Reading Mode has to agree with the widget: a member's cell is what it
    // paints, and a drawing is never taller than the box it came from, so a turn
    // can only shorten a cell and never grow the row.  The landscape here paints
    // its box either way, which holds the row at that height throughout.
    const WORDS: Array<[string, boolean]> = [
      ['orig', false], ['r90', true], ['r180', false], ['r270', true],
      ['fh', false], ['fv', false], ['r90fh', true], ['r270fh', true],
    ];
    const metas = [PORTRAIT(), LANDSCAPE()];
    for (const [word, turned] of WORDS) {
      const embeds = buildEmbeds(metas, [word, word]);
      wrapAsFlexRow(embeds, OPTIONS);
      const row = embeds[0].parentElement!;
      const cells = embeds.map((e, i) => drawnFromBox(350, metas[i], turned));
      expect(parseInt(row.style.height, 10), word).toBe(Math.max(...cells));
      for (let i = 0; i < embeds.length; i++) {
        expect(itemHeight(embeds[i]), word).toBe(cells[i]);
        expect(boxHeight(embeds[i]), word).toBe(350);
      }
    }
  });
});

/**
 * A standalone picture is not a row item: it keeps its own `inline-block` embed
 * and is placed by the host block's text-align.  A quarter turn still has to
 * centre the box inside it — the turn paints about the box's own centre, and the
 * box is one aspect taller than the swapped rectangle the embed takes, so a
 * top-left anchor carries the picture half the difference left and down: the
 * drawn rectangle keeps the right size but lands off the container, which is
 * what the reader sees as the picture sitting low inside the hover ring.
 */
describe('Standalone quarter-turn centring', () => {
  beforeEach(inSizedRow);

  function buildStandalone(word: string | null, meta: ImageMeta = PORTRAIT()) {
    const view = document.body.createDiv({ cls: 'markdown-preview-view' });
    const block = view.createEl('p');
    const embed = block.createDiv({ cls: 'internal-embed' });
    const img = embed.createEl('img');
    Object.defineProperty(img, 'naturalWidth', { value: meta.naturalWidth, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: meta.naturalHeight, configurable: true });
    if (word) embed.setAttribute('data-diaa-orientation', word);
    return { embed, img };
  }

  it('centres a turned picture inside its embed', () => {
    const { embed, img } = buildStandalone('r270fh');
    applyStandaloneAlignment(embed, 'center');
    applyStandaloneSize(embed, img, 373, OPTIONS);

    // inline-flex, not flex: the embed stays inline-level so the host block's
    // text-align still decides where it sits on the line.  The rows' own path
    // centres the same way.
    expect(embed.style.getPropertyValue('display')).toBe('inline-flex');
    expect(embed.style.getPropertyPriority('display')).toBe('important');
    expect(embed.style.getPropertyValue('justify-content')).toBe('center');
    expect(embed.style.getPropertyValue('align-items')).toBe('center');
    // The box is wider than the embed on a quarter turn, so it must not be
    // allowed to shrink into it.
    expect(img.style.getPropertyValue('flex-shrink')).toBe('0');
  });

  it('goes back to a shrink-wrapped inline-block once the turn is gone', () => {
    const { embed, img } = buildStandalone('r270fh');
    applyStandaloneAlignment(embed, 'center');
    applyStandaloneSize(embed, img, 373, OPTIONS);

    embed.removeAttribute('data-diaa-orientation');
    applyStandaloneAlignment(embed, 'center');
    applyStandaloneSize(embed, img, 373, OPTIONS);

    expect(embed.style.getPropertyValue('display')).toBe('inline-block');
    expect(embed.style.getPropertyValue('justify-content')).toBe('');
    expect(embed.style.getPropertyValue('align-items')).toBe('');
    expect(img.style.getPropertyValue('flex-shrink')).toBe('');
  });

  it('leaves an upright picture anchored as before', () => {
    const { embed, img } = buildStandalone(null);
    applyStandaloneAlignment(embed, 'center');
    applyStandaloneSize(embed, img, 373, OPTIONS);

    expect(embed.style.getPropertyValue('display')).toBe('inline-block');
    expect(embed.style.getPropertyValue('align-items')).toBe('');
  });
});
