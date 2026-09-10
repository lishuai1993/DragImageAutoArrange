import { describe, it, expect } from "vitest";
import { detectRowGroups } from "../src/imageParse/imageDetector";

describe("detectRowGroups grouping", () => {
  it("empty text → no groups", () => {
    expect(detectRowGroups("", 10, "png,jpg")).toEqual([]);
  });

  it("no-image text → no groups", () => {
    expect(detectRowGroups("Just text\nMore text", 10, "png,jpg")).toEqual([]);
  });

  it("single image → one single group", () => {
    const gs = detectRowGroups("![[a.png]]", 10, "png,jpg");
    expect(gs).toHaveLength(1);
    expect(gs[0].kind).toBe("single");
    expect(gs[0].images).toHaveLength(1);
    expect(gs[0].images[0].fileName).toBe("a.png");
    expect(gs[0].images[0].display).toEqual({ kind: "single-follow" });
  });

  it("two consecutive images → one multi group", () => {
    const gs = detectRowGroups("![[a.png]]\n![[b.png]]", 10, "png,jpg");
    expect(gs).toHaveLength(1);
    expect(gs[0].kind).toBe("multi");
    expect(gs[0].images).toHaveLength(2);
    for (const img of gs[0].images) {
      expect(img.display).toEqual({ kind: "multi", share: 1, fill: null });
    }
  });

  it("images separated by text → separate groups", () => {
    const gs = detectRowGroups(
      "![[a.png]]\nSome text\n![[b.png]]",
      10,
      "png,jpg"
    );
    expect(gs).toHaveLength(2);
    expect(gs[0].kind).toBe("single");
    expect(gs[1].kind).toBe("single");
  });

  it("respects lineStart/lineEnd", () => {
    const gs = detectRowGroups(
      "text before\n![[a.png]]\n![[b.png]]\ntext after\n![[c.png]]",
      10,
      "png,jpg"
    );
    expect(gs).toHaveLength(2);
    expect(gs[0]).toMatchObject({ lineStart: 1, lineEnd: 3, kind: "multi" });
    expect(gs[1]).toMatchObject({ lineStart: 4, lineEnd: 5, kind: "single" });
  });
});

describe("detectRowGroups oversize splitting + reclassification", () => {
  it("splits oversized runs by maxImagesPerRow", () => {
    const lines = Array.from({ length: 5 }, (_, i) => `![[img${i}.png]]`).join("\n");
    const gs = detectRowGroups(lines, 3, "png,jpg");
    expect(gs).toHaveLength(2);
    expect(gs[0].kind).toBe("multi");
    expect(gs[0].images).toHaveLength(3);
    expect(gs[1].kind).toBe("multi");
    expect(gs[1].images).toHaveLength(2);
  });

  it("a lone leftover member of a split row becomes a single row", () => {
    const lines = Array.from({ length: 3 }, (_, i) => `![[img${i}.png]]`).join("\n");
    const gs = detectRowGroups(lines, 2, "png,jpg");
    expect(gs).toHaveLength(2);
    expect(gs[0]).toMatchObject({ kind: "multi", lineStart: 0, lineEnd: 2 });
    expect(gs[1]).toMatchObject({ kind: "single", lineStart: 2, lineEnd: 3 });
    expect(gs[1].images[0].display).toEqual({ kind: "single-follow" });
  });

  it("classifies a split lone leftover carrying multi params as single-follow", () => {
    const lines = "![[a.png|740|48]]\n![[b.png|100|60]]\n![[c.png|114|100]]";
    const gs = detectRowGroups(lines, 2, "png,jpg");
    expect(gs[0].kind).toBe("multi");
    expect(gs[1].kind).toBe("single");
    // |114|100 read as single is a multi-leftover (first param ≠ 0/1) → follow reset
    expect(gs[1].images[0].display).toEqual({ kind: "single-follow" });
  });
});

describe("detectRowGroups param semantics", () => {
  it("multi group members parse share/fill", () => {
    const gs = detectRowGroups("![[a.png|left|120|50]]\n![[b.png|150|80]]", 10, "png,jpg");
    expect(gs[0].kind).toBe("multi");
    expect(gs[0].images[0].alignment).toBe("left");
    expect(gs[0].images[0].display).toEqual({ kind: "multi", share: 1.2, fill: 0.5 });
    expect(gs[0].images[1].display).toEqual({ kind: "multi", share: 1.5, fill: 0.8 });
  });

  it("a single row parses |S|W as manual when S=1", () => {
    const gs = detectRowGroups("![[a.webp|1|350]]", 10, "png,jpg,webp");
    expect(gs[0].kind).toBe("single");
    expect(gs[0].images[0].display).toEqual({ kind: "single-manual", widthPx: 350 });
  });
});
