/**
 * @vitest-environment jsdom
 *
 * The Reading-Mode alignment flush: an alignment change made in Reading Mode is
 * buffered and written to the note when the user switches to Live Preview.
 *
 * The write is a *slot* write.  A line's word slots are ordered
 * `orientation, alignment` (rowParams' `slotOffset`), and the flush used to strip
 * the old alignment word and re-insert the new one at the line's first `|` —
 * which is the orientation slot.  One alignment change therefore cost the row
 * its rotation (the rotate/flip word now sat where an alignment is read) and,
 * on a single row, its `S|W` tail (the numerics no longer sat where that parser
 * looks, so the row read back as setting-driven with no width).  The other half
 * of the defect was *which line* got the write: entries were keyed by file name
 * alone and matched with `includes`, so a note showing one attachment on several
 * rows had the edit land on the first of them — or on a different file whose
 * name merely started the same way.
 *
 * The flush is driven through a fake CodeMirror view: the module's only view of
 * the document is `state.doc` (`lines`, `line(n)`) plus `dispatch`, so a text
 * model and a change applier are the whole of what it needs.
 */
import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import {
  storePendingAlignment,
  flushPendingAlignments,
  getPendingAlignmentCount,
} from '../src/imageRender/rmAlignStore';
import { read, write } from '../src/imageParse/rowParams';

/** CodeMirror `Text`, to the depth the flush uses it. */
class FakeText {
  private text: string;
  private starts: number[] = [];

  constructor(text: string) {
    this.text = text;
    this.reindex();
  }

  private reindex(): void {
    this.starts = [0];
    for (let i = 0; i < this.text.length; i++) {
      if (this.text[i] === '\n') this.starts.push(i + 1);
    }
  }

  get lines(): number {
    return this.starts.length;
  }

  /** 1-based, like CodeMirror's. */
  line(n: number): { text: string; from: number } {
    const from = this.starts[n - 1];
    const end = n < this.starts.length ? this.starts[n] - 1 : this.text.length;
    return { text: this.text.slice(from, end), from };
  }

  toString(): string {
    return this.text;
  }

  apply(changes: Array<{ from: number; to: number; insert: string }>): void {
    // Descending, as a dispatch does: an earlier change must not shift the
    // offsets a later one was measured against.
    for (const c of [...changes].sort((a, b) => b.from - a.from)) {
      this.text = this.text.slice(0, c.from) + c.insert + this.text.slice(c.to);
    }
    this.reindex();
  }
}

const FILE = '图片并排测试-1782296951858.webp';

interface Harness {
  doc: FakeText;
  app: App;
  dispatchCount(): number;
}

function harness(text: string, path = 'note.md'): Harness {
  const doc = new FakeText(text);
  const dispatches: Array<Array<{ from: number; to: number; insert: string }>> = [];
  const cm = {
    state: { doc },
    dispatch(t: { changes: Array<{ from: number; to: number; insert: string }> }): void {
      dispatches.push(t.changes);
      doc.apply(t.changes);
    },
  };
  const app = {
    workspace: { getLeavesOfType: () => [{ view: { file: { path }, editor: { cm } } }] },
    // A promise, as Obsidian's adapter returns — the flush leaves it unawaited
    // on purpose: a disk failure must not undo the landed editor change.
    vault: { adapter: { write: () => Promise.resolve() } },
  } as unknown as App;
  return { doc, app, dispatchCount: () => dispatches.length };
}

describe('flushPendingAlignments: the alignment slot', () => {
  it('writes the new word into the alignment slot, leaving the numerics alone', () => {
    const h = harness(`![[${FILE}|orig|right|250|100]]`);
    storePendingAlignment('note.md', FILE, 'left', 1);
    flushPendingAlignments(h.app);

    expect(h.doc.toString()).toBe(`![[${FILE}|orig|left|250|100]]`);
  });

  it('keeps a single row’s rotation and S|W tail', () => {
    // The regression: `|r90|left|1|415` used to come back as `|left|r90|1|415`,
    // which reads as an unknown orientation over a NaN tail — the picture
    // un-rotates and loses its pinned width in one alignment edit.
    const h = harness(`![[${FILE}|r90|left|1|415]]`);
    storePendingAlignment('note.md', FILE, 'right', 1);
    flushPendingAlignments(h.app);

    expect(h.doc.toString()).toBe(`![[${FILE}|r90|right|1|415]]`);
  });

  it('inserts the word into an empty alignment slot, not ahead of the orientation', () => {
    const h = harness(`![[${FILE}|orig|250|100]]`);
    storePendingAlignment('note.md', FILE, 'right', 1);
    flushPendingAlignments(h.app);

    expect(h.doc.toString()).toBe(`![[${FILE}|orig|right|250|100]]`);
  });

  it('repairs a line whose alignment word sits in the orientation slot', () => {
    // What the old rewrite left behind: exactly the shape found in the wild.
    const h = harness(`![[${FILE}|right|orig|250|100]]`);
    storePendingAlignment('note.md', FILE, 'center', 1);
    flushPendingAlignments(h.app);

    expect(h.doc.toString()).toBe(`![[${FILE}|orig|center|250|100]]`);
  });

  it('adds the word to a bare line', () => {
    const h = harness(`![[${FILE}]]`);
    storePendingAlignment('note.md', FILE, 'right', 1);
    flushPendingAlignments(h.app);

    expect(h.doc.toString()).toBe(`![[${FILE}|right]]`);
  });
});

describe('flushPendingAlignments: which line', () => {
  it('edits the row the user changed, not the first row showing that file', () => {
    // The same attachment on two rows — the case the old file-name hunt got
    // wrong, and the case the test vault is full of.
    const h = harness(
      [
        `![[${FILE}|orig|right|250|100]]`,
        'text between',
        `![[${FILE}|orig|right|110|47]]`,
      ].join('\n')
    );
    storePendingAlignment('note.md', FILE, 'center', 3);
    flushPendingAlignments(h.app);

    expect(h.doc.line(1).text).toBe(`![[${FILE}|orig|right|250|100]]`);
    expect(h.doc.line(3).text).toBe(`![[${FILE}|orig|center|110|47]]`);
  });

  it('falls back to a name search when the recorded line no longer holds the file', () => {
    // The line was inserted above, so line 3 is now other text.  The edit still
    // has to land on the row naming that file.
    const h = harness(
      ['new first line', 'another', `![[${FILE}|orig|right|250|100]]`].join('\n')
    );
    storePendingAlignment('note.md', FILE, 'center', 3);
    flushPendingAlignments(h.app);

    expect(h.doc.line(3).text).toBe(`![[${FILE}|orig|center|250|100]]`);
  });

  it('matches the file by its last path segment, not by prefix', () => {
    // `includes` accepted line 3 as well: its name merely starts with the
    // wanted one.  The subfolder link is the real target.
    const h = harness(
      [
        `![[${FILE}-2.webp|orig|right|250|100]]`,
        `![[图片集/${FILE}|orig|right|250|100]]`,
      ].join('\n')
    );
    storePendingAlignment('note.md', FILE, 'center');
    flushPendingAlignments(h.app);

    expect(h.doc.line(1).text).toBe(`![[${FILE}-2.webp|orig|right|250|100]]`);
    expect(h.doc.line(2).text).toBe(`![[图片集/${FILE}|orig|center|250|100]]`);
  });

  it('touches only the matching embed when one line carries two', () => {
    const h = harness(`![[other.webp|orig|left|250|100]]![[${FILE}|orig|center|250|100]]`);
    storePendingAlignment('note.md', FILE, 'right', 1);
    flushPendingAlignments(h.app);

    expect(h.doc.toString()).toBe(
      `![[other.webp|orig|left|250|100]]![[${FILE}|orig|right|250|100]]`
    );
  });
});

describe('flushPendingAlignments: the row survives the edit', () => {
  const EXTS = 'png,jpg,jpeg,webp';

  /** Drive the line through the row model the way the plugin does: parse it,
   *  serialise it back, let the flush change the alignment, parse again.  What
   *  the user changed is the alignment; the orientation and the sizing the row
   *  came in with have to come out the other side unchanged. */
  function roundTrip(source: string, kind: 'multi' | 'single', next: 'left' | 'center' | 'right') {
    const [before] = read(source, kind, EXTS);
    expect(before).toBeDefined();
    const written = write(before, { followWidthPx: 415 });

    const h = harness(written);
    storePendingAlignment('note.md', FILE, next, 1);
    flushPendingAlignments(h.app);

    const [after] = read(h.doc.toString(), kind, EXTS);
    expect(after).toBeDefined();
    return { before, after };
  }

  it('keeps a single row’s turn and pinned width while changing the alignment', () => {
    const { before, after } = roundTrip(`![[${FILE}|r90|left|1|415]]`, 'single', 'center');

    expect(after.alignment).toBe('center');
    expect(after.orientation).toEqual(before.orientation);
    expect(after.display).toEqual(before.display);
  });

  it('keeps a multi row’s share and fill while changing the alignment', () => {
    const { before, after } = roundTrip(`![[${FILE}|fh|center|250|100]]`, 'multi', 'right');

    expect(after.alignment).toBe('right');
    expect(after.orientation).toEqual(before.orientation);
    expect(after.display).toEqual(before.display);
  });
});

describe('flushPendingAlignments: bookkeeping', () => {
  it('clears an entry that changes nothing without dispatching', () => {
    const h = harness(`![[${FILE}|orig|right|250|100]]`);
    const before = getPendingAlignmentCount();
    storePendingAlignment('note.md', FILE, 'right', 1);
    flushPendingAlignments(h.app);

    expect(h.dispatchCount()).toBe(0);
    expect(h.doc.toString()).toBe(`![[${FILE}|orig|right|250|100]]`);
    expect(getPendingAlignmentCount()).toBe(before);
  });

  it('keeps an entry buffered while its line cannot be found', () => {
    const h = harness('nothing here');
    const before = getPendingAlignmentCount();
    storePendingAlignment('note.md', FILE, 'right', 1);
    expect(flushPendingAlignments(h.app).size).toBe(0);
    expect(getPendingAlignmentCount()).toBe(before + 1);
  });
});
