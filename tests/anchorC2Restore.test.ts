import { describe, it, expect, beforeAll } from "vitest";
import { runRestoreLoop } from "../src/anchor/anchorRestoreSession";
import { whenEmbedPresent } from "../src/anchor/anchorSignals";

// P4-C2 composition test.
//
// scheduleRMDeferredRestore's cold-RM branch is now: push native once, then
// `await whenEmbedPresent(...)` for the renderer to build the target embed,
// re-arming the native push if the embed never shows within the budget. That
// branch is buried in a closure that needs a full Obsidian app + DOM harness to
// run, so instead we exercise the two REAL primitives it is built from
// (runRestoreLoop async + whenEmbedPresent) wired in the exact C2 pattern, and
// assert the important invariants: the restore lands exactly once, only after
// the embed appears; native is re-pushed when the embed is late; the loop stops.

class FakeMutationObserver {
  static last: FakeMutationObserver | null = null;
  cb: MutationCallback;
  constructor(cb: MutationCallback) { this.cb = cb; FakeMutationObserver.last = this; }
  observe() {}
  disconnect() {}
  trigger() { this.cb([], this as unknown as MutationObserver); }
}

beforeAll(() => {
  window.requestAnimationFrame = (cb: FrameRequestCallback) =>
    window.setTimeout(() => cb(Date.now()), 0);
  window.cancelAnimationFrame = (h: number) => window.clearTimeout(h);
  // FakeMutationObserver omits `takeRecords`; the cast bridges that one gap.
  window.MutationObserver = FakeMutationObserver as unknown as typeof MutationObserver;
});

/** Minimal preview root whose target embed can be toggled into existence. */
class FakeRoot {
  present = false;
  readonly embed = { tag: "internal-embed" };
  querySelector(sel: string) {
    return this.present && sel.includes("internal-embed") ? this.embed : null;
  }
}

const tick = (ms = 5) => new Promise((r) => window.setTimeout(r, ms));

/** Build the C2 image-anchor cold-restore onFrame around the real primitives. */
function makeColdRMFrame(root: FakeRoot, counters: {
  restores: number; nativePushes: number; handoffs: number;
}, opts: { timeoutMs: number }) {
  let nativeTried = false;
  return async function onFrame(): Promise<"continue" | "stop"> {
    // restoreContentAnchor succeeds only once the embed is in the DOM.
    if (root.present) {
      counters.restores++;
      counters.handoffs++; // hand off to settle-hold, exactly as production does
      return "stop";
    }
    if (!nativeTried) {
      nativeTried = true;
      counters.nativePushes++;
      const appeared = await whenEmbedPresent(root as unknown as ParentNode, 42, {
        timeoutMs: opts.timeoutMs,
      });
      if (!appeared) nativeTried = false; // re-arm the native push next cycle
      return "continue";
    }
    return "continue";
  };
}

describe("P4-C2 cold-RM restore (runRestoreLoop + whenEmbedPresent)", () => {
  it("restores exactly once, only after the embed appears; loop then stops", async () => {
    const root = new FakeRoot();
    const counters = { restores: 0, nativePushes: 0, handoffs: 0 };
    let idSlot: number | null = null;

    runRestoreLoop({
      getId: () => idSlot,
      setId: (id) => { idSlot = id; },
      firstFrameSync: true,
      onFrame: makeColdRMFrame(root, counters, { timeoutMs: 1000 }),
    });

    // First (sync) frame pushed native and is now awaiting the embed.
    expect(counters.nativePushes).toBe(1);
    expect(counters.restores).toBe(0);

    // Renderer builds the target embed and the MutationObserver fires.
    root.present = true;
    FakeMutationObserver.last!.trigger();

    await tick(20);

    expect(counters.nativePushes).toBe(1); // no needless re-push once embed shows
    expect(counters.restores).toBe(1);     // restore landed exactly once
    expect(counters.handoffs).toBe(1);     // single hand-off to settle-hold
    expect(idSlot).toBe(null);             // loop stopped, slot cleared
  });

  it("re-pushes native when the embed is late, then restores once", async () => {
    const root = new FakeRoot();
    const counters = { restores: 0, nativePushes: 0, handoffs: 0 };
    let idSlot: number | null = null;

    runRestoreLoop({
      getId: () => idSlot,
      setId: (id) => { idSlot = id; },
      firstFrameSync: true,
      onFrame: makeColdRMFrame(root, counters, { timeoutMs: 10 }),
    });

    // Let a couple of embed-wait budgets time out and re-arm the native push.
    await tick(60);
    expect(counters.nativePushes).toBeGreaterThanOrEqual(2);
    expect(counters.restores).toBe(0); // nothing restored while the embed is absent

    // Embed finally appears; the pending wait (or the next one) resolves.
    root.present = true;
    FakeMutationObserver.last!.trigger();

    await tick(40);
    expect(counters.restores).toBe(1);
    expect(counters.handoffs).toBe(1);
    expect(idSlot).toBe(null);
  });
});
