// ── Shared vault-wide maintenance pass ──────────────────────────────────
// The skeleton behind the settings tab's two "DIA 格式维护" actions: walk every
// markdown file, let a policy say which lines it owns and what they become, then
// write the changed notes back.  Traversal, progress cadence, the hybrid write
// channel and failure accounting live here; the two actions — clearing every DIA
// row back to a bare embed, and normalising every hostable line into the
// standard slot layout — are pure line policies supplied by the caller.

import type { App, Editor, MarkdownView, TFile } from "obsidian";
import { logger } from "../logger";

export interface VaultPassProgress {
  phase: "scan" | "apply";
  processed: number;
  total: number;
}

/** A file carrying at least one owned line, with those line indices. */
export interface VaultPassEntry {
  file: TFile;
  lines: number[];
}

export interface VaultPassScan {
  entries: VaultPassEntry[];
  /** Markdown files visited. */
  scanned: number;
  /** Owned lines found across the vault. */
  foundLines: number;
  failed: number;
}

export interface VaultPassSummary {
  scanned: number;
  changedFiles: number;
  changedLines: number;
  failed: number;
}

/**
 * A pass's policy: given a note's raw lines, return the replacements to make as
 * `index → new line text`.  Only lines whose text actually differs belong in the
 * map, so a note the policy leaves alone never reaches disk; and a replacement
 * must stay within one line, because every index addresses the original text.
 *
 * The whole file is handed over rather than one line at a time because a line's
 * neighbours can decide its treatment — normalisation has to know whether an
 * image line stands alone or is one member of a run.
 */
export type LinePlan = (lines: string[], extensions: string) => Map<number, string>;

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function openMarkdownView(app: App, file: TFile): MarkdownView | null {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const view = leaf.view as MarkdownView;
    if (view.getViewType() !== "markdown" || !view.editor) continue;
    if (view.file?.path === file.path) return view;
  }
  return null;
}

function rewriteContent(
  content: string,
  extensions: string,
  plan: LinePlan
): { text: string; changed: number } {
  const lines = content.split("\n");
  const replacements = plan(lines, extensions);
  if (replacements.size === 0) return { text: content, changed: 0 };
  for (const [i, text] of replacements) lines[i] = text;
  return { text: lines.join("\n"), changed: replacements.size };
}

function rewriteViaEditor(editor: Editor, extensions: string, plan: LinePlan): number {
  const count = editor.lineCount();
  const lines: string[] = [];
  for (let i = 0; i < count; i++) lines.push(editor.getLine(i));
  const replacements = plan(lines, extensions);
  if (replacements.size === 0) return 0;
  // One transaction = one undo step. The ranges are read off the pre-transaction
  // text, which is also what the indices were computed against.
  editor.transaction({
    changes: [...replacements].map(([i, text]) => ({
      from: { line: i, ch: 0 },
      to: { line: i, ch: editor.getLine(i).length },
      text,
    })),
  });
  return replacements.size;
}

/**
 * Rewrite one note, preferring the editor channel when the note is open: that
 * preserves an unsaved buffer and lands as a single cmd+z.  Any other note goes
 * through `vault.process`.
 */
async function rewriteFile(
  app: App,
  file: TFile,
  extensions: string,
  plan: LinePlan
): Promise<number> {
  const view = openMarkdownView(app, file);
  if (view) return rewriteViaEditor(view.editor, extensions, plan);

  let changed = 0;
  await app.vault.process(file, (content) => {
    const next = rewriteContent(content, extensions, plan);
    changed = next.changed;
    return next.text;
  });
  return changed;
}

/**
 * Walk every markdown file and remember which lines the policy would touch.
 * Split from the write pass so a confirmation dialog can state the exact scope
 * before anything is written.
 */
export async function scanVault(
  app: App,
  extensions: string,
  plan: LinePlan,
  onProgress: (p: VaultPassProgress) => void
): Promise<VaultPassScan> {
  const files = app.vault.getMarkdownFiles();
  const entries: VaultPassEntry[] = [];
  let foundLines = 0;
  let failed = 0;

  for (let i = 0; i < files.length; i++) {
    try {
      const content = await app.vault.cachedRead(files[i]);
      const lines = [...plan(content.split("\n"), extensions).keys()];
      if (lines.length > 0) {
        entries.push({ file: files[i], lines });
        foundLines += lines.length;
      }
    } catch (error) {
      failed += 1;
      logger.warn("vault-pass: read failed", {
        path: files[i].path,
        error: String(error),
      });
    }
    onProgress({ phase: "scan", processed: i + 1, total: files.length });
    if ((i & 15) === 15) await yieldToUi();
  }

  return { entries, scanned: files.length, foundLines, failed };
}

/** Write pass over a scan's results. */
export async function applyPass(
  app: App,
  scan: VaultPassScan,
  extensions: string,
  plan: LinePlan,
  onProgress: (p: VaultPassProgress) => void
): Promise<VaultPassSummary> {
  const total = scan.entries.length;
  let changedFiles = 0;
  let changedLines = 0;
  let failed = scan.failed;

  for (let i = 0; i < total; i++) {
    try {
      const changed = await rewriteFile(app, scan.entries[i].file, extensions, plan);
      if (changed > 0) changedFiles += 1;
      changedLines += changed;
    } catch (error) {
      failed += 1;
      logger.warn("vault-pass: write failed", {
        path: scan.entries[i].file.path,
        error: String(error),
      });
    }
    onProgress({ phase: "apply", processed: i + 1, total });
    if ((i & 7) === 7) await yieldToUi();
  }

  return { scanned: scan.scanned, changedFiles, changedLines, failed };
}
