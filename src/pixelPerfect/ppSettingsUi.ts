import { Setting } from 'obsidian';
import {
    getFileOperationName,
    restoreDefaultFileOperationOrder,
    sanitizeResizeSizes,
    type PixelPerfectImageSettings,
} from '../vendor/pixelPerfectImage/ui/settings';
import { strings } from '../vendor/pixelPerfectImage/i18n';

/**
 * Thin read/write surface over the in-process Pixel Perfect host, exposed so the
 * Drag Image Auto Arrange settings tab can edit the PP options that the merged
 * runtime actually consumes: the file-info menu row, resize presets, delete
 * confirmation, and the visibility/order of the file-operation menu group.
 * (PP settings DIA does not consume — wheel zoom, cmd/ctrl+click, About — are
 * intentionally not surfaced here.)
 */
export interface PixelPerfectBridge {
    settings: PixelPerfectImageSettings;
    saveSettings(): Promise<void>;
    requestSaveSettings(): Promise<void>;
}

/** Toggle-backed boolean PP setting, persisted straight to the host. */
function addBooleanSetting(
    container: HTMLElement,
    bridge: PixelPerfectBridge,
    get: (settings: PixelPerfectImageSettings) => boolean,
    set: (settings: PixelPerfectImageSettings, value: boolean) => void,
    name: string,
    desc: string
): void {
    new Setting(container)
        .setName(name)
        .setDesc(desc)
        .addToggle(toggle =>
            toggle
                .setValue(get(bridge.settings))
                .onChange(async value => {
                    set(bridge.settings, value);
                    await bridge.saveSettings();
                })
        );
}

/**
 * Append the Pixel Perfect settings groups to the DIA settings tab. Rendered
 * inside DragImageSettingTab.display(), so the h3 group + indented card style
 * matches the DIA groups around it.
 */
export function renderPixelPerfectSettings(
    containerEl: HTMLElement,
    bridge: PixelPerfectBridge
): void {
    // ── Group 1: right-click menu options ───────────────────────────
    containerEl.createEl('h3', { text: '图片右键菜单设置' });
    const menuGroup = containerEl.createDiv();
    menuGroup.addClass('drag-img-settings-group');

    addBooleanSetting(
        menuGroup,
        bridge,
        s => s.showFileInfo,
        (s, v) => {
            s.showFileInfo = v;
        },
        strings.settings.items.fileInfo.name,
        strings.settings.items.fileInfo.desc
    );

    // Resize presets — a comma-separated list committed on Enter/blur, so a
    // partially-typed entry never gets sanitized into an empty preset mid-edit.
    new Setting(menuGroup)
        .setName(strings.settings.items.resizeOptions.name)
        .setDesc(strings.settings.items.resizeOptions.desc)
        .addText(text => {
            let raw = bridge.settings.customResizeSizes.join(', ');
            const commit = (): void => {
                bridge.settings.customResizeSizes = sanitizeResizeSizes(raw.split(','));
                text.setValue(bridge.settings.customResizeSizes.join(', '));
                void bridge.requestSaveSettings();
            };
            text.setPlaceholder(strings.settings.items.resizeOptions.placeholder);
            text.inputEl.type = 'text';
            text.inputEl.style.minWidth = '240px';
            text.inputEl.addEventListener('keydown', ev => {
                if (ev.key === 'Enter') commit();
            });
            text.inputEl.addEventListener('blur', commit);
            text.onChange(value => {
                raw = value;
            });
            return text.setValue(raw);
        });

    addBooleanSetting(
        menuGroup,
        bridge,
        s => s.confirmBeforeDelete,
        (s, v) => {
            s.confirmBeforeDelete = v;
        },
        strings.settings.items.confirmDelete.name,
        strings.settings.items.confirmDelete.desc
    );

    // ── Group 2: file-operation menu items ──────────────────────────
    containerEl.createEl('h3', { text: '文件操作设置' });
    const opGroup = containerEl.createDiv();
    opGroup.addClass('drag-img-settings-group');

    const buildOpSettings = (): void => {
        opGroup.empty();
        for (const operation of bridge.settings.fileOperations) {
            new Setting(opGroup)
                .setName(getFileOperationName(operation.id))
                .addToggle(toggle =>
                    toggle
                        .setValue(operation.visible)
                        .onChange(async value => {
                            operation.visible = value;
                            await bridge.saveSettings();
                        })
                );
        }
        new Setting(opGroup)
            .setName(strings.settings.items.contextMenu.restoreDefaultOrder)
            .setDesc('将文件操作顺序恢复为默认排列（保留当前的显示开关状态）。')
            .addButton(button =>
                button
                    .setButtonText(strings.settings.items.contextMenu.restoreDefaultOrder)
                    .onClick(() => {
                        bridge.settings.fileOperations =
                            restoreDefaultFileOperationOrder(bridge.settings.fileOperations);
                        void bridge.saveSettings();
                        buildOpSettings();
                    })
            );
    };
    buildOpSettings();
}
