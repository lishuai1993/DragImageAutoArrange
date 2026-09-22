/**
 * @vitest-environment jsdom
 *
 * Tests for the image right-click menu's master switch: the state write plus
 * the two shut-off concerns — the clipboard hand-off of the command that turns
 * the menu back on, and the notice that explains it. `announce` is what the
 * three surfaces differ by, and all three share this write path — including the
 * broadcast that keeps the settings page's own toggle showing the right value.
 *
 * The switch-off notice is a real bullet list, so the assertions read the
 * fragment's `ul > li` texts rather than splitting a string: the shape is the
 * requirement, not just the words.
 *
 * The clipboard stub lives on `navigator`, is swappable per test, and can be
 * made to refuse: a refused clipboard must not undo the switch, nor let the
 * notice claim a copy that never happened.
 *
 * This file also re-installs the platform's create-AND-append `document.createDiv`.
 * The shared setup's double only creates and returns, which is exactly why the
 * original `document.createDiv({text})` bug shipped green — see the lock at the
 * bottom, which fails the moment anyone reaches for that helper again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
    notices: [] as (string | DocumentFragment)[],
    copied: [] as string[],
    refuse: false,
}));

vi.mock('obsidian', async (importOriginal) => {
    const actual = await importOriginal<typeof import('obsidian')>();
    return {
        ...actual,
        Notice: class {
            // Kept as handed over: the switch-off notice is a fragment, and its
            // shape is under test — flattening here would hide what is asserted.
            constructor(message: string | DocumentFragment) {
                h.notices.push(message);
            }
        },
    };
});

/** The notice's lines. A fragment carries them as the bullets of its list. */
function linesOf(message: string | DocumentFragment): string[] {
    if (typeof message === 'string') return [message];
    return Array.from(message.querySelectorAll('li')).map((item) => item.textContent ?? '');
}

/**
 * `Node.prototype.createEl` forces `parent = this` before handing over to the
 * global createEl, so on `document` the helper's "create" is really an
 * appendChild — and a second element on a document throws HierarchyRequestError.
 * The shared double omits the append, hiding that. Reinstalled here so a
 * regression to `document.createDiv({text})` reddens this file.
 */
function installPlatformCreateDiv(): void {
    Object.defineProperty(document, 'createDiv', {
        configurable: true,
        writable: true,
        value: function (
            this: Document,
            o?: { cls?: string | string[]; text?: string } | string
        ): HTMLElement {
            const el = document.createElement('div');
            if (typeof o === 'string') el.className = o;
            else if (o) {
                if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(' ') : o.cls;
                if (o.text !== undefined) el.textContent = o.text;
            }
            this.appendChild(el);
            return el;
        },
    });
}

import {
    TOGGLE_CONTEXT_MENU_COMMAND_ID,
    TOGGLE_CONTEXT_MENU_COMMAND_ID_ZH,
    TOGGLE_CONTEXT_MENU_COMMAND_NAME,
    TOGGLE_CONTEXT_MENU_NAMES,
    onContextMenuSwitchChanged,
    setContextMenuEnabled,
    toggleContextMenu,
    toggleCommandPaletteLabel,
    type ContextMenuSwitchHost,
} from '../src/imageMenu/contextMenuToggle';
import { setLanguage } from '../src/i18n/language';
import { DEFAULT_IMAGE_MENU_SETTINGS } from '../src/imageMenu/settingsModel';

function facadeWith(enableContextMenu: boolean) {
    const settings = { ...DEFAULT_IMAGE_MENU_SETTINGS, enableContextMenu };
    const saveSettings = vi.fn(async () => {});
    // The switch needs only these two, which is the whole point of the narrow
    // host type: the real facade and the settings section's bridge both fit it,
    // so the row can drive this write path without the facade leaking in.
    const facade: ContextMenuSwitchHost = { getSettings: () => settings, saveSettings };
    return { facade, settings, saveSettings };
}

const createDivInSetup = (document as unknown as { createDiv: unknown }).createDiv;

beforeEach(() => {
    // The notice copy asserted below is the Chinese one; the English rendering of
    // the same table is covered by the settings-copy guard in tests/i18n.test.ts.
    setLanguage('zh');
    h.notices.length = 0;
    h.copied.length = 0;
    h.refuse = false;
    installPlatformCreateDiv();
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
            writeText: async (text: string) => {
                if (h.refuse) throw new Error('clipboard denied');
                h.copied.push(text);
            },
        },
    });
});

afterEach(() => {
    (document as unknown as { createDiv: unknown }).createDiv = createDivInSetup;
    Reflect.deleteProperty(navigator, 'clipboard');
    setLanguage('en');
});

describe('the command this switch hands out', () => {
    it('names the command as the palette renders it, in the language of the notice', () => {
        // Both languages are registered side by side, so the label the notice
        // puts on the clipboard always names a command that exists.
        expect(TOGGLE_CONTEXT_MENU_COMMAND_ID).toBe('toggle-image-context-menu');
        expect(TOGGLE_CONTEXT_MENU_COMMAND_ID_ZH).toBe('toggle-image-context-menu-zh');
        expect(TOGGLE_CONTEXT_MENU_COMMAND_NAME).toBe('Toggle image context menu');

        setLanguage('en');
        expect(toggleCommandPaletteLabel()).toBe(
            `Drag Image Auto Arrange: ${TOGGLE_CONTEXT_MENU_NAMES.en}`
        );
        setLanguage('zh');
        expect(toggleCommandPaletteLabel()).toBe(
            `Drag Image Auto Arrange: ${TOGGLE_CONTEXT_MENU_NAMES.zh}`
        );
        setLanguage('en');
    });
});

describe('the notice building helper', () => {
    it('renders the lines as one bullet list, not as text', async () => {
        const { facade } = facadeWith(true);

        await setContextMenuEnabled(facade, false, true);

        const message = h.notices[0];
        expect(typeof message).not.toBe('string');
        const fragment = message as DocumentFragment;
        const lists = fragment.querySelectorAll('ul');
        expect(lists).toHaveLength(1);
        expect(lists[0].className).toContain('diaa-notice-list');
        expect(fragment.querySelectorAll('li')).toHaveLength(3);
    });

    it('locks the create-AND-append trap that hid the missing notice', () => {
        // Under the platform's semantics a detached element is impossible to get
        // from `document.createDiv`; the regression that swallowed the notice had
        // to throw here. If this stops throwing, the double is back and the trap
        // is unguarded again.
        let thrown: unknown;
        try {
            (document as unknown as { createDiv(o: { text: string }): unknown }).createDiv({
                text: '游离行',
            });
        } catch (error) {
            thrown = error;
        }
        expect((thrown as DOMException | undefined)?.name).toBe('HierarchyRequestError');
    });
});

describe('setContextMenuEnabled', () => {
    it('writes the switch and saves, silently, when not announcing', async () => {
        const { facade, settings, saveSettings } = facadeWith(true);

        await setContextMenuEnabled(facade, false, false);

        expect(settings.enableContextMenu).toBe(false);
        expect(saveSettings).toHaveBeenCalledTimes(1);
        expect(h.notices).toEqual([]);
        expect(h.copied).toEqual([]);
    });

    it('announces an enable without touching the clipboard', async () => {
        const { facade, settings } = facadeWith(false);

        await setContextMenuEnabled(facade, true, true);

        expect(settings.enableContextMenu).toBe(true);
        expect(h.notices).toEqual(['图片右键菜单已开启']);
        expect(h.copied).toEqual([]);
    });

    it('hands the way back to the clipboard when switched off, and says so', async () => {
        const { facade } = facadeWith(true);

        await setContextMenuEnabled(facade, false, true);

        expect(h.copied).toEqual([toggleCommandPaletteLabel()]);
        expect(h.notices).toHaveLength(1);
        expect(linesOf(h.notices[0])).toEqual([
            '图片右键菜单已关闭',
            `开启命令「${toggleCommandPaletteLabel()}」已复制到剪贴板`,
            '在「设置 → 快捷键」中搜索该命令并绑定快捷键，即可随时重新开启。',
        ]);
    });

    it('still switches off when the clipboard refuses, without claiming a copy', async () => {
        const { facade, settings } = facadeWith(true);
        h.refuse = true;

        await setContextMenuEnabled(facade, false, true);

        expect(settings.enableContextMenu).toBe(false);
        expect(h.copied).toEqual([]);
        expect(h.notices).toHaveLength(1);
        expect(linesOf(h.notices[0])).toEqual([
            '图片右键菜单已关闭',
            `开启命令「${toggleCommandPaletteLabel()}」复制到剪贴板失败，可手动记下该名称`,
            '在「设置 → 快捷键」中搜索该命令并绑定快捷键，即可随时重新开启。',
        ]);
    });
});

describe('the switch change broadcast', () => {
    it('tells listeners the value that landed, once it has landed', async () => {
        const { facade, settings } = facadeWith(true);
        const heard: boolean[] = [];
        const unsubscribe = onContextMenuSwitchChanged((enabled) => {
            heard.push(enabled);
            expect(settings.enableContextMenu).toBe(enabled);
        });

        await setContextMenuEnabled(facade, false, false);
        unsubscribe();

        expect(heard).toEqual([false]);
    });

    it('stops telling a listener that unsubscribed', async () => {
        const { facade } = facadeWith(true);
        const heard: boolean[] = [];
        const unsubscribe = onContextMenuSwitchChanged((enabled) => heard.push(enabled));
        unsubscribe();

        await setContextMenuEnabled(facade, false, false);

        expect(heard).toEqual([]);
    });
});

describe('toggleContextMenu', () => {
    it('flips the stored value in both directions', async () => {
        const on = facadeWith(true);
        await toggleContextMenu(on.facade);
        expect(on.settings.enableContextMenu).toBe(false);

        const off = facadeWith(false);
        await toggleContextMenu(off.facade);
        expect(off.settings.enableContextMenu).toBe(true);
        // The first toggle left its switch-off notice behind; the second is this one.
        expect(h.notices).toHaveLength(2);
        expect(linesOf(h.notices[1])).toEqual(['图片右键菜单已开启']);
    });
});
