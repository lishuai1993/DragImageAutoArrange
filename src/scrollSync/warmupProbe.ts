import { App, WorkspaceLeaf } from "obsidian";
import { logger } from "../logger";
const log = logger.channel("warmupProbe");
import { setSectionSnapshot } from "./scrollAnchor";
import { viewInternals } from "../obsidianInternals";
// L3: release the per-section re-entry marks this warmup pass wrote into the RM
// post-processor guard, so the real RM render can reprocess any section the warmup
// touched but did not fully wrap (cross-pass mark leak → problem 1).
import { releasePostProcessingMarks } from "../imageRender/readingMode";

// ── RM warm-up probe ───────────────────────────────────────────────────
// Pre-renders the real previewMode in the background (visibility:hidden) so
// the first LP→RM switch takes the hot path — the height ledger is already
// built and the DOM is already laid out.
//
// Supports:
//  - Per-leaf warmup (active or background)
//  - Abort signal for preemption (P0 cancels running P2)
//  - Container-level overrides for non-active leaf warmup
// ── Feature flag ────────────────────────────────────────────────────────

export const ENABLE_WARMUP_PROBE = true;

// ── Timing ─────────────────────────────────────────────────────────────

const CIRCUIT_BREAKER_MS = 30_000;
const STABLE_FRAMES = 8;
const STABLE_FRAMES_EARLY = 2;
const SET_FALLBACK_AT_MS = 3000;

// ── Style override machinery ───────────────────────────────────────────
// The overrides go on as inline styles rather than as styles.css classes: they
// land on Obsidian's own container chain (`.workspace-leaf-content`, the view's
// containerEl, `.markdown-reading-view`), so they have to outrank the display /
// position rules Obsidian itself puts on those elements. The class names are
// kept as markers, so a warm-up's DOM traces stay identifiable in DevTools.

const OVERRIDE_CLASS = "diaa-warmup-probe";
const CONTAINER_OVERRIDE_CLASS = "diaa-warmup-container";

/** Makes an element layout-capable but invisible for the duration of a warm-up. */
const OVERRIDE_STYLE = {
  display: "block",
  visibility: "hidden",
  position: "absolute",
  inset: "0",
  pointerEvents: "none",
} as const;

type OverrideProp = keyof typeof OVERRIDE_STYLE;

/** Apply OVERRIDE_STYLE, returning the element's previous inline values. */
function applyOverrideStyle(el: HTMLElement): Record<OverrideProp, string> {
  const saved = {} as Record<OverrideProp, string>;
  const props = Object.keys(OVERRIDE_STYLE) as OverrideProp[];
  for (const key of props) saved[key] = el.style[key];
  el.setCssStyles(OVERRIDE_STYLE);
  return saved;
}

/** Put back whatever inline values applyOverrideStyle displaced. */
function restoreOverrideStyle(el: HTMLElement, saved: Record<OverrideProp, string>): void {
  const props = Object.keys(saved) as OverrideProp[];
  for (const key of props) el.style[key] = saved[key];
}

/** Apply overrides to the container chain so a non-active leaf's DOM
 *  is layout-capable. Returns cleanup. */
function applyContainerOverrides(leaf: WorkspaceLeaf): () => void {
  const overridden: Array<{ el: HTMLElement; saved: Record<OverrideProp, string> }> = [];
  const view = viewInternals(leaf.view);
  const contentEl = view?.contentEl;
  const containerEl = view?.containerEl;

  const override = (el: HTMLElement) => {
    el.classList.add(CONTAINER_OVERRIDE_CLASS);
    overridden.push({ el, saved: applyOverrideStyle(el) });
  };

  // Walk up from contentEl to the workspace-leaf, overriding each
  // ancestor that might have display:none.
  let el: HTMLElement | null = contentEl?.parentElement ?? null;
  while (el && !el.classList.contains("workspace-leaf")) {
    if (getComputedStyle(el).display === "none") override(el);
    el = el.parentElement;
  }
  // Also check containerEl itself
  if (containerEl && getComputedStyle(containerEl).display === "none") override(containerEl);

  return () => {
    for (const { el: target, saved } of overridden) {
      target.classList.remove(CONTAINER_OVERRIDE_CLASS);
      restoreOverrideStyle(target, saved);
    }
  };
}

let _active = false;
let _overriddenEl: HTMLElement | null = null;
let _overriddenSaved: Record<OverrideProp, string> | null = null;
let _removeContainerOverride: (() => void) | null = null;

function removeOverride(): void {
  if (_overriddenEl) {
    _overriddenEl.classList.remove(OVERRIDE_CLASS);
    if (_overriddenSaved) restoreOverrideStyle(_overriddenEl, _overriddenSaved);
    _overriddenEl = null;
    _overriddenSaved = null;
  }
  if (_removeContainerOverride) {
    _removeContainerOverride();
    _removeContainerOverride = null;
  }
}

/** Cancel any running probe and remove all DOM traces. */
export function cancelWarmupProbe(): void {
  removeOverride();
  _active = false;
}

// ── Core warmup runner ─────────────────────────────────────────────────

/**
 * Run warmup for a specific leaf (or the active leaf if omitted).
 * @param app        Obsidian App instance
 * @param targetLeaf The leaf to warm up (pass undefined for active leaf)
 * @param signal     Abort signal — checked each rAF tick; set `aborted=true`
 *                   to cancel. The runner cleans up DOM overrides before
 *                   returning when aborted.
 */
export async function runWarmup(
  app: App,
  targetLeaf?: WorkspaceLeaf,
  signal?: { aborted: boolean },
): Promise<void> {
  if (_active) return;

  const leaf = targetLeaf ?? app.workspace.getMostRecentLeaf();
  if (!leaf) return;
  const view = viewInternals(leaf.view);
  if (!view) return;
  const file = view.file?.path ?? "";
  const mode = view.getMode?.() ?? "";

  if (!file || mode !== "source") return;

  const pm = view.previewMode;
  const contentEl = view.contentEl ?? view.containerEl;
  const readingEl = contentEl?.querySelector<HTMLElement>(".markdown-reading-view");
  const previewEl = readingEl?.querySelector<HTMLElement>(".markdown-preview-view");
  const sizer = previewEl?.querySelector<HTMLElement>(".markdown-preview-sizer");
  if (!pm || !readingEl || !previewEl) {
    log.info("WARMUP aborted: preview objects missing", {
      file, hasPm: !!pm, hasReadingEl: !!readingEl, hasPreviewEl: !!previewEl,
    });
    return;
  }

  // Make the leaf's container chain layout-capable (needed for non-active leaves)
  _removeContainerOverride = applyContainerOverrides(leaf);

  const preChildren = sizer?.childElementCount ?? -1;
  _active = true;
  readingEl.classList.add(OVERRIDE_CLASS);
  _overriddenEl = readingEl;
  _overriddenSaved = applyOverrideStyle(readingEl);

  log.info("WARMUP start", {
    file,
    isActive: leaf === app.workspace.getMostRecentLeaf(),
    preChildren,
    clientH: previewEl.clientHeight,
    docH: previewEl.scrollHeight,
  });

  let rerenderOk = true;
  try { pm.rerender(true); } catch (e) {
    rerenderOk = false;
    log.warn("WARMUP rerender(true) threw", { error: String(e) });
  }

  const t0 = performance.now();
  let lastDocH = -1;
  let stableFrames = 0;
  let setFallbackTried = false;

  const finish = (result: string) => {
    const ms = Math.round(performance.now() - t0);
    const secs = pm?.renderer?.sections;
    const sectionsLen = Array.isArray(secs) ? secs.length : -1;

    // Capture snapshot if sections are available
    try {
      if (Array.isArray(secs) && secs.length > 0) {
        const snap = secs.map((s) => ({
          lineStart: s.lineStart, lineEnd: s.lineEnd, height: s.height,
        }));
        const totalLines = view.editor?.lineCount()
          ?? (snap.length > 0 ? snap[snap.length - 1].lineEnd : 0);
        setSectionSnapshot(file, snap, totalLines);
        log.debug("WARMUP snapshot captured", { sections: snap.length, totalLines });
      } else {
        log.debug("WARMUP snapshot skipped", {
          hasSecs: Array.isArray(secs), len: sectionsLen,
        });
      }
    } catch (e) {
      log.debug("WARMUP snapshot failed", { error: String(e) });
    }

    const finalChildren = sizer?.childElementCount ?? -1;
    removeOverride();
    _active = false;

    // L3: this warmup pass (success or abort) is over — release the re-entry marks
    // it wrote into the RM post-processor guard. Without this, a warmup that touched
    // a section but did not finish wrapping it (e.g. "aborted: reading view detached")
    // would leave that section permanently marked, so the real RM render skips it and
    // images fall back to native Obsidian form. Already-wrapped sections stay skipped
    // via the L1 completion-marker short-circuit in the processor entry.
    releasePostProcessingMarks();
    log.debug("WARMUP marks released", { result });

    // Single structured log for every warmup completion
    log.info("WARMUP finish", {
      file, result, totalMs: ms,
      finalDocH: lastDocH,
      finalChildren,
      preChildren,
      stableFrames,
      fallbackFired: setFallbackTried,
      sectionsLen,
      rerenderOk,
      docHAfterRestore: previewEl.scrollHeight,
    });
  };

  const tick = () => {
    // ── Abort check ──
    if (signal?.aborted) {
      finish("aborted: signal");
      return;
    }

    const elapsed = performance.now() - t0;

    // User switched modes/files mid-warmup on the active leaf
    if (leaf === app.workspace.getMostRecentLeaf()) {
      const curMode = view.getMode?.() ?? "";
      const curFile = view.file?.path ?? "";
      if (curMode !== "source" || curFile !== file) {
        finish("aborted: view changed (user took over)");
        return;
      }
    }
    if (!readingEl.isConnected) {
      finish("aborted: reading view detached");
      return;
    }

    const docH = previewEl.scrollHeight;
    const children = sizer?.childElementCount ?? -1;
    if (docH === lastDocH) {
      stableFrames++;
    } else {
      stableFrames = 0;
      lastDocH = docH;
      log.debug("WARMUP progress", {
        t: Math.round(elapsed), docH, children, clientH: previewEl.clientHeight, stableFrames,
      });
    }

    if (!setFallbackTried && elapsed >= SET_FALLBACK_AT_MS
        && (children <= preChildren || !rerenderOk)) {
      setFallbackTried = true;
      const data = view.editor?.getValue() ?? "";
      if (typeof pm.set === "function" && data) {
        try {
          pm.set(data, true);
          log.info("WARMUP fallback previewMode.set() fired", { bytes: data.length });
        } catch (e) {
          log.warn("WARMUP previewMode.set() threw", { error: String(e) });
        }
      } else {
        log.info("WARMUP fallback unavailable", { hasSet: typeof pm.set === "function" });
      }
    }

    const rendered = docH > previewEl.clientHeight && children > 1;
    if (rendered && stableFrames >= STABLE_FRAMES) {
      finish("rendered+stable");
      return;
    }
    // Early exit: sections populated with line mapping, docH still settling.
    // lineStart/lineEnd are determined at first render; later docH drift is
    // layout micro-adjustment that doesn't affect line mapping correctness.
    if (rendered && elapsed > 500 && stableFrames >= STABLE_FRAMES_EARLY) {
      const secs = pm?.renderer?.sections;
      if (Array.isArray(secs) && secs.length > 0) {
        finish("rendered+stale");
        return;
      }
    }
    // 30s circuit breaker: sections populate within ~1s in all observed cases.
    // Only reached if rendering fails entirely (pm.rerender threw + fallback
    // pm.set also failed + sections never populated).
    if (elapsed >= CIRCUIT_BREAKER_MS) {
      const secs = pm?.renderer?.sections;
      log.error("WARMUP circuit breaker", {
        file, elapsed: Math.round(elapsed), docH, children, preChildren,
        stableFrames, rerenderOk, fallbackFired: setFallbackTried,
        sectionsLen: Array.isArray(secs) ? secs.length : -1,
      });
      removeOverride();
      _active = false;
      return;
    }
    window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
}
