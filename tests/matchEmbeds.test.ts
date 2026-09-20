import { describe, it, expect } from 'vitest';
import { matchEmbedsToParsed } from '../src/imageParse/matchEmbeds';

// Minimal parsed-embed factory — matching only ever reads fileName, everything
// else is passed through untouched on the matched record.  Shape mirrors the
// fields the asserts below inspect (a RowImage in production carries more).
interface Embed {
  fileName: string;
  line: number;
  alignment?: 'left' | 'center' | 'right';
  hasExplicitWidth?: boolean;
  flexGrow?: number;
  scale?: number | null;
}
function emb(fileName: string, line: number, extra: Partial<Embed> = {}): Embed {
  return { fileName, line, ...extra };
}

describe('matchEmbedsToParsed', () => {
  it('matches a section 1:1 by filename in source order', () => {
    const candidates = [emb('a.png', 10), emb('b.png', 11), emb('c.png', 12)];
    const r = matchEmbedsToParsed(['a.png', 'b.png', 'c.png'], candidates, candidates);
    expect(r.usedFallback).toBe(false);
    expect(r.mismatches).toBe(0);
    expect(r.matches.map((m) => m?.line)).toEqual([10, 11, 12]);
  });

  it('disambiguates duplicate filenames within a section by position', () => {
    const candidates = [emb('dup.png', 10), emb('dup.png', 11), emb('dup.png', 12)];
    const r = matchEmbedsToParsed(['dup.png', 'dup.png', 'dup.png'], candidates, candidates);
    expect(r.usedFallback).toBe(false);
    expect(r.matches.map((m) => m?.line)).toEqual([10, 11, 12]);
  });

  it('skips already-wrapped embeds (fewer embeds than candidates) and stays aligned', () => {
    // Section has 3 parsed images; a prior run already wrapped the first, so
    // only b and c remain as fresh embeds.
    const candidates = [emb('a.png', 10), emb('b.png', 11), emb('c.png', 12)];
    const r = matchEmbedsToParsed(['b.png', 'c.png'], candidates, candidates);
    expect(r.usedFallback).toBe(false);
    expect(r.mismatches).toBe(0);
    expect(r.matches.map((m) => m?.line)).toEqual([11, 12]);
  });

  it('uses positional match for embeds with unknown (null) filename', () => {
    const candidates = [emb('a.png', 10), emb('b.png', 11)];
    const r = matchEmbedsToParsed([null, null], candidates, candidates);
    // Null filenames are unverifiable → never counted as mismatch.
    expect(r.mismatches).toBe(0);
    expect(r.usedFallback).toBe(false);
    expect(r.matches.map((m) => m?.line)).toEqual([10, 11]);
  });

  it('degrades to filename-only global match when the section scope disagrees', () => {
    // Section candidates are WRONG for these embeds (e.g. getSectionInfo drift):
    // section-scoped matching cannot satisfy them, so it must fall back to the
    // global pool and recover by filename.
    const sectionCandidates = [emb('x.png', 5), emb('y.png', 6)];
    const allParsed = [
      emb('x.png', 5),
      emb('y.png', 6),
      emb('a.png', 20, { scale: 0.5 }),
      emb('b.png', 21, { scale: 0.7 }),
    ];
    const r = matchEmbedsToParsed(['a.png', 'b.png'], sectionCandidates, allParsed);
    expect(r.usedFallback).toBe(true);
    expect(r.mismatches).toBe(0);
    expect(r.matches.map((m) => m?.line)).toEqual([20, 21]);
    expect(r.matches.map((m) => m?.scale)).toEqual([0.5, 0.7]);
  });

  it('reports residual mismatches when a filename exists nowhere', () => {
    const candidates = [emb('a.png', 10)];
    const allParsed = candidates;
    const r = matchEmbedsToParsed(['a.png', 'ghost.png'], candidates, allParsed);
    // 'ghost.png' triggers the integrity failure → fallback → still unmatched.
    expect(r.usedFallback).toBe(true);
    expect(r.mismatches).toBe(1);
    expect(r.matches[0]?.line).toBe(10);
    expect(r.matches[1]).toBeNull();
  });

  it('carries alignment / flexGrow / scale through to the matched record', () => {
    const candidates = [
      emb('a.png', 10, { alignment: 'right', hasExplicitWidth: true, flexGrow: 1.2, scale: 0.63 }),
    ];
    const r = matchEmbedsToParsed(['a.png'], candidates, candidates);
    expect(r.matches[0]?.alignment).toBe('right');
    expect(r.matches[0]?.hasExplicitWidth).toBe(true);
    expect(r.matches[0]?.flexGrow).toBe(1.2);
    expect(r.matches[0]?.scale).toBe(0.63);
  });

  it('handles an empty section (no embeds)', () => {
    const r = matchEmbedsToParsed([], [emb('a.png', 10)], [emb('a.png', 10)]);
    expect(r.matches).toEqual([]);
    expect(r.mismatches).toBe(0);
    expect(r.usedFallback).toBe(false);
  });

  // The parser keeps the link verbatim (`图片集/a.png`), the DOM reader can only
  // see `img.src` and takes its last segment (`a.png`).  Comparing raw strings
  // makes every subfolder link disagree with its own line: the primary match
  // fails, the integrity check reports failure, and the row renders with
  // somebody else's params.  Both sides are compared by basename now.
  it('matches a subfolder link against the DOM basename', () => {
    const candidates = [emb('图片集/a.png', 43), emb('图片集/b.png', 44)];
    const r = matchEmbedsToParsed(['a.png', 'b.png'], candidates, candidates);
    expect(r.usedFallback).toBe(false);
    expect(r.mismatches).toBe(0);
    expect(r.matches.map((m) => m?.line)).toEqual([43, 44]);
  });

  it('matches a subfolder link without degrading to a same-named earlier line', () => {
    // A duplicate attachment earlier in the document must not capture the
    // section's params: with basename-normalized primary matching, the
    // section's own lines win outright and the fallback is never consulted.
    const allParsed = [
      emb('图片集/x.webp', 10, { scale: 0.3 }),
      emb('图片集/y.webp', 11, { scale: 0.3 }),
      emb('图片集/x.webp', 43, { scale: 0.5 }),
      emb('图片集/y.webp', 44, { scale: 1 }),
    ];
    const candidates = [allParsed[2], allParsed[3]];
    const r = matchEmbedsToParsed(['x.webp', 'y.webp'], candidates, allParsed);
    expect(r.usedFallback).toBe(false);
    expect(r.mismatches).toBe(0);
    expect(r.matches.map((m) => m?.line)).toEqual([43, 44]);
    expect(r.matches.map((m) => m?.scale)).toEqual([0.5, 1]);
  });

  it('prefers the section pool over a document-wide first hit on a mismatch tie', () => {
    // The degrade path is a bare-name hunt, so the *first* line in the document
    // carrying a name wins — for a duplicated attachment that is a different row
    // entirely.  When both pools resolve the same number of names, the section's
    // own records are the trustworthy ones.
    const sectionCandidates = [emb('a.png', 10, { scale: 0.5 })];
    const allParsed = [emb('b.png', 2, { scale: 0.9 })];
    const r = matchEmbedsToParsed(['b.png', 'a.png'], sectionCandidates, allParsed);
    expect(r.usedFallback).toBe(true);
    // Both pools leave exactly one name unresolved; the section pool keeps the
    // second embed pointed at (null, a@10) instead of (b@2, null).
    expect(r.mismatches).toBe(1);
    expect(r.matches[0]).toBeNull();
    expect(r.matches[1]?.line).toBe(10);
    expect(r.matches[1]?.scale).toBe(0.5);
  });
});
