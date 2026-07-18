import { App } from "obsidian";
import { logger } from "../logger";
import { setSectionSnapshot } from "./scrollAnchor";

// ── RM warm-up probe (TEMPORARY — delete after the experiment) ───────
// Verifies the "pre-render the real previewMode in the background" plan:
// a WARM preview (DOM + height ledger already built) makes every LP→RM
// switch instant — all cold-start pathologies (maxScroll=0, compact-stack
// phase, transient coordinate space) exist only in the FIRST render.
//
// Probe questions:
//   W1  does previewMode.rerender(true) render while the reading view is
//       hidden-but-laid-out? (post-processor fires, sizer children grow)
//   W2  does the height ledger materialize (docH → full scale, stable)?
//   W3  after removing the style override, does the next real LP→RM switch
//       take the hot path (first-frame anchor-restored, no bounce)?
//
// The override is a CSS class (not inline styles) so Obsidian's own
// display toggling on a real mode switch can't be clobbered by our cleanup.

export const ENABLE_WARMUP_PROBE = true;

const WARMUP_DELAY_MS = 2000;
const WARMUP_TIMEOUT_MS = 10000;
const STABLE_FRAMES = 30;      // consecutive equal-docH frames = ledger settled
const SET_FALLBACK_AT_MS = 3000; // no progress by then → try previewMode.set()

const OVERRIDE_CLASS = "diaa-warmup-probe";
const STYLE_ID = "diaa-warmup-probe-style";

let _timer: number | null = null;
let _active = false;
let _overriddenEl: HTMLElement | null = null;

function ensureStyleEl(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.${OVERRIDE_CLASS} {
  display: block !important;
  visibility: hidden !important;
  position: absolute !important;
  inset: 0 !important;
  pointer-events: none !important;
}`;
  document.head.appendChild(style);
}

function removeOverride(): void {
  if (_overriddenEl) {
    _overriddenEl.classList.remove(OVERRIDE_CLASS);
    _overriddenEl = null;
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

/** Debounced entry point — call on file-open / layout-ready. */
export function scheduleWarmupProbe(app: App): void {
  if (!ENABLE_WARMUP_PROBE) return;
  if (_timer !== null) clearTimeout(_timer);
  _timer = window.setTimeout(() => {
    _timer = null;
    try { runWarmup(app); } catch (e) {
      logger.warn("WARMUP probe threw", { error: String(e) });
      removeOverride();
      _active = false;
    }
  }, WARMUP_DELAY_MS);
}

function runWarmup(app: App): void {
  if (_active) return;
  const view = app.workspace.activeLeaf?.view as any;
  const file = view?.file?.path ?? "";
  const mode = view?.getMode?.() ?? "";
  if (!file || mode !== "source") return; // only warm a hidden preview under LP

  const pm = view.previewMode;
  const contentEl = (view.contentEl ?? view.containerEl) as HTMLElement | undefined;
  const readingEl = contentEl?.querySelector(".markdown-reading-view") as HTMLElement | null;
  const previewEl = readingEl?.querySelector(".markdown-preview-view") as HTMLElement | null;
  const sizer = previewEl?.querySelector(".markdown-preview-sizer") as HTMLElement | null;
  if (!pm || !readingEl || !previewEl) {
    logger.info("WARMUP aborted: preview objects missing", {
      file, hasPm: !!pm, hasReadingEl: !!readingEl, hasPreviewEl: !!previewEl,
    });
    return;
  }

  const preChildren = sizer?.childElementCount ?? -1;
  _active = true;
  ensureStyleEl();
  readingEl.classList.add(OVERRIDE_CLASS);
  _overriddenEl = readingEl;

  logger.info("WARMUP start", {
    file,
    preChildren,
    clientH: previewEl.clientHeight, // must be ~viewport height for the renderer to work
    docH: previewEl.scrollHeight,
  });

  let rerenderOk = true;
  try { pm.rerender(true); } catch (e) {
    rerenderOk = false;
    logger.warn("WARMUP rerender(true) threw", { error: String(e) });
  }

  const t0 = performance.now();
  let lastDocH = -1;
  let stableFrames = 0;
  let setFallbackTried = false;

  const finish = (result: string) => {
    // Snapshot the renderer's section heights while the override keeps layout
    // alive (visibility:hidden still has computed geometry). This snapshot
    // survives the display:none gap so the first real LP→RM switch can park
    // at the correct Y before the renderer's re-measure cycle completes.
    try {
      const secs = pm?.renderer?.sections;
      if (Array.isArray(secs) && secs.length > 0) {
        const snap = secs.map((s: any) => ({
          lineStart: s.lineStart, lineEnd: s.lineEnd, height: s.height,
        }));
        setSectionSnapshot(file, snap);
        logger.debug("WARMUP snapshot captured", { sections: snap.length });
      } else {
        logger.debug("WARMUP snapshot skipped", {
          hasSecs: Array.isArray(secs), len: Array.isArray(secs) ? secs.length : -1,
        });
      }
    } catch (e) {
      logger.debug("WARMUP snapshot failed", { error: String(e) });
    }
    const ms = Math.round(performance.now() - t0);
    removeOverride();
    _active = false;
    // Re-measure one frame later: display:none again → scrollHeight reads 0.
    // That is EXPECTED and says nothing about ledger retention — W3 (the real
    // switch) is the retention test.
    requestAnimationFrame(() => {
      logger.info("WARMUP end", {
        file, result, ms,
        children: sizer?.childElementCount ?? -1,
        lastVisibleDocH: lastDocH,
        docHAfterRestore: previewEl.scrollHeight,
      });
    });
  };

  const tick = () => {
    const elapsed = performance.now() - t0;

    // User switched modes / files mid-warmup: Obsidian owns the view now —
    // drop our override immediately and get out of the way.
    const curMode = (app.workspace.activeLeaf?.view as any)?.getMode?.() ?? "";
    const curFile = (app.workspace.activeLeaf?.view as any)?.file?.path ?? "";
    if (curMode !== "source" || curFile !== file) {
      finish("aborted: view changed (user took over)");
      return;
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
      logger.debug("WARMUP progress", {
        t: Math.round(elapsed), docH, children, clientH: previewEl.clientHeight,
      });
    }

    // W1 fallback: rerender didn't produce anything — try feeding the data in.
    if (!setFallbackTried && elapsed >= SET_FALLBACK_AT_MS
        && (children <= preChildren || !rerenderOk)) {
      setFallbackTried = true;
      const data = view.editor?.getValue?.() ?? "";
      if (typeof pm.set === "function" && data) {
        try {
          pm.set(data, true);
          logger.info("WARMUP fallback previewMode.set() fired", { bytes: data.length });
        } catch (e) {
          logger.warn("WARMUP previewMode.set() threw", { error: String(e) });
        }
      } else {
        logger.info("WARMUP fallback unavailable", { hasSet: typeof pm.set === "function" });
      }
    }

    const rendered = docH > previewEl.clientHeight && children > Math.max(preChildren, 1);
    if (rendered && stableFrames >= STABLE_FRAMES) {
      finish("rendered+stable");
      return;
    }
    if (elapsed >= WARMUP_TIMEOUT_MS) {
      finish(rendered ? "rendered (docH never settled)" : "failed: nothing rendered");
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
