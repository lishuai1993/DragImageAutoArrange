import { describe, it, expect } from "vitest";
import type { App } from "obsidian";
import { clearPlan } from "../src/maintenance/clearDiaaFormat";
import {
  applyPass,
  scanVault,
  type VaultPassProgress,
} from "../src/maintenance/vaultPass";

const EXTS = "png,jpg,webp";

interface Harness {
  app: App;
  written: Record<string, string>;
}

/** Minimal fake of the two vault/workspace surfaces the pass touches.  Paths
 *  listed in `failRead` / `failWrite` reject in that phase. */
function makeApp(
  files: Record<string, string>,
  failRead: string[] = [],
  failWrite: string[] = []
): Harness {
  const written: Record<string, string> = {};
  const store = { ...files };
  const vault = {
    getMarkdownFiles: () => Object.keys(store).map((path) => ({ path })),
    cachedRead: (file: { path: string }) =>
      failRead.includes(file.path)
        ? Promise.reject(new Error("boom"))
        : Promise.resolve(store[file.path]),
    process: (file: { path: string }, fn: (content: string) => string) => {
      if (failWrite.includes(file.path)) return Promise.reject(new Error("boom"));
      const next = fn(store[file.path]);
      written[file.path] = next;
      store[file.path] = next;
      return Promise.resolve(next);
    },
  };
  const workspace = { getLeavesOfType: () => [] };
  return { app: { vault, workspace } as unknown as App, written };
}

describe("scanVault + applyPass", () => {
  it("reports the scope, then rewrites only the files that need it", async () => {
    const { app, written } = makeApp({
      "a.md": "![[x.png|orig|left|0|350]]",
      "b.md": "![[y.png|400]]\n正文",
      "c.md": "![[z.png|orig|100|50]]\n![[w.png|1|400]]",
    });

    const scan: VaultPassProgress[] = [];
    const result = await scanVault(app, EXTS, clearPlan, (p) => scan.push({ ...p }));
    expect(result.scanned).toBe(3);
    expect(result.foundLines).toBe(3);
    expect(result.entries.map((e) => e.file.path)).toEqual(["a.md", "c.md"]);
    expect(scan[scan.length - 1]).toEqual({ phase: "scan", processed: 3, total: 3 });

    const applied: VaultPassProgress[] = [];
    const summary = await applyPass(app, result, EXTS, clearPlan, (p) =>
      applied.push({ ...p })
    );
    expect(summary).toEqual({
      scanned: 3,
      changedFiles: 2,
      changedLines: 3,
      failed: 0,
    });
    expect(applied[applied.length - 1]).toEqual({
      phase: "apply",
      processed: 2,
      total: 2,
    });

    expect(written).toEqual({
      "a.md": "![[x.png]]",
      "c.md": "![[z.png]]\n![[w.png]]",
    });
    expect(written["b.md"]).toBeUndefined();
  });

  it("counts a failed read and keeps going", async () => {
    const { app } = makeApp({ "a.md": "![[x.png|orig|100|50]]" }, ["a.md"]);

    const scan = await scanVault(app, EXTS, clearPlan, () => undefined);
    expect(scan.failed).toBe(1);
    expect(scan.entries).toHaveLength(0);
  });

  it("counts a failed write without aborting the pass", async () => {
    const { app } = makeApp(
      { "a.md": "![[x.png|orig|100|50]]", "b.md": "![[y.png|orig|100|50]]" },
      [],
      ["a.md"]
    );

    const scan = await scanVault(app, EXTS, clearPlan, () => undefined);
    expect(scan.entries).toHaveLength(2);

    const summary = await applyPass(app, scan, EXTS, clearPlan, () => undefined);
    expect(summary.failed).toBe(1);
    expect(summary.changedFiles).toBe(1);
    expect(summary.changedLines).toBe(1);
  });
});
