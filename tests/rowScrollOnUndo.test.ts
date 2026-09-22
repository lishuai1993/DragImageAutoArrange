import { describe, it, expect, vi } from 'vitest';

// The extender injects a real `EditorView.scrollIntoView` effect, so the view
// mock must hand back a real StateEffect (effects go through
// `StateEffect.mapEffects`, which calls `effect.map`).
const holders = vi.hoisted(() => ({
  effect: null as unknown,
  calls: [] as number[],
}));

vi.mock('obsidian', () => ({
  editorLivePreviewField: {},
}));

vi.mock('@codemirror/view', async () => {
  const { StateEffect } = await import('@codemirror/state');
  const effect = StateEffect.define<number>();
  holders.effect = effect;
  return {
    Decoration: { replace: () => ({}), none: {} },
    DecorationSet: {},
    EditorView: {
      scrollIntoView: (pos: number) => {
        holders.calls.push(pos);
        return effect.of(pos);
      },
    },
    ViewPlugin: { fromClass: () => ({}) },
    WidgetType: class {},
    ViewUpdate: class {},
  };
});

import { EditorState, RangeSet, StateField, type StateEffect } from '@codemirror/state';
import { rowChangePos, undoRevealPos, makeRowScrollOnUndo } from '../src/imageRender/livePreview';

const DOC = ['# note', '![[a.png]]', '![[b.png]]', '', 'text here'].join('\n');

type Decos = Parameters<typeof rowChangePos>[1];

/** Minimal `RangeValue` (only the fields `RangeSet` reads for indexing). */
const BLOCK_VALUE = {
  point: false,
  startSide: 0,
  endSide: 0,
  mapMode: 0,
  eq: () => false,
  map: () => null,
};

/** Live-Preview row decoration: covers source lines 2..3 (block replace). */
function rowDecos(): { rowFrom: number; rowTo: number; decos: Decos } {
  const probe = EditorState.create({ doc: DOC });
  const rowFrom = probe.doc.line(2).from;
  const rowTo = probe.doc.line(4).from;
  const rs = RangeSet.of([
    { from: rowFrom, to: rowTo, value: BLOCK_VALUE },
  ] as never);
  return { rowFrom, rowTo, decos: rs as unknown as Decos };
}

describe('rowChangePos', () => {
  it('returns the change position for an edit inside a row', () => {
    const { rowFrom, decos } = rowDecos();
    const state = EditorState.create({ doc: DOC });
    const tr = state.update({
      changes: { from: rowFrom + 2, to: rowFrom + 6, insert: 'xx' },
    });
    expect(rowChangePos(tr, decos)).toBe(rowFrom + 2);
  });

  it('returns null for an edit outside every row', () => {
    const { decos } = rowDecos();
    const state = EditorState.create({ doc: DOC });
    const line5 = state.doc.line(5);
    const tr = state.update({
      changes: { from: line5.from + 1, to: line5.from + 5, insert: 'XXXX' },
    });
    expect(rowChangePos(tr, decos)).toBeNull();
  });

  it('returns null when the change straddles a row boundary', () => {
    const { rowFrom, rowTo, decos } = rowDecos();
    const state = EditorState.create({ doc: DOC });
    const tr = state.update({
      changes: { from: rowFrom, to: rowTo + 3, insert: 'x' },
    });
    expect(rowChangePos(tr, decos)).toBeNull();
  });

  it('returns null without a decoration set', () => {
    const { rowFrom } = rowDecos();
    const state = EditorState.create({ doc: DOC });
    const tr = state.update({ changes: { from: rowFrom + 1, insert: 'x' } });
    expect(rowChangePos(tr, undefined)).toBeNull();
  });

  it('returns null for an empty decoration set', () => {
    const { rowFrom } = rowDecos();
    const state = EditorState.create({ doc: DOC });
    const tr = state.update({ changes: { from: rowFrom + 1, insert: 'x' } });
    const empty = RangeSet.of([]) as unknown as Decos;
    expect(rowChangePos(tr, empty)).toBeNull();
  });

  it('treats a point insertion at the row start as inside the row', () => {
    const { rowFrom, decos } = rowDecos();
    const state = EditorState.create({ doc: DOC });
    const tr = state.update({ changes: { from: rowFrom, insert: 'x' } });
    expect(rowChangePos(tr, decos)).toBe(rowFrom);
  });
});

describe('undoRevealPos', () => {
  it('prefers the row start for a change inside a row', () => {
    const { rowFrom, decos } = rowDecos();
    const state = EditorState.create({ doc: DOC });
    const tr = state.update({
      changes: { from: rowFrom + 2, to: rowFrom + 6, insert: 'xx' },
    });
    expect(undoRevealPos(tr, decos)).toBe(rowFrom + 2);
  });

  it('falls back to the change start for a change outside every row', () => {
    const { decos } = rowDecos();
    const state = EditorState.create({ doc: DOC });
    const line5 = state.doc.line(5);
    const tr = state.update({
      changes: { from: line5.from + 1, to: line5.from + 5, insert: 'XXXX' },
    });
    expect(undoRevealPos(tr, decos)).toBe(line5.from + 1);
  });

  it('falls back to the insertion point of a restored image line', () => {
    // The cut-undo shape: the line is gone before the undo, so no row
    // decoration covers the insertion — this is the case that used to be left
    // to CodeMirror, which revealed the pre-cut caret instead.
    const { decos } = rowDecos();
    const state = EditorState.create({ doc: DOC });
    const line5 = state.doc.line(5);
    const tr = state.update({ changes: { from: line5.from, insert: '![[c.png]]\n' } });
    expect(undoRevealPos(tr, decos)).toBe(line5.from);
  });

  it('falls back to the change start for a change straddling a row boundary', () => {
    const { rowFrom, rowTo, decos } = rowDecos();
    const state = EditorState.create({ doc: DOC });
    const tr = state.update({ changes: { from: rowFrom, to: rowTo + 3, insert: 'x' } });
    expect(undoRevealPos(tr, decos)).toBe(rowFrom);
  });

  it('falls back to the change start without a decoration set', () => {
    const { rowFrom } = rowDecos();
    const state = EditorState.create({ doc: DOC });
    const tr = state.update({ changes: { from: rowFrom + 1, insert: 'x' } });
    expect(undoRevealPos(tr, undefined)).toBe(rowFrom + 1);
  });

  it('returns null when the transaction changed no text', () => {
    const { decos } = rowDecos();
    const state = EditorState.create({ doc: DOC });
    const tr = state.update({ selection: { anchor: 2 } });
    expect(undoRevealPos(tr, decos)).toBeNull();
  });
});

describe('makeRowScrollOnUndo', () => {
  function setup() {
    const { rowFrom, decos } = rowDecos();
    const decoField = StateField.define<Decos>({
      create: () => decos,
      update: (value) => value,
    });
    const extender = makeRowScrollOnUndo(
      decoField as unknown as Parameters<typeof makeRowScrollOnUndo>[0]
    );
    const state = EditorState.create({ doc: DOC, extensions: [decoField, extender] });
    const effect = holders.effect as StateEffect<number>;
    return { state, rowFrom, effect };
  }

  it('retargets the reveal of an undo that changed a row', () => {
    const { state, rowFrom, effect } = setup();
    const tr = state.update({
      changes: { from: rowFrom + 2, to: rowFrom + 6, insert: 'xx' },
      userEvent: 'undo',
      scrollIntoView: true,
    });
    const injected = tr.effects.find((e) => e.is(effect));
    expect(injected).toBeDefined();
    expect((injected as StateEffect<number>).value).toBe(rowFrom + 2);
  });

  it('retargets redo as well', () => {
    const { state, rowFrom, effect } = setup();
    const tr = state.update({
      changes: { from: rowFrom + 2, to: rowFrom + 6, insert: 'xx' },
      userEvent: 'redo',
      scrollIntoView: true,
    });
    expect(tr.effects.some((e) => e.is(effect))).toBe(true);
  });

  it('retargets an undo whose change lies outside every row', () => {
    const { state, effect } = setup();
    const line5 = state.doc.line(5);
    const tr = state.update({
      changes: { from: line5.from + 1, to: line5.from + 5, insert: 'XXXX' },
      userEvent: 'undo',
      scrollIntoView: true,
    });
    const injected = tr.effects.find((e) => e.is(effect));
    expect(injected).toBeDefined();
    expect((injected as StateEffect<number>).value).toBe(line5.from + 1);
  });

  it('retargets the undo that restores a cut image line', () => {
    const { state, effect } = setup();
    // Restored at the gap below the row: no decoration covers it before the
    // undo, which is why the reveal used to fall through to CodeMirror.
    const line5 = state.doc.line(5);
    const tr = state.update({
      changes: { from: line5.from, insert: '![[c.png]]\n' },
      userEvent: 'undo',
      scrollIntoView: true,
    });
    const injected = tr.effects.find((e) => e.is(effect));
    expect(injected).toBeDefined();
    expect((injected as StateEffect<number>).value).toBe(line5.from);
  });

  it('leaves an undo that changed no text alone', () => {
    const { state } = setup();
    const tr = state.update({
      selection: { anchor: 2 },
      userEvent: 'undo',
      scrollIntoView: true,
    });
    expect(tr.effects.length).toBe(0);
  });

  it('ignores ordinary typing (not an undo/redo)', () => {
    const { state, rowFrom } = setup();
    const tr = state.update({
      changes: { from: rowFrom + 2, to: rowFrom + 6, insert: 'xx' },
      userEvent: 'input.type',
      scrollIntoView: true,
    });
    expect(tr.effects.length).toBe(0);
  });

  it('ignores transactions that do not request a reveal', () => {
    const { state, rowFrom } = setup();
    const tr = state.update({
      changes: { from: rowFrom + 2, to: rowFrom + 6, insert: 'xx' },
      userEvent: 'undo',
    });
    expect(tr.effects.length).toBe(0);
  });
});
