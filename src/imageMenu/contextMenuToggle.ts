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
import type { ImageMenuFacade } from './imageMenuHost';
import { NOTICE_DONE, contextMenuDisabledLines } from './menuLabels';

const log = logger.channel('imageMenuToggle');

export const TOGGLE_CONTEXT_MENU_COMMAND_ID = 'toggle-image-context-menu';
export const TOGGLE_CONTEXT_MENU_COMMAND_NAME = 'Toggle image context menu';

/** The command as the palette renders it, plugin name included — exactly the
 *  string a search in 设置 → 快捷键 matches, which is what makes the clipboard
 *  hand-off useful. */
export const TOGGLE_CONTEXT_MENU_PALETTE_LABEL =
    'Drag Image Auto Arrange: Toggle image context menu';

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
    new Notice(noticeLines(contextMenuDisabledLines(TOGGLE_CONTEXT_MENU_PALETTE_LABEL, copied)));
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
        await navigator.clipboard.writeText(TOGGLE_CONTEXT_MENU_PALETTE_LABEL);
        return true;
    } catch (error) {
        log.warn('LOG_IMAGE_MENU_TOGGLE_CLIPBOARD_FAILED', { error: String(error) });
        return false;
    }
}
