import { describe, it, expect } from "vitest";
import { clearPlan, isManagedLine } from "../src/maintenance/clearDiaaFormat";

const EXTS = "png,jpg,webp";

// ── managed-param test (conservative) ───────────────────────────────────
describe("isManagedLine", () => {
  it("keeps lines that carry no DIAA-only marker", () => {
    expect(isManagedLine("![[a.png]]")).toBe(false);
    expect(isManagedLine("![[a.png|400]]")).toBe(false);
    expect(isManagedLine("![[a.png|400x300]]")).toBe(false);
    expect(isManagedLine("![[a.png|center]]")).toBe(false);
    expect(isManagedLine("![[a.png|left|120]]")).toBe(false);
  });

  it("claims lines DIAA could have written", () => {
    expect(isManagedLine("![[a.png|0|350]]")).toBe(true);
    expect(isManagedLine("![[a.png|1|350]]")).toBe(true);
    expect(isManagedLine("![[a.png|150|100]]")).toBe(true);
    expect(isManagedLine("![[a.png|orig]]")).toBe(true);
    expect(isManagedLine("![[a.png|orig|center|100|67]]")).toBe(true);
    expect(isManagedLine("![[a.png|r90|left|120|50]]")).toBe(true);
  });
});

// ── row selection (whole-line image rows) ───────────────────────────────
describe("clearPlan — image rows", () => {
  it("picks only managed rows, ignoring prose and native embeds", () => {
    const lines = ["正文", "![[a.png|400]]", "![[b.png|orig|center|100|67]]", "![[d.png]]"];
    const plan = clearPlan(lines, EXTS);
    expect([...plan.keys()]).toEqual([2]);
    expect(plan.get(2)).toBe("![[b.png]]");
  });

  it("treats each image row independently of its neighbours", () => {
    const plan = clearPlan(["![[a.png|orig|100|50]]", "![[b.png|orig|100|50]]"], EXTS);
    expect([...plan.entries()]).toEqual([
      [0, "![[a.png]]"],
      [1, "![[b.png]]"],
    ]);
  });

  it("is a no-op when nothing is managed", () => {
    expect(clearPlan(["![[a.png]]", "![[b.png|400x300]]"], EXTS).size).toBe(0);
  });

  it("leaves a lone alignment word alone — a row DIAA will fill in, not residue", () => {
    expect(clearPlan(["![[a.png|center]]"], EXTS).size).toBe(0);
  });
});

// ── inline references (prose / list / quote) ────────────────────────────
describe("clearPlan — inline references", () => {
  it("takes DIAA's alignment word back out of a paragraph", () => {
    const plan = clearPlan(["文字 ![[c.png|center]] 尾巴"], EXTS);
    expect(plan.get(0)).toBe("文字 ![[c.png]] 尾巴");
  });

  it("keeps Obsidian's numeric sizing while dropping the word params", () => {
    const plan = clearPlan(["文字 ![[a.png|center|400]] 文字"], EXTS);
    expect(plan.get(0)).toBe("文字 ![[a.png|400]] 文字");
  });

  it("clears a list item and a quote, keeping their markers", () => {
    const plan = clearPlan(["- ![[a.png|left]]", "> ![[b.png|center|400x300]]"], EXTS);
    expect([...plan.entries()]).toEqual([
      [0, "- ![[a.png]]"],
      [1, "> ![[b.png|400x300]]"],
    ]);
  });

  it("drops a full DIAA param run wherever it sits in the line", () => {
    const plan = clearPlan(["文字 ![[c.png|0|350]] 尾巴"], EXTS);
    expect(plan.get(0)).toBe("文字 ![[c.png]] 尾巴");
  });

  it("handles several references on one line, each on its own merits", () => {
    const plan = clearPlan(["![[a.png|center]] 和 ![[b.png|400]]"], EXTS);
    expect(plan.get(0)).toBe("![[a.png]] 和 ![[b.png|400]]");
  });

  it("leaves hand-written native params and prose untouched", () => {
    const lines = ["文字 ![[a.png|400]] 文字", "- ![[b.png|400x300]]", "正文"];
    expect(clearPlan(lines, EXTS).size).toBe(0);
  });

  it("ignores non-image embeds and unknown extensions", () => {
    const lines = ["见 ![[笔记|center]]", "见 ![[a.txt|400]]"];
    expect(clearPlan(lines, EXTS).size).toBe(0);
  });
});
