import { App, WorkspaceLeaf } from "obsidian";
import { logger } from "../logger";
const log = logger.channel("warmupProbe");
import { setSectionSnapshot } from "./scrollAnchor";

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

// ── CSS override machinery ─────────────────────────────────────────────

const OVERRIDE_CLASS = "diaa-warmup-probe";
const CONTAINER_OVERRIDE_CLASS = "diaa-warmup-container";
const STYLE_ID = "diaa-warmup-probe-style";

function ensureStyleEl(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.${CONTAINER_OVERRIDE_CLASS} {
  display: block !important;
  visibility: hidden !important;
  position: absolute !important;
  inset: 0 !important;
  pointer-events: none !important;
}
.${OVERRIDE_CLASS} {
  display: block !important;
  visibility: hidden !important;
  position: absolute !important;
  inset: 0 !important;
  pointer-events: none !important;
}`;
  document.head.appendChild(style);
}

/** Apply overrides to the container chain so a non-active leaf's DOM
 *  is layout-capable. Returns cleanup. */
function applyContainerOverrides(leaf: WorkspaceLeaf): () => void {
  const overridden: HTMLElement[] = [];
  const contentEl = (leaf.view as any)?.contentEl as HTMLElement | undefined;
  const containerEl = (leaf.view as any)?.containerEl as HTMLElement | undefined;

  // Walk up from contentEl to the workspace-leaf, overriding each
  // ancestor that might have display:none.
  let el: HTMLElement | null = contentEl?.parentElement ?? null;
  while (el && !el.classList.contains("workspace-leaf")) {
    const computed = getComputedStyle(el);
    if (computed.display === "none") {
      el.classList.add(CONTAINER_OVERRIDE_CLASS);
      overridden.push(el);
    }
    el = el.parentElement;
  }
  // Also check containerEl itself
  if (containerEl && getComputedStyle(containerEl).display === "none") {
    containerEl.classList.add(CONTAINER_OVERRIDE_CLASS);
    overridden.push(containerEl);
  }

  return () => {
    for (const el of overridden) el.classList.remove(CONTAINER_OVERRIDE_CLASS);
  };
}

// ── Legacy scheduling (deprecated by warmupScheduler, kept for compat) ─

let _timer: number | null = null;
let _active = false;
let _overriddenEl: HTMLElement | null = null;
let _removeContainerOverride: (() => void) | null = null;

function removeOverride(): void {
  if (_overriddenEl) {
    _overriddenEl.classList.remove(OVERRIDE_CLASS);
    _overriddenEl = null;
  }
  if (_removeContainerOverride) {
    _removeContainerOverride();
    _removeContainerOverride = null;
  }
}

/** Cancel any pending/running probe and remove all DOM traces. */
export function cancelWarmupProbe(): void {
  if (_timer !== null) {
    clearTimeout(_timer);
    _timer = null;
  }
  removeOverride();
  _active = false;
  document.getElementById(STYLE_ID)?.remove();
}

/** Debounced entry point for the active leaf only (legacy). */
export function scheduleWarmupProbe(app: App): void {
  if (!ENABLE_WARMUP_PROBE) return;
  if (_timer !== null) clearTimeout(_timer);
  _timer = window.setTimeout(() => {
    _timer = null;
    try { runWarmup(app); } catch (e) {
      log.warn("WARMUP probe threw", { error: String(e) });
      removeOverride();
      _active = false;
    }
  }, 2000);
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

  const leaf = targetLeaf ?? app.workspace.activeLeaf;
  if (!leaf) return;
  const view = leaf.view as any;
  const file = view?.file?.path ?? "";
  const mode = view?.getMode?.() ?? "";

  if (!file || mode !== "source") return;

  const pm = view.previewMode;
  const contentEl = (view.contentEl ?? view.containerEl) as HTMLElement | undefined;
  const readingEl = contentEl?.querySelector(".markdown-reading-view") as HTMLElement | null;
  const previewEl = readingEl?.querySelector(".markdown-preview-view") as HTMLElement | null;
  const sizer = previewEl?.querySelector(".markdown-preview-sizer") as HTMLElement | null;
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
  ensureStyleEl();
  readingEl.classList.add(OVERRIDE_CLASS);
  _overriddenEl = readingEl;

  log.info("WARMUP start", {
    file,
    isActive: leaf === app.workspace.activeLeaf,
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
        const snap = secs.map((s: any) => ({
          lineStart: s.lineStart, lineEnd: s.lineEnd, height: s.height,
        }));
        const totalLines = view.editor?.lineCount?.()
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
    if (leaf === app.workspace.activeLeaf) {
      const curMode = (view?.getMode?.() ?? "");
      const curFile = (view?.file?.path ?? "");
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
      const data = view.editor?.getValue?.() ?? "";
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
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
