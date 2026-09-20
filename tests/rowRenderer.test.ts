/**
 * @vitest-environment jsdom
 *
 * Pins the two shared DOM helpers the drag paths own:
 *
 *  - `neutralizeWrappers` — the single place both render paths flatten an
 *    intermediate wrapper between an img and its boundary.  The wrapper has to
 *    stop being a box for the img to be a flex child of the item, and the
 *    declaration is written inline because that wrapper's styling is Obsidian's,
 *    which a plugin class cannot outrank on specificity;
 *  - `applyDropIndicator` — paints and clears the three drop-indicator states
 *    on a CodeMirror line, whose own styling the platform repaints.
 *
 * Both keep a class alongside the inline write; the class marks the state, it
 * does not style anything.  Hex colours read back as `rgb()` — that is jsdom's
 * CSSOM normalizing them, not the helpers writing something else.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { neutralizeWrappers, applyDropIndicator } from '../src/imageRender/rowRenderer';

describe('neutralizeWrappers', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('flattens an intermediate wrapper inline, and marks it', () => {
    const boundary = document.body.createDiv({ cls: 'diaa-row' });
    const wrapper = boundary.createDiv({ cls: 'image-wrapper' });
    const img = wrapper.createEl('img');

    neutralizeWrappers(img, boundary);

    expect(wrapper.style.getPropertyValue('display')).toBe('contents');
    expect(wrapper.style.getPropertyPriority('display')).toBe('important');
    expect(wrapper.classList.contains('diaa-contents')).toBe(true);
  });

  it('walks the whole chain up to the boundary', () => {
    const boundary = document.body.createDiv({ cls: 'diaa-row' });
    const outer = boundary.createDiv({ cls: 'image-wrapper' });
    const inner = outer.createDiv({ cls: 'some-other-wrapper' });
    const img = inner.createEl('img');

    neutralizeWrappers(img, boundary);

    expect(outer.style.getPropertyValue('display')).toBe('contents');
    expect(inner.style.getPropertyValue('display')).toBe('contents');
    // The boundary itself is never touched — it is the flex container.
    expect(boundary.style.getPropertyValue('display')).toBe('');
  });

  it('skips the elements the caller reserves', () => {
    const boundary = document.body.createDiv({ cls: 'diaa-row' });
    const item = boundary.createDiv({ cls: 'diaa-item' });
    const wrapper = item.createDiv({ cls: 'image-wrapper' });
    const img = wrapper.createEl('img');

    neutralizeWrappers(img, boundary, [item]);

    expect(wrapper.style.getPropertyValue('display')).toBe('contents');
    expect(item.style.getPropertyValue('display')).toBe('');
    expect(item.classList.contains('diaa-contents')).toBe(false);
  });

  it('leaves an img that already sits in the boundary alone', () => {
    const boundary = document.body.createDiv({ cls: 'diaa-row' });
    const img = boundary.createEl('img');

    neutralizeWrappers(img, boundary);

    expect(boundary.style.getPropertyValue('display')).toBe('');
  });
});

describe('applyDropIndicator', () => {
  let line: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    line = document.body.createDiv({ cls: 'cm-line' });
  });

  function props(el: HTMLElement): Record<string, string> {
    return {
      background: el.style.getPropertyValue('background-color'),
      shadow: el.style.getPropertyValue('box-shadow'),
      radius: el.style.getPropertyValue('border-radius'),
      left: el.style.getPropertyValue('border-left'),
      right: el.style.getPropertyValue('border-right'),
    };
  }

  it('paints the line state inline, with priority', () => {
    applyDropIndicator(line, 'line');

    expect(line.style.getPropertyValue('background-color')).toBe('rgba(74, 158, 255, 0.15)');
    expect(line.style.getPropertyValue('box-shadow')).not.toBe('');
    expect(line.style.getPropertyValue('border-radius')).toBe('3px');
    expect(line.style.getPropertyPriority('background-color')).toBe('important');
  });

  it('paints one side at a time', () => {
    applyDropIndicator(line, 'left');
    expect(line.style.getPropertyValue('border-left')).toBe('3px solid rgb(74, 158, 255)');
    expect(line.style.getPropertyValue('border-right')).toBe('');
    expect(line.style.getPropertyValue('border-radius')).toBe('3px 0 0 3px');

    // Painting the other side must not leave the first one behind.
    applyDropIndicator(line, 'right');
    expect(line.style.getPropertyValue('border-left')).toBe('');
    expect(line.style.getPropertyValue('border-right')).toBe('3px solid rgb(74, 158, 255)');
    expect(line.style.getPropertyValue('border-radius')).toBe('0 3px 3px 0');
  });

  it('clears everything a previous state may have painted', () => {
    applyDropIndicator(line, 'line');
    applyDropIndicator(line, null);
    expect(props(line)).toEqual({ background: '', shadow: '', radius: '', left: '', right: '' });

    applyDropIndicator(line, 'left');
    applyDropIndicator(line, null);
    expect(props(line)).toEqual({ background: '', shadow: '', radius: '', left: '', right: '' });
  });

  it('clears a shadow the flex-row branch wrote without priority', () => {
    // showDropIndicator writes the row target's shadow with plain setCssStyles;
    // clearing has to take that one out too, not only its own.
    line.setCssStyles({ boxShadow: 'inset 3px 0 0 #4a9eff' });

    applyDropIndicator(line, null);

    expect(line.style.getPropertyValue('box-shadow')).toBe('');
  });
});
