import { App, TFile, MarkdownPostProcessorContext } from "obsidian";
import { CLASSES, buildImageLineRe } from "../constants";
import { ImageRowOptions } from "../types";
import { detectRowGroups } from "../imageParse/imageDetector";
import type { RowImage } from "../imageParse/rowParams";
import { matchEmbedsToParsed } from "../imageParse/matchEmbeds";
import { viewInternals } from "../obsidianInternals";
import { logger } from "../logger";
const log = logger.channel("readingMode");
import { storePendingAlignment } from "./rmAlignStore";
// TEMP-DIAG: alignment/flash probes — delete with the probe module.
import {
  diagAlign, diagAlignFrames, diagFlashSeen, diagFlashWatchStart,
} from "../diagnostics/tmpAlignFlashProbe";
import { attachDiaImageMarkers } from "./imageMarkers";
import {
  isIdentityOrientation,
  orientationWord,
} from "../imageTransform/orientation";
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
  getFileNameFromEmbed, embedLine1, isImageEmbed,
  applyStandaloneAlignment, applyStandaloneSize,
  areEmbedsConsecutive,
  waitForImagesThenWrap, makeImagesDraggable,
} from "./rmFlexRow";

/**
 * The persistent per-section guard: a block holding one of our wrappers has
 * been rendered.  `wrapAsFlexRow` writes `[data-diaa-group]` onto a >=2-image
 * row's wrapper and `applyStandaloneAlignment` writes `[data-diaa-standalone]`
 * onto a single image's, so either means a finished pass.
 *
 * Kept narrow on purpose.  This decides whether a section is skipped for good,
 * so a marker that only means "our picture is somewhere inside" would freeze
 * sections the pass still has to lay out; the flash strip, which wants exactly
 * that looser question, asks it separately (`holdsDiaaPicture`).
 */
function isRenderedBlock(el: HTMLElement): boolean {
  return el.querySelector("[data-diaa-group], [data-diaa-standalone]") !== null;
}

// In-flight guard, not a completion mark.  This handler awaits vault I/O and
// image loads, so Obsidian can re-invoke the post-processor for the same section
// while the first run is still going; the mark lives for that run and no longer
// (see `SectionPass` for the part of the run that outlasts the handler).  A
// *persistent* mark is what `isRenderedBlock` already gives us, and keeping one
// here is what loses a section: Obsidian rebuilds a section's children in place,
// so a section rendered before but not wrapped now comes back wrapper-less (the
// persistent check passes) while a leftover mark would still bail on it —
// silently, before the "invoked" log — leaving the real reading view to render
// that section natively (the images stack vertically, and the mode-switch flash
// then has no row marker to be stripped by, so it shows in the blank space).
const _inFlight = new WeakSet<HTMLElement>();

/** Whether a render of `el` is in flight right now. Exported for its test. */
export function isRenderInFlight(el: HTMLElement): boolean {
  return _inFlight.has(el);
}

/** A section pass's handle.  The handler returns as soon as the DOM is ours, but
 *  its images may still be loading and its row still to be wrapped; `tail` is
 *  where it names that leftover work, so the guard can hold the mark for it. */
export interface SectionPass {
  tail: Promise<void> | null;
}

/** Run a section handler under the guard pair above.  Exported for its own
 *  regression test — the defect it fixes is invisible from the outside. */
export function guardSection(
  handler: (
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext,
    pass: SectionPass
  ) => Promise<void>
): (el: HTMLElement, ctx: MarkdownPostProcessorContext) => Promise<void> {
  return async (el, ctx) => {
    if (isRenderedBlock(el)) {
      log.debug("ReadingMode processor skipped", {
        reason: "already-wrapped", sourcePath: ctx.sourcePath,
      });
      return;
    }
    if (_inFlight.has(el)) {
      log.debug("ReadingMode processor skipped", {
        reason: "in-flight", sourcePath: ctx.sourcePath,
      });
      return;
    }
    _inFlight.add(el);
    const pass: SectionPass = { tail: null };
    try {
      await handler(el, ctx, pass);
    } catch (e) {
      _inFlight.delete(el);
      throw e;
    }
    // Hold the mark until the pass's tail settles: a re-invoke in that window
    // would see the embeds still unwrapped and wrap them a second time.
    const tail = pass.tail ?? Promise.resolve();
    void tail.then(
      () => _inFlight.delete(el),
      () => _inFlight.delete(el)
    );
  };
}

// ── Obsidian's mode-switch flash, kept off the rows ────────────────────
// Restoring the reading view's scroll position highlights the block at the
// target line by adding `.is-flashing`, which paints
// `background-color: var(--text-highlight-bg) !important` — amber under most
// themes — and drops the class three seconds later (obsidian.asar).  The band
// is painted by the flashing element itself, so its pictures cover it and only
// the image-free parts of the block show through: for a flex row that is the
// letterbox inside each slot plus the gaps beside them, which is exactly where
// the user sees a yellow blink on a mode switch.  An `!important` background on
// an ancestor cannot be outranked from a descendant, so the class is what has to
// go — and since it is applied *after* the section is rendered, clearing it in
// this pass is not enough: watch for it for as long as the flash can live.

const FLASH_CLASS = "is-flashing";
/** The flash's own lifetime in Obsidian is 3s; watch slightly past it. */
const FLASH_WATCH_MS = 3500;
/** Catch-up sweep period.  The observer below removes a flash in the same task
 *  that adds it, but a row can still be mid-wrap when the flash lands (the row
 *  marker is a precondition of the strip), so the window is also swept. */
const FLASH_SWEEP_MS = 150;

let _flashObserver: MutationObserver | null = null;
let _flashSweep: number | null = null;

/**
 * The flash strip's own predicate — deliberately not `isRenderedBlock`.  That
 * one doubles as the section entry guard, where every extra class that counts as
 * "already rendered" is a section that will never be rendered at all.  The strip
 * only has to know that a picture of ours will be painted over, and the
 * commonest single-image row leaves no wrapper behind: a pure image block is
 * sized in place, with the marker going onto the *embed* (`diaa-row-inline`), so
 * the block holding it carries neither `data-diaa-*` attribute and the amber
 * band along the block's edge had nobody to clear it.
 *
 * The marker alone is not enough to answer that either.  Obsidian flashes the
 * restored scroll line as it builds the section, which is before this pass has
 * wrapped or marked anything: at that moment the block holds a bare image embed
 * and the marker arrives a beat later, so a marker-only test declines the flash
 * and leaves the band to the sweep.  An image embed is therefore ours to clear
 * from the moment it exists — `image-embed` is Obsidian's own class on one, the
 * same marker the drop path keys on.  A block of text, or one holding a note
 * embed, keeps its flash: the strip is about what the band would cover.
 */
function holdsDiaaPicture(el: HTMLElement): boolean {
  const sel = `[data-diaa-group], [data-diaa-standalone], .${CLASSES.rowInline}`;
  if (el.matches(sel) || el.querySelector(sel) !== null) return true;
  return el.matches(".image-embed") || el.querySelector(".image-embed") !== null;
}

/** `phase` names the caller, so the log can tell a band the strip met at the
 *  moment it was added from one it only caught on a later sweep. */
function stripFlashFromRows(root: HTMLElement, phase: string): void {
  // The root is a candidate itself: the section render hands in the section
  // element, which is the block Obsidian flashes when the restore points at its
  // first line.
  const flashing: HTMLElement[] = root.classList.contains(FLASH_CLASS) ? [root] : [];
  flashing.push(...Array.from(root.querySelectorAll<HTMLElement>(`.${FLASH_CLASS}`)));
  for (const el of flashing) {
    const ours = holdsDiaaPicture(el);
    // TEMP-DIAG: record what the strip did, so a band the user still sees can be
    // told apart from a band nobody ever claimed.
    diagFlashSeen(el, `${phase}:${ours ? "stripped" : "not-ours"}`);
    if (ours) el.classList.remove(FLASH_CLASS);
  }
}

function stopFlashWatch(): void {
  _flashObserver?.disconnect();
  _flashObserver = null;
  if (_flashSweep !== null) {
    window.clearInterval(_flashSweep);
    _flashSweep = null;
  }
}

/** Clear the mode-switch flash from any block holding a flex row, and keep
 *  clearing it while the flash can still arrive.  Idempotent: the watch is
 *  shared, so repeated calls from a multi-section document only sweep. */
export function suppressRowFlash(): void {
  if (typeof window === "undefined") return;
  // TEMP-DIAG: the shadow watch starts here (same moment as the strip's own
  // window) and keeps recording past it.
  diagFlashWatchStart(
    getComputedStyle(document.documentElement).getPropertyValue("--text-highlight-bg")
  );
  stripFlashFromRows(document.body, "mode-switch");
  if (_flashObserver) return;
  _flashObserver = new MutationObserver((records) => {
    for (const r of records) {
      const target = r.target as HTMLElement | null;
      if (!target?.classList?.contains(FLASH_CLASS)) continue;
      const ours = holdsDiaaPicture(target);
      diagFlashSeen(target, ours ? "observed-stripped" : "observed-not-ours");
      if (ours) target.classList.remove(FLASH_CLASS);
    }
  });
  _flashObserver.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["class"],
  });
  _flashSweep = window.setInterval(
    () => stripFlashFromRows(document.body, "sweep"),
    FLASH_SWEEP_MS
  );
  window.setTimeout(stopFlashWatch, FLASH_WATCH_MS);
}

/**
 * Create a MarkdownPostProcessor that:
 * 1. Auto-detects consecutive image embeds and renders them as a flex row.
 * 2. Makes standalone images draggable — drop near another image to merge.
 * 3. Within a flex row, images are draggable for reorder.
 */
export function createReadingModeProcessor(
  app: App,
  getOptions: () => ImageRowOptions
) {
  return guardSection(async (
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext,
    pass: SectionPass
  ) => {
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

    suppressRowFlash();

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

    // TEMP-DIAG: section context, one self-contained record per pass. Read-only:
    // nothing below feeds the match or the render. The payload exists to answer
    // why the warmup pass reports a range one line past the same section's 0-based
    // parse lines while the real pass reports it exactly — so it carries the pass
    // tag, the raw range, the renderer's own section ledger, the editor's line
    // count and the section's source text, all read at the same instant.
    {
      const view =
        app.workspace
          .getLeavesOfType("markdown")
          .map((l) => viewInternals(l.view))
          .find((v) => v?.file?.path === ctx.sourcePath) ?? null;
      const secs = view?.previewMode?.renderer?.sections;
      const secsLen = secs ? secs.length : null;
      const near = secs && sectionInfo
        ? secs.filter(
            (s) =>
              s.lineStart != null &&
              s.lineEnd != null &&
              s.lineEnd >= sectionInfo.lineStart - 3 &&
              s.lineStart <= sectionInfo.lineEnd + 3
          )
        : [];
      log.debug("RM SECPROBE section context", {
        pass: el.closest(".diaa-warmup-probe") ? "warmup" : "real",
        file: ctx.sourcePath,
        section: sectionInfo
          ? { lineStart: sectionInfo.lineStart, lineEnd: sectionInfo.lineEnd }
          : null,
        sectionTextHead: sectionInfo?.text?.slice(0, 60) ?? null,
        editorLineCount: view?.editor?.lineCount() ?? null,
        sectionsLen: secsLen,
        sectionsFirst: secs && secsLen ? secs[0] : null,
        sectionsLast: secs && secsLen ? secs[secsLen - 1] : null,
        sectionsNear: near.map((s) => [s.lineStart, s.lineEnd, s.height ?? 0]),
        elChildCount: el.childElementCount,
        elFirstChildTag: el.firstElementChild?.tagName ?? null,
        embedFileNames,
        candidateLines: candidates.map((c) => c.line),
        usedFallback,
        mismatches,
      });
    }

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
          // The turn the renderers replay, and whether the attribute can carry
          // it — an identity orientation is deliberately never written.
          orientation: isIdentityOrientation(parsed.orientation)
            ? "(identity)"
            : orientationWord(parsed.orientation),
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
      // Rotate/flip rides as a word on the embed so the RM renderers (this file's
      // standalone path and rmFlexRow's row path) can replay it as a CSS
      // transform — mirroring how the LP widget renders it from the row params.
      if (!isIdentityOrientation(parsed.orientation)) {
        embed.setAttribute(
          "data-diaa-orientation",
          orientationWord(parsed.orientation)
        );
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
            // TEMP-DIAG: what the user had, what they picked, and the geometry
            // on both sides of the write — plus the frames that follow it.
            const diagExtra = {
              from: img.__diaa_alignment ?? null,
              to: newAlign ?? null,
              effective: newAlign ?? options.alignment,
              sizeMode: options.singleImageSizeMode,
              sourcePath: ctx.sourcePath,
            };
            diagAlign("standalone-align:before", embed, diagExtra);
            if (newAlign) {
              embed.setAttribute("data-diaa-alignment", newAlign);
            } else {
              embed.removeAttribute("data-diaa-alignment");
            }
            img.__diaa_alignment = newAlign;
            applyStandaloneAlignment(embed, options.alignment);
            diagAlign("standalone-align:after", embed, diagExtra);
            diagAlignFrames("standalone-align", embed, diagExtra);
            if (app && ctx.sourcePath) {
              const effectiveAlign = newAlign ?? options.alignment;
              const fn = getFileNameFromEmbed(embed);
              if (fn) storePendingAlignment(ctx.sourcePath, fn, effectiveAlign, embedLine1(embed));
            }
          };
          // Read-only reset surface so RM renders the reset row greyed-out.
          // manualSingle comes straight from the typed parse (matches[i] is the
          // RowImage this embed matched), not from re-reading a data-diaa-scale
          // attr — single rows carry no scale slot under the unified model.
          const parsed = matches[i];
          attachDiaImageMarkers(img, {
            manualSingle: () =>
              parsed != null && parsed.display.kind === "single-manual",
            resetTarget: () => ({
              mode: options.singleImageSizeMode,
              width: options.singleImageWidth,
            }),
            resetSingleManual: null,
            // Reading Mode persists nothing, so a rotation here cannot pin the
            // row's width — it stays a read-only surface.
            screenWidth: null,
            memberFill: null,
          });
          // A standalone row carries its size in `|S|W`, and the S flag decides
          // which frame the width is read from — the manual pixel width, or the
          // size setting.  The sizing path also replays the orientation (it has
          // to: the fit scale follows from the drawn size).
          applyStandaloneSize(
            embed,
            img,
            parsed != null && parsed.display.kind === "single-manual"
              ? parsed.display.widthPx
              : null,
            options
          );
        }
      }
    }

    // The section has been rendered a picture at a time, so clear the flash here
    // too: a block Obsidian flashed while this pass ran only starts carrying our
    // picture during it, and without this call the band would wait out a sweep
    // tick (up to FLASH_SWEEP_MS) before anyone looked again.
    stripFlashFromRows(el, "render");

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
      // Hand the guard the wrap as this pass's tail: the mark has to outlive the
      // handler, since the embeds are only wrapped once their images load.
      pass.tail = Promise.all(wrapPromises).then(afterRender);
    } else {
      afterRender();
    }
  });
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
