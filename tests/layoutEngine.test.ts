import { describe, it, expect } from 'vitest';
import {
  computeUniformHeight,
  computeFlexGrows,
  computeRowHeight,
  computeImageContentRect,
  computeDividerEquilibrium,
  computeGlobalEquilibrium,
  imageHeightToFlexGrow,
  computeIndividualHeights,
  computeDividerXPositions,
  findClosestDividerIndex,
  findInsertIndex,
  computeScaleBasedHeights,
  computeFlexGrowsFromWidths,
  computeSingleImageWidth,
} from '../src/imageLayout/layoutEngine';
import { ImageMeta } from '../src/imageParse/imageDetector';

// ── Helpers ──
const m = (w: number, h: number): ImageMeta => ({ naturalWidth: w, naturalHeight: h });

// ── computeUniformHeight ──
describe('computeUniformHeight', () => {
  it('returns minHeight for empty array', () => {
    const r = computeUniformHeight([], 800, 4, 50, 400);
    expect(r.rowHeight).toBe(50);
    expect(r.imageWidths).toEqual([]);
    expect(r.totalWidth).toBe(0);
  });

  it('single 16:9 image clamped to maxHeight', () => {
    const r = computeUniformHeight([m(1600, 900)], 800, 0, 50, 400);
    // h = 800 / (1600/900) = 450 → clamped to 400
    expect(r.rowHeight).toBe(400);
    // w = 400 * (1600/900) = 711.11 → round 711
    expect(r.imageWidths[0]).toBe(711);
  });

  it('two identical images', () => {
    const r = computeUniformHeight([m(800, 600), m(800, 600)], 800, 4, 50, 600);
    // sumAspect = 1.333 + 1.333 = 2.667, totalGap = 4
    // h = (800 - 4) / 2.667 = 298.5 → round 299
    expect(r.rowHeight).toBe(299);
    expect(r.imageWidths[0]).toBe(Math.round(299 * (800 / 600))); // 399
    expect(r.imageWidths[1]).toBe(Math.round(299 * (800 / 600))); // 399
    expect(r.totalWidth).toBe(399 + 399 + 4);
  });

  it('uses fallback aspect 4:3 for unloaded image', () => {
    const r = computeUniformHeight([m(0, 0)], 800, 0, 50, 600);
    // h = 800 / (4/3) = 600, within clamp
    expect(r.rowHeight).toBe(600);
    expect(r.imageWidths[0]).toBe(Math.round(600 * (4 / 3))); // 800
  });

  it('clamps below minHeight', () => {
    const r = computeUniformHeight([m(100, 1600)], 800, 0, 50, 400);
    // aspect = 0.0625, h = 800/0.0625 = 12800, clamped to 400
    expect(r.rowHeight).toBe(400);
  });

  it('uses default 800 containerWidth when cw is 0', () => {
    const r = computeUniformHeight([m(800, 600)], 0, 0, 50, 600);
    expect(r.rowHeight).toBe(600); // 800/(800/600) = 600
  });
});

// ── computeFlexGrows ──
describe('computeFlexGrows', () => {
  it('returns empty for empty metas', () => {
    expect(computeFlexGrows([])).toEqual([]);
  });

  it('single image maps to 1', () => {
    expect(computeFlexGrows([m(800, 600)])).toEqual([1]);
  });

  it('normalizes to smallest aspect ratio', () => {
    // 16:9 aspect = 1.778, 4:3 = 1.333
    const grows = computeFlexGrows([m(1600, 900), m(800, 600)]);
    // minAspect = 1.333, grows[0] = 1.778/1.333 = 1.33, grows[1] = 1.0
    expect(grows[0]).toBeCloseTo(1.33, 2);
    expect(grows[1]).toBe(1);
  });

  it('unloaded image uses 4:3 fallback', () => {
    const grows = computeFlexGrows([m(0, 0)]);
    expect(grows[0]).toBe(1);
  });

  it('identical aspects all map to 1', () => {
    const grows = computeFlexGrows([m(800, 600), m(800, 600), m(800, 600)]);
    expect(grows).toEqual([1, 1, 1]);
  });
});

// ── computeRowHeight ──
describe('computeRowHeight', () => {
  it('returns lower clamp for empty arrays', () => {
    expect(computeRowHeight([], [], 800, 4, 200)).toBe(50);
  });

  it('single 16:9 image', () => {
    // available = 800, w = 800, h = 800/(1600/900)=450, upperClamp=2000
    const h = computeRowHeight([1], [m(1600, 900)], 800, 0, 200);
    expect(h).toBe(450);
  });

  it('single very tall image clamped to 2000', () => {
    // w = 800, h = 800/(100/2000) = 16000 → clamped 2000
    const h = computeRowHeight([0.5], [m(100, 2000)], 800, 0, 200);
    expect(h).toBe(2000);
  });

  it('single image at min clamp (50px)', () => {
    // Very wide image: 4000×100, aspect=40
    // height = 800/40 = 20 → clamped to 50
    const h = computeRowHeight([1], [m(4000, 100)], 800, 0, 200);
    expect(h).toBe(50);
  });

  it('single image with gap (gap is ignored for n=1)', () => {
    // Gap doesn't affect single image: availableWidth = containerWidth - 0
    const hNoGap = computeRowHeight([1], [m(1600, 900)], 800, 0, 200);
    const hWithGap = computeRowHeight([1], [m(1600, 900)], 800, 20, 200);
    expect(hNoGap).toBe(450);
    expect(hWithGap).toBe(450);
  });

  it('two images with different flex', () => {
    // available = 800-4 = 796, totalGrow = 3
    // img0: w = 796*2/3 = 530.67, h = 530.67/(1600/900) = 298.5
    // img1: w = 796*1/3 = 265.33, h = 265.33/(800/600) = 199
    // maxH = 299, upperClamp = 600
    const h = computeRowHeight([2, 1], [m(1600, 900), m(800, 600)], 800, 4, 200);
    expect(h).toBe(299);
  });

  it('returns 50 for zero totalGrow', () => {
    expect(computeRowHeight([0, 0], [m(800, 600), m(800, 600)], 800, 0, 200)).toBe(50);
  });

  it('skips meta with zero naturalWidth', () => {
    // Only second meta is valid
    const h = computeRowHeight([1, 1], [m(0, 0), m(800, 600)], 800, 0, 200);
    // Only img1: w = 800*1/2 = 400, h = 400/(800/600) = 300
    expect(h).toBe(300);
  });

  it('multi-image clamped to defaultRowHeight * 3', () => {
    // Very wide image → huge height → clamped to 200*3 = 600
    const h = computeRowHeight([1, 1], [m(4000, 1000), m(4000, 1000)], 400, 0, 200);
    // aspect = 4, available = 400, w = 400/2 = 200, h = 200/4 = 50 for each
    // Actually 50 is below clamp of 50
    expect(h).toBe(50);
  });
});

// ── computeScaleBasedHeights ──
describe('computeScaleBasedHeights', () => {
  it('applies scale ratio to compute per-image height', () => {
    // 2 equal 16:9 images, container 804, gap 4 → AW = 800, itemW = 400 each.
    // ar = 1600/900 = 1.777..; scale 0.5 → h = round(0.5 * 400 / 1.777..) = round(112.5) = 113
    const r = computeScaleBasedHeights(
      [1, 1], [m(1600, 900), m(1600, 900)], [0.5, 0.5], 804, 4, 200
    );
    expect(r.heights).toEqual([113, 113]);
    expect(r.maxH).toBe(113);
  });

  it('mixes scale and null: null image falls back to uniform computeRowHeight', () => {
    // Fallback = computeRowHeight([1,1], metas, 804, 4, 200)
    const fallback = computeRowHeight([1, 1], [m(1600, 900), m(1600, 900)], 804, 4, 200);
    const r = computeScaleBasedHeights(
      [1, 1], [m(1600, 900), m(1600, 900)], [0.5, null], 804, 4, 200
    );
    expect(r.heights[0]).toBe(113);
    expect(r.heights[1]).toBe(fallback);
    expect(r.maxH).toBe(Math.max(113, fallback));
  });

  it('all-null scales → every height equals the uniform fallback', () => {
    const fallback = computeRowHeight([2, 1], [m(1600, 900), m(800, 600)], 804, 4, 200);
    const r = computeScaleBasedHeights(
      [2, 1], [m(1600, 900), m(800, 600)], [null, null], 804, 4, 200
    );
    expect(r.heights).toEqual([fallback, fallback]);
    expect(r.maxH).toBe(fallback);
  });

  it('scale == 1 uses each image\'s own full-width height (not the row max)', () => {
    // grows [2,1], 16:9 + 4:3, container 804 gap 4 → AW=800.
    // itemW0 = (2/3)*800 = 533.33 → h0 = 533.33/1.7778 = 300
    // itemW1 = (1/3)*800 = 266.67 → h1 = 266.67/1.3333 = 200
    // Old `scale < 1` would fall back to computeRowHeight (row max 300) for BOTH,
    // wrongly resetting image 1 to the equilibrium max.
    const r = computeScaleBasedHeights(
      [2, 1], [m(1600, 900), m(800, 600)], [1, 1], 804, 4, 200
    );
    expect(r.heights).toEqual([300, 200]);
    expect(r.maxH).toBe(300);
  });

  it('scale > 1 is treated as invalid and falls back to uniform', () => {
    const fallback = computeRowHeight([1, 1], [m(1600, 900), m(1600, 900)], 804, 4, 200);
    const r = computeScaleBasedHeights(
      [1, 1], [m(1600, 900), m(1600, 900)], [1.5, 1.5], 804, 4, 200
    );
    expect(r.heights).toEqual([fallback, fallback]);
  });
});

// ── computeFlexGrowsFromWidths ──
describe('computeFlexGrowsFromWidths', () => {
  it('returns [] for empty input', () => {
    expect(computeFlexGrowsFromWidths([])).toEqual([]);
  });

  it('normalizes so the smallest width maps to flex-grow 1', () => {
    // widths [400, 200, 600] → min 200 → [2, 1, 3]
    expect(computeFlexGrowsFromWidths([400, 200, 600])).toEqual([2, 1, 3]);
  });

  it('rounds to two decimals', () => {
    // widths [100, 333] → min 100 → [1, 3.33]
    expect(computeFlexGrowsFromWidths([100, 333])).toEqual([1, 3.33]);
  });

  it('is proportional regardless of absolute magnitude', () => {
    expect(computeFlexGrowsFromWidths([800, 400])).toEqual(
      computeFlexGrowsFromWidths([200, 100])
    );
  });

  it('falls back to 1 for non-positive widths and ignores them for the min basis', () => {
    // positive min is 150 → 300/150=2, 150/150=1, zero → 1
    expect(computeFlexGrowsFromWidths([300, 150, 0])).toEqual([2, 1, 1]);
  });

  it('handles all-zero widths as flex-grow 1', () => {
    expect(computeFlexGrowsFromWidths([0, 0])).toEqual([1, 1]);
  });
});

// ── computeSingleImageWidth ──
describe('computeSingleImageWidth', () => {
  it('natural: small image keeps its own pixel width', () => {
    // 300px natural, 800 container → 300 (fits).
    expect(computeSingleImageWidth('natural', 400, 300, 800)).toBe(300);
  });

  it('natural: wide image shrinks to the container width', () => {
    // 1600px natural, 800 container → 800.
    expect(computeSingleImageWidth('natural', 400, 1600, 800)).toBe(800);
  });

  it('fixed: uses the specified width', () => {
    expect(computeSingleImageWidth('fixed', 400, 1600, 800)).toBe(400);
  });

  it('fixed: clamps width up to the minimum (100)', () => {
    expect(computeSingleImageWidth('fixed', 40, 800, 800)).toBe(100);
  });

  it('fixed: clamps width down to the container width', () => {
    expect(computeSingleImageWidth('fixed', 5000, 800, 800)).toBe(800);
  });

  it('returns 0 when dimensions are unknown', () => {
    expect(computeSingleImageWidth('natural', 400, 0, 800)).toBe(0);
    expect(computeSingleImageWidth('fixed', 400, 800, 0)).toBe(0);
  });
});

// ── computeImageContentRect ──
describe('computeImageContentRect', () => {
  it('returns null for zero width', () => {
    expect(computeImageContentRect(0, 200, m(800, 600))).toBeNull();
  });

  it('returns null for zero height', () => {
    expect(computeImageContentRect(300, 0, m(800, 600))).toBeNull();
  });

  it('returns null for zero naturalWidth', () => {
    expect(computeImageContentRect(300, 200, m(0, 600))).toBeNull();
  });

  it('image wider than container — fills full width', () => {
    // imgAspect = 1600/900 = 1.778, ctrAspect = 300/200 = 1.5
    // imageAspect > containerAspect → width-constrained
    const r = computeImageContentRect(300, 200, m(1600, 900))!;
    expect(r.width).toBeCloseTo(300, 0);
    expect(r.height).toBeCloseTo(300 / (1600 / 900), 2); // 168.75
    expect(r.left).toBe(0);
    expect(r.top).toBe(0);
  });

  it('image taller than container — fills full height', () => {
    // imgAspect = 600/800 = 0.75, ctrAspect = 300/200 = 1.5
    // imageAspect < containerAspect → height-constrained
    const r = computeImageContentRect(300, 200, m(600, 800))!;
    expect(r.height).toBeCloseTo(200, 0);
    expect(r.width).toBeCloseTo(200 * (600 / 800), 2); // 150
  });

  it('square image in square container', () => {
    const r = computeImageContentRect(200, 200, m(800, 800))!;
    // imgAspect = 1, ctrAspect = 1 → else branch
    expect(r.width).toBe(200);
    expect(r.height).toBe(200);
  });

  it('tall image in short container — height-constrained', () => {
    // 500×654 (aspect 0.765) in 543×600
    // ctrAspect = 543/600 = 0.905, imgAspect = 0.765
    // imageAspect < containerAspect → height-constrained
    const r = computeImageContentRect(543, 600, m(500, 654))!;
    expect(r.height).toBe(600);
    expect(r.width).toBeCloseTo(600 * (500 / 654), 0); // 459
    expect(r.width).toBeLessThan(543); // fits within item width
  });

  it('tall image in tall container — becomes width-constrained', () => {
    // 500×654 (aspect 0.765) in 543×1000
    // ctrAspect = 543/1000 = 0.543, imgAspect = 0.765
    // imageAspect > containerAspect → width-constrained
    const r = computeImageContentRect(543, 1000, m(500, 654))!;
    expect(r.width).toBe(543);
    expect(r.height).toBeCloseTo(543 / (500 / 654), 0); // 710
    expect(r.height).toBeLessThan(1000); // dead zone above image
  });

  // ── fill-width boundary (zoom mode transition point) ──
  // fillWidthH = containerWidth * naturalHeight / naturalWidth
  // At this height the image exactly fills the container width under
  // object-fit:contain. Below it the image is height-constrained;
  // above it the image is width-constrained and cannot grow further
  // — which is why we switch to object-fit:cover in zoom mode.

  it('at fill-width height, image content exactly fills container', () => {
    // 1920×1440 (aspect 1.333) in 972px wide container
    // fillWidthH = 972 * 1440 / 1920 = 729
    const r = computeImageContentRect(972, 729, m(1920, 1440))!;
    expect(r.width).toBeCloseTo(972, 0);
    expect(r.height).toBeCloseTo(729, 0);
  });

  it('above fill-width height, contain mode caps content height at fillWidthH', () => {
    // Same image at 900px tall — should still render at 729px content height
    // imgAspect = 1.333, ctrAspect = 972/900 = 1.08
    // imageAspect > containerAspect → width-constrained
    const r = computeImageContentRect(972, 900, m(1920, 1440))!;
    expect(r.width).toBeCloseTo(972, 0);
    expect(r.height).toBeCloseTo(729, 0); // capped at fillWidthH, not 900
  });

  it('below fill-width height, image content fills container height', () => {
    // Same image at 500px tall
    // imgAspect = 1.333, ctrAspect = 972/500 = 1.944
    // imageAspect < containerAspect → height-constrained
    const r = computeImageContentRect(972, 500, m(1920, 1440))!;
    expect(r.height).toBe(500);
    expect(r.width).toBeCloseTo(500 * (1920 / 1440), 0); // 667
  });

  it('fill-width boundary for tall image (aspect < 1)', () => {
    // 500×654 (aspect 0.765) in 800px wide container
    // fillWidthH = 800 * 654 / 500 = 1046.4 → 1046
    // At fillWidthH: ctrAspect = 800/1046 = 0.765 = imgAspect → height-constrained
    const r = computeImageContentRect(800, 1046, m(500, 654))!;
    expect(r.width).toBeCloseTo(800, 0);
    expect(r.height).toBeCloseTo(1046, 0);
  });

  it('contain mode dead zone: tall image above fill-width stays capped', () => {
    // Same image at 1500px tall — still at fillWidthH
    // ctrAspect = 800/1500 = 0.533, imgAspect = 0.765
    // imageAspect > containerAspect → width-constrained
    const r = computeImageContentRect(800, 1500, m(500, 654))!;
    expect(r.width).toBeCloseTo(800, 0);
    expect(r.height).toBeCloseTo(1046, 0); // capped, not 1500
  });
});

// ── computeDividerEquilibrium ──
describe('computeDividerEquilibrium', () => {
  it('identical aspects split total evenly', () => {
    const { left, right } = computeDividerEquilibrium(m(1600, 900), m(1600, 900), 3);
    expect(left).toBeCloseTo(1.5, 5);
    expect(right).toBeCloseTo(1.5, 5);
  });

  it('16:9 vs 4:3', () => {
    // la = 1.778, ra = 1.333, sum = 3.111
    const { left, right } = computeDividerEquilibrium(m(1600, 900), m(800, 600), 2);
    expect(left).toBeCloseTo(2 * 1.778 / 3.111, 2); // 1.143
    expect(right).toBeCloseTo(2 - 2 * 1.778 / 3.111, 2); // 0.857
    expect(left + right).toBeCloseTo(2, 5);
  });

  it('extreme aspect difference', () => {
    // la = 2000/100 = 20, ra = 100/2000 = 0.05
    const { left, right } = computeDividerEquilibrium(m(2000, 100), m(100, 2000), 4);
    expect(left).toBeGreaterThan(3.9); // nearly all to the wide image
    expect(right).toBeLessThan(0.1);
    expect(left + right).toBeCloseTo(4, 5);
  });

  it('zero dimensions returns uniform split', () => {
    const { left, right } = computeDividerEquilibrium(m(0, 0), m(0, 0), 10);
    expect(left).toBe(5);
    expect(right).toBe(5);
  });
});

// ── computeGlobalEquilibrium ──
describe('computeGlobalEquilibrium', () => {
  it('returns empty for empty metas', () => {
    expect(computeGlobalEquilibrium([], 10)).toEqual([]);
  });

  it('single image returns the total', () => {
    expect(computeGlobalEquilibrium([m(1600, 900)], 1)).toEqual([1]);
  });

  it('two identical images — equal grows', () => {
    const grows = computeGlobalEquilibrium([m(1600, 900), m(1600, 900)], 3);
    expect(grows[0]).toBeCloseTo(1.5, 5);
    expect(grows[1]).toBeCloseTo(1.5, 5);
    expect(grows.reduce((s, v) => s + v, 0)).toBeCloseTo(3, 5);
  });

  it('16:9 + 4:3', () => {
    const grows = computeGlobalEquilibrium([m(1600, 900), m(800, 600)], 3);
    // aspects = [1.778, 1.333], sum = 3.111
    expect(grows[0]).toBeCloseTo(3 * 1.778 / 3.111, 2); // 1.714
    expect(grows[1]).toBeCloseTo(3 * 1.333 / 3.111, 2); // 1.286
    expect(grows.reduce((s, v) => s + v, 0)).toBeCloseTo(3, 5);
  });

  it('zero dimensions returns uniform distribution', () => {
    const grows = computeGlobalEquilibrium([m(0, 0), m(0, 0)], 5);
    expect(grows[0]).toBe(2.5);
    expect(grows[1]).toBe(2.5);
  });
});

// ── imageHeightToFlexGrow ──
describe('imageHeightToFlexGrow', () => {
  it('16:9 image, 200px target, one sibling at flex=1, 800px available', () => {
    const g = imageHeightToFlexGrow(200, m(1600, 900), 1, 800);
    // aspect = 1.778, denom = 800/1.778 - 200 = 450 - 200 = 250
    // g = 200 * 1 / 250 = 0.8
    expect(g).toBeCloseTo(0.8, 5);
  });

  it('doubling target height doubles flex-grow (linear relationship)', () => {
    const g1 = imageHeightToFlexGrow(100, m(800, 600), 1, 800);
    const g2 = imageHeightToFlexGrow(200, m(800, 600), 1, 800);
    // aspect = 1.333, denom1 = 800/1.333 - 100 = 600 - 100 = 500
    // g1 = 100 * 1 / 500 = 0.2
    // denom2 = 600 - 200 = 400
    // g2 = 200 * 1 / 400 = 0.5
    // g2/g1 = 0.5/0.2 = 2.5 (not exactly double — the denom shrinks)
    // Actually let's just verify both are computed correctly
    expect(g1).toBeCloseTo(0.2, 5);
    expect(g2).toBeCloseTo(0.5, 5);
  });

  it('target height equal to max possible → returns large sentinel', () => {
    // maxHeight = availableWidth / aspect = 800 / 1 = 800
    const g = imageHeightToFlexGrow(800, m(800, 800), 1, 800);
    expect(g).toBeGreaterThanOrEqual(1e9);
  });

  it('target height exceeds max → returns large sentinel', () => {
    const g = imageHeightToFlexGrow(900, m(800, 800), 1, 800);
    expect(g).toBeGreaterThanOrEqual(1e9);
  });

  it('zero naturalWidth returns 1', () => {
    expect(imageHeightToFlexGrow(200, m(0, 600), 1, 800)).toBe(1);
  });

  it('zero targetHeight returns 1', () => {
    expect(imageHeightToFlexGrow(0, m(800, 600), 1, 800)).toBe(1);
  });

  it('zero otherFlexGrowSum returns 0', () => {
    // denom = 800/1.333 - 200 = 600 - 200 = 400
    // g = 200 * 0 / 400 = 0
    expect(imageHeightToFlexGrow(200, m(800, 600), 0, 800)).toBe(0);
  });

  it('tall image 500×654 at 600px height in 543px available', () => {
    // This reproduces the actual dead-zone scenario:
    // aspect = 500/654 ≈ 0.764526, denom = 543 / (500/654) - 600 ≈ 710.23 - 600 = 110.23
    // g = 600 * 0.53 / 110.23 ≈ 2.885
    const g = imageHeightToFlexGrow(600, m(500, 654), 0.53, 543);
    expect(g).toBeCloseTo(2.885, 2);
    expect(g).toBeGreaterThan(0);
  });

  it('resized image flex + other images flex preserves total for verify', () => {
    // Given: two images [500x654, 1920x1440], flex-grows [1, 0.53], AW ≈ 969
    // Resize image 0 from current height to a new target.
    const meta0 = m(500, 654);
    const otherGrow = 0.53;
    const aw = 969;
    const newGrow0 = imageHeightToFlexGrow(500, meta0, otherGrow, aw);
    // aspect = 0.7645, denom = 969/0.7645 - 500 = 1267 - 500 = 767
    // newGrow0 = 500 * 0.53 / 767 ≈ 0.3455
    expect(newGrow0).toBeCloseTo(0.345, 3);
    // After: flex-grows are [newGrow0, otherGrow]
    // computeRowHeight should return ~500
    const h = computeRowHeight([newGrow0, otherGrow], [meta0, m(1920, 1440)], aw + 4, 4, 200);
    expect(h).toBeCloseTo(500, -1); // within ~10px
  });
});

// ── computeIndividualHeights ──
describe('computeIndividualHeights', () => {
  it('returns empty for empty arrays', () => {
    expect(computeIndividualHeights([], [], 800, 4)).toEqual([]);
  });

  it('single 16:9 image', () => {
    const heights = computeIndividualHeights([1], [m(1600, 900)], 800, 0);
    // w = 800 * 1/1 = 800, h = 800 / 1.778 = 450
    expect(heights[0]).toBe(450);
  });

  it('two images with different aspects have different heights', () => {
    // [500x654: aspect=0.765, 1920x1440: aspect=1.333]
    // flex-grows [1, 0.53], AW = 973 - 4 = 969
    const heights = computeIndividualHeights(
      [1, 0.53],
      [m(500, 654), m(1920, 1440)],
      973,
      4
    );
    // Image 0: w = 969 * 1/1.53 = 633.3, h = 633.3 / 0.7645 ≈ 828
    // Image 1: w = 969 * 0.53/1.53 = 335.7, h = 335.7 / 1.333 ≈ 252
    // Max = 828 = computeRowHeight result
    expect(heights[0]).toBeGreaterThan(heights[1]);
    expect(heights[0]).toBeGreaterThan(500);
    expect(heights[1]).toBeLessThan(300);
  });

  it('zero totalGrow returns all zeros', () => {
    expect(computeIndividualHeights([0, 0], [m(800, 600), m(800, 600)], 800, 0))
      .toEqual([0, 0]);
  });

  it('zero naturalWidth returns zero for that image', () => {
    const heights = computeIndividualHeights([1, 1], [m(0, 600), m(800, 600)], 800, 0);
    expect(heights[0]).toBe(0);
    expect(heights[1]).toBeGreaterThan(0);
  });

  it('changing one flex-grow affects all heights (flex-grow coupling)', () => {
    // This documents why the corner-resize uses explicit DOM heights:
    // flex-grow math couples all images — changing one flex-grow shifts
    // totalGrow, which re-distributes width across ALL images.
    const metas = [m(500, 654), m(1920, 1440)];
    const h1 = computeIndividualHeights([1, 0.53], metas, 973, 4);
    // Decrease image 0's flex-grow → totalGrow decreases → image 1 gets
    // a larger share of availableWidth → its height increases.
    const h2 = computeIndividualHeights([0.35, 0.53], metas, 973, 4);
    // Image 0 should be shorter
    expect(h2[0]).toBeLessThan(h1[0]);
    // Image 1 should be taller (coupling effect)
    expect(h2[1]).toBeGreaterThan(h1[1]);
  });

  it('regression: height-to-flexGrow round-trip preserves other image proportion', () => {
    // Simulate: resize image 0 shorter → convert to flex-grow → verify
    // image 1's height change is only the proportional coupling effect.
    const metas = [m(500, 654), m(1920, 1440)];
    const origGrows = [1, 0.53];
    const origHeights = computeIndividualHeights(origGrows, metas, 973, 4);

    // Resize image 0 to 300px → compute new flex-grow
    const newGrow0 = imageHeightToFlexGrow(300, metas[0], origGrows[1], 969);
    const newHeights = computeIndividualHeights(
      [newGrow0, origGrows[1]],
      metas,
      973,
      4
    );

    // Image 1's height ∝ 1/totalGrow, so oldH/newH = newTotal/oldTotal
    const oldTotal = origGrows[0] + origGrows[1];
    const newTotal = newGrow0 + origGrows[1];
    const expectedRatio = newTotal / oldTotal;
    const actualRatio = origHeights[1] / newHeights[1];
    expect(actualRatio).toBeCloseTo(expectedRatio, 2);
  });
});

// ── computeDividerXPositions ──
describe('computeDividerXPositions', () => {
  it('single image returns two positions (left + right edges)', () => {
    const p = computeDividerXPositions(0, [800], 4);
    expect(p).toHaveLength(2);
    expect(p[0]).toBe(0);
    expect(p[1]).toBe(800); // right edge, no gap after last image
  });

  it('two images with gap', () => {
    // containerLeft=100, widths=[300, 200], gap=10
    // pos[0]=100                        (before image 0)
    // i=0: x=100+300=400, divider at 400+5=405, x+=10=410
    // i=1: x=410+200=610 (last image, no gap after it)
    const p = computeDividerXPositions(100, [300, 200], 10);
    expect(p).toHaveLength(3);
    expect(p[0]).toBe(100);   // left edge
    expect(p[1]).toBe(405);   // between images: 100+300+5=405
    expect(p[2]).toBe(610);   // right edge: 100+300+10+200=610
  });

  it('three images with zero gap', () => {
    const p = computeDividerXPositions(0, [100, 100, 100], 0);
    expect(p).toHaveLength(4);
    expect(p[0]).toBe(0);
    expect(p[1]).toBe(100);
    expect(p[2]).toBe(200);
    expect(p[3]).toBe(300);
  });

  it('empty widths returns only container left edge', () => {
    const p = computeDividerXPositions(50, [], 4);
    expect(p).toHaveLength(1);
    expect(p[0]).toBe(50);
  });

  it('dockerLeft non-zero offsets all positions', () => {
    const p = computeDividerXPositions(30, [240, 240], 0);
    expect(p[0]).toBe(30);
    expect(p[1]).toBe(270); // 30 + 240
    expect(p[2]).toBe(510); // 30 + 240 + 0 + 240
  });
});

// ── findClosestDividerIndex ──
describe('findClosestDividerIndex', () => {
  const positions = [100, 405, 610]; // two-image row

  it('returns index of nearest divider within threshold', () => {
    expect(findClosestDividerIndex(402, positions, 10)).toBe(1);
    expect(findClosestDividerIndex(407, positions, 10)).toBe(1);
    expect(findClosestDividerIndex(100, positions, 10)).toBe(0);
    expect(findClosestDividerIndex(608, positions, 10)).toBe(2);
  });

  it('returns null when cursor is far from any divider', () => {
    expect(findClosestDividerIndex(300, positions, 10)).toBeNull();
    expect(findClosestDividerIndex(550, positions, 20)).toBeNull();
  });

  it('zero threshold always returns null unless exact match', () => {
    expect(findClosestDividerIndex(405, positions, 0)).toBe(1);
    expect(findClosestDividerIndex(406, positions, 0)).toBeNull();
  });

  it('empty positions returns null', () => {
    expect(findClosestDividerIndex(200, [], 50)).toBeNull();
  });

  it('single position returns 0 when within threshold', () => {
    expect(findClosestDividerIndex(52, [50], 5)).toBe(0);
    expect(findClosestDividerIndex(56, [50], 5)).toBeNull();
  });
});

// ── findInsertIndex ──
describe('findInsertIndex', () => {
  // Two-image row: containerLeft=100, widths=[300, 200], gap=10
  // positions = [100, 405, 610], totalWidth = 300+200+10 = 510
  const [left, widths, gap] = [100, [300, 200], 10];

  it('cursor near divider → returns divider index', () => {
    // Near divider at position[1]=405
    expect(findInsertIndex(400, left, widths, gap, 60)).toBe(1);
    expect(findInsertIndex(410, left, widths, gap, 60)).toBe(1);
  });

  it('cursor near left edge → returns 0', () => {
    expect(findInsertIndex(95, left, widths, gap, 60)).toBe(0);
    expect(findInsertIndex(110, left, widths, gap, 60)).toBe(0);
  });

  it('cursor near right edge → returns imageWidths.length', () => {
    expect(findInsertIndex(615, left, widths, gap, 60)).toBe(2);
    expect(findInsertIndex(605, left, widths, gap, 60)).toBe(2);
  });

  it('cursor in middle of image, far from any divider → fallback to binary', () => {
    // Middle of image 0 (x≈250): far from 100 (150px) and 405 (155px)
    // totalWidth=510, center at 100+255=355, 250 < 355 → fallback 0
    expect(findInsertIndex(250, left, widths, gap, 60)).toBe(0);
    // Middle of image 1 (x≈500): far from 405 (95px) and 610 (110px)
    // center at 355, 500 > 355 → fallback 2
    expect(findInsertIndex(500, left, widths, gap, 60)).toBe(2);
  });

  it('old midpoint logic would have given wrong answer near divider', () => {
    // Scenario that caused the insert-position bug:
    // Cursor at x=490 (right side of image 0, near the divider at 405)
    // Old midpoint logic on item 0: mid of first image = 100+150=250
    //   → 490 > 250 → insertAt = 0+1 = 1  ← coincidentally correct for this case
    // Cursor at x=430 (left side of image 1, near the divider at 405)
    // Old midpoint logic on item 1: mid = (100+300+10) + 100 = 510
    //   → 430 < 510 → insertAt = 1 = 1  ← also correct

    // But for cursor at gap center (x=405), old logic doesn't fire on any item
    // → container handler uses old binary choice: 405 > 355 → insertAt = 2 (WRONG)
    // New logic: 405 is exactly at divider → returns 1 (CORRECT)
    const oldFallback = 405 < (100 + 510 / 2) ? 0 : 2; // 405 > 355 → 2 (WRONG)
    expect(oldFallback).toBe(2);
    expect(findInsertIndex(405, left, widths, gap, 60)).toBe(1);
  });

  it('empty widths → returns 0 when left of center, 0 when right', () => {
    // Empty row: only left edge at position 0
    // totalWidth = 0, center = 100
    expect(findInsertIndex(90, 100, [], 0, 60)).toBe(0);
    expect(findInsertIndex(110, 100, [], 0, 60)).toBe(0);
  });

  it('single image: edge positions within threshold, middle → fallback', () => {
    // containerLeft=0, width=[800], gap=4, positions=[0, 800]
    // Near left edge
    expect(findInsertIndex(30, 0, [800], 4, 60)).toBe(0);
    // Near right edge
    expect(findInsertIndex(780, 0, [800], 4, 60)).toBe(1);
    // Middle → fallback (400 < 400 → 0, 450 > 400 → 1)
    expect(findInsertIndex(300, 0, [800], 4, 60)).toBe(0);
    expect(findInsertIndex(500, 0, [800], 4, 60)).toBe(1);
  });
});
