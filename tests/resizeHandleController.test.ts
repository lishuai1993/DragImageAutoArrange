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
    getGroupLineStart: () => 0,
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
    maxDrawnHeight: () => 0,
    noteDragGeometry: () => undefined,
    syncItemToDrawing: () => calls.push('syncItemToDrawing'),
    notifyLayoutChange: () => undefined,
    emitResizeEnd: () => undefined,
    setImageScale: () => undefined,
    setSingleImageWidth: (w) => calls.push(`setSingleImageWidth:${w}`),
    getSnapSensitivity: () => 3,
    // A lone row has no junction on either side, so it offers no bar — which is
    // also the whole of what the drag asks before snapping.
    setResizeSnapSide: () => false,
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

/**
 * Snap behaviour of a multi-image resize drag, on a three-member row whose
 * middle member is the one under the handle.
 *
 * The drag reads every height off the members themselves — which is what
 * `recalculateRowHeight` leaves behind, each cell carrying its own drawn height —
 * so the harness only has to say what each member stands at.  The middle member
 * starts at 180 and the south-east corner is driven, where both weights are 1
 * and the blended delta is `dy / 2`.
 */
interface ThreeRow {
  host: ResizeHost;
  items: HTMLElement[];
  /** Every side the drag has asked for a bar on, in order. */
  sides: Array<'left' | 'right' | null>;
  /** Every rectangle the drag has handed the host as the model, in order. */
  notes: Array<{ index: number; box: number; drawn: number }>;
  /** What the drag persisted, as it persisted it. */
  calls: string[];
}

function makeThreeRow(
  heights: [number, number, number],
  opts: {
    sensitivity?: number;
    canSnap?: boolean;
    ceiling?: number;
    /** Px the measured picture falls short of its cell — the sub-pixel the box
     *  height's own rounding leaves behind, exaggerated so a ratio of 99 shows. */
    contentInset?: number;
  } = {}
): ThreeRow {
  const container = createDiv();
  const items: HTMLElement[] = [];
  const imgs: HTMLImageElement[] = [];
  container.setCssStyles({ height: `${heights[2]}px` });
  container.getBoundingClientRect = () => rect(CONTAINER_W, heights[2]);

  for (let i = 0; i < heights.length; i++) {
    const item = createDiv();
    const img = createEl('img');
    item.appendChild(img);
    container.appendChild(item);
    item.setCssStyles({ height: `${heights[i]}px` });
    // Read through to the inline height so a cell and its picture always agree,
    // which is the invariant the drag's own mismatch probe checks.
    const cellH = () => Number.parseFloat(item.style.height) || 0;
    const boxH = () => Number.parseFloat(img.style.height) || 0;
    item.getBoundingClientRect = () => rect(CONTAINER_W / 3, cellH());
    img.getBoundingClientRect = () => rect(CONTAINER_W / 3, boxH());
    items.push(item);
    imgs.push(img);
  }

  const sides: Array<'left' | 'right' | null> = [];
  const notes: ThreeRow['notes'] = [];
  const calls: string[] = [];
  const host: ResizeHost = {
    getContainer: () => container,
    getGroupLineStart: () => 0,
    getItemEls: () => items,
    getImageEls: () => imgs,
    getInterItemSpace: () => 0,
    getSnapSensitivity: () => opts.sensitivity ?? 3,
    getLoadedMeta: () => NATURAL,
    getImageContentRect: (i) => ({
      left: 0,
      top: 0,
      width: CONTAINER_W / 3 - (opts.contentInset ?? 0),
      height: heights[i],
    }),
    getObjectPosition: () => 'left top',
    updateHandlePositions: () => undefined,
    isTurnedImage: () => false,
    boxHeightForDrawn: (h) => h,
    maxDrawnHeight: () => opts.ceiling ?? 0,
    noteDragGeometry: (i, box, drawn) => notes.push({ index: i, box, drawn }),
    syncItemToDrawing: () => undefined,
    notifyLayoutChange: () => undefined,
    emitResizeEnd: () => calls.push('emitResizeEnd'),
    setImageScale: (_index, scale) => calls.push(`setImageScale:${scale}`),
    setSingleImageWidth: () => undefined,
    setResizeSnapSide: (_index, side) => {
      sides.push(side);
      return opts.canSnap ?? true;
    },
  };
  return { host, items, sides, notes, calls };
}

/**
 * Press the middle member's south-east corner, move `dys` in turn, and release.
 * Returns the sides asked for *during* the drag: releasing appends its own
 * clearing call, which only the teardown case is about.
 */
function dragMiddle(h: ThreeRow, dys: number[]): Array<'left' | 'right' | null> {
  const { handles } = new ResizeHandleController(h.host).buildHandles(h.items[1], 1);
  handles[SE_CORNER].dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 100 }));
  for (const dy of dys) {
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 100 + dy }));
  }
  const during = [...h.sides];
  document.dispatchEvent(new MouseEvent('mouseup'));
  return during;
}

describe('multi-image resize drag snapping', () => {
  it('lands on the neighbour the pointer has reached', () => {
    // Middle starts at 180, the right neighbour stands at 220.
    const h = makeThreeRow([160, 180, 220]);
    const sides = dragMiddle(h, [80]);

    expect(h.items[1].style.height).toBe('220px');
    expect(sides).toEqual(['right']);
  });

  it('records everything it wrote as the model, dragged member and neighbours alike', () => {
    // A member's model box is what the observer and the next layout pass read
    // back; left at the pre-drag value it would be "something else wrote this"
    // and the picture would snap back to the older rectangle on the first check.
    const h = makeThreeRow([160, 180, 220]);
    dragMiddle(h, [80]);

    expect(h.notes).toEqual([
      { index: 1, box: 220, drawn: 220 },
      { index: 0, box: 160, drawn: 160 },
      { index: 2, box: 220, drawn: 220 },
    ]);
  });

  it('leaves the height on the pointer between zones', () => {
    const h = makeThreeRow([160, 180, 220]);
    // 190 sits 10 from the left neighbour and 30 from the right: in neither zone.
    const sides = dragMiddle(h, [20]);

    expect(h.items[1].style.height).toBe('190px');
    expect(sides).toEqual([null]);
  });

  it('crosses to the other neighbour when the drag leaves its zone', () => {
    const h = makeThreeRow([160, 180, 220]);
    // Down onto the right neighbour at 220, then back up past its zone to 164,
    // inside the left neighbour's (160 ± 4.8).
    const sides = dragMiddle(h, [80, -32]);

    expect(sides).toEqual(['right', 'left']);
    expect(h.items[1].style.height).toBe('160px');
  });

  it('keeps its claim while the pointer stays in the zone it already holds', () => {
    // Neighbours 200 and 204 — closer together than two zones, so both reach the
    // pointer at once and the first move has to break the tie.
    const h = makeThreeRow([200, 180, 204]);
    // 202 is two from each; then 203, which the right neighbour is nearer to.
    const sides = dragMiddle(h, [44, 46]);

    expect(sides).toEqual(['left', 'left']);
    expect(h.items[1].style.height).toBe('200px');
  });

  it('snaps nothing at zero sensitivity', () => {
    const h = makeThreeRow([160, 180, 220], { sensitivity: 0 });
    const sides = dragMiddle(h, [80]);

    expect(h.items[1].style.height).toBe('220px');
    expect(sides).toEqual([null]);
  });

  it('does not lock when the row has no bar to show', () => {
    // Dividers switched off: the row cannot say why the height locked, so the
    // drag runs unsnapped rather than locking silently.
    const h = makeThreeRow([160, 180, 220], { canSnap: false });
    dragMiddle(h, [80]);

    expect(h.items[1].style.height).toBe('220px');
  });

  it('puts the bar out when the drag ends', () => {
    const h = makeThreeRow([160, 180, 220]);
    dragMiddle(h, [80]);

    expect(h.sides.at(-1)).toBeNull();
  });
});

/**
 * The far end of a multi-image resize drag: the drawn height at which the
 * member's box spans its whole cell (`fill = 1`).  Past it a taller box only
 * spills out of the cell — the picture is clipped by it and the row grows with
 * nothing on screen to show for it — so the drag is void there.  Only the host
 * can say where that is (it alone knows the bitmap and the cell), so the drag
 * reads it off `maxDrawnHeight` and clamps its own request before snapping.
 */
describe('multi-image resize drag ceiling', () => {
  it('stops at the ceiling instead of growing the row', () => {
    // The middle member can fill its cell only up to 200; its right neighbour
    // stands at 300, beyond anything this member could reach.
    const h = makeThreeRow([160, 180, 300], { ceiling: 200 });
    const sides = dragMiddle(h, [200]);

    expect(h.items[1].style.height).toBe('200px');
    // The row is its tallest cell, and that is where it stays.
    expect(h.host.getContainer()!.style.height).toBe('300px');
    expect(sides).toEqual([null]);
  });

  it('still snaps to a neighbour the ceiling allows', () => {
    // 195 sits inside the 3% zone of the clamped 200 and below the ceiling, so
    // it claims: this is a height the member can actually take.
    const h = makeThreeRow([160, 180, 195], { ceiling: 200 });
    const sides = dragMiddle(h, [40]);

    expect(h.items[1].style.height).toBe('195px');
    expect(sides).toEqual(['right']);
  });

  it('never claims from above the ceiling', () => {
    // 204 is inside the zone of the clamped pointer but cannot be reached — the
    // box may not be wider than the cell — so no bar lights for it.
    const h = makeThreeRow([160, 180, 204], { ceiling: 200 });
    const sides = dragMiddle(h, [40]);

    expect(h.items[1].style.height).toBe('200px');
    expect(sides).toEqual([null]);
  });

  it("lands on the row's own rounding of the ceiling", () => {
    // The height model rounds this length to 201; a drag that floored it would
    // stop at 200 and sit a pixel under a neighbour standing on 201.
    const h = makeThreeRow([160, 180, 300], { ceiling: 200.6 });
    dragMiddle(h, [400]);

    expect(h.items[1].style.height).toBe('201px');
  });

  it('lets a neighbour standing on the ceiling claim the drag', () => {
    // The repro: a column dragged to its ceiling, which is where its neighbour
    // already stands.  The ceiling and that height are one length put through
    // two roundings, so they can land a pixel apart — and the bar must light
    // anyway.  It exists to announce exactly this equality.
    const h = makeThreeRow([160, 180, 201], { ceiling: 200 });
    const sides = dragMiddle(h, [400]);

    expect(h.items[1].style.height).toBe('201px');
    expect(sides).toEqual(['right']);
  });

  it('never claims from more than the rounding above the ceiling', () => {
    // 202 is two above: no rounding of that one length explains it, so the
    // equality really is out of reach and no bar lights.
    const h = makeThreeRow([160, 180, 202], { ceiling: 200 });
    const sides = dragMiddle(h, [400]);

    expect(h.items[1].style.height).toBe('200px');
    expect(sides).toEqual([null]);
  });

  it('writes nothing when the drag never leaves the ceiling', () => {
    // Already full: the member stands at the height where its box spans the cell,
    // so dragging outward cannot move it.  A drag that changes nothing must not
    // edit the note either — an explicit |100 would replace the default 满格 for
    // no reason at all.
    const h = makeThreeRow([160, 200, 220], { ceiling: 200 });
    dragMiddle(h, [40, 400]);

    expect(h.items[1].style.height).toBe('200px');
    expect(h.calls).toEqual([]);
  });

  it('writes the scale and the row once the drag has moved', () => {
    // dy 800 blended by the corner's ½ → 580 asked, 400 delivered: a drag the
    // ceiling stopped has still moved, so it is recorded as it stands.
    const h = makeThreeRow([160, 180, 220], { ceiling: 400 });
    dragMiddle(h, [800]);

    expect(h.items[1].style.height).toBe('400px');
    expect(h.calls).toEqual(['setImageScale:1', 'emitResizeEnd']);
  });
});

/**
 * The ceiling is also a snap target.  满格 is an equality every member can
 * reach, so a pointer that comes within the zone of it is pulled onto it the
 * way a pointer near a neighbour is — but silently: the ceiling is not a
 * neighbour and has no divider of its own to light.
 *
 * The lock is what makes the far end of the drag reachable at all.  The pointer
 * drives an integer drawn height while the ceiling is fractional, so a drag that
 * stops a pixel or two short would otherwise settle just under 满格 and record
 * 99 for a cell it visibly fills.
 */
describe('multi-image resize drag near-full lock', () => {
  it('pulls a pointer within the zone onto the ceiling', () => {
    // 390 is past the clamped 400's 3% line (388) while both neighbours are far
    // away, so nothing else claims: the member lands on 满格.
    const h = makeThreeRow([160, 180, 220], { ceiling: 400 });
    const sides = dragMiddle(h, [420]);

    expect(h.items[1].style.height).toBe('400px');
    expect(sides).toEqual([null]);
  });

  it('leaves a pointer short of the zone where it stands', () => {
    // 380 is outside the 388 line, so the drag keeps its own height — the lock
    // is a band, not a trap.
    const h = makeThreeRow([160, 180, 220], { ceiling: 400 });
    const sides = dragMiddle(h, [400]);

    expect(h.items[1].style.height).toBe('380px');
    expect(sides).toEqual([null]);
  });

  it('lets a neighbour standing inside the band keep the claim', () => {
    // 394 is within the band of 400 and within the zone of the right neighbour
    // at 394.  The neighbour wins: its claim is the deliberate equality, and it
    // is the nearer target — so the bar lights and the picture sits on 394.
    const h = makeThreeRow([160, 180, 394], { ceiling: 400 });
    const sides = dragMiddle(h, [428]);

    expect(h.items[1].style.height).toBe('394px');
    expect(sides).toEqual(['right']);
  });

  it('records the ceiling as exactly full despite a short measurement', () => {
    // The box height is an integer, so the box lands a hair inside the cell and
    // the measured ratio reads 98 for a cell the picture fills.  At the ceiling
    // the member *is* 满格, and that is what the note gets.
    const h = makeThreeRow([160, 180, 220], { ceiling: 400, contentInset: 5 });
    dragMiddle(h, [800]);

    expect(h.items[1].style.height).toBe('400px');
    expect(h.calls).toEqual(['setImageScale:1', 'emitResizeEnd']);
  });

  it('records the measurement when the drag stops short of the ceiling', () => {
    // Same short measurement, but the drag ends outside the band: the member is
    // genuinely narrower than its cell, so its own ratio is the honest record.
    const h = makeThreeRow([160, 180, 220], { ceiling: 400, contentInset: 5 });
    dragMiddle(h, [400]);

    expect(h.items[1].style.height).toBe('380px');
    expect(h.calls[0]).not.toBe('setImageScale:1');
    expect(h.calls[1]).toBe('emitResizeEnd');
  });
});
