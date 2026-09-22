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
 * with it. Every surface that can switch off hands that over, the settings row
 * included. That row is also the one place the switch can be turned *on*, and it
 * stays quiet in that direction — being turned off is what strands the user.
 *
 * Every write is broadcast to the listeners below, which is how the settings
 * page's own toggle keeps up with a flip made from anywhere else.
 */

import { Notice } from 'obsidian';
import { CLASSES } from '../constants';
import { logger } from '../logger';
import { t, type Localized } from '../i18n/language';
import type { ImageMenuSettings } from './settingsModel';
import { NOTICE_DONE, contextMenuDisabledLines } from './menuLabels';

const log = logger.channel('imageMenuToggle');

/**
 * The slice of the image-menu host this switch needs. Deliberately the same two
 * members the settings section's bridge offers, so that row can drive this write
 * path too without this module ever seeing the facade.
 */
export interface ContextMenuSwitchHost {
    getSettings(): ImageMenuSettings;
    saveSettings(): Promise<void>;
}

type ContextMenuSwitchListener = (enabled: boolean) => void;

/**
 * Who to tell when the switch moves.
 *
 * Three surfaces flip it and only one of them owns a control that shows its
 * state — the settings page's toggle. Without this, a flip made from the command
 * or the menu row leaves that toggle showing the old value until the page is
 * reopened, because the page reads the setting once, when it draws.
 */
const switchListeners = new Set<ContextMenuSwitchListener>();

/** Subscribe to switch changes; the return value unsubscribes. Listeners run
 *  after the write has landed, and are handed the value that landed. */
export function onContextMenuSwitchChanged(listener: ContextMenuSwitchListener): () => void {
    switchListeners.add(listener);
    return () => {
        switchListeners.delete(listener);
    };
}

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
 * Write the master switch. `announce` is the difference between the callers:
 * the command and the menu row are transient surfaces that have to say what
 * happened, while the settings row says it only when switching off — the row it
 * is turned off from is the one that disappears with it.
 */
export async function setContextMenuEnabled(
    host: ContextMenuSwitchHost,
    enabled: boolean,
    announce: boolean
): Promise<void> {
    host.getSettings().enableContextMenu = enabled;
    void host.saveSettings();
    for (const listener of switchListeners) listener(enabled);

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
 * Built with the *global* (unparented) helpers, and that choice is load-bearing.
 * The node-level `createEl` / `createDiv` is create-AND-append — it forces
 * `parent = this` before handing over to the global one — so on `document` the
 * helper's "create" is really an appendChild, and a second element there throws
 * `HierarchyRequestError` ("Only one element on document allowed"). Detached
 * elements are what is wanted here, and calling the global helpers is the form
 * that gets them. The `li`s go through `list`'s own node-level helper instead:
 * appending *there* is exactly what is wanted, and `list` is no document.
 *
 * A list rather than plain lines because a newline inside a notice's text is
 * only a line break if the active theme's CSS says so.
 */
function noticeLines(lines: readonly string[]): DocumentFragment {
    const fragment = createFragment();
    const list = createEl('ul', { cls: CLASSES.noticeList });
    for (const line of lines) {
        list.createEl('li', { text: line });
    }
    fragment.appendChild(list);
    return fragment;
}

/** Flip the switch and report — shared by the command and the menu row. */
export async function toggleContextMenu(host: ContextMenuSwitchHost): Promise<void> {
    await setContextMenuEnabled(host, !host.getSettings().enableContextMenu, true);
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
