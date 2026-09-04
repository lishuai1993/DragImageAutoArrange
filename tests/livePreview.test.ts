import { describe, it, expect, vi } from 'vitest';

vi.mock('obsidian', () => ({
  editorLivePreviewField: {},
}));

vi.mock('@codemirror/state', () => ({
  StateField: { define: () => ({}) },
  StateEffect: { define: () => ({}) },
  Prec: { highest: (x: unknown) => x },
  Annotation: { define: () => ({}) },
  EditorState: {},
}));

vi.mock('@codemirror/view', () => ({
  Decoration: {
    replace: () => ({ range: () => ({}) }),
    widget: () => ({ widget: {} }),
  },
  ViewPlugin: { fromClass: () => ({}) },
  WidgetType: class {},
  EditorView: {},
}));

import { normalizeRaw } from '../src/imageRender/livePreview';

// ── normalizeRaw ──
describe('normalizeRaw', () => {
  it('strips width parameter between pipe and ]]', () => {
    expect(normalizeRaw('![[image.png|200]]')).toBe('![[image.png]]');
  });

  it('strips dimensions parameter', () => {
    expect(normalizeRaw('![[image.png|800x600]]')).toBe('![[image.png]]');
  });

  it('strips multi-part parameter (width|dimensions)', () => {
    expect(normalizeRaw('![[image.png|200|800x600]]')).toBe('![[image.png]]');
  });

  it('returns unchanged if no pipe parameter', () => {
    expect(normalizeRaw('![[image.png]]')).toBe('![[image.png]]');
  });

  it('strips from first pipe when filename contains pipes', () => {
    // "file|name.png|200" → regex matches "|name.png|200" → result "![[file]]"
    // Wait: regex is \|[^\]]*(?=]])
    // In "file|name.png|200", [^\]]* matches "name.png|200"
    // So result is "![[file]]"
    // Actually: the filename part is "file|name.png" (with a pipe in the name).
    // The regex matches the FIRST pipe that is followed by non-] chars before ]].
    // In `![[file|name.png|200]]`, the first | is between file and name.png.
    // [^\]]* matches "name.png|200". So normalizeRaw strips "|name.png|200".
    // Result: `![[file]]`.
    // This edge case behavior is a known limitation.
    const result = normalizeRaw('![[file|name.png|200]]');
    // The first | before ]] is at "name.png", stripping to "![[file]]"
    expect(result).toBe('![[file]]');
  });
});
