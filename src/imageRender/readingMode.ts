import { App, TFile, MarkdownPostProcessorContext } from "obsidian";
import { buildImageLineRe } from "../constants";
import { ImageRowOptions } from "../types";
import { detectRowGroups } from "../imageParse/imageDetector";
import type { RowImage } from "../imageParse/rowParams";
import { matchEmbedsToParsed } from "../imageParse/matchEmbeds";
import { logger } from "../logger";
const log = logger.channel("readingMode");
import { storePendingAlignment } from "./rmAlignStore";
import { attachDiaImageMarkers } from "./imageMarkers";
import {
  setImageRowIndex, setImageLineRe,
  getScrollAnchor, getFallbackPct,
  setLastAnchor, setLastFallbackPct,
  getRMDeferredRestoreId, cancelRMDeferredRestore,
  ensureRMScrollTracking,
  restoreContentAnchor, restoreScrollPct,
  captureContentAnchor, computeScrollPct,
  startRMSettleHold,
  driveViewportTransition,
} from "../scrollSync/scrollAnchor";
import { buildImageRowIndex, toLine1 } from "../anchor/viewportAnchor";
import {
  getFileNameFromEmbed, isImageEmbed,
  applyStandaloneAlignment,
  areEmbedsConsecutive,
  waitForImagesThenWrap, makeImagesDraggable,
} from "./rmFlexRow";

/**
 * Create a MarkdownPostProcessor that:
 * 1. Auto-detects consecutive image embeds and renders them as a flex row.
 * 2. Makes standalone images draggable — drop near another image to merge.
 * 3. Within a flex row, images are draggable for reorder.
 */
// Per-section re-entrancy guard: the post-processor fires per section, and
// image wrapping can trigger DOM mutations that cause Obsidian to re-invoke it
// within the same tick. Prevent duplicate runs for the same section element.
// L2: declared `let` so a warmup (background) render pass can release its marks
// via releasePostProcessingMarks() — otherwise a warmup that touched-but-did-not-
// finish-wrapping a section permanently blocks the subsequent real RM render
// (cross-pass mark leak). See warmupProbe.finish() / L3.
let _postProcessing = new WeakSet<HTMLElement>();

/**
 * L2/L3: release re-entry marks accumulated during a warmup render pass.
 * Called from warmupProbe.finish() so sections a warmup touched but did not fully
 * wrap are no longer skipped by the real RM render. Sections already fully wrapped
 * stay skipped via the L1 completion-marker short-circuit in the processor entry.
 */
export function releasePostProcessingMarks(): void {
  _postProcessing = new WeakSet<HTMLElement>();
}

export function createReadingModeProcessor(
  app: App,
  getOptions: () => ImageRowOptions
) {
  return async (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
    // L1: short-circuit sections already fully rendered. wrapAsFlexRow produces a
    // [data-diaa-group] wrapper (rmFlexRow.ts) for >=2-image rows;
    // applyStandaloneAlignment produces a [data-diaa-standalone] wrapper for single
    // images. Presence of either means a prior pass already wrapped this section,
    // so skip to avoid double-wrap. This also makes the guard state-aware: a warmup
    // pass that completed wrapping is correctly skipped even after L2 resets the
    // WeakSet (only incomplete sections get reprocessed).
    if (el.querySelector("[data-diaa-group], [data-diaa-standalone]")) {
      log.debug("ReadingMode processor skipped", {
        reason: "already-wrapped", sourcePath: ctx.sourcePath,
      });
      return;
    }
    // Intra-pass dedup: Obsidian may re-invoke the post-processor for the same
    // section element within the same tick (129b2aa fix preserved). The WeakSet is
    // reset between render passes by releasePostProcessingMarks() (L2/L3).
    if (_postProcessing.has(el)) return;
    _postProcessing.add(el);

    const allInternalEmbeds = Array.from(
      el.querySelectorAll<HTMLElement>(".internal-embed")
    );

    // Skip embeds already inside a flex row (from a previous run)
    const freshEmbeds = allInternalEmbeds.filter(
      (e) => !e.closest("[data-diaa-group]")
    );

    // Filter to image embeds by file extension
    const imageEmbeds = freshEmbeds.filter(isImageEmbed);

    log.debug("ReadingMode processor invoked", {
      sourcePath: ctx.sourcePath,
      totalInternalEmbeds: allInternalEmbeds.length,
      freshEmbeds: freshEmbeds.length,
      imageEmbeds: imageEmbeds.length,
    });

    if (imageEmbeds.length === 0) { return; }

    const options = getOptions();

    // Group consecutive image embeds (buildEmbedGroups returns only groups ≥2).
    const groups = buildEmbedGroups(imageEmbeds, options.maxImagesPerRow);

    const groupedEmbeds = new Set<HTMLElement>(groups.flat());

    // --- Step 0: Parse markdown to recover scale values ---
    let parsedImages: RowImage[] = [];
    try {
      const file = app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (file instanceof TFile) {
        await new Promise(r => window.setTimeout(r, 0));
        const content = await app.vault.cachedRead(file);
        const re = buildImageLineRe(options.imageExtensions);
        // Register the configured image-line regex so scrollAnchor's capture /
        // classification / diagnostics all honor the user's imageExtensions
        // identically (single source of truth — see setImageLineRe).
        setImageLineRe(re);
        const lines = content.split("\n");
        // Classify consecutive image lines into typed rows (detectRowGroups) and
        // flatten to one RowImage per source image line, in source order — the
        // exact membership a per-line embed-regex scan would produce, but
        // under the unified single/multi display model.
        const rows = detectRowGroups(content, options.maxImagesPerRow, options.imageExtensions);
        for (const group of rows) parsedImages.push(...group.images);
        setImageRowIndex(ctx.sourcePath, buildImageRowIndex(lines, re));
        log.debug("ReadingMode parsed markdown", {
          filePath: file.path,
          totalLines: lines.length,
          parsedCount: parsedImages.length,
          parsed: parsedImages.map(p => ({
            line: p.line,
            fileName: p.fileName,
            alignment: p.alignment,
            hasSizing: p.hasSizing,
            display: p.display,
            rawSnippet: p.raw.trim().slice(0, 80),
          })),
        });
      } else {
        log.debug("ReadingMode file not found or not TFile", {
          sourcePath: ctx.sourcePath,
          abstractFile: file?.path ?? "(none)",
        });
      }
    } catch (e) {
      log.warn("ReadingMode failed to read file for scale data", { error: String(e) });
    }

    // Match parsed params to DOM embeds via SECTION-LOCAL source line numbers.
    // The post-processor only guarantees the local `el`; sections may be
    // rendered detached from the document, so document.querySelectorAll is
    // unreliable (returns 0 → every global index is -1 → no attrs applied).
    // ctx.getSectionInfo(el) gives this section's [lineStart, lineEnd], letting
    // us scope candidates to the section and zip them to the section's embeds
    // in source order — independent of whether `el` is attached to the document.
    const sectionInfo = ctx.getSectionInfo(el);
    const candidates: RowImage[] = sectionInfo
      ? parsedImages.filter(
          (p) => p.line >= sectionInfo.lineStart && p.line <= sectionInfo.lineEnd
        )
      : parsedImages;

    // Delegate the matching policy + integrity check to a pure, unit-tested
    // function (see src/matchEmbeds.ts). Keeps the invariants under CI so a
    // future refactor that breaks alignment fails a test instead of silently
    // rendering defaults.
    const embedFileNames = imageEmbeds.map((e) => getFileNameFromEmbed(e) || null);
    const { matches, mismatches, usedFallback } = matchEmbedsToParsed(
      embedFileNames,
      candidates,
      parsedImages
    );

    // Runtime invariant guard: convert silent failure into an observable WARN
    // in log.txt. usedFallback means section-scoped matching disagreed with the
    // embeds and we degraded to a filename-only global match.
    if (usedFallback || mismatches > 0) {
      log.warn("RM match integrity FAILED", {
        sourcePath: ctx.sourcePath,
        usedFallback,
        mismatches,
        sectionLines: sectionInfo ? `${sectionInfo.lineStart}-${sectionInfo.lineEnd}` : "(null)",
        embedFileNames,
        candidates: candidates.map((c) => c.fileName),
      });
    }

    let matchCount = 0;
    let flexGrowSetCount = 0;
    for (let i = 0; i < imageEmbeds.length; i++) {
      const embed = imageEmbeds[i];
      const parsed = matches[i];
      if (!parsed) continue;
      log.debug("ReadingMode attr-set", {
        line: parsed.line,
        embedFn: embedFileNames[i],
        parsedFn: parsed.fileName,
        set: {
          alignment: parsed.alignment ?? "(default)",
          kind: parsed.display.kind,
          grow: parsed.display.kind === "multi" && parsed.hasSizing
            ? String(parsed.display.share)
            : "(none)",
          scale: parsed.display.kind === "multi" && parsed.display.fill != null
            ? String(parsed.display.fill)
            : "(none)",
        },
      });
      if (parsed.display.kind === "multi") {
        // Multi-row members carry grow/fill in |share码|fill码|; a single row's
        // |S|W belongs to no flex group here, so it emits no grow/fill attrs
        // (nothing in RM reads them for standalone rows).
        if (parsed.hasSizing) {
          embed.setAttribute("data-diaa-flexgrow", String(parsed.display.share));
          flexGrowSetCount++;
        }
        if (parsed.display.fill != null) {
          embed.setAttribute("data-diaa-scale", String(parsed.display.fill));
          matchCount++;
        }
      }
      if (parsed.alignment) {
        embed.setAttribute("data-diaa-alignment", parsed.alignment);
      }
      // 1-based source line, to match ImageRowIndex.startLine/endLine (which
      // scrollAnchor.ts uses for every data-diaa-line query and range check).
      // toLine1 is the single, greppable 0→1 conversion point: parsed.line is
      // 0-based, and Line1 makes any accidental 0-based write a type error.
      // Keeping these bases in sync is a load-bearing contract: a mismatch
      // silently breaks RM scroll anchoring.
      embed.setAttribute("data-diaa-line", String(toLine1(parsed.line)));
    }
    log.debug("ReadingMode scale matching", {
      domEmbeds: imageEmbeds.length,
      sectionLines: sectionInfo ? `${sectionInfo.lineStart}-${sectionInfo.lineEnd}` : "(null)",
      candidates: candidates.length,
      parsedImages: parsedImages.length,
      matched: matchCount,
      flexGrowSet: flexGrowSetCount,
      usedFallback,
    });

    // Apply alignment to standalone single images
    for (let i = 0; i < imageEmbeds.length; i++) {
      const embed = imageEmbeds[i];
      if (!groupedEmbeds.has(embed)) {
        applyStandaloneAlignment(embed, options.alignment);
        const img = embed.querySelector<HTMLImageElement>("img");
        if (img) {
          img.__diaa_alignment = (embed.getAttribute("data-diaa-alignment") || undefined) as "left" | "center" | "right" | undefined;
          img.__diaa_onAlign = (newAlign: "left" | "center" | "right" | undefined) => {
            if (newAlign) {
              embed.setAttribute("data-diaa-alignment", newAlign);
            } else {
              embed.removeAttribute("data-diaa-alignment");
            }
            img.__diaa_alignment = newAlign;
            applyStandaloneAlignment(embed, options.alignment);
            if (app && ctx.sourcePath) {
              const effectiveAlign = newAlign ?? options.alignment;
              const fn = getFileNameFromEmbed(embed);
              if (fn) storePendingAlignment(ctx.sourcePath, fn, effectiveAlign);
            }
          };
          // Read-only resize surface so RM renders the size rows greyed-out.
          // manualSingle comes straight from the typed parse (matches[i] is the
          // RowImage this embed matched), not from re-reading a data-diaa-scale
          // attr — single rows carry no scale slot under the unified model.
          const parsed = matches[i];
          attachDiaImageMarkers(img, {
            resizeEnabled: options.enableResize,
            naturalWidth: () => img.naturalWidth || 0,
            manualSingle: () =>
              parsed != null && parsed.display.kind === "single-manual",
            singleRow: () => true,
            resetTargetWidth: () => img.naturalWidth || 0,
            onResize: null,
            resetSingleManual: null,
          });
        }
      }
    }

    log.debug("ReadingMode processor", {
      embedCount: imageEmbeds.length,
      groupCount: groups.length,
      sourcePath: ctx.sourcePath,
      groups: groups.map((g) => g.length),
      scaleMatches: imageEmbeds.filter((e) => e.hasAttribute("data-diaa-scale")).length,
    });

    // --- Step 2: Wait for images then wrap ---
    const wrapPromises: Promise<void>[] = [];
    for (const group of groups) {
      if (group.length >= 2) {
        wrapPromises.push(waitForImagesThenWrap(group, options, app, ctx.sourcePath));
      }
    }

    // --- Step 3: Make ALL image items draggable for merge/reorder ---
    makeImagesDraggable(app, ctx.sourcePath, imageEmbeds);

    driveViewportTransition(app, "post-processor");

    const afterRender = () => {
      let restored = false;
      const seedAnchor = getScrollAnchor(); // consumed on success — snapshot for the settle-hold
      if (seedAnchor) {
        restored = restoreContentAnchor(app);
        // A cold-render restore is not final: the layout keeps settling and
        // slides the content away under a frozen scrollTop. The settle-hold
        // re-pins the anchor per frame until the height ledger is calm.
        if (restored) startRMSettleHold(app, seedAnchor);
      } else if (getFallbackPct() >= 0) {
        // restoreScrollPct now reports whether the write landed (a cold RM
        // scroller has no scroll space yet) — only a real write may cancel
        // the deferred retry loop below.
        restored = restoreScrollPct(app);
      }
      // Stop the deferred RM retry loop only once the anchor is actually
      // resolved. If this section's render didn't contain the target row, let
      // the loop keep retrying (and coarse-scrolling) until the row exists.
      if (restored && getRMDeferredRestoreId() !== null) {
        cancelRMDeferredRestore();
      }
      const anchor = captureContentAnchor(app);
      // Pass through even when null: setLastAnchor(null) clears any stale RM
      // anchor so a later mode switch won't reuse an unrelated image row.
      setLastAnchor(anchor, ctx.sourcePath);
      const pct = computeScrollPct(app);
      if (pct >= 0) setLastFallbackPct(pct);
      ensureRMScrollTracking(app);
      driveViewportTransition(app, "rm-after-restore");
    };
    if (wrapPromises.length > 0) {
      void Promise.all(wrapPromises).then(afterRender);
    } else {
      afterRender();
    }
  };
}

// ── Group detection ──────────────────────────────────────────

function buildEmbedGroups(embeds: HTMLElement[], maxPerRow: number): HTMLElement[][] {
  const groups: HTMLElement[][] = [];
  let current: HTMLElement[] = [];

  const flushGroup = () => {
    while (current.length > maxPerRow) {
      groups.push(current.slice(0, maxPerRow));
      current = current.slice(maxPerRow);
    }
    if (current.length >= 2) groups.push([...current]);
    current = [];
  };

  for (let i = 0; i < embeds.length; i++) {
    const embed = embeds[i];

    if (current.length === 0) {
      current.push(embed);
      continue;
    }

    const prev = current[current.length - 1];
    const consecutive = areEmbedsConsecutive(prev, embed);

    if (consecutive) {
      current.push(embed);
    } else {
      flushGroup();
      current = [embed];
    }
  }
  flushGroup();

  return groups;
}
