/**
 * @vitest-environment jsdom
 *
 * Tests for the quarter-turn preview transform and the container size that
 * follows from it.
 *
 * A quarter turn swaps the drawn width and height.  A container that hugs the
 * picture takes the swapped size (`displayedImageSize`), fit-scaling the whole
 * picture only when that width would overrun the page and carrying the factor
 * into the transform; a container with a fixed box falls back to the measured
 * letterbox scale, which brings the drawing back inside the box.  Mirrors and
 * half turns leave the bounding box alone and must stay unscaled.
 */
import { describe, it, expect } from 'vitest';
import { applyOrientationPreview, displayedImageSize } from '../src/imageTransform/transformPreview';
import type { OrientationState } from '../src/imageTransform/orientation';

/** jsdom lays nothing out, so the sizes the helper reads are written directly. */
function fakeImg(box: { w: number; h: number }, natural: { w: number; h: number }): HTMLImageElement {
  const img = createEl('img');
  const define = (prop: string, value: number) =>
    Object.defineProperty(img, prop, { value, configurable: true });
  define('clientWidth', box.w);
  define('clientHeight', box.h);
  define('naturalWidth', natural.w);
  define('naturalHeight', natural.h);
  return img;
}

const state = (turns: OrientationState['turns'], mirror = false): OrientationState => ({ turns, mirror });

/** 400×523 box holding a 400×523 image: turned, the content measures 523×400
 *  and the box only affords 400 across, so it is scaled by 400/523. */
const PORTRAIT = () => fakeImg({ w: 400, h: 523 }, { w: 400, h: 523 });

describe('applyOrientationPreview', () => {
  it('clears the transform for the identity', () => {
    const img = PORTRAIT();
    img.setCssStyles({ transform: 'rotate(90deg)' });
    applyOrientationPreview(img, state(0));
    expect(img.style.transform).toBe('');
  });

  it('prefixes the fit scale onto a quarter turn', () => {
    const img = PORTRAIT();
    applyOrientationPreview(img, state(1));
    expect(img.style.transform).toBe('scale(0.7648) rotate(90deg)');
  });

  it('scales a mirrored quarter turn too', () => {
    const img = PORTRAIT();
    applyOrientationPreview(img, state(3, true));
    expect(img.style.transform).toBe('scale(0.7648) scaleX(-1) rotate(270deg)');
  });

  it('leaves a half turn and a mirror unscaled — neither grows the box', () => {
    const img = PORTRAIT();
    applyOrientationPreview(img, state(2));
    expect(img.style.transform).toBe('rotate(180deg)');
    applyOrientationPreview(img, state(0, true));
    expect(img.style.transform).toBe('scaleX(-1)');
  });

  it('drops the scale when the turned content already fits', () => {
    // Tall image in a wide short box: contained content is 160×200, which turns
    // into 200×160 and fits inside 800×200 — never scaled up.
    const img = fakeImg({ w: 800, h: 200 }, { w: 800, h: 1000 });
    applyOrientationPreview(img, state(1));
    expect(img.style.transform).toBe('rotate(90deg)');
  });

  it('leaves a landscape box turning a landscape image at the same factor', () => {
    const img = fakeImg({ w: 523, h: 400 }, { w: 523, h: 400 });
    applyOrientationPreview(img, state(1));
    expect(img.style.transform).toBe('scale(0.7648) rotate(90deg)');
  });

  it('asks for no scale when the box cannot be measured', () => {
    const img = fakeImg({ w: 0, h: 0 }, { w: 400, h: 523 });
    applyOrientationPreview(img, state(1));
    expect(img.style.transform).toBe('rotate(90deg)');
  });

  it('uses an explicit scale verbatim, even one that asks for no shrink', () => {
    const img = PORTRAIT();
    applyOrientationPreview(img, state(1), { scale: 0.5 });
    expect(img.style.transform).toBe('scale(0.5) rotate(90deg)');
    // A container sized by the drawing hands over its own scale — a turned row
    // must not fall back to the measured letterbox when that scale is 1.
    applyOrientationPreview(img, state(1), { scale: 1 });
    expect(img.style.transform).toBe('rotate(90deg)');
  });
});

describe('displayedImageSize', () => {
  it('answers with the box itself when nothing is turned', () => {
    expect(displayedImageSize(400, 306, state(0))).toEqual({ width: 400, height: 306, scale: 1 });
    expect(displayedImageSize(400, 523, state(0, true))).toEqual({ width: 400, height: 523, scale: 1 });
  });

  it('swaps width and height on a quarter turn, keeping the pixel scale', () => {
    expect(displayedImageSize(400, 523, state(1))).toEqual({ width: 523, height: 400, scale: 1 });
    expect(displayedImageSize(131, 176, state(3))).toEqual({ width: 176, height: 131, scale: 1 });
  });

  it('fit-scales the whole picture when the swapped width overruns the page', () => {
    // 700×1050 box turned puts 1050 across a 944 page: one uniform factor
    // brings the picture back to page width, shrinking its height too.
    const shown = displayedImageSize(700, 1050, state(1), 944);
    // The factor is rounded to the four decimals the transform carries, so the
    // width lands a hair under the cap rather than exactly on it.
    expect(shown.scale).toBeCloseTo(944 / 1050, 4);
    expect(Math.round(shown.width)).toBe(944);
    expect(shown.width).toBeLessThanOrEqual(944);
    expect(shown.height).toBeCloseTo(700 * shown.scale, 3);
  });

  it('leaves the picture alone when the page affords its width', () => {
    expect(displayedImageSize(700, 1050, state(1), 1200)).toEqual({ width: 1050, height: 700, scale: 1 });
  });

  it('never lets the drawn width exceed the page cap it is given', () => {
    for (const turns of [0, 1, 2, 3] as const) {
      expect(displayedImageSize(700, 1050, state(turns), 944).width).toBeLessThanOrEqual(944 + 0.5);
    }
  });

  it('answers with the box when there is nothing to measure', () => {
    expect(displayedImageSize(0, 0, state(1), 944)).toEqual({ width: 0, height: 0, scale: 1 });
  });
});
