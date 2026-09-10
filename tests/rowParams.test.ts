import { describe, it, expect } from "vitest";
import { read, write } from "../src/imageParse/rowParams";

const EXTS = "png,jpg,webp";

// ── read: multi row ─────────────────────────────────────────────────────
describe("read multi-row member", () => {
  it("bare embed → share 1, fill null", () => {
    const [r] = read("![[photo.png]]", "multi", EXTS);
    expect(r).toBeDefined();
    expect(r.fileName).toBe("photo.png");
    expect(r.display).toEqual({ kind: "multi", share: 1, fill: null });
  });

  it("|200 → share 2, fill null", () => {
    const [r] = read("![[photo.png|200]]", "multi", EXTS);
    expect(r.display).toEqual({ kind: "multi", share: 2, fill: null });
  });

  it("|120|50 (no align) → share 1.2, fill 0.5", () => {
    const [r] = read("![[a.png|120|50]]", "multi", EXTS);
    expect(r.alignment).toBeUndefined();
    expect(r.display).toEqual({ kind: "multi", share: 1.2, fill: 0.5 });
  });

  it("|left|120|50 → alignment left", () => {
    const [r] = read("![[a.png|left|120|50]]", "multi", EXTS);
    expect(r.alignment).toBe("left");
    expect(r.display).toEqual({ kind: "multi", share: 1.2, fill: 0.5 });
  });

  it("|center|150|80 → alignment center", () => {
    const [r] = read("![[a.png|center|150|80]]", "multi", EXTS);
    expect(r.alignment).toBe("center");
    expect(r.display).toEqual({ kind: "multi", share: 1.5, fill: 0.8 });
  });

  it("|left|120 alone → fill null (no double-assign)", () => {
    const [r] = read("![[a.png|left|120]]", "multi", EXTS);
    expect(r.alignment).toBe("left");
    expect(r.display).toEqual({ kind: "multi", share: 1.2, fill: null });
  });

  it("|800x600 legacy dims → share 8, fill null", () => {
    const [r] = read("![[a.png|800x600]]", "multi", EXTS);
    expect(r.display).toEqual({ kind: "multi", share: 8, fill: null });
  });

  it("nested path + line offset", () => {
    const rows = read("![[folder/photo.jpg|150]]", "multi", EXTS, 3);
    expect(rows[0].fileName).toBe("folder/photo.jpg");
    expect(rows[0].line).toBe(3);
  });

  it("skips a non-embed line", () => {
    const rows = read("![[a.png]]\nplain text\n![[b.png]]", "multi", EXTS);
    expect(rows).toHaveLength(2);
  });

  it("a lone leading align word is not a multi alignment", () => {
    const [r] = read("![[a.png|left]]", "multi", EXTS);
    expect(r.alignment).toBeUndefined();
    expect(r.display).toEqual({ kind: "multi", share: 1, fill: null });
  });
});

// ── read: single row ────────────────────────────────────────────────────
describe("read single-row", () => {
  it("|1|350 → single-manual 350", () => {
    const [r] = read("![[a.webp|1|350]]", "single", EXTS);
    expect(r.display).toEqual({ kind: "single-manual", widthPx: 350 });
  });

  it("|0|420 → single-follow", () => {
    const [r] = read("![[a.webp|0|420]]", "single", EXTS);
    expect(r.display).toEqual({ kind: "single-follow" });
  });

  it("bare → single-follow", () => {
    const [r] = read("![[a.webp]]", "single", EXTS);
    expect(r.display).toEqual({ kind: "single-follow" });
  });

  it("legacy single |600 → single-follow (not manual)", () => {
    const [r] = read("![[a.webp|600]]", "single", EXTS);
    expect(r.display).toEqual({ kind: "single-follow" });
  });

  it("legacy |400x300 → single-follow", () => {
    const [r] = read("![[a.webp|400x300]]", "single", EXTS);
    expect(r.display).toEqual({ kind: "single-follow" });
  });

  it("multi-leftover |150|100 → single-follow reset", () => {
    const [r] = read("![[a.webp|150|100]]", "single", EXTS);
    expect(r.display).toEqual({ kind: "single-follow" });
  });

  it("|left|1|350 → alignment left, manual", () => {
    const [r] = read("![[a.webp|left|1|350]]", "single", EXTS);
    expect(r.alignment).toBe("left");
    expect(r.display).toEqual({ kind: "single-manual", widthPx: 350 });
  });

  it("|center|0|420 → alignment center, follow", () => {
    const [r] = read("![[a.webp|center|0|420]]", "single", EXTS);
    expect(r.alignment).toBe("center");
    expect(r.display).toEqual({ kind: "single-follow" });
  });

  it("alignment-only |left → alignment left, follow", () => {
    const [r] = read("![[a.webp|left]]", "single", EXTS);
    expect(r.alignment).toBe("left");
    expect(r.display).toEqual({ kind: "single-follow" });
  });
});

// ── read: hasSizing flag ────────────────────────────────────────────────
describe("read hasSizing", () => {
  it("multi: numeric share anywhere → true", () => {
    expect(read("![[a.png]]", "multi", EXTS)[0].hasSizing).toBe(false);
    expect(read("![[a.png|200]]", "multi", EXTS)[0].hasSizing).toBe(true);
    expect(read("![[a.png|120|50]]", "multi", EXTS)[0].hasSizing).toBe(true);
    expect(read("![[a.png|left|120|50]]", "multi", EXTS)[0].hasSizing).toBe(true);
    expect(read("![[a.png|left]]", "multi", EXTS)[0].hasSizing).toBe(false);
    expect(read("![[a.png|100]]", "multi", EXTS)[0].hasSizing).toBe(true);
  });

  it("single: only an S∈{0,1} ·W tail counts", () => {
    expect(read("![[a.png]]", "single", EXTS)[0].hasSizing).toBe(false);
    expect(read("![[a.png|1|350]]", "single", EXTS)[0].hasSizing).toBe(true);
    expect(read("![[a.png|0|420]]", "single", EXTS)[0].hasSizing).toBe(true);
    expect(read("![[a.png|left|1|350]]", "single", EXTS)[0].hasSizing).toBe(true);
    expect(read("![[a.png|600]]", "single", EXTS)[0].hasSizing).toBe(false);
    expect(read("![[a.png|150|100]]", "single", EXTS)[0].hasSizing).toBe(false);
    expect(read("![[a.png|left]]", "single", EXTS)[0].hasSizing).toBe(false);
  });
});

// ── write: multi round-trip ─────────────────────────────────────────────
describe("write multi-row member", () => {
  it("bare stays bare", () => {
    const [r] = read("![[a.png]]", "multi", EXTS);
    expect(write(r)).toBe("![[a.png]]");
  });

  it("round-trips share/fill codes", () => {
    for (const line of [
      "![[a.png|200]]",
      "![[a.png|120|50]]",
      "![[a.png|left|120|50]]",
      "![[a.png|center|150|80]]",
      "![[a.png|left|120]]",
      "![[folder/p.png|740|48]]",
    ]) {
      const [r] = read(line, "multi", EXTS);
      expect(write(r)).toBe(line);
    }
  });

  it("share 1.0 with a scale keeps a placeholder 100", () => {
    const [r] = read("![[a.png|100|50]]", "multi", EXTS);
    expect(r.display).toEqual({ kind: "multi", share: 1, fill: 0.5 });
    expect(write(r)).toBe("![[a.png|100|50]]");
  });

  it("a default |100 alone normalises to bare (mirrors updateImageLineWidth)", () => {
    const [r] = read("![[a.png|100]]", "multi", EXTS);
    expect(write(r)).toBe("![[a.png]]");
  });

  it("serialises new values onto a bare line", () => {
    const [r] = read("![[a.png]]", "multi", EXTS);
    const edited = { ...r, display: { kind: "multi" as const, share: 1.2, fill: 0.5 } };
    expect(write(edited)).toBe("![[a.png|120|50]]");
  });
});

// ── write: single round-trip ────────────────────────────────────────────
describe("write single-row", () => {
  it("manual round-trips |1|W and floors W ≥ 1", () => {
    expect(write(read("![[a.webp|1|350]]", "single", EXTS)[0])).toBe("![[a.webp|1|350]]");
    expect(write(read("![[a.webp|1|0]]", "single", EXTS)[0])).toBe("![[a.webp|1|1]]");
  });

  it("manual keeps alignment", () => {
    expect(write(read("![[a.webp|left|1|350]]", "single", EXTS)[0])).toBe("![[a.webp|left|1|350]]");
  });

  it("follow round-trips with explicit width", () => {
    const [r] = read("![[a.webp|0|420]]", "single", EXTS);
    expect(write(r, { followWidthPx: 420 })).toBe("![[a.webp|0|420]]");
  });

  it("follow round-trips without opts via the stored |0|W width", () => {
    const [r] = read("![[a.webp|0|420]]", "single", EXTS);
    expect(write(r)).toBe("![[a.webp|0|420]]");
  });

  it("follow serialises a fresh width onto a bare line", () => {
    const [r] = read("![[a.webp]]", "single", EXTS);
    expect(write(r, { followWidthPx: 350 })).toBe("![[a.webp|0|350]]");
  });

  it("manual serialises a new pixel width", () => {
    const [r] = read("![[a.webp|0|350]]", "single", EXTS);
    const edited = { ...r, display: { kind: "single-manual" as const, widthPx: 700 } };
    expect(write(edited)).toBe("![[a.webp|1|700]]");
  });

  it("preserves surrounding text and leading whitespace", () => {
    const [r] = read("  ![[a.webp|1|50]]", "single", EXTS);
    const edited = { ...r, display: { kind: "single-manual" as const, widthPx: 200 } };
    expect(write(edited)).toBe("  ![[a.webp|1|200]]");
  });
});
