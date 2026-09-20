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

describe('setLineOrientation (sizing override)', () => {
  const pin = { sFlag: '1' as const, widthPx: 250 };

  it('replaces the S and W slots, keeping alignment where it was', () => {
    expect(setLineOrientation('![[a.png|orig|center|0|800]]', { turns: 1, mirror: false }, pin))
      .toBe('![[a.png|r90|center|1|250]]');
  });

  it('introduces the slots on a bare embed', () => {
    expect(setLineOrientation('![[a.png]]', { turns: 1, mirror: false }, pin))
      .toBe('![[a.png|r90|1|250]]');
  });

  it('takes over a legacy width sitting where the S|W pair belongs', () => {
    expect(setLineOrientation('![[a.png|800]]', { turns: 1, mirror: false }, pin))
      .toBe('![[a.png|r90|1|250]]');
  });

  it('leaves the slots alone when no override is given', () => {
    expect(setLineOrientation('![[a.png|left|120|100]]', { turns: 1, mirror: false }))
      .toBe('![[a.png|r90|left|120|100]]');
  });

  it('rounds the width and never writes a non-positive one', () => {
    expect(setLineOrientation('![[a.png]]', IDENTITY_STATE, { sFlag: '1', widthPx: 250.4 }))
      .toBe('![[a.png|orig|1|250]]');
    expect(setLineOrientation('![[a.png]]', IDENTITY_STATE, { sFlag: '1', widthPx: 0 }))
      .toBe('![[a.png|orig|1|1]]');
  });

  it('is ignored on the upgrade path, which has no slots to move', () => {
    expect(setLineOrientation('see ![[a.png]] here', { turns: 1, mirror: false }, pin))
      .toBe('see\n![[a.png|r90]]\nhere');
  });
});

describe('setLineOrientation (member fill override)', () => {
  const TURNED = { turns: 1, mirror: false };

  it('replaces the trailing fill code, leaving the share beside it', () => {
    expect(setLineOrientation('![[a.png|r90|center|1497|100]]', IDENTITY_STATE, undefined, 0.585))
      .toBe('![[a.png|orig|center|1497|59]]');
  });

  it('appends a fill where the member had only a share', () => {
    expect(setLineOrientation('![[a.png|r90|center|1497]]', IDENTITY_STATE, undefined, 0.585))
      .toBe('![[a.png|orig|center|1497|59]]');
  });

  it('leaves a member with no share slot alone — a lone number is the share', () => {
    expect(setLineOrientation('![[a.png|r90|center]]', IDENTITY_STATE, undefined, 0.585))
      .toBe('![[a.png|orig|center]]');
  });

  it('clamps to 1 and never writes a code outside (0, 100]', () => {
    expect(setLineOrientation('![[a.png|r90|100]]', IDENTITY_STATE, undefined, 1.71))
      .toBe('![[a.png|orig|100|100]]');
  });

  it('is dropped on the upgrade path, which has no slots to move', () => {
    expect(setLineOrientation('see ![[a.png]] here', TURNED, undefined, 0.5))
      .toBe('see\n![[a.png|r90]]\nhere');
  });

  it('is ignored when a sizing override owns the slots instead', () => {
    // The two never meet — a line is either a lone row or a member — and the
    // sizing path already replaces everything past the alignment word.
    expect(
      setLineOrientation('![[a.png|orig|center|0|800]]', TURNED, { sFlag: '1', widthPx: 250 }, 0.5)
    ).toBe('![[a.png|r90|center|1|250]]');
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
    expect(applyOrientationState(asEditor(editor), 0, { turns: 1, mirror: false })).toBe(true);
    expect(editor.getValue()).toBe('![[a.png|r90]]\nbody');
  });

  it('resets to an explicit orig', () => {
    const editor = new FakeEditor('![[a.png|r90|left]]');
    expect(resetOrientationOnLine(asEditor(editor), 0)).toBe(true);
    expect(editor.getValue()).toBe('![[a.png|orig|left]]');
  });

  it('carries a sizing override in the same transaction', () => {
    const editor = new FakeEditor('![[a.png|orig|center|0|800]]');
    expect(
      applyOrientationState(asEditor(editor), 0, { turns: 1, mirror: false }, null, {
        sFlag: '1',
        widthPx: 400,
      })
    ).toBe(true);
    expect(editor.getValue()).toBe('![[a.png|r90|center|1|400]]');
  });

  it('carries a member fill override in the same transaction', () => {
    const editor = new FakeEditor('![[a.png|r90|center|1497|100]]');
    expect(
      applyOrientationState(asEditor(editor), 0, IDENTITY_STATE, null, undefined, 0.585)
    ).toBe(true);
    expect(editor.getValue()).toBe('![[a.png|orig|center|1497|59]]');
  });

  it('reports false when the state is already what it would write', () => {
    const editor = new FakeEditor('![[a.png|r90]]');
    expect(applyOrientationState(asEditor(editor), 0, { turns: 1, mirror: false })).toBe(false);
  });
});
