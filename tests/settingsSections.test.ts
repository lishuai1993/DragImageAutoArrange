/**
 * @vitest-environment jsdom
 *
 * Tests for the two settings sections that sibling modules own — the image
 * right-click menu and the vault maintenance passes — driven through both the
 * declarative contract Obsidian 1.13 reads (`definitions()`) and the imperative
 * `mount()` the older path calls.
 *
 * `Setting` is stubbed locally because the assertions are about DOM shape: where
 * a row's progress bar sits, what a rebuild leaves behind, and whether a pass's
 * state outlives the elements showing it. The shared mock's Setting has no
 * elements and never invokes a callback, so it cannot carry any of that. The
 * stub mirrors Obsidian's own construction — `settingEl → infoEl (nameEl,
 * descEl) + controlEl` — and its two sharp edges: `clear()` empties only the
 * control column, and the framework re-renders a matched row into the same
 * element rather than building a new one.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  Setting,
  type SettingDefinitionGroup,
  type SettingDefinitionItem,
  type SettingGroup,
} from 'obsidian';
import type { App } from 'obsidian';
import {
  imageMenuSectionDefinitions,
  renderImageMenuSettings,
  type ImageMenuBridge,
} from '../src/imageMenu/menuSettingsUi';
import {
  createMaintenanceSection,
  type MaintenanceBridge,
} from '../src/maintenance/maintenanceSettingsUi';
import {
  DEFAULT_IMAGE_MENU_SETTINGS,
  FILE_OPERATION_IDS,
  type ImageMenuSettings,
} from '../src/imageMenu/settingsModel';
import { FILE_OPERATION_LABELS } from '../src/imageMenu/menuLabels';
import type {
  LinePlan,
  VaultPassProgress,
  VaultPassScan,
  VaultPassSummary,
} from '../src/maintenance/vaultPass';

type ScanFn = (
  app: App,
  extensions: string,
  plan: LinePlan,
  onProgress: (progress: VaultPassProgress) => void
) => Promise<VaultPassScan>;

type ApplyFn = (
  app: App,
  scan: VaultPassScan,
  extensions: string,
  plan: LinePlan,
  onProgress: (progress: VaultPassProgress) => void
) => Promise<VaultPassSummary>;

const scanVaultMock = vi.hoisted(() => vi.fn<ScanFn>());
const applyPassMock = vi.hoisted(() => vi.fn<ApplyFn>());

vi.mock('../src/maintenance/vaultPass', () => ({
  scanVault: scanVaultMock,
  applyPass: applyPassMock,
}));

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

  class StubToggle {
    readonly inputEl = document.createEl('input');

    constructor() {
      this.inputEl.type = 'checkbox';
    }

    setValue(value: boolean): this {
      this.inputEl.checked = value;
      return this;
    }

    setDisabled(_disabled: boolean): this {
      return this;
    }

    onChange(callback: (value: boolean) => void): this {
      this.inputEl.addEventListener('change', () => callback(this.inputEl.checked));
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
      this.controlEl.appendChild(toggle.inputEl);
      callback(toggle);
      return this;
    }

    /** Mirrors Obsidian's: the control column is all that gets emptied. */
    clear(): this {
      this.controlEl.empty();
      return this;
    }
  }

  class StubModal {
    constructor(_app: unknown) {}
    open(): void {}
    close(): void {}
  }

  class StubNotice {
    constructor(_message: string) {}
  }

  return { Setting: StubSetting, Modal: StubModal, Notice: StubNotice };
});

/** The section's own row: the copy the framework shows, plus the body it fills. */
type RowRender = (setting: Setting) => void;

interface DefinitionRow {
  name: string;
  render: RowRender;
}

function must<T extends Element>(scope: ParentNode, selector: string): T {
  const el = scope.querySelector<T>(selector);
  if (!el) throw new Error(`no element matching ${selector}`);
  return el;
}

/** The single group a section contributes — the sections under test each add one. */
function groupOf(items: SettingDefinitionItem[]): SettingDefinitionGroup {
  const groups = items.filter(
    (item): item is SettingDefinitionGroup => 'type' in item && item.type === 'group'
  );
  if (groups.length !== 1) throw new Error(`expected one group, got ${groups.length}`);
  return groups[0];
}

/** The rows of a group, in definition order, as callable body functions. */
function rowsOf(group: SettingDefinitionGroup): DefinitionRow[] {
  const rows: DefinitionRow[] = [];
  for (const item of group.items ?? []) {
    if (!('render' in item) || typeof item.render !== 'function') continue;
    rows.push({
      name: item.name ?? '',
      render: (setting) => {
        item.render(setting, undefined as unknown as SettingGroup);
      },
    });
  }
  return rows;
}

function rowNamed(rows: DefinitionRow[], name: string): DefinitionRow {
  const row = rows.find((candidate) => candidate.name === name);
  if (!row) throw new Error(`no row named ${name}`);
  return row;
}

/** Build one row the way the framework does: a Setting, then its body. */
function renderRow(row: DefinitionRow, containerEl: HTMLElement): Setting {
  const setting = new Setting(containerEl);
  row.render(setting);
  return setting;
}

function rowButton(setting: Setting): HTMLButtonElement {
  return must<HTMLButtonElement>(setting.settingEl, 'button');
}

function rowLabel(setting: Setting): string {
  return must(setting.settingEl, '.diaa-vault-label').textContent ?? '';
}

/** The bar's fill as a percentage. Read as a number because jsdom normalises
 *  the serialised length ("100.0%" comes back as "100%"). */
function barPercent(setting: Setting): number {
  const width = must<HTMLElement>(setting.settingEl, '.diaa-vault-bar').style.width;
  expect(width.endsWith('%')).toBe(true);
  return parseFloat(width);
}

/** A fresh copy of the defaults — the sections mutate the settings they read. */
function menuSettings(): ImageMenuSettings {
  return {
    ...DEFAULT_IMAGE_MENU_SETTINGS,
    fileOperationItems: DEFAULT_IMAGE_MENU_SETTINGS.fileOperationItems.map((item) => ({ ...item })),
  };
}

function menuBridge(
  settings: ImageMenuSettings,
  saveSettings: () => Promise<void>
): ImageMenuBridge {
  return { getSettings: () => settings, saveSettings };
}

const operationNames = FILE_OPERATION_IDS.map((id) => FILE_OPERATION_LABELS[id]);

const MAINTENANCE_BRIDGE: MaintenanceBridge = {
  extensions: 'png',
  alignment: 'left',
  maxImagesPerRow: 4,
};

const APP = {} as unknown as App;

function maintenanceSection(): ReturnType<typeof createMaintenanceSection> {
  return createMaintenanceSection(APP, () => MAINTENANCE_BRIDGE);
}

describe('image menu section definitions', () => {
  it('contributes one group, its heading and one render row per operation', () => {
    const group = groupOf(
      imageMenuSectionDefinitions(menuBridge(menuSettings(), vi.fn()), vi.fn())
    );

    expect(group.heading).toBe('图片右键菜单设置');
    expect((group.items ?? []).map((item) => item.name)).toEqual([
      '显示文件信息',
      '删除前确认',
      '文件操作',
      ...operationNames,
    ]);
    // Every row needs imperative code (a button, a pair of arrows), so none may
    // be handed over as a pure `control` definition the framework renders alone.
    expect(rowsOf(group)).toHaveLength(3 + operationNames.length);
  });

  it('keeps the stored operation order', () => {
    const settings = menuSettings();
    const items = settings.fileOperationItems;
    const last = items.pop();
    if (last) items.unshift(last);

    const group = groupOf(imageMenuSectionDefinitions(menuBridge(settings, vi.fn()), vi.fn()));

    expect((group.items ?? []).map((item) => item.name)).toEqual([
      '显示文件信息',
      '删除前确认',
      '文件操作',
      ...items.map((item) => FILE_OPERATION_LABELS[item.id]),
    ]);
  });

  it('writes a toggle straight into the model and saves', async () => {
    const settings = menuSettings();
    const saveSettings = vi.fn(async () => {});
    const rows = rowsOf(
      groupOf(imageMenuSectionDefinitions(menuBridge(settings, saveSettings), vi.fn()))
    );
    const setting = renderRow(rowNamed(rows, '显示文件信息'), document.createDiv());

    const input = must<HTMLInputElement>(setting.controlEl, 'input[type="checkbox"]');
    expect(input.checked).toBe(settings.showImageInfo);

    input.checked = false;
    input.dispatchEvent(new Event('change'));

    await vi.waitFor(() => expect(settings.showImageInfo).toBe(false));
    expect(saveSettings).toHaveBeenCalled();
  });

  it('disables the first operation up arrow, where there is nowhere to go', () => {
    const rows = rowsOf(
      groupOf(imageMenuSectionDefinitions(menuBridge(menuSettings(), vi.fn()), vi.fn()))
    );
    const setting = renderRow(rowNamed(rows, operationNames[0]), document.createDiv());

    const arrows = Array.from(setting.controlEl.querySelectorAll('button'));
    expect(arrows.map((button) => button.disabled)).toEqual([true, false]);
  });

  it('moves an operation, saves, and asks the tab to redraw', async () => {
    const settings = menuSettings();
    const saveSettings = vi.fn(async () => {});
    const refresh = vi.fn();
    const rows = rowsOf(
      groupOf(imageMenuSectionDefinitions(menuBridge(settings, saveSettings), refresh))
    );
    const order = settings.fileOperationItems.map((item) => item.id);
    const setting = renderRow(
      rowNamed(rows, FILE_OPERATION_LABELS[order[1]]),
      document.createDiv()
    );

    must<HTMLButtonElement>(setting.controlEl, 'button').click();

    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(settings.fileOperationItems.map((item) => item.id)).toEqual([
      order[1],
      order[0],
      ...order.slice(2),
    ]);
    expect(saveSettings).toHaveBeenCalled();
  });

  it('restores the canonical order from the reset row', async () => {
    const settings = menuSettings();
    const items = settings.fileOperationItems;
    const last = items.pop();
    if (last) items.unshift(last);
    const saveSettings = vi.fn(async () => {});
    const refresh = vi.fn();

    const rows = rowsOf(
      groupOf(imageMenuSectionDefinitions(menuBridge(settings, saveSettings), refresh))
    );
    const setting = renderRow(rowNamed(rows, '文件操作'), document.createDiv());

    must<HTMLButtonElement>(setting.controlEl, 'button').click();

    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(settings.fileOperationItems.map((item) => item.id)).toEqual([...FILE_OPERATION_IDS]);
  });
});

describe('image menu section, imperative path', () => {
  it('draws the heading itself and mounts the same rows into its own group', () => {
    const containerEl = document.createDiv();
    renderImageMenuSettings(containerEl, menuBridge(menuSettings(), vi.fn()));

    expect(must(containerEl, '.setting-item-heading .setting-item-name').textContent).toBe(
      '图片右键菜单设置'
    );
    const group = must(containerEl, '.diaa-settings-group');
    expect(group.querySelectorAll('.setting-item')).toHaveLength(3 + operationNames.length);
  });

  it('rebuilds its group in the new order after a reorder', async () => {
    const settings = menuSettings();
    const containerEl = document.createDiv();
    renderImageMenuSettings(containerEl, menuBridge(settings, vi.fn(async () => {})));
    const group = must(containerEl, '.diaa-settings-group');

    const order = settings.fileOperationItems.map((item) => item.id);
    const second = FILE_OPERATION_LABELS[order[1]];
    const rows = () =>
      Array.from(group.querySelectorAll('.setting-item-name')).map((el) => el.textContent);
    expect(rows().indexOf(second)).toBe(4);

    const target = Array.from(group.querySelectorAll<HTMLElement>('.setting-item')).find(
      (row) => row.querySelector('.setting-item-name')?.textContent === second
    );
    if (!target) throw new Error(`no row named ${second}`);
    must<HTMLButtonElement>(target, 'button').click();

    await vi.waitFor(() => expect(rows().indexOf(second)).toBe(3));
  });
});

describe('maintenance section', () => {
  it('contributes one group with both actions as render rows', () => {
    const group = groupOf(maintenanceSection().definitions());

    expect(group.heading).toBe('DIAA 格式维护');
    expect(rowsOf(group).map((row) => row.name)).toEqual([
      '清除 DIAA 格式（本库）',
      '归一化为标准格式（本库）',
    ]);
  });

  it('puts the progress bar inside the row, resting until a pass runs', () => {
    const rows = rowsOf(groupOf(maintenanceSection().definitions()));
    const setting = renderRow(rowNamed(rows, '清除 DIAA 格式（本库）'), document.createDiv());

    expect(setting.settingEl.querySelectorAll('.diaa-vault-progress')).toHaveLength(1);
    expect(rowLabel(setting)).toBe('尚未执行。');
    expect(barPercent(setting)).toBe(0);
    expect(rowButton(setting).textContent).toBe('开始清除');
  });

  it('keeps the finished pass on screen when the framework rebuilds the row', async () => {
    const rows = rowsOf(groupOf(maintenanceSection().definitions()));
    const row = rowNamed(rows, '清除 DIAA 格式（本库）');
    const setting = renderRow(row, document.createDiv());

    scanVaultMock.mockImplementation(async (_app, _extensions, _plan, onProgress) => {
      onProgress({ phase: 'scan', processed: 1, total: 2 });
      // The row paints as the pass reports, not only once it has finished.
      expect(rowLabel(setting)).toBe('正在扫描 1 / 2 个文件…');
      expect(barPercent(setting)).toBe(50);
      onProgress({ phase: 'scan', processed: 2, total: 2 });
      return { entries: [], scanned: 2, foundLines: 0, failed: 0 };
    });

    rowButton(setting).click();
    await vi.waitFor(() => expect(rowLabel(setting)).toContain('没有 DIAA 格式行'));
    expect(rowButton(setting).disabled).toBe(false);

    // The framework's rebuild of a matched row: clear, then render again into the
    // same element. The bar must not be left behind twice, and the state it shows
    // has to come back — a rebuild is not a reset.
    setting.clear();
    row.render(setting);

    expect(setting.settingEl.querySelectorAll('.diaa-vault-progress')).toHaveLength(1);
    expect(rowLabel(setting)).toContain('没有 DIAA 格式行');
    expect(barPercent(setting)).toBe(100);
    expect(must(setting.settingEl, '.diaa-vault-bar').classList).toContain('is-done');
    // A rebuild also has to hand the button back, not leave it mid-pass.
    expect(rowButton(setting).textContent).toBe('开始清除');
    expect(rowButton(setting).disabled).toBe(false);
  });

  it('draws its heading, group and row divider on the imperative path', () => {
    const containerEl = document.createDiv();
    maintenanceSection().mount(containerEl);

    expect(must(containerEl, '.setting-item-heading .setting-item-name').textContent).toBe(
      'DIAA 格式维护'
    );
    const group = must(containerEl, '.diaa-settings-group');
    expect(group.querySelectorAll(':scope > .diaa-vault-sep')).toHaveLength(1);
    expect(group.querySelectorAll('.diaa-vault-progress')).toHaveLength(2);
  });
});

