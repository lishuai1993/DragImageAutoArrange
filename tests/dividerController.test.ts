/**
 * @vitest-environment jsdom
 *
 * Pins the divider's snap to the heights the row actually renders.
 *
 * A member's drawn height is `fill × grow / aspect`, so two members render
 * equal heights at the aspect-equal split only while their fill ratios agree.
 * The two-image row of the 图片并排测试文档 repro has fills 0.64 and 1.00, and
 * the aspect-only zone failed it in mirror-image ways: at the split that
 * equalises the pictures (≈1.322/0.738 → 516 px against 516 px) it showed
 * nothing, while at the split an earlier drag had persisted (1.095/0.965, where
 * the aspects agree) it lit up with the members 428 px against 675 px.  Both
 * are pinned below, from the same drag direction, so neither can be satisfied
 * by breaking the other.  The colour is a transient drag indicator — it is
 * cleared on release — so it is read mid-drag.
 */
import { describe, it, expect } from 'vitest';
import { DividerController, type DividerHost } from '../src/interaction/dividerController';
import { CLASSES } from '../src/constants';
import type { ImageMeta } from '../src/imageParse/imageDetector';
import type { OrientationState } from '../src/imageTransform/orientation';

/** Container width the real row reported, and what one seam costs there: the
 *  4 px divider with the row's 4 px flex gap on each side of it. */
const WIDTH = 972.890625;
const INTER_ITEM_SPACE = 12;
const ROW_HEIGHT = 200;
const SNAP_SENSITIVITY = 3;

const LEFT = { naturalWidth: 500, naturalHeight: 654 };
const RIGHT = { naturalWidth: 800, naturalHeight: 1200 };
const METAS: ImageMeta[] = [LEFT, RIGHT];

interface Harness {
  items: HTMLElement[];
  /** How many times the drag's shares were written to the note. */
  releases: number[];
  /** Drag by `dx` px; `snapped` is the colour while the drag is still held. */
  drag(dx: number): { snapped: boolean; divider: HTMLElement };
}

function makeRow(
  grows: number[],
  fills: Array<number | null>,
  sensitivity = SNAP_SENSITIVITY,
  orientations: Array<OrientationState | null> = []
): Harness {
  const items = grows.map((g) => {
    const item = createDiv();
    item.style.flexGrow = String(g);
    return item;
  });
  const releases: number[] = [];
  const host: DividerHost = {
    getItemEls: () => items,
    getLoadedMeta: (i) => METAS[i],
    getSnapSensitivity: () => sensitivity,
    getImageCount: () => items.length,
    getFill: (i) => fills[i] ?? null,
    getOrientation: (i) => orientations[i] ?? null,
    getRowWidth: () => WIDTH,
    getInterItemSpace: () => INTER_ITEM_SPACE,
    getDefaultRowHeight: () => ROW_HEIGHT,
    snapDividerToEquilibrium: () => undefined,
    recalculateRowHeight: () => undefined,
    emitDividerDrag: () => undefined,
    emitDividerDragEnd: (leftIndex) => releases.push(leftIndex),
  };
  return {
    items,
    releases,
    drag(dx: number) {
      const divider = new DividerController(host).build(0);
      divider.dispatchEvent(new MouseEvent('mousedown', { clientX: 500, clientY: 100 }));
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 500 + dx, clientY: 100 }));
      const snapped = divider.classList.contains(CLASSES.dividerSnap);
      document.dispatchEvent(new MouseEvent('mouseup'));
      return { snapped, divider };
    },
  };
}

/** The grow the controller last wrote onto a member. */
function growOf(item: HTMLElement): number {
  return Number.parseFloat(item.style.flexGrow);
}

describe('divider drag snap', () => {
  it('snaps where the pictures match, not where the aspects do', () => {
    // Start near the equal-height split (516 px against 516 px) and step onto
    // it: the pair must lock to the model's own answer, ≈1.322/0.738.
    const h = makeRow([1.34, 0.72], [0.64, 1]);
    const { snapped } = h.drag(-3);

    expect(snapped).toBe(true);
    expect(growOf(h.items[0])).toBeCloseTo(1.322, 3);
    expect(growOf(h.items[1])).toBeCloseTo(0.738, 3);
  });

  it('does not snap where the aspects match but the pictures differ by 55%', () => {
    // 1.095/0.965 leaves the members at 428 px against 675 px — the aspect-equal
    // split, and the one the persisted |110|64 / |96|100 pair sits on.
    const h = makeRow([1.32, 0.74], [0.64, 1]);
    const { snapped } = h.drag(-45);

    expect(snapped).toBe(false);
    // The candidate itself was written: the move ran, it simply did not snap.
    expect(growOf(h.items[0])).toBeCloseTo(1.095, 3);
    expect(growOf(h.items[1])).toBeCloseTo(0.965, 3);
  });

  it('keeps a pair with matching fills on the old behaviour', () => {
    // Both fills at 1: aspect and rendered heights coincide, so the aspect-equal
    // split is still the snap target — the four-image row's case.  2.05 ×
    // 0.764526 / 1.431193 = 1.09509, solved exactly now that the search runs on
    // the unrounded heights.
    const h = makeRow([1.11, 0.94], [1, 1]);
    const { snapped } = h.drag(-3);

    expect(snapped).toBe(true);
    expect(growOf(h.items[0])).toBeCloseTo(1.09509, 4);
    expect(growOf(h.items[1])).toBeCloseTo(0.95491, 4);
  });

  it('leaves a pair nothing can equalise alone', () => {
    // No fills at all: both members render the row fallback at every split, so
    // there is no split to lock to — and no colour that could claim one.
    const h = makeRow([1.1, 0.95], [null, null]);
    const { snapped } = h.drag(-45);

    expect(snapped).toBe(false);
    expect(growOf(h.items[0])).toBeCloseTo(0.875, 3);
    expect(growOf(h.items[1])).toBeCloseTo(1.175, 3);
  });

  it('solves on the painted heights when a member is quarter-turned', () => {
    // The turned left member paints at 0.7645 × its slot (it holds the slot
    // width and its own 0.7645 ratio is what the height follows), against the
    // neighbour's 1.5.  Equal painting then asks for a split in
    // 1.5 / (0.7645 + 1.5) = 0.6625 of the pair's 2.06, i.e. 1.3645 — not the
    // aspect-only 1.1005 that an unturned row would use.  The drag starts at
    // 1.34 and has to come *up* to reach it.
    const turned: OrientationState = { turns: 1, mirror: false };
    const h = makeRow([1.34, 0.72], [1, 1], SNAP_SENSITIVITY, [turned, null]);
    const { snapped } = h.drag(5);

    expect(snapped).toBe(true);
    expect(growOf(h.items[0])).toBeCloseTo(1.3646, 3);
    expect(growOf(h.items[1])).toBeCloseTo(0.6954, 3);
  });

  it('does not snap a turned pair at the aspect-only split', () => {
    // 1.1005 of the pair's 2.06 is where the *aspects* agree: the turned
    // portrait paints 392 px there against the neighbour's 672 px.
    const turned: OrientationState = { turns: 1, mirror: false };
    const h = makeRow([1.34, 0.72], [1, 1], SNAP_SENSITIVITY, [turned, null]);
    const { snapped } = h.drag(-48);

    expect(snapped).toBe(false);
    expect(growOf(h.items[0])).toBeCloseTo(1.1, 3);
  });

  it('clears the colour when the snapping is switched off', () => {
    const off = makeRow([1.11, 0.94], [1, 1], 0);
    off.items[0].parentElement?.appendChild(off.items[1]);
    const divider = new DividerController({
      getItemEls: () => off.items,
      getLoadedMeta: (i) => METAS[i],
      getSnapSensitivity: () => 0,
      getImageCount: () => 2,
      getFill: () => 1,
      getOrientation: () => null,
      getRowWidth: () => WIDTH,
      getInterItemSpace: () => INTER_ITEM_SPACE,
      getDefaultRowHeight: () => ROW_HEIGHT,
      snapDividerToEquilibrium: () => undefined,
      recalculateRowHeight: () => undefined,
      emitDividerDrag: () => undefined,
      emitDividerDragEnd: () => undefined,
    }).build(0);
    divider.classList.add(CLASSES.dividerSnap);
    divider.dispatchEvent(new MouseEvent('mousedown', { clientX: 500, clientY: 100 }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 520, clientY: 100 }));

    // A stale colour from an earlier drag must not survive a move.
    expect(divider.classList.contains(CLASSES.dividerSnap)).toBe(false);
    document.dispatchEvent(new MouseEvent('mouseup'));
  });
});

describe('divider drag persist', () => {
  it('writes the shares once the drag is released', () => {
    // The move only touches the DOM, so without this the gesture leaves no
    // document change behind — and then there is nothing for a Cmd+Z to undo.
    const h = makeRow([1.34, 0.72], [0.64, 1]);
    h.drag(-20);

    expect(h.releases).toEqual([0]);
  });

  it('writes nothing when the drag never left the divider', () => {
    const h = makeRow([1.34, 0.72], [0.64, 1]);
    h.drag(1);

    expect(h.releases).toEqual([]);
  });
});
