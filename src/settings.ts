import {
  App,
  ButtonComponent,
  Plugin,
  PluginSettingTab,
  Setting,
  TextComponent,
  requireApiVersion,
  type SettingControl,
  type SettingDefinition,
  type SettingDefinitionItem,
} from "obsidian";
import { DEFAULT_SETTINGS } from "./constants";
import {
  imageMenuSectionDefinitions,
  renderImageMenuSettings,
  type ImageMenuBridge,
} from "./imageMenu/menuSettingsUi";
import {
  createMaintenanceSection,
  type MaintenanceBridge,
  type MaintenanceSection,
} from "./maintenance/maintenanceSettingsUi";
import { applySettingButtonStyle } from "./settingsButton";
import { logger, type LogLevel } from "./logger";
import { setLanguage, t, type Language, type Localized } from "./i18n/language";
import {
  CONTROL_ROWS,
  LANGUAGE_OPTIONS,
  SETTINGS_SECTIONS,
  type ControlRow,
  type HostId,
  type RenderRowId,
  type RowSpec,
} from "./settingsSpecs";

import { Alignment, SingleImageSizeMode } from "./constants";
import { setStyleImportant } from "./utils";

export interface DragImageSettings {
  /** Display language for the settings tab and the image context menu. */
  language: Language;
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

/** The label the "Reset all…" rows carry, and the flash it shows once pressed. */
const RESET_BUTTON_TEXT: Localized = {
  zh: "全部重置为当前设置",
  en: "Reset all to current setting",
};
const RESET_DONE_TEXT: Localized = { zh: "已重置", en: "Reset" };

const asNumber = (value: unknown): number => (typeof value === "number" ? value : 0);
const asBoolean = (value: unknown): boolean => value === true;
const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const asAlignment = (value: unknown): Alignment =>
  value === "center" || value === "right" ? value : "left";
const asLanguage = (value: unknown): Language => (value === "zh" ? "zh" : "en");

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
  merged.language = asLanguage(merged.language);
  return merged;
}

/** Build the declarative control descriptor for one `control` row. */
function controlSpec(row: ControlRow): SettingControl {
  switch (row.kind) {
    case "slider":
      return { key: row.key, type: "slider", min: row.min, max: row.max, step: row.step };
    case "toggle":
      return { key: row.key, type: "toggle" };
    case "dropdown":
      return {
        key: row.key,
        type: "dropdown",
        options: Object.fromEntries(row.options.map(([value, label]) => [value, t(label)])),
      };
    case "text":
      return { key: row.key, type: "text" };
  }
}

/**
 * The plugin's settings tab, rendered two ways from one row table
 * (see ./settingsSpecs):
 *
 *  - `display()` — the imperative path for Obsidian below 1.13.
 *  - `getSettingDefinitions()` — the declarative path for 1.13 and later, which
 *    is what puts the rows into Obsidian's settings search. Obsidian skips
 *    `display()` entirely once it returns a non-empty array, so the two paths
 *    never both run; both read the same table and call the same row builders.
 *
 * Sections owned by sibling modules (the image menu and the vault maintenance
 * passes) contribute definitions of their own in the declarative path too, so
 * the framework — which wraps a group and draws its heading — keeps owning the
 * card around their rows instead of the module appending one inside a row.
 *
 * Persistence goes through `saveSettings()` rather than the framework's default
 * control binding: the plugin's on-disk envelope is `{ settings, imageMenu,
 * preservedSizes }` and a plain write of `plugin.settings` would drop the other
 * two namespaces.
 */
export class DragImageSettingTab extends PluginSettingTab {
  plugin: IDragImagePlugin;
  private bridge: ImageMenuBridge | null;
  /** Tab-owned so an in-flight maintenance pass keeps its progress across the
   *  re-renders the declarative path performs. */
  private maintenance: MaintenanceSection | null = null;
  private reflowObserver: MutationObserver | null = null;

  constructor(app: App, plugin: IDragImagePlugin, bridge?: ImageMenuBridge | null) {
    super(app, plugin);
    this.plugin = plugin;
    this.bridge = bridge ?? null;
  }

  // ── Imperative path (Obsidian < 1.13) ────────────────────────────────

  display(): void {
    this.disconnectReflow();
    const { containerEl } = this;
    containerEl.empty();
    // Scope the full-width-description reflow styles to this settings tab only.
    containerEl.addClass("diaa-settings");

    // No plugin-name heading: the settings tab already carries it as its title.

    for (const section of SETTINGS_SECTIONS) {
      if (section.kind === "host") {
        if (this.hostAvailable(section.id)) this.mountHost(containerEl, section.id);
        continue;
      }
      new Setting(containerEl).setName(t(section.heading)).setHeading();
      const group = containerEl.createDiv();
      group.addClass("diaa-settings-group");
      for (const row of section.rows) this.mountRow(group, row);
    }

    // Move every description element out of the left info column and onto its
    // own full-width line, so long descriptions no longer wrap inside a narrow
    // column beside the control. Re-run per display() since the DOM is rebuilt.
    this.reflowDescriptions();
  }

  private mountRow(containerEl: HTMLElement, row: RowSpec): void {
    const setting = new Setting(containerEl).setName(t(row.name)).setDesc(t(row.desc));
    if (row.kind === "render") {
      this.buildRenderRow(setting, row.id);
      return;
    }
    this.buildControlRow(setting, row);
  }

  private buildControlRow(setting: Setting, row: ControlRow): void {
    switch (row.kind) {
      case "slider":
        setting.addSlider((slider) =>
          slider
            .setLimits(row.min, row.max, row.step)
            .setValue(this.plugin.settings[row.key])
            .onChange((value) => void this.assign(row.key, value))
        );
        break;
      case "toggle":
        setting.addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings[row.key])
            .onChange((value) => void this.assign(row.key, value))
        );
        break;
      case "dropdown":
        setting.addDropdown((dropdown) => {
          for (const [value, label] of row.options) dropdown.addOption(value, t(label));
          dropdown
            .setValue(this.plugin.settings[row.key])
            .onChange((value) => void this.assign(row.key, value as Alignment));
        });
        break;
      case "text":
        setting.addText((text) =>
          text
            .setValue(this.plugin.settings[row.key])
            .onChange((value) =>
              void this.assign(row.key, value || DEFAULT_SETTINGS.imageExtensions)
            )
        );
        break;
    }
  }

  // ── Declarative path (Obsidian >= 1.13) ──────────────────────────────

  getSettingDefinitions(): SettingDefinitionItem[] {
    if (this.containerEl) this.containerEl.addClass("diaa-settings");

    const items: SettingDefinitionItem[] = [];
    for (const section of SETTINGS_SECTIONS) {
      if (section.kind === "host") {
        if (!this.hostAvailable(section.id)) continue;
        items.push(...this.hostDefinitions(section.id));
        continue;
      }
      items.push({
        type: "group",
        heading: t(section.heading),
        items: section.rows.map((row) => this.definitionFor(row)),
      });
    }
    return items;
  }

  /** What a host module brings: its own group — heading and card included — and
   *  its own rows, rather than a placeholder row the tab has to swap out. */
  private hostDefinitions(id: HostId): SettingDefinitionItem[] {
    if (id === "imageMenuSection") {
      if (!this.bridge) return [];
      // A reorder redraws the rows in their new order, which means asking the tab
      // to re-read these definitions. `update()` arrived in 1.13 — but so did the
      // render path that reads them, and `refresh` runs only from a row button,
      // so the call below is unreachable on anything older.
      const refresh = (): void => {
        if (requireApiVersion("1.13.0")) this.update();
      };
      return imageMenuSectionDefinitions(this.bridge, refresh);
    }
    return this.maintenanceSection().definitions();
  }

  private definitionFor(row: RowSpec): SettingDefinition {
    if (row.kind === "render") {
      return {
        name: t(row.name),
        desc: t(row.desc),
        render: (setting) => this.buildRenderRow(setting, row.id),
      };
    }
    return { name: t(row.name), desc: t(row.desc), control: controlSpec(row) };
  }

  // ── Value binding ────────────────────────────────────────────────────

  getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  setControlValue(key: string, value: unknown): void | Promise<void> {
    const row = CONTROL_ROWS.find((candidate) => candidate.key === key);
    switch (row?.kind) {
      case "slider":
        return this.assign(row.key, asNumber(value));
      case "toggle":
        return this.assign(row.key, asBoolean(value));
      case "dropdown":
        return this.assign(row.key, asAlignment(value));
      case "text":
        return this.assign(row.key, asString(value) || DEFAULT_SETTINGS.imageExtensions);
      default:
        return undefined;
    }
  }

  private assign<K extends keyof DragImageSettings>(key: K, value: DragImageSettings[K]): Promise<void> {
    this.plugin.settings[key] = value;
    this.applySideEffect(key, value);
    return this.plugin.saveSettings();
  }

  /** Effects a setting change has beyond persisting the value. */
  private applySideEffect(key: keyof DragImageSettings, value: DragImageSettings[keyof DragImageSettings]): void {
    switch (key) {
      case "language": {
        setLanguage(value as Language);
        // Every string on this page was resolved through `t()` as it was drawn,
        // so the page has to be drawn again — the row table itself only holds
        // pairs, it does not settle on a language. 1.13+ re-reads its
        // definitions on `update()`; below it `display()` is the entry point.
        // Nothing else has to be told: the context menu and the notices build
        // their copy when they open.
        if (requireApiVersion("1.13.0")) this.update();
        else this.display();
        break;
      }
      case "logLevel":
        // Both sinks read the logger singleton, so a change takes effect on the
        // next log call — no plugin reload needed.
        logger.setMinLevel(value as LogLevel);
        break;
      case "logToFile": {
        const enabled = value as boolean;
        logger.setFileEnabled(enabled);
        // Clear once on enable, so log.txt only ever holds the current session.
        if (enabled) void logger.clearLogFile();
        break;
      }
      default:
        break;
    }
  }

  // ── Rows whose body needs imperative code ────────────────────────────

  private buildRenderRow(setting: Setting, id: RenderRowId): void {
    this.ensureReflow();
    switch (id) {
      case "language":
        this.buildLanguageRow(setting);
        break;
      case "singleImageSize":
        this.buildSingleImageSize(setting);
        break;
      case "resetAlignments":
        this.buildResetRow(setting, () => this.plugin.resetAllImageAlignments());
        break;
      case "resetSingleImages":
        this.buildResetRow(setting, () => this.plugin.resetAllSingleImages());
        break;
      case "logLevel":
        this.buildLogLevel(setting);
        break;
    }
  }

  /**
   * Display language: a segmented bar rather than a dropdown, because the choice
   * is binary and each segment is labelled in the language it selects — the
   * control is its own sample.
   *
   * The two segments go into one `diaa-segmented` wrapper (see styles.css) so the
   * pair reads as a single control: a grey track carrying both labels, one of
   * which is filled in the same green as the reset buttons. That is why this row
   * is the one control that does not wear `.diaa-setting-btn`.
   *
   * The buttons are still built by the framework, and the wrapper lives *inside*
   * `controlEl`: the declarative path reuses a `settingEl` across updates and
   * clears `controlEl` only, so a custom node placed here is repainted with the
   * rest of the row instead of accumulating. Choosing a language re-renders the
   * whole tab (see `applySideEffect`), which is also what moves the plate.
   */
  private buildLanguageRow(setting: Setting): void {
    const bar = setting.controlEl.createDiv({ cls: "diaa-segmented" });
    for (const [value, label] of LANGUAGE_OPTIONS) {
      const selected = this.plugin.settings.language === value;
      setting.addButton((button) => {
        button.buttonEl.addClass("diaa-segment");
        if (selected) button.buttonEl.addClass("is-on");
        button.setButtonText(label).onClick(() => {
          if (this.plugin.settings.language === value) return;
          void this.assign("language", value);
        });
        // `addButton` appends to `controlEl`; the frame is where it belongs.
        bar.appendChild(button.buttonEl);
      });
    }
  }

  /**
   * A lone image's size: a mode dropdown plus the fixed-width input. One row
   * carries both controls, so it can't be a `control` row; the width input is
   * disabled while the mode is natural size.
   */
  private buildSingleImageSize(setting: Setting): void {
    const mode = this.plugin.settings.singleImageSizeMode;
    let widthText: TextComponent | null = null;
    const setWidthDisabled = (disabled: boolean) => {
      if (!widthText) return;
      widthText.setDisabled(disabled);
      widthText.inputEl.style.color = disabled ? "var(--text-faint)" : "";
    };

    setting
      .addDropdown((dropdown) =>
        dropdown
          .addOption("natural", t({ zh: "原始尺寸", en: "Natural size" }))
          .addOption("fixed", t({ zh: "固定宽度", en: "Fixed width" }))
          .setValue(mode)
          .onChange((value) => {
            void this.assign("singleImageSizeMode", value as SingleImageSizeMode);
            // Toggle the width input in-place — no full-page rebuild
            setWidthDisabled(value === "natural");
          })
      )
      .addText((text) => {
        widthText = text;
        text.inputEl.type = "number";
        text.inputEl.min = "100";
        text
          .setValue(String(this.plugin.settings.singleImageWidth))
          .onChange((value) => {
            const parsed = parseInt(value, 10);
            void this.assign(
              "singleImageWidth",
              isFinite(parsed) ? Math.max(100, parsed) : DEFAULT_SETTINGS.singleImageWidth
            );
          });
        if (mode === "natural") setWidthDisabled(true);
      });
  }

  /**
   * One-click feedback for a "Reset all..." row: paint the accent color, shrink
   * momentarily, swap the label to the done flash, then restore everything.
   * Rapid double-clicks are ignored (the button is disabled for the 1.5s window).
   */
  private buildResetRow(setting: Setting, reset: () => void): void {
    setting.settingEl.addClass("diaa-row-sep-above");
    setting.addButton((button) => {
      applySettingButtonStyle(button)
        .setButtonText(t(RESET_BUTTON_TEXT))
        .onClick(() => {
          reset();
          this.flashResetFeedback(button);
        });
    });
  }

  /**
   * Logging & debugging: a 4-stop severity slider (ERROR → WARN → INFO → DEBUG,
   * least → most verbose) gating both sinks. The control takes the whole card
   * row so the track gets its full width, with four tick labels and a row of
   * stop dots underneath.
   */
  private buildLogLevel(setting: Setting): void {
    let active = LOG_LEVELS.indexOf(this.plugin.settings.logLevel);
    if (active < 0) active = 0;

    let ticks: HTMLElement | null = null;
    let nodes: HTMLElement | null = null;
    // Paint the current stop on the labels (accent + caret) and on the track dots:
    // dots to the thumb's left take the filled-track colour, and the dot under the
    // thumb itself is dropped so it can't show through it.
    const markActive = (idx: number) => {
      ticks?.querySelectorAll<HTMLElement>(".diaa-log-tick").forEach((el, i) => {
        el.toggleClass("is-active", i === idx);
      });
      nodes?.querySelectorAll<HTMLElement>(".diaa-log-node").forEach((el, i) => {
        el.toggleClass("is-on", i < idx);
        el.toggleClass("is-hidden", i === idx);
      });
    };

    setting.addSlider((slider) =>
      slider
        .setLimits(0, LOG_LEVELS.length - 1, 1)
        .setValue(active)
        .onChange((value) => {
          const level = LOG_LEVELS[value] ?? "ERROR";
          void this.assign("logLevel", level);
          markActive(value);
        })
    );

    const controlEl = setting.controlEl;
    controlEl.addClass("diaa-log-control");

    const ticksEl = controlEl.createDiv("diaa-log-ticks");
    for (const name of LOG_LEVELS) {
      ticksEl.createSpan({ text: name, cls: "diaa-log-tick" });
    }
    // Dots live in their own layer anchored to the stops: the outer two labels are
    // pushed inside the track ends, so they no longer sit over their stops.
    const nodesEl = ticksEl.createDiv("diaa-log-nodes");
    for (let i = 0; i < LOG_LEVELS.length; i++) {
      nodesEl.createSpan({ cls: "diaa-log-node" });
    }
    ticks = ticksEl;
    nodes = nodesEl;

    // How far the info column is inset from the control column varies by version
    // and theme, so measure the gap and indent the track to start flush with the
    // "日志级别" name rather than assuming a value. Same for where the track centre
    // sits above the ticks row and for the native thumb's radius.
    const measure = (): boolean => {
      const inset = Math.round(
        setting.nameEl.getBoundingClientRect().left - controlEl.getBoundingClientRect().left
      );
      if (inset > 0 && inset < 40) controlEl.style.marginLeft = `${inset}px`;

      const sliderEl = controlEl.querySelector<HTMLInputElement>('input[type="range"]');
      if (!sliderEl) return false;
      const sliderRect = sliderEl.getBoundingClientRect();
      const ticksRect = ticksEl.getBoundingClientRect();
      // The declarative path can run this builder before the row is in the
      // document, in which case nothing has been laid out yet and every
      // measurement is zero; report that so the caller retries next frame.
      if (sliderRect.height === 0 || ticksRect.height === 0) return false;
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
      return true;
    };
    if (!measure()) window.requestAnimationFrame(() => void measure());

    markActive(active);
  }

  // ── Sections mounted from sibling modules ────────────────────────────

  private hostAvailable(id: HostId): boolean {
    return id !== "imageMenuSection" || this.bridge !== null;
  }

  private mountHost(containerEl: HTMLElement, id: HostId): void {
    if (id === "imageMenuSection") {
      if (this.bridge) renderImageMenuSettings(containerEl, this.bridge);
      return;
    }
    this.maintenanceSection().mount(containerEl);
  }

  /** Vault-wide maintenance: restore every DIAA-managed row to the native
   *  `![[file]]` form (the counterpart to the always-filled write policy), and
   *  pre-place the word slots on every hostable row. One instance per tab, so a
   *  pass in flight is not restarted by a rebuild of the page. */
  private maintenanceSection(): MaintenanceSection {
    if (!this.maintenance) {
      this.maintenance = createMaintenanceSection(this.app, () => this.maintenanceBridge());
    }
    return this.maintenance;
  }

  /** Read per run, so a settings change reaches the next pass without a rebuild. */
  private maintenanceBridge(): MaintenanceBridge {
    return {
      extensions: this.plugin.settings.imageExtensions,
      alignment: this.plugin.settings.alignment,
      maxImagesPerRow: this.plugin.settings.maxImagesPerRow,
    };
  }

  // ── Description reflow ───────────────────────────────────────────────

  /**
   * Re-parent each setting's description element from setting-item-info to the
   * setting-item root. The .diaa-settings .setting-item flex-wrap + the
   * full-width flex-basis in styles.css then lay it out as a block that spans
   * the whole card, left-aligned with the label and right-aligned with the
   * card edge (below the control).
   */
  private reflowDescriptions(): void {
    this.containerEl.querySelectorAll<HTMLElement>(".setting-item").forEach((item) => {
      const desc = item.querySelector<HTMLElement>(".setting-item-description");
      // Skip an already-reflowed description: re-appending it would mutate the
      // DOM again and keep the observer below firing on every pass.
      if (!desc || desc.parentElement === item) return;
      // A maintenance row carries a progress bar after its control, and that bar
      // has to stay the row's last line — so the description goes in above it
      // rather than at the end.
      const bar = item.querySelector<HTMLElement>(":scope > .diaa-vault-progress");
      if (bar) item.insertBefore(desc, bar);
      else item.appendChild(desc);
    });
  }

  /**
   * Declarative rendering has no "finished" hook to reflow from, so watch the
   * container instead: any batch of rows the framework (or a mounted section)
   * adds is reflowed as it lands.
   */
  private ensureReflow(): void {
    this.reflowDescriptions();
    if (this.reflowObserver) return;
    this.reflowObserver = new MutationObserver(() => this.reflowDescriptions());
    this.reflowObserver.observe(this.containerEl, { childList: true, subtree: true });
  }

  private disconnectReflow(): void {
    this.reflowObserver?.disconnect();
    this.reflowObserver = null;
  }

  /**
   * One-click feedback for the "Reset all..." buttons: paint the accent color,
   * shrink momentarily, swap the label to the done flash, then restore everything.
   * Rapid double-clicks are ignored (the button is disabled for the 1.5s window).
   *
   * The fill and text colour are written inline because the competitor is the
   * theme's own CTA rule (`--color-btn-primary-bg`), which a stylesheet
   * declaration cannot outrank by specificity; only the transform — nobody else
   * animates it — is left to the class in styles.css.
   */
  private flashResetFeedback(button: ButtonComponent): void {
    const el = button.buttonEl;
    if (el.classList.contains("diaa-btn-pressed")) return;
    const originalText = el.textContent ?? t(RESET_BUTTON_TEXT);
    // Pin the width so the shorter flash label doesn't shrink the button.
    el.style.minWidth = `${el.offsetWidth}px`;
    button.setDisabled(true);
    button.setButtonText(t(RESET_DONE_TEXT));
    setStyleImportant(el, "background-color", "var(--color-green)");
    setStyleImportant(el, "color", "#fff");
    setStyleImportant(el, "opacity", "1");
    el.classList.add("diaa-btn-pressed");
    window.setTimeout(() => {
      button.setDisabled(false);
      button.setButtonText(originalText);
      el.classList.remove("diaa-btn-pressed");
      el.style.removeProperty("background-color");
      el.style.removeProperty("color");
      el.style.removeProperty("opacity");
      el.setCssStyles({ minWidth: "" });
    }, 1500);
  }
}
