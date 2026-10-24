/**
 * Tests for the post-paste correction. The structural half turns a line that
 * Obsidian glued together (`![[a]]![[b]]`) back into one embed per line; the
 * form half keeps each affected group on a single param grammar, resetting only
 * the members whose slots no longer match the row kind the paste left them in.
 */
import { describe, it, expect } from 'vitest';
import {
  isolateEmbedAtCaret,
  normalizePastedText,
  splitConcatenatedEmbeds,
} from '../src/imagePaste/pasteNormalizer';

const EXT = 'png,jpg,jpeg,gif,webp,svg,bmp,avif,mp4,webm';

describe('splitConcatenatedEmbeds', () => {
  it('splits a run of embeds into one per line, in order', () => {
    expect(splitConcatenatedEmbeds('![[a.png]]![[b.png]]![[c.png]]', EXT)).toEqual([
      '![[a.png]]',
      '![[b.png]]',
      '![[c.png]]',
    ]);
  });

  it('keeps the line indentation on every piece', () => {
    expect(splitConcatenatedEmbeds('  ![[a.png]]![[b.png]]', EXT)).toEqual([
      '  ![[a.png]]',
      '  ![[b.png]]',
    ]);
  });

  it('accepts whitespace between embeds', () => {
    expect(splitConcatenatedEmbeds('![[a.png]]  ![[b.png]]', EXT)).toEqual([
      '![[a.png]]',
      '![[b.png]]',
    ]);
  });

  it('handles video embeds', () => {
    expect(splitConcatenatedEmbeds('![[a.mp4]]![[b.png]]', EXT)).toEqual([
      '![[a.mp4]]',
      '![[b.png]]',
    ]);
  });

  it('leaves a solitary embed alone', () => {
    expect(splitConcatenatedEmbeds('![[a.png]]', EXT)).toBeNull();
  });

  it('leaves prose alone even when it carries embeds', () => {
    expect(splitConcatenatedEmbeds('见 ![[a.png]]![[b.png]]', EXT)).toBeNull();
  });
});

describe('isolateEmbedAtCaret', () => {
  it('splits the embed from text before it', () => {
    const line = 'text![[a.png]]';
    expect(isolateEmbedAtCaret(line, line.length, EXT)).toEqual(['text', '![[a.png]]']);
  });

  it('splits the embed from text after it', () => {
    const line = '![[a.png]]text';
    expect(isolateEmbedAtCaret(line, '![[a.png]]'.length, EXT)).toEqual([
      '![[a.png]]',
      'text',
    ]);
  });

  it('splits on both sides', () => {
    const line = 'a![[b.png]]c';
    expect(isolateEmbedAtCaret(line, 'a![[b.png]]'.length, EXT)).toEqual([
      'a',
      '![[b.png]]',
      'c',
    ]);
  });

  it('returns null when the embed already owns the line', () => {
    expect(isolateEmbedAtCaret('  ![[a.png]]  ', 13, EXT)).toBeNull();
  });

  it('returns null when the caret is before the embed end', () => {
    expect(isolateEmbedAtCaret('text![[a.png]]', 2, EXT)).toBeNull();
  });

  it('returns null when the line holds more than one embed', () => {
    expect(isolateEmbedAtCaret('![[a.png]]![[b.png]]', 17, EXT)).toBeNull();
  });
});

describe('normalizePastedText', () => {
  it('splits concatenated multi-row members and keeps their params', () => {
    const text =
      '![[a.png|orig|center|407|100]]![[b.png|orig|center|398|100]]' +
      '![[c.png|orig|center|422|100]]';
    const fix = normalizePastedText(text, 0, text.length, 10, EXT);

    expect(fix).not.toBeNull();
    expect(fix!.text.split('\n')).toEqual([
      '![[a.png|orig|center|407|100]]',
      '![[b.png|orig|center|398|100]]',
      '![[c.png|orig|center|422|100]]',
    ]);
    // The caret follows the paste: the last embed on the old line.
    expect(fix!.caretLine).toBe(2);
  });

  it('splits bare embeds without inventing params', () => {
    const text = '![[a.png]]![[b.png]]';
    const fix = normalizePastedText(text, 0, text.length, 10, EXT);
    expect(fix!.text.split('\n')).toEqual(['![[a.png]]', '![[b.png]]']);
  });

  it('strips single-row sizing from a member joining a row', () => {
    // The pasted multi-form member is fine; the single-form line it landed
    // against is not — as a member, `|0|400` would read as a near-zero share.
    const text = '![[b.png|orig|left|0|400]]![[a.png|orig|center|407|100]]';
    const fix = normalizePastedText(text, 0, text.length, 10, EXT);
    expect(fix!.text.split('\n')).toEqual([
      '![[b.png|orig]]',
      '![[a.png|orig|center|407|100]]',
    ]);
  });

  it('resets multi-row sizing when the pasted member lands alone', () => {
    const line = 'text![[a.png|orig|center|407|100]]';
    const fix = normalizePastedText(line, 0, line.length, 10, EXT);

    expect(fix!.text.split('\n')).toEqual(['text', '![[a.png|orig]]']);
    expect(fix!.caretLine).toBe(1);
  });

  it('keeps an alignment-only line intact', () => {
    const line = 'text![[a.png|left]]';
    const fix = normalizePastedText(line, 0, line.length, 10, EXT);
    expect(fix!.text.split('\n')).toEqual(['text', '![[a.png|left]]']);
  });

  it('keeps a clean single row untouched', () => {
    expect(normalizePastedText('![[a.png|orig|left|1|400]]', 0, 32, 10, EXT)).toBeNull();
  });

  it('ignores a paste that left no embed', () => {
    expect(normalizePastedText('just words', 0, 10, 10, EXT)).toBeNull();
  });

  it('respects maxImagesPerRow when judging the row kind', () => {
    // Two rows' worth of members: each chunk is still a multi row.
    const text = '![[a.png|0|400]]![[b.png|407|100]]';
    const fix = normalizePastedText(text, 0, text.length, 1, EXT);
    // The first line is now a single row on its own, so its single-form params
    // are legitimate; the second is a lone member too.
    expect(fix!.text.split('\n')).toEqual(['![[a.png|0|400]]', '![[b.png]]']);
  });
});
