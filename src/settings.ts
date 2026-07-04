import { App, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_SETTINGS } from "./constants";

import { Alignment } from "./constants";

export interface DragImageSettings {
  enabled: boolean;
  defaultRowHeight: number;
  maxImagesPerRow: number;
  gapSize: number;
  snapSensitivity: number;
  enableDragReorder: boolean;
  enableResize: boolean;
  enableDividers: boolean;
  imageExtensions: string;
  topBarSensitivity: number;
  ghostImageWidth: number;
  dragOpacity: number;
  alignment: Alignment;
}

export interface IDragImagePlugin {
  settings: DragImageSettings;
  saveSettings(): Promise<void>;
}

export async function loadSettings(plugin: { loadData(): Promise<any> }): Promise<DragImageSettings> {
  const data = await plugin.loadData();
  // Support both new format ({ settings, preservedSizes }) and old format (settings directly)
  const settings = data?.settings ?? data;
  return Object.assign({}, DEFAULT_SETTINGS, settings ?? {});
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
      .setName("Snap sensitivity")
      .setDesc("When dragging a divider or resize handle, snap into place when the height difference between adjacent images falls within this percentage of their equilibrium (equal) height. Set to 0 to disable snapping.")
      .addSlider((slider) =>
        slider
          .setLimits(0, 10, 1)
          .setValue(this.plugin.settings.snapSensitivity)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.snapSensitivity = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Top bar activation zone")
      .setDesc("Pixel distance from the top of a flex row within which the global-balance top bar appears (4-40 px).")
      .addSlider((slider) =>
        slider
          .setLimits(4, 40, 2)
          .setValue(this.plugin.settings.topBarSensitivity)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.topBarSensitivity = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Ghost image width")
      .setDesc("Width (px) of the drag ghost image that follows the cursor (100-500 px).")
      .addSlider((slider) =>
        slider
          .setLimits(100, 500, 10)
          .setValue(this.plugin.settings.ghostImageWidth)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.ghostImageWidth = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Drag ghost opacity")
      .setDesc("Transparency of the original image during drag (10% = nearly opaque, 90% = very transparent).")
      .addSlider((slider) =>
        slider
          .setLimits(10, 90, 5)
          .setValue(this.plugin.settings.dragOpacity)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.dragOpacity = value;
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
      .setName("Image alignment")
      .setDesc("Horizontal alignment of images within the row container.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("left", "Left")
          .addOption("center", "Center")
          .addOption("right", "Right")
          .setValue(this.plugin.settings.alignment)
          .onChange(async (value) => {
            this.plugin.settings.alignment = value as Alignment;
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
