// ── Reading-mode DOM locators ──────────────────────────────────────────
// Single source of truth for the reading-view element lookups used across the
// scroll-anchor capture/restore/warmup code. Centralizing the selectors and
// the "scope to the active view" rule prevents subtle divergence (e.g. one
// call site accidentally querying globally and matching a hidden preview from
// another leaf).

import type { App } from "obsidian";

/** The reading-mode preview scroller class. Kept as a named constant so every
 *  locator targets the exact same element. */
export const RM_PREVIEW_VIEW_SELECTOR = ".markdown-preview-view";

/** Find the `.markdown-preview-view` scroller within a specific container
 *  (a view's contentEl/containerEl). Scoping to the container avoids matching a
 *  hidden/zero-height preview from another leaf or a mid-switch stub. */
export function queryPreviewViewIn(container: HTMLElement | undefined | null): HTMLElement | null {
  return (container?.querySelector(RM_PREVIEW_VIEW_SELECTOR) as HTMLElement | null) ?? null;
}

/** The active view's reading-mode scroll container. RM-side capture/restore must
 *  query WITHIN the active MarkdownView — a global `document.querySelector`
 *  can hit a hidden/zero-height `.markdown-preview-view` from another leaf or a
 *  mid-switch stub, which silently makes all RM geometry read 0 and degrades
 *  cross-mode sync to LP-only. Scoping to the active view's contentEl fixes it. */
export function getRMPreviewEl(app: App): HTMLElement | null {
  const view = app.workspace.activeLeaf?.view as any;
  const container = (view?.contentEl ?? view?.containerEl) as HTMLElement | undefined;
  return queryPreviewViewIn(container);
}

/** Locate a rendered image embed by its source-line marker (data-diaa-line),
 *  scoped to a preview root. Returns null when no such embed is laid out yet. */
export function findEmbedByLine(root: ParentNode, line: number | string): HTMLElement | null {
  return root.querySelector(`.internal-embed[data-diaa-line="${line}"]`) as HTMLElement | null;
}
