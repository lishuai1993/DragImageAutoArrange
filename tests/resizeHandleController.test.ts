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
}

function makeThreeRow(
  heights: [number, number, number],
  opts: { sensitivity?: number; canSnap?: boolean } = {}
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
  const host: ResizeHost = {
    getContainer: () => container,
    getItemEls: () => items,
    getImageEls: () => imgs,
    getInterItemSpace: () => 0,
    getSnapSensitivity: () => opts.sensitivity ?? 3,
    getLoadedMeta: () => NATURAL,
    getImageContentRect: (i) => ({
      left: 0,
      top: 0,
      width: CONTAINER_W / 3,
      height: heights[i],
    }),
    getObjectPosition: () => 'left top',
    updateHandlePositions: () => undefined,
    isTurnedImage: () => false,
    boxHeightForDrawn: (h) => h,
    noteDragGeometry: (i, box, drawn) => notes.push({ index: i, box, drawn }),
    syncItemToDrawing: () => undefined,
    notifyLayoutChange: () => undefined,
    emitResizeEnd: () => undefined,
    setImageScale: () => undefined,
    setSingleImageWidth: () => undefined,
    setResizeSnapSide: (_index, side) => {
      sides.push(side);
      return opts.canSnap ?? true;
    },
  };
  return { host, items, sides, notes };
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
