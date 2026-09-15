import { describe, it, expect } from "vitest";
import type { App } from "obsidian";
import {
  makeNormalizePlan,
  type NormalizeOptions,
} from "../src/maintenance/normalizeDiaaFormat";
import { applyPass, scanVault } from "../src/maintenance/vaultPass";

const EXTS = "png,jpg,webp";
const OPTIONS: NormalizeOptions = { alignment: "left", maxImagesPerRow: 10 };

const plan = makeNormalizePlan(OPTIONS);
const run = (lines: string[]) => plan(lines, EXTS);

/** What the pass would write, as a plain array of lines. */
function rewrite(lines: string[], replacements: Map<number, string>): string[] {
  const out = [...lines];
  for (const [i, text] of replacements) out[i] = text;
  return out;
}

// ── single rows (an image line with no image line beside it) ────────────
describe("normalizePlan: single rows", () => {
  const cases: Array<[string, string]> = [
    // A bare line gains both word slots; the numeric slots stay empty for the
    // first render to derive.
    ["![[a.png]]", "![[a.png|orig|left]]"],
    // A hand-written native width becomes a manual one, so DIA's first render
    // can't overwrite it with a setting-driven `|0|W`.
    ["![[a.png|400]]", "![[a.png|orig|left|1|400]]"],
    ["![[a.png|400x300]]", "![[a.png|orig|left|1|400]]"],
    // An existing alignment word is kept; a missing one takes the setting.
    ["![[a.png|center]]", "![[a.png|orig|center]]"],
    ["![[a.png|0|350]]", "![[a.png|orig|left|0|350]]"],
    // An orientation word survives verbatim.
    ["![[a.png|r90|1|350]]", "![[a.png|r90|left|1|350]]"],
  ];

  for (const [before, after] of cases) {
    it(`${before} → ${after}`, () => {
      expect(run([before]).get(0)).toBe(after);
    });
  }

  it("leaves a row already in the standard form alone", () => {
    expect(run(["![[a.png|orig|left|0|350]]"]).size).toBe(0);
    expect(run(["![[a.png|orig|left|1|350]]"]).size).toBe(0);
  });
});

// ── multi rows (a run of consecutive image lines) ───────────────────────
describe("normalizePlan: multi rows", () => {
  it("fills the word slots on both members of a bare pair", () => {
    expect([...run(["![[a.png]]", "![[b.png]]"]).entries()]).toEqual([
      [0, "![[a.png|orig|left]]"],
      [1, "![[b.png|orig|left]]"],
    ]);
  });

  it("keeps an existing share code and an existing alignment word", () => {
    const replacements = run(["![[a.png|left|120]]", "![[b.png]]"]);
    expect(replacements.get(0)).toBe("![[a.png|orig|left|120]]");
    expect(replacements.get(1)).toBe("![[b.png|orig|left]]");
  });

  it("leaves a row already in the standard form alone", () => {
    expect(
      run(["![[a.png|orig|center|100|67]]", "![[b.png|orig|center|100|67]]"]).size
    ).toBe(0);
  });
});

// ── lines the pass must not touch ──────────────────────────────────────
describe("normalizePlan: unaccountable lines", () => {
  it("skips a line carrying an alias", () => {
    expect(run(["![[a.png|说明文字]]"]).size).toBe(0);
  });

  it("skips an unaccountable member but still normalises its neighbour", () => {
    expect([...run(["![[a.png|400x300]]", "![[b.png]]"]).keys()]).toEqual([1]);
  });

  it("skips a lone alignment word on a multi member, which the parser reads as absent", () => {
    expect([...run(["![[a.png|left]]", "![[b.png]]"]).keys()]).toEqual([1]);
  });

  it("never plans a line that is not an image embed", () => {
    const replacements = run([
      "正文",
      "![[a.png|400]]",
      "文字 ![[b.png|400]] 尾巴",
      "- 列表项",
    ]);
    expect([...replacements.keys()]).toEqual([1]);
  });
});

// ── idempotence ────────────────────────────────────────────────────────
describe("normalizePlan: idempotence", () => {
  it("finds nothing left to do on a second pass", () => {
    const lines = [
      "![[a.png|400]]",
      "正文",
      "![[b.png|center|100|67]]",
      "![[c.png]]",
    ];
    const after = rewrite(lines, run(lines));
    expect(after).toEqual([
      "![[a.png|orig|left|1|400]]",
      "正文",
      "![[b.png|orig|center|100|67]]",
      "![[c.png|orig|left]]",
    ]);
    expect(run(after).size).toBe(0);
  });
});

// ── through the vault pass ─────────────────────────────────────────────
describe("normalizePlan: through the vault pass", () => {
  interface Harness {
    app: App;
    written: Record<string, string>;
  }

  function makeApp(files: Record<string, string>): Harness {
    const written: Record<string, string> = {};
    const store = { ...files };
    const vault = {
      getMarkdownFiles: () => Object.keys(store).map((path) => ({ path })),
      cachedRead: (file: { path: string }) => Promise.resolve(store[file.path]),
      process: (file: { path: string }, fn: (content: string) => string) => {
        const next = fn(store[file.path]);
        written[file.path] = next;
        store[file.path] = next;
        return Promise.resolve(next);
      },
    };
    const workspace = { getLeavesOfType: () => [] };
    return { app: { vault, workspace } as unknown as App, written };
  }

  it("scans the whole vault but writes only the notes that change", async () => {
    const { app, written } = makeApp({
      "a.md": "![[x.png]]",
      "b.md": "正文\n![[y.png|orig|center|100|67]]\n![[z.png|orig|center|100|67]]",
    });

    const scan = await scanVault(app, EXTS, plan, () => undefined);
    expect(scan.scanned).toBe(2);
    expect(scan.entries.map((e) => e.file.path)).toEqual(["a.md"]);
    expect(scan.foundLines).toBe(1);

    const summary = await applyPass(app, scan, EXTS, plan, () => undefined);
    expect(summary).toEqual({
      scanned: 2,
      changedFiles: 1,
      changedLines: 1,
      failed: 0,
    });
    expect(written).toEqual({ "a.md": "![[x.png|orig|left]]" });
  });
});
