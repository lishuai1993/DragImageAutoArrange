/**
 * @vitest-environment jsdom
 *
 * Regression guard for "Cmd+Z does nothing after an image-menu action".
 *
 * The menu is a plain div appended to `document.body`, so the browser's default
 * mousedown action would move focus off the editor. Obsidian's CodeMirror drops
 * any keydown whose target is outside `.cm-content`, so the Cmd+Z that follows
 * a rotate/align/cut never reached the editor and undo silently did nothing.
 * The fix cancels that default with a mousedown listener on the menu root; the
 * `click` that carries the action must still fire.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DomMenu, closeAllMenus } from '../src/imageMenu/menuUi';

afterEach(() => closeAllMenus());

function buildMenu(handler: () => void, disabled = false): DomMenu {
  const menu = new DomMenu();
  menu.addItem((item) => {
    item.setTitle('Rotate').setIcon('rotate-cw');
    if (disabled) item.setDisabled(true);
    item.onClick(handler);
  });
  menu.showAt(10, 10);
  return menu;
}

function rowOf(menu: DomMenu): HTMLElement {
  const row = menu.rootEl.querySelector<HTMLElement>('.diaa-menu-item');
  if (!row) throw new Error('menu row not built');
  return row;
}

describe('image menu keeps editor focus', () => {
  it('cancels the default of a mousedown on a row', () => {
    const menu = buildMenu(vi.fn());
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    rowOf(menu).dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  it('cancels the default of a mousedown anywhere on the menu', () => {
    const menu = buildMenu(vi.fn());
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    menu.rootEl.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  it('still runs the row action on the click that follows', () => {
    const handler = vi.fn();
    const menu = buildMenu(handler);
    const row = rowOf(menu);
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not run a disabled row action', () => {
    const handler = vi.fn();
    const menu = buildMenu(handler, true);
    const row = rowOf(menu);
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(handler).not.toHaveBeenCalled();
  });
});
