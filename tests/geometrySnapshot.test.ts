import { describe, expect, it } from "vitest";
import {
  FAIL,
  isQuarterTurn,
  memberFailures,
  predictedPaint,
  quarterTurnFitScale,
  scaleOfTransform,
  snapshotPayload,
  type MemberFrames,
} from "../src/diagnostics/rowSnapshot";

/** A frame set that satisfies every invariant, so each test can perturb exactly
 *  one link of the chain and assert the code it names. */
function frames(overrides: {
  model?: Partial<MemberFrames["model"]>;
  wrote?: Partial<MemberFrames["wrote"]>;
  measured?: Partial<MemberFrames["measured"]>;
} = {}): MemberFrames {
  const model = {
    fill: null as number | null,
    share: null as number | null,
    word: "orig",
    aspect: 2,
    boxW: 200,
    boxH: 100,
    drawn: 100,
    expectedScale: null as number | null,
    ...overrides.model,
  };
  return {
    label: "0:test.png",
    model,
    wrote: { imgW: 200, imgH: 100, itemW: null, itemH: 100, imgTransform: "", ...overrides.wrote },
    measured: {
      itemW: 200,
      itemH: 100,
      imgClientW: 200,
      imgClientH: 100,
      paintW: 200,
      paintH: 100,
      paintOffsetX: 0,
      paintOffsetY: 0,
      transform: "none",
      display: "block",
      ...overrides.measured,
    },
  };
}

describe("orientation helpers", () => {
  it("reads a quarter turn out of the word form", () => {
    expect(isQuarterTurn("r90")).toBe(true);
    expect(isQuarterTurn("r270fh")).toBe(true);
    expect(isQuarterTurn("r180")).toBe(false);
    expect(isQuarterTurn("fv")).toBe(false);
    expect(isQuarterTurn("orig")).toBe(false);
    expect(isQuarterTurn("bogus")).toBe(false);
  });

  it("keeps the fit scale inside the box and never magnifies", () => {
    expect(quarterTurnFitScale(200, 100)).toBe(0.5);
    expect(quarterTurnFitScale(100, 200)).toBe(0.5);
    expect(quarterTurnFitScale(100, 100)).toBe(1);
    expect(quarterTurnFitScale(0, 100)).toBe(1);
  });
});

describe("predictedPaint", () => {
  it("paints the box itself on an even orientation", () => {
    expect(predictedPaint(frames().model)).toEqual({ width: 200, height: 100 });
  });

  it("swaps and fits a quarter turn's drawing", () => {
    const model = frames({ model: { word: "r270", boxW: 200, boxH: 100 } }).model;
    expect(predictedPaint(model)).toEqual({ width: 50, height: 100 });
  });

  it("honours an explicit fit scale over the box's own", () => {
    const model = frames({
      model: { word: "r270", boxW: 200, boxH: 100, expectedScale: 0.25 },
    }).model;
    expect(predictedPaint(model)).toEqual({ width: 25, height: 50 });
  });
});

describe("scaleOfTransform", () => {
  it("has no scale when there is no transform", () => {
    expect(scaleOfTransform("none")).toBeNull();
    expect(scaleOfTransform("")).toBeNull();
  });

  it("reads 1 out of a pure rotation matrix", () => {
    expect(scaleOfTransform("matrix(0, -1, 1, 0, 0, 0)")).toBe(1);
  });

  it("reads a uniform scale out of a scaled rotation matrix", () => {
    expect(scaleOfTransform("matrix(0, -0.75, 0.75, 0, 0, 0)")).toBe(0.75);
  });

  it("reads a leading scale function", () => {
    expect(scaleOfTransform("scale(0.7645) rotate(270deg)")).toBe(0.7645);
  });
});

describe("memberFailures", () => {
  it("reports nothing when the three frames agree", () => {
    expect(memberFailures(frames())).toEqual([]);
  });

  it("names the write when a value other than the model's landed on the img", () => {
    const f = frames({ wrote: { imgH: 624 } });
    expect(memberFailures(f)).toContain(FAIL.boxWrite);
  });

  it("names survival when the box height on screen is not the model's", () => {
    const f = frames({ measured: { imgClientH: 624 } });
    expect(memberFailures(f)).toContain(FAIL.boxSurvived);
  });

  it("names a clamped box width", () => {
    const f = frames({ measured: { imgClientW: 120 } });
    expect(memberFailures(f)).toContain(FAIL.boxWidth);
  });

  it("names a missing transform on a quarter turn", () => {
    const f = frames({ model: { word: "r270", expectedScale: 1 } });
    expect(memberFailures(f)).toContain(FAIL.transformMissing);
  });

  it("names a transform scale that is not the one expected", () => {
    const f = frames({
      model: { word: "r270", expectedScale: 1 },
      measured: { transform: "matrix(0, -0.5, 0.5, 0, 0, 0)" },
    });
    expect(memberFailures(f)).toContain(FAIL.transformScale);
  });

  it("names a drawing that is not the size the model predicted", () => {
    const f = frames({ measured: { paintH: 160 } });
    expect(memberFailures(f)).toContain(FAIL.paintMismatch);
  });

  it("names a container that does not take the drawn height", () => {
    const f = frames({ measured: { itemH: 365 } });
    expect(memberFailures(f)).toContain(FAIL.slotHeight);
  });

  it("names a drawing that does not honour the fill ratio", () => {
    const f = frames({
      model: { fill: 0.8, word: "r270", boxW: 200, boxH: 100, drawn: 100 },
      measured: { paintW: 120, paintH: 100, itemH: 100, imgClientH: 100, transform: "matrix(0,-1,1,0,0,0)" },
    });
    expect(memberFailures(f)).toContain(FAIL.fillArithmetic);
  });

  it("names a drawing that spills out of its container", () => {
    const f = frames({ measured: { paintOffsetY: -8 } });
    expect(memberFailures(f)).toContain(FAIL.paintOverflow);
  });

  it("tolerates sub-pixel disagreement", () => {
    const f = frames({ measured: { imgClientH: 100.4, itemH: 100.3 } });
    expect(memberFailures(f)).toEqual([]);
  });
});

describe("snapshotPayload", () => {
  it("carries the verdict and the frames", () => {
    const payload = snapshotPayload(frames({ measured: { itemH: 365 } }));
    expect(payload.ok).toBe(false);
    expect(payload.fails).toEqual([FAIL.slotHeight]);
    expect(payload.label).toBe("0:test.png");
    expect(payload.measured).toMatchObject({ item: [200, 365] });
  });
});
