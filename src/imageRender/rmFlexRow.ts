import { App, TFile } from "obsidian";
import { CLASSES } from "../constants";
import { ImageRowOptions } from "../types";
import { ImageMeta } from "../imageParse/imageDetector";
import { computeFlexGrows, computeRowHeight, computeScaleBasedHeights } from "../imageLayout/layoutEngine";
import { alignmentToCSS } from "../utils";
import { logger } from "../logger";
const log = logger.channel("rmFlexRow");
import { validateRowFlexGrows } from "../imageLayout/parameterValidator";
import { stripObsidianClasses, hasObsidianAlignClass, neutralizeWrappers } from "./rowRenderer";
import { storePendingAlignment, AlignValue } from "./rmAlignStore";

/** Extract the filename from an .internal-embed by reading the <img> src attribute. */
export function getFileNameFromEmbed(embed: HTMLElement): string {
  const img = embed.querySelector<HTMLImageElement>("img");
  if (!img) return "";
  const src = img.src || img.getAttribute("src") || "";
  const match = src.match(/\/([^\/\?]+\.\w+)(?:\?|$)/);
  return match ? decodeURIComponent(match[1]) : "";
}

export function isImageEmbed(el: HTMLElement): boolean {
  const src = el.getAttribute("src") || "";
  const alt = el.getAttribute("alt") || "";
  const re = /\.(png|jpg|jpeg|gif|webp|svg|bmp|avif)$/i;
  if (re.test(src) || re.test(alt)) return true;
  if (el.querySelector("img")) return true;
  return false;
}

// ── DOM utilities ──────────────────────────────────────────

export function findBlockParent(el: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = el.parentElement;
  while (cur) {
    const d = window.getComputedStyle(cur).display;
    if (d === "block" || d === "flex" || d === "list-item") return cur;
    cur = cur.parentElement;
  }
  return el.parentElement;
}

export function isImageOnlyBlock(block: HTMLElement | null): boolean {
  if (!block) return false;
  const children = Array.from(block.children);
  if (children.length === 0) return false;
  return children.every(
    (c) => c.classList.contains("internal-embed") || c.tagName === "BR"
  );
}

export function applyStandaloneAlignment(
  embed: HTMLElement,
  defaultAlignment: "left" | "center" | "right"
): void {
  const block = findBlockParent(embed);
  if (!block || !isImageOnlyBlock(block)) return;
  const perImage = embed.getAttribute("data-diaa-alignment") as "left" | "center" | "right" | null;
  const alignment = perImage ?? defaultAlignment;
  const textAlign = alignment === "center" ? "center" : alignment === "right" ? "right" : "left";

  // isImageOnlyBlock ignores text nodes, so a "text\n![[img]]" paragraph (one
  // block holding text + a single image) passes its check. Setting text-align
  // on that block would drag the text along with the image. Detect the mixed
  // case and, when present, extract the image into its own aligned block so the
  // text keeps its default flow — text stays text, image stays image.
  const probe = block.cloneNode(true) as HTMLElement;
  probe.querySelectorAll(".internal-embed").forEach((e) => e.remove());
  const blockHasText = (probe.textContent ?? "").trim().length > 0;

  if (!blockHasText) {
    // Pure image block: align the block itself (original behavior).
    block.style.setProperty("text-align", textAlign, "important");
    embed.style.setProperty("display", "inline-block", "important");
    return;
  }

  // Is there text BEFORE the embed within the block? Used to preserve source
  // order when placing the extracted image relative to the text block.
  let textBefore = false;
  for (let node = embed.previousSibling; node; node = node.previousSibling) {
    if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim()) { textBefore = true; break; }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      if (!el.classList.contains("internal-embed") && el.tagName !== "BR" && (el.textContent ?? "").trim()) {
        textBefore = true;
        break;
      }
    }
  }

  // Drop the <br> siblings flanking the embed so the text block doesn't keep a
  // dangling blank line once the image is pulled out.
  const prevBr = embed.previousElementSibling;
  if (prevBr?.tagName === "BR") prevBr.remove();
  const nextBr = embed.nextElementSibling;
  if (nextBr?.tagName === "BR") nextBr.remove();

  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-diaa-standalone", "true");
  wrapper.style.setProperty("text-align", textAlign, "important");
  embed.style.setProperty("display", "inline-block", "important");
  wrapper.appendChild(embed);

  if (textBefore) {
    block.after(wrapper);   // text above, image below
  } else {
    block.before(wrapper);  // image above, text below
  }

  // Clean up any <br> left dangling at the edges of the text block.
  while (block.lastElementChild?.tagName === "BR") block.lastElementChild.remove();
  while (block.firstElementChild?.tagName === "BR") block.firstElementChild.remove();
}

export function areAdjacentSiblings(a: HTMLElement | null, b: HTMLElement | null): boolean {
  if (!a || !b || a.parentElement !== b.parentElement) return false;
  const sibs = Array.from(a.parentElement!.children);
  return Math.abs(sibs.indexOf(a) - sibs.indexOf(b)) === 1;
}

/** Check if two embeds are consecutive — handles both same-block (Reading Mode, separated by <br>) and different-block (Live Preview) layouts. */
export function areEmbedsConsecutive(prev: HTMLElement, curr: HTMLElement): boolean {
  const prevBlock = findBlockParent(prev);
  const currBlock = findBlockParent(curr);

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

  return Boolean(
    prevBlock && currBlock &&
    isImageOnlyBlock(prevBlock) &&
    areAdjacentSiblings(prevBlock, currBlock)
  );
}

// ── Flex row wrapping ────────────────────────────────────────

export function wrapAsFlexRow(embeds: HTMLElement[], options: ImageRowOptions, app?: App, sourcePath?: string): void {
  try {
  const firstBlock = findBlockParent(embeds[0]);
  if (!firstBlock) return;

  // Detect whether the first embed's block also holds surrounding text — this
  // happens when a paragraph is "text\n![[img]]\n![[img]]" with no blank line,
  // so text + embeds render inside one <p>. In that case the text must stay in
  // place and the flex row goes AFTER the block to preserve source order;
  // otherwise the block is image-only and the row goes BEFORE it (existing
  // behavior). `.internal-embed` elements carry no text, so stripping them and
  // checking the remainder reliably distinguishes the two cases.
  const textProbe = firstBlock.cloneNode(true) as HTMLElement;
  textProbe.querySelectorAll(".internal-embed").forEach((e) => e.remove());
  const blockHasText = (textProbe.textContent ?? "").trim().length > 0;

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

  log.debug("RM wrapAsFlexRow entry", {
    n: embeds.length,
    defaultAlignment: options.alignment,
    readAlignments: alignments.map(a => a ?? "(default)"),
    readFlexGrows: parsedFlexGrows.map(f => f ?? "(none)"),
    readScales: scales.map(s => s == null ? "(none)" : Math.round(s * 100)),
    hasScale,
  });

  const allLoaded = metas.every((m) => m.naturalWidth > 0);
  const hasParsedGrows = parsedFlexGrows.some((g) => g !== null);

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

  let rowH = options.defaultRowHeight;
  const firstImg = embeds[0].querySelector<HTMLImageElement>("img");
  if (firstImg?.naturalWidth) {
    rowH = Math.min(options.defaultRowHeight * 3, Math.max(50, rowH));
  }
  row.style.height = `${rowH}px`;

  for (const embed of embeds) {
    const next = embed.nextElementSibling;
    if (next?.tagName === "BR") next.remove();
  }

  for (let i = 0; i < embeds.length; i++) {
    const flexGrow = grows[i] || 1;
    const embed = embeds[i];
    const perImageAlign = alignments[i] ?? options.alignment;
    const { justifyContent: ji, objectPosition: oi } = alignmentToCSS(perImageAlign);
    embed.style.setProperty("flex", `${flexGrow} 1 0%`, "important");
    embed.style.setProperty("overflow", "hidden", "important");
    embed.style.setProperty("min-width", "50px", "important");
    embed.style.setProperty("position", "relative", "important");
    embed.style.setProperty("margin", "0", "important");
    embed.style.setProperty("padding", "0", "important");
    embed.style.setProperty("display", "flex", "important");
    embed.style.setProperty("justify-content", ji, "important");
    embed.style.setProperty("align-items", "flex-start", "important");

    log.debug("RM wrapAsFlexRow item-style", {
      i,
      fileName: getFileNameFromEmbed(embed),
      perImageAlign,
      flexGrow,
      justifyContent: ji,
      objectPosition: oi,
      height: embed.style.height,
    });

    const embedImgs = Array.from(embed.querySelectorAll<HTMLImageElement>("img"));
    for (const img of embedImgs) {
      stripObsidianClasses(img);
      img.style.setProperty("width", "100%", "important");
      img.style.setProperty("height", "100%", "important");
      img.style.setProperty("object-fit", "contain", "important");
      img.style.setProperty("object-position", oi, "important");
      img.style.setProperty("display", "block", "important");
      img.style.setProperty("margin", "0", "important");

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

  if (blockHasText) {
    // Keep the surrounding text in place; the flex row follows it.
    firstBlock.after(row);
    // Drop any <br> left dangling at the end of the text block after the
    // embeds were pulled out, so the text doesn't gain a trailing blank line.
    while (firstBlock.lastElementChild?.tagName === "BR") {
      firstBlock.lastElementChild.remove();
    }
  } else {
    firstBlock.before(row);
  }
  const blocksToRemove = new Set<HTMLElement>();
  for (const embed of embeds) {
    const block = findBlockParent(embed);
    if (block && block !== row) {
      blocksToRemove.add(block);
    }
  }
  for (const block of blocksToRemove) {
    if (!block.querySelector(".internal-embed")) {
      block.remove();
    }
  }

  for (const img of imgs) {
    neutralizeWrappers(img, row, embeds);
  }

  const applySizes = () => {
    try {
    const containerWidth = row.getBoundingClientRect().width;
    if (containerWidth === 0) {
      if (row.isConnected) requestAnimationFrame(() => applySizes());
      return;
    }
    const currentMetas = imgs.map((img) => ({
      naturalWidth: img.naturalWidth || 0,
      naturalHeight: img.naturalHeight || 0,
    }));
    const allReady = currentMetas.every((m) => m.naturalWidth > 0);
    if (!allReady) {
      if (row.isConnected) requestAnimationFrame(() => applySizes());
      return;
    }

    const currentParsedGrows: Array<number | null> = [];
    for (const embed of embeds) {
      const fg = embed.getAttribute("data-diaa-flexgrow");
      currentParsedGrows.push(fg ? parseFloat(fg) : null);
    }
    const curHasExplicit = currentParsedGrows.some((g) => g !== null);

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

    const validatedGrows = validateRowFlexGrows(finalGrows, currentMetas, containerWidth, options.gap);
    for (let _i = 0; _i < finalGrows.length; _i++) finalGrows[_i] = validatedGrows[_i];

    log.debug("RM applySizes flexGrows", {
      containerWidth,
      currentParsedGrows,
      curHasExplicit,
      finalGrows: [...finalGrows],
      scales: scales.map((s) => s == null ? null : Math.round(s * 100)),
      hasScale,
      n: embeds.length,
    });

    const n = embeds.length;

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
          stripObsidianClasses(embedImg);
          embedImg.style.setProperty("height", hPx, "important");
          embedImg.style.setProperty("width", "auto", "important");
          embedImg.style.setProperty("margin", "0", "important");
        }
      }
      row.style.height = `${maxH}px`;
      log.debug("RM applySizes scale-based heights", {
        maxH,
        heights,
      });
    } else {
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
        log.info("RM ROW render diagnostic", {
          n: embeds.length,
          rowSetH: row.style.height,
          rowRectH: Math.round(rowRect.height),
          rowOverflow: getComputedStyle(row).overflow,
          items,
          clippers,
        });
      } catch (e) {
        log.warn("RM ROW render diagnostic error", { error: String(e) });
      }
    };
    requestAnimationFrame(() => {
      rowDiagnostic();
      requestAnimationFrame(() => rowDiagnostic());
    });

    if (embeds.length === 3 && imgs[0]?.isConnected) {
      const trackImage0 = () => {
        const img = imgs[0];
        if (!img?.isConnected) return;
        const containerRect = row.getBoundingClientRect();
        const itemRect = embeds[0].getBoundingClientRect();
        const imgRect = img.getBoundingClientRect();
        const cs = getComputedStyle(img);
        const itemCS = getComputedStyle(embeds[0]);
        log.info("RM ROW1_IMG0 render snapshot", {
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
        requestAnimationFrame(() => trackImage0());
      });
    }

    } catch (e) {
      log.error("RM applySizes error", { error: String(e), stack: (e as Error)?.stack ?? "no stack" });
    }
  };

  let lastRowWidth = 0;
  const sizeObserver = new ResizeObserver(() => {
    const w = row.isConnected ? Math.round(row.getBoundingClientRect().width) : 0;
    if (w > 0 && w !== lastRowWidth) {
      lastRowWidth = w;
      applySizes();
    }
  });
  sizeObserver.observe(row);

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
    log.error("RM wrapAsFlexRow error", { error: String(e), stack: (e as Error)?.stack ?? "no stack" });
  }
}

// ── Wait for async image loading ─────────────────────────────

export function waitForImagesThenWrap(embeds: HTMLElement[], options: ImageRowOptions, app?: App, sourcePath?: string): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };

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

export function makeImagesDraggable(app: App, sourcePath: string, embeds: HTMLElement[]): void {
  let draggableCount = 0;
  for (const embed of embeds) {
    const block = findBlockParent(embed);
    if (!block) {
      log.debug("ReadingMode makeDraggable skip: no block parent", {
        embedTag: embed.tagName,
      });
      continue;
    }

    block.setAttribute("draggable", "true");
    block.classList.add("diaa-draggable");
    for (const img of Array.from(block.querySelectorAll("img"))) {
      img.setAttribute("draggable", "false");
    }
    draggableCount++;

    block.addEventListener("dragstart", (e) => {
      log.debug("ReadingMode dragstart", { sourcePath });
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
  log.debug("ReadingMode makeDraggable done", {
    draggableCount,
    totalEmbeds: embeds.length,
  });
}

export function removeAllDropIndicators(): void {
  for (const p of dragPlaceholders) p.remove();
  dragPlaceholders = [];
}

function isImageEmbedLine(line: string): boolean {
  const re = /^\s*!\[\[([^\]]+\.(?:png|jpg|jpeg|gif|webp|svg|bmp|avif))(?:\|\d+)?\]\]\s*$/i;
  return re.test(line);
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

    log.info("ReadingMode drag-drop reorder", {
      srcDomIdx,
      dstDomIdx,
      srcLine,
      dstLine,
      insertBefore,
      totalImages: imageLineNumbers.length,
    });

    const [removed] = lines.splice(srcLine, 1);
    const adjustedDst = srcLine < dstLine ? dstLine - 1 : dstLine;
    const insertAt = insertBefore ? adjustedDst : adjustedDst + 1;
    lines.splice(insertAt, 0, removed);

    return lines.join("\n");
  });
}
