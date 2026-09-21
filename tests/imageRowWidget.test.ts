/**
 * @vitest-environment jsdom
 *
 * Tests for ImageRowWidget alignment behavior.
 *
 * Focus: verify that after alignment changes (via widget recreation with
 * preservedMultiImageSizes), every image element in a multi-image row ends
 * up with the correct `object-position` CSS. This is the regression path
 * where the third image in a resized row appeared not to respond to
 * alignment setting changes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('obsidian', () => ({
  Menu: vi.fn().mockImplementation(() => ({
    addItem: vi.fn().mockReturnThis(),
    addSeparator: vi.fn().mockReturnThis(),
    showAtMouseEvent: vi.fn(),
  })),
}));

import { ImageRowWidget, ImageRowOptions, sanitizeOptions, handleRect } from '../src/imageRender/imageRowWidget';
import type { RowGroup } from '../src/imageParse/imageDetector';
import type { RowImage, RowKind } from '../src/imageParse/rowParams';
import type { OrientationState } from '../src/imageTransform/orientation';
import { CLASSES } from '../src/constants';

// ── Test helpers ─────────────────────────────────────────────────────

const IDENTITY: OrientationState = { turns: 0, mirror: false };

/** Build a typed RowImage.  Callers hand over the flex-grammar grow the widget
 *  used to seed; hasExplicitWidth maps to the model's hasSizing flag. */
function makeImage(
  fileName: string,
  line: number,
  flexGrow: number,
  hasExplicitWidth = false,
  orientation: OrientationState = IDENTITY
): RowImage {
  return {
    line,
    raw: hasExplicitWidth ? `![[${fileName}|${Math.round(flexGrow * 100)}]]` : `![[${fileName}]]`,
    fileName,
    orientation,
    hasSizing: hasExplicitWidth,
    display: { kind: 'multi', share: flexGrow, fill: null },
  };
}

/** Build a RowGroup.  Kind follows the member count (mirrors detectRowGroups);
 *  a lone member reads under single grammar, so its display is single-follow. */
function makeGroup(images: RowImage[], lineStart = 17): RowGroup {
  const kind: RowKind = images.length === 1 ? 'single' : 'multi';
  const typed = kind === 'single'
    ? images.map((img) => ({ ...img, display: { kind: 'single-follow' as const } }))
    : images;
  return {
    lineStart,
    lineEnd: lineStart + typed.length,
    kind,
    images: typed,
  };
}

function makeOptions(alignment: 'left' | 'center' | 'right' = 'left'): ImageRowOptions {
  return {
    defaultRowHeight: 200,
    gap: 4,
    enableDividers: true,
    enableResize: true,
    snapSensitivity: 3,
    topBarSensitivity: 12,
    ghostImageWidth: 120,
    dragOpacity: 60,
    alignment,
    getResourcePath: (fn) => `mock://${fn}`,
  };
}

/**
 * Simulate image loading by directly writing naturalWidth/Height via
 * Object.defineProperty and firing onload. Then poke internal loadedMetas
 * via applyLayout invocations from the load handler.
 */
function simulateImagesLoaded(
  widget: ImageRowWidget,
  container: HTMLElement,
  dims: Array<{ w: number; h: number }>
): void {
  const imgs = container.querySelectorAll('img');
  for (let i = 0; i < imgs.length && i < dims.length; i++) {
    const img = imgs[i];
    Object.defineProperty(img, 'naturalWidth', { value: dims[i].w, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: dims[i].h, configurable: true });
    Object.defineProperty(img, 'complete', { value: true, configurable: true });
    if (img.onload) img.onload.call(img, new Event('load'));
  }
}

// jsdom lacks ResizeObserver — polyfill so build() doesn't throw
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = MockResizeObserver;

// Every test drives layout synchronously (patched bounding rect + a fired
// load event), so the widget's requestAnimationFrame callbacks — log snapshots
// and zero-width retries — are irrelevant here. Drop them: in jsdom they run
// after the test environment tears down, and the resulting late console write
// surfaces as a spurious "EnvironmentTeardownError" on the run.
window.requestAnimationFrame = () => 0;

// jsdom lacks getBoundingClientRect that reflects layout — patch to
// return a plausible container width so applyLayout doesn't retry via RAF.
function patchBoundingRect(container: HTMLElement, width = 800): void {
  container.getBoundingClientRect = () => {
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 200, width, height: 200, toJSON() {} };
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('sanitizeOptions', () => {
  it('passes through a valid options object unchanged in value', () => {
    const opts = makeOptions('center');
    const s = sanitizeOptions(opts);
    expect(s.defaultRowHeight).toBe(200);
    expect(s.gap).toBe(4);
    expect(s.alignment).toBe('center');
  });

  it('defaults a missing sourcePath to ""', () => {
    // makeOptions omits sourcePath entirely
    const s = sanitizeOptions(makeOptions('left'));
    expect(s.sourcePath).toBe('');
  });

  it('coerces non-finite numerics to DEFAULT_SETTINGS values', () => {
    const bad = {
      ...makeOptions('left'),
      defaultRowHeight: NaN,
      gap: Infinity,
      snapSensitivity: -Infinity,
    };
    const s = sanitizeOptions(bad);
    expect(s.defaultRowHeight).toBe(200);
    expect(s.gap).toBe(4);
    expect(s.snapSensitivity).toBe(3);
  });

  it('falls back to "left" for an invalid alignment', () => {
    const bad = { ...makeOptions('left'), alignment: 'diagonal' } as unknown as ImageRowOptions;
    expect(sanitizeOptions(bad).alignment).toBe('left');
  });

  it('provides an identity getResourcePath when missing', () => {
    const bad = { ...makeOptions('left'), getResourcePath: undefined } as unknown as ImageRowOptions;
    expect(sanitizeOptions(bad).getResourcePath('x.png')).toBe('x.png');
  });

  it('does not throw on an empty object', () => {
    expect(() => sanitizeOptions({} as ImageRowOptions)).not.toThrow();
  });

  it('defaults singleImageSizeMode to "natural" and clamps width to a minimum of 100', () => {
    const s = sanitizeOptions(makeOptions('left'));
    expect(s.singleImageSizeMode).toBe('natural');
    expect(s.singleImageWidth).toBe(400);
  });

  it('preserves a valid "fixed" mode and width', () => {
    const opts = { ...makeOptions('left'), singleImageSizeMode: 'fixed', singleImageWidth: 640 } as unknown as ImageRowOptions;
    const s = sanitizeOptions(opts);
    expect(s.singleImageSizeMode).toBe('fixed');
    expect(s.singleImageWidth).toBe(640);
  });

  it('falls back to "natural" for an invalid singleImageSizeMode and floors width at 100', () => {
    const bad = { ...makeOptions('left'), singleImageSizeMode: 'huge', singleImageWidth: 20 } as unknown as ImageRowOptions;
    const s = sanitizeOptions(bad);
    expect(s.singleImageSizeMode).toBe('natural');
    expect(s.singleImageWidth).toBe(100);
  });
});

describe('ImageRowWidget alignment (single image)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('sets object-position to "left top" for left alignment', () => {
    const group = makeGroup([makeImage('a.png', 5, 1)]);
    const widget = new ImageRowWidget(group, makeOptions('left'));
    const el = widget.build();
    document.body.appendChild(el);
    patchBoundingRect(el, 800);
    simulateImagesLoaded(widget, el, [{ w: 500, h: 654 }]);
    const img = el.querySelector('img') as HTMLImageElement;
    expect(img.style.objectPosition).toBe('left top');
  });

  it('sets object-position to "center top" for center alignment', () => {
    const group = makeGroup([makeImage('a.png', 5, 1)]);
    const widget = new ImageRowWidget(group, makeOptions('center'));
    const el = widget.build();
    document.body.appendChild(el);
    patchBoundingRect(el, 800);
    simulateImagesLoaded(widget, el, [{ w: 500, h: 654 }]);
    const img = el.querySelector('img') as HTMLImageElement;
    expect(img.style.objectPosition).toBe('center top');
  });

  it('sets object-position to "right top" for right alignment', () => {
    const group = makeGroup([makeImage('a.png', 5, 1)]);
    const widget = new ImageRowWidget(group, makeOptions('right'));
    const el = widget.build();
    document.body.appendChild(el);
    patchBoundingRect(el, 800);
    simulateImagesLoaded(widget, el, [{ w: 500, h: 654 }]);
    const img = el.querySelector('img') as HTMLImageElement;
    expect(img.style.objectPosition).toBe('right top');
  });
});

describe('ImageRowWidget alignment (multi-image, all images)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('applies object-position to EVERY image in a 4-image row (left)', () => {
    const group = makeGroup([
      makeImage('a.webp', 17, 1),
      makeImage('b.webp', 18, 4),
      makeImage('c.webp', 19, 9.6),
      makeImage('d.webp', 20, 4),
    ]);
    const widget = new ImageRowWidget(group, makeOptions('left'));
    const el = widget.build();
    document.body.appendChild(el);
    patchBoundingRect(el, 944);
    simulateImagesLoaded(widget, el, [
      { w: 500, h: 654 },
      { w: 800, h: 1200 },
      { w: 1920, h: 1440 },
      { w: 800, h: 1200 },
    ]);
    const imgs = el.querySelectorAll('img');
    expect(imgs.length).toBe(4);
    for (const img of imgs) {
      expect((img as HTMLImageElement).style.objectPosition).toBe('left top');
    }
  });

  it('applies object-position to EVERY image in a 4-image row (center)', () => {
    const group = makeGroup([
      makeImage('a.webp', 17, 1),
      makeImage('b.webp', 18, 4),
      makeImage('c.webp', 19, 9.6),
      makeImage('d.webp', 20, 4),
    ]);
    const widget = new ImageRowWidget(group, makeOptions('center'));
    const el = widget.build();
    document.body.appendChild(el);
    patchBoundingRect(el, 944);
    simulateImagesLoaded(widget, el, [
      { w: 500, h: 654 },
      { w: 800, h: 1200 },
      { w: 1920, h: 1440 },
      { w: 800, h: 1200 },
    ]);
    const imgs = el.querySelectorAll('img');
    for (const img of imgs) {
      expect((img as HTMLImageElement).style.objectPosition).toBe('center top');
    }
  });

  it('applies object-position to EVERY image in a 4-image row (right)', () => {
    const group = makeGroup([
      makeImage('a.webp', 17, 1),
      makeImage('b.webp', 18, 4),
      makeImage('c.webp', 19, 9.6),
      makeImage('d.webp', 20, 4),
    ]);
    const widget = new ImageRowWidget(group, makeOptions('right'));
    const el = widget.build();
    document.body.appendChild(el);
    patchBoundingRect(el, 944);
    simulateImagesLoaded(widget, el, [
      { w: 500, h: 654 },
      { w: 800, h: 1200 },
      { w: 1920, h: 1440 },
      { w: 800, h: 1200 },
    ]);
    const imgs = el.querySelectorAll('img');
    for (const img of imgs) {
      expect((img as HTMLImageElement).style.objectPosition).toBe('right top');
    }
  });

  it('applies object-position to every image when |width markdown gives hasExplicitWidth=true', () => {
    // This is the actual regression case: images with |width in markdown,
    // one of which (index 2, flexGrow=9.6) was previously resized by a
    // corner-handle.
    const group = makeGroup([
      makeImage('a.webp', 17, 1, true),
      makeImage('b.webp', 18, 4, true),
      makeImage('c.webp', 19, 9.6, true),
      makeImage('d.webp', 20, 4, true),
    ]);
    const widget = new ImageRowWidget(group, makeOptions('right'));
    const el = widget.build();
    document.body.appendChild(el);
    patchBoundingRect(el, 944);
    simulateImagesLoaded(widget, el, [
      { w: 500, h: 654 },
      { w: 800, h: 1200 },
      { w: 1920, h: 1440 },
      { w: 800, h: 1200 },
    ]);
    const imgs = el.querySelectorAll('img');
    for (let i = 0; i < imgs.length; i++) {
      expect(imgs[i].style.objectPosition).toBe('right top');
    }
  });
});

describe('ImageRowWidget alignment persists across widget recreation (preserved sizes)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('after destroy+rebuild, all images use NEW alignment (not stale from preserved)', () => {
    // Simulate the alignment-change flow:
    //   1. Build widget A with 'left', let images load.
    //   2. Destroy A → preservedMultiImageSizes populated.
    //   3. Build widget B (same lineStart) with 'right', let images load.
    //   4. All 4 img.style.objectPosition should be 'right top'.
    const groupA = makeGroup([
      makeImage('a.webp', 17, 1, true),
      makeImage('b.webp', 18, 4, true),
      makeImage('c.webp', 19, 9.6, true),
      makeImage('d.webp', 20, 4, true),
    ]);
    const widgetA = new ImageRowWidget(groupA, makeOptions('left'));
    const elA = widgetA.build();
    document.body.appendChild(elA);
    patchBoundingRect(elA, 944);
    simulateImagesLoaded(widgetA, elA, [
      { w: 500, h: 654 },
      { w: 800, h: 1200 },
      { w: 1920, h: 1440 },
      { w: 800, h: 1200 },
    ]);
    // Simulate corner-handle resize on image 2: set inline height
    const imgsA = elA.querySelectorAll('img');
    imgsA[2].setCssStyles({ height: '361px' });
    const itemC = elA.querySelectorAll('.diaa-item')[2] as HTMLElement;
    itemC.setCssStyles({ height: '361px' });
    // Destroy — this saves preservedMultiImageSizes internally
    widgetA.destroy();

    // Build widget B with new alignment
    const groupB = makeGroup([
      makeImage('a.webp', 17, 1, true),
      makeImage('b.webp', 18, 4, true),
      makeImage('c.webp', 19, 9.6, true),
      makeImage('d.webp', 20, 4, true),
    ]);
    const widgetB = new ImageRowWidget(groupB, makeOptions('right'));
    const elB = widgetB.build();
    document.body.appendChild(elB);
    patchBoundingRect(elB, 944);
    simulateImagesLoaded(widgetB, elB, [
      { w: 500, h: 654 },
      { w: 800, h: 1200 },
      { w: 1920, h: 1440 },
      { w: 800, h: 1200 },
    ]);
    const imgsB = elB.querySelectorAll('img');
    expect(imgsB.length).toBe(4);
    for (let i = 0; i < imgsB.length; i++) {
      const op = imgsB[i].style.objectPosition;
      expect(op, `img[${i}] object-position after alignment change`).toBe('right top');
    }
  });

  it('after destroy+rebuild, container justify-content reflects NEW alignment', () => {
    const group = makeGroup([
      makeImage('a.webp', 17, 1, true),
      makeImage('b.webp', 18, 4, true),
    ]);
    const widgetA = new ImageRowWidget(group, makeOptions('left'));
    const elA = widgetA.build();
    document.body.appendChild(elA);
    patchBoundingRect(elA, 944);
    simulateImagesLoaded(widgetA, elA, [{ w: 500, h: 654 }, { w: 800, h: 1200 }]);
    widgetA.destroy();

    const widgetB = new ImageRowWidget(group, makeOptions('center'));
    const elB = widgetB.build();
    document.body.appendChild(elB);
    patchBoundingRect(elB, 944);
    simulateImagesLoaded(widgetB, elB, [{ w: 500, h: 654 }, { w: 800, h: 1200 }]);

    expect(elB.style.justifyContent).toBe('center');
  });
});

describe('ImageRowWidget.updateAlignment (in-place)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('updates every image object-position without recreating widget', () => {
    const group = makeGroup([
      makeImage('a.webp', 17, 1),
      makeImage('b.webp', 18, 4),
      makeImage('c.webp', 19, 9.6),
    ]);
    const widget = new ImageRowWidget(group, makeOptions('left'));
    const el = widget.build();
    document.body.appendChild(el);
    patchBoundingRect(el, 944);
    simulateImagesLoaded(widget, el, [
      { w: 500, h: 654 },
      { w: 800, h: 1200 },
      { w: 1920, h: 1440 },
    ]);
    let imgs = el.querySelectorAll('img');
    for (const img of imgs) {
      expect((img as HTMLImageElement).style.objectPosition).toBe('left top');
    }

    widget.updateAlignment('right');
    imgs = el.querySelectorAll('img');
    expect(imgs.length).toBe(3);
    for (const img of imgs) {
      expect((img as HTMLImageElement).style.objectPosition).toBe('right top');
    }
    // Verify item-level alignment (img element positioning within item)
    const items = el.querySelectorAll('.diaa-item');
    for (const item of items) {
      expect((item as HTMLElement).style.display).toBe('flex');
      expect((item as HTMLElement).style.justifyContent).toBe('flex-end');
    }
    expect(el.style.justifyContent).toBe('flex-end');
  });

  it('applies item-level flex positioning for every image after build', () => {
    const group = makeGroup([
      makeImage('a.webp', 17, 1),
      makeImage('b.webp', 18, 4),
      makeImage('c.webp', 19, 9.6),
    ]);
    const widget = new ImageRowWidget(group, makeOptions('center'));
    const el = widget.build();
    document.body.appendChild(el);
    patchBoundingRect(el, 944);
    simulateImagesLoaded(widget, el, [
      { w: 500, h: 654 },
      { w: 800, h: 1200 },
      { w: 1920, h: 1440 },
    ]);
    const items = el.querySelectorAll('.diaa-item');
    expect(items.length).toBe(3);
    for (const item of items) {
      expect((item as HTMLElement).style.display).toBe('flex');
      expect((item as HTMLElement).style.justifyContent).toBe('center');
    }
  });
});

describe('ImageRowWidget replays each member orientation as a CSS transform', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  function buildLoaded(
    files: Array<{ name: string; line: number; grow: number; orientation?: OrientationState }>,
    dims: Array<{ w: number; h: number }>,
    lineStart = 17,
  ): { el: HTMLElement; widget: ImageRowWidget } {
    const group = makeGroup(
      files.map((f) => makeImage(f.name, f.line, f.grow, false, f.orientation))
    );
    const widget = new ImageRowWidget(group, makeOptions('left'));
    const el = widget.build();
    document.body.appendChild(el);
    patchBoundingRect(el, 944);
    simulateImagesLoaded(widget, el, dims);
    return { el, widget };
  }

  it('applies a quarter-turn onto a single-image row', () => {
    const { el } = buildLoaded(
      [{ name: 'a.png', line: 5, grow: 1, orientation: { turns: 1, mirror: false } }],
      [{ w: 500, h: 654 }]
    );
    const img = el.querySelector('img') as HTMLImageElement;
    expect(img.style.transform).toBe('rotate(90deg)');
  });

  it('applies each member orientation onto a multi-image row', () => {
    const { el } = buildLoaded(
      [
        { name: 'a.png', line: 17, grow: 1, orientation: { turns: 3, mirror: false } },
        { name: 'b.png', line: 18, grow: 4, orientation: { turns: 0, mirror: true } },
      ],
      [
        { w: 500, h: 654 },
        { w: 800, h: 1200 },
      ]
    );
    const imgs = el.querySelectorAll('img');
    expect(imgs.length).toBe(2);
    // A row member carries its bitmap's aspect as the scale, so the turned
    // member's box keeps the fill share of the slot it was given, instead of
    // being fitted back into the un-rotated box.
    expect(imgs[0].style.transform).toBe(`scale(${500 / 654}) rotate(270deg)`);
    expect(imgs[1].style.transform).toBe('scaleX(-1)');
  });

  it('leaves an identity-orientation image untransformed', () => {
    const { el } = buildLoaded(
      [{ name: 'a.png', line: 5, grow: 1 }],
      [{ w: 500, h: 654 }]
    );
    const img = el.querySelector('img') as HTMLImageElement;
    expect(img.style.transform).toBe('');
  });
});

describe('ImageRowWidget sizes a lone item to what is drawn', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  /** jsdom measures nothing, so the box the layout maths works from is the one
   *  the widget writes: a 500×654 natural image rendered 500 wide is a 500×654
   *  box, and a quarter turn draws it at 654×500 — width and height swapped, the
   *  picture's own pixel scale untouched. */
  function buildSingle(orientation?: OrientationState, dims = { w: 500, h: 654 }) {
    const group = makeGroup([makeImage('a.png', 5, 1, false, orientation)]);
    const widget = new ImageRowWidget(group, makeOptions('left'));
    const el = widget.build();
    document.body.appendChild(el);
    patchBoundingRect(el, 944);
    simulateImagesLoaded(widget, el, [dims]);
    const item = el.querySelector('.diaa-item') as HTMLElement;
    const img = el.querySelector('img') as HTMLImageElement;
    return { el, widget, item, img };
  }

  it('swaps the item to the turned drawing rather than the layout box', () => {
    const { item, img } = buildSingle({ turns: 1, mirror: false });
    // The box keeps the un-rotated size — it holds the un-rotated bitmap.
    expect(img.style.height).toBe('654px');
    // The item takes the drawn size: the box's width and height swapped.
    expect(item.style.width).toBe('654px');
    expect(item.style.height).toBe('500px');
    // The box is centred in the item, which is why it must not be clamped by it.
    expect(item.style.alignItems).toBe('center');
    expect(item.style.justifyContent).toBe('center');
    expect(img.style.maxWidth).toBe('none');
    expect(img.style.transform).toBe('rotate(90deg)');
  });

  it('records the page width, not the layout box width, on a turned row', () => {
    const { widget, img } = buildSingle({ turns: 1, mirror: false });
    const { images } = (widget as unknown as { group: RowGroup }).group;
    // Natural mode: on the page the picture is 654 across — the bitmap's own
    // height — while the box it is drawn from stays 500. The line records the
    // former, so the number in the note is the one the reader sees.
    expect(images[0].raw).toBe('![[a.png|r90|left|0|654]]');
    // The context menu reads the same number off the element, to move it by one
    // aspect when a turn would otherwise change what the page shows.
    expect(img.__diaa_screenWidth?.()).toBe(654);
  });

  it('sizes a pinned turned row from its page width', () => {
    // A 2:1 landscape pinned at 400 across the page. Turned, the box that holds
    // the un-rotated bitmap is 800×400 and the drawing comes off it at 400×800.
    const group = makeGroup([{
      ...makeImage('a.png', 5, 1, false, { turns: 1, mirror: false }),
      raw: '![[a.png|r90|left|1|400]]',
      hasSizing: true,
    }]);
    // makeGroup reads a lone member under single grammar; pin it, as `|1|400` does.
    group.images[0].display = { kind: 'single-manual', widthPx: 400 };
    const widget = new ImageRowWidget(group, makeOptions('left'));
    const el = widget.build();
    document.body.appendChild(el);
    patchBoundingRect(el, 944);
    simulateImagesLoaded(widget, el, [{ w: 800, h: 400 }]);

    const item = el.querySelector('.diaa-item') as HTMLElement;
    const img = el.querySelector('img') as HTMLImageElement;
    expect(img.style.height).toBe('400px');
    expect(item.style.width).toBe('400px');
    expect(item.style.height).toBe('800px');
    expect(img.style.transform).toBe('rotate(90deg)');
    // The line already says the page width, so layout has nothing to rewrite.
    expect(group.images[0].raw).toBe('![[a.png|r90|left|1|400]]');
    expect(img.__diaa_screenWidth?.()).toBe(400);
  });

  it('reads a follow width on a turned row as the width across the page', () => {
    // The reset case: a 2:1 landscape rotated, then handed back to "Fixed 400".
    // Upright or turned, 400 is what the row must show across the page — which
    // for a turned picture means an 800×400 box drawn back down to 400×800.
    const group = makeGroup([{
      ...makeImage('a.png', 5, 1, false, { turns: 1, mirror: false }),
      raw: '![[a.png|r90|center|0|400]]',
      hasSizing: true,
    }]);
    const widget = new ImageRowWidget(group, {
      ...makeOptions('center'),
      singleImageSizeMode: 'fixed',
      singleImageWidth: 400,
    });
    const el = widget.build();
    document.body.appendChild(el);
    patchBoundingRect(el, 944);
    simulateImagesLoaded(widget, el, [{ w: 800, h: 400 }]);

    const item = el.querySelector('.diaa-item') as HTMLElement;
    const img = el.querySelector('img') as HTMLImageElement;
    expect(item.style.width).toBe('400px');
    expect(item.style.height).toBe('800px');
    expect(img.style.height).toBe('400px');
  });

  it('keeps a turned picture on the page by shrinking the box, not the drawing', () => {
    // 700×1400 portrait: turned, the picture is "naturally" 1400 wide, which
    // overruns a 944 page.  The box is what gets shrunk — to 472×944, an exact
    // un-rotated 700×1400 at half scale — so the drawing lands on the page width
    // and needs no fit scale of its own.
    const { item, img } = buildSingle({ turns: 1, mirror: false }, { w: 700, h: 1400 });
    expect(img.style.height).toBe('944px');
    expect(img.style.transform).toBe('rotate(90deg)');
    expect(Math.round(parseFloat(item.style.width))).toBe(944);
    expect(Math.round(parseFloat(item.style.height))).toBe(472);
  });

  it('restores the layout box height when Obsidian overwrites it on a turned row', async () => {
    const { img } = buildSingle({ turns: 1, mirror: false });
    // Obsidian's own resize writes the img's inline height to the *item* size
    // (the drawn one). Left alone that would deform the box the turn is drawn
    // from, so the observer has to put the box height back.
    img.setCssStyles({ height: '500px' });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(img.style.height).toBe('654px');
  });

  it('leaves an unturned item to the image box', () => {
    const { item, img } = buildSingle(undefined);
    expect(img.style.height).toBe('654px');
    expect(item.style.height).toBe('');
    expect(item.style.width).toBe('');
    expect(item.style.alignItems).toBe('flex-start');
    expect(img.style.maxWidth).toBe('100%');
  });

  it('goes back to the box when the turn is undone', () => {
    const { item } = buildSingle({ turns: 1, mirror: false });
    expect(item.style.height).toBe('500px');
    const { item: upright } = buildSingle(undefined);
    expect(upright.style.height).toBe('');
  });

  it('reports the turn for the resize controller', () => {
    expect(buildSingle({ turns: 3, mirror: true }).widget.isTurnedImage(0)).toBe(true);
    expect(buildSingle(undefined).widget.isTurnedImage(0)).toBe(false);
  });
});

/**
 * The two gestures that equalise a pair — double-clicking the divider and
 * dragging until it snaps — must land on the same geometry.  They diverged:
 * the double-click pinned `computeRowHeight`'s clamped figure onto the item and
 * the picture and left the picture its intrinsic width, so the drawing sat
 * 27 px inside its 513 px item on one side and 24 px inside its 448 px item on
 * the other, reading as a ~63 px gap; the drag left the picture flush to its
 * item and showed the divider's own 12 px.  Both now hand the split to the row's
 * own pass, and the split is the one `computePairEquilibrium` solves to — the
 * same answer the drag snaps to, pinned in dividerController.test.ts.
 */
describe('ImageRowWidget divider double-click', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  /** The 图片并排测试文档 repro row, at the width the editor reported. */
  function buildReproRow() {
    const a = makeImage('a.webp', 23, 1.34, true);
    a.display = { kind: 'multi', share: 1.34, fill: 0.64 };
    const b = makeImage('b.webp', 24, 0.72, true);
    b.display = { kind: 'multi', share: 0.72, fill: 1 };
    const widget = new ImageRowWidget(makeGroup([a, b]), makeOptions('left'));
    const el = widget.build();
    document.body.appendChild(el);
    patchBoundingRect(el, 972.890625);
    simulateImagesLoaded(widget, el, [
      { w: 500, h: 654 },
      { w: 800, h: 1200 },
    ]);
    return el;
  }

  it('lands on the persisted grid, holding the pair total, pictures flush', () => {
    const el = buildReproRow();
    const divider = el.querySelector(`.${CLASSES.divider}`) as HTMLElement;
    divider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    const items = el.querySelectorAll<HTMLElement>(`.${CLASSES.imageItem}`);
    // The continuous solve wants 1.10043 / 0.95957 (2.06 grows in, split in
    // aspect — the pair's own fills of 0.64 and 1 are retired by the gesture, so
    // each picture fills the slot it ends up with).  The row grammar only
    // carries hundredths, so the snap lands on the grid point near it that keeps
    // the drawn heights closest — and the pair's total is held, since a divider
    // never takes width off the rest of the row.  The grid step here is ~4 px of
    // height, so the residual is a couple of pixels: what the file can express,
    // the screen now shows.
    expect(Number.parseFloat(items[0].style.flexGrow)).toBeCloseTo(1.1, 4);
    expect(Number.parseFloat(items[1].style.flexGrow)).toBeCloseTo(0.96, 4);

    // Each member draws its own height off that split, and the row is the
    // taller of the two — the picture's box takes the same number, so nothing is
    // left floating inside its item.
    const imgs = el.querySelectorAll<HTMLImageElement>('img');
    expect(imgs[0].style.height).toBe('671px');
    expect(imgs[1].style.height).toBe('672px');
    expect(items[0].style.height).toBe('671px');
    expect(items[1].style.height).toBe('672px');
    expect(el.style.height).toBe('672px');
  });

  it('retires the pair\'s own fills, so the pictures stay flush on the next rebuild', () => {
    const a = makeImage('a.webp', 23, 1.34, true);
    a.display = { kind: 'multi', share: 1.34, fill: 0.64 };
    const b = makeImage('b.webp', 24, 0.72, true);
    b.display = { kind: 'multi', share: 0.72, fill: 1 };
    const widget = new ImageRowWidget(makeGroup([a, b]), makeOptions('left'));
    const el = widget.build();
    document.body.appendChild(el);
    patchBoundingRect(el, 972.890625);
    simulateImagesLoaded(widget, el, [
      { w: 500, h: 654 },
      { w: 800, h: 1200 },
    ]);

    const divider = el.querySelector(`.${CLASSES.divider}`) as HTMLElement;
    divider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    // The row reads the fills back from the note on every rebuild, so a fill
    // left behind would paint the picture narrow inside its slot again.
    expect(a.display).toMatchObject({ kind: 'multi', fill: 1 });
    expect(b.display).toMatchObject({ kind: 'multi', fill: 1 });
  });

  it('balances the whole row on aspect ratios, leaving no blank in any slot', () => {
    const a = makeImage('a.png', 10, 2.86, true);
    a.display = { kind: 'multi', share: 2.86, fill: 1 };
    const b = makeImage('b.png', 11, 1.64, true);
    b.display = { kind: 'multi', share: 1.64, fill: 1 };
    const c = makeImage('b.png', 12, 2.38, true);
    c.display = { kind: 'multi', share: 2.38, fill: 0.52 };
    const d = makeImage('a.png', 13, 2.86, true);
    d.display = { kind: 'multi', share: 2.86, fill: 1 };
    const widget = new ImageRowWidget(makeGroup([a, b, c, d], 14), makeOptions('left'));
    const el = widget.build();
    document.body.appendChild(el);
    patchBoundingRect(el, 972.890625);
    simulateImagesLoaded(widget, el, [
      { w: 1920, h: 1440 },
      { w: 500, h: 654 },
      { w: 500, h: 654 },
      { w: 1920, h: 1440 },
    ]);

    const topBar = el.querySelector(`.${CLASSES.topBar}`) as HTMLElement;
    topBar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    // The shrunk member's 0.52 is what used to hand it a *wider* slot than the
    // picture — equal heights came out, but 135 px of the slot stayed empty.  On
    // aspect ratios the two 500×654 members get the same slot as each other, and
    // every member's box fills the slot it was given.
    const items = Array.from(el.querySelectorAll<HTMLElement>(`.${CLASSES.imageItem}`));
    const imgs = Array.from(el.querySelectorAll<HTMLImageElement>('img'));

    for (const m of [a, b, c, d]) {
      const fill = m.display.kind === 'multi' ? m.display.fill : null;
      expect(fill).toBe(1);
    }

    // Two members of the same aspect carry the same grow, and each drawn height
    // is its own slot times its aspect — so the four are equal.
    expect(Number.parseFloat(items[1].style.flexGrow)).toBeCloseTo(
      Number.parseFloat(items[2].style.flexGrow), 6
    );
    const heights = imgs.map((im) => Number.parseFloat(im.style.height));
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
  });
});

describe('ImageRowWidget top-bar double-click lands the row on an exact grid point', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  /** The 图片并排测试 row: two wide outside, two narrow inside. */
  function buildTwoPairRow(width = 972.890625) {
    const a = makeImage('a.png', 10, 2.86, true);
    a.display = { kind: 'multi', share: 2.86, fill: 1 };
    const b = makeImage('b.png', 11, 1.64, true);
    b.display = { kind: 'multi', share: 1.64, fill: 1 };
    const c = makeImage('c.png', 12, 2.38, true);
    c.display = { kind: 'multi', share: 2.38, fill: 0.52 };
    const d = makeImage('d.png', 13, 2.86, true);
    d.display = { kind: 'multi', share: 2.86, fill: 1 };
    const widget = new ImageRowWidget(makeGroup([a, b, c, d], 14), makeOptions('left'));
    const el = widget.build();
    document.body.appendChild(el);
    patchBoundingRect(el, width);
    simulateImagesLoaded(widget, el, [
      { w: 1920, h: 1440 },
      { w: 500, h: 654 },
      { w: 500, h: 654 },
      { w: 1920, h: 1440 },
    ]);
    const topBar = el.querySelector(`.${CLASSES.topBar}`) as HTMLElement;
    topBar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return { el, members: [a, b, c, d] };
  }

  it('equals the four drawn heights, not just the ones a single member can reach', () => {
    const { el } = buildTwoPairRow();

    // The continuous solve wants 3.0952 / 1.7748 on the aspect split, which the
    // grid rounds to 3.10 / 1.77.  That point paints the row the user sees as
    // "the middle two a pixel short", and no single member's step improves on
    // it: flex-grow is a ratio, so moving one member drags the whole row, and
    // the one-member move towards the fix is strictly worse than standing
    // still.  The solver instead keeps the continuous solution's *ratios* and
    // sweeps their scale: 2.18 / 1.25 lands the per-image rounding on a point
    // that paints four equal heights, and the unrounded model is equal there by
    // construction, so nothing later in the sweep can beat it.
    const items = Array.from(el.querySelectorAll<HTMLElement>(`.${CLASSES.imageItem}`));
    const grows = items.map((it) => Number.parseFloat(it.style.flexGrow));
    expect(grows).toEqual([2.18, 1.25, 1.25, 2.18]);

    const imgs = Array.from(el.querySelectorAll<HTMLImageElement>('img'));
    const heights = imgs.map((im) => Number.parseFloat(im.style.height));
    expect(heights).toEqual([223, 223, 223, 223]);
    expect(Math.max(...heights) - Math.min(...heights)).toBe(0);
  });

  it('still paints four equal heights when the rounding band shifts with width', () => {
    // At 973.5 the seed rounds to 3.10 / 1.78 and paints 224/223/223/224 — the
    // "middle two a pixel short" row again, but this time the nearest grid points
    // that paint four equal heights are three-plus steps away, so the old local
    // descent could not reach them.  The scale sweep has no neighbourhood to be
    // trapped in.
    const { el } = buildTwoPairRow(973.5);

    const items = Array.from(el.querySelectorAll<HTMLElement>(`.${CLASSES.imageItem}`));
    const grows = items.map((it) => Number.parseFloat(it.style.flexGrow));
    expect(grows[0]).toBe(grows[3]);
    expect(grows[1]).toBe(grows[2]);

    const imgs = Array.from(el.querySelectorAll<HTMLImageElement>('img'));
    const heights = imgs.map((im) => Number.parseFloat(im.style.height));
    expect(Math.max(...heights) - Math.min(...heights)).toBe(0);
  });

  it('retires every member fill, so no slot keeps a blank', () => {
    const { members } = buildTwoPairRow();
    for (const m of members) {
      expect(m.display).toMatchObject({ kind: 'multi', fill: 1 });
    }
  });
});

describe('ImageRowWidget quarters a turned member in an unfilled row', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  function buildUnfilledRow() {
    const turned: OrientationState = { turns: 1, mirror: false };
    const group = makeGroup([
      makeImage('q1.webp', 31, 1, false, turned),
      makeImage('q2.webp', 32, 1),
    ]);
    const widget = new ImageRowWidget(group, makeOptions('left'));
    const el = widget.build();
    document.body.appendChild(el);
    patchBoundingRect(el, 944);
    simulateImagesLoaded(widget, el, [
      { w: 500, h: 654 },
      { w: 500, h: 654 },
    ]);
    widget.recalculateRowHeight();
    return el;
  }

  it('gives the turned cell the drawing, not the box it is folded inside', () => {
    const el = buildUnfilledRow();
    const items = el.querySelectorAll<HTMLElement>(`.${CLASSES.imageItem}`);
    const imgs = el.querySelectorAll<HTMLImageElement>('img');
    const box = Number.parseFloat(imgs[0].style.height);

    // The img keeps the box — the rectangle the member occupied upright, which
    // the turn repaints inside — and the cell takes what is painted.  Portrait,
    // aspect 0.7645: the fit is the aspect itself, so the drawing is box ×
    // aspect², and *that* is the rectangle the column hugs.
    expect(box).toBe(600);
    expect(imgs[0].style.transform).toBe(`scale(${500 / 654}) rotate(90deg)`);
    expect(items[0].style.height).toBe('351px');
    expect(items[0].style.height).not.toBe(imgs[0].style.height);
    // The drawing is centred inside the box it no longer fills, which is what
    // puts it on the cell's own centre line.
    expect(items[0].style.alignItems).toBe('center');
  });

  it('takes its height from the tallest cell, whatever orientation the members take', () => {
    // A turn can only fold a drawing smaller than its box, so a cell is never
    // taller than the box it came from and a rotation can never grow the row.
    // Here an upright neighbour holds the row at the box height the whole time.
    const STATES: Array<[string, OrientationState]> = [
      ['orig', { turns: 0, mirror: false }],
      ['r90', { turns: 1, mirror: false }],
      ['r180', { turns: 2, mirror: false }],
      ['r270', { turns: 3, mirror: false }],
      ['fh', { turns: 0, mirror: true }],
      ['fv', { turns: 2, mirror: true }],
      ['r90fh', { turns: 1, mirror: true }],
      ['r270fh', { turns: 3, mirror: true }],
    ];
    for (const [word, state] of STATES) {
      const group = makeGroup([
        makeImage('q1.webp', 31, 1, false, state),
        makeImage('q2.webp', 32, 1),
      ]);
      const widget = new ImageRowWidget(group, makeOptions('left'));
      const el = widget.build();
      document.body.appendChild(el);
      patchBoundingRect(el, 944);
      simulateImagesLoaded(widget, el, [
        { w: 500, h: 654 },
        { w: 500, h: 654 },
      ]);
      widget.recalculateRowHeight();

      const items = el.querySelectorAll<HTMLElement>(`.${CLASSES.imageItem}`);
      const imgs = el.querySelectorAll<HTMLImageElement>('img');
      const turned = state.turns % 2 === 1;
      const drawn = turned ? Math.round((500 / 654) * 600 * (500 / 654)) : 600;
      expect(imgs[0].style.height, word).toBe('600px');
      expect(items[0].style.height, word).toBe(`${drawn}px`);
      expect(el.style.height, word).toBe('600px');
    }
  });

  it('leaves its upright neighbour on its box', () => {
    const el = buildUnfilledRow();
    const items = el.querySelectorAll<HTMLElement>(`.${CLASSES.imageItem}`);
    const imgs = el.querySelectorAll<HTMLImageElement>('img');

    // Upright, the drawing *is* the box, so the cell is unchanged there.
    expect(items[1].style.height).toBe(imgs[1].style.height);
    expect(items[1].style.height).toBe('600px');
    expect(items[1].style.alignItems).toBe('flex-start');
  });

  it('lines a balanced row up on one height, boxes notwithstanding', () => {
    // The shape a balance gesture leaves: shares from the rendered aspect ratios
    // (a landscape's 1.778, a turned portrait's 1 / 0.7645) so every drawing
    // comes out the same height.  Rounding apart, the cells agree — and the row
    // is that height, not the 517px box the turned member is folded inside.
    const turned: OrientationState = { turns: 1, mirror: false };
    const group = makeGroup([
      { ...makeImage('l.webp', 31, 1.778, true), display: { kind: 'multi', share: 1.778, fill: 1 } },
      { ...makeImage('p.webp', 32, 1.308, true, turned), display: { kind: 'multi', share: 1.308, fill: 1 } },
    ]);
    const widget = new ImageRowWidget(group, makeOptions('left'));
    const el = widget.build();
    document.body.appendChild(el);
    patchBoundingRect(el, 944);
    simulateImagesLoaded(widget, el, [
      { w: 1600, h: 900 },
      { w: 500, h: 654 },
    ]);
    widget.recalculateRowHeight();

    const items = el.querySelectorAll<HTMLElement>(`.${CLASSES.imageItem}`);
    const imgs = el.querySelectorAll<HTMLImageElement>('img');
    expect(items[0].style.height).toBe('302px');
    expect(items[1].style.height).toBe('302px');
    expect(imgs[1].style.height).toBe('517px');
    expect(el.style.height).toBe('302px');
  });
});

/**
 * Below the breakpoint the media query re-flows the row and the widget must get
 * out of its way: the inline pixel geometry it writes would outrank the
 * stylesheet and pin the row to its desktop layout.  The widget therefore
 * stashes the members' flex values, clears every inline dimension, and puts the
 * flex back before re-laying-out when the viewport widens again.
 */
describe('ImageRowWidget narrow viewport hand-off', () => {
  interface MediaStub {
    set(narrow: boolean): void;
  }

  /** A MediaQueryList stand-in whose `matches` is whatever the test last set;
   *  `set` fires the change event at whoever subscribed (the widget did, once,
   *  in build()). */
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

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });

  /** The 图片并排测试文档 repro row, built at the given viewport width class.
   *  The returned `media` drives the stub the widget subscribed to at build. */
  function buildReproRow(narrow = false) {
    const media = stubMatchMedia(narrow);
    const a = makeImage('a.webp', 23, 1.34, true);
    a.display = { kind: 'multi', share: 1.34, fill: 0.64 };
    const b = makeImage('b.webp', 24, 0.72, true);
    b.display = { kind: 'multi', share: 0.72, fill: 1 };
    const widget = new ImageRowWidget(makeGroup([a, b]), makeOptions('left'));
    const el = widget.build();
    document.body.appendChild(el);
    patchBoundingRect(el, 972.890625);
    simulateImagesLoaded(widget, el, [
      { w: 500, h: 654 },
      { w: 800, h: 1200 },
    ]);
    const items = (): HTMLElement[] =>
      Array.from(el.querySelectorAll<HTMLElement>(`.${CLASSES.imageItem}`));
    const imgs = (): HTMLImageElement[] => Array.from(el.querySelectorAll<HTMLImageElement>('img'));
    return { el, items, imgs, media };
  }

  it('clears the inline geometry below the breakpoint and restores it above', () => {
    const { el, items, imgs, media } = buildReproRow();
    const wide = {
      container: el.style.height,
      itemFlex: items().map((i) => i.style.flex),
      itemGrow: items().map((i) => i.style.flexGrow),
      imgHeight: imgs().map((i) => i.style.height),
    };
    expect(wide.container).not.toBe('');
    expect(wide.itemGrow).toEqual(['1.34', '0.72']);

    media.set(true);

    expect(el.style.height).toBe('');
    for (const item of items()) {
      expect(item.style.flex).toBe('');
      expect(item.style.flexGrow).toBe('');
      expect(item.style.height).toBe('');
    }
    // The image follows the item's new width and takes its height from its own
    // aspect ratio; a desktop pixel height would letterbox it in a 45 % item.
    for (const img of imgs()) {
      expect(img.style.width).toBe('100%');
      expect(img.style.height).toBe('auto');
    }

    media.set(false);
    expect(el.style.height).toBe(wide.container);
    expect(items().map((i) => i.style.flex)).toEqual(wide.itemFlex);
    expect(items().map((i) => i.style.flexGrow)).toEqual(wide.itemGrow);
    expect(imgs().map((i) => i.style.height)).toEqual(wide.imgHeight);
  });

  it('never writes inline geometry when it is built already narrow', () => {
    const { el, items, imgs } = buildReproRow(true);

    expect(el.style.height).toBe('');
    for (const item of items()) {
      expect(item.style.flex).toBe('');
      expect(item.style.height).toBe('');
    }
    for (const img of imgs()) {
      expect(img.style.width).toBe('100%');
      expect(img.style.height).toBe('auto');
    }
  });
});

describe('handleRect', () => {
  const item = { left: 5, top: 5, width: 400, height: 523 };
  const content = { left: 0, top: 0, width: 400, height: 523 };
  const img = { left: 20, top: 10, width: 400, height: 523 };

  it('is the content rect when no turn is in play', () => {
    expect(handleRect(content, img, item, false)).toEqual(content);
  });

  it('hugs the measured img box after a quarter turn', () => {
    // The 400×523 layout box draws its content at 400×306 once turned, and the
    // browser reports exactly that as the img's rect, transform included.
    const turnedImg = { left: 20, top: 10, width: 400, height: 306 };
    expect(handleRect(content, turnedImg, item, true)).toEqual({
      left: 15,
      top: 5,
      width: 400,
      height: 306,
    });
  });

  it('follows the img box wherever flex alignment puts it', () => {
    const turnedImg = { left: 205, top: 55, width: 380, height: 288.4 };
    expect(handleRect(content, turnedImg, item, true)).toEqual({
      left: 200,
      top: 50,
      width: 380,
      height: 288.4,
    });
  });
});

/**
 * Which divider a resize drag lights as its equilibrium bar.
 *
 * The side of a member is a junction, and a junction is one of the dividers the
 * row built — `dividerEls[k]` is built by `build(k)` and appended before member
 * `k + 1`.  Reading that off by one would light the wrong junction (or none, at
 * the first and last members), which is a defect the geometry tests cannot see:
 * the height still snaps, only the bar lands elsewhere.
 */
describe('equilibrium bar for a resize drag', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  function threeRow(enableDividers = true): { widget: ImageRowWidget; el: HTMLElement } {
    const group = makeGroup([
      makeImage('a.webp', 17, 1),
      makeImage('b.webp', 18, 4),
      makeImage('c.webp', 19, 4),
    ]);
    const widget = new ImageRowWidget(group, { ...makeOptions(), enableDividers });
    const el = widget.build();
    document.body.appendChild(el);
    patchBoundingRect(el, 944);
    simulateImagesLoaded(widget, el, [
      { w: 800, h: 1200 },
      { w: 800, h: 1200 },
      { w: 800, h: 1200 },
    ]);
    return { widget, el };
  }

  const snapClass = CLASSES.dividerSnap;

  it('lights the junction on the side asked for, and only that one', () => {
    const { widget } = threeRow();
    const dividers = widget.getDividerEls();
    expect(dividers).toHaveLength(2);

    // The middle member's left junction is the divider before it, its right
    // junction the one after it.
    expect(widget.setResizeSnapSide(1, 'left')).toBe(true);
    expect(dividers[0].classList.contains(snapClass)).toBe(true);
    expect(dividers[1].classList.contains(snapClass)).toBe(false);
  });

  it('moves the bar across when the drag crosses to the other side', () => {
    const { widget } = threeRow();
    const dividers = widget.getDividerEls();

    widget.setResizeSnapSide(1, 'left');
    widget.setResizeSnapSide(1, 'right');

    expect(dividers[0].classList.contains(snapClass)).toBe(false);
    expect(dividers[1].classList.contains(snapClass)).toBe(true);
  });

  it('puts the bar out when asked for no side', () => {
    const { widget } = threeRow();
    const dividers = widget.getDividerEls();

    widget.setResizeSnapSide(1, 'right');
    widget.setResizeSnapSide(1, null);

    expect(dividers[0].classList.contains(snapClass)).toBe(false);
    expect(dividers[1].classList.contains(snapClass)).toBe(false);
  });

  it('has no junction outside the row, and lights nothing there', () => {
    const { widget } = threeRow();
    const dividers = widget.getDividerEls();

    // A first member has no neighbour on its left: the drag must be told so,
    // since it reads that as "do not snap at all".
    expect(widget.setResizeSnapSide(0, 'left')).toBe(false);
    expect(dividers.some((d) => d.classList.contains(snapClass))).toBe(false);
  });

  it('offers no bar when dividers are switched off', () => {
    const { widget, el } = threeRow(false);
    expect(widget.getDividerEls()).toHaveLength(0);
    expect(el.querySelectorAll(`.${CLASSES.divider}`)).toHaveLength(0);

    expect(widget.setResizeSnapSide(1, 'right')).toBe(false);
  });
});

/**
 * The observer that puts a third party's inline height back on the img has to
 * stand down while a resize drag is running.  The drag re-derives that height
 * from the pointer on every mousemove, and on a turned member the value it
 * writes never matches the one the layout pass solved for — so the observer
 * restored the model's box after each move, the picture stayed put and only the
 * cell grew.  Pinned both ways: with the drag's marker on the row the write
 * survives, and without it the observer still does its job.
 */
describe('ImageRowWidget yields the img box to a running resize drag', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  /** A two-member row whose first member is a turned portrait. */
  function turnedRow(): { item: HTMLElement; img: HTMLImageElement } {
    const group = makeGroup([
      makeImage('a.png', 17, 1, false, { turns: 1, mirror: false }),
      makeImage('b.png', 18, 1),
    ]);
    const widget = new ImageRowWidget(group, makeOptions('left'));
    const el = widget.build();
    document.body.appendChild(el);
    patchBoundingRect(el, 944);
    simulateImagesLoaded(widget, el, [
      { w: 500, h: 654 },
      { w: 500, h: 654 },
    ]);
    const items = el.querySelectorAll(`.${CLASSES.imageItem}`);
    const imgs = el.querySelectorAll('img');
    return { item: items[0] as HTMLElement, img: imgs[0] as HTMLImageElement };
  }

  /** MutationObserver callbacks are delivered as microtasks; jsdom's land after
   *  a macrotask turn, so give the queue one. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('leaves the drag’s own height alone while the row carries the resizing marker', async () => {
    const { item, img } = turnedRow();
    item.classList.add(CLASSES.resizing);

    img.style.height = '300px';
    await settle();

    expect(img.style.height).toBe('300px');
  });

  it('restores the model box once no drag is running', async () => {
    const { img } = turnedRow();
    const model = img.style.height;
    expect(model).not.toBe('');

    img.style.height = '300px';
    await settle();

    expect(img.style.height).toBe(model);
  });
});
