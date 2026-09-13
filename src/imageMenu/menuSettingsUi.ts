/**
 * Settings tab section for the image right-click menu: two toggles plus the
 * file-operation editor (per-row visibility, with up/down reordering).
 *
 * The host is reached only through `ImageMenuBridge`, so this module never sees
 * the facade, the persistence key or Obsidian's data object — it just asks for
 * the current settings, mutates them in place, and asks for a save.
 */

import { ButtonComponent, Setting } from 'obsidian';
import { FILE_OPERATION_LABELS } from './menuLabels';
import { restoreDefaultFileOperationOrder, type ImageMenuSettings } from './settingsModel';

/** The slice of the image-menu host the settings section needs. */
export interface ImageMenuBridge {
    /** Live settings object; mutations here are picked up by the next save. */
    getSettings(): ImageMenuSettings;
    saveSettings(): Promise<void>;
}

/** Mount the image-menu settings section at the end of `containerEl`. */
export function renderImageMenuSettings(containerEl: HTMLElement, bridge: ImageMenuBridge): void {
    new ImageMenuSettingsSection(containerEl, bridge).render();
}

class ImageMenuSettingsSection {
    private readonly group: HTMLElement;

    constructor(
        containerEl: HTMLElement,
        private readonly bridge: ImageMenuBridge
    ) {
        new Setting(containerEl).setName('图片右键菜单设置').setHeading();
        this.group = containerEl.createDiv();
        this.group.addClass('drag-img-settings-group');
    }

    render(): void {
        this.renderToggles();
        this.renderOperations();
    }

    private get settings(): ImageMenuSettings {
        return this.bridge.getSettings();
    }

    private renderToggles(): void {
        new Setting(this.group)
            .setName('显示文件信息')
            .setDesc('在菜单顶部显示图片的文件名、当前缩放比例与原始像素尺寸。')
            .addToggle(toggle =>
                toggle.setValue(this.settings.showImageInfo).onChange(async value => {
                    this.settings.showImageInfo = value;
                    await this.bridge.saveSettings();
                })
            );

        new Setting(this.group)
            .setName('删除前确认')
            .setDesc('「删除」会一并移除图片文件时，先弹出确认；仅删除笔记中的引用时不询问。')
            .addToggle(toggle =>
                toggle.setValue(this.settings.confirmDelete).onChange(async value => {
                    this.settings.confirmDelete = value;
                    await this.bridge.saveSettings();
                })
            );
    }

    /**
     * The file-operation editor, rebuilt from the settings on every change. Each
     * mutation is saved and then re-rendered whole, so the buttons' disabled ends
     * and the row order can never drift out of step with the stored list.
     */
    private renderOperations(): void {
        const list = this.group.createDiv();
        new Setting(list)
            .setName('文件操作')
            .setDesc('菜单底部的文件操作项：开关控制是否显示，箭头调整先后顺序。')
            .addButton(button =>
                button.setButtonText('恢复默认顺序').onClick(async () => {
                    this.settings.fileOperationItems = restoreDefaultFileOperationOrder(
                        this.settings.fileOperationItems
                    );
                    await this.bridge.saveSettings();
                    this.refreshOperations(list);
                })
            );

        const rows = list.createDiv();
        const items = this.settings.fileOperationItems;
        items.forEach((item, index) => {
            new Setting(rows)
                .setName(FILE_OPERATION_LABELS[item.id])
                .addToggle(toggle =>
                    toggle.setValue(item.visible).onChange(async value => {
                        item.visible = value;
                        await this.bridge.saveSettings();
                    })
                )
                .addButton(button => this.wireMove(button, list, index, -1))
                .addButton(button => this.wireMove(button, list, index, 1));
        });
    }

    private refreshOperations(list: HTMLElement): void {
        list.remove();
        this.renderOperations();
    }

    /** Move one row one step (`delta` −1 up / +1 down); disabled at either end. */
    private wireMove(button: ButtonComponent, list: HTMLElement, index: number, delta: number): void {
        const label = delta < 0 ? '上移' : '下移';
        button.setButtonText(delta < 0 ? '↑' : '↓').setTooltip(label);
        const items = this.settings.fileOperationItems;
        const target = index + delta;
        if (target < 0 || target >= items.length) {
            button.setDisabled(true);
            return;
        }
        button.onClick(async () => {
            const moved = items[index];
            const displaced = items[target];
            if (!moved || !displaced) return;
            items[index] = displaced;
            items[target] = moved;
            await this.bridge.saveSettings();
            this.refreshOperations(list);
        });
    }
}
