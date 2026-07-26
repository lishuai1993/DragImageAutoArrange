import { App, MarkdownView } from "obsidian";
import { logger } from "../logger";
import {
  getPendingAlignmentCount, clearFlushTimer, setFlushTimer, getFlushTimer, flushPendingAlignments,
} from "../rmAlignStore";
import {
  classifyCenter, ImageRowIndex, Line1, asLine1, buildImageRowIndex,
} from "./viewportAnchor";
import {
  clamp01, intraRowRatio, gapRatioFromGeom, imageRowTargetY, gapJunction, gapTargetY, textTargetY,
  nearestIndexBy, ledgerYForLine, ledgerTotalHeight, extrapolateLedgerY, sectionIndexEstimateY,
  LedgerSection, clientTopToDocY, scrollTopToPct, pctToScrollTop,
} from "./anchorMath";
import { assertNever } from "../utils";
import { getRMPreviewEl, queryPreviewViewIn, findEmbedByLine } from "./domLocators";
import { normalizeAnchorText } from "./textAnchor";
import {
  ViewportAnchor, setImageRowIndex, getImageRowIndex, invalidateImageRowIndex,
  getActiveAnchor, setActiveAnchor, getFallbackPct, setFallbackPct, getLastFallbackPct,
  setLastFallbackPct, setRMLastAnchor, getRMLastAnchor, setLPLastAnchor, getLPLastAnchor,
  getLastMode, setLastMode, getLastDocH, setLastDocH, getImageLineRe,
  setRMLastAnchorList, getRMLastAnchorList,
} from "./anchorStore";

const log = logger.channel("scrollAnchor");

import {
  state,
  MIN_ANCHOR_TEXT_LEN,
  TABLE_ROW_RE,
  TABLE_SPLIT_RE,
  BOX_DRAWING_RE,
  _sectionSnapshot,
  _snapshotLineCount,
  LEDGER_DOCH_TOLERANCE,
  LEDGER_PARK_TOL_MIN,
  LEDGER_PARK_TOL_FRAC,
  RATIO_GATE_TOL,
  ENABLE_NATIVE_SCROLL,
  SILENCE_WINDOW_MS,
  RM_RESTORE_TIMEOUT_MS,
  NATIVE_RETRY_INTERVAL,
  RM_HOLD_TIMEOUT_MS,
  RM_HOLD_CALM_FRAMES,
  EARLY_RESTORE_MAX_FRAMES,
  RM_EARLY_HOLD_FRAMES,
  getRMDeferredRestoreId,
  rmLoopEnterGuard,
  cancelAllRestoreChains,
  applySnapshotLineDelta,
  setLastAnchor,
  rmLoopExitGuard,
  enterRestoreGuard,
  setSectionSnapshot,
  exitRestoreGuard,
  isRestoreGuardActive,
  isInSilenceWindow,
  cancelRMHoldChain,
  getScrollAnchor,
  cancelRMDeferredRestore,
} from "./anchorState";

import {
  ensureImageRowIndexFromCM,
  clampRatioWarn,
  lineBlockByNumber,
  lpInset,
  nearestImgRowsByLine,
  rmTextBlocks,
  imgIndexToSelector,
  computeScrollPct,
  captureContentAnchor,
  extractCandidates,
  captureAnchorLP,
  captureAnchorRM,
  nearestImgRowsRM,
  rmRowBounds,
  captureImageRowRM,
  findBestTextLine,
  rmLedgerYForLine,
  anchorTargetLine,
  computeDocH,
} from "./anchorCapture";

import {
  scheduleRestoreAccuracyCheck,
  restoreContentAnchor,
  restoreImageRowInLP,
  restoreImageRowInRM,
  restoreImageGapInLP,
  restoreImageGapInRM,
  restoreTextInLP,
  restoreTextInRM,
  nativeScrollToLine,
  restoreScrollPct,
} from "./anchorRestore";

import { driveViewportTransition } from "./anchorModeSwitch";

// ── anchorTracking (extracted from scrollAnchor.ts in P3 split) ──

export function logScrollCapture(side: "RM" | "LP", el: HTMLElement, anchor: ViewportAnchor | null): void {
  const now = Date.now();
  if (now - state._lastScrollLogTs < 150) return;
  state._lastScrollLogTs = now;
  const info: Record<string, any> = { scrollTop: Math.round(el.scrollTop), kind: anchor?.kind ?? "none" };
  if (anchor) {
    switch (anchor.kind) {
      case "text":
        info.frag = anchor.anchorText.slice(0, 16);
        info.offset = Math.round(anchor.anchorOffset);
        if (anchor.anchorLine && anchor.anchorLine > 0) info.line = anchor.anchorLine;
        if (anchor.anchorContext) info.ctx = anchor.anchorContext.slice(0, 60);
        if (anchor.headingHint) info.hdg = anchor.headingHint.slice(0, 30);
        info.imgB = anchor.nearestImgBefore;
        info.imgA = anchor.nearestImgAfter;
        info.ratio = Math.round(anchor.docRatio * 100);
        break;
      case "image-row":
        info.imageRowIndex = anchor.imageRowIndex;
        info.ratio = Math.round(anchor.intraRowRatio * 100);
        break;
      case "image-gap":
        info.imgBefore = anchor.imgBefore;
        info.imgAfter = anchor.imgAfter;
        info.ratio = Math.round(anchor.gapRatio * 100);
        break;
      default:
        assertNever(anchor);
    }
  }
  if (side === "RM") {
    const cands = [".markdown-reading-view", ".markdown-preview-view", ".markdown-preview-sizer", ".markdown-preview-section"];
    info.scrollTops = cands
      .map(s => { const e = document.querySelector(s) as HTMLElement | null; return e ? `${s}=${Math.round(e.scrollTop)}` : `${s}=n/a`; })
      .join(" ");
  }
  if (side === "RM") {
    if (state._rmSuppressCount > 0 || state._rmSilenceCount > 0) {
      info.suppressed = state._rmSuppressCount;
      info.silenced = state._rmSilenceCount;
    }
    state._rmSuppressCount = 0;
    state._rmSilenceCount = 0;
  } else {
    if (state._lpSuppressCount > 0 || state._lpSilenceCount > 0) {
      info.suppressed = state._lpSuppressCount;
      info.silenced = state._lpSilenceCount;
    }
    state._lpSuppressCount = 0;
    state._lpSilenceCount = 0;
  }
  log.debug(`SCROLL ${side}`, info);
}



export function ensureRMScrollTracking(app: App): void {
  const previewEl = getRMPreviewEl(app) as HTMLElement | null;
  if (!previewEl || previewEl.clientHeight === 0) return;
  if (state._rmTrackedEl === previewEl) return;

  if (state._rmScrollCleanup) {
    state._rmScrollCleanup();
    state._rmScrollCleanup = null;
  }
  state._rmTrackedEl = null;

  const onScroll = () => {
    if (isRestoreGuardActive()) { state._rmSuppressCount++; return; }
    if (isInSilenceWindow()) { state._rmSilenceCount++; return; }
    const anchor = captureContentAnchor(app);
    if (anchor) {
      setRMLastAnchor(anchor, (app.workspace.activeLeaf?.view as any)?.file?.path ?? "");
    } else {
      // No anchor at this position — drop any stale one so a later mode switch
      // falls back to the fresh scroll percentage instead of jumping to an
      // unrelated image row captured earlier. Keep the file (matches prior
      // behavior: only the anchor is nulled).
      setRMLastAnchor(null, getRMLastAnchor().file);
    }
    const pct = computeScrollPct(app);
    if (pct >= 0) setLastFallbackPct(pct);
    logScrollCapture("RM", previewEl, anchor);
  };

  previewEl.addEventListener("scroll", onScroll, { passive: true });
  state._rmScrollCleanup = () => {
    previewEl.removeEventListener("scroll", onScroll);
    state._rmScrollCleanup = null;
    state._rmTrackedEl = null;
  };
  state._rmTrackedEl = previewEl;
}

// ── RM deferred restore ─────────────────────────────────────────────

// RM virtualizes off-screen sections, so a deep target row's embeds may not
// exist for the first several frames after a mode switch. Retry the precise
// restore until it lands; coarse-jump once toward the captured scroll percent
// to force the target region to render (its embeds then appear).
// Time-based timeout for RM cold-render retry loop (5 s). Removed the
// frame-count cap (RM_RESTORE_MAX_FRAMES) because setEphemeralState is async
// and the renderer may take >1 s to build DOM around a deep target line.
// native-scroll is re-pushed every NATIVE_RETRY_INTERVAL frames to keep the
// renderer moving toward the target region.


export function startRMSettleHold(app: App, seedAnchor: ViewportAnchor): void {
  cancelAllRestoreChains();
  const view = app.workspace.activeLeaf?.view as any;
  const file = view?.file?.path ?? "";
  let hookedEl = getRMPreviewEl(app) as HTMLElement | null;
  if (!hookedEl || !file) return;

  // Hold the scroll-capture guard across the whole hold: our corrective
  // writes dispatch their scroll events asynchronously, so a per-write guard
  // would release before the event fires and pollute the RM anchor slot.
  enterRestoreGuard();

  let userInterrupted = false;
  const onUser = () => { userInterrupted = true; };
  const attach = (el: HTMLElement) => {
    el.addEventListener("wheel", onUser, { passive: true });
    el.addEventListener("touchstart", onUser, { passive: true });
    el.addEventListener("pointerdown", onUser, { passive: true });
  };
  const detach = (el: HTMLElement) => {
    el.removeEventListener("wheel", onUser);
    el.removeEventListener("touchstart", onUser);
    el.removeEventListener("pointerdown", onUser);
  };
  attach(hookedEl);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (hookedEl) detach(hookedEl);
    exitRestoreGuard();
  };
  state._rmHoldCleanup = cleanup;

  const start = performance.now();
  let lastTop = hookedEl.scrollTop;
  let lastDocH = hookedEl.scrollHeight;
  let calm = 0;
  let corrections = 0;
  let firstCorrectionPx = 0;
  let lastCorrectionPx = 0;
  let maxDriftPx = 0;
  let firstTick = true;

  const finish = (reason: string, recapture: boolean) => {
    state._rmHoldId = null;
    state._rmHoldCleanup = null;
    cleanup();
    setActiveAnchor(null);
    log.info("VIEWPORT settle-hold end", {
      reason, corrections,
      firstPx: Math.round(firstCorrectionPx),
      lastPx: Math.round(lastCorrectionPx),
      maxDriftPx: Math.round(maxDriftPx),
      ms: Math.round(performance.now() - start),
      scrollTop: hookedEl ? Math.round(hookedEl.scrollTop) : -1,
    });
    if (!recapture) return;
    // Guard: if settle-hold landed at document head abnormally, the
    // captured anchor would be garbage — skip to avoid polluting the
    // RM slot and fallback percentage.
    if (hookedEl && hookedEl.scrollTop <= 0 && reason !== "stable") return;
    const anchor = captureContentAnchor(app);
    if (anchor) setRMLastAnchor(anchor, file);
    const pct = computeScrollPct(app);
    if (pct >= 0) setLastFallbackPct(pct);
    driveViewportTransition(app, "rm-settle-hold");
  };

  const tick = () => {
    state._rmHoldId = null;
    const v = app.workspace.activeLeaf?.view as any;
    if ((v?.getMode?.() ?? "") !== "preview" || (v?.file?.path ?? "") !== file) {
      finish("view-changed", false);
      return;
    }
    if (userInterrupted) {
      finish("user-input", false);
      return;
    }
    const el = getRMPreviewEl(app) as HTMLElement | null;
    if (!el) {
      finish("preview-gone", false);
      return;
    }
    if (el !== hookedEl) {
      // Spurious re-render replaced the preview DOM — force re-restore
		// instead of accepting the new (possibly empty) DOM's values.
      if (hookedEl) detach(hookedEl);
      attach(el);
      hookedEl = el;
      enterRestoreGuard();
      setActiveAnchor(seedAnchor);
      restoreContentAnchor(app);
      exitRestoreGuard();
      lastTop = el.scrollTop;
      lastDocH = el.scrollHeight;
      calm = 0;
    }

    if (firstTick) {
      firstTick = false;
      if (el.scrollTop > 0) {
        // Early restore already positioned us; use current values as baseline
        // instead of re-restoring against a layout that may still be settling.
        lastTop = el.scrollTop;
        lastDocH = el.scrollHeight;
        calm++;
        state._rmHoldId = requestAnimationFrame(tick);
        return;
      }
    }

    const docH = el.scrollHeight;
    const top = el.scrollTop;
    const moved = docH !== lastDocH || Math.abs(top - lastTop) > 1;
    if (moved) {
      // Track max layout drift between ticks (before correction).
      const drift = Math.abs(top - lastTop);
      if (drift > maxDriftPx) maxDriftPx = drift;

      // Layout reflowed (or an external write scrolled us) — re-pin.
      // enterRestoreGuard also refreshes the guard's 2s safety timer, so a
      // hold that keeps correcting can't be force-released mid-flight.
      enterRestoreGuard();
      setActiveAnchor(seedAnchor);
      const ok = restoreContentAnchor(app);
      if (!ok) setActiveAnchor(null); // target block mid-rerender; retry next frame
      exitRestoreGuard();
      const newTop = el.scrollTop;
      const correctionPx = Math.abs(newTop - top);
      if (correctionPx > 2) {
        if (corrections === 0) firstCorrectionPx = correctionPx;
        lastCorrectionPx = correctionPx;
        corrections++; calm = 0;
      } else calm++;
      lastTop = newTop;
      lastDocH = el.scrollHeight;
    } else {
      calm++;
    }

    if (calm >= RM_HOLD_CALM_FRAMES) { finish("stable", true); return; }
    if (performance.now() - start > RM_HOLD_TIMEOUT_MS) { finish("timeout", true); return; }
    state._rmHoldId = requestAnimationFrame(tick);
  };
  log.debug("VIEWPORT settle-hold start", {
    scrollTop: Math.round(lastTop), docH: lastDocH,
  });
  state._rmHoldId = requestAnimationFrame(tick);
}



export function scheduleRMDeferredRestore(app: App): void {
  if (state._rmDeferredRestoreId !== null) {
    cancelAnimationFrame(state._rmDeferredRestoreId);
    state._rmDeferredRestoreId = null;
  }
  cancelAllRestoreChains(); // a new restore session supersedes any settling hold
  rmLoopExitGuard();    // close any prior session's guard (its closure is gone)
  state._rmRestoreStartTime = performance.now();
  state._rmNativeTried = false;
  state._rmFramesSinceNative = 0;
  let _rmLastSeenDocH = -1;
  // Stable-degraded counter: when restoreContentAnchor returns false
  // (text-degraded) and the scroller isn't moving, further retries won't help.
  let _rmStableDegraded = 0;
  let _rmLastSeenScrollTop = -1;
  const STABLE_DEGRADED_EXIT = 8;
  const targetFile = (app.workspace.activeLeaf?.view as any)?.file?.path ?? "";

  const enterGuardOnce = rmLoopEnterGuard;
  const exitGuardOnce = rmLoopExitGuard;

  const attempt = () => {
    const mode = (app.workspace.activeLeaf?.view as any)?.getMode?.() ?? "";
    if (mode !== "preview") { state._rmDeferredRestoreId = null; exitGuardOnce(); return; }

    // Abort if the user switched documents during the retry window.
    const curFile = (app.workspace.activeLeaf?.view as any)?.file?.path ?? "";
    if (curFile !== targetFile) {
      state._rmDeferredRestoreId = null;
      state._rmNativeTried = false;
      exitGuardOnce();
      setActiveAnchor(null); setFallbackPct(-1);
      log.info("VIEWPORT deferred-restore aborted: file changed", { targetFile, curFile });
      return;
    }

    const previewEl = getRMPreviewEl(app) as HTMLElement | null;
    if (!previewEl || previewEl.clientHeight === 0) {
      state._rmDeferredRestoreId = requestAnimationFrame(attempt);
      return;
    }

    ensureRMScrollTracking(app);

    if (getActiveAnchor()) {
      const seedAnchor = getActiveAnchor()!; // restoreContentAnchor consumes it on success
      const ok = restoreContentAnchor(app);
      const elapsed = performance.now() - state._rmRestoreStartTime;
      if (!ok && elapsed < RM_RESTORE_TIMEOUT_MS) {
        // Periodically re-push native-scroll so the renderer keeps building
        // DOM toward the target region (cold RM may need multiple pushes).
        state._rmFramesSinceNative++;
        if (state._rmFramesSinceNative >= NATIVE_RETRY_INTERVAL) {
          state._rmNativeTried = false;
          state._rmFramesSinceNative = 0;
        }
        let advanced = false;
        if (!state._rmNativeTried) {
          state._rmNativeTried = true;
          const line = anchorTargetLine(app);
          if (nativeScrollToLine(app, line)) {
            enterGuardOnce();
            advanced = true;
            state._rmDeferredRestoreId = requestAnimationFrame(attempt);
            return;
          }
        }
        if (!advanced && getFallbackPct() >= 0) {
          // Coarse-jump as soon as the height ledger is USABLE, not at the end
          // of the window: during the cold-render ramp docH swings >10% per
          // frame, and jumping on a partial ledger would steer the renderer
          // far from the target region. ±5% frame-over-frame is stable enough;
          // restoreScrollPct itself keeps the pct un-consumed until the write
          // actually lands, so calling every stable frame is self-healing.
          const docH = previewEl.scrollHeight;
          const stable = _rmLastSeenDocH > 0
            && docH >= _rmLastSeenDocH * 0.95 && docH <= _rmLastSeenDocH * 1.05;
          _rmLastSeenDocH = docH;
          if (stable) {
            enterGuardOnce();
            restoreScrollPct(app);
          }
        }
        // Stable-degraded exit: when restoreContentAnchor keeps returning
        // false and the scroller position isn't changing (native-scroll
        // made no progress), further retries won't help. Exit silently.
        const curScrollTop = previewEl.scrollTop;
        if (curScrollTop === _rmLastSeenScrollTop) {
          _rmStableDegraded++;
          if (_rmStableDegraded >= STABLE_DEGRADED_EXIT) {
            setActiveAnchor(null); setFallbackPct(-1);
            state._rmDeferredRestoreId = null;
            state._rmNativeTried = false;
            exitGuardOnce();
            return;
          }
        } else {
          _rmStableDegraded = 0;
          _rmLastSeenScrollTop = curScrollTop;
        }
        state._rmDeferredRestoreId = requestAnimationFrame(attempt);
        return;
      }
      if (ok) {
        // A cold-render restore success is not final: the layout is still
        // settling and the content will slide away under a frozen scrollTop.
        // Hand off to the settle-hold, which re-pins the anchor per frame.
        state._rmDeferredRestoreId = null;
        state._rmNativeTried = false;
        startRMSettleHold(app, seedAnchor); // enters its own guard first…
        exitGuardOnce();                    // …so capture stays suppressed across the handoff
        return;
      }
      // Timeout — clear the anchor.
      state._rmNativeTried = false;
      exitGuardOnce();
      restoreScrollPct(app);
      setFallbackPct(-1); // end of session: drop the pct even if the write failed
    }
    state._rmDeferredRestoreId = null;
    state._rmNativeTried = false;
    exitGuardOnce();

    const anchor = captureContentAnchor(app);
    if (anchor) {
      setRMLastAnchor(anchor, (app.workspace.activeLeaf?.view as any)?.file?.path ?? "");
    } else {
      setRMLastAnchor(null, getRMLastAnchor().file);
    }
    const pct = computeScrollPct(app);
    if (pct >= 0) setLastFallbackPct(pct);
    driveViewportTransition(app, "rm-after-restore");
  };
  // Try synchronously first: at layout-change the incoming view is usually
  // already laid out, so the restore lands before frame 0 paints (no flash).
  // The clientHeight===0 guard inside `attempt` falls back to rAF polling when
  // geometry isn't ready yet (cold RM render / virtualized target region).
  attempt();
}

// ── LP scroll tracking ─────────────────────────────────────────────



export function ensureLPScrollTracking(app: App): void {
  const cm = (app.workspace.activeLeaf?.view as any)?.editor?.cm;
  const sd = cm?.scrollDOM as HTMLElement | null;
  if (!sd) return;
  if (state._lpTrackedEl === sd) return;

  if (state._lpScrollCleanup) {
    state._lpScrollCleanup();
    state._lpScrollCleanup = null;
  }
  state._lpTrackedEl = null;

  const onScroll = () => {
    if (isRestoreGuardActive()) { state._lpSuppressCount++; return; }
    if (isInSilenceWindow()) { state._lpSilenceCount++; return; }
    const anchor = captureContentAnchor(app);
    if (anchor) {
      setLPLastAnchor(anchor, (app.workspace.activeLeaf?.view as any)?.file?.path ?? "");
    } else {
      setLPLastAnchor(null, getLPLastAnchor().file);
    }
    const pct = computeScrollPct(app);
    if (pct >= 0) setLastFallbackPct(pct);
    logScrollCapture("LP", sd, anchor);
  };

  sd.addEventListener("scroll", onScroll, { passive: true });
  state._lpScrollCleanup = () => {
    sd.removeEventListener("scroll", onScroll);
    state._lpScrollCleanup = null;
    state._lpTrackedEl = null;
  };
  state._lpTrackedEl = sd;
}

// ── LP deferred restore ─────────────────────────────────────────────



export function scheduleLPDeferredRestore(app: App): void {
  if (state._lpDeferredRestoreId !== null) {
    cancelAnimationFrame(state._lpDeferredRestoreId);
    state._lpDeferredRestoreId = null;
  }
  const targetFile = (app.workspace.activeLeaf?.view as any)?.file?.path ?? "";
  let _lpNativeTried = false;
  let _lpGuardActive = false;

  const enterGuardOnce = () => {
    if (!_lpGuardActive) { enterRestoreGuard(); _lpGuardActive = true; }
  };
  const exitGuardOnce = () => {
    if (_lpGuardActive) { exitRestoreGuard(); _lpGuardActive = false; }
  };

  const attempt = () => {
    const view = (app.workspace.activeLeaf?.view as any);
    const mode = view?.getMode?.() ?? "";
    if (mode !== "source") { state._lpDeferredRestoreId = null; exitGuardOnce(); return; }

    // Abort if the user switched documents during the retry window.
    const curFile = view?.file?.path ?? "";
    if (curFile !== targetFile) {
      state._lpDeferredRestoreId = null;
      _lpNativeTried = false;
      exitGuardOnce();
      setActiveAnchor(null); setFallbackPct(-1);
      log.info("VIEWPORT deferred-restore aborted: file changed", { targetFile, curFile });
      return;
    }

    const sd = view.editor?.cm?.scrollDOM as HTMLElement | null;
    if (!sd || sd.clientHeight === 0) {
      state._lpDeferredRestoreId = requestAnimationFrame(attempt);
      return;
    }
    state._lpDeferredRestoreId = null;

    ensureLPScrollTracking(app);
    if (getActiveAnchor()) {
      const ok = restoreContentAnchor(app);
      if (!ok) {
        if (!_lpNativeTried) {
          _lpNativeTried = true;
          const line = anchorTargetLine(app);
          if (nativeScrollToLine(app, line)) {
            enterGuardOnce();
            state._lpDeferredRestoreId = requestAnimationFrame(attempt);
            return;
          }
        }
        // LP (CodeMirror) is not virtualized — lineBlockAt resolves any line
        // regardless of scroll, so a native-scroll failure is terminal. Clear
        // the anchor so it can't linger and hijack a later restore.
        setActiveAnchor(null); setFallbackPct(-1);
      }
    } else if (getFallbackPct() >= 0) {
      enterGuardOnce();
      restoreScrollPct(app);
      // LP's height map is authoritative from frame one — a failed write means
      // "unscrollable", never "not yet". Drop the pct to preserve one-shot
      // semantics (no stale pct hijacking a later restore).
      setFallbackPct(-1);
    }
    _lpNativeTried = false;
    exitGuardOnce();

    // Guard the post-restore anchor capture: a scroll event from the restore
    // write may still be queued and would overwrite _lpLastAnchor with wrong
    // text if it fires after us. Suppress scroll-capture for 50ms so any
    // queued event lands inside the guard window.
    enterRestoreGuard();
    const anchor = captureContentAnchor(app);
    if (anchor) {
      setLPLastAnchor(anchor, view?.file?.path ?? "");
    } else {
      setLPLastAnchor(null, getLPLastAnchor().file);
    }
    setTimeout(() => exitRestoreGuard(), 50);
    const pct = computeScrollPct(app);
    if (pct >= 0) setLastFallbackPct(pct);
    driveViewportTransition(app, "lp-after-restore");
  };
  // Try synchronously first (see scheduleRMDeferredRestore): LP's CodeMirror is
  // laid out at layout-change time and not virtualized, so the restore lands
  // before frame 0 paints. The clientHeight===0 guard keeps the rAF fallback.
  attempt();
}

// ── View mode change driver ─────────────────────────────────────────

/** DIAGNOSTIC (mode-switch flicker): sample the active scroller's scrollTop
 *  over consecutive animation frames to trace the per-frame timeline of the
 *  switch — frame 0 (synchronous) is the incoming view's native-retained
 *  position; the visible flash is the frame where our deferred anchor-restore
 *  snaps scrollTop to the target. docH/viewportH expose whether the geometry is
 *  even settled yet. Remove once the flicker fix lands. */


export function probeSwitchScroll(app: App, framesLeft: number, total: number): void {
  const view = app.workspace.activeLeaf?.view as any;
  const mode = view?.getMode?.() ?? "";
  let scroller: HTMLElement | null = null;
  if (mode === "preview") scroller = getRMPreviewEl(app);
  else if (mode === "source") scroller = (view?.editor?.cm?.scrollDOM ?? null) as HTMLElement | null;
  if (scroller) {
    log.debug("SWITCH probe", {
      mode,
      frame: total - framesLeft,
      scrollTop: Math.round(scroller.scrollTop),
      docH: scroller.scrollHeight,
      viewportH: scroller.clientHeight,
    });
  }
  if (framesLeft > 1) requestAnimationFrame(() => probeSwitchScroll(app, framesLeft - 1, total));
}

// ── Early mode-switch restore (Approach X) + Step-3.1 ordering probe ──
// Monkeypatches MarkdownView.setState — the unified API entry every RM↔LP
// switch funnels through, which the Step-3.1 diagnosis proved runs BEFORE the
// incoming view's first native paint (frame N). We schedule a rAF that polls
// until the incoming scroller is laid out (frame N) and writes scrollTop to the
// anchor target IN THAT FRAME, before it paints — so the incoming content's
// first visible frame is already aligned (no native-position flash). The
// layout-change path in onViewModeChange stays intact as an idempotent safety
// net. The `SWITCH setState-*` logging is kept during Phase 1 for verification.



