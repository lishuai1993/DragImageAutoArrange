// scrollAnchor.ts — re-export barrel for the split scroll-sync implementation.
//
// During the P3 refactor the ~2947-line scrollAnchor.ts was split into:
//   anchorState.ts      — shared mutable state + guard/restore primitives
//   anchorCapture.ts    — anchor capture (LP + RM)
//   anchorRestore.ts    — anchor restore (LP + RM)
//   anchorTracking.ts   — RM/LP scroll tracking + deferred/settle-hold restores
//   anchorModeSwitch.ts — early-restore + view-mode-switch orchestration
// This file now only re-exports the public API so call sites in main.ts,
// readingMode.ts, warmupProbe.ts, warmupScheduler.ts and the smoke test stay
// unchanged.

export {
  getRMDeferredRestoreId, cancelRMDeferredRestore, setSectionSnapshot,
  applySnapshotLineDelta, getScrollAnchor, setLastAnchor,
} from "./anchorState";
export { computeScrollPct, captureContentAnchor } from "./anchorCapture";
export { restoreContentAnchor, restoreScrollPct } from "./anchorRestore";
export { ensureRMScrollTracking, startRMSettleHold } from "./anchorTracking";
export {
  installEarlyModeSwitchRestore, onViewModeChange, driveViewportTransition, schedulePendingFlush,
} from "./anchorModeSwitch";
export {
  setImageRowIndex, invalidateImageRowIndex, setImageLineRe,
  setLastFallbackPct, setRMRenderedFile, getFallbackPct,
} from "./anchorStore";
