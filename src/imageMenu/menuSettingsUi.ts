/**
 * Settings tab section for the image right-click menu: two toggles plus the
 * file-operation editor (per-row visibility, with up/down reordering).
 *
 * The host is reached only through `ImageMenuBridge`, so this module never sees
 * the facade, the persistence key or Obsidian's data object — it just asks for
 * the current settings, mutates them in place, and asks for a save.
 *
 * One row table, two render paths. Obsidian 1.13 renders a settings tab from
 * definitions, and puts a group's heading and card around the rows itself, so
 * `imageMenuSectionDefinitions` only supplies copy and row bodies. Older
 * versions draw the tab imperatively, so `renderImageMenuSettings` builds the
 * heading and the group div by hand and mounts the same rows into it.
 */

import { ButtonComponent, Setting, type SettingDefinitionItem } from 'obsidian';
import { applySettingButtonStyle } from '../settingsButton';
import { FILE_OPERATION_LABELS } from './menuLabels';
import { restoreDefaultFileOperationOrder, type ImageMenuSettings } from './settingsModel';

/** The slice of the image-menu host the settings section needs. */
export interface ImageMenuBridge {
    /** Live settings object; mutations here are picked up by the next save. */
    getSettings(): ImageMenuSettings;
    saveSettings(): Promise<void>;
}

/** The section heading. The declarative path hands it to the framework; the
 *  imperative path creates the heading element itself. */
const HEADING = '图片右键菜单设置';

/** One row: its copy, plus the body that fills its control area. */
interface SectionRow {
    name: string;
    desc?: string;
    /** Called with a row that already carries its name and description. */
    body(setting: Setting): void;
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
            .setTooltip(delta < 0 ? '上移' : '下移');
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
            name: '显示文件信息',
            desc: '在菜单顶部显示图片的文件名、当前缩放比例与原始像素尺寸。',
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
            name: '删除前确认',
            desc: '「删除」会一并移除图片文件时，先弹出确认；仅删除笔记中的引用时不询问。',
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
            name: '文件操作',
            desc: '菜单底部的文件操作项：开关控制是否显示，箭头调整先后顺序。',
            body: (setting) => {
                setting.addButton((button) =>
                    applySettingButtonStyle(button)
                        .setButtonText('恢复默认顺序')
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
            heading: HEADING,
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
    new Setting(containerEl).setName(HEADING).setHeading();
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
