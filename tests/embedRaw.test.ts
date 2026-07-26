import { describe, it, expect } from "vitest";
import { stripEmbedParams, parseEmbedParams } from "../src/embedRaw";

describe("stripEmbedParams", () => {
  it("strips a single width param", () => {
    expect(stripEmbedParams("![[image.png|200]]")).toBe("![[image.png]]");
  });
  it("strips WxH dimensions", () => {
    expect(stripEmbedParams("![[image.png|800x600]]")).toBe("![[image.png]]");
  });
  it("strips combined |W|S params", () => {
    expect(stripEmbedParams("![[image.png|200|48]]")).toBe("![[image.png]]");
  });
  it("strips |alignment|S|W params", () => {
    expect(stripEmbedParams("![[image.png|center|0|350]]")).toBe("![[image.png]]");
  });
  it("is idempotent on an already-bare embed", () => {
    expect(stripEmbedParams("![[image.png]]")).toBe("![[image.png]]");
  });
  it("only strips from the first pipe (matches legacy normalizeRaw edge case)", () => {
    // [^\]]* matches "file|name.png|200", so everything after the first | goes.
    expect(stripEmbedParams("![[file|name.png|200]]")).toBe("![[file]]");
  });
});

describe("parseEmbedParams", () => {
  it("returns null for a bare embed (no pipe section)", () => {
    expect(parseEmbedParams("![[image.png]]")).toBeNull();
  });
  it("splits a single param", () => {
    expect(parseEmbedParams("![[image.png|200]]")).toEqual(["200"]);
  });
  it("splits multiple params in order", () => {
    expect(parseEmbedParams("![[image.png|200|48]]")).toEqual(["200", "48"]);
    expect(parseEmbedParams("![[image.png|center|0|350]]")).toEqual(["center", "0", "350"]);
  });
  it("yields [\"\"] for an empty pipe param", () => {
    expect(parseEmbedParams("![[image.png|]]")).toEqual([""]);
  });
  it("round-trips with stripEmbedParams (strip then no params)", () => {
    const bare = stripEmbedParams("![[a.webp|740|48]]");
    expect(parseEmbedParams(bare)).toBeNull();
  });
});
