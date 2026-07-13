import { App, TFile, MarkdownPostProcessorContext } from "obsidian";
import { buildImageLineRe } from "./constants";
import { ImageRowOptions } from "./types";
import { ImageEmbed, parseImageLine } from "./imageDetector";
import { logger } from "./logger";
import { storePendingAlignment, AlignValue } from "./rmAlignStore";
import {
  buildImageRowIndex, setImageRowIndex,
  getScrollAnchor, getFallbackPct,
  setLastAnchor, setLastFallbackPct,
  setRMRenderedFile, getRMDeferredRestoreId, cancelRMDeferredRestore,
  ensureRMScrollTracking,
  restoreContentAnchor, restoreScrollPct,
  captureContentAnchor, computeScrollPct,
  logViewportState,
} from "./scrollAnchor";
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
export function createReadingModeProcessor(
  app: App,
  getOptions: () => ImageRowOptions,
  enabled: () => boolean
) {
  return async (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
    if (!enabled()) return;

    const allInternalEmbeds = Array.from(
      el.querySelectorAll(".internal-embed")
    ) as HTMLElement[];

    // Skip embeds already inside a flex row (from a previous run)
    const freshEmbeds = allInternalEmbeds.filter(
      (e) => !e.closest("[data-diaa-group]")
    );

    // Filter to image embeds by file extension
    const imageEmbeds = freshEmbeds.filter(isImageEmbed);

    logger.debug("ReadingMode processor invoked", {
      sourcePath: ctx.sourcePath,
      totalInternalEmbeds: allInternalEmbeds.length,
      freshEmbeds: freshEmbeds.length,
      imageEmbeds: imageEmbeds.length,
      enabled: enabled(),
    });

    if (imageEmbeds.length === 0) return;

    const options = getOptions();

    // Group consecutive image embeds (buildEmbedGroups returns only groups ≥2).
    const groups = buildEmbedGroups(imageEmbeds, options.maxImagesPerRow);

    const groupedEmbeds = new Set<HTMLElement>(groups.flat());

    // --- Step 0: Parse markdown to recover scale values ---
    let parsedImages: ImageEmbed[] = [];
    try {
      const file = app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (file instanceof TFile) {
        await new Promise(r => setTimeout(r, 0));
        const content = await app.vault.cachedRead(file);
        const re = buildImageLineRe(options.imageExtensions);
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const parsed = parseImageLine(lines[i], i, re);
          if (parsed) parsedImages.push(parsed);
        }
        setImageRowIndex(ctx.sourcePath, buildImageRowIndex(lines, re));
        logger.debug("ReadingMode parsed markdown", {
          filePath: file.path,
          totalLines: lines.length,
          parsedCount: parsedImages.length,
          parsed: parsedImages.map(p => ({
            line: p.line,
            fileName: p.fileName,
            alignment: p.alignment,
            hasExplicitWidth: p.hasExplicitWidth,
            explicitWidth: p.explicitWidth,
            flexGrow: p.flexGrow,
            scale: p.scale,
            rawSnippet: p.raw.trim().slice(0, 80),
          })),
        });
      } else {
        logger.debug("ReadingMode file not found or not TFile", {
          sourcePath: ctx.sourcePath,
          abstractFile: String(file),
        });
      }
    } catch (e) {
      logger.warn("ReadingMode failed to read file for scale data", { error: String(e) });
    }

    // Match parsed params to DOM embeds via SECTION-LOCAL source line numbers.
    // The post-processor only guarantees the local `el`; sections may be
    // rendered detached from the document, so document.querySelectorAll is
    // unreliable (returns 0 → every global index is -1 → no attrs applied).
    // ctx.getSectionInfo(el) gives this section's [lineStart, lineEnd], letting
    // us scope candidates to the section and zip them to the section's embeds
    // in source order — independent of whether `el` is attached to the document.
    const sectionInfo = ctx.getSectionInfo(el);
    const candidates: ImageEmbed[] = sectionInfo
      ? parsedImages.filter(
          (p) => p.line >= sectionInfo.lineStart && p.line <= sectionInfo.lineEnd
        )
      : parsedImages;

    let matchCount = 0;
    let flexGrowSetCount = 0;
    let cursor = 0;
    for (const embed of imageEmbeds) {
      const embedFn = getFileNameFromEmbed(embed);
      // Prefer positional match within the section; if the filename is known,
      // seek forward to sync (skips any already-wrapped embeds from a prior run).
      let parsed: ImageEmbed | undefined = candidates[cursor];
      if (embedFn) {
        let k = cursor;
        while (k < candidates.length && candidates[k].fileName !== embedFn) k++;
        if (k < candidates.length) {
          parsed = candidates[k];
          cursor = k;
        }
      }
      cursor++;
      if (!parsed) continue;
      logger.debug("ReadingMode attr-set", {
        line: parsed.line,
        embedFn,
        parsedFn: parsed.fileName,
        set: {
          alignment: parsed.alignment ?? "(default)",
          flexGrow: parsed.hasExplicitWidth ? parsed.flexGrow : "(none)",
          scale: parsed.scale ?? "(none)",
        },
      });
      if (parsed.hasExplicitWidth) {
        embed.setAttribute("data-diaa-flexgrow", String(parsed.flexGrow));
        flexGrowSetCount++;
      }
      if (parsed.scale != null) {
        embed.setAttribute("data-diaa-scale", String(parsed.scale));
        matchCount++;
      }
      if (parsed.alignment) {
        embed.setAttribute("data-diaa-alignment", parsed.alignment);
      }
      embed.setAttribute("data-diaa-line", String(parsed.line));
    }
    logger.debug("ReadingMode scale matching", {
      domEmbeds: imageEmbeds.length,
      sectionLines: sectionInfo ? `${sectionInfo.lineStart}-${sectionInfo.lineEnd}` : "(null)",
      candidates: candidates.length,
      parsedImages: parsedImages.length,
      matched: matchCount,
      flexGrowSet: flexGrowSetCount,
    });

    // Apply alignment to standalone single images
    for (const embed of imageEmbeds) {
      if (!groupedEmbeds.has(embed)) {
        applyStandaloneAlignment(embed, options.alignment);
        const img = embed.querySelector<HTMLImageElement>("img");
        if (img) {
          (img as any).__diaa_alignment = (embed.getAttribute("data-diaa-alignment") || undefined) as "left" | "center" | "right" | undefined;
          (img as any).__diaa_onAlign = (newAlign: "left" | "center" | "right" | undefined) => {
            if (newAlign) {
              embed.setAttribute("data-diaa-alignment", newAlign);
            } else {
              embed.removeAttribute("data-diaa-alignment");
            }
            (img as any).__diaa_alignment = newAlign;
            applyStandaloneAlignment(embed, options.alignment);
            if (app && ctx.sourcePath) {
              const effectiveAlign = (newAlign ?? options.alignment) as AlignValue;
              const fn = getFileNameFromEmbed(embed);
              if (fn) storePendingAlignment(ctx.sourcePath, fn, effectiveAlign);
            }
          };
        }
      }
    }

    logger.debug("ReadingMode processor", {
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

    logViewportState(app, "post-processor");

    const afterRender = () => {
      if (getRMDeferredRestoreId() !== null) {
        cancelRMDeferredRestore();
      }
      if (getScrollAnchor()) {
        restoreContentAnchor(app);
      } else if (getFallbackPct() >= 0) {
        restoreScrollPct(app);
      }
      const anchor = captureContentAnchor(app);
      if (anchor) {
        setLastAnchor(anchor, ctx.sourcePath);
      }
      const pct = computeScrollPct(app);
      if (pct >= 0) setLastFallbackPct(pct);
      ensureRMScrollTracking(app);
      setRMRenderedFile(ctx.sourcePath);
      logViewportState(app, "rm-after-restore");
    };
    if (wrapPromises.length > 0) {
      Promise.all(wrapPromises).then(afterRender);
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
