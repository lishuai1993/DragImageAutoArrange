import { App, TFile, MarkdownPostProcessorContext } from "obsidian";
import { CLASSES, buildImageLineRe } from "./constants";
import { ImageRowOptions } from "./types";
import { ImageMeta, ImageEmbed, parseImageLine } from "./imageDetector";
import { computeFlexGrows, computeRowHeight } from "./layoutEngine";
import { alignmentToCSS } from "./utils";
import { logger } from "./logger";

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

    if (imageEmbeds.length < 2) return;

    const options = getOptions();

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

    // Match by file name + occurrence count.
    // Post-processor may be called multiple times for different sections of the
    // same file, so global position-based matching doesn't work — each invocation
    // only sees a subset of embeds but parses the entire file.
    const fileNameCount = new Map<string, number>();
    let matchCount = 0;
    let flexGrowSetCount = 0;
    const matchDebug: Array<{ embedIdx: number; alt: string; extractedFn: string; matched: boolean; matchedLine: number | null; matchedFn: string | null; parsedHasExplicit: boolean; parsedScale: number | null; parsedFlexGrow: number }> = [];
    for (let embedIdx = 0; embedIdx < imageEmbeds.length; embedIdx++) {
      const embed = imageEmbeds[embedIdx];
      const alt = embed.getAttribute("alt") || "";
      const fn = alt.split("|")[0];
      const count = fileNameCount.get(fn) ?? 0;
      fileNameCount.set(fn, count + 1);
      // Find the (count+1)-th occurrence in parsedImages
      let occ = 0;
      let matched = false;
      let matchedLine: number | null = null;
      let matchedFn: string | null = null;
      let parsedHasExplicit = false;
      let parsedScale: number | null = null;
      let parsedFlexGrow = 0;
      for (const parsed of parsedImages) {
        if (parsed.fileName === fn) {
          if (occ === count) {
            matched = true;
            matchedLine = parsed.line;
            matchedFn = parsed.fileName;
            parsedHasExplicit = parsed.hasExplicitWidth;
            parsedScale = parsed.scale;
            parsedFlexGrow = parsed.flexGrow;
            // Store flexGrow from parsed markdown.
            // Only trust it when hasExplicitWidth is true; otherwise
            // parseImageLine defaults to 1 which is unreliable.
            if (parsed.hasExplicitWidth) {
              embed.setAttribute("data-diaa-flexgrow", String(parsed.flexGrow));
              flexGrowSetCount++;
            }
            if (parsed.scale != null) {
              embed.setAttribute("data-diaa-scale", String(parsed.scale));
              matchCount++;
            }
            break;
          }
          occ++;
        }
      }
      matchDebug.push({ embedIdx, alt, extractedFn: fn, matched, matchedLine, matchedFn, parsedHasExplicit, parsedScale, parsedFlexGrow });
    }
    logger.debug("ReadingMode scale matching", {
      domEmbeds: imageEmbeds.length,
      parsedImages: parsedImages.length,
      matched: matchCount,
      flexGrowSet: flexGrowSetCount,
      details: matchDebug,
    });

    // --- Step 1: Group consecutive embeds (respect maxImagesPerRow) ---
    const groups = buildEmbedGroups(imageEmbeds, options.maxImagesPerRow);

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
  // Use flex-start when scales exist (per-image heights differ), stretch otherwise
  const alignItems = hasScale ? "flex-start" : "stretch";
  row.style.cssText = [
    `display:flex`,
    `align-items:${alignItems}`,
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
    embeds[i].style.cssText = [
      `flex:${flexGrow} 1 0%`,
      `overflow:hidden`,
      `min-width:50px`,
      `position:relative`,
      `margin:0`,
      `padding:0`,
      `display:flex`,
      `justify-content:${justifyContent}`,
      `align-items:flex-start`,
    ].join(";");

    const embedImgs = Array.from(embeds[i].querySelectorAll<HTMLImageElement>("img"));
    for (const img of embedImgs) {
      img.style.cssText = [
        `width:100%`,
        `height:100%`,
        `object-fit:contain`,
        `object-position:${objectPosition}`,
        `display:block`,
      ].join(";");
    }
    row.appendChild(embeds[i]);
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
    let el: HTMLElement | null = img.parentElement;
    while (el && el !== row) {
      if (!(el instanceof HTMLElement && embeds.includes(el))) {
        el.style.setProperty("display", "contents", "important");
      }
      el = el.parentElement;
    }
  }

  // Compute proper row height after DOM insertion (needs container width)
  const applySizes = () => {
    const containerWidth = row.getBoundingClientRect().width;
    if (containerWidth === 0) return;
    const currentMetas = imgs.map((img) => ({
      naturalWidth: img.naturalWidth || 0,
      naturalHeight: img.naturalHeight || 0,
    }));
    const allReady = currentMetas.every((m) => m.naturalWidth > 0);
    if (!allReady) return;

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
      let totalG = 0;
      for (let i = 0; i < n; i++) totalG += finalGrows[i];
      const AW = containerWidth - (n - 1) * options.gap;
      let maxH = 0;
      const debugHeights: Array<{ i: number; scale: number | null; itemW: number; ar: number; imageH: number; fallback: boolean }> = [];
      for (let i = 0; i < n; i++) {
        const scale = scales[i];
        let imageH: number;
        let fallback = false;
        if (scale != null && scale > 0 && scale <= 1) {
          const itemW = (finalGrows[i] / totalG) * AW;
          const meta = currentMetas[i];
          const ar = meta.naturalWidth / meta.naturalHeight;
          imageH = Math.round(scale * itemW / ar);
        } else {
          // Fall back to uniform height
          imageH = computeRowHeight(finalGrows, currentMetas, containerWidth, options.gap, options.defaultRowHeight);
          fallback = true;
        }
        debugHeights.push({ i, scale, itemW: (finalGrows[i] / totalG) * AW, ar: currentMetas[i].naturalWidth / currentMetas[i].naturalHeight, imageH, fallback });
        const hPx = `${imageH}px`;
        embeds[i].style.flex = `${finalGrows[i]} 1 0%`;
        embeds[i].style.height = hPx;
        const embedImg = embeds[i].querySelector<HTMLImageElement>("img");
        if (embedImg) {
          embedImg.style.height = hPx;
          embedImg.style.width = "auto";
        }
        maxH = Math.max(maxH, imageH);
      }
      row.style.height = `${maxH}px`;
      logger.debug("RM applySizes scale-based heights", {
        totalG,
        AW,
        maxH,
        heights: debugHeights,
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
        embeds[j].style.flex = `${finalGrows[j]} 1 0%`;
        embeds[j].style.height = `${rowHeightPx}px`;
        const embedImg = embeds[j].querySelector<HTMLImageElement>("img");
        if (embedImg) {
          embedImg.style.height = `${rowHeightPx}px`;
          embedImg.style.width = "auto";
        }
      }
    }

    // ── RENDER_COMPARE: cross-mode comparison log ──
    requestAnimationFrame(() => {
      const containerRect = row.getBoundingClientRect();
      const containerCS = row.style;
      const images = imgs.map((img, i) => {
        const imgRect = img.getBoundingClientRect();
        const itemRect = embeds[i]?.getBoundingClientRect() ?? imgRect;
        const computed = getComputedStyle(img);
        return {
          index: i,
          imgRect: { x: Math.round(imgRect.x), y: Math.round(imgRect.y), w: Math.round(imgRect.width), h: Math.round(imgRect.height) },
          itemRect: { x: Math.round(itemRect.x), y: Math.round(itemRect.y), w: Math.round(itemRect.width), h: Math.round(itemRect.height) },
          imgStyle: {
            width: computed.width,
            height: computed.height,
            objectFit: computed.objectFit,
            objectPosition: computed.objectPosition,
          },
          natural: { w: img.naturalWidth, h: img.naturalHeight },
          scale: scales[i],
        };
      });
      logger.info("RENDER_COMPARE ReadingMode", {
        containerRect: { x: Math.round(containerRect.x), y: Math.round(containerRect.y), w: Math.round(containerRect.width), h: Math.round(containerRect.height) },
        containerStyle: { height: containerCS.height, justifyContent: containerCS.justifyContent },
        alignment: options.alignment,
        images,
      });
    });
  };

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
