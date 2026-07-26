import { describe, it, expect, beforeAll } from "vitest";
import {
  nextFrame, waitFor, whenEmbedPresent, whenScrollSettled,
} from "../src/anchor/anchorSignals";

// Node env has no rAF / MutationObserver — shim both for deterministic tests.
class FakeMutationObserver {
  static last: FakeMutationObserver | null = null;
  cb: MutationCallback;
  constructor(cb: MutationCallback) { this.cb = cb; FakeMutationObserver.last = this; }
  observe() {}
  disconnect() {}
  trigger() { this.cb([] as any, this as any); }
}

beforeAll(() => {
  (globalThis as any).requestAnimationFrame = (cb: (t: number) => void) =>
    setTimeout(() => cb(Date.now()), 0) as unknown as number;
  (globalThis as any).cancelAnimationFrame = (h: number) => clearTimeout(h);
  (globalThis as any).MutationObserver = FakeMutationObserver;
});

class FakeRoot {
  present = false;
  embed = { tag: "internal-embed" } as any;
  querySelector(sel: string) {
    return this.present && sel.includes("internal-embed") ? this.embed : null;
  }
}

describe("anchorSignals (P4-C)", () => {
  it("nextFrame resolves on the next frame", async () => {
    let done = false;
    nextFrame().then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(done).toBe(true);
  });

  it("waitFor returns true once pred holds, false on timeout", async () => {
    let n = 0;
    const ok = await waitFor(() => { n++; return n >= 3; }, { maxFrames: 10 });
    expect(ok).toBe(true);
    expect(n).toBe(3);

    let m = 0;
    const fail = await waitFor(() => { m++; return false; }, { maxFrames: 4 });
    expect(fail).toBe(false);
  });

  it("whenEmbedPresent resolves immediately when the embed already exists", async () => {
    const root = new FakeRoot();
    root.present = true;
    const el = await whenEmbedPresent(root as unknown as ParentNode, 42, { timeoutMs: 100 });
    expect(el).toBe(root.embed);
  });

  it("whenEmbedPresent resolves when the embed appears after a mutation", async () => {
    const root = new FakeRoot();
    const p = whenEmbedPresent(root as unknown as ParentNode, 42, { timeoutMs: 5000 });
    root.present = true; // renderer builds the target embed
    FakeMutationObserver.last!.trigger(); // mutation observer fires
    const el = await p;
    expect(el).toBe(root.embed);
  });

  it("whenEmbedPresent resolves null on timeout when the embed never appears", async () => {
    const root = new FakeRoot(); // present stays false
    const el = await whenEmbedPresent(root as unknown as ParentNode, 42, { timeoutMs: 10 });
    expect(el).toBe(null);
  });

  it("whenScrollSettled resolves true when already within tolerance", async () => {
    const el = { scrollTop: 100 } as unknown as HTMLElement;
    expect(await whenScrollSettled(el, 100, 5)).toBe(true);
  });

  it("whenScrollSettled resolves false when it never settles", async () => {
    const el = { scrollTop: 0 } as unknown as HTMLElement;
    expect(await whenScrollSettled(el, 500, 5, { maxFrames: 3 })).toBe(false);
  });
});
