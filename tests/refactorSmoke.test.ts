import { describe, it, expect } from "vitest";

// ── Refactor surface smoke test (P0 safety net) ──────────────────────────
// Lightweight contract guard for the upcoming refactor (P1 dead-code →
// P2 extract-common → P3 split-large-files → P4 decouple-timing).
//
// It does NOT expand the Obsidian mock and does NOT assert behavior. It only
// (1) statically imports every module in the refactor crosshair, so a split
//     that breaks an import (missing re-export, circular dep, dropped file)
//     fails the whole suite — exactly the regression class we already hit
//     (tests/__mocks__/obsidian.ts was missing → livePreview.test.ts wouldn't
//     load); and (2) asserts each module is a non-empty ES module (catches a
//     split that empties/destroys a module), plus a few curated critical
//     entry-point names that are most likely to be renamed during extraction.
//
// Keep the module list in sync with the modules actually touched by refactor.

import * as livePreview from "../src/imageRender/livePreview";
import * as rmFlexRow from "../src/imageRender/rmFlexRow";
import * as readingMode from "../src/imageRender/readingMode";
import * as scrollAnchor from "../src/scrollSync/scrollAnchor";
import * as imageRowWidget from "../src/imageRender/imageRowWidget";
import * as layoutEngine from "../src/imageLayout/layoutEngine";
import * as anchorMath from "../src/anchor/anchorMath";
import * as domLocators from "../src/scrollSync/domLocators";
import * as anchorRestoreSession from "../src/anchor/anchorRestoreSession";
import * as anchorSignals from "../src/anchor/anchorSignals";
import * as warmupProbe from "../src/scrollSync/warmupProbe";
import * as warmupScheduler from "../src/scrollSync/warmupScheduler";
import * as rmAlignStore from "../src/imageRender/rmAlignStore";
import * as matchEmbeds from "../src/imageParse/matchEmbeds";
import * as embedRaw from "../src/imageParse/embedRaw";
import * as settings from "../src/settings";
import * as constants from "../src/constants";
import * as utils from "../src/utils";

type Mod = Record<string, unknown>;

const MODULES: Record<string, Mod> = {
  livePreview, rmFlexRow, readingMode, scrollAnchor, imageRowWidget,
  layoutEngine, anchorMath, domLocators, anchorRestoreSession, anchorSignals, warmupProbe, warmupScheduler, rmAlignStore,
  matchEmbeds, settings, constants, utils,
};

describe("refactor surface smoke", () => {
  it("all refactor-target modules import without throwing", () => {
    // If any import above throws (broken re-export, circular dep, missing
    // file after a split), vitest fails this suite at load time.
    expect(true).toBe(true);
  });

  it("each target module stays a non-empty ES module after refactor", () => {
    for (const [name, mod] of Object.entries(MODULES)) {
      expect(mod, `${name} should import as a module object`).toBeTruthy();
      expect(Object.keys(mod).length, `${name} should keep at least one export`).toBeGreaterThan(0);
    }
  });

  it("critical entry-point names survive refactor (update only on intentional rename)", () => {
    const must = (mod: Mod, name: string) =>
      expect(typeof mod[name] !== "undefined", `${mod === scrollAnchor ? "scrollAnchor" : ""} missing ${name}`).toBe(true);
    must(rmFlexRow as Mod, "wrapAsFlexRow");
    must(scrollAnchor as Mod, "driveViewportTransition");
    must(imageRowWidget as Mod, "ImageRowWidget");
    must(layoutEngine as Mod, "computeDividerEquilibrium");
    must(readingMode as Mod, "createReadingModeProcessor");
  });
});
