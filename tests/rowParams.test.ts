import { describe, it, expect } from "vitest";
import { read, write, mergeRewrite } from "../src/imageParse/rowParams";

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

// ── write: multi round-trip (every slot is always filled) ───────────────
describe("write multi-row member", () => {
  it("a bare line materialises with the orientation and share slots", () => {
    const [r] = read("![[a.png]]", "multi", EXTS);
    expect(write(r)).toBe("![[a.png|orig|100]]");
  });

  it("normalises a legacy line to the filled form", () => {
    const cases: [string, string][] = [
      ["![[a.png|200]]", "![[a.png|orig|200]]"],
      ["![[a.png|120|50]]", "![[a.png|orig|120|50]]"],
      ["![[a.png|left|120|50]]", "![[a.png|orig|left|120|50]]"],
      ["![[a.png|center|150|80]]", "![[a.png|orig|center|150|80]]"],
      ["![[a.png|left|120]]", "![[a.png|orig|left|120]]"],
      ["![[folder/p.png|740|48]]", "![[folder/p.png|orig|740|48]]"],
    ];
    for (const [from, to] of cases) {
      expect(write(read(from, "multi", EXTS)[0])).toBe(to);
    }
  });

  it("round-trips an already-filled line byte for byte", () => {
    for (const line of [
      "![[a.png|orig|100]]",
      "![[a.png|orig|120|50]]",
      "![[a.png|r90|center|150|80]]",
    ]) {
      expect(write(read(line, "multi", EXTS)[0])).toBe(line);
    }
  });

  it("a uniform share still writes its 100 code", () => {
    const [r] = read("![[a.png|100|50]]", "multi", EXTS);
    expect(r.display).toEqual({ kind: "multi", share: 1, fill: 0.5 });
    expect(write(r)).toBe("![[a.png|orig|100|50]]");
  });

  it("keeps the share code alone when no fill has been measured", () => {
    const [r] = read("![[a.png|120]]", "multi", EXTS);
    expect(write(r)).toBe("![[a.png|orig|120]]");
  });

  it("serialises new values onto a bare line", () => {
    const [r] = read("![[a.png]]", "multi", EXTS);
    const edited = { ...r, display: { kind: "multi" as const, share: 1.2, fill: 0.5 } };
    expect(write(edited)).toBe("![[a.png|orig|120|50]]");
  });
});

// ── write: single round-trip (every slot is always filled) ──────────────
describe("write single-row", () => {
  it("manual round-trips |S|W with the orientation word and floors W ≥ 1", () => {
    expect(write(read("![[a.webp|1|350]]", "single", EXTS)[0])).toBe("![[a.webp|orig|1|350]]");
    expect(write(read("![[a.webp|1|0]]", "single", EXTS)[0])).toBe("![[a.webp|orig|1|1]]");
  });

  it("manual keeps alignment", () => {
    expect(write(read("![[a.webp|left|1|350]]", "single", EXTS)[0])).toBe(
      "![[a.webp|orig|left|1|350]]"
    );
  });

  it("follow round-trips with explicit width", () => {
    const [r] = read("![[a.webp|0|420]]", "single", EXTS);
    expect(write(r, { followWidthPx: 420 })).toBe("![[a.webp|orig|0|420]]");
  });

  it("follow round-trips without opts via the stored |0|W width", () => {
    const [r] = read("![[a.webp|0|420]]", "single", EXTS);
    expect(write(r)).toBe("![[a.webp|orig|0|420]]");
  });

  it("follow serialises a fresh width onto a bare line", () => {
    const [r] = read("![[a.webp]]", "single", EXTS);
    expect(write(r, { followWidthPx: 350 })).toBe("![[a.webp|orig|0|350]]");
  });

  it("manual serialises a new pixel width", () => {
    const [r] = read("![[a.webp|0|350]]", "single", EXTS);
    const edited = { ...r, display: { kind: "single-manual" as const, widthPx: 700 } };
    expect(write(edited)).toBe("![[a.webp|orig|1|700]]");
  });

  it("preserves surrounding text and leading whitespace", () => {
    const [r] = read("  ![[a.webp|1|50]]", "single", EXTS);
    const edited = { ...r, display: { kind: "single-manual" as const, widthPx: 200 } };
    expect(write(edited)).toBe("  ![[a.webp|orig|1|200]]");
  });
});

// ── orientation slot ────────────────────────────────────────────────────
describe("read orientation word", () => {
  it("reads it ahead of the alignment word and the numbers", () => {
    const [m] = read("![[a.png|r90|left|120|50]]", "multi", EXTS);
    expect(m.orientation).toEqual({ turns: 1, mirror: false });
    expect(m.alignment).toBe("left");
    expect(m.display).toEqual({ kind: "multi", share: 1.2, fill: 0.5 });
  });

  it("shifts the single row's S/W pair past it", () => {
    const [manual] = read("![[a.webp|orig|1|350]]", "single", EXTS);
    expect(manual.orientation).toEqual({ turns: 0, mirror: false });
    expect(manual.alignment).toBeUndefined();
    expect(manual.display).toEqual({ kind: "single-manual", widthPx: 350 });

    const [follow] = read("![[a.webp|r270fh|center|0|420]]", "single", EXTS);
    expect(follow.orientation).toEqual({ turns: 3, mirror: true });
    expect(follow.alignment).toBe("center");
    expect(follow.display).toEqual({ kind: "single-follow" });
  });

  it("defaults to identity both when the word is absent and when it reads orig", () => {
    const identity = { turns: 0, mirror: false };
    expect(read("![[a.png]]", "multi", EXTS)[0].orientation).toEqual(identity);
    expect(read("![[a.png|orig]]", "multi", EXTS)[0].orientation).toEqual(identity);
    expect(read("![[a.png|left|120|50]]", "multi", EXTS)[0].orientation).toEqual(identity);
  });

  it("leaves hasSizing keyed on numbers alone", () => {
    expect(read("![[a.png|r90]]", "multi", EXTS)[0].hasSizing).toBe(false);
    expect(read("![[a.png|r90|200]]", "multi", EXTS)[0].hasSizing).toBe(true);
    expect(read("![[a.webp|r90]]", "single", EXTS)[0].hasSizing).toBe(false);
    expect(read("![[a.webp|r90|1|350]]", "single", EXTS)[0].hasSizing).toBe(true);
  });
});

// ── mergeRewrite: which slots follow the document ───────────────────────
describe("mergeRewrite", () => {
  it("takes every unclaimed slot from the line, not from the model", () => {
    // The rotate repro: the document already holds the new word *and* the fill
    // the turn wrote, while the model is the snapshot from before that edit.
    const model = read("![[a.png|fh|center|310|100]]", "multi", EXTS)[0];
    const merged = mergeRewrite(
      "![[a.png|r90fh|center|310|51]]",
      "multi",
      { ...model, display: { kind: "multi", share: 3.1, fill: 0.87 } }
    );
    expect(write(merged)).toBe("![[a.png|r90fh|center|310|51]]");
  });

  it("lets a claimed slot win over the line", () => {
    const model = read("![[a.png|fh|center|310|100]]", "multi", EXTS)[0];
    const merged = mergeRewrite(
      "![[a.png|r90fh|center|310|51]]",
      "multi",
      { ...model, display: { kind: "multi", share: 2.5, fill: 0.87 } },
      { share: true, fill: true }
    );
    expect(write(merged)).toBe("![[a.png|r90fh|center|250|87]]");
  });

  it("takes a single row's S|W from the line when the tail holds no local edit", () => {
    // The single-row counterpart of the rotate repro: the turn writes its own
    // `|1|turned width` straight to the line, and the widget built before that
    // edit still holds the width it last laid out.
    const model = read("![[a.webp|fh|left|1|200]]", "single", EXTS)[0];
    const merged = mergeRewrite("![[a.webp|r90|center|1|350]]", "single", model);
    expect(write(merged)).toBe("![[a.webp|r90|center|1|350]]");
  });

  it("lets a claimed single tail win over the line", () => {
    const model = read("![[a.webp|fh|left|1|200]]", "single", EXTS)[0];
    const merged = mergeRewrite("![[a.webp|r90|center|1|350]]", "single", model, {
      sizing: true,
    });
    expect(write(merged)).toBe("![[a.webp|r90|center|1|200]]");
  });

  it("takes the line's follow flag over a stale manual model", () => {
    // S is the line's to decide: a return to setting-driven (or a settings pass
    // that unpinned the row) must not be undone by the widget's manual width.
    const model = read("![[a.webp|fh|left|1|200]]", "single", EXTS)[0];
    const merged = mergeRewrite("![[a.webp|r90|center|0|350]]", "single", model);
    expect(merged.display).toEqual({ kind: "single-follow" });
    expect(write(merged)).toBe("![[a.webp|r90|center|0|350]]");
    // A follow row's W is still the caller's measurement when one is supplied.
    expect(write(merged, { followWidthPx: 400 })).toBe("![[a.webp|r90|center|0|400]]");
  });

  it("omits the alignment word when the line carries none and none is claimed", () => {
    const model = read("![[a.png|left|310|100]]", "multi", EXTS)[0];
    const merged = mergeRewrite("![[a.png|310|100]]", "multi", model);
    expect(write(merged)).toBe("![[a.png|orig|310|100]]");
  });

  it("reads a line that is not an embed as empty slots without throwing", () => {
    const model = read("![[a.png|left|310|100]]", "multi", EXTS)[0];
    const merged = mergeRewrite("plain text", "multi", model);
    expect(merged.orientation).toEqual({ turns: 0, mirror: false });
    expect(merged.alignment).toBeUndefined();
    expect(write(merged)).toBe("plain text");
  });
});

describe("write orientation word", () => {
  it("fills the slot even on a line that never carried one", () => {
    expect(write(read("![[a.png]]", "multi", EXTS)[0])).toBe("![[a.png|orig|100]]");
    expect(write(read("![[a.png|100]]", "multi", EXTS)[0])).toBe("![[a.png|orig|100]]");
  });

  it("prepends the word ahead of the alignment and numbers", () => {
    const [m] = read("![[a.png|left|120|50]]", "multi", EXTS);
    const rotated = { ...m, orientation: { turns: 1, mirror: false } };
    expect(write(rotated)).toBe("![[a.png|r90|left|120|50]]");
  });

  it("round-trips a rotated line and a rotated single row", () => {
    expect(write(read("![[a.png|r90|left|120|50]]", "multi", EXTS)[0]))
      .toBe("![[a.png|r90|left|120|50]]");
    expect(write(read("![[a.webp|r270fh|0|420]]", "single", EXTS)[0], { followWidthPx: 420 }))
      .toBe("![[a.webp|r270fh|0|420]]");
  });

  it("keeps the slot as an explicit orig once it is reset", () => {
    const [m] = read("![[a.png|r90|120|50]]", "multi", EXTS);
    const reset = { ...m, orientation: { turns: 0, mirror: false } };
    expect(write(reset)).toBe("![[a.png|orig|120|50]]");

    const [s] = read("![[a.webp|r90|0|420]]", "single", EXTS);
    const sReset = { ...s, orientation: { turns: 0, mirror: false } };
    expect(write(sReset)).toBe("![[a.webp|orig|0|420]]");
  });
});
