import { describe, it, expect } from 'vitest';
import { normalizeAnchorText } from '../src/anchor/textAnchor';

describe('normalizeAnchorText', () => {
  describe('leading block markers', () => {
    it('strips ATX headings', () => {
      expect(normalizeAnchorText('## Notes')).toBe('Notes');
      expect(normalizeAnchorText('###### Deep')).toBe('Deep');
    });
    it('leaves a #tag (no space) untouched', () => {
      expect(normalizeAnchorText('#tag here')).toBe('#tag here');
    });
    it('strips blockquote chains', () => {
      expect(normalizeAnchorText('> quoted')).toBe('quoted');
      expect(normalizeAnchorText('> > nested')).toBe('nested');
    });
    it('strips list bullets and ordered numbers', () => {
      expect(normalizeAnchorText('- item')).toBe('item');
      expect(normalizeAnchorText('* star')).toBe('star');
      expect(normalizeAnchorText('+ plus')).toBe('plus');
      expect(normalizeAnchorText('3. third')).toBe('third');
    });
    it('strips task checkboxes after the bullet', () => {
      expect(normalizeAnchorText('- [ ] todo')).toBe('todo');
      expect(normalizeAnchorText('- [x] done')).toBe('done');
      expect(normalizeAnchorText('- [X] DONE')).toBe('DONE');
    });
    it('peels nested prefixes layer by layer', () => {
      expect(normalizeAnchorText('> - [ ] quoted task')).toBe('quoted task');
    });
  });

  describe('inline markers', () => {
    it('strips bold, italic, code, strikethrough', () => {
      expect(normalizeAnchorText('**bold**')).toBe('bold');
      expect(normalizeAnchorText('__bold__')).toBe('bold');
      expect(normalizeAnchorText('*it*')).toBe('it');
      expect(normalizeAnchorText('_it_')).toBe('it');
      expect(normalizeAnchorText('`code`')).toBe('code');
      expect(normalizeAnchorText('~~gone~~')).toBe('gone');
    });
    it('collapses nested emphasis fully', () => {
      expect(normalizeAnchorText('**_x_**')).toBe('x');
    });
    it('handles emphasis mid-sentence', () => {
      expect(normalizeAnchorText('a **b** c')).toBe('a b c');
    });
  });

  describe('links', () => {
    it('wikilink with alias renders the alias', () => {
      expect(normalizeAnchorText('see [[note|alias]] here')).toBe('see alias here');
    });
    it('wikilink without alias renders the target', () => {
      expect(normalizeAnchorText('see [[note]] here')).toBe('see note here');
    });
    it('markdown link renders the display text', () => {
      expect(normalizeAnchorText('[text](https://x.com)')).toBe('text');
    });
    it('markdown image renders the alt text', () => {
      expect(normalizeAnchorText('![alt](img.png)')).toBe('alt');
    });
  });

  describe('mixed and edge cases', () => {
    it('normalizes a heading with a wikilink alias (LP↔RM convergence)', () => {
      expect(normalizeAnchorText('## See [[foo|Bar]]')).toBe('See Bar');
    });
    it('is idempotent on already-plain text (RM textContent case)', () => {
      const plain = 'just some plain words';
      expect(normalizeAnchorText(plain)).toBe(plain);
      expect(normalizeAnchorText(normalizeAnchorText(plain))).toBe(plain);
    });
    it('LP source and RM rendered text converge to the same string', () => {
      // A heading with bold: LP holds the source, RM holds Obsidian's render.
      const lpSource = '## **Important** [[topic|Topic]]';
      const rmRendered = 'Important Topic';
      expect(normalizeAnchorText(lpSource)).toBe(normalizeAnchorText(rmRendered));
    });
    it('returns empty for a pure-marker line', () => {
      expect(normalizeAnchorText('## ')).toBe('');
      expect(normalizeAnchorText('- [ ] ')).toBe('');
      expect(normalizeAnchorText('>')).toBe('');
    });
    it('collapses runs of whitespace and trims', () => {
      expect(normalizeAnchorText('  a   b  ')).toBe('a b');
    });
  });
});
