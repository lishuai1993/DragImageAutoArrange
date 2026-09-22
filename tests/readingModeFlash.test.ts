/**
 * @vitest-environment jsdom
 *
 * The mode-switch flash: Obsidian's reading view highlights the block at the
 * restored scroll line by adding `.is-flashing`, which paints
 * `var(--text-highlight-bg) !important` for three seconds.  On a flex row the
 * pictures cover the band, so what the user sees is a yellow blink in the
 * letterbox and the gaps beside them.  The class is stripped from any block
 * that holds a row or an image embed — the marker once the pass has placed one
 * of our pictures, the bare embed before it has, which is the state the block is
 * in when the flash arrives.  It is stripped once as the section renders, and
 * continuously while the flash can still arrive (Obsidian applies it *after*
 * rendering the section).
 *
 * The watcher is a module singleton, so each test starts by calling
 * suppressRowFlash() to install its own; the afterEach runs the watch window
 * out so the next test installs a fresh one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  suppressRowFlash,
  guardSection,
  isRenderInFlight,
} from '../src/imageRender/readingMode';
import type { MarkdownPostProcessorContext } from 'obsidian';

const FLASH = 'is-flashing';
/** A section element carrying the flash, optionally holding one of our
 *  wrappers — `[data-diaa-group]` for a row, `[data-diaa-standalone]` for a
 *  lone picture.  Either is the marker the strip reads. */
function block(marker: string | null): HTMLElement {
  const el = document.createDiv({ cls: FLASH });
  const inner = document.createDiv();
  if (marker) inner.setAttribute(marker, '');
  inner.textContent = 'Body';
  el.appendChild(inner);
  document.body.appendChild(el);
  return el;
}

/** The commonest single-image row, and the shape that used to slip through:
 *  `applyStandaloneAlignment` sizes a pure image block where it stands and marks
 *  the *embed*, so the block carries no `data-diaa-*` attribute at all. */
function inlineBlock(): HTMLElement {
  const el = document.createDiv({ cls: FLASH });
  const embed = el.createDiv({ cls: 'internal-embed diaa-row-inline' });
  embed.textContent = 'Body';
  document.body.appendChild(el);
  return el;
}

describe('suppressRowFlash', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    // Past the 3.5 s watch window: the watcher stops and the next test installs
    // its own rather than sharing this one.
    vi.advanceTimersByTime(4000);
    vi.useRealTimers();
  });

  it('strips the flash from a block holding a row, on the spot', () => {
    const row = block('data-diaa-group');
    suppressRowFlash();
    expect(row.classList.contains(FLASH)).toBe(false);
  });

  it('strips it from a block holding a lone picture too', () => {
    // The marker check is the processor's own entry guard, so it accepts both
    // wrappers — a single image leaves the block's own width uncovered beside
    // it, which is amber all the same.
    const single = block('data-diaa-standalone');
    suppressRowFlash();
    expect(single.classList.contains(FLASH)).toBe(false);
  });

  it('strips it from a block holding a lone picture sized where it stands', () => {
    // No wrapper marker to read: this is the shape the strip used to miss, so
    // the amber band along the block's uncovered edge stayed for Obsidian's
    // own three seconds.
    const single = inlineBlock();
    suppressRowFlash();
    expect(single.classList.contains(FLASH)).toBe(false);
  });

  it('strips a flash that lands on the embed itself', () => {
    const el = document.createDiv();
    const embed = el.createDiv({ cls: 'internal-embed diaa-row-inline' });
    embed.textContent = 'Body';
    document.body.appendChild(el);
    embed.classList.add(FLASH);

    suppressRowFlash();
    expect(embed.classList.contains(FLASH)).toBe(false);
  });

  it('leaves a block with no row alone', () => {
    const plain = block(null);
    suppressRowFlash();
    expect(plain.classList.contains(FLASH)).toBe(true);
  });

  it('strips it from a block that holds only a bare image embed so far', () => {
    // What Obsidian hands the strip: it flashes the restored line as it builds
    // the section, so the block holds the embed Obsidian made and nothing of
    // ours — no wrapper, no `diaa-row-inline` — until this pass wraps or sizes
    // it.  A marker-only test declines the flash there and leaves the band to
    // the sweep; the embed alone is enough to know the band will be covered.
    const el = document.createDiv({ cls: FLASH });
    el.createDiv({ cls: 'internal-embed media-embed image-embed' }).textContent = 'Body';
    document.body.appendChild(el);

    suppressRowFlash();
    expect(el.classList.contains(FLASH)).toBe(false);
  });

  it('leaves a block holding a note embed alone', () => {
    // Only an image embed is ours to clear: a note embed's block is not a
    // picture the plugin paints over, so its flash is still Obsidian's.
    const el = document.createDiv({ cls: FLASH });
    el.createDiv({ cls: 'internal-embed' }).textContent = 'Body';
    document.body.appendChild(el);

    suppressRowFlash();
    expect(el.classList.contains(FLASH)).toBe(true);
  });

  it('catches a flash that lands before our marker does', async () => {
    const el = document.createDiv();
    el.createDiv({ cls: 'internal-embed image-embed' }).textContent = 'Body';
    document.body.appendChild(el);

    suppressRowFlash();
    el.classList.add(FLASH);
    await vi.advanceTimersByTimeAsync(1);
    expect(el.classList.contains(FLASH)).toBe(false);
  });

  it('catches a flash applied after the section rendered', async () => {
    const first = block('data-diaa-group');
    suppressRowFlash();
    expect(first.classList.contains(FLASH)).toBe(false);

    // What Obsidian does: the row is already in the document, and the class
    // lands on the block holding it.
    const late = document.createDiv();
    const inner = document.createDiv();
    inner.setAttribute('data-diaa-group', '');
    late.appendChild(inner);
    document.body.appendChild(late);

    late.classList.add(FLASH);
    await vi.advanceTimersByTimeAsync(1);
    expect(late.classList.contains(FLASH)).toBe(false);
  });

  it('catches a late flash on a lone picture sized where it stands', async () => {
    const el = document.createDiv();
    const embed = el.createDiv({ cls: 'internal-embed diaa-row-inline' });
    embed.textContent = 'Body';
    document.body.appendChild(el);

    suppressRowFlash();
    el.classList.add(FLASH);
    await vi.advanceTimersByTimeAsync(1);
    expect(el.classList.contains(FLASH)).toBe(false);
  });

  it('sweeps a flash whose block only becomes a row afterwards', async () => {
    // A row can be mid-wrap when the flash lands, so the marker is not there
    // yet and neither the immediate sweep nor the observer's record check finds
    // anything.  Only the periodic sweep can catch it once the row lands.
    const el = block(null);
    suppressRowFlash();
    expect(el.classList.contains(FLASH)).toBe(true);

    el.querySelector('div')!.setAttribute('data-diaa-group', '');
    await vi.advanceTimersByTimeAsync(200);
    expect(el.classList.contains(FLASH)).toBe(false);
  });
});

/**
 * The guard around the section handler.  Its defect was the opposite of a
 * missed render: a mark that outlived its pass left a section permanently
 * skipped, so the real reading view rendered it natively and the images stacked.
 * The mark must therefore live exactly as long as the run does — and a section
 * that already carries a wrapper is the one thing that stays skipped, for good.
 */
describe('guardSection', () => {
  const ctx = { sourcePath: 'note.md' } as unknown as MarkdownPostProcessorContext;

  function section(): HTMLElement {
    return document.body.createDiv();
  }

  /** Let the guard's own `.then` on the mark run — it is scheduled off the
   *  handler's resolution, so a bare `await` of that is not enough. */
  function flush(): Promise<void> {
    return new Promise((resolve) => { window.setTimeout(resolve, 0); });
  }

  it('runs the handler once and clears the in-flight mark', async () => {
    const runs: string[] = [];
    const guarded = guardSection(async () => { runs.push('run'); });
    const el = section();

    await guarded(el, ctx);
    expect(runs).toEqual(['run']);
    await flush();
    expect(isRenderInFlight(el)).toBe(false);

    // Nothing about the section changed, so a later pass must be free to run it
    // again — that is what a section a warmup touched but never wrapped needs.
    await guarded(el, ctx);
    expect(runs).toEqual(['run', 'run']);
  });

  it('skips a section re-entered while its own render is in flight', async () => {
    const runs: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const guarded = guardSection(async () => { runs.push('run'); await gate; });
    const el = section();

    const first = guarded(el, ctx);
    expect(isRenderInFlight(el)).toBe(true);
    await guarded(el, ctx);
    expect(runs).toEqual(['run']);

    release();
    await first;
    await flush();
    expect(isRenderInFlight(el)).toBe(false);
  });

  it('holds the mark for a pass that names a tail, past the handler returning', async () => {
    // The handler returns the moment the DOM is ours; its images are still
    // loading and its row is not wrapped yet.  A re-invoke in that window finds
    // the embeds unwrapped, so only the mark can stop a second wrap.
    const runs: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const guarded = guardSection(async (_el, _ctx, pass) => {
      runs.push('run');
      pass.tail = gate;
    });
    const el = section();

    await guarded(el, ctx);
    expect(isRenderInFlight(el)).toBe(true);
    await guarded(el, ctx);
    expect(runs).toEqual(['run']);

    release();
    await flush();
    expect(isRenderInFlight(el)).toBe(false);
  });

  it('clears the mark when the handler throws, so the section is not lost', async () => {
    const guarded = guardSection(async () => { throw new Error('wrap failed'); });
    const el = section();

    await expect(guarded(el, ctx)).rejects.toThrow('wrap failed');
    expect(isRenderInFlight(el)).toBe(false);
  });

  it('skips a section that already holds a wrapper, without marking it', async () => {
    const runs: string[] = [];
    const guarded = guardSection(async () => { runs.push('run'); });
    const el = section();
    el.createDiv().setAttribute('data-diaa-standalone', 'true');

    await guarded(el, ctx);
    expect(runs).toEqual([]);
    expect(isRenderInFlight(el)).toBe(false);
  });
});
