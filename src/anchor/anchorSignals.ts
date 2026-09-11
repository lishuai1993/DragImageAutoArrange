// ── Explicit completion signals (P4-C) ──────────────────────────────
// The restore loops in P3/P4-B poll on frame counts and magic timeouts
// because Obsidian gives no explicit "render done" event for a cold RM
// (virtualized) preview. P4-C replaces that fragile polling with explicit
// signals:
//   • nextFrame / waitFor      — frame-stepping without hand-rolled counters
//   • whenEmbedPresent         — the real "renderer built DOM around the
//                                 target line" signal (MutationObserver)
//   • whenScrollSettled        — scroll position reached / stopped moving
// All are promise-based so the loops can `await` completion instead of
// recursing rAF and guessing frame budgets.

import { findEmbedByLine } from "../scrollSync/domLocators";

/** Resolve on the next animation frame. The single primitive every other
 *  signal is built on. */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

/** Step frames until `pred()` is true, or until `maxFrames` elapse.
 *  `poll()` (if given) runs at the start of every frame, before the check —
 *  useful for re-measuring geometry. Returns true once pred holds, false on
 *  timeout. Replaces frame-count loops (STABLE_DEGRADED_EXIT, docH±5%
 *  stability, early-restore frame budgets). */
export async function waitFor(
  pred: () => boolean,
  opts: { maxFrames?: number; poll?: () => void } = {},
): Promise<boolean> {
  const maxFrames = opts.maxFrames ?? 30;
  for (let i = 0; i < maxFrames; i++) {
    opts.poll?.();
    if (pred()) return true;
    await nextFrame();
  }
  opts.poll?.();
  return pred();
}

/** Resolve with the target embed element once it appears in `root`, or null
 *  after `timeoutMs`. This is the true "the renderer has built DOM around the
 *  target line" signal — far more precise than re-pushing native-scroll every
 *  N frames and hoping restoreContentAnchor eventually succeeds. */
export function whenEmbedPresent(
  root: ParentNode,
  line: number | string,
  opts: { timeoutMs?: number } = {},
): Promise<HTMLElement | null> {
  const existing = findEmbedByLine(root, line);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? 5000;
    let timer: number | null = null;

    const cleanup = () => {
      obs.disconnect();
      if (timer !== null) window.clearTimeout(timer);
    };
    const obs = new MutationObserver(() => {
      const el = findEmbedByLine(root, line);
      if (el) {
        cleanup();
        resolve(el);
      }
    });
    obs.observe(root, { childList: true, subtree: true });

    if (timeoutMs > 0) {
      timer = window.setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);
    }
  });
}

/** Resolve true once `el.scrollTop` is within `tol` of `targetY` (or stops
 *  moving), false if it never settles within `maxFrames`. Built on waitFor. */
export async function whenScrollSettled(
  el: HTMLElement,
  targetY: number,
  tol: number,
  opts: { maxFrames?: number } = {},
): Promise<boolean> {
  return waitFor(
    () => Math.abs((el.scrollTop ?? 0) - targetY) <= tol,
    { maxFrames: opts.maxFrames ?? 30 },
  );
}
