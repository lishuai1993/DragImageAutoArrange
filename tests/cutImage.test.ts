import { describe, it, expect } from 'vitest';
import {
  countOtherRefs,
  cutImageKeptNotice,
  cutMenuItemEnabled,
  decideCut,
  normalizeRowAfterRemoval,
  sourceLineFromMarkers,
} from '../src/imageMenu/cutImage';
import { setLanguage } from '../src/i18n/language';
import { planImageLinkRemoval, removeImageLinkOccurrences } from '../src/imageMenu/noteLinks';
import { lineStartOffset, minimalTextChange } from '../src/imageMenu/noteEdit';

const IMG = 'assets/a.png';
const NOTE = 'notes/here.md';

describe('decideCut', () => {
  it('deletes the file when the cut removed the last reference', () => {
    expect(decideCut({ other: 0, liveInCurrent: 1, removed: 1 })).toEqual({
      remaining: 0,
      deleteFile: true,
    });
  });

  it('keeps the file while the note still holds a reference', () => {
    // Three embeds of the same image in one note; cutting one leaves two.
    expect(decideCut({ other: 0, liveInCurrent: 3, removed: 1 })).toEqual({
      remaining: 2,
      deleteFile: false,
    });
  });

  it('keeps the file while other notes reference it', () => {
    expect(decideCut({ other: 2, liveInCurrent: 1, removed: 1 })).toEqual({
      remaining: 2,
      deleteFile: false,
    });
  });

  it('never deletes when no reference could be removed', () => {
    // The image renders, yet the note has no link we can find (an embed of
    // another note, or a stale cache). Without a removal we know nothing.
    expect(decideCut({ other: 0, liveInCurrent: 0, removed: 0 }).deleteFile).toBe(false);
    expect(decideCut({ other: 0, liveInCurrent: 3, removed: 0 }).deleteFile).toBe(false);
  });

  it('counts remaining references as other + note leftovers', () => {
    expect(decideCut({ other: 4, liveInCurrent: 3, removed: 1 }).remaining).toBe(6);
  });
});

describe('countOtherRefs', () => {
  it('excludes the note the cut came from', () => {
    expect(countOtherRefs({ [NOTE]: { [IMG]: 3 }, 'notes/x.md': { [IMG]: 2 } }, IMG, NOTE)).toBe(2);
  });

  it('ignores unrelated and zero-count targets', () => {
    expect(
      countOtherRefs({ 'notes/x.md': { [IMG]: 0, 'assets/b.png': 4 } }, IMG, NOTE)
    ).toBe(0);
  });

  it('treats a missing map as no references', () => {
    expect(countOtherRefs(undefined, IMG, NOTE)).toBe(0);
    expect(countOtherRefs(null, IMG, NOTE)).toBe(0);
  });
});

describe('sourceLineFromMarkers', () => {
  it('converts Reading Mode’s 1-based data-diaa-line', () => {
    expect(sourceLineFromMarkers(undefined, undefined, '7')).toBe(6);
  });

  it('adds the Live Preview row start and member index', () => {
    expect(sourceLineFromMarkers('10', '2', undefined)).toBe(12);
  });

  it('treats a Live Preview row without an index as its first member', () => {
    expect(sourceLineFromMarkers('10', undefined, undefined)).toBe(10);
  });

  it('returns null when neither anchor is present', () => {
    expect(sourceLineFromMarkers(undefined, undefined, undefined)).toBeNull();
    expect(sourceLineFromMarkers(undefined, undefined, '0')).toBeNull();
  });
});

describe('normalizeRowAfterRemoval', () => {
  it('drops the line the reference was cut from once it is empty', () => {
    const before = 'text\n![[a.png]]\ntext';
    expect(normalizeRowAfterRemoval('text\n\ntext', 1)).toBe('text\ntext');
    expect(before.split('\n')).toHaveLength(3);
  });

  it('rewrites a two-member row’s survivor to the bare form', () => {
    // Cutting the first of two members leaves the second one on its own.
    expect(normalizeRowAfterRemoval('\n![[a.png|150|100]]', 0)).toBe('![[a.png]]');
    // Cutting the second leaves the first one on its own.
    expect(normalizeRowAfterRemoval('![[a.png|150|100]]\n', 1)).toBe('![[a.png]]');
  });

  it('leaves a row that still has two members alone', () => {
    // A three-member row lost its first member; two remain, weights untouched.
    const after = '\n![[a.png|150|100]]\n![[b.png|150|100]]';
    expect(normalizeRowAfterRemoval(after, 0)).toBe('![[a.png|150|100]]\n![[b.png|150|100]]');
  });

  it('leaves an already-clean single-image row alone', () => {
    expect(normalizeRowAfterRemoval('\n![[a.png|0|300]]', 0)).toBe('![[a.png|0|300]]');
    expect(normalizeRowAfterRemoval('\n![[a.png]]', 0)).toBe('![[a.png]]');
  });

  it('keeps text that shares the line with the reference', () => {
    expect(normalizeRowAfterRemoval('keep me \nnext', 0)).toBe('keep me \nnext');
  });

  it('does nothing without a removal line', () => {
    expect(normalizeRowAfterRemoval('![[a.png|150|100]]', null)).toBe('![[a.png|150|100]]');
  });
});

describe('cutImageKeptNotice', () => {
  it('matches the agreed wording in both languages', () => {
    setLanguage('zh');
    expect(cutImageKeptNotice(3)).toBe('仅剪切图像引用（文件仍被 3 处引用）');
    setLanguage('en');
    expect(cutImageKeptNotice(3)).toBe(
      'Only the reference was cut (the file is still referenced 3 times elsewhere)'
    );
  });
});

describe('cutMenuItemEnabled', () => {
  it('allows cut for a DIAA-managed image in Live Preview', () => {
    expect(cutMenuItemEnabled(true, false)).toBe(true);
  });

  it('forbids cut in Reading Mode even for a DIAA-managed image', () => {
    expect(cutMenuItemEnabled(true, true)).toBe(false);
  });

  it('forbids cut for a non-DIAA image in Live Preview', () => {
    expect(cutMenuItemEnabled(false, false)).toBe(false);
  });

  it('forbids cut for a non-DIAA image in Reading Mode', () => {
    expect(cutMenuItemEnabled(false, true)).toBe(false);
  });
});

// ── noteEdit: minimalTextChange / lineStartOffset ──────────────────────────

describe('minimalTextChange', () => {
  it('reports no change for identical texts', () => {
    expect(minimalTextChange('abc', 'abc')).toBeNull();
    expect(minimalTextChange('', '')).toBeNull();
  });

  it('trims the common prefix and suffix down to the edited spot', () => {
    expect(minimalTextChange('hello world', 'hello brave world')).toEqual({
      from: 6,
      to: 6,
      insert: 'brave ',
    });
  });

  it('covers a pure deletion', () => {
    expect(minimalTextChange('a\nb\nc', 'a\nc')).toEqual({ from: 2, to: 4, insert: '' });
  });

  it('covers an insertion into an empty document', () => {
    expect(minimalTextChange('', 'x')).toEqual({ from: 0, to: 0, insert: 'x' });
  });

  it('covers an edit at the very end', () => {
    expect(minimalTextChange('abc', 'abcd')).toEqual({ from: 3, to: 3, insert: 'd' });
  });

  it('covers a whole-document swap', () => {
    expect(minimalTextChange('aaa', 'bbb')).toEqual({ from: 0, to: 3, insert: 'bbb' });
  });

  it('rebuilds the target when applied', () => {
    const before = 'one\ntwo\nthree';
    const change = minimalTextChange(before, 'one\nthree')!;
    expect(before.slice(0, change.from) + change.insert + before.slice(change.to)).toBe('one\nthree');
  });
});

describe('lineStartOffset', () => {
  const text = 'one\ntwo\nthree';

  it('is zero for the first line', () => {
    expect(lineStartOffset(text, 0)).toBe(0);
  });

  it('points just past the preceding newline', () => {
    expect(lineStartOffset(text, 1)).toBe(4);
    expect(lineStartOffset(text, 2)).toBe(8);
  });

  it('reports the text length for a line past the end', () => {
    expect(lineStartOffset(text, 9)).toBe(text.length);
  });

  it('lands on the previous line end once one is subtracted', () => {
    expect(lineStartOffset(text, 1) - 1).toBe(3);
  });
});

// ── noteLinks: planImageLinkRemoval / removeImageLinkOccurrences ───────────

function makeApp(files: Record<string, string>, activePath = NOTE) {
  const paths = Object.keys(files);
  return {
    workspace: { getActiveFile: () => ({ path: activePath }) },
    vault: {
      process: async (file: { path: string }, fn: (data: string) => string) => {
        const next = fn(files[file.path]);
        files[file.path] = next;
        return next;
      },
    },
    metadataCache: {
      getFirstLinkpathDest: (linkPath: string) => {
        const hit = paths.find(
          p => p === linkPath || p.split('/').pop() === linkPath || p.endsWith(`/${linkPath}`)
        );
        return hit ? { path: hit } : null;
      },
    },
  };
}

const note = (text: string) => ({ 'notes/here.md': text, 'assets/a.png': '', 'assets/b.png': '' });
const image = { path: IMG } as never;
const noteFile = { path: NOTE } as never;

type RemovalOpts = {
  max?: number;
  line?: number | null;
  afterRemoval?: (content: string, removedLine: number | null) => string;
};

const plan = (files: Record<string, string>, opts: RemovalOpts = {}) =>
  planImageLinkRemoval(makeApp(files), files[NOTE], image, noteFile, opts);

describe('planImageLinkRemoval', () => {
  it('removes one of several identical references and reports the counts', () => {
    const result = plan(note('![[a.png]]\n![[a.png]]\n![[a.png]]'));

    expect(result).toEqual({ next: '\n![[a.png]]\n![[a.png]]', found: 3, removed: 1 });
  });

  it('restricts the removal to the requested line', () => {
    const result = plan(note('![[a.png]]\n![[a.png]]\n![[a.png]]'), { line: 1 });

    expect(result.next).toBe('![[a.png]]\n\n![[a.png]]');
  });

  it('removes nothing when the requested line holds no reference', () => {
    const result = plan(note('![[a.png]]\nplain text'), { line: 1 });

    expect(result.removed).toBe(0);
    expect(result.next).toBe('![[a.png]]\nplain text');
  });

  it('ignores links inside code fences', () => {
    const result = plan(note('```\n![[a.png]]\n```\n'));

    expect(result).toEqual({ next: '```\n![[a.png]]\n```\n', found: 0, removed: 0 });
  });

  it('handles markdown-style references', () => {
    const result = plan(note('![a](a.png)\n![a](a.png)'));

    expect(result).toEqual({ next: '\n![a](a.png)', found: 2, removed: 1 });
  });

  it('leaves references to other images alone', () => {
    const result = plan(note('![[a.png]]\n![[b.png]]'));

    expect(result).toEqual({ next: '\n![[b.png]]', found: 1, removed: 1 });
  });

  it('hands the rewritten content and the removal line to afterRemoval', () => {
    const seen: Array<number | null> = [];
    const result = plan(note('![[a.png|150|100]]\n![[a.png|150|100]]'), {
      afterRemoval: (content, line) => {
        seen.push(line);
        return normalizeRowAfterRemoval(content, line);
      },
    });

    expect(seen).toEqual([0]);
    expect(result.next).toBe('![[a.png]]');
  });

  it('keeps frontmatter out of the line numbering', () => {
    const seen: Array<number | null> = [];
    const result = plan(note('---\nkey: value\n---\n![[a.png]]\n![[a.png]]'), {
      line: 3,
      afterRemoval: (content, line) => {
        seen.push(line);
        return content;
      },
    });

    // Frontmatter occupies lines 0-2, so the requested line 3 is the first embed.
    expect(seen).toEqual([0]);
    expect(result.next).toBe('---\nkey: value\n---\n\n![[a.png]]');
  });
});

describe('removeImageLinkOccurrences (vault fallback)', () => {
  it('writes the planned text through vault.process', async () => {
    const files = note('![[a.png]]\n![[a.png]]');
    const result = await removeImageLinkOccurrences(makeApp(files), image);

    expect(result).toEqual({ found: 2, removed: 1 });
    expect(files[NOTE]).toBe('\n![[a.png]]');
  });

  it('does nothing when the active file is the image itself', async () => {
    const files = note('![[a.png]]');
    const result = await removeImageLinkOccurrences(makeApp(files, IMG), image);

    expect(result).toEqual({ found: 0, removed: 0 });
    expect(files[NOTE]).toBe('![[a.png]]');
  });
});
