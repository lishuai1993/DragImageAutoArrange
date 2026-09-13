/**
 * @vitest-environment jsdom
 *
 * Tests for the reference-paste interception, across both routes a copy can leave
 * its reference behind: the text flavour a Web-clipboard copy writes, and the
 * in-memory reference a native-JPEG copy arms. A paste carrying an embed that names
 * a real vault image must land as that reference, from either route, and every
 * other paste must fall through to Obsidian untouched.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { TFile, MarkdownView, type App } from 'obsidian';
import {
  embedLinkTarget,
  handleReferencePaste,
  resolveVaultImage,
} from '../src/imageMenu/referencePaste';
import { recallReference } from '../src/imageMenu/nativeClipboard';

// Hoisted above the imports, so TFile / MarkdownView below are these classes and
// `instanceof` narrows the way the source expects.
vi.mock('obsidian', () => {
  class MockTFile {}
  class MockMarkdownView {}
  return { TFile: MockTFile, MarkdownView: MockMarkdownView };
});

// The native route's reference lives in memory, not on the pasteboard; these tests
// drive that memory directly and use the text flavour for the Web route's cases.
vi.mock('../src/imageMenu/nativeClipboard', () => ({
  recallReference: vi.fn(() => null),
}));

const recall = vi.mocked(recallReference);

beforeEach(() => {
  recall.mockReturnValue(null);
});

function vaultFile(path: string, extension: string): object {
  return Object.assign(new TFile(), { path, extension });
}

interface Harness {
  app: App;
  target: Element;
  editor: { replaceSelection: ReturnType<typeof vi.fn> };
  preventDefault: ReturnType<typeof vi.fn>;
  stopPropagation: ReturnType<typeof vi.fn>;
}

function harness(options: {
  mode?: string;
  destination?: object | null;
} = {}): Harness {
  const containerEl = createDiv();
  const target = createSpan();
  containerEl.appendChild(target);

  const editor = { replaceSelection: vi.fn() };
  const view = Object.assign(new MarkdownView(), {
    editor,
    file: { path: 'notes/note.md' },
    containerEl,
    getMode: () => options.mode ?? 'source',
  });

  const app = {
    workspace: { getLeavesOfType: () => [{ view }] },
    metadataCache: { getFirstLinkpathDest: () => options.destination ?? null },
  } as unknown as App;

  return {
    app,
    target,
    editor,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

function paste(h: Harness, text: string): ClipboardEvent {
  const event = {
    target: h.target,
    clipboardData: { getData: () => text },
    preventDefault: h.preventDefault,
    stopPropagation: h.stopPropagation,
  };
  return event as unknown as ClipboardEvent;
}

describe('embedLinkTarget', () => {
  it('reads the target of a bare embed', () => {
    expect(embedLinkTarget('![[pic.png]]')).toBe('pic.png');
  });

  it('ignores params, alignment and fragments', () => {
    expect(embedLinkTarget('![[pic.png|left|0|400]]')).toBe('pic.png');
    expect(embedLinkTarget('![[pic.png#heading]]')).toBe('pic.png');
    expect(embedLinkTarget('  ![[Folder/pic.png|1|300]]  ')).toBe('Folder/pic.png');
  });

  it('rejects anything that is not one lone embed', () => {
    expect(embedLinkTarget('see ![[pic.png]] here')).toBeNull();
    expect(embedLinkTarget('https://example.com/pic.png')).toBeNull();
    expect(embedLinkTarget('[[pic.png]]')).toBeNull();
    expect(embedLinkTarget('')).toBeNull();
  });
});

describe('resolveVaultImage', () => {
  it('accepts a resolved non-markdown file', () => {
    const app = { metadataCache: { getFirstLinkpathDest: () => vaultFile('img/a.png', 'png') } };
    expect(resolveVaultImage(app as unknown as App, 'a.png', 'notes/n.md')).not.toBeNull();
  });

  it('rejects a note and an unresolved link', () => {
    const note = { metadataCache: { getFirstLinkpathDest: () => vaultFile('n.md', 'md') } };
    const missing = { metadataCache: { getFirstLinkpathDest: () => null } };
    expect(resolveVaultImage(note as unknown as App, 'n', 'notes/n.md')).toBeNull();
    expect(resolveVaultImage(missing as unknown as App, 'ghost.png', 'notes/n.md')).toBeNull();
  });
});

describe('handleReferencePaste', () => {
  const image = vaultFile('img/a.png', 'png');

  it('inserts a vault image reference instead of letting an attachment be made', () => {
    const h = harness({ destination: image });
    const event = paste(h, '![[img/a.png]]');

    expect(handleReferencePaste(h.app, event)).toBe(true);
    expect(h.preventDefault).toHaveBeenCalled();
    expect(h.stopPropagation).toHaveBeenCalled();
    expect(h.editor.replaceSelection).toHaveBeenCalledWith('![[img/a.png]]');
  });

  it('preserves the params of a reference copied out of a note', () => {
    const h = harness({ destination: image });
    handleReferencePaste(h.app, paste(h, '![[img/a.png|left|0|400]]'));
    expect(h.editor.replaceSelection).toHaveBeenCalledWith('![[img/a.png|left|0|400]]');
  });

  it('falls through for text that is not an embed', () => {
    const h = harness({ destination: image });
    expect(handleReferencePaste(h.app, paste(h, 'plain words'))).toBe(false);
    expect(h.editor.replaceSelection).not.toHaveBeenCalled();
  });

  it('falls through when the link resolves to no vault image', () => {
    const h = harness({ destination: vaultFile('notes/other.md', 'md') });
    expect(handleReferencePaste(h.app, paste(h, '![[other]]'))).toBe(false);
    expect(h.editor.replaceSelection).not.toHaveBeenCalled();
  });

  it('falls through in reading mode', () => {
    const h = harness({ destination: image, mode: 'preview' });
    expect(handleReferencePaste(h.app, paste(h, '![[img/a.png]]'))).toBe(false);
  });

  it('falls through outside any markdown view', () => {
    const h = harness({ destination: image });
    const stray = { workspace: { getLeavesOfType: () => [] } } as unknown as App;
    expect(handleReferencePaste(stray, paste(h, '![[img/a.png]]'))).toBe(false);
  });
});

describe('handleReferencePaste — native JPEG route', () => {
  const image = vaultFile('img/a.png', 'png');

  it('inserts the remembered reference when the paste carries no text flavour', () => {
    recall.mockReturnValue('![[img/a.png]]');
    const h = harness({ destination: image });
    const event = paste(h, '');

    expect(handleReferencePaste(h.app, event)).toBe(true);
    expect(h.preventDefault).toHaveBeenCalled();
    expect(h.editor.replaceSelection).toHaveBeenCalledWith('![[img/a.png]]');
  });

  it('falls through when the memory holds nothing', () => {
    const h = harness({ destination: image });
    expect(handleReferencePaste(h.app, paste(h, ''))).toBe(false);
    expect(h.editor.replaceSelection).not.toHaveBeenCalled();
  });

  it('ignores a remembered value that is not an embed', () => {
    recall.mockReturnValue('plain words');
    const h = harness({ destination: image });
    expect(handleReferencePaste(h.app, paste(h, ''))).toBe(false);
  });

  it('falls through when the remembered reference names no vault image', () => {
    recall.mockReturnValue('![[gone.png]]');
    const h = harness({ destination: null });
    expect(handleReferencePaste(h.app, paste(h, ''))).toBe(false);
    expect(h.editor.replaceSelection).not.toHaveBeenCalled();
  });

  it('prefers the text flavour when the paste carries one', () => {
    recall.mockReturnValue('![[img/other.png]]');
    const h = harness({ destination: image });
    handleReferencePaste(h.app, paste(h, '![[img/a.png]]'));
    expect(h.editor.replaceSelection).toHaveBeenCalledWith('![[img/a.png]]');
  });
});
