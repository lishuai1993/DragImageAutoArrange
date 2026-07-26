// ── Restore-loop primitive (P4-B) ───────────────────────────────────
// The five scroll-sync restore loops in anchorTracking.ts / anchorModeSwitch.ts
// each hand-roll the same rAF recursion: a slot holding the current animation
// frame id, a synchronous first attempt, then `requestAnimationFrame(loop)`
// until a terminal condition. This primitive centralizes that bookkeeping so
// the loops only express *what to do per frame* via `onFrame` and return
// "continue" / "stop". It is behavior-preserving: the first frame still runs
// synchronously when `firstFrameSync` is set, and the id slot is cleared on
// halt exactly as the old loops did on their terminal `return`.

export type FrameOutcome = "continue" | "stop";

export interface RestoreLoopOptions {
  /** Read the current rAF id stored for this loop (e.g. () => state._rmDeferredRestoreId). */
  getId: () => number | null;
  /** Write the current rAF id (null clears it). */
  setId: (id: number | null) => void;
  /** Execute one frame. Return "continue" to schedule the next frame, "stop" to halt. */
  onFrame: () => FrameOutcome;
  /** Run the first frame synchronously (no rAF) — matches loops that call their
   *  closure once before scheduling. Default false (first frame on next rAF). */
  firstFrameSync?: boolean;
}

export interface RestoreLoopHandle {
  cancel(): void;
}

export function runRestoreLoop(opts: RestoreLoopOptions): RestoreLoopHandle {
  let halted = false;

  const halt = () => {
    if (halted) return;
    halted = true;
    const id = opts.getId();
    if (id !== null) {
      cancelAnimationFrame(id);
      opts.setId(null);
    }
  };

  const frame = () => {
    if (halted) return;
    opts.setId(null); // slot is owned by the primitive while a frame is in flight
    const outcome = opts.onFrame();
    if (outcome === "stop") {
      halt();
      return;
    }
    opts.setId(requestAnimationFrame(frame));
  };

  // Cancel any pre-existing frame on this slot before starting fresh.
  const existing = opts.getId();
  if (existing !== null) {
    cancelAnimationFrame(existing);
    opts.setId(null);
  }

  if (opts.firstFrameSync) frame();
  else opts.setId(requestAnimationFrame(frame));

  return { cancel: halt };
}
