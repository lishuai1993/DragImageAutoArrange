import { describe, it, expect, beforeAll } from "vitest";
import { runRestoreLoop, type FrameOutcome } from "../src/anchor/anchorRestoreSession";

// The loops run in Obsidian where requestAnimationFrame exists; vitest's node
// env has none, so shim a setTimeout-backed rAF for the primitive's control flow.
beforeAll(() => {
  (globalThis as any).requestAnimationFrame = (cb: (t: number) => void) =>
    setTimeout(() => cb(Date.now()), 0) as unknown as number;
  (globalThis as any).cancelAnimationFrame = (h: number) => clearTimeout(h);
});

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("runRestoreLoop primitive (P4-B)", () => {
  it("stop on the first (sync) frame halts and clears the id slot", () => {
    let id: number | null = null;
    let frames = 0;
    runRestoreLoop({
      getId: () => id,
      setId: (v) => { id = v; },
      firstFrameSync: true,
      onFrame: () => { frames++; return "stop" as FrameOutcome; },
    });
    expect(frames).toBe(1);
    expect(id).toBe(null); // halt cleared the slot
  });

  it("continue then stop schedules exactly one async frame and halts", async () => {
    let id: number | null = null;
    let frames = 0;
    runRestoreLoop({
      getId: () => id,
      setId: (v) => { id = v; },
      firstFrameSync: true,
      onFrame: () => { frames++; return frames < 2 ? "continue" : "stop"; },
    });
    expect(frames).toBe(1);            // first frame is synchronous
    expect(id).not.toBe(null);         // next frame scheduled (slot non-null)
    await tick();
    expect(frames).toBe(2);
    expect(id).toBe(null);             // halted, slot cleared
  });

  it("firstFrameSync:false defers the first frame to the next rAF", async () => {
    let id: number | null = null;
    let frames = 0;
    runRestoreLoop({
      getId: () => id,
      setId: (v) => { id = v; },
      firstFrameSync: false,
      onFrame: () => { frames++; return "stop"; },
    });
    expect(frames).toBe(0);            // not run synchronously
    expect(id).not.toBe(null);         // but scheduled (slot non-null)
    await tick();
    expect(frames).toBe(1);
    expect(id).toBe(null);
  });

  it("cancel() stops the loop and prevents further frames", async () => {
    let id: number | null = null;
    let frames = 0;
    const handle = runRestoreLoop({
      getId: () => id,
      setId: (v) => { id = v; },
      firstFrameSync: true,
      onFrame: () => { frames++; return "continue"; },
    });
    expect(frames).toBe(1);
    handle.cancel();
    expect(id).toBe(null); // slot cleared on cancel
    await tick();
    expect(frames).toBe(1); // halted guard blocked the scheduled frame
  });

  it("async onFrame (returns a Promise) drives the loop and halts", async () => {
    let id: number | null = null;
    let frames = 0;
    runRestoreLoop({
      getId: () => id,
      setId: (v) => { id = v; },
      firstFrameSync: true,
      onFrame: (): Promise<FrameOutcome> =>
        Promise.resolve(frames++ < 1 ? "continue" : "stop"),
    });
    // first frame's synchronous prefix ran; scheduling is on a microtask
    await Promise.resolve();
    expect(frames).toBe(1);
    expect(id).not.toBe(null); // next frame scheduled
    await tick();
    expect(frames).toBe(2);
    expect(id).toBe(null);     // halted, slot cleared
  });
});
