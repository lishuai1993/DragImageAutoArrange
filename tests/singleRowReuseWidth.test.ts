/**
 * Regression guard for widget reuse across a single row's `|S|W` width.
 *
 * `normalizeRaw` strips a row's whole param tail, so every width change is
 * invisible to the widget equality check unless the single-row display is
 * compared on its own.  That is the shape of the defect this pins: a handle
 * drag persists `|1|345`, the user presses Cmd+Z, the document goes back to
 * `|1|523` — and because the two rows compared equal, CodeMirror kept the old
 * DOM and the picture stayed at 345 while the note read 523.  From the outside
 * it looks like the undo did nothing.
 *
 * The boundary matters as much as the fix: a multi row's share codes are
 * applied by the widget's own update path, and a follow row's serialised width
 * is a render cache, so neither may start forcing a full rebuild here.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('obsidian', () => ({
  editorLivePreviewField: {},
}));

vi.mock('@codemirror/view', () => ({
  Decoration: { replace: () => ({}), none: {} },
  DecorationSet: {},
  EditorView: {},
  ViewPlugin: { fromClass: () => ({}) },
  WidgetType: class {},
  ViewUpdate: class {},
}));

import { read, singleDisplayChanged } from '../src/imageParse/rowParams';
import { sameRowImages } from '../src/imageRender/livePreview';

const EXTS = 'png,jpg,webp';

/** One single-image row, as `read` builds it from the line's text. */
const single = (raw: string) => read(raw, 'single', EXTS);

/** A two-member row, as `read` builds it from the block's text. */
const multi = (a: string, b: string) => read(`${a}\n${b}`, 'multi', EXTS);

describe('singleDisplayChanged', () => {
  it('reports a changed width on a manual row', () => {
    const [a] = single('![[a.png|orig|right|1|523]]');
    const [b] = single('![[a.png|orig|right|1|345]]');
    expect(singleDisplayChanged(a.display, b.display)).toBe(true);
  });

  it('reports no change for the same width', () => {
    const [a] = single('![[a.png|orig|right|1|523]]');
    const [b] = single('![[a.png|orig|right|1|523]]');
    expect(singleDisplayChanged(a.display, b.display)).toBe(false);
  });

  it('reports the manual ↔ follow flip', () => {
    const [manual] = single('![[a.png|orig|right|1|523]]');
    const [follow] = single('![[a.png|orig|right|0|523]]');
    expect(singleDisplayChanged(manual.display, follow.display)).toBe(true);
    expect(singleDisplayChanged(follow.display, manual.display)).toBe(true);
  });

  it('reports no change between two follow rows', () => {
    const [a] = single('![[a.png|orig|right|0|523]]');
    const [b] = single('![[a.png|orig|right|0|345]]');
    expect(singleDisplayChanged(a.display, b.display)).toBe(false);
  });
});

describe('sameRowImages', () => {
  it('refuses reuse when an undo restores the pre-drag single width', () => {
    const before = single('![[a.png|orig|right|1|345]]');
    const after = single('![[a.png|orig|right|1|523]]');
    expect(sameRowImages(before, after)).toBe(false);
  });

  it('allows reuse when a single row keeps its width', () => {
    const a = single('![[a.png|orig|right|1|523]]');
    const b = single('![[a.png|orig|right|1|523]]');
    expect(sameRowImages(a, b)).toBe(true);
  });

  it('allows reuse when a follow row\'s serialised width changes', () => {
    // The follow width in the document is a cache; what is drawn comes from the
    // settings, so re-rendering for it would be pure churn.
    const a = single('![[a.png|orig|right|0|523]]');
    const b = single('![[a.png|orig|right|0|345]]');
    expect(sameRowImages(a, b)).toBe(true);
  });

  it('allows reuse when a multi row\'s share codes change', () => {
    // Shares are synced onto the live DOM by updateDOM, not by a rebuild.
    const a = multi('![[a.png|120|50]]', '![[b.png|80|50]]');
    const b = multi('![[a.png|150|50]]', '![[b.png|50|50]]');
    expect(sameRowImages(a, b)).toBe(true);
  });

  it('refuses reuse when the member count changes', () => {
    const a = multi('![[a.png|120]]', '![[b.png|80]]');
    const b = multi('![[a.png|120]]', '![[c.png|80]]');
    expect(sameRowImages(a, b)).toBe(false);
    expect(sameRowImages(a, single('![[a.png|120]]'))).toBe(false);
  });

  it('still refuses reuse for an alignment or orientation change', () => {
    const aligned = single('![[a.png|left|1|523]]');
    const realigned = single('![[a.png|right|1|523]]');
    expect(sameRowImages(aligned, realigned)).toBe(false);

    const upright = single('![[a.png|orig|1|523]]');
    const turned = single('![[a.png|r90|1|523]]');
    expect(sameRowImages(upright, turned)).toBe(false);
  });
});
