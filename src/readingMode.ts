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

    // Standalone single images are rendered natively by Obsidian (always
    // left-aligned regardless of the setting). Apply the configured alignment so
    // they match the multi-image rows. Width is untouched (native |0|W render).
    const groupedEmbeds = new Set<HTMLElement>(groups.flat());
    for (const embed of imageEmbeds) {
      if (!groupedEmbeds.has(embed)) applyStandaloneAlignment(embed, options.alignment);
    }

    if (imageEmbeds.length < 2) return;

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
    }
    logger.debug("ReadingMode scale matching", {
      domEmbeds: imageEmbeds.length,
      allEmbeds: allImageEmbeds.length,
      parsedImages: parsedImages.length,
      matched: matchCount,
      flexGrowSet: flexGrowSetCount,
    });

    // --- Step 1: (consecutive-embed groups already computed above) ---

    logger.debug("ReadingMode processor", {
      embedCount: imageEmbeds.length,
      groupCount: groups.length,
      sourcePath: ctx.sourcePath,
      groups: groups.map((g) => g.length),
      scaleMatches: imageEmbeds.filter((e) => e.hasAttribute("data-diaa-scale")).length,
    });

    // --- Step 2: Wait for images then wrap ---
    for (const group of groups) {
      if (group.length >= 2) {
        waitForImagesThenWrap(group, options);
      }
    }

    // --- Step 3: Make ALL image items draggable for merge/reorder ---
    makeImagesDraggable(app, ctx.sourcePath, imageEmbeds);
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
  alignment: "left" | "center" | "right"
): void {
  const block = findBlockParent(embed);
  if (!block || !isImageOnlyBlock(block)) return;
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

function wrapAsFlexRow(embeds: HTMLElement[], options: ImageRowOptions): void {
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
  for (const embed of embeds) {
    const img = embed.querySelector<HTMLImageElement>("img");
    const scaleAttr = embed.getAttribute("data-diaa-scale");
    const fgAttr = embed.getAttribute("data-diaa-flexgrow");
    if (img) {
      imgs.push(img);
      metas.push({
        naturalWidth: img.naturalWidth || 0,
        naturalHeight: img.naturalHeight || 0,
      });
      parsedFlexGrows.push(fgAttr ? parseFloat(fgAttr) : null);
      scales.push(scaleAttr ? parseFloat(scaleAttr) : null);
    } else {
      metas.push({ naturalWidth: 0, naturalHeight: 0 });
      parsedFlexGrows.push(null);
      scales.push(null);
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
  const { justifyContent, objectPosition } = alignmentToCSS(options.alignment);
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
    // Use setProperty("important") for styles that Obsidian CSS classes may override
    embed.style.setProperty("flex", `${flexGrow} 1 0%`, "important");
    embed.style.setProperty("overflow", "hidden", "important");
    embed.style.setProperty("min-width", "50px", "important");
    embed.style.setProperty("position", "relative", "important");
    embed.style.setProperty("margin", "0", "important");
    embed.style.setProperty("padding", "0", "important");
    embed.style.setProperty("display", "flex", "important");
    embed.style.setProperty("justify-content", justifyContent, "important");
    embed.style.setProperty("align-items", "flex-start", "important");

    const embedImgs = Array.from(embed.querySelectorAll<HTMLImageElement>("img"));
    for (const img of embedImgs) {
      // Strip Obsidian alignment classes that override our layout
      stripObsidianClasses(img);
      img.style.setProperty("width", "100%", "important");
      img.style.setProperty("height", "100%", "important");
      img.style.setProperty("object-fit", "contain", "important");
      img.style.setProperty("object-position", objectPosition, "important");
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

function waitForImagesThenWrap(embeds: HTMLElement[], options: ImageRowOptions): void {
  // Check if images are already present
  if (embeds.every((e) => e.querySelector("img"))) {
    wrapAsFlexRow(embeds, options);
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
          wrapAsFlexRow(embeds, options);
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
      wrapAsFlexRow(embeds, options);
    }
  }, 5000);
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
