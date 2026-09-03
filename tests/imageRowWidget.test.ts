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

import { ImageRowWidget, ImageRowOptions, sanitizeOptions } from '../src/imageRender/imageRowWidget';
import { ImageGroup, ImageEmbed } from '../src/imageParse/imageDetector';
import { setPendingTransform, clearPendingTransform, listPendingTransforms } from '../src/imageTransform/transformStore';

// ── Test helpers ─────────────────────────────────────────────────────

function makeImage(fileName: string, line: number, flexGrow: number, hasExplicitWidth = false): ImageEmbed {
  return {
    line,
    raw: hasExplicitWidth ? `![[${fileName}|${Math.round(flexGrow * 100)}]]` : `![[${fileName}]]`,
    fileName,
    explicitWidth: hasExplicitWidth ? Math.round(flexGrow * 100) : null,
    hasExplicitWidth,
    flexGrow,
  };
}

function makeGroup(images: ImageEmbed[], lineStart = 17): ImageGroup {
  return {
    lineStart,
    lineEnd: lineStart + images.length,
    images,
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
    const img = imgs[i] as HTMLImageElement;
    Object.defineProperty(img, 'naturalWidth', { value: dims[i].w, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: dims[i].h, configurable: true });
    Object.defineProperty(img, 'complete', { value: true, configurable: true });
    if (img.onload) (img.onload as any)(new Event('load'));
  }
}

// jsdom lacks ResizeObserver — polyfill so build() doesn't throw
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = MockResizeObserver;

// jsdom lacks getBoundingClientRect that reflects layout — patch to
// return a plausible container width so applyLayout doesn't retry via RAF.
function patchBoundingRect(container: HTMLElement, width = 800): void {
  const origGetBoundingClientRect = container.getBoundingClientRect.bind(container);
  container.getBoundingClientRect = () => {
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 200, width, height: 200, toJSON() {} } as DOMRect;
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
    } as unknown as ImageRowOptions;
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
      expect((imgs[i] as HTMLImageElement).style.objectPosition).toBe('right top');
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
    (imgsA[2] as HTMLImageElement).style.height = '361px';
    const itemC = elA.querySelectorAll('.drag-img-item')[2] as HTMLElement;
    itemC.style.height = '361px';
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
      const op = (imgsB[i] as HTMLImageElement).style.objectPosition;
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

describe('ImageRowWidget re-applies pending orientation preview across rebuild', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    for (const entry of listPendingTransforms()) clearPendingTransform(entry.imagePath);
    document.body.innerHTML = '';
  });

  function makeOptsWithResolver(): ImageRowOptions {
    return {
      ...makeOptions('left'),
      getImageVaultPath: (fileName: string) =>
        fileName === 'a.png' || fileName === 'b.png' ? `assets/${fileName}` : null,
    };
  }

  function buildLoaded(
    files: Array<{ name: string; line: number; grow: number }>,
    dims: Array<{ w: number; h: number }>,
    opts: ImageRowOptions,
    lineStart = 17,
  ): { el: HTMLElement; widget: ImageRowWidget } {
    const group = makeGroup(files.map((f) => makeImage(f.name, f.line, f.grow)), lineStart);
    const widget = new ImageRowWidget(group, opts);
    const el = widget.build();
    document.body.appendChild(el);
    patchBoundingRect(el, 944);
    simulateImagesLoaded(widget, el, dims);
    return { el, widget };
  }

  it('replays a pending quarter-turn onto a rebuilt single-image row', () => {
    setPendingTransform('assets/a.png', 'notes/note.md', { turns: 1, mirror: false });
    const { el } = buildLoaded(
      [{ name: 'a.png', line: 5, grow: 1 }],
      [{ w: 500, h: 654 }],
      makeOptsWithResolver()
    );
    const img = el.querySelector('img') as HTMLImageElement;
    expect(img.style.transform).toBe('rotate(90deg)');
  });

  it('replays pending orientations onto every rebuilt multi-image member', () => {
    setPendingTransform('assets/a.png', 'notes/note.md', { turns: 3, mirror: false });
    setPendingTransform('assets/b.png', 'notes/note.md', { mirror: true, turns: 0 });
    const { el } = buildLoaded(
      [
        { name: 'a.png', line: 17, grow: 1 },
        { name: 'b.png', line: 18, grow: 4 },
      ],
      [
        { w: 500, h: 654 },
        { w: 800, h: 1200 },
      ],
      makeOptsWithResolver()
    );
    const imgs = el.querySelectorAll('img');
    expect(imgs.length).toBe(2);
    expect((imgs[0] as HTMLImageElement).style.transform).toBe('rotate(270deg)');
    expect((imgs[1] as HTMLImageElement).style.transform).toBe('scaleX(-1)');
  });

  it('leaves rebuilt images untransformed once the pending state is cleared', () => {
    setPendingTransform('assets/a.png', 'notes/note.md', { turns: 1, mirror: false });
    // Simulate the note-departure flush clearing the store, then a fresh rebuild.
    for (const entry of listPendingTransforms()) clearPendingTransform(entry.imagePath);
    const { el } = buildLoaded(
      [{ name: 'a.png', line: 5, grow: 1 }],
      [{ w: 500, h: 654 }],
      makeOptsWithResolver(),
      18
    );
    const img = el.querySelector('img') as HTMLImageElement;
    expect(img.style.transform).toBe('');
  });
});
