/**
 * Settings tab section for the vault-wide maintenance actions: two buttons, each
 * with a two-phase progress bar (scan → apply) and a confirmation dialog that
 * states the exact scope before anything is written.
 *
 * Both actions have the same shape — walk the vault for the lines their policy
 * owns, confirm, write — so they share one runner and differ only in copy and in
 * the plan they hand it (see ./clearDiaaFormat and ./normalizeDiaaFormat).
 *
 * User-facing copy names the plugin's own acronym in caps ("DIA 格式"); the
 * sentence-case lint rule is configured to keep it — see eslint.config.mjs.
 */

import { App, Modal, Notice, Setting, type ButtonComponent } from 'obsidian';
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

/** Mount the maintenance section at the end of `containerEl`. */
export function renderMaintenanceSettings(
  containerEl: HTMLElement,
  app: App,
  bridge: () => MaintenanceBridge
): void {
  new MaintenanceSection(containerEl, app, bridge).render();
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

/** 「DIA 格式维护」: the actions, one runner, one busy flag. */
class MaintenanceSection {
  private readonly group: HTMLElement;
  private readonly views: MaintenanceActionView[] = [];
  private running = false;

  constructor(
    containerEl: HTMLElement,
    private readonly app: App,
    private readonly bridge: () => MaintenanceBridge
  ) {
    new Setting(containerEl).setName('DIA 格式维护').setHeading();
    this.group = containerEl.createDiv();
    this.group.addClass('drag-img-settings-group');
  }

  render(): void {
    this.mount(CLEAR_ACTION);
    const sep = this.group.createDiv();
    sep.setCssStyles({ borderBottom: '1px solid var(--background-modifier-border)' });
    sep.setCssStyles({ margin: '12px 0' });
    this.mount(NORMALIZE_ACTION);
  }

  private mount(action: MaintenanceAction): void {
    const view = new MaintenanceActionView(this.group, action);
    this.views.push(view);
    view.render(() => void this.run(action, view));
  }

  private lockOthers(exclude: MaintenanceActionView, locked: boolean): void {
    for (const view of this.views) if (view !== exclude) view.setLocked(locked);
  }

  /** Scan → confirm → write. Every exit path leaves copy explaining what
   *  happened; a second click while one pass is in flight is ignored. */
  private async run(action: MaintenanceAction, view: MaintenanceActionView): Promise<void> {
    if (this.running) return;
    this.running = true;
    const bridge = this.bridge();
    view.setBusy(true);
    this.lockOthers(view, true);
    view.setBar(0, false);
    view.setLabel('正在扫描…');

    try {
      const plan = action.plan(bridge);
      const scan = await scanVault(this.app, bridge.extensions, plan, (p) =>
        view.onProgress(p, action.applyLabel)
      );

      if (scan.entries.length === 0) {
        view.setBar(1, true);
        view.setLabel(action.emptyText(scan));
        return;
      }

      const confirmed = await new MaintenanceConfirmModal(this.app, action, scan).ask();
      if (!confirmed) {
        view.setBar(0, false);
        view.setLabel(action.cancelledText(scan));
        return;
      }

      const summary = await applyPass(this.app, scan, bridge.extensions, plan, (p) =>
        view.onProgress(p, action.applyLabel)
      );
      view.setBar(1, true);
      const text = action.doneText(summary);
      view.setLabel(text);
      new Notice(text);
    } catch (error) {
      view.setBar(0, false);
      view.setLabel(`操作失败：${String(error)}`);
      new Notice(action.failureNotice);
    } finally {
      view.setBusy(false);
      this.lockOthers(view, false);
      this.running = false;
    }
  }
}

/** The button + progress bar for one action. Purely a widget: the section drives it. */
class MaintenanceActionView {
  private button: ButtonComponent | null = null;
  private readonly restingText: string;
  private readonly barEl: HTMLElement;
  private readonly labelEl: HTMLElement;

  constructor(group: HTMLElement, action: MaintenanceAction) {
    this.restingText = action.buttonText;
    new Setting(group)
      .setName(action.name)
      .setDesc(action.desc)
      .addButton((button) => {
        this.button = button;
        applySettingButtonStyle(button).setButtonText(action.buttonText);
      });

    const progress = group.createDiv();
    progress.addClass('drag-img-vault-progress');
    const track = progress.createDiv();
    track.addClass('drag-img-vault-track');
    this.barEl = track.createDiv();
    this.barEl.addClass('drag-img-vault-bar');
    this.labelEl = progress.createDiv();
    this.labelEl.addClass('drag-img-vault-label');
    this.setLabel('尚未执行。');
  }

  render(onClick: () => void): void {
    this.button?.onClick(onClick);
  }

  setBusy(busy: boolean): void {
    this.button?.setDisabled(busy);
    this.button?.setButtonText(busy ? '处理中…' : this.restingText);
  }

  /** Disable without touching the label — used to hold the other action's
   *  button quiet while a pass is in flight. */
  setLocked(locked: boolean): void {
    this.button?.setDisabled(locked);
  }

  setLabel(text: string): void {
    this.labelEl.setText(text);
  }

  /** `fraction` 0–1 paints the completed share; `blue` swaps the grey fill for
   *  the accent colour once the whole pass is done. */
  setBar(fraction: number, blue: boolean): void {
    const pct = Math.max(0, Math.min(1, fraction)) * 100;
    this.barEl.style.width = `${pct.toFixed(1)}%`;
    this.barEl.toggleClass('is-done', blue);
  }

  onProgress(p: VaultPassProgress, applyLabel: string): void {
    const verb = p.phase === 'scan' ? '正在扫描' : applyLabel;
    this.setBar(p.total === 0 ? 1 : p.processed / p.total, false);
    this.setLabel(`${verb} ${p.processed} / ${p.total} 个文件…`);
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
    contentEl.addClass('drag-img-vault-confirm');
    new Setting(contentEl).setName(this.action.confirmTitle).setHeading();
    this.action.writeConfirmBody(contentEl, this.scan);

    // Plain CTA rather than `setDestructive()`: that method only exists from
    // Obsidian 1.13 and this plugin declares minAppVersion 1.5.0. The copy above
    // carries the "this is destructive" signal instead.
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

// ── Action: clear every DIA row back to a bare embed ────────────────────

const CLEAR_ACTION: MaintenanceAction = {
  name: '清除 DIA 格式（本库）',
  desc:
    '把全库中 DIA 写入的图片参数还原为 Obsidian 原生的 ![[文件名]]：整行图片行清掉整个' +
    '参数段，行内引用只清 DIA 写的对齐词、Obsidian 原生的宽度保留。逐个文件处理，' +
    '点击后先扫描、再确认、然后写入。清除会丢弃朝向、对齐、份额、填充与单图宽度，' +
    '且不可自动恢复（原始图片文件不受影响）。' +
    '注意：插件启用期间，笔记只要被打开或编辑，参数就会在第一帧被重新写回；' +
    '若目的是卸载插件，建议清除前先关闭所有打开的笔记，并在清除完成后立即停用插件。',
  buttonText: '开始清除',
  confirmTitle: '清除 DIA 格式（本库）',
  confirmButton: '确认清除',
  applyLabel: '正在清除',
  plan: () => clearPlan,
  emptyText: (scan) =>
    `扫描完成：${scan.scanned} 个 Markdown 文件中没有 DIA 格式行，无需清除。`,
  cancelledText: (scan) =>
    `已取消，未做任何修改。共检测到 ${scan.foundLines} 行 DIA 格式，` +
    `分布在 ${scan.entries.length} 个文件中。`,
  doneText: (summary) =>
    `清除完成：共扫描 ${summary.scanned} 个文件，` +
    `还原 ${summary.changedLines} 行，覆盖 ${summary.changedFiles} 个文件` +
    (summary.failed > 0 ? `，${summary.failed} 个文件失败（见 log.txt）。` : '。') +
    '若目的是卸载插件，请立即停用插件，并关闭所有打开的笔记。',
  failureNotice: '清除 DIA 格式失败',
  writeConfirmBody: (contentEl, scan) => {
    paragraph(
      contentEl,
      `本次已扫描 ${scan.scanned} 个 Markdown 文件，命中 ${scan.foundLines} 行 ` +
        `DIA 写入的图片行参数，分布在 ${scan.entries.length} 个文件中。`
    );
    paragraph(contentEl, '这些行会被改写为 Obsidian 原生格式，例如：');
    sampleBlock(contentEl, '![[示例图片.webp|orig|center|100|67]]', '![[示例图片.webp]]');
  },
};

// ── Action: normalise every hostable line into the standard slot form ───

const NORMALIZE_ACTION: MaintenanceAction = {
  name: '归一化为标准格式（本库）',
  desc:
    '把全库中 DIA 可托管的图片行补写成标准参数格式：朝向槽写入原朝向（直立时写 orig），' +
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

    paragraph(contentEl, '以下内容会被保留：');
    const list = contentEl.createEl('ul');
    for (const item of [
      '行内已有的份额码与填充码：原样保留，不重算',
      '已有的朝向词（r90 / fh / …）与对齐词：原样保留',
      '单图行已有的 |S|W 尾码及其像素宽',
    ]) {
      list.createEl('li', { text: item });
    }

    paragraph(
      contentEl,
      '本次不会写入缺失的数值槽。份额要按各成员的自然像素尺寸才算得准，' +
        '填充比要等图像画出来才量得到，扫描期两者都拿不到；' +
        '笔记下次被打开时，首帧渲染会把它们按真实值补上。' +
        '若在这里硬写一个数，它会因为是显式参数而被固定下来，之后不再自动纠正。'
    );
    paragraph(
      contentEl,
      '原始图片文件不会被改动，受影响的只有笔记文本。' +
        '已保存到磁盘的笔记无法撤销；正在编辑器中打开的笔记可用一次 cmd+z 撤销。'
    );
    paragraph(contentEl, '建议先备份整个库，或在 Git 中提交一次当前状态，再执行本操作。');
  },
};
