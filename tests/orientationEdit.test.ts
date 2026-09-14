/**
 * Tests for the note-writing side of rotate/flip (P4).
 *
 * `orientationEdit` composes a rotate/flip word onto a target line and writes it
 * back as one minimal editor range.  The row-line path rewrites the params in
 * place; the text-bearing path upgrades the paragraph by splitting the embed
 * onto its own line, refusing anything structured or ambiguous.
 */
import { describe, it, expect } from 'vitest';
import type { Editor } from 'obsidian';
import {
  applyOpToLine,
  applyOrientationOp,
  applyOrientationState,
  findEmbedLine,
  lineOrientation,
  resetOrientationOnLine,
  rewriteLineTo,
  setLineOrientation,
} from '../src/imageMenu/orientationEdit';
import { IDENTITY_STATE } from '../src/imageTransform/orientation';

/** Minimal editor whose text is one linear string; offsets map straight to ch. */
class FakeEditor {
  text: string;
  constructor(text: string) {
    this.text = text;
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
    this.text = this.text.slice(0, from.ch) + insert + this.text.slice(to.ch);
  }
}

const asEditor = (e: FakeEditor): Editor => e as unknown as Editor;

describe('lineOrientation', () => {
  it('reads the leading orientation word', () => {
    expect(lineOrientation('![[a.png|r90|left|120]]')).toEqual({ turns: 1, mirror: false });
    expect(lineOrientation('![[a.png|fv]]')).toEqual({ turns: 2, mirror: true });
  });

  it('treats a word-less line as identity', () => {
    expect(lineOrientation('![[a.png]]')).toEqual(IDENTITY_STATE);
    expect(lineOrientation('![[a.png|left|120]]')).toEqual(IDENTITY_STATE);
  });
});

describe('setLineOrientation (row line)', () => {
  it('introduces the word on a bare embed', () => {
    expect(setLineOrientation('![[a.png]]', { turns: 1, mirror: false }))
      .toBe('![[a.png|r90]]');
  });

  it('replaces an existing leading word, leaving other params in order', () => {
    expect(setLineOrientation('![[a.png|r270|left|120]]', { turns: 1, mirror: false }))
      .toBe('![[a.png|r90|left|120]]');
  });

  it('prepends the word ahead of alignment and numbers', () => {
    expect(setLineOrientation('![[a.png|left|120]]', { turns: 1, mirror: false }))
      .toBe('![[a.png|r90|left|120]]');
  });

  it('keeps the slot explicit on a reset to identity', () => {
    expect(setLineOrientation('![[a.png|r270|left]]', IDENTITY_STATE))
      .toBe('![[a.png|orig|left]]');
  });

  it('preserves surrounding whitespace', () => {
    expect(setLineOrientation('  ![[a.png|100]]  ', { turns: 1, mirror: false }))
      .toBe('  ![[a.png|r90|100]]  ');
  });
});

describe('setLineOrientation (text-bearing upgrade)', () => {
  it('splits a paragraph so the embed stands alone, then orients it', () => {
    expect(setLineOrientation('see ![[a.png]] here', { turns: 1, mirror: false }))
      .toBe('see\n![[a.png|r90]]\nhere');
  });

  it('keeps a trailing text run below the embed', () => {
    expect(setLineOrientation('![[a.png]] trailing', { turns: 1, mirror: false }))
      .toBe('![[a.png|r90]]\ntrailing');
  });

  it('refuses structured lines (quote, list, heading, fence)', () => {
    expect(setLineOrientation('> ![[a.png]] quote', { turns: 1, mirror: false })).toBeNull();
    expect(setLineOrientation('- ![[a.png]] item', { turns: 1, mirror: false })).toBeNull();
    expect(setLineOrientation('# ![[a.png]] head', { turns: 1, mirror: false })).toBeNull();
    expect(setLineOrientation('```', { turns: 1, mirror: false })).toBeNull();
  });

  it('refuses a line holding more than one embed', () => {
    expect(setLineOrientation('a ![[a.png]] b ![[b.png]]', { turns: 1, mirror: false }))
      .toBeNull();
  });
});

describe('applyOpToLine', () => {
  it('composes onto the current orientation', () => {
    expect(applyOpToLine('![[a.png]]', 'rotate90cw')).toBe('![[a.png|r90]]');
    expect(applyOpToLine('![[a.png|r90]]', 'rotate180')).toBe('![[a.png|r270]]');
  });

  it('lands on an explicit orig when the op returns to identity', () => {
    expect(applyOpToLine('![[a.png|r90]]', 'rotate90ccw')).toBe('![[a.png|orig]]');
  });

  it('is null where the line cannot be rewritten', () => {
    expect(applyOpToLine('> ![[a.png]]', 'rotate90cw')).toBeNull();
  });
});

describe('rewriteLineTo', () => {
  it('rewrites only the addressed line', () => {
    expect(rewriteLineTo('body\n![[a.png]]\ntail', 1, { turns: 1, mirror: false }))
      .toBe('body\n![[a.png|r90]]\ntail');
  });

  it('is null out of range or when nothing changes', () => {
    expect(rewriteLineTo('![[a.png]]', 5, { turns: 1, mirror: false })).toBeNull();
    expect(rewriteLineTo('![[a.png|orig]]', 0, IDENTITY_STATE)).toBeNull();
  });
});

describe('findEmbedLine', () => {
  it('returns the one line holding exactly one embed of the target', () => {
    expect(findEmbedLine('a\n![[a.png]]\nb', ['a.png'])).toBe(1);
  });

  it('refuses an ambiguous match', () => {
    expect(findEmbedLine('![[a.png]]\n![[a.png]]', ['a.png'])).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(findEmbedLine('![[b.png]]', ['a.png'])).toBeNull();
  });
});

describe('editor transaction', () => {
  it('writes the composed orientation back through one range', () => {
    const editor = new FakeEditor('![[a.png]]\nbody');
    expect(applyOrientationOp(asEditor(editor), 0, 'rotate90cw')).toBe(true);
    expect(editor.getValue()).toBe('![[a.png|r90]]\nbody');
  });

  it('resets to an explicit orig', () => {
    const editor = new FakeEditor('![[a.png|r90|left]]');
    expect(resetOrientationOnLine(asEditor(editor), 0)).toBe(true);
    expect(editor.getValue()).toBe('![[a.png|orig|left]]');
  });

  it('reports false when the state is already what it would write', () => {
    const editor = new FakeEditor('![[a.png|r90]]');
    expect(applyOrientationState(asEditor(editor), 0, { turns: 1, mirror: false })).toBe(false);
  });
});
