/**
 * Settings tab section for the vault-wide maintenance actions: two buttons, each
 * with a two-phase progress bar (scan → apply) and a confirmation dialog that
 * states the exact scope before anything is written.
 *
 * Both actions have the same shape — walk the vault for the lines their policy
 * owns, confirm, write — so they share one runner and differ only in copy and in
 * the plan they hand it (see ./clearDiaaFormat and ./normalizeDiaaFormat).
 *
 * One row table, two render paths, plus state that outlives the DOM.  A pass runs
 * for seconds and paints its own progress, so what a row shows cannot live in the
 * row: it lives in the section, keyed by action, and every render repaints from
 * it.  A rebuild of the tab — which the framework's diff does freely, throwing
 * the rows away — therefore restores the bar where it stood instead of snapping
 * back to 尚未执行.  Obsidian 1.13 renders the tab from definitions, so the
 * section supplies `definitions()`; older versions draw it imperatively, so it
 * supplies `mount()` as well.
 *
 * User-facing copy names the plugin's own acronym in caps ("DIAA 格式"); the
 * sentence-case lint rule is configured to keep it — see eslint.config.mjs.
 */

import {
  App,
  Modal,
  Notice,
  Setting,
  type ButtonComponent,
  type SettingDefinitionItem,
} from 'obsidian';
import type { Alignment } from '../constants';
import { clearPlan } from './clearDiaaFormat';
import { makeNormalizePlan } from './normalizeDiaaFormat';
import { applySettingButtonStyle } from '../settingsButton';
import {
  applyPass,
  scanVault,
  type LinePlan,
  type VaultPassProgress,
  type VaultPassScan,
  type VaultPassSummary,
} from './vaultPass';

/** Live settings an action reads, so a change in the tab takes effect on the
 *  next run without rebuilding the page. */
export interface MaintenanceBridge {
  extensions: string;
  alignment: Alignment;
  maxImagesPerRow: number;
}

/** The section heading. The declarative path hands it to the framework; the
 *  imperative path creates the heading element itself. */
const HEADING = 'DIAA 格式维护';

/** The maintenance section as the settings tab sees it: definitions for the
 *  1.13 path, a mount point for the path below it. */
export interface MaintenanceSection {
  definitions(): SettingDefinitionItem[];
  mount(containerEl: HTMLElement): void;
}

/** One vault-wide action: what it is called, what it says, which lines it owns. */
interface MaintenanceAction {
  name: string;
  desc: string;
  buttonText: string;
  confirmTitle: string;
  confirmButton: string;
  /** Progress label for the write half; the scan half always reads 正在扫描. */
  applyLabel: string;
  /** The plan the run scans and writes with — built once per run, so both phases
   *  see the same policy even if the settings move underneath. */
  plan(bridge: MaintenanceBridge): LinePlan;
  /** The body of the confirmation dialog, above the buttons. */
  writeConfirmBody(contentEl: HTMLElement, scan: VaultPassScan): void;
  emptyText(scan: VaultPassScan): string;
  cancelledText(scan: VaultPassScan): string;
  doneText(summary: VaultPassSummary): string;
  failureNotice: string;
}

/** Everything a row shows that a rebuild would otherwise wipe. Held by the
 *  section, one per action, for as long as the tab lives. */
interface ActionState {
  label: string;
  /** Completed share of the bar, 0–1. */
  fraction: number;
  /** Accent fill once the whole pass is done. */
  blue: boolean;
  busy: boolean;
  /** Held down because another action's pass is in flight. */
  locked: boolean;
}

/** The elements of one rendered row the section paints into. Replaced on every
 *  render, so it always points at the row that is currently on screen. */
interface ActionView {
  button: ButtonComponent;
  barEl: HTMLElement;
  labelEl: HTMLElement;
}

/** The resting copy of every action: nothing has run yet. */
function restingState(): ActionState {
  return { label: '尚未执行。', fraction: 0, blue: false, busy: false, locked: false };
}

/** Create the section. One instance per settings tab, so an in-flight pass and
 *  its progress survive every rebuild of the page. */
export function createMaintenanceSection(
  app: App,
  bridge: () => MaintenanceBridge
): MaintenanceSection {
  return new MaintenanceSectionImpl(app, bridge);
}

/** 「DIAA 格式维护」: the actions, one runner, one busy flag. */
class MaintenanceSectionImpl implements MaintenanceSection {
  private readonly states = new Map<MaintenanceAction, ActionState>();
  private readonly views = new Map<MaintenanceAction, ActionView>();
  private running = false;

  constructor(private readonly app: App, private readonly bridge: () => MaintenanceBridge) {}

  /**
   * The rows as definitions for Obsidian 1.13+, which renders the group heading
   * and the card around them. Read fresh on every render — the rows the framework
   * builds then repaint themselves from the held state.
   */
  definitions(): SettingDefinitionItem[] {
    return [
      {
        type: 'group',
        heading: HEADING,
        items: ACTIONS.map((action) => ({
          name: action.name,
          desc: action.desc,
          render: (setting: Setting) => this.renderRow(setting, action),
        })),
      },
    ];
  }

  /** Draw the group by hand, heading and div included — the path below 1.13. */
  mount(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(HEADING).setHeading();
    const group = containerEl.createDiv();
    group.addClass('diaa-settings-group');

    ACTIONS.forEach((action, index) => {
      // Rows in a card are divided by the framework's own rule; a bare group div
      // has none, so the legacy path draws the divider it needs.
      if (index > 0) {
        const sep = group.createDiv();
        sep.addClass('diaa-vault-sep');
      }
      this.renderRow(new Setting(group).setName(action.name).setDesc(action.desc), action);
    });
  }

  /** Fill one row — the button and the progress bar — and register it as the
   *  action's current picture of its state. */
  private renderRow(setting: Setting, action: MaintenanceAction): void {
    // The framework re-renders a matched row into the same element, and clears
    // only the control column before doing so — the bar from the previous pass
    // is still standing and has to go, or every rebuild leaves another behind.
    setting.settingEl.querySelector(".diaa-vault-progress")?.remove();

    let button: ButtonComponent | null = null;
    setting.addButton((component) => {
      button = component;
      applySettingButtonStyle(component)
        .setButtonText(action.buttonText)
        .onClick(() => void this.run(action));
    });

    // The bar sits inside the row, so it travels with the row through the
    // framework's diff rather than drifting out of it.
    const progress = setting.settingEl.createDiv();
    progress.addClass('diaa-vault-progress');
    const track = progress.createDiv();
    track.addClass('diaa-vault-track');
    const barEl = track.createDiv();
    barEl.addClass('diaa-vault-bar');
    const labelEl = progress.createDiv();
    labelEl.addClass('diaa-vault-label');

    if (button) this.views.set(action, { button, barEl, labelEl });
    this.paint(action);
  }

  private state(action: MaintenanceAction): ActionState {
    let state = this.states.get(action);
    if (!state) {
      state = restingState();
      this.states.set(action, state);
    }
    return state;
  }

  /** Merge a change into the held state and show it, if the row is on screen. */
  private update(action: MaintenanceAction, patch: Partial<ActionState>): void {
    Object.assign(this.state(action), patch);
    this.paint(action);
  }

  private paint(action: MaintenanceAction): void {
    const view = this.views.get(action);
    if (!view) return;
    const state = this.state(action);
    view.button.setDisabled(state.busy || state.locked);
    view.button.setButtonText(state.busy ? '处理中…' : action.buttonText);
    view.labelEl.setText(state.label);
    const pct = Math.max(0, Math.min(1, state.fraction)) * 100;
    view.barEl.style.width = `${pct.toFixed(1)}%`;
    view.barEl.toggleClass('is-done', state.blue);
  }

  private onProgress(action: MaintenanceAction, p: VaultPassProgress): void {
    const verb = p.phase === 'scan' ? '正在扫描' : action.applyLabel;
    this.update(action, {
      fraction: p.total === 0 ? 1 : p.processed / p.total,
      blue: false,
      label: `${verb} ${p.processed} / ${p.total} 个文件…`,
    });
  }

  /** Hold every other action's button down while one pass runs. */
  private lockOthers(exclude: MaintenanceAction, locked: boolean): void {
    for (const action of ACTIONS) {
      if (action !== exclude) this.update(action, { locked });
    }
  }

  /** Scan → confirm → write. Every exit path leaves copy explaining what
   *  happened; a second click while one pass is in flight is ignored. */
  private async run(action: MaintenanceAction): Promise<void> {
    if (this.running) return;
    this.running = true;
    const bridge = this.bridge();
    this.update(action, { busy: true, fraction: 0, blue: false, label: '正在扫描…' });
    this.lockOthers(action, true);

    try {
      const plan = action.plan(bridge);
      const scan = await scanVault(this.app, bridge.extensions, plan, (p) =>
        this.onProgress(action, p)
      );

      if (scan.entries.length === 0) {
        this.update(action, { fraction: 1, blue: true, label: action.emptyText(scan) });
        return;
      }

      const confirmed = await new MaintenanceConfirmModal(this.app, action, scan).ask();
      if (!confirmed) {
        this.update(action, {
          fraction: 0,
          blue: false,
          label: action.cancelledText(scan),
        });
        return;
      }

      const summary = await applyPass(this.app, scan, bridge.extensions, plan, (p) =>
        this.onProgress(action, p)
      );
      const text = action.doneText(summary);
      this.update(action, { fraction: 1, blue: true, label: text });
      new Notice(text);
    } catch (error) {
      this.update(action, {
        fraction: 0,
        blue: false,
        label: `操作失败：${String(error)}`,
      });
      new Notice(action.failureNotice);
    } finally {
      this.update(action, { busy: false });
      this.lockOthers(action, false);
      this.running = false;
    }
  }
}

/**
 * Pre-flight confirmation.  Resolves `true` only when the user presses the
 * confirm button; closing the dialog any other way resolves `false`.
 */
class MaintenanceConfirmModal extends Modal {
  private settle: ((value: boolean) => void) | null = null;

  constructor(
    app: App,
    private readonly action: MaintenanceAction,
    private readonly scan: VaultPassScan
  ) {
    super(app);
  }

  ask(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.settle = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('diaa-vault-confirm');
    new Setting(contentEl).setName(this.action.confirmTitle).setHeading();
    this.action.writeConfirmBody(contentEl, this.scan);

    // Plain CTA rather than `setDestructive()`: that method only exists from
    // Obsidian 1.13 and this plugin declares minAppVersion 1.5.0.
    new Setting(contentEl)
      .addButton((button) => button.setButtonText('取消').onClick(() => this.decide(false)))
      .addButton((button) =>
        button
          .setButtonText(this.action.confirmButton)
          .setCta()
          .onClick(() => this.decide(true))
      );
  }

  /** Escape, the backdrop and the cancel button all land here: answer `false`
   *  unless a button already answered. */
  onClose(): void {
    this.contentEl.empty();
    this.settle?.(false);
    this.settle = null;
  }

  private decide(value: boolean): void {
    this.settle?.(value);
    this.settle = null;
    this.close();
  }
}

function paragraph(containerEl: HTMLElement, text: string): void {
  containerEl.createEl('p', { text });
}

/** A before/after sample pair, rendered as one code block. */
function sampleBlock(containerEl: HTMLElement, before: string, after: string): void {
  const pre = containerEl.createEl('pre');
  pre.createEl('code', { text: before });
  pre.createEl('code', { text: after });
}

// ── Action: clear every DIAA row back to a bare embed ────────────────────

const CLEAR_ACTION: MaintenanceAction = {
  name: '清除 DIAA 格式（本库）',
  desc:
    '把全库中 DIAA 写入的图片参数还原为 Obsidian 原生的 ![[文件名]]：整行图片行清掉整个' +
    '参数段，行内引用只清 DIAA 写的对齐词、Obsidian 原生的宽度保留。逐个文件处理，' +
    '点击后先扫描、再确认、然后写入。清除会丢弃朝向、对齐、份额、填充与单图宽度，' +
    '且不可自动恢复（原始图片文件不受影响）。' +
    '注意：插件启用期间，笔记只要被打开或编辑，参数就会在第一帧被重新写回；' +
    '若目的是卸载插件，建议清除前先关闭所有打开的笔记，并在清除完成后立即停用插件。',
  buttonText: '开始清除',
  confirmTitle: '清除 DIAA 格式（本库）',
  confirmButton: '确认清除',
  applyLabel: '正在清除',
  plan: () => clearPlan,
  emptyText: (scan) =>
    `扫描完成：${scan.scanned} 个 Markdown 文件中没有 DIAA 格式行，无需清除。`,
  cancelledText: (scan) =>
    `已取消，未做任何修改。共检测到 ${scan.foundLines} 行 DIAA 格式，` +
    `分布在 ${scan.entries.length} 个文件中。`,
  doneText: (summary) =>
    `清除完成：共扫描 ${summary.scanned} 个文件，` +
    `还原 ${summary.changedLines} 行，覆盖 ${summary.changedFiles} 个文件` +
    (summary.failed > 0 ? `，${summary.failed} 个文件失败（见 log.txt）。` : '。') +
    '若目的是卸载插件，请立即停用插件，并关闭所有打开的笔记。',
  failureNotice: '清除 DIAA 格式失败',
  writeConfirmBody: (contentEl, scan) => {
    paragraph(
      contentEl,
      `本次已扫描 ${scan.scanned} 个 Markdown 文件，命中 ${scan.foundLines} 行 ` +
        `DIAA 写入的图片行参数，分布在 ${scan.entries.length} 个文件中。`
    );
    paragraph(contentEl, '这些行会被改写为 Obsidian 原生格式，例如：');
    sampleBlock(contentEl, '![[示例图片.webp|orig|center|100|67]]', '![[示例图片.webp]]');
    paragraph(contentEl, '整库改写不可撤销，建议先提交一次。');
  },
};

// ── Action: normalise every hostable line into the standard slot form ───

const NORMALIZE_ACTION: MaintenanceAction = {
  name: '归一化为标准格式（本库）',
  desc:
    '把全库中 DIAA 可托管的图片行补写成标准参数格式：朝向槽写入原朝向（直立时写 orig），' +
    '对齐槽写入当前统一对齐设置，行内已有的数值参数原样保留。缺失的数值槽不在这里猜——' +
    '份额要按各成员的自然像素尺寸才算得准、填充比要等图像画出来才量得到，' +
    '所以交给该行首次渲染时按真实值补写，免得把一个凑出来的数钉死在笔记里。' +
    '单图行手写的原生宽度（|400、|400x300）会转写为手动宽度 |1|400 保留下来。' +
    '含别名等无法识别参数的行一律不动。',
  buttonText: '开始归一化',
  confirmTitle: '归一化为标准格式（本库）',
  confirmButton: '确认归一化',
  applyLabel: '正在归一化',
  plan: (bridge) =>
    makeNormalizePlan({
      alignment: bridge.alignment,
      maxImagesPerRow: bridge.maxImagesPerRow,
    }),
  emptyText: (scan) =>
    `扫描完成：${scan.scanned} 个 Markdown 文件中没有需要归一化的图片行。`,
  cancelledText: (scan) =>
    `已取消，未做任何修改。共检测到 ${scan.foundLines} 行可归一化，` +
    `分布在 ${scan.entries.length} 个文件中。`,
  doneText: (summary) =>
    `归一化完成：共扫描 ${summary.scanned} 个文件，` +
    `改写 ${summary.changedLines} 行，覆盖 ${summary.changedFiles} 个文件` +
    (summary.failed > 0 ? `，${summary.failed} 个文件失败（见 log.txt）。` : '。') +
    '数值槽会在笔记下次打开时由首帧补齐，补齐后才是完整的标准格式。',
  failureNotice: '归一化失败',
  writeConfirmBody: (contentEl, scan) => {
    paragraph(
      contentEl,
      `本次将扫描 ${scan.scanned} 个 Markdown 文件，命中 ${scan.foundLines} 行 ` +
        `可归一化的图片行。`
    );
    paragraph(contentEl, '每一行会补上朝向槽与对齐槽；自身没有对齐词的行取当前统一对齐设置：');
    sampleBlock(contentEl, '![[示例图片.webp|center]]', '![[示例图片.webp|orig|left]]');
    paragraph(contentEl, '单图行手写的原生宽度会转写为手动宽度，免得被首次渲染覆盖掉：');
    sampleBlock(contentEl, '![[示例图片.webp|400]]', '![[示例图片.webp|orig|left|1|400]]');
    paragraph(contentEl, '整库改写不可撤销，建议先提交一次。');
  },
};

/** The actions in the order the section draws them. Declared after the two
 *  definitions above, which it reads. */
const ACTIONS: MaintenanceAction[] = [CLEAR_ACTION, NORMALIZE_ACTION];
