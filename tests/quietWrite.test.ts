/**
 * @vitest-environment jsdom
 *
 * Tests for writing a note edit without moving the viewport.
 *
 * The trap being guarded against: a programmatic write carries a "reveal the
 * caret" scroll request, which CodeMirror applies on the next scheduled
 * measure.  With the caret off-screen that request moves the viewport.  The
 * guard must (a) still write the text, (b) leave a scroll request naming the
 * viewport's own anchor, carrying no text change and no caret, and (c) take
 * that anchor *before* the write — the write is what invalidates it.
 *
 * The request must be a snapshot rather than a hand-built `y: "start"` one: a
 * snapshot measures and restores its offset in block coordinates on both sides,
 * so the `lpInset` Obsidian leaves above `.cm-content` cancels out.  Mixing
 * block coordinates with the on-screen ones CodeMirror applies them in lands
 * short by exactly that inset, which shifts the viewport on every write.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Editor } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { writeQuietly, viewOfElement } from '../src/imageMenu/quietWrite';
import { IDENTITY_STATE } from '../src/imageTransform/orientation';
import { applyOrientationOp, applyOrientationState } from '../src/imageMenu/orientationEdit';

/** Minimal editor whose text is one linear string; offsets map straight to ch. */
class FakeEditor {
  text: string;
  /** Shared trace of what ran, in order — the ordering assertion reads it. */
  readonly trace: string[];
  constructor(text: string, trace: string[] = []) {
    this.text = text;
    this.trace = trace;
  }
  getValue(): string {
    return this.text;
  }
  offsetToPos(offset: number): { line: number; ch: number } {
    return { line: 0, ch: offset };
  }
  replaceRange(
    insert: string,
    from: { line: number; ch: number },
    to: { line: number; ch: number }
  ): void {
    this.trace.push('write');
    this.text = this.text.slice(0, from.ch) + insert + this.text.slice(to.ch);
  }
}

const asEditor = (e: FakeEditor): Editor => e as unknown as Editor;

/** The fields of the scroll request `writeQuietly` is expected to dispatch.
 *  `ScrollTarget` is not exported, so its shape is spelled out here. */
interface AimedScroll {
  range: { from: number; to: number; head: number };
  y: string;
  x: string;
  yMargin: number;
  xMargin: number;
  isSnapshot: boolean;
}

/** A view scrolled to 400 whose viewport top sits 20px below the top of the
 *  block at document offset 120 (block top 380).  It inherits the real
 *  `scrollSnapshot`, driven by a faked anchor lookup, so the tests exercise the
 *  snapshot CodeMirror itself produces. */
function fakeView(trace: string[] = []) {
  const scrollDOM = document.createDiv();
  scrollDOM.scrollTop = 400;
  const block = { from: 120, top: 380, height: 200 };
  const dispatch = vi.fn();
  const scrollAnchorAt = vi.fn((_scrollTop: number) => {
    trace.push('capture');
    return block;
  });
  const view = Object.assign(Object.create(EditorView.prototype) as EditorView, {
    scrollDOM,
    viewState: { scrollAnchorAt, state: { doc: { length: 500 } } },
    dispatch,
  });
  return { view, dispatch, scrollAnchorAt, block };
}

/** The transaction spec `writeQuietly` dispatched. */
function onlySpec(dispatch: ReturnType<typeof vi.fn>): Record<string, unknown> {
  expect(dispatch).toHaveBeenCalledTimes(1);
  return dispatch.mock.calls[0][0] as Record<string, unknown>;
}

/** The scroll request carried by the hold transaction. */
function aimedScroll(spec: Record<string, unknown>): AimedScroll {
  const effect = spec.effects as { type: unknown; value: AimedScroll };
  expect(effect.type).toBe(EditorView.scrollIntoView(0).type);
  return effect.value;
}

describe('writeQuietly', () => {
  it('writes the change through the editor', () => {
    const editor = new FakeEditor('![[a.png]]');
    writeQuietly(null, asEditor(editor), { from: 8, to: 8, insert: '|orig' });
    expect(editor.getValue()).toBe('![[a.png|orig]]');
  });

  it('asks nothing of the view when none is known', () => {
    const editor = new FakeEditor('abc');
    writeQuietly(null, asEditor(editor), { from: 0, to: 0, insert: 'z' });
    expect(editor.getValue()).toBe('zabc');
  });

  it('holds the viewport by answering the edit with a snapshot', () => {
    const trace: string[] = [];
    const { view, dispatch, scrollAnchorAt, block } = fakeView(trace);
    const editor = new FakeEditor('abc', trace);

    writeQuietly(view, asEditor(editor), { from: 0, to: 0, insert: 'z' });

    // The anchor is read before the write, and from where the viewport stands
    // rather than from the document top.
    expect(scrollAnchorAt).toHaveBeenCalledWith(400);
    expect(trace).toEqual(['capture', 'write']);

    // The request is the only thing that rides along: no text change and no
    // caret, so nothing is added to the undo stack and the caret stays put.
    const spec = onlySpec(dispatch);
    expect(spec.changes).toBeUndefined();
    expect(spec.selection).toBeUndefined();
    expect(spec.scrollIntoView).toBeUndefined();

    const target = aimedScroll(spec);
    expect(target.isSnapshot).toBe(true);
    // The offset is a block-space delta (block top minus scroll offset), which
    // is why it round-trips regardless of any on-screen inset above the
    // content.  The inserted 'z' sits ahead of the anchor, shifting it by one.
    expect(target.yMargin).toBe(block.top - 400);
    expect(target.range.head).toBe(block.from + 1);
  });

  it('maps the anchor through the change it wrote', () => {
    const { view, dispatch } = fakeView();
    // Insert 2 chars ahead of the anchor: it shifts right by 2.
    writeQuietly(view, asEditor(new FakeEditor('abc')), { from: 0, to: 0, insert: 'zz' });
    expect(aimedScroll(onlySpec(dispatch)).range.head).toBe(122);

    // Delete 50 chars ahead of the anchor: it shifts left by 50.
    const second = fakeView();
    writeQuietly(second.view, asEditor(new FakeEditor('abc')), { from: 10, to: 60, insert: '' });
    expect(aimedScroll(onlySpec(second.dispatch)).range.head).toBe(70);
  });

  it('still writes when the layout cannot be read here', () => {
    const { view, dispatch } = fakeView();
    (view as unknown as { viewState: { scrollAnchorAt: () => never } }).viewState.scrollAnchorAt =
      () => {
        throw new Error("Reading the editor layout isn't allowed during an update");
      };
    const editor = new FakeEditor('abc');

    expect(() =>
      writeQuietly(view, asEditor(editor), { from: 0, to: 0, insert: 'z' })
    ).not.toThrow();
    expect(editor.getValue()).toBe('zabc');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('is wired through the rotate path', () => {
    const { view, dispatch } = fakeView();
    const editor = new FakeEditor('![[a.png]]');
    expect(applyOrientationOp(asEditor(editor), 0, 'rotate90cw', view)).toBe(true);
    expect(editor.getValue()).toBe('![[a.png|r90]]');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when the requested state is the state it already has', () => {
    const { view, dispatch } = fakeView();
    const editor = new FakeEditor('![[a.png|orig]]');
    expect(applyOrientationState(asEditor(editor), 0, IDENTITY_STATE, view)).toBe(false);
    expect(editor.getValue()).toBe('![[a.png|orig]]');
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('viewOfElement', () => {
  it('finds the editor view from an element inside the editor', () => {
    const host = createDiv({ cls: 'cm-content' });
    const img = createEl('img');
    host.appendChild(img);
    document.body.appendChild(host);

    const sentinel = { marker: true } as unknown as EditorView;
    const spy = vi.spyOn(EditorView, 'findFromDOM').mockReturnValue(sentinel);
    expect(viewOfElement(img)).toBe(sentinel);
    expect(spy).toHaveBeenCalledWith(host);
    spy.mockRestore();
  });

  it('reports null rather than throwing when the lookup fails', () => {
    const spy = vi.spyOn(EditorView, 'findFromDOM').mockImplementation(() => {
      throw new Error('not an editor');
    });
    expect(viewOfElement(createEl('img'))).toBeNull();
    spy.mockRestore();
  });
});
