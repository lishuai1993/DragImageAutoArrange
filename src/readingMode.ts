import { App, TFile, MarkdownPostProcessorContext } from "obsidian";
import { CLASSES } from "./constants";
import { ImageRowOptions } from "./imageRowWidget";
import { ImageMeta } from "./imageDetector";
import { computeFlexGrows, computeUniformHeight, computeRowHeight } from "./layoutEngine";
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
  return (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
    if (!enabled()) return;

    // In Reading Mode Obsidian creates .internal-embed placeholders first
    // and loads <img> tags asynchronously later.  We cannot rely on
    // .image-embed class or <img> being present when the post-processor
    // runs.  Instead, detect .internal-embed elements, filter to image
    // embeds by file extension, then use a MutationObserver to wait for
    // <img> elements before applying the flex row layout.
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

    // --- Step 1: Group consecutive embeds ---
    const groups = buildEmbedGroups(imageEmbeds);
    const options = getOptions();

    logger.debug("ReadingMode processor", {
      embedCount: imageEmbeds.length,
      groupCount: groups.length,
      sourcePath: ctx.sourcePath,
      groups: groups.map((g) => g.length),
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

function buildEmbedGroups(embeds: HTMLElement[]): HTMLElement[][] {
  const groups: HTMLElement[][] = [];
  let current: HTMLElement[] = [];

  for (let i = 0; i < embeds.length; i++) {
    const embed = embeds[i];

    if (current.length === 0) {
      current.push(embed);
      continue;
    }

    const prev = current[current.length - 1];
    const consecutive = areEmbedsConsecutive(prev, embed);

    logger.debug("ReadingMode buildEmbedGroups decision", {
      index: i,
      areConsecutive: consecutive,
      prevBlock: findBlockParent(prev)?.tagName ?? null,
      currBlock: findBlockParent(embed)?.tagName ?? null,
    });

    if (consecutive) {
      current.push(embed);
    } else {
      if (current.length >= 2) groups.push([...current]);
      current = [embed];
    }
  }
  if (current.length >= 2) groups.push([...current]);

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

  // Collect image elements, natural metadata, and markdown |width values.
  // In Reading Mode Obsidian renders ![[file|960]] as <img width="960">,
  // so we can recover the flex-grow from the HTML width attribute.
  const imgs: HTMLImageElement[] = [];
  const metas: ImageMeta[] = [];
  const explicitWidths: Array<number | null> = [];
  for (const embed of embeds) {
    const img = embed.querySelector<HTMLImageElement>("img");
    if (img) {
      imgs.push(img);
      metas.push({
        naturalWidth: img.naturalWidth || 0,
        naturalHeight: img.naturalHeight || 0,
      });
      const wAttr = img.getAttribute("width");
      explicitWidths.push(wAttr ? parseInt(wAttr, 10) : null);
    } else {
      metas.push({ naturalWidth: 0, naturalHeight: 0 });
      explicitWidths.push(null);
    }
  }

  const allLoaded = metas.every((m) => m.naturalWidth > 0);
  const hasExplicit = explicitWidths.some((w) => w !== null);

  // Build flex-grows: explicit |width takes priority, else compute from aspect ratio
  const grows: number[] = [];
  if (allLoaded && hasExplicit) {
    for (let i = 0; i < metas.length; i++) {
      grows[i] = explicitWidths[i] !== null ? explicitWidths[i]! / 100 : computeFlexGrows(metas)[i];
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
  row.style.cssText = `display:flex;align-items:stretch;justify-content:${justifyContent};gap:${options.gap}px;width:100%;overflow:hidden;`;

  // Set initial row height
  let rowH = options.defaultRowHeight;
  const firstImg = embeds[0].querySelector<HTMLImageElement>("img");
  if (firstImg?.naturalWidth) {
    rowH = Math.min(options.defaultRowHeight * 3, Math.max(50, rowH));
  }
  row.style.height = `${rowH}px`;

  // Apply styles to each embed directly (Reading Mode uses embed elements
  // as flex items since all embeds may share the same block parent).
  // Remove <br> separators between embeds first.
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

  firstBlock.replaceWith(row);

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

    // Re-read explicit widths in case they changed
    const currentExplicits: Array<number | null> = [];
    for (const img of imgs) {
      const wAttr = img.getAttribute("width");
      currentExplicits.push(wAttr ? parseInt(wAttr, 10) : null);
    }
    const curHasExplicit = currentExplicits.some((w) => w !== null);

    // Build final flex-grows
    const finalGrows: number[] = [];
    if (curHasExplicit) {
      const aspectGrows = computeFlexGrows(currentMetas);
      for (let i = 0; i < currentMetas.length; i++) {
        finalGrows[i] = currentExplicits[i] !== null ? currentExplicits[i]! / 100 : aspectGrows[i];
      }
    } else {
      const cg = computeFlexGrows(currentMetas);
      for (let i = 0; i < currentMetas.length; i++) finalGrows[i] = cg[i];
    }

    // Use computeRowHeight when explicit widths exist (matches Live Preview
    // recalculateRowHeight path), otherwise computeUniformHeight.
    let rowHeightPx: number;
    if (curHasExplicit) {
      rowHeightPx = computeRowHeight(
        finalGrows,
        currentMetas,
        containerWidth,
        options.gap,
        options.defaultRowHeight
      );
    } else {
      const result = computeUniformHeight(
        currentMetas,
        containerWidth,
        options.gap,
        50,
        options.defaultRowHeight * 3
      );
      rowHeightPx = result.rowHeight;
    }

    row.style.height = `${rowHeightPx}px`;
    for (let j = 0; j < embeds.length; j++) {
      embeds[j].style.flex = `${finalGrows[j]} 1 0%`;
      embeds[j].style.height = `${rowHeightPx}px`;
    }

    // ── COMPUTED check: settings vs browser actual ──
    requestAnimationFrame(() => {
      for (let j = 0; j < embeds.length; j++) {
        const embed = embeds[j];
        const img = imgs[j];
        if (!img || !img.isConnected) continue;
        const cs = getComputedStyle(img);
        const rect = img.getBoundingClientRect();
        const embedRect = embed.getBoundingClientRect();
        logger.debug("ReadingMode applySizes COMPUTED", {
          index: j,
          settings: {
            alignment: options.alignment,
            defaultRowHeight: options.defaultRowHeight,
            gap: options.gap,
            justifyContent,
            objectPosition,
          },
          explicitWidth: currentExplicits[j],
          finalFlexGrow: finalGrows[j],
          rowHeightPx,
          containerWidth,
          naturalW: currentMetas[j].naturalWidth,
          naturalH: currentMetas[j].naturalHeight,
          inline: {
            w: img.style.width,
            h: img.style.height,
            op: img.style.objectPosition,
            of: img.style.objectFit,
          },
          computed: {
            op: cs.objectPosition,
            of: cs.objectFit,
            w: cs.width,
            h: cs.height,
          },
          rendered: {
            imgW: Math.round(rect.width),
            imgH: Math.round(rect.height),
            embedW: Math.round(embedRect.width),
            embedH: Math.round(embedRect.height),
          },
        });
      }
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
