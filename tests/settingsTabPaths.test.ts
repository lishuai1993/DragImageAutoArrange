/**
 * @vitest-environment jsdom
 *
 * The settings tab's own entry points, and which of them a language change
 * redraws through.
 *
 * The tab is drawn two ways from one row table, and below 1.13 the only way in
 * is `display()`. A language change has to draw the page again — every string on
 * it was resolved through `t()` as it was drawn — and that redraw must not go
 * through `display()`, which the framework has deprecated since 1.13. So
 * `display()` is a forwarder to the page and the redraw calls the page directly.
 *
 * What is pinned here is that the forwarder still draws (the older path would
 * otherwise come up blank) and that the two redraw routes stay mutually
 * exclusive: below 1.13 the page is rebuilt in the new language, on 1.13 nothing
 * is touched and `update()` is what was asked to redraw.
 *
 * `Setting` and `PluginSettingTab` are stubbed locally: the assertions are about
 * a page being built and rebuilt, which needs a control column, a container and
 * an `update()` to count — none of which the shared mock's empty classes carry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { App } from 'obsidian';

/** `api13` stands in for the running Obsidian's version; `updates` counts the
 *  framework redraw the tab asks for on it. Both have to exist before the module
 *  under test is imported, hence the hoist. */
const h = vi.hoisted(() => ({ api13: false, updates: 0 }));

vi.mock('obsidian', () => {
  class StubButton {
    readonly buttonEl = document.createEl('button');

    setButtonText(text: string): this {
      this.buttonEl.textContent = text;
      return this;
    }

    setDisabled(disabled: boolean): this {
      this.buttonEl.disabled = disabled;
      return this;
    }

    setCta(): this {
      return this;
    }

    setTooltip(_tooltip: string): this {
      return this;
    }

    onClick(callback: () => void): this {
      this.buttonEl.addEventListener('click', () => callback());
      return this;
    }
  }

  class StubDropdown {
    readonly selectEl = document.createEl('select');

    addOption(value: string, label: string): this {
      const option = document.createEl('option');
      option.value = value;
      option.textContent = label;
      this.selectEl.appendChild(option);
      return this;
    }

    setValue(value: string): this {
      this.selectEl.value = value;
      return this;
    }

    onChange(callback: (value: string) => void): this {
      this.selectEl.addEventListener('change', () => callback(this.selectEl.value));
      return this;
    }
  }

  class StubText {
    readonly inputEl = document.createEl('input');

    setValue(value: string): this {
      this.inputEl.value = value;
      return this;
    }

    setDisabled(disabled: boolean): this {
      this.inputEl.disabled = disabled;
      return this;
    }

    onChange(callback: (value: string) => void): this {
      this.inputEl.addEventListener('input', () => callback(this.inputEl.value));
      return this;
    }
  }

  class StubToggle {
    readonly toggleEl = document.createEl('input');

    setValue(value: boolean): this {
      this.toggleEl.checked = value;
      return this;
    }

    setDisabled(_disabled: boolean): this {
      return this;
    }

    onChange(callback: (value: boolean) => void): this {
      this.toggleEl.addEventListener('change', () => callback(this.toggleEl.checked));
      return this;
    }
  }

  class StubSlider {
    readonly sliderEl = document.createEl('input');

    setLimits(): this {
      return this;
    }

    setValue(): this {
      return this;
    }

    onChange(): this {
      return this;
    }
  }

  class StubSetting {
    readonly settingEl: HTMLElement;
    readonly infoEl: HTMLElement;
    readonly nameEl: HTMLElement;
    readonly descEl: HTMLElement;
    readonly controlEl: HTMLElement;

    constructor(containerEl: HTMLElement) {
      this.settingEl = containerEl.createDiv('setting-item');
      this.infoEl = this.settingEl.createDiv('setting-item-info');
      this.nameEl = this.infoEl.createDiv('setting-item-name');
      this.descEl = this.infoEl.createDiv('setting-item-description');
      this.controlEl = this.settingEl.createDiv('setting-item-control');
    }

    setName(name: string): this {
      this.nameEl.setText(name);
      return this;
    }

    setDesc(desc: string): this {
      this.descEl.setText(desc);
      return this;
    }

    setHeading(): this {
      this.settingEl.addClass('setting-item-heading');
      return this;
    }

    setClass(cls: string): this {
      this.settingEl.addClass(cls);
      return this;
    }

    setDisabled(_disabled: boolean): this {
      return this;
    }

    setTooltip(_tooltip: string): this {
      return this;
    }

    addButton(callback: (component: StubButton) => unknown): this {
      const button = new StubButton();
      this.controlEl.appendChild(button.buttonEl);
      callback(button);
      return this;
    }

    addToggle(callback: (component: StubToggle) => unknown): this {
      const toggle = new StubToggle();
      this.controlEl.appendChild(toggle.toggleEl);
      callback(toggle);
      return this;
    }

    addSlider(callback: (component: StubSlider) => unknown): this {
      const slider = new StubSlider();
      this.controlEl.appendChild(slider.sliderEl);
      callback(slider);
      return this;
    }

    addDropdown(callback: (component: StubDropdown) => unknown): this {
      const dropdown = new StubDropdown();
      this.controlEl.appendChild(dropdown.selectEl);
      callback(dropdown);
      return this;
    }

    addText(callback: (component: StubText) => unknown): this {
      const text = new StubText();
      this.controlEl.appendChild(text.inputEl);
      callback(text);
      return this;
    }

    /** Mirrors Obsidian's: the control column is all that gets emptied. */
    clear(): this {
      this.controlEl.empty();
      return this;
    }
  }

  /** The base class the tab extends: it owns the container, and it is where the
   *  1.13 redraw the tab asks for lands. */
  class StubPluginSettingTab {
    readonly containerEl: HTMLElement;

    constructor(_app: unknown, _plugin: unknown) {
      this.containerEl = document.body.createDiv();
    }

    update(): void {
      h.updates += 1;
    }
  }

  class StubModal {
    constructor(_app: unknown) {}
    open(): void {}
    close(): void {}
  }

  class StubNotice {
    constructor(_message: unknown) {}
  }

  return {
    Setting: StubSetting,
    PluginSettingTab: StubPluginSettingTab,
    Modal: StubModal,
    Notice: StubNotice,
    ButtonComponent: StubButton,
    ToggleComponent: class {},
    DropdownComponent: StubDropdown,
    TextComponent: StubText,
    SliderComponent: StubSlider,
    requireApiVersion: () => h.api13,
  };
});

import { DragImageSettingTab, type DragImageSettings, type IDragImagePlugin } from '../src/settings';
import { DEFAULT_SETTINGS } from '../src/constants';
import { setLanguage } from '../src/i18n/language';

/** The copy the two languages differ by on this page — the language group's own
 *  heading and its row, so a repaint is visible in one string. */
const EN_ROW = 'Display language';
const ZH_ROW = '显示语言';
const EN_HEADING = 'Interface language';
const ZH_HEADING = '界面语言';

interface TabFixture {
  tab: DragImageSettingTab;
  containerEl: HTMLElement;
  settings: DragImageSettings;
}

function buildTab(): TabFixture {
  const settings: DragImageSettings = { ...DEFAULT_SETTINGS, language: 'en' };
  const plugin = {
    settings,
    saveSettings: () => Promise.resolve(),
    resetAllSingleImages: () => {},
    resetAllImageAlignments: () => {},
  } as unknown as IDragImagePlugin;
  const tab = new DragImageSettingTab({} as App, plugin);
  return { tab, containerEl: tab.containerEl, settings };
}

/**
 * Draw the tab the way an older Obsidian does.
 *
 * Named through a shape rather than through the tab's own method: the framework
 * entry point this stands for is deprecated from 1.13 on, and the tests below
 * are about the tab surviving its removal, so reaching it by name would make
 * this file the one thing in the repo still calling it.
 */
function frameworkDraw(tab: DragImageSettingTab): void {
  (tab as unknown as { display(): void }).display();
}

/** Press one half of the language bar. Its label is written in the language it
 *  selects, so the label is the whole lookup key. */
function clickLanguage(containerEl: HTMLElement, label: string): void {
  const segment = Array.from(containerEl.querySelectorAll<HTMLButtonElement>('.diaa-segment')).find(
    (el) => el.textContent === label
  );
  if (!segment) throw new Error(`no language segment labelled ${label}`);
  segment.click();
}

describe('the settings tab, drawn below 1.13', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    h.api13 = false;
    h.updates = 0;
    setLanguage('en');
    // The level slider row measures its own geometry once it is laid out; jsdom
    // lays nothing out, so it asks for a frame it will never get. Answering it
    // with a no-op keeps the page build synchronous and single-pass.
    window.requestAnimationFrame = () => 0;
  });

  afterEach(() => {
    setLanguage('en');
  });

  it('draws the page from display()', () => {
    const { tab, containerEl } = buildTab();

    frameworkDraw(tab);

    expect(containerEl.classList.contains('diaa-settings')).toBe(true);
    expect(containerEl.querySelectorAll('.setting-item').length).toBeGreaterThan(0);
    expect(containerEl.textContent).toContain(EN_HEADING);
    expect(containerEl.textContent).toContain(EN_ROW);
    // Both halves of the language bar are drawn, so the switch is on the page.
    expect(containerEl.querySelectorAll('.diaa-segment')).toHaveLength(2);
  });

  it('redraws in the new language through the page itself, not display()', () => {
    const { tab, containerEl, settings } = buildTab();
    frameworkDraw(tab);

    clickLanguage(containerEl, '中文');

    expect(settings.language).toBe('zh');
    expect(containerEl.textContent).toContain(ZH_ROW);
    expect(containerEl.textContent).toContain(ZH_HEADING);
    // Not a stale page with a new label swapped in: the whole page is rebuilt.
    expect(containerEl.textContent).not.toContain(EN_ROW);
    expect(containerEl.textContent).not.toContain(EN_HEADING);
        // 1.13 is what asks the framework; below it the tab redraws itself.
    expect(h.updates).toBe(0);
  });

  it('leaves the redraw to the framework on 1.13, without touching the page', () => {
    h.api13 = true;
    const { tab, containerEl, settings } = buildTab();
    frameworkDraw(tab);
    const before = containerEl.innerHTML;

    clickLanguage(containerEl, '中文');

    expect(settings.language).toBe('zh');
    expect(h.updates).toBe(1);
    // The framework re-reads the definitions and patches the rows; a tab that
    // also rebuilt the page itself would be doing the work twice.
    expect(containerEl.innerHTML).toBe(before);
  });
});
