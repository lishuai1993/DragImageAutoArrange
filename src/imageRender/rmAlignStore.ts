import { App } from "obsidian";
import { logger } from "../logger";
import { editorCmOf, viewInternals, type ObsidianEditorView } from "../obsidianInternals";
const log = logger.channel("rmAlignStore");

// ── Pending alignment store ─────────────────────────────────────────
// RM alignment changes are buffered here and only flushed to the
// markdown document when the user switches from RM to LP mode.
// This avoids the flash that view.dispatch() would cause in RM.

export type AlignValue = "left" | "center" | "right";

const _pendingAlignments = new Map<string, AlignValue>();

function pendingKey(sourcePath: string, fileName: string): string {
  return `${sourcePath}::${fileName}`;
}

export function storePendingAlignment(
  sourcePath: string,
  fileName: string,
  alignment: AlignValue
): void {
  const key = pendingKey(sourcePath, fileName);
  _pendingAlignments.set(key, alignment);
  log.debug("ALIGN store-pending", { key, alignment, size: _pendingAlignments.size });
}

export function getPendingAlignmentCount(): number {
  return _pendingAlignments.size;
}

// ── Flush timer ──────────────────────────────────────────────────────

let _flushTimer: number | null = null;

export function clearFlushTimer(): void {
  if (_flushTimer) {
    window.clearTimeout(_flushTimer);
    _flushTimer = null;
  }
}

export function setFlushTimer(id: number): void {
  _flushTimer = id;
}

export function getFlushTimer(): number | null {
  return _flushTimer;
}

/** Find the CodeMirror EditorView for a given file path, if one is open. */
function findEditorViewForFile(app: App, sourcePath: string): ObsidianEditorView | null {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    if (viewInternals(leaf.view)?.file?.path !== sourcePath) continue;
    const cm = editorCmOf(leaf.view);
    if (cm) return cm;
  }
  return null;
}

/** Flush pending alignment changes to markdown files.
 *  Only clears entries that were successfully written — entries for files
 *  without an open LP editor stay buffered for the next flush attempt.
 *  Returns the set of file paths that were modified. */
export function flushPendingAlignments(app: App): Set<string> {
  const modified = new Set<string>();
  if (_pendingAlignments.size === 0) return modified;

  // Group by sourcePath
  const byFile = new Map<string, Array<{ key: string; fileName: string; alignment: AlignValue }>>();
  for (const [key, alignment] of _pendingAlignments) {
    const idx = key.lastIndexOf("::");
    const sourcePath = key.slice(0, idx);
    const fileName = key.slice(idx + 2);
    if (!byFile.has(sourcePath)) byFile.set(sourcePath, []);
    byFile.get(sourcePath)!.push({ key, fileName, alignment });
  }

  for (const [sourcePath, entries] of byFile) {
    const editorView = findEditorViewForFile(app, sourcePath);
    if (!editorView) {
      log.warn("ALIGN flush skip: no editorView", { sourcePath, entries: entries.length });
      continue;
    }
    log.debug("ALIGN flush file", { sourcePath, entries: entries.length });

    const changes: Array<{ from: number; to: number; insert: string }> = [];
    const doc = editorView.state.doc;

    for (const { fileName, alignment } of entries) {
      for (let i = 1; i <= doc.lines; i++) {
        const lineObj = doc.line(i);
        if (!lineObj.text.includes(fileName)) continue;
        const stripped = lineObj.text.replace(/\|(left|center|right)\|/, "|");
        let newLine: string;
        if (stripped.includes("|")) {
          newLine = stripped.replace(/\|/, `|${alignment}|`);
        } else {
          newLine = stripped.replace(/\]\]/, `|${alignment}]]`);
        }
        if (newLine !== lineObj.text) {
          changes.push({ from: lineObj.from, to: lineObj.from + lineObj.text.length, insert: newLine });
        }
        break;
      }
    }

    if (changes.length > 0) {
      changes.sort((a, b) => b.from - a.from);
      editorView.dispatch({ changes });
      // Fire-and-forget: the caller is a sync flush, and a disk write failure
      // must not block the in-memory editor change that already landed.
      void app.vault.adapter.write(sourcePath, editorView.state.doc.toString());
      modified.add(sourcePath);
      // Only clear entries that were successfully written
      for (const { key } of entries) {
        _pendingAlignments.delete(key);
      }
    }
  }

  return modified;
}
