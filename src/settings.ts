import { App, ButtonComponent, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_SETTINGS } from "./constants";
import { renderPixelPerfectSettings, type PixelPerfectBridge } from "./pixelPerfect/ppSettingsUi";

import { Alignment, SingleImageSizeMode } from "./constants";

export interface DragImageSettings {
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
  singleImageSizeMode: SingleImageSizeMode;
  singleImageWidth: number;
  enableReadingModeContextMenu: boolean;
  enableReadingModeDoubleClickZoom: boolean;
  menuScalePercent: number;
}

export interface IDragImagePlugin {
  settings: DragImageSettings;
  saveSettings(): Promise<void>;
  /** One-shot: reset every single-image row to the current size setting. */
  resetAllSingleImages(): void;
  /** One-shot: clear every per-image alignment, reverting to the global setting. */
  resetAllImageAlignments(): void;
}

export async function loadSettings(plugin: { loadData(): Promise<any> }): Promise<DragImageSettings> {
  const data = await plugin.loadData();
  // Support both new format ({ settings, preservedSizes }) and old format (settings directly)
  const settings = data?.settings ?? data;
  const merged = Object.assign({}, DEFAULT_SETTINGS, settings ?? {});
  // Drop the pre-refactor `enabled` key so a stale saved `false` can't linger
  // in settings data — enable/disable is now exclusively the Obsidian plugin-list toggle.
  delete (merged as Record<string, unknown>).enabled;
  return merged;
}

export class DragImageSettingTab extends PluginSettingTab {
  plugin: IDragImagePlugin;
  private bridge: PixelPerfectBridge | null;

  constructor(app: App, plugin: IDragImagePlugin, bridge?: PixelPerfectBridge | null) {
    super(app, plugin as any);
    this.plugin = plugin;
    this.bridge = bridge ?? null;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    // Scope the full-width-description reflow styles to this settings tab only.
    containerEl.addClass("drag-img-settings");

    containerEl.createEl("h2", { text: "Drag Image Auto Arrange" });

    // ── Layout & interaction (global) ──────────────────────────
    containerEl.createEl("h3", { text: "行布局与交互设置" });
    const layoutGroup = containerEl.createDiv();
    layoutGroup.addClass("drag-img-settings-group");

    new Setting(layoutGroup)
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

    new Setting(layoutGroup)
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

    new Setting(layoutGroup)
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

    new Setting(layoutGroup)
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

    new Setting(layoutGroup)
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

    new Setting(layoutGroup)
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

    new Setting(layoutGroup)
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

    new Setting(layoutGroup)
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

    new Setting(layoutGroup)
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

    new Setting(layoutGroup)
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

    new Setting(layoutGroup)
      .setName("Context menu size")
      .setDesc("Scale of the right-click image menu (50%–150%). Menu padding, spacing, fonts and icons scale together in 10% steps.")
      .addSlider((slider) =>
        slider
          .setLimits(50, 150, 10)
          .setValue(this.plugin.settings.menuScalePercent)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.menuScalePercent = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(layoutGroup)
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

    // ── Image Alignment (grouped) ──────────────────────────────

    containerEl.createEl("h3", { text: "图片统一对齐设置" });

    const alignGroup = containerEl.createDiv();
    alignGroup.addClass("drag-img-settings-group");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let alignDropdown: any;

    new Setting(alignGroup)
      .setName("Image alignment")
      .setDesc("Global horizontal alignment for image rows. Per-image overrides set via right-click take priority.")
      .addDropdown((dropdown) => {
        alignDropdown = dropdown;
        return dropdown
          .addOption("left", "Left")
          .addOption("center", "Center")
          .addOption("right", "Right")
          .setValue(this.plugin.settings.alignment)
          .onChange(async (value) => {
            this.plugin.settings.alignment = value as Alignment;
            await this.plugin.saveSettings();
          });
      });

    const alignSep = alignGroup.createDiv();
    alignSep.style.borderBottom =
      "1px solid var(--background-modifier-border)";
    alignSep.style.margin = "12px 0";

    new Setting(alignGroup)
      .setName("Reset image alignments")
      .setDesc(
        "One-shot: clear every image's per-image alignment override and revert to the global setting above."
      )
      .addButton((button) => {
        button.buttonEl.classList.add("drag-img-reset-btn");
        return button
          .setButtonText("Reset all to current setting")
          .setCta()
          .onClick(() => {
            this.plugin.resetAllImageAlignments();
            alignDropdown.setValue(
              this.plugin.settings.alignment
            );
            this.flashResetFeedback(button);
          });
      });

    new Setting(alignGroup)
      .setName("Enable reading mode context menu")
      .setDesc(
        "When enabled, right-clicking an image in Reading Mode shows the alignment menu. When disabled, Reading Mode is read-only — alignment can only be changed in Live Preview or Source mode."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableReadingModeContextMenu)
          .onChange(async (value) => {
            this.plugin.settings.enableReadingModeContextMenu = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(alignGroup)
      .setName("Reading mode: double-click image to preview")
      .setDesc(
        "When enabled, opening an image's preview in Reading Mode requires a double click instead of a single click. When disabled, Reading Mode keeps Obsidian's native single-click behavior."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableReadingModeDoubleClickZoom)
          .onChange(async (value) => {
            this.plugin.settings.enableReadingModeDoubleClickZoom = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Single Image Display (grouped) ──────────────────────────

    containerEl.createEl("h3", { text: "单图行图片尺寸设置" });

    const singleImageGroup = containerEl.createDiv();
    singleImageGroup.addClass("drag-img-settings-group");

    const mode = this.plugin.settings.singleImageSizeMode;

    // Capture component refs so dropdown onChange and reset button onClick can
    // update the UI in-place (no full this.display() rebuild → no page jitter).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sizeDropdown: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let widthText: any;

    const setWidthDisabled = (disabled: boolean) => {
      if (!widthText) return;
      widthText.setDisabled(disabled);
      widthText.inputEl.style.color = disabled
        ? "var(--text-faint)"
        : "";
    };

    new Setting(singleImageGroup)
      .setName("Single image size")
      .setDesc(
        "How a lone image (a single-image row) is sized. Natural size shows images at their real pixel size, shrunk to fit the editor width; Fixed width renders single images at a set width. Manual corner-resizes stick per image."
      )
      .addDropdown((dropdown) => {
        sizeDropdown = dropdown;
        return dropdown
          .addOption("natural", "Natural size")
          .addOption("fixed", "Fixed width")
          .setValue(mode)
          .onChange(async (value) => {
            this.plugin.settings.singleImageSizeMode =
              value as SingleImageSizeMode;
            await this.plugin.saveSettings();
            // Toggle the width input in-place — no full-page rebuild
            setWidthDisabled(value === "natural");
          });
      })
      .addText((text) => {
        widthText = text;
        text.inputEl.type = "number";
        text.inputEl.min = "100";
        text
          .setValue(String(this.plugin.settings.singleImageWidth))
          .onChange(async (value) => {
            const parsed = parseInt(value, 10);
            this.plugin.settings.singleImageWidth = isFinite(parsed)
              ? Math.max(100, parsed)
              : DEFAULT_SETTINGS.singleImageWidth;
            await this.plugin.saveSettings();
          });
        if (mode === "natural") setWidthDisabled(true);
      });

    // Horizontal separator between the two sub-items
    const sep = singleImageGroup.createDiv();
    sep.style.borderBottom =
      "1px solid var(--background-modifier-border)";
    sep.style.margin = "12px 0";

    new Setting(singleImageGroup)
      .setName("Reset single image sizes")
      .setDesc(
        "One-shot: clear every single image's manual size override and re-apply the current mode."
      )
      .addButton((button) => {
        button.buttonEl.classList.add("drag-img-reset-btn");
        return button
          .setButtonText("Reset all to current setting")
          .setCta()
          .onClick(() => {
            this.plugin.resetAllSingleImages();
            // Sync dropdown + width input in-place to reflect the reset
            sizeDropdown.setValue(
              this.plugin.settings.singleImageSizeMode
            );
            widthText.setValue(
              String(this.plugin.settings.singleImageWidth)
            );
            setWidthDisabled(
              this.plugin.settings.singleImageSizeMode === "natural"
            );
            this.flashResetFeedback(button);
          });
      });

    // Pixel Perfect settings (merged features only) — surfaced as two groups at
    // the tail of the page once the merged host is available.
    if (this.bridge) {
      renderPixelPerfectSettings(containerEl, this.bridge);
    }

    // Move every description element out of the left info column and onto its
    // own full-width line, so long descriptions no longer wrap inside a narrow
    // column beside the control. Re-run per display() since the DOM is rebuilt.
    this.reflowDescriptions();
  }

  /**
   * Re-parent each setting's description element from setting-item-info to the
   * setting-item root. The .drag-img-settings .setting-item flex-wrap + the
   * full-width flex-basis in styles.css then lay it out as a block that spans
   * the whole card, left-aligned with the label and right-aligned with the
   * card edge (below the control).
   */
  private reflowDescriptions(): void {
    this.containerEl.querySelectorAll<HTMLElement>(".setting-item").forEach((item) => {
      const desc = item.querySelector<HTMLElement>(".setting-item-description");
      if (desc) item.appendChild(desc);
    });
  }

  /**
   * One-click feedback for the "Reset all..." buttons: paint the accent color,
   * shrink momentarily, swap the label to "已重置", then restore everything.
   * Rapid double-clicks are ignored (the button is disabled for the 1.5s window).
   */
  private flashResetFeedback(button: ButtonComponent): void {
    const el = button.buttonEl;
    if (el.classList.contains("drag-img-btn-pressed")) return;
    const originalText = el.textContent ?? "Reset all to current setting";
    // Pin the width so the shorter "已重置" label doesn't shrink the button.
    el.style.minWidth = `${el.offsetWidth}px`;
    button.setDisabled(true);
    button.setButtonText("已重置");
    el.classList.add("drag-img-btn-pressed");
    setTimeout(() => {
      button.setDisabled(false);
      button.setButtonText(originalText);
      el.classList.remove("drag-img-btn-pressed");
      el.style.minWidth = "";
    }, 1500);
  }
}
