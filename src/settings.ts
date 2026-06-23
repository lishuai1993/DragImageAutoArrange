import { App, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_SETTINGS } from "./constants";

export interface DragImageSettings {
  enabled: boolean;
  defaultRowHeight: number;
  maxImagesPerRow: number;
  gapSize: number;
  enableDragReorder: boolean;
  enableResize: boolean;
  enableDividers: boolean;
  imageExtensions: string;
}

export interface IDragImagePlugin {
  settings: DragImageSettings;
  saveSettings(): Promise<void>;
}

export function loadSettings(plugin: { loadData(): unknown }): DragImageSettings {
  const data = plugin.loadData();
  return Object.assign({}, DEFAULT_SETTINGS, data ?? {});
}

export class DragImageSettingTab extends PluginSettingTab {
  plugin: IDragImagePlugin;

  constructor(app: App, plugin: IDragImagePlugin) {
    super(app, plugin as any);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Drag Image Auto Arrange" });

    new Setting(containerEl)
      .setName("Enable plugin")
      .setDesc("Toggle the image auto-arrange feature on or off.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enabled)
          .onChange(async (value) => {
            this.plugin.settings.enabled = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Default row height")
      .setDesc("Default uniform height (px) for image rows. Individual rows adapt based on image aspect ratios.")
      .addSlider((slider) =>
        slider
          .setLimits(80, 600, 10)
          .setValue(this.plugin.settings.defaultRowHeight)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.defaultRowHeight = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max images per row")
      .setDesc("Maximum number of images allowed in a single row (1-10). Groups exceeding this limit are split.")
      .addSlider((slider) =>
        slider
          .setLimits(2, 10, 1)
          .setValue(this.plugin.settings.maxImagesPerRow)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxImagesPerRow = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Gap size")
      .setDesc("Spacing between images in a row (px).")
      .addSlider((slider) =>
        slider
          .setLimits(0, 20, 1)
          .setValue(this.plugin.settings.gapSize)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.gapSize = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Enable drag reorder")
      .setDesc("Allow dragging images within a row to reorder them.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableDragReorder)
          .onChange(async (value) => {
            this.plugin.settings.enableDragReorder = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Enable resize handles")
      .setDesc("Show corner resize handles on hover to adjust individual image sizes.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableResize)
          .onChange(async (value) => {
            this.plugin.settings.enableResize = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Enable column dividers")
      .setDesc("Show draggable dividers between images to adjust width ratios.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableDividers)
          .onChange(async (value) => {
            this.plugin.settings.enableDividers = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Image extensions")
      .setDesc("Comma-separated list of image file extensions to detect (e.g., png,jpg,gif,webp).")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.imageExtensions)
          .onChange(async (value) => {
            this.plugin.settings.imageExtensions = value || DEFAULT_SETTINGS.imageExtensions;
            await this.plugin.saveSettings();
          })
      );
  }
}
