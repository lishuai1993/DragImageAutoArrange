import { describe, it, expect } from "vitest";
import {
  RM_PREVIEW_VIEW_SELECTOR, queryPreviewViewIn, findEmbedByLine,
} from "../src/scrollSync/domLocators";

// The test env is `node` (no real DOM), so we drive the locators with fake
// ParentNode-shaped objects that record the selector they receive. This pins
// the selector strings (the fragile part) without needing jsdom.

function fakeRoot(result: unknown = null) {
  const calls: string[] = [];
  const root = {
    calls,
    querySelector(sel: string) { calls.push(sel); return result; },
  };
  return root as typeof root & ParentNode;
}

describe("RM_PREVIEW_VIEW_SELECTOR", () => {
  it("is the reading-mode preview scroller class", () => {
    expect(RM_PREVIEW_VIEW_SELECTOR).toBe(".markdown-preview-view");
  });
});

describe("queryPreviewViewIn", () => {
  it("queries the container with the preview-view selector", () => {
    const sentinel = {} as HTMLElement;
    const root = fakeRoot(sentinel);
    expect(queryPreviewViewIn(root)).toBe(sentinel);
    expect(root.calls).toEqual([".markdown-preview-view"]);
  });
  it("returns null for a missing container (no throw)", () => {
    expect(queryPreviewViewIn(null)).toBeNull();
    expect(queryPreviewViewIn(undefined)).toBeNull();
  });
  it("returns null when the container has no preview view", () => {
    expect(queryPreviewViewIn(fakeRoot(null))).toBeNull();
  });
});

describe("findEmbedByLine", () => {
  it("builds the data-diaa-line selector for a numeric line", () => {
    const root = fakeRoot(null);
    findEmbedByLine(root, 42);
    expect(root.calls).toEqual(['.internal-embed[data-diaa-line="42"]']);
  });
  it("accepts a string line and returns the matched element", () => {
    const sentinel = {} as HTMLElement;
    const root = fakeRoot(sentinel);
    expect(findEmbedByLine(root, "7")).toBe(sentinel);
    expect(root.calls).toEqual(['.internal-embed[data-diaa-line="7"]']);
  });
});
