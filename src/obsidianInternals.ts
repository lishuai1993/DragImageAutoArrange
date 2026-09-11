// ── Narrow views onto Obsidian internals ─────────────────────────────────
// A few members this plugin reads are not in Obsidian's public typings: the
// CodeMirror view behind `Editor`, the preview renderer's height ledger, and
// `EditorView.documentTop`. Declaring them once here lets every call site work
// against a real type instead of `any` — which is what the review lint's
// `no-unsafe-*` rules require, and what makes these accesses greppable.

import type { Editor, TFile, WorkspaceLeaf } from "obsidian";
import type { EditorView } from "@codemirror/view";

/** CodeMirror's `EditorView` plus Obsidian's extra offset: the distance from
 *  the scroller's top edge down to block-coordinate 0. */
export type ObsidianEditorView = EditorView & { documentTop?: number };

/** Obsidian's `Editor` facade plus the underlying CodeMirror view. */
export type EditorInternals = Editor & { cm?: ObsidianEditorView };

/** One entry of the preview renderer's JS height ledger. Fields are optional
 *  because the ledger is populated incrementally: early sections carry heights
 *  but no line range, and the range may be absent entirely. */
export interface PreviewSection {
  lineStart?: number;
  lineEnd?: number;
  height?: number;
  type?: string;
}

/** The renderer Obsidian hangs off `MarkdownPreviewView`. */
export interface PreviewModeInternals {
  renderer?: { sections?: PreviewSection[] };
  /** Internal "scroll the preview so this source line is centered" hook. */
  applyScroll?(line: number): void;
  /** Public on `MarkdownPreviewView`, restated here so warmup can drive the
   *  preview straight from a `MarkdownViewInternals` handle. `set` stays
   *  optional because callers probe for it before use. */
  set?(data: string, clear: boolean): void;
  rerender(full?: boolean): void;
}

/** The `MarkdownView` members this plugin reads. Every member is optional:
 *  call sites guard on presence, and a leaf's view may not be a Markdown view
 *  at all. */
export interface MarkdownViewInternals {
  file?: TFile | null;
  editor?: EditorInternals;
  previewMode?: PreviewModeInternals;
  contentEl?: HTMLElement;
  containerEl?: HTMLElement;
  leaf?: WorkspaceLeaf;
  getMode?(): string;
  getViewData?(): string;
  setEphemeralState?(state: unknown): void;
  save?(clear?: boolean): Promise<void>;
}

/** `MarkdownView.prototype` as monkey-patched by anchorModeSwitch. */
export interface MarkdownViewPrototype {
  setState?(state: unknown, result: unknown): Promise<void>;
  save?(clear?: boolean): Promise<void>;
}

/** Re-type any view as its internal surface. Nothing is changed at runtime —
 *  the members are optional, so a non-Markdown view degrades to `undefined`. */
export function viewInternals(view: unknown): MarkdownViewInternals | null {
  // Every member is optional, so the narrowed `{}` is already structurally
  // assignable — no cast needed (an explicit one is flagged as redundant).
  return view ? view : null;
}

/** The CodeMirror view behind a Markdown view, or null when the view is not a
 *  Markdown view / has no editor attached yet. Centralizes the
 *  `view.editor.cm` descent that `Editor`'s public type doesn't expose. */
export function editorCmOf(view: unknown): ObsidianEditorView | null {
  return viewInternals(view)?.editor?.cm ?? null;
}

/** Probe-and-call the instance `scrollIntoView` some Obsidian builds hang off
 *  the CM view. CodeMirror 6 declares only the *static* form (which dispatches
 *  an effect), so this member is invisible to the typings; probing structurally
 *  keeps the call site type-safe and lets the caller fall back when absent. */
export function instanceScrollIntoView(
  cm: ObsidianEditorView,
  pos: number,
  opts: { y: string },
): boolean {
  const fn = (cm as ObsidianEditorView & {
    scrollIntoView?: (pos: number, opts: { y: string }) => void;
  }).scrollIntoView;
  if (typeof fn !== "function") return false;
  fn.call(cm, pos, opts);
  return true;
}
