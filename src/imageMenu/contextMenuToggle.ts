/**
 * The image right-click menu's master switch, and the one place it is written.
 *
 * Three surfaces flip it — the settings row, the menu's own「关闭 DIAA 图片右键
 * 菜单」row, and the toggle command — so the state write, the persistence call
 * and the switch-off announcement all live here rather than being spelled out
 * three times.
 *
 * Switch-off is the path that needs care: with the menu gone, the row that
 * turned it off is unreachable, so the way back is the command. Its palette
 * label goes to the clipboard on the way out and the notice explains what to do
 * with it. The settings row stays silent instead — it is reached from a page
 * that already shows the state, and must not clobber the clipboard while the
 * user is typing in it.
 */

import { Notice } from 'obsidian';
import { CLASSES } from '../constants';
import { logger } from '../logger';
import { t, type Localized } from '../i18n/language';
import type { ImageMenuFacade } from './imageMenuHost';
import { NOTICE_DONE, contextMenuDisabledLines } from './menuLabels';

const log = logger.channel('imageMenuToggle');

export const TOGGLE_CONTEXT_MENU_COMMAND_ID = 'toggle-image-context-menu';
export const TOGGLE_CONTEXT_MENU_COMMAND_ID_ZH = 'toggle-image-context-menu-zh';

/**
 * The command's name in both languages. Both are registered as separate commands
 * (see main.ts) rather than one command that renames itself: a command name is
 * also a hotkey binding's identity, and re-registering on a language change would
 * churn the hotkey list. Registering both means a user can find this command
 * under a name they recognise whichever language the interface is showing.
 */
export const TOGGLE_CONTEXT_MENU_NAMES: Localized = {
    zh: '开关 DIAA 图片右键菜单',
    en: 'Toggle image context menu',
};

export const TOGGLE_CONTEXT_MENU_COMMAND_NAME = TOGGLE_CONTEXT_MENU_NAMES.en;

/** The command as the palette renders it, plugin name included — exactly the
 *  string a search in 设置 → 快捷键 matches, which is what makes the clipboard
 *  hand-off useful. Resolved per call so the copy names the command in the
 *  language of the notice that carries it. */
export function toggleCommandPaletteLabel(): string {
    return `Drag Image Auto Arrange: ${t(TOGGLE_CONTEXT_MENU_NAMES)}`;
}

/**
 * Write the master switch. `announce` is the difference between the two kinds
 * of caller: the command and the menu row are transient surfaces that have to
 * say what happened, the settings row is not.
 */
export async function setContextMenuEnabled(
    facade: ImageMenuFacade,
    enabled: boolean,
    announce: boolean
): Promise<void> {
    facade.settings.enableContextMenu = enabled;
    void facade.saveSettings();

    if (!announce) return;
    if (enabled) {
        new Notice(NOTICE_DONE.contextMenuEnabled);
        return;
    }
    const copied = await copyEnableCommand();
    new Notice(noticeLines(contextMenuDisabledLines(toggleCommandPaletteLabel(), copied)));
}

/**
 * The notice body: a bullet list, one item per line.
 *
 * Built with `createElement` rather than Obsidian's `createDiv` on purpose. The
 * node-level helper is create-AND-append — it forces `parent = this` before
 * handing over to the global `createEl` — so `document.createDiv(...)` is
 * `document.appendChild(...)` and throws `HierarchyRequestError` ("Only one
 * element on document allowed"). Detached elements are what is wanted here.
 *
 * A list rather than plain lines because a newline inside a notice's text is
 * only a line break if the active theme's CSS says so.
 */
function noticeLines(lines: readonly string[]): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const list = document.createElement('ul');
    list.className = CLASSES.noticeList;
    for (const line of lines) {
        const item = document.createElement('li');
        item.textContent = line;
        list.appendChild(item);
    }
    fragment.appendChild(list);
    return fragment;
}

/** Flip the switch and report — shared by the command and the menu row. */
export async function toggleContextMenu(facade: ImageMenuFacade): Promise<void> {
    await setContextMenuEnabled(facade, !facade.settings.enableContextMenu, true);
}

/** A refused clipboard must not undo the switch, so this reports rather than throws. */
async function copyEnableCommand(): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(toggleCommandPaletteLabel());
        return true;
    } catch (error) {
        log.warn('LOG_IMAGE_MENU_TOGGLE_CLIPBOARD_FAILED', { error: String(error) });
        return false;
    }
}
