import { App } from "obsidian";
import { logger } from "../logger";



import { activeMarkdownView, assertNever } from "../utils";
import { getRMPreviewEl } from "../scrollSync/domLocators";

import { ViewportAnchor, getActiveAnchor, setActiveAnchor, getFallbackPct, setFallbackPct, setLastFallbackPct, setRMLastAnchor, getRMLastAnchor, setLPLastAnchor, getLPLastAnchor, state, RM_RESTORE_TIMEOUT_MS, NATIVE_RETRY_INTERVAL, RM_EMBED_WAIT_MS, RM_HOLD_TIMEOUT_MS, RM_HOLD_CALM_FRAMES, rmLoopEnterGuard, cancelAllRestoreChains, rmLoopExitGuard, enterRestoreGuard, exitRestoreGuard, isRestoreGuardActive, isInSilenceWindow } from "./anchorStore";
import { runRestoreLoop } from "./anchorRestoreSession";
import { whenEmbedPresent } from "./anchorSignals";

const log = logger.channel("scrollAnchor");


import { computeScrollPct, captureContentAnchor, anchorTargetLine } from "./anchorCapture";

import { restoreContentAnchor, nativeScrollToLine, restoreScrollPct } from "./anchorRestore";

import { driveViewportTransition } from "./anchorModeSwitch";
import { editorCmOf, viewInternals } from "../obsidianInternals";

// ── anchorTracking (extracted from scrollAnchor.ts in P3 split) ──

export function logScrollCapture(side: "RM" | "LP", el: HTMLElement, anchor: ViewportAnchor | null): void {
  const now = Date.now();
  if (now - state._lastScrollLogTs < 150) return;
  state._lastScrollLogTs = now;
  const info: Record<string, unknown> = { scrollTop: Math.round(el.scrollTop), kind: anchor?.kind ?? "none" };
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
      .map(s => { const e = document.querySelector(s); return e ? `${s}=${Math.round(e.scrollTop)}` : `${s}=n/a`; })
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
  const previewEl = getRMPreviewEl(app);
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
      setRMLastAnchor(anchor, activeMarkdownView(app)?.file?.path ?? "");
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
  const view = activeMarkdownView(app);
  const file = view?.file?.path ?? "";
  let hookedEl = getRMPreviewEl(app);
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
    const v = activeMarkdownView(app);
    if ((v?.getMode?.() ?? "") !== "preview" || (v?.file?.path ?? "") !== file) {
      finish("view-changed", false);
      return;
    }
    if (userInterrupted) {
      finish("user-input", false);
      return;
    }
    const el = getRMPreviewEl(app);
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
        state._rmHoldId = window.requestAnimationFrame(tick);
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
    state._rmHoldId = window.requestAnimationFrame(tick);
  };
  log.debug("VIEWPORT settle-hold start", {
    scrollTop: Math.round(lastTop), docH: lastDocH,
  });
  state._rmHoldId = window.requestAnimationFrame(tick);
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
  const targetFile = activeMarkdownView(app)?.file?.path ?? "";

  const enterGuardOnce = rmLoopEnterGuard;
  const exitGuardOnce = rmLoopExitGuard;

  // P4-B: the per-frame `attempt` body is now `onFrame`; runRestoreLoop owns the
  // rAF id slot and the synchronous-first-frame behavior. "continue" reschedules,
  // "stop" halts (clears the slot) — identical to the old terminal returns.
  // P4-C2: onFrame is now async so the cold-render retry can `await` the real
  // "embed appeared" signal (image anchors) instead of blindly re-pushing native
  // every NATIVE_RETRY_INTERVAL frames. runRestoreLoop (C1) handles a Promise
  // return; the synchronous head of the first frame still runs before paint.
  runRestoreLoop({
    getId: () => state._rmDeferredRestoreId,
    setId: (id) => { state._rmDeferredRestoreId = id; },
    firstFrameSync: true,
    onFrame: async () => {
      const mode = activeMarkdownView(app)?.getMode?.() ?? "";
      if (mode !== "preview") { exitGuardOnce(); return "stop"; }

      // Abort if the user switched documents during the retry window.
      const curFile = activeMarkdownView(app)?.file?.path ?? "";
      if (curFile !== targetFile) {
        state._rmNativeTried = false;
        exitGuardOnce();
        setActiveAnchor(null); setFallbackPct(-1);
        log.info("VIEWPORT deferred-restore aborted: file changed", { targetFile, curFile });
        return "stop";
      }

      const previewEl = getRMPreviewEl(app);
      if (!previewEl || previewEl.clientHeight === 0) {
        return "continue";
      }

      ensureRMScrollTracking(app);

      if (getActiveAnchor()) {
        const seedAnchor = getActiveAnchor()!; // restoreContentAnchor consumes it on success
        const ok = restoreContentAnchor(app);
        const elapsed = performance.now() - state._rmRestoreStartTime;
        if (!ok && elapsed < RM_RESTORE_TIMEOUT_MS) {
          // Image anchors have a real DOM signal — the `.internal-embed` row for
          // the target line — so C2 waits for that instead of a frame counter.
          // Text anchors have no such element, so they keep the frame-count
          // re-push cadence unchanged.
          const anchorIsImage =
            seedAnchor.kind === "image-row" || seedAnchor.kind === "image-gap";

          // Periodically re-push native-scroll so the renderer keeps building
          // DOM toward the target region (cold RM may need multiple pushes).
          // (text anchors only — image anchors gate re-push on whenEmbedPresent)
          if (!anchorIsImage) {
            state._rmFramesSinceNative++;
            if (state._rmFramesSinceNative >= NATIVE_RETRY_INTERVAL) {
              state._rmNativeTried = false;
              state._rmFramesSinceNative = 0;
            }
          }
          let advanced = false;
          if (!state._rmNativeTried) {
            state._rmNativeTried = true;
            const line = anchorTargetLine(app);
            if (nativeScrollToLine(app, line)) {
              enterGuardOnce();
              advanced = true;
              if (anchorIsImage) {
                // P4-C2: await the real "renderer built the target embed" signal
                // instead of re-pushing native blindly every N frames. On timeout
                // (embed never appeared) re-arm the native push for next cycle.
                const appeared = await whenEmbedPresent(previewEl, line, {
                  timeoutMs: RM_EMBED_WAIT_MS,
                });
                if (!appeared) state._rmNativeTried = false;
              }
              return "continue";
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
              state._rmNativeTried = false;
              exitGuardOnce();
              return "stop";
            }
          } else {
            _rmStableDegraded = 0;
            _rmLastSeenScrollTop = curScrollTop;
          }
          return "continue";
        }
        if (ok) {
          // A cold-render restore success is not final: the layout is still
          // settling and the content will slide away under a frozen scrollTop.
          // Hand off to the settle-hold, which re-pins the anchor per frame.
          state._rmNativeTried = false;
          startRMSettleHold(app, seedAnchor); // enters its own guard first…
          exitGuardOnce();                    // …so capture stays suppressed across the handoff
          return "stop";
        }
        // Timeout — clear the anchor.
        state._rmNativeTried = false;
        exitGuardOnce();
        restoreScrollPct(app);
        setFallbackPct(-1); // end of session: drop the pct even if the write failed
      }
      state._rmNativeTried = false;
      exitGuardOnce();

      const anchor = captureContentAnchor(app);
      if (anchor) {
        setRMLastAnchor(anchor, activeMarkdownView(app)?.file?.path ?? "");
      } else {
        setRMLastAnchor(null, getRMLastAnchor().file);
      }
      const pct = computeScrollPct(app);
      if (pct >= 0) setLastFallbackPct(pct);
      driveViewportTransition(app, "rm-after-restore");
      return "stop";
    },
  });
}

// ── LP scroll tracking ─────────────────────────────────────────────



export function ensureLPScrollTracking(app: App): void {
  const cm = editorCmOf(activeMarkdownView(app));
  const sd = cm?.scrollDOM;
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
      setLPLastAnchor(anchor, activeMarkdownView(app)?.file?.path ?? "");
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
  const targetFile = activeMarkdownView(app)?.file?.path ?? "";
  let _lpNativeTried = false;
  let _lpGuardActive = false;

  const enterGuardOnce = () => {
    if (!_lpGuardActive) { enterRestoreGuard(); _lpGuardActive = true; }
  };
  const exitGuardOnce = () => {
    if (_lpGuardActive) { exitRestoreGuard(); _lpGuardActive = false; }
  };

  // P4-B: see scheduleRMDeferredRestore — runRestoreLoop owns the rAF id slot.
  // P4-C2: intentionally NOT converted to async signals. Unlike cold RM, the LP
  // (CodeMirror) height map is authoritative from frame one and is not
  // virtualized — lineBlockAt resolves any line regardless of scroll, so there
  // is no "wait for the renderer to build the target embed" phase and no
  // frame-count / magic-timeout polling to replace. The single post-native
  // `continue` is a legitimate one-frame settle, and a native-scroll failure is
  // terminal by design. Adding await here would only add latency and risk.
  runRestoreLoop({
    getId: () => state._lpDeferredRestoreId,
    setId: (id) => { state._lpDeferredRestoreId = id; },
    firstFrameSync: true,
    onFrame: () => {
      const view = viewInternals(activeMarkdownView(app));
      const mode = view?.getMode?.() ?? "";
      if (mode !== "source") { exitGuardOnce(); return "stop"; }

      // Abort if the user switched documents during the retry window.
      const curFile = view?.file?.path ?? "";
      if (curFile !== targetFile) {
        _lpNativeTried = false;
        exitGuardOnce();
        setActiveAnchor(null); setFallbackPct(-1);
        log.info("VIEWPORT deferred-restore aborted: file changed", { targetFile, curFile });
        return "stop";
      }

      const sd = view?.editor?.cm?.scrollDOM;
      if (!sd || sd.clientHeight === 0) {
        return "continue";
      }
      ensureLPScrollTracking(app);
      if (getActiveAnchor()) {
        const ok = restoreContentAnchor(app);
        if (!ok) {
          if (!_lpNativeTried) {
            _lpNativeTried = true;
            const line = anchorTargetLine(app);
            if (nativeScrollToLine(app, line)) {
              enterGuardOnce();
              return "continue";
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
      window.setTimeout(() => exitRestoreGuard(), 50);
      const pct = computeScrollPct(app);
      if (pct >= 0) setLastFallbackPct(pct);
      driveViewportTransition(app, "lp-after-restore");
      return "stop";
    },
  });
}

// ── View mode change driver ─────────────────────────────────────────

/** DIAGNOSTIC (mode-switch flicker): sample the active scroller's scrollTop
 *  over consecutive animation frames to trace the per-frame timeline of the
 *  switch — frame 0 (synchronous) is the incoming view's native-retained
 *  position; the visible flash is the frame where our deferred anchor-restore
 *  snaps scrollTop to the target. docH/viewportH expose whether the geometry is
 *  even settled yet. Remove once the flicker fix lands. */


export function probeSwitchScroll(app: App, framesLeft: number, total: number): void {
  const view = activeMarkdownView(app);
  const mode = view?.getMode?.() ?? "";
  let scroller: HTMLElement | null = null;
  if (mode === "preview") scroller = getRMPreviewEl(app);
  else if (mode === "source") scroller = editorCmOf(view)?.scrollDOM ?? null;
  if (scroller) {
    log.debug("SWITCH probe", {
      mode,
      frame: total - framesLeft,
      scrollTop: Math.round(scroller.scrollTop),
      docH: scroller.scrollHeight,
      viewportH: scroller.clientHeight,
    });
  }
  if (framesLeft > 1) window.requestAnimationFrame(() => probeSwitchScroll(app, framesLeft - 1, total));
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



