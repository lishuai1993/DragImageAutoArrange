/**
 * Settings tab section for the image right-click menu: two toggles plus the
 * file-operation editor (per-row visibility, with up/down reordering).
 *
 * The host is reached only through `ImageMenuBridge`, so this module never sees
 * the facade, the persistence key or Obsidian's data object — it asks for the
 * current settings, mutates them in place, and asks for a save. The master
 * switch is the exception: it goes through the one writer, which is also what
 * hands the way back out when the menu is turned off.
 *
 * One row table, two render paths. Obsidian 1.13 renders a settings tab from
 * definitions, and puts a group's heading and card around the rows itself, so
 * `imageMenuSectionDefinitions` only supplies copy and row bodies. Older
 * versions draw the tab imperatively, so `renderImageMenuSettings` builds the
 * heading and the group div by hand and mounts the same rows into it.
 */

import { ButtonComponent, Setting, ToggleComponent, type SettingDefinitionItem } from 'obsidian';
import { applySettingButtonStyle } from '../settingsButton';
import { t, type Localized } from '../i18n/language';
import { onContextMenuSwitchChanged, setContextMenuEnabled } from './contextMenuToggle';
import { FILE_OPERATION_LABELS } from './menuLabels';
import { restoreDefaultFileOperationOrder, type ImageMenuSettings } from './settingsModel';

/** The slice of the image-menu host the settings section needs. */
export interface ImageMenuBridge {
    /** Live settings object; mutations here are picked up by the next save. */
    getSettings(): ImageMenuSettings;
    saveSettings(): Promise<void>;
}

/** The section heading. The declarative path hands it to the framework; the
 *  imperative path creates the heading element itself. A pair, since the rows
 *  are built afresh on every render but this file is imported once. */
const HEADING: Localized = { zh: '图片右键菜单设置', en: 'Image context menu' };

/** One row: its copy, plus the body that fills its control area. */
interface SectionRow {
    name: string;
    desc?: string;
    /** Called with a row that already carries its name and description. */
    body(setting: Setting): void;
}

/**
 * The master switch's control, as last drawn.
 *
 * The switch has three surfaces and this toggle is the only one whose state
 * lives in a drawn control — the command and the menu row just write the setting
 * — so a flip made there has to be reflected *here*, and reflected in place: a
 * redraw would rebuild the page under the user's cursor. Reassigned on every
 * render; both render paths go through `buildRows`, so both keep it current.
 */
let masterToggle: ToggleComponent | null = null;

/**
 * Reflect a switch value changed elsewhere.
 *
 * A no-op until the row has been drawn, and once that drawing has been torn down
 * (the page closed, a rebuild replaced it): either way the value is read again
 * when the row is next drawn, so there is nothing to chase.
 */
export function syncContextMenuToggleValue(enabled: boolean): void {
    const toggle = masterToggle;
    if (!toggle || !toggle.toggleEl.isConnected) return;
    toggle.setValue(enabled);
}

/**
 * Put this section on the switch's broadcast list, once.
 *
 * Hung off the first drawing rather than off import or the settings tab, since
 * before a row is drawn there is no control to keep current. It is never taken
 * down: the section is a singleton for the life of the plugin, and the
 * subscription holds the module's own sync function, not any drawn element.
 */
let switchSyncInstalled = false;

function installSwitchSync(): void {
    if (switchSyncInstalled) return;
    switchSyncInstalled = true;
    onContextMenuSwitchChanged(syncContextMenuToggleValue);
}

/**
 * The rows, read from the live settings every time.
 *
 * `refresh` redraws the section after a mutation the DOM cannot express on its
 * own — a reorder. Which redraw that is depends on the path: the declarative
 * one asks the tab to re-read its definitions, the imperative one rebuilds the
 * group div it owns. Everything else (a toggle flip) is already reflected by
 * the model and needs no redraw.
 */
function buildRows(bridge: ImageMenuBridge, refresh: () => void): SectionRow[] {
    const settings = bridge.getSettings();

    /** Move one row one step (`delta` −1 up / +1 down); disabled at either end. */
    const wireMove = (button: ButtonComponent, index: number, delta: number): void => {
        const items = settings.fileOperationItems;
        applySettingButtonStyle(button)
            .setButtonText(delta < 0 ? '↑' : '↓')
            .setTooltip(
                delta < 0
                    ? t({ zh: '上移', en: 'Move up' })
                    : t({ zh: '下移', en: 'Move down' })
            );
        const target = index + delta;
        if (target < 0 || target >= items.length) {
            button.setDisabled(true);
            return;
        }
        button.onClick(() => {
            const moved = items[index];
            const displaced = items[target];
            if (!moved || !displaced) return;
            items[index] = displaced;
            items[target] = moved;
            void bridge.saveSettings().then(refresh);
        });
    };

    const rows: SectionRow[] = [
        {
            name: t({ zh: '启用图片右键菜单', en: 'Enable image context menu' }),
            desc: t({
                zh: '关闭后，右键图片不再弹出 DIAA 菜单，交还 Obsidian 与其他插件处理；可用命令或菜单项快速切换。',
                en: 'When off, right-clicking an image no longer opens the DIAA menu — Obsidian and other plugins handle it again. A command and a menu row can switch it back on.',
            }),
            body: (setting) => {
                setting.addToggle((toggle) => {
                    installSwitchSync();
                    masterToggle = toggle;
                    toggle.setValue(settings.enableContextMenu).onChange((value) => {
                        // Through the one writer, so switching off here hands the
                        // way back out exactly as the command and the menu row do.
                        void setContextMenuEnabled(bridge, value, !value);
                    });
                });
            },
        },
        {
            name: t({ zh: '显示文件信息', en: 'Show file info' }),
            desc: t({
                zh: '在菜单顶部显示图片的文件名、当前缩放比例与原始像素尺寸。',
                en: 'Show the image’s file name, current scale and original pixel size at the top of the menu.',
            }),
            body: (setting) => {
                setting.addToggle((toggle) =>
                    toggle.setValue(settings.showImageInfo).onChange((value) => {
                        settings.showImageInfo = value;
                        void bridge.saveSettings();
                    })
                );
            },
        },
        {
            name: t({ zh: '删除前确认', en: 'Confirm before deleting' }),
            desc: t({
                zh: '「删除」会一并移除图片文件时，先弹出确认；仅删除笔记中的引用时不询问。',
                en: 'Ask first when Delete would remove the image file too. Removing only the note’s reference asks nothing.',
            }),
            body: (setting) => {
                setting.addToggle((toggle) =>
                    toggle.setValue(settings.confirmDelete).onChange((value) => {
                        settings.confirmDelete = value;
                        void bridge.saveSettings();
                    })
                );
            },
        },
        {
            name: t({ zh: '文件操作', en: 'File operations' }),
            desc: t({
                zh: '菜单底部的文件操作项：开关控制是否显示，箭头调整先后顺序。',
                en: 'The file-operation rows at the bottom of the menu: a toggle shows or hides one, the arrows set their order.',
            }),
            body: (setting) => {
                setting.addButton((button) =>
                    applySettingButtonStyle(button)
                        .setButtonText(t({ zh: '恢复默认顺序', en: 'Restore default order' }))
                        .onClick(() => {
                            settings.fileOperationItems = restoreDefaultFileOperationOrder(
                                settings.fileOperationItems
                            );
                            void bridge.saveSettings().then(refresh);
                        })
                );
            },
        },
    ];

    // One row per operation. The row order is the stored order, so a move is a
    // swap in the model plus a redraw — never a DOM move the framework would
    // undo on its next render.
    settings.fileOperationItems.forEach((item, index) => {
        rows.push({
            name: FILE_OPERATION_LABELS[item.id],
            body: (setting) => {
                setting.addToggle((toggle) =>
                    toggle.setValue(item.visible).onChange((value) => {
                        item.visible = value;
                        void bridge.saveSettings();
                    })
                );
                setting.addButton((button) => wireMove(button, index, -1));
                setting.addButton((button) => wireMove(button, index, 1));
            },
        });
    });

    return rows;
}

/**
 * The image-menu rows as definitions for Obsidian 1.13+, which renders the
 * group heading and the card around them. `refresh` re-reads these definitions
 * after a reorder, so the rows come back in the new order.
 */
export function imageMenuSectionDefinitions(
    bridge: ImageMenuBridge,
    refresh: () => void
): SettingDefinitionItem[] {
    return [
        {
            type: 'group',
            heading: t(HEADING),
            items: buildRows(bridge, refresh).map((row) => ({
                name: row.name,
                desc: row.desc,
                render: (setting: Setting) => row.body(setting),
            })),
        },
    ];
}

/** Mount the image-menu settings section at the end of `containerEl`, the
 *  heading and group div included — the path for Obsidian below 1.13. */
export function renderImageMenuSettings(containerEl: HTMLElement, bridge: ImageMenuBridge): void {
    new Setting(containerEl).setName(t(HEADING)).setHeading();
    const group = containerEl.createDiv();
    group.addClass('diaa-settings-group');

    const mount = (): void => {
        for (const row of buildRows(bridge, refresh)) {
            const setting = new Setting(group).setName(row.name);
            if (row.desc) setting.setDesc(row.desc);
            row.body(setting);
        }
    };
    const refresh = (): void => {
        group.empty();
        mount();
    };

    mount();
}
