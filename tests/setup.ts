/**
 * Shared vitest setup.
 *
 * The suite runs in a plain node environment (except the files that opt into
 * jsdom), but the plugin itself always runs inside Obsidian's Electron
 * renderer, where `window` and Obsidian's DOM augmentations exist. This file
 * supplies just enough of that environment for the modules under test.
 */

// Obsidian's own API uses `window.setTimeout` and friends, and the review
// rules require it (`prefer-window-timers`), so src code calls the
// window-qualified forms everywhere. Aliasing `window` to globalThis makes
// those calls resolve to the same node timers the suite already relies on.
if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
  (globalThis as { window?: unknown }).window = globalThis;
}

// Obsidian augments `document` with createEl / createDiv / createSpan, which
// src code uses to build detached elements. Provide them only where a DOM
// exists (jsdom test files); node-env files never reach these code paths.
if (typeof document !== 'undefined') {
  const doc = document as Document & Record<string, unknown>;

  const createEl = (
    tag: string,
    o?: { cls?: string | string[]; text?: string } | string
  ): HTMLElement => {
    const el = document.createElement(tag);
    if (typeof o === 'string') el.className = o;
    else if (o) {
      if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(' ') : o.cls;
      if (o.text !== undefined) el.textContent = o.text;
    }
    return el;
  };

  if (typeof doc.createEl !== 'function') {
    doc.createEl = createEl;
    doc.createDiv = (o?: { cls?: string | string[]; text?: string } | string) =>
      createEl('div', o);
    doc.createSpan = (o?: { cls?: string | string[]; text?: string } | string) =>
      createEl('span', o);
  }

  // Obsidian exposes element creation as *global* functions too (createEl /
  // createDiv / createSpan / createFragment), which is the form src code calls
  // to build detached elements. They are not module exports, so they cannot be
  // imported.
  const globals = globalThis as Record<string, unknown>;
  if (typeof globals.createEl !== 'function') {
    globals.createEl = createEl;
    globals.createDiv = (o?: { cls?: string | string[]; text?: string } | string) =>
      createEl('div', o);
    globals.createSpan = (o?: { cls?: string | string[]; text?: string } | string) =>
      createEl('span', o);
  }
  if (typeof globals.createFragment !== 'function') {
    globals.createFragment = (callback?: (el: DocumentFragment) => void): DocumentFragment => {
      const fragment = document.createDocumentFragment();
      callback?.(fragment);
      return fragment;
    };
  }

  const elProto = Element.prototype as Element & Record<string, unknown>;
  if (typeof elProto.createEl !== 'function') {
    const appendEl = function (
      this: Element,
      tag: string,
      o?: { cls?: string | string[]; text?: string } | string
    ): HTMLElement {
      const el = createEl(tag, o);
      this.appendChild(el);
      return el;
    };
    elProto.createEl = appendEl;
    elProto.createDiv = function (
      this: Element,
      o?: { cls?: string | string[]; text?: string } | string
    ): HTMLElement {
      return appendEl.call(this, 'div', o);
    };
    elProto.createSpan = function (
      this: Element,
      o?: { cls?: string | string[]; text?: string } | string
    ): HTMLElement {
      return appendEl.call(this, 'span', o);
    };
    elProto.empty = function (this: Element): void {
      while (this.firstChild) this.removeChild(this.firstChild);
    };
    elProto.addClass = function (this: Element, ...classes: string[]): void {
      this.classList.add(...classes);
    };
    elProto.removeClass = function (this: Element, ...classes: string[]): void {
      this.classList.remove(...classes);
    };
    elProto.toggleClass = function (
      this: Element,
      classes: string | string[],
      value: boolean
    ): void {
      for (const cls of Array.isArray(classes) ? classes : [classes]) {
        this.classList.toggle(cls, value);
      }
    };
  }

  // Obsidian augments every element with `setText`, which src code uses to
  // write a label's copy. Same category as the helpers above, and here a plain
  // wrapper over `textContent`.
  if (typeof elProto.setText !== 'function') {
    elProto.setText = function (this: HTMLElement, text: string): void {
      this.textContent = text;
    };
  }

  // Obsidian's `setCssStyles` takes a `Partial<CSSStyleDeclaration>`, i.e.
  // camelCase keys, and assigns them onto the element's inline style. jsdom
  // exposes the same camelCase view of CSSStyleDeclaration, so writing through
  // it keeps both the src call sites and the tests' camelCase reads working.
  if (typeof elProto.setCssStyles !== 'function') {
    elProto.setCssStyles = function (
      this: HTMLElement,
      styles: Partial<CSSStyleDeclaration>
    ): void {
      for (const key of Object.keys(styles)) {
        const value = (styles as Record<string, string | null | undefined>)[key];
        (this.style as unknown as Record<string, string>)[key] = value ?? '';
      }
    };
  }
}
