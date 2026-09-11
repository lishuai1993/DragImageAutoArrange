import {
  App,
  ButtonComponent,
  DropdownComponent,
  Plugin,
  PluginSettingTab,
  Setting,
  TextComponent,
} from "obsidian";
import { DEFAULT_SETTINGS } from "./constants";
import { renderPixelPerfectSettings, type PixelPerfectBridge } from "./pixelPerfect/ppSettingsUi";
import { logger, type LogLevel } from "./logger";

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
  logLevel: LogLevel;
  logToFile: boolean;
}

/** Slider stops, least→most verbose. The slider index maps into this array. */
const LOG_LEVELS: LogLevel[] = ["ERROR", "WARN", "INFO", "DEBUG"];

export interface IDragImagePlugin extends Plugin {
  settings: DragImageSettings;
  saveSettings(): Promise<void>;
  /** One-shot: reset every single-image row to the current size setting. */
  resetAllSingleImages(): void;
  /** One-shot: clear every per-image alignment, reverting to the global setting. */
  resetAllImageAlignments(): void;
}

export async function loadSettings(plugin: { loadData(): Promise<unknown> }): Promise<DragImageSettings> {
  const data = await plugin.loadData();
  // Support both new format ({ settings, preservedSizes }) and old format (settings directly)
  const raw = (data as { settings?: unknown } | null | undefined)?.settings ?? data;
  const settings = (raw && typeof raw === "object" ? raw : {}) as Partial<DragImageSettings>;
  const merged = Object.assign({}, DEFAULT_SETTINGS, settings);
  // Drop the pre-refactor `enabled` key so a stale saved `false` can't linger
  // in settings data — enable/disable is now exclusively the Obsidian plugin-list toggle.
  delete (merged as unknown as Record<string, unknown>).enabled;
  return merged;
}

export class DragImageSettingTab extends PluginSettingTab {
  plugin: IDragImagePlugin;
  private bridge: PixelPerfectBridge | null;

  constructor(app: App, plugin: IDragImagePlugin, bridge?: PixelPerfectBridge | null) {
    super(app, plugin);
    this.plugin = plugin;
    this.bridge = bridge ?? null;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    // Scope the full-width-description reflow styles to this settings tab only.
    containerEl.addClass("drag-img-settings");

    // No plugin-name heading: the settings tab already carries it as its title.

    // ── Layout & interaction (global) ──────────────────────────
    new Setting(containerEl).setName("行布局与交互设置").setHeading();
    const layoutGroup = containerEl.createDiv();
    layoutGroup.addClass("drag-img-settings-group");

    new Setting(layoutGroup)
      .setName("Default row height")
      .setDesc("Default uniform height (px) for image rows. Individual rows adapt based on image aspect ratios.")
      .addSlider((slider) =>
        slider
          .setLimits(80, 600, 10)
          .setValue(this.plugin.settings.defaultRowHeight)
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
          .onChange(async (value) => {
            this.plugin.settings.topBarSensitivity = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(layoutGroup)
      .setName("Ghost image width")
      .setDesc("Width (px) of the drag ghost image that follows the Cursor (100-500 px).")
      .addSlider((slider) =>
        slider
          .setLimits(100, 500, 10)
          .setValue(this.plugin.settings.ghostImageWidth)
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
          .onChange(async (value) => {
            this.plugin.settings.menuScalePercent = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(layoutGroup)
      .setName("Image extensions")
      .setDesc("Comma-separated list of image file extensions to detect (e.g., PNG,JPG,GIF,webp).")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.imageExtensions)
          .onChange(async (value) => {
            this.plugin.settings.imageExtensions = value || DEFAULT_SETTINGS.imageExtensions;
            await this.plugin.saveSettings();
          })
      );

    // ── Image Alignment (grouped) ──────────────────────────────

    new Setting(containerEl).setName("图片统一对齐设置").setHeading();

    const alignGroup = containerEl.createDiv();
    alignGroup.addClass("drag-img-settings-group");

    let alignDropdown: DropdownComponent | null = null;

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
    alignSep.setCssStyles({ borderBottom: "1px solid var(--background-modifier-border)" });
    alignSep.setCssStyles({ margin: "12px 0" });

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
            alignDropdown?.setValue(
              this.plugin.settings.alignment
            );
            this.flashResetFeedback(button);
          });
      });

    new Setting(alignGroup)
      .setName("Enable reading mode context menu")
      .setDesc(
        "When enabled, right-clicking an image in reading mode shows the alignment menu. When disabled, reading mode is read-only — alignment can only be changed in live preview or source mode."
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
        "When enabled, opening an image's preview in reading mode requires a double click instead of a single click. When disabled, reading mode keeps Obsidian's native single-click behavior."
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

    new Setting(containerEl).setName("单图行图片尺寸设置").setHeading();

    const singleImageGroup = containerEl.createDiv();
    singleImageGroup.addClass("drag-img-settings-group");

    const mode = this.plugin.settings.singleImageSizeMode;

    // Capture component refs so dropdown onChange and reset button onClick can
    // update the UI in-place (no full this.display() rebuild → no page jitter).
    let sizeDropdown: DropdownComponent | null = null;
    let widthText: TextComponent | null = null;

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
    sep.setCssStyles({ borderBottom: "1px solid var(--background-modifier-border)" });
    sep.setCssStyles({ margin: "12px 0" });

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
            sizeDropdown?.setValue(
              this.plugin.settings.singleImageSizeMode
            );
            widthText?.setValue(
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

    this.renderLogSettings(containerEl);

    // Move every description element out of the left info column and onto its
    // own full-width line, so long descriptions no longer wrap inside a narrow
    // column beside the control. Re-run per display() since the DOM is rebuilt.
    this.reflowDescriptions();
  }

  /**
   * Logging & debugging group. A 4-stop severity slider (ERROR → WARN → INFO →
   * DEBUG, least → most verbose) gates both sinks; a toggle controls the log.txt
   * sink. Both write straight through to the logger singleton, so a change takes
   * effect on the next log call — no plugin reload needed.
   */
  private renderLogSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("日志与调试设置").setHeading();
    const group = containerEl.createDiv();
    group.addClass("drag-img-settings-group");

    let active = LOG_LEVELS.indexOf(this.plugin.settings.logLevel);
    if (active < 0) active = 0;

    let ticksEl: HTMLElement | null = null;
    let nodesEl: HTMLElement | null = null;
    // Paint the current stop on the labels (accent + caret) and on the track dots:
    // dots to the thumb's left take the filled-track colour, and the dot under the
    // thumb itself is dropped so it can't show through it.
    const markActive = (idx: number) => {
      ticksEl?.querySelectorAll<HTMLElement>(".drag-img-log-tick").forEach((el, i) => {
        el.toggleClass("is-active", i === idx);
      });
      nodesEl?.querySelectorAll<HTMLElement>(".drag-img-log-node").forEach((el, i) => {
        el.toggleClass("is-on", i < idx);
        el.toggleClass("is-hidden", i === idx);
      });
    };

    const levelSetting = new Setting(group)
      .setName("日志级别")
      .setDesc(
        "低于所选级别的日志不会输出，同时作用于控制台与 log.txt。默认 error，仅记录错误。"
      )
      .addSlider((slider) =>
        slider
          .setLimits(0, LOG_LEVELS.length - 1, 1)
          .setValue(active)
          .onChange(async (value) => {
            const level = LOG_LEVELS[value] ?? "ERROR";
            this.plugin.settings.logLevel = level;
            logger.setMinLevel(level);
            markActive(value);
            await this.plugin.saveSettings();
          })
      );

    // The control takes the whole card row so the track gets its full width, with
    // four tick labels and a row of stop dots underneath.
    const controlEl = levelSetting.controlEl;
    controlEl.addClass("drag-img-log-control");
    // How far the info column is inset from the control column varies by version
    // and theme, so measure the gap and indent the track to start flush with the
    // "日志级别" name rather than assuming a value.
    const inset = Math.round(
      levelSetting.nameEl.getBoundingClientRect().left -
        controlEl.getBoundingClientRect().left
    );
    if (inset > 0 && inset < 40) controlEl.style.marginLeft = `${inset}px`;

    ticksEl = controlEl.createDiv("drag-img-log-ticks");
    for (const name of LOG_LEVELS) {
      ticksEl.createSpan({ text: name, cls: "drag-img-log-tick" });
    }
    // Dots live in their own layer anchored to the stops: the outer two labels are
    // pushed inside the track ends, so they no longer sit over their stops.
    nodesEl = ticksEl.createDiv("drag-img-log-nodes");
    for (let i = 0; i < LOG_LEVELS.length; i++) {
      nodesEl.createSpan({ cls: "drag-img-log-node" });
    }
    // Where the track centre sits above the ticks row depends on the theme's
    // slider height and on whatever gap the flex layout adds, so measure the lift
    // instead of assuming either.
    const sliderEl = controlEl.querySelector<HTMLInputElement>('input[type="range"]');
    if (sliderEl) {
      const sliderRect = sliderEl.getBoundingClientRect();
      const ticksRect = ticksEl.getBoundingClientRect();
      const lift = ticksRect.top - sliderRect.top - sliderRect.height / 2;
      if (lift > 0) {
        controlEl.style.setProperty("--diaa-log-lift", `${Math.round(lift)}px`);
      }
      // The native thumb is inset by half its own width at each end of the track,
      // so its centre travels r..(100% - r) and the middle two stops sit at
      // r + i·(100% - 2r)/3 — not at the value's plain fraction of the track.
      // Every theme picks its own thumb size, so read the used one here instead
      // of assuming (the pseudo-element style is Chromium-only; the CSS variable
      // is the fallback).
      const num = (v: string | null | undefined) => {
        const n = parseFloat(v ?? "");
        return Number.isFinite(n) ? n : 0;
      };
      const thumbCs = getComputedStyle(sliderEl, "::-webkit-slider-thumb");
      const thumbW =
        num(thumbCs.width) ||
        num(getComputedStyle(sliderEl).getPropertyValue("--slider-thumb-width"));
      const thumbR =
        (thumbW + num(thumbCs.borderLeftWidth) + num(thumbCs.borderRightWidth)) / 2;
      if (thumbR > 0 && thumbR < 40) {
        controlEl.style.setProperty("--diaa-log-thumb-r", `${thumbR}px`);
      }
      logger.debug("LOG_SLIDER_GEOM", { thumbW, thumbR, lift: Math.round(lift) });
    }
    markActive(active);

    new Setting(group)
      .setName("写入 log.txt")
      .setDesc(
        "开启后，符合级别的日志写入插件目录下的 log.txt（开启时清空一次，便于读取本次会话）。"
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.logToFile)
          .onChange(async (value) => {
            this.plugin.settings.logToFile = value;
            logger.setFileEnabled(value);
            if (value) await logger.clearLogFile();
            await this.plugin.saveSettings();
          })
      );
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
    window.setTimeout(() => {
      button.setDisabled(false);
      button.setButtonText(originalText);
      el.classList.remove("drag-img-btn-pressed");
      el.setCssStyles({ minWidth: "" });
    }, 1500);
  }
}
