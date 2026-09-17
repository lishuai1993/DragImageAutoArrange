/**
 * @vitest-environment jsdom
 *
 * Pins which of the single-image drag's two modes a resize takes.
 *
 * A drag grows the image's *layout box*.  Normal mode then re-fits the item to
 * what that box draws — which is what a turned row depends on, since its box
 * (131×176) and its drawing (176×131) differ and only the re-fit reconciles
 * them.  Zoom mode — object-fit: cover with the container's height locked to
 * the image — is reserved for a row that is *not* turned and has grown past the
 * height at which the picture fills the container's width.
 *
 * A turned row must never zoom: the swap already caps its width to the page, so
 * a taller box can no longer widen the picture.  With the branch inverted a
 * turned row takes zoom mode instead — the item and container grow while the
 * drawing stays put (the observer keeps restoring the box height), which reads
 * as "the container resized and the image did not".
 *
 * Each mode is pinned by the `object-position` it writes inline.  That value is
 * the whole point of the branch: the alignment pass owns the property inline and
 * with `!important`, so a stylesheet rule cannot re-anchor the crop — the zoom
 * branch has to claim it inline too, and the normal branch has to hand it back.
 */
import { describe, it, expect } from 'vitest';
import {
  ResizeHandleController,
  type ResizeHost,
} from '../src/interaction/resizeHandleController';

/** The 131×176 portrait the turned-row repro was found with. */
const NATURAL = { naturalWidth: 131, naturalHeight: 176 };
const CONTAINER_W = 1000;
/** Box height at which the image fills the container width: 1000 × 176/131. */
const FILL_WIDTH_H = Math.round((CONTAINER_W * NATURAL.naturalHeight) / NATURAL.naturalWidth);

/** Handles are built as [nw, ne, sw, se, n, s, w, e]. */
const SE_CORNER = 3;

interface Harness {
  host: ResizeHost;
  item: HTMLElement;
  img: HTMLImageElement;
  container: HTMLElement;
  calls: string[];
}

/** jsdom lays nothing out, so every rect the drag reads is handed to it. */
function rect(width: number, height: number) {
  return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON() {} };
}

/**
 * A one-image row.  Turned, the item hugs the drawing (176×131) while the img's
 * own box stays 131×176 — the asymmetry `layoutSingleImage` produces.
 */
function makeRow(turned: boolean): Harness {
  const container = createDiv();
  const item = createDiv();
  const img = createEl('img');
  item.appendChild(img);
  container.appendChild(item);

  const drawW = turned ? 176 : 131;
  const drawH = turned ? 131 : 176;
  item.setCssStyles({ height: `${drawH}px` });
  img.setCssStyles({ height: '176px' });

  container.getBoundingClientRect = () => rect(CONTAINER_W, 600);
  item.getBoundingClientRect = () => rect(drawW, drawH);

  const calls: string[] = [];
  const host: ResizeHost = {
    getContainer: () => container,
    getItemEls: () => [item],
    getImageEls: () => [img],
    getInterItemSpace: () => 0,
    getLoadedMeta: () => NATURAL,
    // The un-rotated box, as the real widget reports it.
    getImageContentRect: () => ({ left: 0, top: 0, width: 131, height: 176 }),
    // Left alignment is the setting the zoom-centring defect shows up with.
    getObjectPosition: () => 'left top',
    updateHandlePositions: () => undefined,
    isTurnedImage: () => turned,
    syncItemToDrawing: () => calls.push('syncItemToDrawing'),
    notifyLayoutChange: () => undefined,
    emitResizeEnd: () => undefined,
    setImageScale: () => undefined,
    setSingleImageWidth: (w) => calls.push(`setSingleImageWidth:${w}`),
  };
  return { host, item, img, container, calls };
}

/**
 * Press the south-east corner and move the pointer by (dx, dy), then release.
 * Both weights are 1 there, so the blended delta is (dx + dy) / 2.
 */
function dragSE(h: Harness, dx: number, dy: number): void {
  const { handles } = new ResizeHandleController(h.host).buildHandles(h.item, 0);
  handles[SE_CORNER].dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 100 }));
  document.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 + dx, clientY: 100 + dy }));
  document.dispatchEvent(new MouseEvent('mouseup'));
}

/** Which anchor the crop was left on, as written inline on the img. */
function cropAnchor(img: HTMLElement): { value: string; priority: string } {
  return {
    value: img.style.getPropertyValue('object-position'),
    priority: img.style.getPropertyPriority('object-position'),
  };
}

describe('single-image resize drag', () => {
  it('re-fits a turned row to its drawing rather than zooming', () => {
    const h = makeRow(true);
    // delta 20 → drawn height 151 → box height round(151 / (131/176)) = 203.
    dragSE(h, 0, 40);

    expect(h.img.style.height).toBe('203px');
    expect(h.img.style.objectFit).toBe('contain');
    expect(h.img.style.width).toBe('auto');
    expect(cropAnchor(h.img).value).toBe('left top');
    expect(h.container.style.height).toBe('');
    expect(h.calls).toContain('syncItemToDrawing');
  });

  it('never zooms a turned row, however far the handle is dragged', () => {
    const h = makeRow(true);
    dragSE(h, 0, 3000);

    // The box has passed the fill-width height and must still be contained.
    expect(Number.parseFloat(h.img.style.height)).toBeGreaterThan(FILL_WIDTH_H);
    expect(cropAnchor(h.img).value).toBe('left top');
    expect(h.img.style.objectFit).toBe('contain');
    expect(h.container.style.height).toBe('');
    expect(h.calls).toContain('syncItemToDrawing');
  });

  it('keeps a row below fill-width in normal mode', () => {
    const h = makeRow(false);
    dragSE(h, 0, 40);

    expect(Number.parseFloat(h.img.style.height)).toBeLessThan(FILL_WIDTH_H);
    expect(h.img.style.objectFit).toBe('contain');
    expect(cropAnchor(h.img).value).toBe('left top');
    expect(h.container.style.height).toBe('');
    expect(h.calls).toContain('syncItemToDrawing');
  });

  it('zooms a row that has grown past fill-width', () => {
    const h = makeRow(false);
    // delta 1500 → driven height 1676, past the 1344 fill-width height.
    dragSE(h, 0, 3000);

    expect(Number.parseFloat(h.img.style.height)).toBeGreaterThan(FILL_WIDTH_H);
    expect(h.img.style.objectFit).toBe('cover');
    // Overrides the alignment's own inline anchor, which is why it must carry
    // the same priority — a plain declaration would lose to it.
    expect(cropAnchor(h.img)).toEqual({ value: 'center', priority: 'important' });
    expect(h.item.style.height).toBe(h.img.style.height);
    expect(h.container.style.height).toBe(h.img.style.height);
    expect(h.calls).not.toContain('syncItemToDrawing');
  });

  it('writes the page width back after a drag, except when it zoomed', () => {
    const turned = makeRow(true);
    dragSE(turned, 0, 40);
    // The row hugged its drawing and never zoomed, so the width is persisted —
    // as the width the picture takes on the page, which for a turned row is the
    // box's height (176), not the box width the content rect also reports.
    expect(turned.calls).toContain('setSingleImageWidth:176');

    const zoomed = makeRow(false);
    dragSE(zoomed, 0, 3000);
    // Zoom is not representable as a capped width, so nothing is written.
    expect(zoomed.calls.some((c) => c.startsWith('setSingleImageWidth'))).toBe(false);
  });
});
