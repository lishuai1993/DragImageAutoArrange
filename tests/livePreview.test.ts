import { describe, it, expect, vi } from 'vitest';

vi.mock('obsidian', () => ({
  editorLivePreviewField: {},
}));

vi.mock('@codemirror/state', () => ({
  StateField: { define: () => ({}) },
  StateEffect: { define: () => ({}) },
  Prec: { highest: (x: unknown) => x },
  Annotation: { define: () => ({}) },
  EditorState: {},
}));

vi.mock('@codemirror/view', () => ({
  Decoration: {
    replace: () => ({ range: () => ({}) }),
    widget: () => ({ widget: {} }),
  },
  ViewPlugin: { fromClass: () => ({}) },
  WidgetType: class {},
  EditorView: {},
}));

import { normalizeRaw, applyFlexGrowChanges } from '../src/imageRender/livePreview';
import { IDENTITY_STATE } from '../src/imageTransform/orientation';
import type { RowImage } from '../src/imageParse/rowParams';

// ── normalizeRaw ──
describe('normalizeRaw', () => {
  it('strips width parameter between pipe and ]]', () => {
    expect(normalizeRaw('![[image.png|200]]')).toBe('![[image.png]]');
  });

  it('strips dimensions parameter', () => {
    expect(normalizeRaw('![[image.png|800x600]]')).toBe('![[image.png]]');
  });

  it('strips multi-part parameter (width|dimensions)', () => {
    expect(normalizeRaw('![[image.png|200|800x600]]')).toBe('![[image.png]]');
  });

  it('returns unchanged if no pipe parameter', () => {
    expect(normalizeRaw('![[image.png]]')).toBe('![[image.png]]');
  });

  it('strips from first pipe when filename contains pipes', () => {
    // "file|name.png|200" → regex matches "|name.png|200" → result "![[file]]"
    // Wait: regex is \|[^\]]*(?=]])
    // In "file|name.png|200", [^\]]* matches "name.png|200"
    // So result is "![[file]]"
    // Actually: the filename part is "file|name.png" (with a pipe in the name).
    // The regex matches the FIRST pipe that is followed by non-] chars before ]].
    // In `![[file|name.png|200]]`, the first | is between file and name.png.
    // [^\]]* matches "name.png|200". So normalizeRaw strips "|name.png|200".
    // Result: `![[file]]`.
    // This edge case behavior is a known limitation.
    const result = normalizeRaw('![[file|name.png|200]]');
    // The first | before ]] is at "name.png", stripping to "![[file]]"
    expect(result).toBe('![[file]]');
  });
});

// ── applyFlexGrowChanges: what decides a write is a no-op ──
// Minimal EditorView stand-in: only `state.doc.lines` / `state.doc.line(n)` and
// `dispatch` are read, so a doc-shaped stub is enough (and keeps the real
// @codemirror/* out of this file's mock set).
function fakeView(lines: string[]): {
  view: { state: { doc: { lines: number; line: (n: number) => { text: string; from: number } } }; dispatch: (tr: unknown) => void };
  dispatched: Array<{ changes: Array<{ from: number; to: number; insert: string }> }>;
} {
  const dispatched: Array<{ changes: Array<{ from: number; to: number; insert: string }> }> = [];
  let off = 0;
  const starts = lines.map((l) => { const s = off; off += l.length + 1; return s; });
  return {
    view: {
      state: {
        doc: {
          lines: lines.length,
          line: (n: number) => ({ text: lines[n - 1], from: starts[n - 1] }),
        },
      },
      dispatch: (tr: unknown) => { dispatched.push(tr as { changes: Array<{ from: number; to: number; insert: string }> }); },
    },
    dispatched,
  };
}

function multiImage(line: number, raw: string, share: number): RowImage {
  return {
    line,
    raw,
    fileName: 'a.webp',
    alignment: 'center',
    orientation: IDENTITY_STATE,
    hasSizing: true,
    display: { kind: 'multi', share, fill: 1 },
  };
}

describe('applyFlexGrowChanges', () => {
  it('writes the line when the model is unchanged but the document differs', () => {
    // The regression: `eqInner` strips the params before comparing, so a
    // param-only write never rebuilds the widget and `img.raw` keeps the value
    // the DOM was last built with.  Comparing the new line against that stale
    // snapshot would discard this write as a no-op, and the file would silently
    // keep the previous share — which is exactly what Reading Mode, reading only
    // the file, keeps showing.
    const stale = '![[a.webp|orig|center|310|100]]';
    const doc = '![[a.webp|orig|center|77|100]]';
    const { view, dispatched } = fakeView([doc]);
    applyFlexGrowChanges(
      view as never,
      [multiImage(0, stale, 3.1)],
      [3.1],
      [1],
      'center'
    );
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].changes[0].insert).toBe(stale);
    expect(dispatched[0].changes[0].from).toBe(0);
    expect(dispatched[0].changes[0].to).toBe(doc.length);
  });

  it('skips the write when the document already holds the new line', () => {
    const doc = '![[a.webp|orig|center|310|100]]';
    const { view, dispatched } = fakeView([doc]);
    applyFlexGrowChanges(view as never, [multiImage(0, doc, 3.1)], [3.1], [1], 'center');
    expect(dispatched).toHaveLength(0);
  });

  it('skips a line that no longer holds the image (structural move)', () => {
    // The cached line was relocated by a moveLine; rewriting it would resurrect
    // the embed at its old position.
    const { view, dispatched } = fakeView(['some other text']);
    applyFlexGrowChanges(
      view as never,
      [multiImage(0, '![[a.webp|orig|center|310|100]]', 3.1)],
      [3.1],
      [1],
      'center'
    );
    expect(dispatched).toHaveLength(0);
  });

  it('folds in a fill change on the same line', () => {
    const stale = '![[a.webp|orig|center|310|100]]';
    const doc = '![[a.webp|orig|center|310|100]]';
    const img = multiImage(0, stale, 3.1);
    const { view, dispatched } = fakeView([doc]);
    applyFlexGrowChanges(view as never, [img], [3.1], [0.52], 'center');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].changes[0].insert).toBe('![[a.webp|orig|center|310|52]]');
  });
});
