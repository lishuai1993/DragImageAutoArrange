import { App, TFile, MarkdownPostProcessorContext } from "obsidian";
import { CLASSES } from "./constants";
import { ImageRowOptions } from "./imageRowWidget";
import { logger } from "./logger";

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
    // Always log entry so we can tell if the processor is invoked at all
    const allEmbeds = el.querySelectorAll(".internal-embed.image-embed");
    logger.debug("ReadingMode processor invoked", {
      sourcePath: ctx.sourcePath,
      embedCount: allEmbeds.length,
      enabled: enabled(),
    });

    if (!enabled()) return;

    const embeds = Array.from(allEmbeds) as HTMLElement[];
    if (embeds.length === 0) return;

    // --- Step 1: Group consecutive embeds ---
    const groups = buildEmbedGroups(embeds);
    const options = getOptions();

    logger.debug("ReadingMode processor", {
      embedCount: embeds.length,
      groupCount: groups.length,
      sourcePath: ctx.sourcePath,
      groups: groups.map((g) => g.length),
    });

    // --- Step 2: Wrap groups in flex rows, make items draggable ---
    for (const group of groups) {
      if (group.length >= 2) {
        wrapAsFlexRow(group, options);
      }
    }

    // --- Step 3: Make ALL image items draggable for merge/reorder ---
    makeImagesDraggable(app, ctx.sourcePath, embeds);
  };
}

// ── Group detection ──────────────────────────────────────────

interface EmbedInfo {
  el: HTMLElement;
  block: HTMLElement | null; // nearest block-level parent
}

function buildEmbedGroups(embeds: HTMLElement[]): HTMLElement[][] {
  const groups: HTMLElement[][] = [];
  let current: HTMLElement[] = [];

  for (let i = 0; i < embeds.length; i++) {
    const embed = embeds[i];
    const block = findBlockParent(embed);

    if (current.length === 0) {
      current.push(embed);
      continue;
    }

    const prev = current[current.length - 1];
    const prevBlock = findBlockParent(prev);

    if (isImageOnlyBlock(prevBlock) && block && areAdjacentSiblings(prevBlock, block)) {
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
  const hasImg = block.querySelector(".internal-embed.image-embed") !== null;
  if (!hasImg) return false;
  for (const child of Array.from(block.children)) {
    if (!child.classList.contains("internal-embed") || !child.classList.contains("image-embed")) {
      return false;
    }
  }
  return true;
}

function areAdjacentSiblings(a: HTMLElement | null, b: HTMLElement | null): boolean {
  if (!a || !b || a.parentElement !== b.parentElement) return false;
  const sibs = Array.from(a.parentElement!.children);
  return Math.abs(sibs.indexOf(a) - sibs.indexOf(b)) === 1;
}

// ── Flex row wrapping ────────────────────────────────────────

function wrapAsFlexRow(embeds: HTMLElement[], options: ImageRowOptions): void {
  const firstBlock = findBlockParent(embeds[0]);
  if (!firstBlock) return;

  const blocks = new Set<HTMLElement>();
  for (const e of embeds) {
    const b = findBlockParent(e);
    if (b) blocks.add(b);
  }
  const blockList = [...blocks];

  const row = document.createElement("div");
  row.className = CLASSES.row;
  row.setAttribute("data-diaa-group", "true");
  row.style.cssText = `display:flex;align-items:flex-start;gap:${options.gap}px;width:100%;overflow:hidden;`;

  let rowH = options.defaultRowHeight;
  const firstImg = embeds[0].querySelector("img");
  if (firstImg?.naturalWidth) {
    rowH = Math.min(options.defaultRowHeight * 3, Math.max(50, rowH));
  }
  row.style.height = `${rowH}px`;

  for (const b of blockList) {
    b.style.cssText = `flex:1 1 0;overflow:hidden;min-width:50px;position:relative;margin:0;padding:0;`;
    const imgs = Array.from(b.querySelectorAll<HTMLImageElement>("img"));
    for (const img of imgs) {
      img.style.cssText = "width:100%;height:100%;object-fit:contain;display:block;";
    }
    row.appendChild(b);
  }

  firstBlock.replaceWith(row);
  if (blockList[0] !== row.firstChild) {
    row.insertBefore(blockList[0], row.firstChild);
  }
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
