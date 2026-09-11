import { Setting } from 'obsidian';
import { SETTINGS_TEXT } from './menuTexts';
import {
  getFileOperationName,
  isDefaultFileOperationOrder,
  restoreDefaultFileOperationOrder,
  sanitizeResizeSizes,
  type PixelPerfectImageSettings,
} from './ppSettingsModel';

/**
 * 图片菜单相关设置项的读写表面：DIA 设置页通过它编辑菜单真正消费的几项——
 * 文件信息行、尺寸预设、删除确认，以及文件操作组的显示开关与顺序。
 * 本案不消费的 PP 选项（滚轮缩放、Cmd/Ctrl + 点击、关于页）不在此暴露。
 */
export interface PixelPerfectBridge {
  settings: PixelPerfectImageSettings;
  saveSettings(): Promise<void>;
  requestSaveSettings(): Promise<void>;
}

/** 布尔型设置项：开关直接写进设置对象并落盘。 */
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
      toggle.setValue(get(bridge.settings)).onChange(async value => {
        set(bridge.settings, value);
        await bridge.saveSettings();
      })
    );
}

/**
 * 把图片菜单设置追加到 DIA 设置页。在 DragImageSettingTab.display() 内调用，
 * 因此 h3 分组与缩进卡片的样式和上下相邻的 DIA 分组一致。
 */
export function renderPixelPerfectSettings(
  containerEl: HTMLElement,
  bridge: PixelPerfectBridge
): void {
  // ── 组 1：右键菜单选项 ───────────────────────────────────────────
  new Setting(containerEl).setName(SETTINGS_TEXT.menuGroupHeading).setHeading();
  const menuGroup = containerEl.createDiv({ cls: 'drag-img-settings-group' });

  addBooleanSetting(
    menuGroup,
    bridge,
    s => s.showFileInfo,
    (s, v) => {
      s.showFileInfo = v;
    },
    SETTINGS_TEXT.fileInfo.name,
    SETTINGS_TEXT.fileInfo.desc
  );

  // 尺寸预设用逗号分隔，回车 / 失焦才提交——逐字符提交会把用户敲到一半的
  // 内容清洗成空列表。
  new Setting(menuGroup)
    .setName(SETTINGS_TEXT.resizeOptions.name)
    .setDesc(SETTINGS_TEXT.resizeOptions.desc)
    .addText(text => {
      let raw = bridge.settings.customResizeSizes.join(', ');
      const commit = (): void => {
        bridge.settings.customResizeSizes = sanitizeResizeSizes(raw.split(','));
        text.setValue(bridge.settings.customResizeSizes.join(', '));
        void bridge.requestSaveSettings();
      };
      text.setPlaceholder(SETTINGS_TEXT.resizeOptions.placeholder);
      text.inputEl.type = 'text';
      text.inputEl.addClass('drag-img-resize-options-input');
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
    SETTINGS_TEXT.confirmDelete.name,
    SETTINGS_TEXT.confirmDelete.desc
  );

  // ── 组 2：文件操作菜单项 ─────────────────────────────────────────
  new Setting(containerEl).setName(SETTINGS_TEXT.fileOpsGroupHeading).setHeading();
  const opGroup = containerEl.createDiv({ cls: 'drag-img-settings-group' });

  const buildOpSettings = (): void => {
    opGroup.empty();
    for (const operation of bridge.settings.fileOperations) {
      new Setting(opGroup)
        .setName(getFileOperationName(operation.id))
        .addToggle(toggle =>
          toggle.setValue(operation.visible).onChange(async value => {
            operation.visible = value;
            await bridge.saveSettings();
          })
        );
    }
    new Setting(opGroup)
      .setName(SETTINGS_TEXT.restoreDefaultOrder)
      .setDesc(SETTINGS_TEXT.restoreDefaultOrderDesc)
      .addButton(button =>
        button
          .setButtonText(SETTINGS_TEXT.restoreDefaultOrder)
          .setDisabled(isDefaultFileOperationOrder(bridge.settings.fileOperations))
          .onClick(() => {
            bridge.settings.fileOperations = restoreDefaultFileOperationOrder(
              bridge.settings.fileOperations
            );
            void bridge.saveSettings();
            buildOpSettings();
          })
      );
  };
  buildOpSettings();
}
