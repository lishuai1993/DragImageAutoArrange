import { App, TFile, MarkdownPostProcessorContext } from "obsidian";
import { CLASSES, buildImageLineRe } from "./constants";
import { ImageRowOptions } from "./types";
import { ImageMeta, ImageEmbed, parseImageLine } from "./imageDetector";
import { computeFlexGrows, computeRowHeight, computeScaleBasedHeights } from "./layoutEngine";
import { alignmentToCSS } from "./utils";
import { logger } from "./logger";
import { validateRowFlexGrows } from "./parameterValidator";
import { stripObsidianClasses, hasObsidianAlignClass, neutralizeWrappers } from "./rowRenderer";

/** Extract the filename from an .internal-embed by reading the <img> src attribute. */
function getFileNameFromEmbed(embed: HTMLElement): string {
  const img = embed.querySelector<HTMLImageElement>("img");
  if (!img) return "";
  const src = img.src || img.getAttribute("src") || "";
  // Obsidian resource URL: app://local/.../filename.webp?timestamp
  const match = src.match(/\/([^\/\?]+\.\w+)(?:\?|$)/);
  return match ? decodeURIComponent(match[1]) : "";
}

/** Check if an .internal-embed element is for an image file. */
// ── Pending alignment store ─────────────────────────────────────────
// RM alignment changes are buffered here and only flushed to the
// markdown document when the user switches from RM to LP mode.
// This avoids the flash that view.dispatch() would cause in RM.

type AlignValue = "left" | "center" | "right";

const _pendingAlignments = new Map<string, AlignValue>();

function pendingKey(sourcePath: string, fileName: string): string {
  return `${sourcePath}::${fileName}`;
}

function storePendingAlignment(
  sourcePath: string,
  fileName: string,
  alignment: AlignValue
): void {
  _pendingAlignments.set(pendingKey(sourcePath, fileName), alignment);
}

function isImageEmbed(el: HTMLElement): boolean {
  const src = el.getAttribute("src") || "";
  const alt = el.getAttribute("alt") || "";
  const re = /\.(png|jpg|jpeg|gif|webp|svg|bmp|avif)$/i;
  if (re.test(src) || re.test(alt)) return true;
  // Fallback: check if there's already an <img> child
  if (el.querySelector("img")) return true;
  return false;
}

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
    // Obsidian only preserves the first |param as the <img width> attribute.
    // The scale (third |param) is lost in the DOM, so we read the file.
    let parsedImages: ImageEmbed[] = [];
    try {
      const file = app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (file instanceof TFile) {
        // Yield to the next macrotask so pending live-preview persists
        // (setTimeout 0) write their scale data before we read the file.
        await new Promise(r => setTimeout(r, 0));
        const content = await app.vault.cachedRead(file);
        const re = buildImageLineRe(options.imageExtensions);
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const parsed = parseImageLine(lines[i], i, re);
          if (parsed) parsedImages.push(parsed);
        }
        // Build image row index for cross-mode scroll sync
        setImageRowIndex(ctx.sourcePath, buildImageRowIndex(lines, re));
        logger.debug("ReadingMode parsed markdown", {
          filePath: file.path,
          totalLines: lines.length,
          parsedCount: parsedImages.length,
          parsed: parsedImages.map(p => ({
            line: p.line,
            fileName: p.fileName,
            hasExplicitWidth: p.hasExplicitWidth,
            explicitWidth: p.explicitWidth,
            flexGrow: p.flexGrow,
            scale: p.scale,
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

    // Match by DOM global position index.
    // DOM order of .internal-embed elements in Reading Mode always matches
    // markdown source line order.  Each embed's position among ALL image
    // embeds in the document maps directly to parsedImages by index.
    // This bypasses filename-based matching and naturally handles duplicate
    // filenames across different sections of the same file.
    const allImageEmbeds = (Array.from(
      document.querySelectorAll(".internal-embed")
    ) as HTMLElement[]).filter(isImageEmbed);
    let matchCount = 0;
    let flexGrowSetCount = 0;
    for (const embed of imageEmbeds) {
      const globalIdx = allImageEmbeds.indexOf(embed);
      if (globalIdx < 0 || globalIdx >= parsedImages.length) continue;
      const parsed = parsedImages[globalIdx];
      // Sanity check: extracted filename should match parsed filename
      const embedFn = getFileNameFromEmbed(embed);
      if (embedFn && embedFn !== parsed.fileName) continue;
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
      // Store source line for cross-mode scroll sync
      embed.setAttribute("data-diaa-line", String(parsed.line));
    }
    logger.debug("ReadingMode scale matching", {
      domEmbeds: imageEmbeds.length,
      allEmbeds: allImageEmbeds.length,
      parsedImages: parsedImages.length,
      matched: matchCount,
      flexGrowSet: flexGrowSetCount,
    });

    // Apply alignment to standalone single images NOW (after data-diaa-*
    // attributes have been set from markdown), so that per-image alignment
    // takes priority over the global default.
    // Also register the __diaa_* callbacks so the document-level
    // contextmenu handler (main.ts) can intercept right-clicks.
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

    // --- Step 1: (consecutive-embed groups already computed above) ---

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

    // After all flex rows are built + images loaded, refresh the anchor
    // snapshot (RM is now fully rendered) and restore scroll if needed.
    const afterRender = () => {
      // Cancel any pending deferred restore — afterRender is authoritative
      // for the initial RM render (images have just finished loading).
      if (_rmDeferredRestoreId !== null) {
        cancelAnimationFrame(_rmDeferredRestoreId);
        _rmDeferredRestoreId = null;
      }
      // Restore scroll first (LP→RM), then snapshot the final position
      if (_scrollAnchor) {
        restoreContentAnchor(app);
      } else if (_fallbackPct >= 0) {
        restoreScrollPct(app);
      }
      const anchor = captureContentAnchor(app);
      if (anchor) {
        _lastAnchor = anchor;
        _lastAnchorFile = ctx.sourcePath;
      }
      const pct = computeScrollPct(app);
      if (pct >= 0) _lastFallbackPct = pct;
      // Keep anchor updated during RM scrolling for the next RM→LP switch
      ensureRMScrollTracking(app);
      // Mark this file's RM as initially rendered so subsequent LP→RM
      // switches use scheduleRMDeferredRestore instead.
      _rmRenderedFile = ctx.sourcePath;
      // Log RM's post-restore viewport for cross-mode comparison
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

function findBlockParent(el: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = el.parentElement;
  while (cur) {
    const d = window.getComputedStyle(cur).display;
    if (d === "block" || d === "flex" || d === "list-item") return cur;
    cur = cur.parentElement;
  }
  return el.parentElement;
}

function isImageOnlyBlock(block: HTMLElement | null): boolean {
  if (!block) return false;
  const children = Array.from(block.children);
  if (children.length === 0) return false;
  // Allow .internal-embed and <br> elements (Reading Mode uses <br> between embeds)
  return children.every(
    (c) => c.classList.contains("internal-embed") || c.tagName === "BR"
  );
}

/**
 * Apply the configured alignment to a standalone single-image embed that
 * Obsidian renders natively (which always left-aligns).  Sets the parent
 * block's text-align and makes the embed inline-block so it honours it.  Only
 * touches image-only blocks and never changes the image width (still `|0|W`).
 */
function applyStandaloneAlignment(
  embed: HTMLElement,
  defaultAlignment: "left" | "center" | "right"
): void {
  const block = findBlockParent(embed);
  if (!block || !isImageOnlyBlock(block)) return;
  // Per-image alignment (from markdown |alignment|S|W) overrides global default
  const perImage = embed.getAttribute("data-diaa-alignment") as "left" | "center" | "right" | null;
  const alignment = perImage ?? defaultAlignment;
  const textAlign = alignment === "center" ? "center" : alignment === "right" ? "right" : "left";
  block.style.setProperty("text-align", textAlign, "important");
  embed.style.setProperty("display", "inline-block", "important");
}

function areAdjacentSiblings(a: HTMLElement | null, b: HTMLElement | null): boolean {
  if (!a || !b || a.parentElement !== b.parentElement) return false;
  const sibs = Array.from(a.parentElement!.children);
  return Math.abs(sibs.indexOf(a) - sibs.indexOf(b)) === 1;
}

/** Check if two embeds are consecutive — handles both same-block (Reading Mode, separated by <br>) and different-block (Live Preview) layouts. */
function areEmbedsConsecutive(prev: HTMLElement, curr: HTMLElement): boolean {
  const prevBlock = findBlockParent(prev);
  const currBlock = findBlockParent(curr);

  // Same block parent (typical in Reading Mode): check adjacency within block,
  // allowing only <br> elements between them.
  if (prevBlock && prevBlock === currBlock) {
    if (!isImageOnlyBlock(prevBlock)) return false;
    const sibs = Array.from(prevBlock.children);
    const idxA = sibs.indexOf(prev);
    const idxB = sibs.indexOf(curr);
    if (idxA === -1 || idxB === -1) return false;
    const [lo, hi] = idxA < idxB ? [idxA, idxB] : [idxB, idxA];
    for (let i = lo + 1; i < hi; i++) {
      if (sibs[i].tagName !== "BR") return false;
    }
    return true;
  }

  // Different block parents: check blocks are adjacent siblings and are image-only
  return Boolean(
    prevBlock && currBlock &&
    isImageOnlyBlock(prevBlock) &&
    areAdjacentSiblings(prevBlock, currBlock)
  );
}

// ── Flex row wrapping ────────────────────────────────────────

function wrapAsFlexRow(embeds: HTMLElement[], options: ImageRowOptions, app?: App, sourcePath?: string): void {
  try {
  const firstBlock = findBlockParent(embeds[0]);
  if (!firstBlock) return;

  // Collect image elements, natural metadata, flexGrow from parsed markdown, and scale ratios.
  // NOTE: do NOT read img.getAttribute("width") — Obsidian sets pixel widths on
  // ALL <img> elements in Reading Mode that are NOT the flexGrow×100 values we need.
  const imgs: HTMLImageElement[] = [];
  const metas: ImageMeta[] = [];
  const parsedFlexGrows: Array<number | null> = [];
  const scales: Array<number | null> = [];
  const alignments: Array<"left" | "center" | "right" | undefined> = [];
  for (const embed of embeds) {
    const img = embed.querySelector<HTMLImageElement>("img");
    const scaleAttr = embed.getAttribute("data-diaa-scale");
    const fgAttr = embed.getAttribute("data-diaa-flexgrow");
    const alignAttr = embed.getAttribute("data-diaa-alignment") as "left" | "center" | "right" | null;
    if (img) {
      imgs.push(img);
      metas.push({
        naturalWidth: img.naturalWidth || 0,
        naturalHeight: img.naturalHeight || 0,
      });
      parsedFlexGrows.push(fgAttr ? parseFloat(fgAttr) : null);
      scales.push(scaleAttr ? parseFloat(scaleAttr) : null);
      alignments.push(alignAttr || undefined);
    } else {
      metas.push({ naturalWidth: 0, naturalHeight: 0 });
      parsedFlexGrows.push(null);
      scales.push(null);
      alignments.push(undefined);
    }
  }
  const hasScale = scales.some((s) => s != null);

  const allLoaded = metas.every((m) => m.naturalWidth > 0);
  const hasParsedGrows = parsedFlexGrows.some((g) => g !== null);

  // Build flex-grows: parsed markdown |width takes priority, else compute from aspect ratio
  const grows: number[] = [];
  if (allLoaded && hasParsedGrows) {
    for (let i = 0; i < metas.length; i++) {
      grows[i] = parsedFlexGrows[i] !== null ? parsedFlexGrows[i]! : computeFlexGrows(metas)[i];
    }
  } else if (allLoaded) {
    const cg = computeFlexGrows(metas);
    for (let i = 0; i < metas.length; i++) grows[i] = cg[i];
  } else {
    for (let i = 0; i < embeds.length; i++) grows[i] = 1;
  }

  // Create flex row container
  const row = document.createElement("div");
  row.className = CLASSES.row;
  row.setAttribute("data-diaa-group", "true");
  const { justifyContent, objectPosition } = alignmentToCSS(
    embeds.length === 1 ? (alignments[0] ?? options.alignment) : options.alignment
  );
  row.style.cssText = [
    `display:flex`,
    `align-items:flex-start`,
    `justify-content:${justifyContent}`,
    `gap:${options.gap}px`,
    `width:100%`,
    `overflow:hidden`,
  ].join(";");

  // Set initial row height
  let rowH = options.defaultRowHeight;
  const firstImg = embeds[0].querySelector<HTMLImageElement>("img");
  if (firstImg?.naturalWidth) {
    rowH = Math.min(options.defaultRowHeight * 3, Math.max(50, rowH));
  }
  row.style.height = `${rowH}px`;

  // Remove <br> separators between embeds
  for (const embed of embeds) {
    const next = embed.nextElementSibling;
    if (next?.tagName === "BR") next.remove();
  }

  for (let i = 0; i < embeds.length; i++) {
    const flexGrow = grows[i] || 1;
    const embed = embeds[i];
    const perImageAlign = alignments[i] ?? options.alignment;
    const { justifyContent: ji, objectPosition: oi } = alignmentToCSS(perImageAlign);
    // Use setProperty("important") for styles that Obsidian CSS classes may override
    embed.style.setProperty("flex", `${flexGrow} 1 0%`, "important");
    embed.style.setProperty("overflow", "hidden", "important");
    embed.style.setProperty("min-width", "50px", "important");
    embed.style.setProperty("position", "relative", "important");
    embed.style.setProperty("margin", "0", "important");
    embed.style.setProperty("padding", "0", "important");
    embed.style.setProperty("display", "flex", "important");
    embed.style.setProperty("justify-content", ji, "important");
    embed.style.setProperty("align-items", "flex-start", "important");

    const embedImgs = Array.from(embed.querySelectorAll<HTMLImageElement>("img"));
    for (const img of embedImgs) {
      // Strip Obsidian alignment classes that override our layout
      stripObsidianClasses(img);
      img.style.setProperty("width", "100%", "important");
      img.style.setProperty("height", "100%", "important");
      img.style.setProperty("object-fit", "contain", "important");
      img.style.setProperty("object-position", oi, "important");
      img.style.setProperty("display", "block", "important");
      img.style.setProperty("margin", "0", "important");

      // Defend against Obsidian asynchronously re-adding alignment classes
      // and overwriting img height (Obsidian repeatedly sets it to defaultRowHeight-20).
      const styleGuard = new MutationObserver((mutations, obs) => {
        for (const m of mutations) {
          if (m.type !== "attributes") continue;
          const attr = m.attributeName;
          if (attr !== "class" && attr !== "style") continue;
          const target = m.target as HTMLImageElement;
          const itemEl = target.closest<HTMLElement>(".internal-embed");
          if (!itemEl) continue;
          const itemH = itemEl.style.height;
          const hasClasses = hasObsidianAlignClass(target);
          const heightMismatch = attr === "style" && itemH && target.style.height !== itemH;
          if (!hasClasses && !heightMismatch) continue;
          obs.disconnect();
          if (hasClasses) {
            stripObsidianClasses(target);
          }
          if (heightMismatch) {
            target.style.setProperty("height", itemH, "important");
          }
          if (target.style.margin) {
            target.style.setProperty("margin", "0", "important");
          }
          obs.observe(target, { attributes: true, attributeFilter: ["class", "style"] });
        }
      });
      styleGuard.observe(img, { attributes: true, attributeFilter: ["class", "style"] });

      // Store alignment callback on the img element so the document-level
      // contextmenu handler (main.ts) can read it at capture phase.
      (img as any).__diaa_alignment = (embed.getAttribute("data-diaa-alignment") || undefined) as "left" | "center" | "right" | undefined;
      (img as any).__diaa_onAlign = (newAlign: "left" | "center" | "right" | undefined) => {
        if (newAlign) {
          embed.setAttribute("data-diaa-alignment", newAlign);
        } else {
          embed.removeAttribute("data-diaa-alignment");
        }
        (img as any).__diaa_alignment = newAlign;
        const align = newAlign ?? options.alignment;
        const { justifyContent: j2, objectPosition: o2 } = alignmentToCSS(align);
        embed.style.setProperty("justify-content", j2, "important");
        img.style.setProperty("object-position", o2, "important");
        if (app && sourcePath) {
          const effectiveAlign = (newAlign ?? options.alignment) as AlignValue;
          const fn = getFileNameFromEmbed(embed);
          if (fn) storePendingAlignment(sourcePath, fn, effectiveAlign);
        }
      };
    }
    row.appendChild(embed);
  }

  // ── Anchor-based insertion: insert before first block, then remove old block(s) ──
  firstBlock.before(row);
  const blocksToRemove = new Set<HTMLElement>();
  for (const embed of embeds) {
    const block = findBlockParent(embed);
    // Only remove blocks that are now empty or are the original firstBlock
    if (block && block !== row) {
      blocksToRemove.add(block);
    }
  }
  for (const block of blocksToRemove) {
    if (!block.querySelector(".internal-embed")) {
      block.remove();
    }
  }

  // ── display:contents walking: neutralize Obsidian's intermediate wrappers ──
  // Obsidian wraps images in extra divs (.image-resize-container, etc).
  // Set display:contents on wrappers BETWEEN img and the flex item (embed),
  // but NOT on the embed itself—it is the flex item and must keep its box.
  for (const img of imgs) {
    neutralizeWrappers(img, row, embeds);
  }

  // Compute proper row height after DOM insertion (needs container width)
  const applySizes = () => {
    try {
    const containerWidth = row.getBoundingClientRect().width;
    if (containerWidth === 0) {
      // Row not laid out yet (common on re-render / section rebuild). Retry next
      // frame — matches LivePreview's applyLayout. Without this the row stays at
      // its initial defaultRowHeight while images render at natural height, and
      // the row's overflow:hidden clips them to "top only". Stop if detached.
      if (row.isConnected) requestAnimationFrame(() => applySizes());
      return;
    }
    const currentMetas = imgs.map((img) => ({
      naturalWidth: img.naturalWidth || 0,
      naturalHeight: img.naturalHeight || 0,
    }));
    const allReady = currentMetas.every((m) => m.naturalWidth > 0);
    if (!allReady) {
      // Images haven't finished decoding yet (naturalWidth still 0 even
      // though the <img> element exists and load handlers already fired).
      // Retry next frame — matching the width-0 guard above — so the row
      // never gets permanently stuck at its initial defaultRowHeight while
      // images render taller and get clipped by overflow:hidden.
      if (row.isConnected) requestAnimationFrame(() => applySizes());
      return;
    }

    // Re-read parsed flexGrow from embed data attributes (set from markdown source).
    const currentParsedGrows: Array<number | null> = [];
    for (const embed of embeds) {
      const fg = embed.getAttribute("data-diaa-flexgrow");
      currentParsedGrows.push(fg ? parseFloat(fg) : null);
    }
    const curHasExplicit = currentParsedGrows.some((g) => g !== null);

    // Build final flex-grows
    const finalGrows: number[] = [];
    if (curHasExplicit) {
      const aspectGrows = computeFlexGrows(currentMetas);
      for (let i = 0; i < currentMetas.length; i++) {
        finalGrows[i] = currentParsedGrows[i] !== null ? currentParsedGrows[i]! : aspectGrows[i];
      }
    } else {
      const cg = computeFlexGrows(currentMetas);
      for (let i = 0; i < currentMetas.length; i++) finalGrows[i] = cg[i];
    }

    // Validate computed flexGrows before use
    const validatedGrows = validateRowFlexGrows(finalGrows, currentMetas, containerWidth, options.gap);
    for (let _i = 0; _i < finalGrows.length; _i++) finalGrows[_i] = validatedGrows[_i];

    logger.debug("RM applySizes flexGrows", {
      containerWidth,
      currentParsedGrows,
      curHasExplicit,
      finalGrows: [...finalGrows],
      scales: scales.map((s) => s == null ? null : Math.round(s * 100)),
      hasScale,
      n: embeds.length,
    });

    const n = embeds.length;

    // ── Scale-based heights (matches LivePreview recalculateRowHeight) ──
    if (n > 1 && hasScale) {
      const { heights, maxH } = computeScaleBasedHeights(
        finalGrows, currentMetas, scales, containerWidth, options.gap, options.defaultRowHeight
      );
      for (let i = 0; i < n; i++) {
        const hPx = `${heights[i]}px`;
        embeds[i].style.setProperty("flex", `${finalGrows[i]} 1 0%`, "important");
        embeds[i].style.setProperty("height", hPx, "important");
        const embedImg = embeds[i].querySelector<HTMLImageElement>("img");
        if (embedImg) {
          // Strip Obsidian alignment classes in case they were re-added
          stripObsidianClasses(embedImg);
          embedImg.style.setProperty("height", hPx, "important");
          embedImg.style.setProperty("width", "auto", "important");
          embedImg.style.setProperty("margin", "0", "important");
        }
      }
      row.style.height = `${maxH}px`;
      logger.debug("RM applySizes scale-based heights", {
        maxH,
        heights,
      });
    } else {
      // ── Uniform height (no scale data) ──
      // Always use computeRowHeight to match LivePreview recalculateRowHeight.
      const rowHeightPx = computeRowHeight(
        finalGrows,
        currentMetas,
        containerWidth,
        options.gap,
        options.defaultRowHeight
      );
      row.style.height = `${rowHeightPx}px`;
      for (let j = 0; j < n; j++) {
        embeds[j].style.setProperty("flex", `${finalGrows[j]} 1 0%`, "important");
        embeds[j].style.setProperty("height", `${rowHeightPx}px`, "important");
        const embedImg = embeds[j].querySelector<HTMLImageElement>("img");
        if (embedImg) {
          stripObsidianClasses(embedImg);
          embedImg.style.setProperty("height", `${rowHeightPx}px`, "important");
          embedImg.style.setProperty("width", "auto", "important");
          embedImg.style.setProperty("margin", "0", "important");
        }
      }
    }

    // ── Diagnostic: rendered vs set heights + ancestor overflow (Problem 1) ──
    // A "top only" truncation means some clip box is shorter than the image.
    // Capture, after paint, each row/item/img's SET height vs RENDERED height,
    // and any ancestor whose overflow-y clips.  Two frames to catch async resets.
    const rowDiagnostic = () => {
      try {
        const rowRect = row.getBoundingClientRect();
        const items = embeds.map((embed, i) => {
          const img = embed.querySelector<HTMLImageElement>("img");
          return {
            i,
            itemSetH: embed.style.height || "",
            itemRectH: Math.round(embed.getBoundingClientRect().height),
            imgSetH: img?.style.height || "",
            imgRectH: img ? Math.round(img.getBoundingClientRect().height) : 0,
            imgNatural: img ? `${img.naturalWidth}x${img.naturalHeight}` : "",
            imgObjectFit: img ? getComputedStyle(img).objectFit : "",
          };
        });
        const clippers: Array<{ tag: string; cls: string; overflowY: string; clientH: number }> = [];
        let cur: HTMLElement | null = row.parentElement;
        for (let d = 0; cur && d < 8; d++) {
          const cs = getComputedStyle(cur);
          if (cs.overflowY !== "visible") {
            clippers.push({
              tag: cur.tagName,
              cls: (cur.className && cur.className.substring) ? cur.className.substring(0, 50) : "",
              overflowY: cs.overflowY,
              clientH: cur.clientHeight,
            });
          }
          cur = cur.parentElement;
        }
        logger.info("RM ROW render diagnostic", {
          n: embeds.length,
          rowSetH: row.style.height,
          rowRectH: Math.round(rowRect.height),
          rowOverflow: getComputedStyle(row).overflow,
          items,
          clippers,
        });
      } catch (e) {
        logger.warn("RM ROW render diagnostic error", { error: String(e) });
      }
    };
    requestAnimationFrame(() => {
      rowDiagnostic();
      requestAnimationFrame(() => rowDiagnostic());
    });

    // ── Row 1 Image 0 render-size tracker ──
    if (embeds.length === 3 && imgs[0]?.isConnected) {
      const trackImage0 = () => {
        const img = imgs[0];
        if (!img?.isConnected) return;
        const containerRect = row.getBoundingClientRect();
        const itemRect = embeds[0].getBoundingClientRect();
        const imgRect = img.getBoundingClientRect();
        const cs = getComputedStyle(img);
        const itemCS = getComputedStyle(embeds[0]);
        logger.info("RM ROW1_IMG0 render snapshot", {
          containerW: Math.round(containerRect.width),
          containerH: Math.round(containerRect.height),
          itemW: Math.round(itemRect.width),
          itemH: Math.round(itemRect.height),
          imgW: Math.round(imgRect.width),
          imgH: Math.round(imgRect.height),
          imgComputedW: cs.width,
          imgComputedH: cs.height,
          imgComputedMargin: cs.margin,
          imgComputedDisplay: cs.display,
          imgComputedObjectPos: cs.objectPosition,
          imgClasses: Array.from(img.classList),
          itemComputedDisplay: itemCS.display,
          itemComputedJustify: itemCS.justifyContent,
          inlineHeight: img.style.height,
          inlineWidth: img.style.width,
        });
      };
      requestAnimationFrame(() => {
        trackImage0();
        // Second frame to catch any async changes
        requestAnimationFrame(() => trackImage0());
      });
    }

    } catch (e) {
      logger.error("RM applySizes error", { error: String(e), stack: (e as Error)?.stack ?? "no stack" });
    }
  };

  // ResizeObserver: when the row first gets a non-zero width (layout complete),
  // or when the editor content width changes (sidebar drag / toggle), re-run
  // applySizes.  This is the RM analogue of the per-widget ResizeObserver width
  // guard in LivePreview's imageRowWidget.ts.  Without it the fragile rAF retry
  // chain inside applySizes is the only trigger — and it dies silently when
  // Obsidian tears down and rebuilds the section mid-chain, leaving the row
  // permanently stuck at its initial defaultRowHeight with images clipped.
  let lastRowWidth = 0;
  const sizeObserver = new ResizeObserver(() => {
    const w = row.isConnected ? Math.round(row.getBoundingClientRect().width) : 0;
    // Width guard: only run when the width actually changed. applySizes
    // mutates heights, not row width, so its own resize callback re-enters
    // here with the same width and is filtered out — no feedback loop.
    if (w > 0 && w !== lastRowWidth) {
      lastRowWidth = w;
      applySizes();
    }
  });
  sizeObserver.observe(row);

  // Clean up the observer when the row is removed from the DOM. MutationObserver
  // on the parent catches removal; resizeObserver on the row catches disconnect.
  const cleanupObserver = () => { sizeObserver.disconnect(); };
  if (row.parentElement) {
    const parentObserver = new MutationObserver((_mutations, obs) => {
      if (!row.isConnected) {
        obs.disconnect();
        cleanupObserver();
      }
    });
    parentObserver.observe(row.parentElement, { childList: true });
  }

  if (allLoaded) {
    requestAnimationFrame(() => applySizes());
  }

  // Set up load handlers for images not yet loaded
  let remainingLoads = metas.filter((m) => m.naturalWidth === 0).length;
  if (remainingLoads > 0) {
    for (const img of imgs) {
      if (img.naturalWidth > 0) continue;
      const onLoad = () => {
        remainingLoads--;
        if (remainingLoads <= 0) {
          requestAnimationFrame(() => applySizes());
        }
      };
      if (img.complete) {
        onLoad();
      } else {
        img.addEventListener("load", onLoad, { once: true });
      }
    }
    if (remainingLoads === 0) {
      requestAnimationFrame(() => applySizes());
    }
  }
  } catch (e) {
    logger.error("RM wrapAsFlexRow error", { error: String(e), stack: (e as Error)?.stack ?? "no stack" });
  }
}

// ── Wait for async image loading ─────────────────────────────

function waitForImagesThenWrap(embeds: HTMLElement[], options: ImageRowOptions, app?: App, sourcePath?: string): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };

    // Check if images are already present
    if (embeds.every((e) => e.querySelector("img"))) {
      wrapAsFlexRow(embeds, options, app, sourcePath);
      done();
      return;
    }

    let readyCount = embeds.filter((e) => e.querySelector("img")).length;
    const totalNeeded = embeds.length;
    const observers: MutationObserver[] = [];

    for (const embed of embeds) {
      if (embed.querySelector("img")) continue;

      const obs = new MutationObserver((_mutations, observer) => {
        if (embed.querySelector("img")) {
          readyCount++;
          observer.disconnect();
          if (readyCount >= totalNeeded) {
            for (const o of observers) o.disconnect();
            wrapAsFlexRow(embeds, options, app, sourcePath);
            done();
          }
        }
      });

      obs.observe(embed, { childList: true, subtree: true });
      observers.push(obs);
    }

    // Safety fallback: try anyway after 5 seconds
    setTimeout(() => {
      for (const o of observers) o.disconnect();
      if (embeds.some((e) => e.querySelector("img"))) {
        wrapAsFlexRow(embeds, options, app, sourcePath);
      }
      done();
    }, 5000);
  });
}

// ── Drag-to-merge / reorder ──────────────────────────────────

let dragSrcEl: HTMLElement | null = null;
let dragPlaceholders: HTMLElement[] = [];

function makeImagesDraggable(app: App, sourcePath: string, embeds: HTMLElement[]): void {
  let draggableCount = 0;
  for (const embed of embeds) {
    const block = findBlockParent(embed);
    if (!block) {
      logger.debug("ReadingMode makeDraggable skip: no block parent", {
        embedTag: embed.tagName,
      });
      continue;
    }

    block.setAttribute("draggable", "true");
    block.classList.add("diaa-draggable");
    // Prevent native image drag from overriding our block-level drag
    for (const img of Array.from(block.querySelectorAll("img"))) {
      img.setAttribute("draggable", "false");
    }
    draggableCount++;

    block.addEventListener("dragstart", (e) => {
      logger.debug("ReadingMode dragstart", { sourcePath });
      dragSrcEl = block;
      block.classList.add(CLASSES.dragging);
      e.dataTransfer!.effectAllowed = "move";
      e.dataTransfer!.setData("text/plain", "");
    });

    block.addEventListener("dragend", () => {
      block.classList.remove(CLASSES.dragging);
      dragSrcEl = null;
      removeAllDropIndicators();
    });

    block.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
      if (!dragSrcEl || dragSrcEl === block) return;

      removeAllDropIndicators();
      const rect = block.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;

      const indicator = document.createElement("div");
      indicator.className = "diaa-drop-indicator";
      indicator.style.cssText =
        "position:absolute;top:0;bottom:0;width:3px;background:#4a9eff;z-index:10;pointer-events:none;";
      if (e.clientX < midX) {
        indicator.style.left = "0";
      } else {
        indicator.style.right = "0";
      }
      block.style.position = block.style.position || "relative";
      block.appendChild(indicator);
      dragPlaceholders.push(indicator);
    });

    block.addEventListener("dragleave", () => {
      removeAllDropIndicators();
    });

    block.addEventListener("drop", (e) => {
      e.preventDefault();
      removeAllDropIndicators();
      if (!dragSrcEl || dragSrcEl === block) return;

      handleImageDrop(
        app,
        sourcePath,
        dragSrcEl,
        block,
        e.clientX < block.getBoundingClientRect().left + block.getBoundingClientRect().width / 2
      );
    });
  }
  logger.debug("ReadingMode makeDraggable done", {
    draggableCount,
    totalEmbeds: embeds.length,
  });
}

function removeAllDropIndicators(): void {
  for (const p of dragPlaceholders) p.remove();
  dragPlaceholders = [];
}

async function handleImageDrop(
  app: App,
  sourcePath: string,
  srcBlock: HTMLElement,
  dstBlock: HTMLElement,
  insertBefore: boolean
): Promise<void> {
  const srcEmbed = srcBlock.querySelector<HTMLElement>(".internal-embed.image-embed");
  const dstEmbed = dstBlock.querySelector<HTMLElement>(".internal-embed.image-embed");
  if (!srcEmbed || !dstEmbed) return;

  // Use DOM order to map to source line order.
  // In Reading Mode, DOM order always matches markdown source order.
  const allEmbeds = Array.from(
    document.querySelectorAll(".internal-embed.image-embed")
  );
  const srcDomIdx = allEmbeds.indexOf(srcEmbed);
  const dstDomIdx = allEmbeds.indexOf(dstEmbed);
  if (srcDomIdx < 0 || dstDomIdx < 0) return;

  const file = app.vault.getAbstractFileByPath(sourcePath);
  if (!(file instanceof TFile)) return;

  await app.vault.process(file, (content: string) => {
    const lines = content.split("\n");

    // Find all image embed line numbers in source order
    const imageLineNumbers: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (isImageEmbedLine(lines[i])) {
        imageLineNumbers.push(i);
      }
    }

    if (srcDomIdx >= imageLineNumbers.length || dstDomIdx >= imageLineNumbers.length) {
      return content;
    }

    const srcLine = imageLineNumbers[srcDomIdx];
    const dstLine = imageLineNumbers[dstDomIdx];

    if (srcLine === dstLine) return content;

    logger.info("ReadingMode drag-drop reorder", {
      srcDomIdx,
      dstDomIdx,
      srcLine,
      dstLine,
      insertBefore,
      totalImages: imageLineNumbers.length,
    });

    // Move src line to be before/after dst line
    const [removed] = lines.splice(srcLine, 1);
    const adjustedDst = srcLine < dstLine ? dstLine - 1 : dstLine;
    const insertAt = insertBefore ? adjustedDst : adjustedDst + 1;
    lines.splice(insertAt, 0, removed);

    return lines.join("\n");
  });
}

/**
 * Check if a line is a valid single-image embed line.
 * Uses the same logic as imageDetector for consistency.
 */
function isImageEmbedLine(line: string): boolean {
  // Width specifier is INSIDE [[...]], not after ]]
  const re = /^\s*!\[\[([^\]]+\.(?:png|jpg|jpeg|gif|webp|svg|bmp|avif))(?:\|\d+)?\]\]\s*$/i;
  return re.test(line);
}

/** Find the CodeMirror EditorView for a given file path, if one is open. */
function findEditorViewForFile(app: App, sourcePath: string): { dispatch: (tr: any) => void; state: { doc: { lines: number; line: (n: number) => { from: number; text: string } } } } | null {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const view = leaf.view as any;
    if (view.file?.path === sourcePath) {
      const cm = view.editor?.cm;
      if (cm?.dispatch) return cm;
    }
  }
  return null;
}

function flushPendingAlignments(app: App): void {
  if (_pendingAlignments.size === 0) return;

  // Group by sourcePath
  const byFile = new Map<string, Array<{ fileName: string; alignment: AlignValue }>>();
  for (const [key, alignment] of _pendingAlignments) {
    const idx = key.lastIndexOf("::");
    const sourcePath = key.slice(0, idx);
    const fileName = key.slice(idx + 2);
    if (!byFile.has(sourcePath)) byFile.set(sourcePath, []);
    byFile.get(sourcePath)!.push({ fileName, alignment });
  }
  _pendingAlignments.clear();

  for (const [sourcePath, entries] of byFile) {
    const editorView = findEditorViewForFile(app, sourcePath);
    if (!editorView) continue;

    const changes: Array<{ from: number; to: number; insert: string }> = [];
    const doc = editorView.state.doc;

    for (const { fileName, alignment } of entries) {
      for (let i = 1; i <= doc.lines; i++) {
        const lineObj = doc.line(i);
        if (!lineObj.text.includes(fileName)) continue;
        const stripped = lineObj.text.replace(/\|(left|center|right)\|/, "|");
        let newLine: string;
        if (stripped.includes("|")) {
          newLine = stripped.replace(/\|/, `|${alignment}|`);
        } else {
          newLine = stripped.replace(/\]\]/, `|${alignment}]]`);
        }
        if (newLine !== lineObj.text) {
          changes.push({ from: lineObj.from, to: lineObj.from + lineObj.text.length, insert: newLine });
        }
        break;
      }
    }

    if (changes.length > 0) {
      changes.sort((a, b) => b.from - a.from);
      editorView.dispatch({ changes });
      app.vault.adapter.write(sourcePath, editorView.state.doc.toString());
      // Invalidate image row index cache since file content changed
      _imageRowIndexCache.delete(sourcePath);
    }
  }
}

let _flushTimer: ReturnType<typeof setTimeout> | null = null;

// ── Scroll sync for cross-mode viewport alignment ─────────────────
//
// Content-based anchor system with three tiers (priority order):
//   1. image-row  – viewport center lands inside an image row; uses
//      global image-row index + intra-row ratio (mode-independent).
//   2. text-search – viewport center is in a text region; uses a
//      text fragment + nearest image row indices for cross-mode search.
//   3. line-fallback – degraded fallback using source line number.

// ── Image row indexing ────────────────────────────────

type ImageRowIndex = {
	index: number;       // global sequential number, 1-based
	startLine: number;   // first source line of this image row (1-based)
	endLine: number;     // last source line of this image row (1-based)
};

const _imageRowIndexCache = new Map<string, ImageRowIndex[]>();

function buildImageRowIndex(lines: string[], imgRe: RegExp): ImageRowIndex[] {
	const result: ImageRowIndex[] = [];
	let idx = 0;
	let inRow = false;
	let startLine = 0;

	for (let i = 0; i < lines.length; i++) {
		const isImg = imgRe.test(lines[i]);
		if (isImg && !inRow) {
			inRow = true;
			startLine = i + 1;
		} else if (!isImg && inRow) {
			idx++;
			result.push({ index: idx, startLine, endLine: i });
			inRow = false;
		}
	}
	if (inRow) {
		idx++;
		result.push({ index: idx, startLine, endLine: lines.length });
	}

	return result;
}

function getImageRowIndex(filePath: string): ImageRowIndex[] | undefined {
	return _imageRowIndexCache.get(filePath);
}

function setImageRowIndex(filePath: string, index: ImageRowIndex[]): void {
	_imageRowIndexCache.set(filePath, index);
}

/** Build index from CodeMirror doc lines (sync, used in LP scroll handlers). */
function ensureImageRowIndexFromCM(app: App): void {
	const view = (app.workspace.activeLeaf?.view as any);
	const filePath = view?.file?.path ?? "";
	if (!filePath || _imageRowIndexCache.has(filePath)) return;

	const cm = view.editor?.cm;
	if (!cm) return;

	const lines: string[] = [];
	for (let i = 1; i <= cm.state.doc.lines; i++) {
		lines.push(cm.state.doc.line(i).text);
	}
	const re = buildImageLineRe("png,jpg,jpeg,gif,webp,svg,bmp,avif");
	_imageRowIndexCache.set(filePath, buildImageRowIndex(lines, re));
}

// ── Anchor types ──────────────────────────────────────

type ContentAnchorV2 =
	| { kind: "image-row"; imageRowIndex: number; intraRowRatio: number }
	| { kind: "text-search"; textFragment: string; nearestImgBefore: number; nearestImgAfter: number }
	| { kind: "line-fallback"; line: number; pixelOffset: number };

let _scrollAnchor: ContentAnchorV2 | null = null;
let _lastAnchor: ContentAnchorV2 | null = null;
let _lastAnchorFile = "";

// Fallback scroll percentage for regions without any image embeds.
let _fallbackPct = -1;
let _lastFallbackPct = -1;

// File whose RM has completed initial post-processor render.
let _rmRenderedFile = "";

// RAF id for pending deferred RM restore.
let _rmDeferredRestoreId: number | null = null;

function computeScrollPct(app: App): number {
  const leaf = app.workspace.activeLeaf;
  const view = (leaf?.view as any);
  if (!view?.file) return -1;
  const mode = view?.getMode?.() ?? "";

  if (mode === "source") {
    const sd = view.editor?.cm?.scrollDOM;
    if (!sd || sd.clientHeight === 0) return -1;
    const maxScroll = sd.scrollHeight - sd.clientHeight;
    return maxScroll > 0 ? sd.scrollTop / maxScroll : 0;
  }

  if (mode === "preview") {
    const previewEl = document.querySelector(".markdown-preview-view") as HTMLElement;
    if (!previewEl || previewEl.clientHeight === 0) return -1;
    const maxScroll = previewEl.scrollHeight - previewEl.clientHeight;
    return maxScroll > 0 ? previewEl.scrollTop / maxScroll : 0;
  }

  return -1;
}

function captureContentAnchor(app: App): ContentAnchorV2 | null {
  const leaf = app.workspace.activeLeaf;
  const view = (leaf?.view as any);
  if (!view?.file) return null;
  const mode = view?.getMode?.() ?? "";
  const filePath = view.file.path ?? "";

  if (mode === "source") return captureAnchorLP(app, filePath);
  if (mode === "preview") return captureAnchorRM(app, filePath);
  return null;
}

// ── LP (source) anchor capture ────────────────────────

function captureAnchorLP(app: App, filePath: string): ContentAnchorV2 | null {
  const view = (app.workspace.activeLeaf?.view as any);
  const cm = view.editor?.cm;
  const sd = cm?.scrollDOM;
  if (!sd || sd.clientHeight === 0) return null;

  ensureImageRowIndexFromCM(app);
  const imgIndex = getImageRowIndex(filePath);
  const viewportCenterY = sd.scrollTop + sd.clientHeight / 2;
  const totalLines = cm.state.doc.lines;
  const imgRe = /!\[\[.*\.(?:png|jpg|jpeg|gif|webp|svg|bmp|avif)/i;

  // Find the line at viewport center
  let centerLine = 1;
  let centerLb = cm.lineBlockAt(1);
  for (let i = 1; i <= totalLines; i++) {
    const lb = cm.lineBlockAt(i);
    if (lb.top <= viewportCenterY && lb.top + lb.height > viewportCenterY) {
      centerLine = i;
      centerLb = lb;
      break;
    }
  }

  // Check if centerLine belongs to an image row
  if (imgIndex) {
    const imgRow = imgIndex.find(r => centerLine >= r.startLine && centerLine <= r.endLine);
    if (imgRow) {
      const startLb = cm.lineBlockAt(imgRow.startLine);
      const endLb = cm.lineBlockAt(imgRow.endLine);
      const rowTop = startLb.top;
      const rowBottom = endLb.top + endLb.height;
      const rowH = rowBottom - rowTop;
      const ratio = rowH > 0 ? Math.max(0, Math.min(1, (viewportCenterY - rowTop) / rowH)) : 0.5;
      return { kind: "image-row", imageRowIndex: imgRow.index, intraRowRatio: ratio };
    }
  }

  // Text region: capture fragment + nearest image row indices
  const lineText = cm.state.doc.line(centerLine).text.trim();
  if (lineText) {
    let nearestBefore = 0, nearestAfter = 0;
    if (imgIndex) {
      for (const r of imgIndex) {
        if (r.endLine < centerLine) nearestBefore = r.index;
        if (r.startLine > centerLine && nearestAfter === 0) nearestAfter = r.index;
      }
    }
    return {
      kind: "text-search",
      textFragment: lineText.slice(0, 80),
      nearestImgBefore: nearestBefore,
      nearestImgAfter: nearestAfter,
    };
  }

  // Pure blank line: fall back to line-based
  return {
    kind: "line-fallback",
    line: centerLine,
    pixelOffset: viewportCenterY - centerLb.top,
  };
}

// ── RM (preview) anchor capture ───────────────────────

function captureAnchorRM(app: App, filePath: string): ContentAnchorV2 | null {
  const previewEl = document.querySelector(".markdown-preview-view") as HTMLElement;
  if (!previewEl || previewEl.clientHeight === 0) return null;

  const previewRect = previewEl.getBoundingClientRect();
  const viewportCenterY = previewEl.scrollTop + previewEl.clientHeight / 2;
  const embeds = previewEl.querySelectorAll(".internal-embed[data-diaa-line]");
  const imgIndex = getImageRowIndex(filePath);

  // Find closest image embed to viewport center
  let bestLine = 0, bestDist = Infinity, bestEmbedTop = 0, bestEmbedH = 0;

  for (const embed of embeds) {
    const lineStr = embed.getAttribute("data-diaa-line");
    if (!lineStr) continue;
    const line = parseInt(lineStr, 10);
    const rect = embed.getBoundingClientRect();
    const embedTop = rect.top - previewRect.top + previewEl.scrollTop;
    const embedCenter = embedTop + rect.height / 2;
    const dist = Math.abs(viewportCenterY - embedCenter);
    if (dist < bestDist) {
      bestDist = dist;
      bestLine = line;
      bestEmbedTop = embedTop;
      bestEmbedH = rect.height;
    }
  }

  if (bestLine > 0 && imgIndex) {
    const imgRow = imgIndex.find(r => bestLine >= r.startLine && bestLine <= r.endLine);
    if (imgRow) {
      // Find the full image row pixel bounds in RM
      const rowEmbeds = previewEl.querySelectorAll(
        imgIndexToSelector(imgRow)
      );
      if (rowEmbeds.length > 0) {
        let rowTop = Infinity, rowBottom = -Infinity;
        for (const re of rowEmbeds) {
          const r = re.getBoundingClientRect();
          const t = r.top - previewRect.top + previewEl.scrollTop;
          const b = t + r.height;
          if (t < rowTop) rowTop = t;
          if (b > rowBottom) rowBottom = b;
        }
        const rowH = rowBottom - rowTop;
        const ratio = rowH > 0 ? Math.max(0, Math.min(1, (viewportCenterY - rowTop) / rowH)) : 0.5;
        return { kind: "image-row", imageRowIndex: imgRow.index, intraRowRatio: ratio };
      }
    }
  }

  // No image row at viewport center — try text fragment from DOM
  const cx = previewRect.left + previewRect.width / 2;
  const cy = previewRect.top + previewEl.clientHeight / 2;
  const elAtCenter = document.elementFromPoint(cx, cy);
  const textContent = elAtCenter?.textContent?.trim().slice(0, 80) ?? "";

  if (textContent && imgIndex) {
    let nearestBefore = 0, nearestAfter = 0;
    for (const r of imgIndex) {
      const re = previewEl.querySelector(`.internal-embed[data-diaa-line="${r.startLine}"]`) as HTMLElement;
      if (re) {
        const rect = re.getBoundingClientRect();
        const embedTop = rect.top - previewRect.top + previewEl.scrollTop;
        if (embedTop < viewportCenterY) nearestBefore = r.index;
        if (embedTop > viewportCenterY && nearestAfter === 0) nearestAfter = r.index;
      }
    }
    return {
      kind: "text-search",
      textFragment: textContent,
      nearestImgBefore: nearestBefore,
      nearestImgAfter: nearestAfter,
    };
  }

  // Fallback
  if (bestLine > 0) {
    return { kind: "line-fallback", line: bestLine, pixelOffset: viewportCenterY - bestEmbedTop };
  }
  return null;
}

/** Build a CSS selector matching all embeds whose data-diaa-line falls
 *  within an image row's source line range. */
function imgIndexToSelector(imgRow: ImageRowIndex): string {
  const parts: string[] = [];
  for (let ln = imgRow.startLine; ln <= imgRow.endLine; ln++) {
    parts.push(`[data-diaa-line="${ln}"]`);
  }
  return parts.join(",");
}

function restoreContentAnchor(app: App): void {
  if (!_scrollAnchor) return;
  const anchor = _scrollAnchor;
  _scrollAnchor = null;

  const leaf = app.workspace.activeLeaf;
  const view = (leaf?.view as any);
  const mode = view?.getMode?.() ?? "";
  const filePath = view?.file?.path ?? "";

  if (anchor.kind === "image-row") {
    restoreImageRowAnchor(app, mode, filePath, anchor.imageRowIndex, anchor.intraRowRatio);
  } else if (anchor.kind === "text-search") {
    restoreTextSearchAnchor(app, mode, filePath, anchor);
  } else {
    restoreLineFallbackAnchor(app, mode, anchor.line, anchor.pixelOffset);
  }
}

// ── image-row restore ──────────────────────────────────

function restoreImageRowAnchor(
  app: App, mode: string, filePath: string,
  imageRowIndex: number, intraRowRatio: number,
): void {
  if (mode === "source") {
    restoreImageRowInLP(app, filePath, imageRowIndex, intraRowRatio);
  } else if (mode === "preview") {
    restoreImageRowInRM(app, filePath, imageRowIndex, intraRowRatio);
  }
}

function restoreImageRowInLP(
  app: App, filePath: string,
  imageRowIndex: number, intraRowRatio: number,
): void {
  const view = (app.workspace.activeLeaf?.view as any);
  const cm = view.editor?.cm;
  const sd = cm?.scrollDOM;
  if (!sd || sd.clientHeight === 0) return;

  const imgIndex = getImageRowIndex(filePath);
  const imgRow = imgIndex?.find(r => r.index === imageRowIndex);
  if (!imgRow) return;

  const startLb = cm.lineBlockAt(imgRow.startLine);
  const endLb = cm.lineBlockAt(imgRow.endLine);
  const rowTop = startLb.top;
  const rowBottom = endLb.top + endLb.height;
  const targetY = Math.max(0, rowTop + (rowBottom - rowTop) * intraRowRatio - sd.clientHeight / 2);
  sd.scrollTop = targetY;

  logger.info("VIEWPORT anchor-restored", {
    mode: "source", kind: "image-row", imageRowIndex,
    ratio: Math.round(intraRowRatio * 100),
    rowTop: Math.round(rowTop), rowH: Math.round(rowBottom - rowTop),
    targetY: Math.round(targetY), actualY: Math.round(sd.scrollTop),
  });
}

function restoreImageRowInRM(
  app: App, filePath: string,
  imageRowIndex: number, intraRowRatio: number,
): void {
  const previewEl = document.querySelector(".markdown-preview-view") as HTMLElement;
  if (!previewEl || previewEl.clientHeight === 0) return;

  const imgIndex = getImageRowIndex(filePath);
  const imgRow = imgIndex?.find(r => r.index === imageRowIndex);
  if (!imgRow) return;

  // Collect all embeds belonging to this image row
  const sel = imgIndexToSelector(imgRow);
  const rowEmbeds = previewEl.querySelectorAll(sel);
  if (rowEmbeds.length === 0) return;

  const previewRect = previewEl.getBoundingClientRect();
  let rowTop = Infinity, rowBottom = -Infinity;
  for (const re of rowEmbeds) {
    const r = re.getBoundingClientRect();
    const t = r.top - previewRect.top + previewEl.scrollTop;
    const b = t + r.height;
    if (t < rowTop) rowTop = t;
    if (b > rowBottom) rowBottom = b;
  }

  const rowH = rowBottom - rowTop;
  const targetY = Math.max(0, rowTop + rowH * intraRowRatio - previewEl.clientHeight / 2);
  previewEl.scrollTop = targetY;

  logger.info("VIEWPORT anchor-restored", {
    mode: "preview", kind: "image-row", imageRowIndex,
    ratio: Math.round(intraRowRatio * 100),
    rowTop: Math.round(rowTop), rowH: Math.round(rowH),
    targetY: Math.round(targetY), actualY: Math.round(previewEl.scrollTop),
  });
}

// ── text-search restore ────────────────────────────────

function restoreTextSearchAnchor(
  app: App, mode: string, filePath: string,
  anchor: Extract<ContentAnchorV2, { kind: "text-search" }>,
): void {
  if (mode === "source") {
    restoreTextSearchInLP(app, filePath, anchor);
  } else {
    // RM text search is hard (rendered DOM); degrade to line-fallback
    // with blank-line compensation using nearest image rows.
    restoreTextSearchInRM(app, filePath, anchor);
  }
}

function restoreTextSearchInLP(
  app: App, filePath: string,
  anchor: Extract<ContentAnchorV2, { kind: "text-search" }>,
): void {
  const view = (app.workspace.activeLeaf?.view as any);
  const cm = view.editor?.cm;
  const sd = cm?.scrollDOM;
  if (!sd || sd.clientHeight === 0) return;

  const docText = cm.state.doc.toString();
  let idx = docText.indexOf(anchor.textFragment);

  // If multiple occurrences, use nearest image rows to pick the right one
  if (idx >= 0) {
    const secondIdx = docText.indexOf(anchor.textFragment, idx + 1);
    if (secondIdx >= 0 && anchor.nearestImgBefore > 0) {
      // Disambiguate: find the occurrence closest to the expected image row
      const imgIndex = getImageRowIndex(filePath);
      const targetRow = imgIndex?.find(r => r.index === anchor.nearestImgBefore);
      if (targetRow) {
        const targetLine = targetRow.endLine + 1;
        // Search forward from each match, pick the one nearest to targetLine
        let pos = 0, bestPos = -1, bestDist = Infinity;
        while ((pos = docText.indexOf(anchor.textFragment, pos)) >= 0) {
          const matchLine = cm.state.doc.lineAt(pos).number;
          const dist = Math.abs(matchLine - targetLine);
          if (dist < bestDist) { bestDist = dist; bestPos = pos; }
          pos++;
        }
        if (bestPos >= 0) idx = bestPos;
      }
    }
  }

  if (idx >= 0) {
    const line = cm.state.doc.lineAt(idx).number;
    const lb = cm.lineBlockAt(line);
    const targetY = Math.max(0, lb.top + lb.height / 2 - sd.clientHeight / 2);
    sd.scrollTop = targetY;

    logger.info("VIEWPORT anchor-restored", {
      mode: "source", kind: "text-search", line,
      textFragment: anchor.textFragment.slice(0, 30),
      targetY: Math.round(targetY), actualY: Math.round(sd.scrollTop),
    });
    return;
  }

  // Text not found — degrade to line-fallback using nearest image row
  logger.info("VIEWPORT text-search miss, degrading", {
    textFragment: anchor.textFragment.slice(0, 30),
  });
  if (anchor.nearestImgBefore > 0) {
    const imgIndex = getImageRowIndex(filePath);
    const imgRow = imgIndex?.find(r => r.index === anchor.nearestImgBefore);
    if (imgRow) {
      const lb = cm.lineBlockAt(imgRow.endLine + 1);
      const targetY = Math.max(0, lb.top + 30 - sd.clientHeight / 2);
      sd.scrollTop = targetY;
    }
  }
}

function restoreTextSearchInRM(
  app: App, filePath: string,
  anchor: Extract<ContentAnchorV2, { kind: "text-search" }>,
): void {
  // RM DOM doesn't expose source line numbers for text nodes.
  // Use nearest image row as a reference point, then add a small offset.
  const previewEl = document.querySelector(".markdown-preview-view") as HTMLElement;
  if (!previewEl || previewEl.clientHeight === 0) return;

  if (anchor.nearestImgBefore > 0 || anchor.nearestImgAfter > 0) {
    const imgIndex = getImageRowIndex(filePath);
    const refIdx = anchor.nearestImgBefore > 0 ? anchor.nearestImgBefore : anchor.nearestImgAfter;
    const imgRow = imgIndex?.find(r => r.index === refIdx);
    if (imgRow) {
      const startLine = anchor.nearestImgBefore > 0 ? imgRow.endLine : imgRow.startLine;
      // Try to find an embed just after/before the image row as reference
      const refEmbed = previewEl.querySelector(`.internal-embed[data-diaa-line="${startLine}"]`) as HTMLElement;
      if (refEmbed) {
        const previewRect = previewEl.getBoundingClientRect();
        const refRect = refEmbed.getBoundingClientRect();
        const refTop = refRect.top - previewRect.top + previewEl.scrollTop;
        // Position viewport so the reference embed is just visible at the top
        const targetY = Math.max(0, refTop + (anchor.nearestImgBefore > 0 ? refRect.height + 40 : -40));
        previewEl.scrollTop = targetY;

        logger.info("VIEWPORT anchor-restored", {
          mode: "preview", kind: "text-search-degraded", refLine: startLine,
          targetY: Math.round(targetY), actualY: Math.round(previewEl.scrollTop),
        });
        return;
      }
    }
  }

  // Last resort: fall back to scroll percentage
  logger.info("VIEWPORT text-search unresolvable in RM");
}

// ── line-fallback restore (original behavior) ─────────

function restoreLineFallbackAnchor(app: App, mode: string, line: number, pixelOffset: number): void {
  if (mode === "source") {
    const view = (app.workspace.activeLeaf?.view as any);
    const cm = view.editor?.cm;
    const sd = cm?.scrollDOM;
    if (!sd || sd.clientHeight === 0) return;

    const lb = cm.lineBlockAt(line);
    const targetY = Math.max(0, lb.top + pixelOffset - sd.clientHeight / 2);
    sd.scrollTop = targetY;

    logger.info("VIEWPORT anchor-restored", {
      mode, kind: "line-fallback", line, offset: Math.round(pixelOffset),
      lineTop: Math.round(lb.top), targetY: Math.round(targetY),
      actualY: Math.round(sd.scrollTop),
    });
  } else if (mode === "preview") {
    const previewEl = document.querySelector(".markdown-preview-view") as HTMLElement;
    if (!previewEl || previewEl.clientHeight === 0) return;

    const embed = previewEl.querySelector(`.internal-embed[data-diaa-line="${line}"]`) as HTMLElement;
    if (!embed) {
      logger.info("VIEWPORT anchor-restore skip", { reason: "embed not found", line });
      return;
    }

    const previewRect = previewEl.getBoundingClientRect();
    const embedRect = embed.getBoundingClientRect();
    const embedTop = embedRect.top - previewRect.top + previewEl.scrollTop;
    const targetY = Math.max(0, embedTop + pixelOffset - previewEl.clientHeight / 2);
    previewEl.scrollTop = targetY;

    logger.info("VIEWPORT anchor-restored", {
      mode, kind: "line-fallback", line, offset: Math.round(pixelOffset),
      embedTop: Math.round(embedTop), targetY: Math.round(targetY),
      actualY: Math.round(previewEl.scrollTop),
    });
  }
}

// Legacy percentage-based restore kept as fallback for text-only regions.
function restoreScrollPct(app: App): void {
  if (_fallbackPct < 0) return;
  const pct = _fallbackPct;
  _fallbackPct = -1;

  const leaf = app.workspace.activeLeaf;
  const view = (leaf?.view as any);
  const mode = view?.getMode?.() ?? "";

  let targetY = -1, docH = 0, viewportH = 0, actualY = -1;

  if (mode === "source") {
    const sd = view.editor?.cm?.scrollDOM;
    if (sd && sd.scrollHeight > sd.clientHeight) {
      docH = sd.scrollHeight;
      viewportH = sd.clientHeight;
      targetY = pct * (docH - viewportH);
      sd.scrollTop = targetY;
      actualY = sd.scrollTop;
    }
  } else if (mode === "preview") {
    const previewEl = document.querySelector(".markdown-preview-view") as HTMLElement;
    if (previewEl && previewEl.scrollHeight > previewEl.clientHeight) {
      docH = previewEl.scrollHeight;
      viewportH = previewEl.clientHeight;
      targetY = pct * (previewEl.scrollHeight - viewportH);
      previewEl.scrollTop = targetY;
      actualY = previewEl.scrollTop;
    }
  }

  logger.info("VIEWPORT fallback-restored", {
    mode, pct: Math.round(pct * 100),
    targetY: Math.round(targetY), actualY: Math.round(actualY),
    docH, viewportH, maxScroll: Math.round(docH - viewportH),
  });
}

// ── RM scroll tracking ─────────────────────────────────────────────
// When the user scrolls in Reading Mode, _lastAnchor must stay
// current so the next RM→LP switch captures the right content position.
// Uses element-reference guard (not boolean) so the listener is
// re-attached when the preview element changes across mode switches.

let _rmTrackedEl: HTMLElement | null = null;
let _rmScrollCleanup: (() => void) | null = null;

function ensureRMScrollTracking(_app: App): void {
	const previewEl = document.querySelector(".markdown-preview-view") as HTMLElement | null;
	if (!previewEl || previewEl.clientHeight === 0) return;
	if (_rmTrackedEl === previewEl) return;

	// Clean up old listener on a different/stale element
	if (_rmScrollCleanup) {
		_rmScrollCleanup();
		_rmScrollCleanup = null;
	}
	_rmTrackedEl = null;

	const onScroll = () => {
		const anchor = captureContentAnchor(_app);
		if (anchor) {
			_lastAnchor = anchor;
			_lastAnchorFile = (_app.workspace.activeLeaf?.view as any)?.file?.path ?? "";
		}
		const pct = computeScrollPct(_app);
		if (pct >= 0) _lastFallbackPct = pct;
	};

	previewEl.addEventListener("scroll", onScroll, { passive: true });
	_rmScrollCleanup = () => {
		previewEl.removeEventListener("scroll", onScroll);
		_rmScrollCleanup = null;
		_rmTrackedEl = null;
	};
	_rmTrackedEl = previewEl;
}

// ── RM deferred restore ─────────────────────────────────────────────
// When the user switches LP→RM for a file whose RM has already been
// initially rendered (post-processor won't re-fire), this function
// polls for RM DOM readiness and then restores the scroll position.
// For the initial RM render, afterRender is authoritative instead.

function scheduleRMDeferredRestore(app: App): void {
	// Cancel any pending deferred restore
	if (_rmDeferredRestoreId !== null) {
		cancelAnimationFrame(_rmDeferredRestoreId);
		_rmDeferredRestoreId = null;
	}

	const attempt = () => {
		const mode = (app.workspace.activeLeaf?.view as any)?.getMode?.() ?? "";
		if (mode !== "preview") return; // mode changed again before DOM ready

		const previewEl = document.querySelector(".markdown-preview-view") as HTMLElement | null;
		if (!previewEl || previewEl.clientHeight === 0) {
			_rmDeferredRestoreId = requestAnimationFrame(attempt);
			return;
		}
		_rmDeferredRestoreId = null;

		ensureRMScrollTracking(app);
		if (_scrollAnchor) {
			restoreContentAnchor(app);
		} else if (_fallbackPct >= 0) {
			restoreScrollPct(app);
		}

		const anchor = captureContentAnchor(app);
		if (anchor) {
			_lastAnchor = anchor;
			_lastAnchorFile = (app.workspace.activeLeaf?.view as any)?.file?.path ?? "";
		}
		const pct = computeScrollPct(app);
		if (pct >= 0) _lastFallbackPct = pct;
		logViewportState(app, "rm-after-restore");
	};
	_rmDeferredRestoreId = requestAnimationFrame(attempt);
}

// ── LP scroll tracking ─────────────────────────────────────────────
// Symmetric to RM tracking: when the user scrolls in LP (source) mode,
// _lastAnchor stays current for the next LP→RM switch.

let _lpScrollCleanup: (() => void) | null = null;

function ensureLPScrollTracking(app: App): void {
	if (_lpScrollCleanup) return;

	const cm = (app.workspace.activeLeaf?.view as any)?.editor?.cm;
	const sd = cm?.scrollDOM as HTMLElement | null;
	if (!sd) return;

	const onScroll = () => {
		const anchor = captureContentAnchor(app);
		if (anchor) {
			_lastAnchor = anchor;
			_lastAnchorFile = (app.workspace.activeLeaf?.view as any)?.file?.path ?? "";
		}
		const pct = computeScrollPct(app);
		if (pct >= 0) _lastFallbackPct = pct;
	};

	sd.addEventListener("scroll", onScroll, { passive: true });
	_lpScrollCleanup = () => {
		sd.removeEventListener("scroll", onScroll);
		_lpScrollCleanup = null;
	};
}

// ── Viewport diagnostic logging ────────────────────────────────────

let _lastMode = "";
let _lastDocH = 0;

function computeDocH(app: App, mode: string): number {
  if (mode === "source") {
    const sd = (app.workspace.activeLeaf?.view as any)?.editor?.cm?.scrollDOM;
    return sd?.scrollHeight ?? 0;
  }
  if (mode === "preview") {
    const el = document.querySelector(".markdown-preview-view") as HTMLElement;
    return el?.scrollHeight ?? 0;
  }
  return 0;
}

function logViewportState(app: App, trigger: string): void {
  const leaf = app.workspace.activeLeaf;
  const view = (leaf?.view as any);
  const mode = view?.getMode?.() ?? "none";
  const file = view?.file?.path ?? "";

  const modeChanged = _lastMode && _lastMode !== mode;
  if (modeChanged) {
    // Compute new mode's docH for the ratio log
    const newDocH = computeDocH(app, mode);
    logger.info("VIEWPORT mode-switch", {
      from: _lastMode, to: mode, trigger, file,
      oldDocH: _lastDocH, newDocH,
      docHRatio: _lastDocH > 0 && newDocH > 0 ? Math.round(newDocH / _lastDocH * 100) : 0,
    });
    if (_lastAnchorFile === file && _lastAnchor) {
      _scrollAnchor = _lastAnchor;
      logger.info("VIEWPORT anchor-captured", {
	        fromMode: _lastMode,
	        kind: _lastAnchor.kind,
	        ...(_lastAnchor.kind === "image-row" ? {
	          imageRowIndex: _lastAnchor.imageRowIndex,
	          ratio: Math.round(_lastAnchor.intraRowRatio * 100),
	        } : _lastAnchor.kind === "text-search" ? {
	          textFragment: _lastAnchor.textFragment.slice(0, 30),
	          nearestBefore: _lastAnchor.nearestImgBefore,
	          nearestAfter: _lastAnchor.nearestImgAfter,
	        } : {
	          line: (_lastAnchor as any).line,
	          offset: Math.round((_lastAnchor as any).pixelOffset),
	        }),
	      });
    } else if (_lastAnchorFile === file && _lastFallbackPct >= 0) {
      _fallbackPct = _lastFallbackPct;
      logger.info("VIEWPORT fallback-captured", { fromMode: _lastMode, pct: Math.round(_lastFallbackPct * 100) });
    }
  }
  _lastMode = mode;

  if (!file) return;

  let scrollY = 0, viewportH = 0, docH = 0;
  const extra: Record<string, any> = {};

  if (mode === "preview") {
    const previewEl = document.querySelector(".markdown-preview-view") as HTMLElement;
    if (previewEl) {
      scrollY = previewEl.scrollTop;
      viewportH = previewEl.clientHeight;
      docH = previewEl.scrollHeight;
    }
    const embeds = document.querySelectorAll(".internal-embed");
    let firstVis: string | null = null;
    let lastVis: string | null = null;
    let count = 0;
    for (const el of embeds) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom > 0 && rect.top < window.innerHeight) {
        count++;
        const img = el.querySelector("img");
        const src = img?.getAttribute("src") ?? "";
        const name = src.split("/").pop()?.split("?")[0] ?? "?";
        if (!firstVis) firstVis = name;
        lastVis = name;
      }
    }
    extra.visibleEmbeds = count;
    extra.firstVis = firstVis;
    extra.lastVis = lastVis;
  } else if (mode === "source") {
    const cm = view.editor?.cm;
    if (cm?.scrollDOM) {
      scrollY = cm.scrollDOM.scrollTop;
      viewportH = cm.scrollDOM.clientHeight;
      docH = cm.scrollDOM.scrollHeight;
      const totalLines = cm.state.doc.lines;
      extra.docLines = totalLines;
      if (totalLines > 0 && docH > 0) {
        extra.approxLineFirst = Math.max(1, Math.floor(scrollY / docH * totalLines) + 1);
        extra.approxLineLast = Math.min(totalLines, Math.ceil((scrollY + viewportH) / docH * totalLines));
      }
      // Visible image lines: scan doc for image embeds whose estimated pixel
      // position falls within the viewport (for cross-mode content comparison).
      const visImages: string[] = [];
      for (let i = 1; i <= totalLines; i++) {
        const line = cm.state.doc.line(i);
        if (/!\[\[.*\.(?:png|jpg|jpeg|gif|webp|svg|bmp|avif)/i.test(line.text)) {
          const lineY = (i - 1) / totalLines * docH;
          if (lineY >= scrollY && lineY <= scrollY + viewportH) {
            const match = line.text.match(/!\[\[([^\]]+)\]\]/i);
            visImages.push(match?.[1]?.split("|")[0]?.split("/").pop() ?? "?");
          }
        }
      }
      extra.visibleImages = visImages;
      extra.visibleImageCount = visImages.length;
    }
  }

  logger.info("VIEWPORT", {
    trigger, mode, file,
    scrollY: Math.round(scrollY), viewportH, docH,
    scrollPct: docH > 0 ? Math.round(scrollY / docH * 100) : 0,
    pending: _pendingAlignments.size,
    ...extra,
  });

  // _lastAnchor and _lastFallbackPct are maintained exclusively by
  // per-mode scroll trackers and afterRender.
  // logViewportState only copies them on mode switch.
  _lastDocH = docH;
}

export function schedulePendingFlush(app: App): void {
  logViewportState(app, "layout-change");

  if (_pendingAlignments.size === 0) {
    const mode = (app.workspace.activeLeaf?.view as any)?.getMode?.() ?? "";
    if (mode === "source") {
      const hasAnchor = _scrollAnchor !== null;
      const hasFallback = _fallbackPct >= 0;
      if (hasAnchor || hasFallback) {
        requestAnimationFrame(() => {
          if (_scrollAnchor) {
            restoreContentAnchor(app);
          } else if (_fallbackPct >= 0) {
            restoreScrollPct(app);
          }
          // Capture LP's post-restore position and keep it updated
          const anchor = captureContentAnchor(app);
          if (anchor) {
            _lastAnchor = anchor;
            _lastAnchorFile = (app.workspace.activeLeaf?.view as any)?.file?.path ?? "";
          }
          const pct = computeScrollPct(app);
          if (pct >= 0) _lastFallbackPct = pct;
          ensureLPScrollTracking(app);
          logViewportState(app, "lp-after-restore");
        });
      }
    } else if (mode === "preview") {
      // Subsequent LP→RM switch (initial render is handled by afterRender).
      // Defer restore until RM DOM is visible and has non-zero height.
      if (_rmRenderedFile === ((app.workspace.activeLeaf?.view as any)?.file?.path ?? "")
          && (_scrollAnchor || _fallbackPct >= 0)) {
        scheduleRMDeferredRestore(app);
      }
    }
    return;
  }

  if (_flushTimer) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    logger.info("VIEWPORT flush-start", { pendingCount: _pendingAlignments.size });
    flushPendingAlignments(app);
    if (_scrollAnchor) {
      restoreContentAnchor(app);
    } else if (_fallbackPct >= 0) {
      restoreScrollPct(app);
    }
    logViewportState(app, "after-flush");
  }, 0);
}
