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
import { describe, it, expect, beforeEach, vi } from 'vitest';

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
    const itemC = elA.querySelectorAll('.drag-img-item')[2] as HTMLElement;
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
    const items = el.querySelectorAll('.drag-img-item');
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
    const items = el.querySelectorAll('.drag-img-item');
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
    expect(imgs[0].style.transform).toBe('rotate(270deg)');
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
    const item = el.querySelector('.drag-img-item') as HTMLElement;
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

  it('fit-scales the drawing to the page when the swap would overrun it', () => {
    // 700×1400 portrait rendered 700 wide: turned, 1400 would be drawn across a
    // 944 page, so one uniform factor brings the picture back to page width.
    const { item, img } = buildSingle({ turns: 1, mirror: false }, { w: 700, h: 1400 });
    const k = Number((944 / 1400).toFixed(4));
    expect(img.style.height).toBe('1400px');
    expect(img.style.transform).toBe(`scale(${k}) rotate(90deg)`);
    expect(Math.round(parseFloat(item.style.width))).toBe(944);
    expect(Math.round(parseFloat(item.style.height))).toBe(Math.round(700 * k));
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
