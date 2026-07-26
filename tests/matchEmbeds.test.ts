import { describe, it, expect } from 'vitest';
import { matchEmbedsToParsed } from '../src/imageParse/matchEmbeds';
import { ImageEmbed } from '../src/imageParse/imageDetector';

// Minimal ImageEmbed factory — only the fields matching cares about matter.
function emb(fileName: string, line: number, extra: Partial<ImageEmbed> = {}): ImageEmbed {
  return {
    line,
    raw: `![[${fileName}]]`,
    fileName,
    explicitWidth: null,
    hasExplicitWidth: false,
    flexGrow: 1,
    scale: null,
    ...extra,
  };
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
});
