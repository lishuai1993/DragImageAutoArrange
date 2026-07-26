// scrollAnchor.ts — re-export barrel for the split scroll-sync implementation.
//
// During the P3 refactor the ~2947-line scrollAnchor.ts was split into:
//   anchorStore.ts      — shared mutable state (incl. P3 anchorState) + guard/restore primitives
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
} from "../anchor/anchorStore";
export { computeScrollPct, captureContentAnchor } from "../anchor/anchorCapture";
export { restoreContentAnchor, restoreScrollPct } from "../anchor/anchorRestore";
export { ensureRMScrollTracking, startRMSettleHold } from "../anchor/anchorTracking";
export {
  installEarlyModeSwitchRestore, onViewModeChange, driveViewportTransition, schedulePendingFlush,
} from "../anchor/anchorModeSwitch";
export {
  setImageRowIndex, invalidateImageRowIndex, setImageLineRe,
  setLastFallbackPct, getFallbackPct,
} from "../anchor/anchorStore";
