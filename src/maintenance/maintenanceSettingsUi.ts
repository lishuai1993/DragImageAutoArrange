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
import { t, type Localized } from '../i18n/language';
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
const HEADING: Localized = { zh: 'DIAA 格式维护', en: 'DIAA formatting upkeep' };

/** Progress and failure copy shared by both actions. */
const RUNNING_TEXT = {
  /** The scan half always reads this; the write half names its own verb. */
  scanning: { zh: '正在扫描', en: 'Scanning' },
  files: { zh: '{verb} {done} / {total} 个文件…', en: '{verb} {done} / {total} files…' },
  starting: { zh: '正在扫描…', en: 'Scanning…' },
  busy: { zh: '处理中…', en: 'Working…' },
  failed: { zh: '操作失败：{error}', en: 'Failed: {error}' },
  cancel: { zh: '取消', en: 'Cancel' },
  /** Nothing has run yet. */
  resting: { zh: '尚未执行。', en: 'Not run yet.' },
} as const satisfies Record<string, Localized>;

/** The maintenance section as the settings tab sees it: definitions for the
 *  1.13 path, a mount point for the path below it. */
export interface MaintenanceSection {
  definitions(): SettingDefinitionItem[];
  mount(containerEl: HTMLElement): void;
}

/** One vault-wide action: what it is called, what it says, which lines it owns.
 *
 *  The fixed strings are `{ zh, en }` pairs resolved where they are drawn, since
 *  the actions themselves are built once at import; the ones that interpolate a
 *  scan result resolve when the pass reports, so they always speak the language
 *  in force at that moment. */
interface MaintenanceAction {
  name: Localized;
  desc: Localized;
  buttonText: Localized;
  confirmTitle: Localized;
  confirmButton: Localized;
  /** The verb for the write half of the progress label; the scan half is
   *  always 正在扫描 / Scanning. */
  applyLabel: Localized;
  /** The plan the run scans and writes with — built once per run, so both phases
   *  see the same policy even if the settings move underneath. */
  plan(bridge: MaintenanceBridge): LinePlan;
  /** The body of the confirmation dialog, above the buttons. */
  writeConfirmBody(contentEl: HTMLElement, scan: VaultPassScan): void;
  emptyText(scan: VaultPassScan): string;
  cancelledText(scan: VaultPassScan): string;
  doneText(summary: VaultPassSummary): string;
  failureNotice: Localized;
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
  return { label: t(RUNNING_TEXT.resting), fraction: 0, blue: false, busy: false, locked: false };
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
        heading: t(HEADING),
        items: ACTIONS.map((action) => ({
          name: t(action.name),
          desc: t(action.desc),
          render: (setting: Setting) => this.renderRow(setting, action),
        })),
      },
    ];
  }

  /** Draw the group by hand, heading and div included — the path below 1.13. */
  mount(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t(HEADING)).setHeading();
    const group = containerEl.createDiv();
    group.addClass('diaa-settings-group');

    ACTIONS.forEach((action, index) => {
      // Rows in a card are divided by the framework's own rule; a bare group div
      // has none, so the legacy path draws the divider it needs.
      if (index > 0) {
        const sep = group.createDiv();
        sep.addClass('diaa-vault-sep');
      }
      this.renderRow(
        new Setting(group).setName(t(action.name)).setDesc(t(action.desc)),
        action
      );
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
        .setButtonText(t(action.buttonText))
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
    view.button.setButtonText(state.busy ? t(RUNNING_TEXT.busy) : t(action.buttonText));
    view.labelEl.setText(state.label);
    const pct = Math.max(0, Math.min(1, state.fraction)) * 100;
    view.barEl.style.width = `${pct.toFixed(1)}%`;
    view.barEl.toggleClass('is-done', state.blue);
  }

  private onProgress(action: MaintenanceAction, p: VaultPassProgress): void {
    const verb = t(p.phase === 'scan' ? RUNNING_TEXT.scanning : action.applyLabel);
    this.update(action, {
      fraction: p.total === 0 ? 1 : p.processed / p.total,
      blue: false,
      label: t(RUNNING_TEXT.files, { verb, done: p.processed, total: p.total }),
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
    this.update(action, { busy: true, fraction: 0, blue: false, label: t(RUNNING_TEXT.starting) });
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
        label: t(RUNNING_TEXT.failed, { error: String(error) }),
      });
      new Notice(t(action.failureNotice));
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
    new Setting(contentEl).setName(t(this.action.confirmTitle)).setHeading();
    this.action.writeConfirmBody(contentEl, this.scan);

    // Plain CTA rather than `setDestructive()`: that method only exists from
    // Obsidian 1.13 and this plugin declares minAppVersion 1.5.0.
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText(t(RUNNING_TEXT.cancel)).onClick(() => this.decide(false))
      )
      .addButton((button) =>
        button
          .setButtonText(t(this.action.confirmButton))
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
  name: { zh: '清除 DIAA 格式（本库）', en: 'Clear DIAA formatting (this vault)' },
  desc: {
    zh:
      '把全库中 DIAA 写入的图片参数还原为 Obsidian 原生的 ![[文件名]]：整行图片行清掉整个' +
      '参数段，行内引用只清 DIAA 写的对齐词、Obsidian 原生的宽度保留。逐个文件处理，' +
      '点击后先扫描、再确认、然后写入。清除会丢弃朝向、对齐、份额、填充与单图宽度，' +
      '且不可自动恢复（原始图片文件不受影响）。' +
      '注意：插件启用期间，笔记只要被打开或编辑，参数就会在第一帧被重新写回；' +
      '若目的是卸载插件，建议清除前先关闭所有打开的笔记，并在清除完成后立即停用插件。',
    en:
      'Restore the image parameters DIAA wrote back to Obsidian’s native ![[file name]]: on ' +
      'a whole image row the entire parameter run goes, while an inline reference only loses ' +
      'the alignment word DIAA wrote and keeps the width Obsidian set. Files are processed one ' +
      'at a time — click, scan, confirm, write. Clearing discards orientation, alignment, share, ' +
      'fill and single-image width, and cannot be undone automatically (the image files ' +
      'themselves are untouched). Note: while the plugin is enabled, any note that is opened or ' +
      'edited has its parameters written back on the first frame; if the goal is to uninstall ' +
      'the plugin, close every open note before clearing and disable the plugin as soon as the ' +
      'pass finishes.',
  },
  buttonText: { zh: '开始清除', en: 'Start clearing' },
  confirmTitle: { zh: '清除 DIAA 格式（本库）', en: 'Clear DIAA formatting (this vault)' },
  confirmButton: { zh: '确认清除', en: 'Confirm' },
  applyLabel: { zh: '正在清除', en: 'Clearing' },
  plan: () => clearPlan,
  emptyText: (scan) =>
    t(
      {
        zh: '扫描完成：{scanned} 个 Markdown 文件中没有 DIAA 格式行，无需清除。',
        en: 'Scan complete: no DIAA-formatted lines in {scanned} Markdown files — nothing to clear.',
      },
      { scanned: scan.scanned }
    ),
  cancelledText: (scan) =>
    t(
      {
        zh: '已取消，未做任何修改。共检测到 {foundLines} 行 DIAA 格式，分布在 {files} 个文件中。',
        en: 'Cancelled, nothing was changed. {foundLines} DIAA-formatted lines were found across {files} files.',
      },
      { foundLines: scan.foundLines, files: scan.entries.length }
    ),
  doneText: (summary) =>
    summary.failed > 0
      ? t(
          {
            zh: '清除完成：共扫描 {scanned} 个文件，还原 {changedLines} 行，覆盖 {changedFiles} 个文件，{failed} 个文件失败（见 log.txt）。若目的是卸载插件，请立即停用插件，并关闭所有打开的笔记。',
            en: 'Clear complete: {scanned} files scanned, {changedLines} lines restored across {changedFiles} files, {failed} files failed (see log.txt). If the goal was to uninstall the plugin, disable it now and close every open note.',
          },
          {
            scanned: summary.scanned,
            changedLines: summary.changedLines,
            changedFiles: summary.changedFiles,
            failed: summary.failed,
          }
        )
      : t(
          {
            zh: '清除完成：共扫描 {scanned} 个文件，还原 {changedLines} 行，覆盖 {changedFiles} 个文件。若目的是卸载插件，请立即停用插件，并关闭所有打开的笔记。',
            en: 'Clear complete: {scanned} files scanned, {changedLines} lines restored across {changedFiles} files. If the goal was to uninstall the plugin, disable it now and close every open note.',
          },
          {
            scanned: summary.scanned,
            changedLines: summary.changedLines,
            changedFiles: summary.changedFiles,
          }
        ),
  failureNotice: { zh: '清除 DIAA 格式失败', en: 'Failed to clear DIAA formatting' },
  writeConfirmBody: (contentEl, scan) => {
    paragraph(
      contentEl,
      t(
        {
          zh: '本次已扫描 {scanned} 个 Markdown 文件，命中 {foundLines} 行 DIAA 写入的图片行参数，分布在 {files} 个文件中。',
          en: 'Scanned {scanned} Markdown files and found {foundLines} image-parameter lines written by DIAA, across {files} files.',
        },
        { scanned: scan.scanned, foundLines: scan.foundLines, files: scan.entries.length }
      )
    );
    paragraph(
      contentEl,
      t({
        zh: '这些行会被改写为 Obsidian 原生格式，例如：',
        en: 'These lines will be rewritten to Obsidian’s native form, for example:',
      })
    );
    sampleBlock(
      contentEl,
      t({ zh: '![[示例图片.webp|orig|center|100|67]]', en: '![[example.webp|orig|center|100|67]]' }),
      t({ zh: '![[示例图片.webp]]', en: '![[example.webp]]' })
    );
    paragraph(
      contentEl,
      t({
        zh: '整库改写不可撤销，建议先提交一次。',
        en: 'A vault-wide rewrite cannot be undone — commit first.',
      })
    );
  },
};

// ── Action: normalise every hostable line into the standard slot form ───

const NORMALIZE_ACTION: MaintenanceAction = {
  name: { zh: '归一化为标准格式（本库）', en: 'Normalise to the standard form (this vault)' },
  desc: {
    zh:
      '把全库中 DIAA 可托管的图片行补写成标准参数格式：朝向槽写入原朝向（直立时写 orig），' +
      '对齐槽写入当前统一对齐设置，行内已有的数值参数原样保留。缺失的数值槽不在这里猜——' +
      '份额要按各成员的自然像素尺寸才算得准、填充比要等图像画出来才量得到，' +
      '所以交给该行首次渲染时按真实值补写，免得把一个凑出来的数钉死在笔记里。' +
      '单图行手写的原生宽度（|400、|400x300）会转写为手动宽度 |1|400 保留下来。' +
      '含别名等无法识别参数的行一律不动。',
    en:
      'Fill in the standard parameter form on every image row DIAA can host: the orientation ' +
      'slot takes the image’s current orientation (orig when upright), the alignment slot takes ' +
      'the current global alignment, and any numeric parameters already on the line are kept as ' +
      'they are. Missing numeric slots are not guessed here — a share needs each member’s ' +
      'natural pixel size, and a fill ratio can only be measured once the picture is painted — ' +
      'so the row fills those in from real values the first time it renders, rather than having ' +
      'a made-up number pinned into the note. A hand-written native width on a single-image row ' +
      '(|400, |400x300) is carried over as the manual width |1|400. Lines with parameters that ' +
      'cannot be read, such as an alias, are left alone.',
  },
  buttonText: { zh: '开始归一化', en: 'Start normalising' },
  confirmTitle: { zh: '归一化为标准格式（本库）', en: 'Normalise to the standard form (this vault)' },
  confirmButton: { zh: '确认归一化', en: 'Confirm' },
  applyLabel: { zh: '正在归一化', en: 'Normalising' },
  plan: (bridge) =>
    makeNormalizePlan({
      alignment: bridge.alignment,
      maxImagesPerRow: bridge.maxImagesPerRow,
    }),
  emptyText: (scan) =>
    t(
      {
        zh: '扫描完成：{scanned} 个 Markdown 文件中没有需要归一化的图片行。',
        en: 'Scan complete: no image rows to normalise in {scanned} Markdown files.',
      },
      { scanned: scan.scanned }
    ),
  cancelledText: (scan) =>
    t(
      {
        zh: '已取消，未做任何修改。共检测到 {foundLines} 行可归一化，分布在 {files} 个文件中。',
        en: 'Cancelled, nothing was changed. {foundLines} normalisable lines were found across {files} files.',
      },
      { foundLines: scan.foundLines, files: scan.entries.length }
    ),
  doneText: (summary) =>
    summary.failed > 0
      ? t(
          {
            zh: '归一化完成：共扫描 {scanned} 个文件，改写 {changedLines} 行，覆盖 {changedFiles} 个文件，{failed} 个文件失败（见 log.txt）。数值槽会在笔记下次打开时由首帧补齐，补齐后才是完整的标准格式。',
            en: 'Normalise complete: {scanned} files scanned, {changedLines} lines rewritten across {changedFiles} files, {failed} files failed (see log.txt). The numeric slots are filled in from the first frame the next time each note is opened; only then is the line in its full standard form.',
          },
          {
            scanned: summary.scanned,
            changedLines: summary.changedLines,
            changedFiles: summary.changedFiles,
            failed: summary.failed,
          }
        )
      : t(
          {
            zh: '归一化完成：共扫描 {scanned} 个文件，改写 {changedLines} 行，覆盖 {changedFiles} 个文件。数值槽会在笔记下次打开时由首帧补齐，补齐后才是完整的标准格式。',
            en: 'Normalise complete: {scanned} files scanned, {changedLines} lines rewritten across {changedFiles} files. The numeric slots are filled in from the first frame the next time each note is opened; only then is the line in its full standard form.',
          },
          {
            scanned: summary.scanned,
            changedLines: summary.changedLines,
            changedFiles: summary.changedFiles,
          }
        ),
  failureNotice: { zh: '归一化失败', en: 'Failed to normalise' },
  writeConfirmBody: (contentEl, scan) => {
    paragraph(
      contentEl,
      t(
        {
          zh: '本次将扫描 {scanned} 个 Markdown 文件，命中 {foundLines} 行可归一化的图片行。',
          en: 'This pass will scan {scanned} Markdown files and match {foundLines} normalisable image rows.',
        },
        { scanned: scan.scanned, foundLines: scan.foundLines }
      )
    );
    paragraph(
      contentEl,
      t({
        zh: '每一行会补上朝向槽与对齐槽；自身没有对齐词的行取当前统一对齐设置：',
        en: 'Each line gains an orientation slot and an alignment slot; a line with no alignment word of its own takes the current global alignment:',
      })
    );
    sampleBlock(
      contentEl,
      t({ zh: '![[示例图片.webp|center]]', en: '![[example.webp|center]]' }),
      t({ zh: '![[示例图片.webp|orig|left]]', en: '![[example.webp|orig|left]]' })
    );
    paragraph(
      contentEl,
      t({
        zh: '单图行手写的原生宽度会转写为手动宽度，免得被首次渲染覆盖掉：',
        en: 'A hand-written native width on a single-image row is carried over as the manual width, so the first render cannot overwrite it:',
      })
    );
    sampleBlock(
      contentEl,
      t({ zh: '![[示例图片.webp|400]]', en: '![[example.webp|400]]' }),
      t({ zh: '![[示例图片.webp|orig|left|1|400]]', en: '![[example.webp|orig|left|1|400]]' })
    );
    paragraph(
      contentEl,
      t({
        zh: '整库改写不可撤销，建议先提交一次。',
        en: 'A vault-wide rewrite cannot be undone — commit first.',
      })
    );
  },
};

/** The actions in the order the section draws them. Declared after the two
 *  definitions above, which it reads. */
const ACTIONS: MaintenanceAction[] = [CLEAR_ACTION, NORMALIZE_ACTION];
