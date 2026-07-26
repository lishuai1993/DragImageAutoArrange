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

import {
  logScrollCapture,
  ensureRMScrollTracking,
  startRMSettleHold,
  scheduleRMDeferredRestore,
  ensureLPScrollTracking,
  scheduleLPDeferredRestore,
  probeSwitchScroll,
} from "./anchorTracking";

// ── anchorModeSwitch (extracted from scrollAnchor.ts in P3 split) ──

export function incomingScrollerOf(view: any, mode: string): HTMLElement | null {
  if (mode === "source") return (view?.editor?.cm?.scrollDOM ?? null) as HTMLElement | null;
  if (mode === "preview") {
    const c = (view?.contentEl ?? view?.containerEl) as HTMLElement | undefined;
    return queryPreviewViewIn(c);
  }
  return null;
}

/** Re-seed the (consume-on-success) active anchor from the captured seed, then
 *  restore. Used for both the frame-N write and the RM hold re-asserts. */


export function applyEarly(app: App, seedAnchor: ViewportAnchor, seedPct: number): boolean {
  setActiveAnchor(seedAnchor);
  if (seedPct >= 0) setFallbackPct(seedPct);
  return restoreContentAnchor(app);
}

/** Re-assert the RM restore for a few frames so the preview's one-frame scroll
 *  revert can't leave a visible dip before the layout-change safety net lands. */


export function scheduleRMHold(
  app: App, file: string, seedAnchor: ViewportAnchor, seedPct: number, holdFrames: number
): void {
  cancelRMHoldChain();
  const start = performance.now();
  const hold = () => {
    state._rmHoldChainId = null;
    const view = app.workspace.activeLeaf?.view as any;
    if ((view?.getMode?.() ?? "") !== "preview") return; // switched away
    if ((view?.file?.path ?? "") !== file) return;       // file changed
    // Skip frames where the RM preview DOM has no content yet
    // (post-processor may be mid-flight). Don't count these
    // against the fixed hold budget.
    const previewEl = getRMPreviewEl(app) as HTMLElement | null;
    const hasContent = previewEl && previewEl.scrollHeight > previewEl.clientHeight + 100;
    if (!hasContent && performance.now() - start < 5000) {
      state._rmHoldChainId = requestAnimationFrame(hold);
      return;
    }
    const before = previewEl?.scrollTop ?? -1;
    applyEarly(app, seedAnchor, seedPct);                // override the preview revert
    if (--holdFrames > 0) {
      // If scrollTop didn't change after the assertion, the revert either
      // didn't happen or was already corrected — no need for further holds.
      const after = (getRMPreviewEl(app) as HTMLElement | null)?.scrollTop ?? -2;
      if (after === before) return;
      state._rmHoldChainId = requestAnimationFrame(hold);
    }
  };
  state._rmHoldChainId = requestAnimationFrame(hold);
}

/** RM→LP (source) early restore, invoked in the Promise microtask after setState
 *  resolves. CM is non-virtualized — its scrollDOM is mounted when setState
 *  resolves. CM auto-restores its own stale scroll position on mount (from the
 *  last time LP was visible), which may be hundreds of px away from where the
 *  user is currently reading. We must overwrite it BEFORE the browser composites
 *  the frame, otherwise the user sees a flash of the wrong position.
 *
 *  Strategy: write on the very first rAF where CM's scrollDOM has a non-zero
 *  clientHeight. No docH-stability wait — delaying the write just lets the stale
 *  position linger on screen longer, making the correction jump more visible.
 *  After the write, set state._lpEarlyRestoreDone so handleModeSwitch won't re-seed
 *  from the RM slot; don't re-seed the anchor so the deferred restore won't
 *  issue a redundant second write. On cold CM where the anchor can't resolve,
 *  fall back to native line scroll + one rAF retry. */


export function scheduleEarlyRestoreLP(app: App, fromMode: string, file: string): void {
  state._lpEarlyRestoreDone = false;
  state._rmEarlyRestoreDone = false;
  const src = getRMLastAnchor();
  if (!(src.file === file && src.anchor)) return;
  const seedAnchor = src.anchor;
  const seedPct = getLastFallbackPct();

  // Short-circuit: RM scrollTop was at or near the document top. No text
  // matching needed — the user was at the top in RM, they belong at the top
  // in LP. Text matching can mis-map a common first-heading phrase to a
  // later occurrence (e.g. TOC entry), producing a large downward offset.
  if (seedPct >= 0 && seedPct <= 0.02) {
    state._lpEarlyRestoreDone = true;
    const sd = (app.workspace.activeLeaf?.view as any)?.editor?.cm?.scrollDOM as HTMLElement | null;
    if (sd && sd.clientHeight > 0) {
      sd.scrollTop = 0;
      log.info("VIEWPORT anchor-restored", { mode: "source", kind: "top-shortcut", targetY: 0 });
    }
    return;
  }

  if (state._earlyRestoreId !== null) {
    cancelAnimationFrame(state._earlyRestoreId);
    state._earlyRestoreId = null;
  }

  let frames = 4;
  let nativeTried = false;
  let guardActive = false;
  // ── Structural improvement C: hard exit after consecutive degraded frames ──
  // When applyEarly falls to text-degraded (which returns false by design),
  // the poll must not retry indefinitely — each retry writes scrollTop to the
  // same position, creating visible flicker without making progress. After 5
  // consecutive degraded frames (~80ms), accept the degraded position and stop.
  let degradedFrames = 0;
  const DEGRADED_EXIT = 5;

  const exitGuardIfNeeded = () => {
    if (guardActive) { exitRestoreGuard(); guardActive = false; }
  };

  const poll = () => {
    state._earlyRestoreId = null;
    const view = app.workspace.activeLeaf?.view as any;
    if ((view?.getMode?.() ?? "") !== "source") { state._lpEarlyRestoreDone = true; exitGuardIfNeeded(); return; }
    if ((view?.file?.path ?? "") !== file) { state._lpEarlyRestoreDone = true; exitGuardIfNeeded(); return; }
    const sc = view?.editor?.cm?.scrollDOM as HTMLElement | null;
    if (!sc || sc.clientHeight === 0) {
      if (--frames > 0) { state._earlyRestoreId = requestAnimationFrame(poll); }
      else { state._lpEarlyRestoreDone = true; }
      return;
    }
    // Suppress scroll events during early restore so the stale CM auto-scroll
    // (and scroll events from our forced write) cannot pollute _lpLastAnchor
    // with wrong-position text. Enter once, exit once when the poll settles.
    if (!guardActive) {
      enterRestoreGuard();
      guardActive = true;
    }
    let ok = applyEarly(app, seedAnchor, seedPct);
    // Hard-exit gate C: too many consecutive degraded frames → accept and stop.
    if (!ok) {
      degradedFrames++;
      if (degradedFrames >= DEGRADED_EXIT) {
        state._lpEarlyRestoreDone = true;
        exitGuardIfNeeded();
        return;
      }
    } else {
      degradedFrames = 0;
    }
    // Multi-anchor fallback: if the primary anchor can't resolve (fragment
    // is ambiguous and spatial priors are insufficient to disambiguate),
    // try each sibling anchor captured from the same RM viewport — one of
    // them may have a more unique fragment or stronger priors.
    if (!ok && seedAnchor.kind === 'text') {
      const list = getRMLastAnchorList();
      if (list.file === file && list.anchors.length > 1) {
        for (const sibling of list.anchors) {
          if (sibling.kind !== 'text') continue;
          if (sibling.anchorText === seedAnchor.anchorText) continue;
          if (applyEarly(app, sibling, seedPct)) {
            ok = true;
            degradedFrames = 0;
            log.info('VIEWPORT anchor-fallback', {
              from: seedAnchor.anchorText.slice(0, 20),
              to: sibling.anchorText.slice(0, 20),
            });
            break;
          }
        }
      }
    }
    if (!ok && !nativeTried) {
      nativeTried = true;
      const line = anchorTargetLine(app);
      if (nativeScrollToLine(app, line)) {
        if (--frames > 0) { state._earlyRestoreId = requestAnimationFrame(poll); }
        else { state._lpEarlyRestoreDone = true; exitGuardIfNeeded(); }
        return;
      }
    }
    state._lpEarlyRestoreDone = true;
    exitGuardIfNeeded();
    // Don't re-seed: we want the deferred restore to be a no-op (no active
    // anchor) so it won't issue a second write that looks like jitter.

    // ── Phase-2 refinement ─────────────────────────────────────────
    // CM's height map continues to build for ~100ms after display:none→visible.
    // The early write above used lb.top values that may be based on estimated
    // line heights. Schedule a deferred cross-check: once the height map
    // settles, re-compute targetY and correct the scroll position if the
    // line's block-top has shifted.
    if (ok && seedAnchor.kind === "text") {
      const saved = seedAnchor;
      setTimeout(() => {
        try {
          const v = app.workspace.activeLeaf?.view as any;
          if ((v?.getMode?.() ?? "") !== "source") return;
          if ((v?.file?.path ?? "") !== file) return;
          const cm = v?.editor?.cm;
          const sd = cm?.scrollDOM as HTMLElement | null;
          if (!sd || sd.clientHeight === 0) return;
          const line = findBestTextLine(cm, saved, file);
          if (line > 0) {
            const lb = lineBlockByNumber(cm, asLine1(line));
            const inset = lpInset(cm, sd);
            const refined = textTargetY(lb.top, inset, saved.anchorOffset);
            const drift = refined - sd.scrollTop;
            if (Math.abs(drift) > 15) {
              sd.scrollTop = refined;
              log.info("VIEWPORT lp-refined", {
                line, drift: Math.round(drift),
                capturedOffset: Math.round(saved.anchorOffset),
              });
            }
          }
        } catch { /* refinement must never throw */ }
      }, 100);
    }
  };

  state._earlyRestoreId = requestAnimationFrame(poll);
}

/** Seed the active anchor from the OUTGOING mode's slot (same source as
 *  handleModeSwitch, with the same file guard), then poll rAF until the incoming
 *  view is laid out (frame N) and restore in that pre-paint frame. On RM-incoming
 *  switches, follow with a short hold loop (the RM preview reverts a single write;
 *  CM does not). Bails (letting the layout-change safety net take over) if there's
 *  nothing to restore or the geometry never settles within EARLY_RESTORE_MAX_FRAMES.
 *  Used for LP→RM only; RM→LP uses the Promise-chained scheduleEarlyRestoreLP. */


export function scheduleEarlyRestore(app: App, fromMode: string, toMode: string, file: string): void {
  state._lpEarlyRestoreDone = false; // reset for this new transition
  state._rmEarlyRestoreDone = false;
  const src = fromMode === "preview" ? getRMLastAnchor() : getLPLastAnchor();
  if (!(src.file === file && src.anchor)) return; // nothing to restore early
  const seedAnchor = src.anchor;
  const seedPct = getLastFallbackPct();

  // Cancel any previous early restore before starting a new one.
  if (state._earlyRestoreId !== null) {
    cancelAnimationFrame(state._earlyRestoreId);
    state._earlyRestoreId = null;
  }

  let frames = EARLY_RESTORE_MAX_FRAMES;
  let nativeTried = false;
  let guardActive = false;
  // ── Structural improvement C: hard exit after consecutive degraded frames ──
  let degradedFrames = 0;
  const DEGRADED_EXIT = 5;

  const exitGuardIfNeeded = () => {
    if (guardActive) { exitRestoreGuard(); guardActive = false; }
  };

  const poll = () => {
    state._earlyRestoreId = null;
    const view = app.workspace.activeLeaf?.view as any;
    if ((view?.getMode?.() ?? "") !== toMode) { state._rmEarlyRestoreDone = true; exitGuardIfNeeded(); return; }
    if ((view?.file?.path ?? "") !== file) { state._rmEarlyRestoreDone = true; exitGuardIfNeeded(); return; }
    const sc = incomingScrollerOf(view, toMode);
    if (!sc || sc.clientHeight === 0) {
      if (--frames > 0) { state._earlyRestoreId = requestAnimationFrame(poll); }
      else { state._rmEarlyRestoreDone = true; }
      return;
    }
    // Suppress scroll events during early restore so the forced write (and any
    // stale scroller auto-restore) cannot pollute the incoming mode's anchor slot.
    if (!guardActive) {
      enterRestoreGuard();
      guardActive = true;
    }
    // frame N, pre-paint: try precise pixel restore first (cached views).
    // On cold RM render the target embeds may not exist yet — fall back to
    // native line-based scroll to force the renderer to build DOM around the
    // target, then retry. If even that fails, let layout-change handle it.
    let ok = applyEarly(app, seedAnchor, seedPct);
    // Hard-exit gate C: too many consecutive degraded frames → accept and stop.
    if (!ok) {
      degradedFrames++;
      if (degradedFrames >= DEGRADED_EXIT) {
        state._rmEarlyRestoreDone = true;
        exitGuardIfNeeded();
        return;
      }
    } else {
      degradedFrames = 0;
    }
    // Multi-anchor fallback: if the primary anchor can't resolve (fragment
    // is ambiguous and spatial priors are insufficient to disambiguate),
    // try each sibling anchor captured from the same RM viewport — one of
    // them may have a more unique fragment or stronger priors.
    if (!ok && seedAnchor.kind === 'text') {
      const list = getRMLastAnchorList();
      if (list.file === file && list.anchors.length > 1) {
        for (const sibling of list.anchors) {
          if (sibling.kind !== 'text') continue;
          if (sibling.anchorText === seedAnchor.anchorText) continue;
          if (applyEarly(app, sibling, seedPct)) {
            ok = true;
            degradedFrames = 0;
            log.info('VIEWPORT anchor-fallback', {
              from: seedAnchor.anchorText.slice(0, 20),
              to: sibling.anchorText.slice(0, 20),
            });
            break;
          }
        }
      }
    }
    if (!ok && !nativeTried) {
      nativeTried = true;
      const line = anchorTargetLine(app);
      if (nativeScrollToLine(app, line)) {
        if (--frames > 0) { state._earlyRestoreId = requestAnimationFrame(poll); }
        else { state._rmEarlyRestoreDone = true; exitGuardIfNeeded(); }
        return;
      }
    }
    state._rmEarlyRestoreDone = true;
    exitGuardIfNeeded();
    if (toMode === "preview") scheduleRMHold(app, file, seedAnchor, seedPct, RM_EARLY_HOLD_FRAMES);
  };
  state._earlyRestoreId = requestAnimationFrame(poll);
}

/** Install the early-restore hook (Phase 1). Returns an un-patch function; pass
 *  it to `Plugin.register` so it's removed on unload. */


export function installEarlyModeSwitchRestore(app: App): () => void {
  const proto = MarkdownView.prototype as any;
  const original = proto.setState as (state: any, result: any) => Promise<void>;

  proto.setState = function (this: any, state: any, result: any): Promise<void> {
    let isSwitch = false, fromMode = "", toMode = "", file = "";
    try {
      fromMode = this?.getMode?.() ?? "";
      toMode = state?.mode ?? "";
      file = this?.file?.path ?? "";
      isSwitch = !!(fromMode && toMode && fromMode !== toMode
        && (toMode === "source" || toMode === "preview") && file);

      // Step-3.1 verification logging (kept through Phase 1).
      const inc = incomingScrollerOf(this, toMode);
      log.debug("SWITCH setState-enter", {
        t: Math.round(performance.now()),
        from: fromMode || "?", to: toMode || "?", file, isSwitch,
        incomingBuilt: !!inc, clientH: inc?.clientHeight ?? -1,
        scrollTop: inc ? Math.round(inc.scrollTop) : -1,
      });

      // ── RM DOM bloat diagnosis ──────────────────────────────────────
      // Hypothesis: RM preview DOM retains <img>/<embed> across switches,
      // and the accumulated nodes slow down CM's full-document layout when
      // it becomes visible (RM→LP).  Capture outgoing RM DOM stats for
      // correlation with the CM mount latency logged in setState-raf.
      if (isSwitch && fromMode === "preview") {
        try {
          const outgoingEl = (this?.contentEl ?? this?.containerEl) as HTMLElement | undefined;
          const rmView = queryPreviewViewIn(outgoingEl);
          if (rmView) {
            const all = rmView.querySelectorAll("*");
            const imgs = rmView.querySelectorAll("img");
            const embeds = rmView.querySelectorAll("embed, iframe, .internal-embed, .image-embed");
            const totalNodes = rmView.getElementsByTagName?.("*")?.length ?? all.length;
            log.info("RM-DOM-STATS", {
              file,
              totalNodes,
              imgCount: imgs.length,
              embedCount: embeds.length,
              scrollHeight: Math.round(rmView.scrollHeight),
              clientHeight: Math.round(rmView.clientHeight),
              // ratio > 1 means virtualized content is loaded
              virtualRatio: Math.round(rmView.scrollHeight / Math.max(1, rmView.clientHeight)),
            });
          }
        } catch { /* diagnostic must never throw */ }
      }
      const self = this;
      requestAnimationFrame(() => {
        try {
          const nowMode = self?.getMode?.() ?? "?";
          const sc = incomingScrollerOf(self, nowMode);
          log.debug("SWITCH setState-raf", {
            t: Math.round(performance.now()), mode: nowMode,
            clientH: sc?.clientHeight ?? -1,
            scrollTop: sc ? Math.round(sc.scrollTop) : -1,
          });
        } catch { /* diagnostic must never throw */ }
      });
    } catch { /* diagnostic must never throw */ }

    const ret = original.call(this, state, result);
    if (isSwitch) {
      if (toMode === "source") {
        // RM→LP: CM is non-virtualized, scrollDOM is ready when setState resolves.
        // Use .then() microtask to skip the rAF wait (up to 16ms) and restore
        // before the height-map reconstruction tail grows (24→354ms with images).
        ret.then(() => {
          try { scheduleEarlyRestoreLP(app, fromMode, file); } catch { /* never break setState */ }
        });
      } else {
        // LP→RM: RM preview is virtualized, keep rAF polling.
        try { scheduleEarlyRestore(app, fromMode, toMode, file); } catch { /* never break setState */ }
      }
    }
    // Defend against spurious internal setState that re-renders the RM preview
    // from scratch, discarding our restored scroll position. Obsidian fires these
    // with mode="preview" but no file (isSwitch=false) during post-switch re-layout.
    // Snapshot the current RM scrollTop; if the reset drops it to 0, re-apply.
    if (!isSwitch && toMode === "preview") {
      const sc = incomingScrollerOf(this, "preview");
      const saved = sc?.scrollTop ?? 0;

      const rmAnchor = getRMLastAnchor().anchor;
      // Defend when scrollTop > 0 (normal snapshot), or when we have a
      // stored anchor whose scrollTop was already trashed to 0 by
      // concurrent DOM disruption (e.g. post-processor widget destroy).
      if (saved > 0 || rmAnchor) {
        ret.then(() => {
          requestAnimationFrame(() => {
            const sc2 = incomingScrollerOf(this, "preview");
            if (sc2 && sc2.scrollTop === 0 && sc2.scrollHeight > sc2.clientHeight) {
              if (saved > 0) {
                sc2.scrollTop = saved;
              } else if (rmAnchor) {
                setActiveAnchor(rmAnchor);
                restoreContentAnchor(app);
              }
              log.debug("SWITCH spurious-reset defended", { saved, hadAnchor: !!rmAnchor });
            }
          });
        });
      }
    }
    return ret;
  };

  return () => { proto.setState = original; };
}


/** Drive cross-mode scroll restore on view mode switches (RM ↔ LP).
 *  Called from main.ts on layout-change. driveViewportTransition performs the
 *  edge-triggered mode-switch detection (RM→LP flush + anchor seed); we then
 *  schedule a deferred restore for whichever mode we switched INTO. The RM
 *  reading view is often cached, so its post-processor afterRender may not
 *  re-run — scheduleRMDeferredRestore guarantees the restore fires anyway. */


export function onViewModeChange(app: App): void {
  cancelAllRestoreChains(); // kill any pending RM restore chains from prior switches
  const wasNotLP = getLastMode() !== "source";
  const wasNotRM = getLastMode() !== "preview";
  probeSwitchScroll(app, 10, 10); // DIAGNOSTIC: trace native→restore scroll timeline
  driveViewportTransition(app, "layout-change");
  const mode = (app.workspace.activeLeaf?.view as any)?.getMode?.() ?? "";
  if (mode === "source") {
    ensureLPScrollTracking(app);
    if (wasNotLP) scheduleLPDeferredRestore(app);
  } else if (mode === "preview") {
    if (wasNotRM) scheduleRMDeferredRestore(app);
  }
}

// ── Viewport diagnostic logging ────────────────────────────────────

/** Flatten an anchor into log fields, handling all three anchor kinds. */


export function anchorLogFields(a: ViewportAnchor): Record<string, any> {
  switch (a.kind) {
    case "image-row":
      return { kind: a.kind, imageRowIndex: a.imageRowIndex, ratio: Math.round(a.intraRowRatio * 100) };
    case "image-gap":
      return { kind: a.kind, imgBefore: a.imgBefore, imgAfter: a.imgAfter, ratio: Math.round(a.gapRatio * 100) };
    case "text":
      return {
        kind: a.kind, frag: a.anchorText.slice(0, 30), offset: Math.round(a.anchorOffset),
        nearestBefore: a.nearestImgBefore, nearestAfter: a.nearestImgAfter,
        docRatio: Math.round(a.docRatio * 100),
        ...(a.anchorLine && a.anchorLine > 0 ? { line: a.anchorLine } : {}),
        ...(a.anchorContext ? { ctx: a.anchorContext.slice(0, 60) } : {}),
        ...(a.headingHint ? { hdg: a.headingHint.slice(0, 30) } : {}),
      };
    default:
      return assertNever(a);
  }
}



export function handleModeSwitch(app: App, mode: string, file: string, trigger: string): void {
  const lastMode = getLastMode();
  if (!(lastMode && lastMode !== mode)) return;

  const newDocH = computeDocH(app, mode);
  log.info("VIEWPORT mode-switch", {
    from: lastMode, to: mode, trigger, file,
    oldDocH: getLastDocH(), newDocH,
    docHRatio: getLastDocH() > 0 && newDocH > 0 ? Math.round(newDocH / getLastDocH() * 100) : 0,
  });
  // Flush buffered RM alignment changes on RM→LP switch so the LP
  // editor picks up the updated markdown before scroll is restored.
  if (lastMode === "preview" && mode === "source") {
    const pendingCount = getPendingAlignmentCount();
    log.info("ALIGN flush trigger: RM→LP switch", { pendingCount });
    const modified = flushPendingAlignments(app);
    log.info("ALIGN flush done", { modifiedFiles: [...modified], remaining: getPendingAlignmentCount() });
    for (const path of modified) invalidateImageRowIndex(path);
    // Immediately rebuild the index for the current file so the deferred
    // restore (which fires next) can use image-row-based disambiguation
    // instead of falling back to the unreliable cross-mode docRatio.
    if (modified.has(file)) ensureImageRowIndexFromCM(app);
  }
  // Seed the restore anchor from the OUTGOING mode's slot, so the
  // incoming view's stale-scroll noise can't hijack it.
  // When the early restore (from setState) has already handled this
  // transition, skip re-seeding to avoid a redundant second restore
  // from the deferred-restore path.
  if (lastMode === "preview" && mode === "source" && state._lpEarlyRestoreDone) {
    state._lpEarlyRestoreDone = false;
  } else if (lastMode === "source" && mode === "preview" && state._rmEarlyRestoreDone) {
    state._rmEarlyRestoreDone = false;
  } else {
    const src = lastMode === "preview" ? getRMLastAnchor() : getLPLastAnchor();
    if (src.file === file && src.anchor) {
      setActiveAnchor(src.anchor);
      // Also seed the coarse fallback percentage: the RM deferred restore uses
      // it to force-render a virtualized target region when the precise anchor
      // can't resolve yet. Cleared on the first successful precise restore.
      if (getLastFallbackPct() >= 0) setFallbackPct(getLastFallbackPct());
      log.info("VIEWPORT anchor-captured", {
        fromMode: lastMode,
        ...anchorLogFields(src.anchor),
      });
    } else if (src.file === file && getLastFallbackPct() >= 0) {
      setFallbackPct(getLastFallbackPct());
      log.info("VIEWPORT fallback-captured", { fromMode: lastMode, pct: Math.round(getLastFallbackPct() * 100) });
    }
  }
}

/** Drive the per-event viewport state transition, then log. Called on every
 *  viewport event (layout-change / post-processor / after-restore); whichever
 *  fires first is the "first observer" that detects the mode switch and seeds
 *  the restore anchor. Owns all global-state writes (mode-switch side effects,
 *  lastMode, lastDocH); logViewportState below is now pure read + log. */


export function driveViewportTransition(app: App, trigger: string): void {
  const view = (app.workspace.activeLeaf?.view as any);
  const mode = view?.getMode?.() ?? "none";
  const file = view?.file?.path ?? "";

  handleModeSwitch(app, mode, file, trigger);
  setLastMode(mode);
  logViewportState(app, trigger);
  if (file) setLastDocH(computeDocH(app, mode));
}



export function logViewportState(app: App, trigger: string): void {
  const leaf = app.workspace.activeLeaf;
  const view = (leaf?.view as any);
  const mode = view?.getMode?.() ?? "none";
  const file = view?.file?.path ?? "";

  if (!file) return;

  let scrollY = 0, viewportH = 0, docH = 0;
  const extra: Record<string, any> = {};

  if (mode === "preview") {
    const previewEl = getRMPreviewEl(app) as HTMLElement;
    if (previewEl) {
      scrollY = previewEl.scrollTop;
      viewportH = previewEl.clientHeight;
      docH = previewEl.scrollHeight;
    }
    const embeds = document.querySelectorAll(".internal-embed");
    let firstVis: string | null = null;
    let lastVis: string | null = null;
    let count = 0;
    for (const el of embeds) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom > 0 && rect.top < window.innerHeight) {
        count++;
        const img = el.querySelector("img");
        const src = img?.getAttribute("src") ?? "";
        const name = src.split("/").pop()?.split("?")[0] ?? "?";
        if (!firstVis) firstVis = name;
        lastVis = name;
      }
    }
    extra.visibleEmbeds = count;
    extra.firstVis = firstVis;
    extra.lastVis = lastVis;
  } else if (mode === "source") {
    const cm = view.editor?.cm;
    if (cm?.scrollDOM) {
      scrollY = cm.scrollDOM.scrollTop;
      viewportH = cm.scrollDOM.clientHeight;
      docH = cm.scrollDOM.scrollHeight;
      const totalLines = cm.state.doc.lines;
      extra.docLines = totalLines;
      if (totalLines > 0 && docH > 0) {
        extra.approxLineFirst = Math.max(1, Math.floor(scrollY / docH * totalLines) + 1);
        extra.approxLineLast = Math.min(totalLines, Math.ceil((scrollY + viewportH) / docH * totalLines));
      }
      const visImages: string[] = [];
      for (let i = 1; i <= totalLines; i++) {
        const line = cm.state.doc.line(i);
        if (getImageLineRe().test(line.text)) {
          const lineY = (i - 1) / totalLines * docH;
          if (lineY >= scrollY && lineY <= scrollY + viewportH) {
            const match = line.text.match(/!\[\[([^\]]+)\]\]/i);
            visImages.push(match?.[1]?.split("|")[0]?.split("/").pop() ?? "?");
          }
        }
      }
      extra.visibleImages = visImages;
      extra.visibleImageCount = visImages.length;
    }
  }

  log.info("VIEWPORT", {
    trigger, mode, file,
    scrollY: Math.round(scrollY), viewportH, docH,
    scrollPct: docH > 0 ? Math.round(scrollY / docH * 100) : 0,
    pending: getPendingAlignmentCount(),
    ...extra,
  });
}

// ── Main exports ───────────────────────────────────────────────

/** Flush buffered RM alignment changes to markdown.
 *  Called from main.ts on layout-change; the RM→LP mode switch flushes
 *  separately via handleModeSwitch. Only fires when there are pending alignments. */


export function schedulePendingFlush(app: App): void {
  if (getPendingAlignmentCount() === 0) return;
  if (getFlushTimer()) clearFlushTimer();
  setFlushTimer(setTimeout(() => {
    setFlushTimer(0 as any);
    log.info("VIEWPORT flush-start", { pendingCount: getPendingAlignmentCount() });
    const modified = flushPendingAlignments(app);
    for (const path of modified) invalidateImageRowIndex(path);
  }, 0));
}


