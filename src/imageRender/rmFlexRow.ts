import { App, TFile } from "obsidian";
import { CLASSES, SINGLE_IMAGE_MIN_WIDTH, computeInterItemSpace } from "../constants";
import { ImageRowOptions } from "../types";
import { ImageMeta } from "../imageParse/imageDetector";
import { computeFlexGrows, computeRowHeight, computeScaleBasedHeights, computeSingleImageWidth, drawnHeightCoefficient } from "../imageLayout/layoutEngine";
import { alignmentToCSS, isNarrowViewport, onNarrowViewportChange, setStyleImportant } from "../utils";
import { logger } from "../logger";
const log = logger.channel("rmFlexRow");
import { validateRowFlexGrows } from "../imageLayout/parameterValidator";
import { stripObsidianClasses, hasObsidianAlignClass, neutralizeWrappers } from "./rowRenderer";
import { storePendingAlignment } from "./rmAlignStore";
import { attachDiaImageMarkers } from "./imageMarkers";
import { IDENTITY_STATE, isIdentityOrientation, orientationWord, orientedSize, parseOrientationWord, quarterTurnFitScale, type OrientationState } from "../imageTransform/orientation";
import { applyOrientationPreview, boxForScreenWidth, displayedImageSize, naturalAspect } from "../imageTransform/transformPreview";
import { emitSnapshot, isGeometryProbeEnabled } from "../diagnostics/probe";
import { round2, snapshotPayload, type MemberFrames } from "../diagnostics/rowSnapshot";

/** Diagnostics (temporary): coalesce a row's settle burst into one snapshot. */
const rmSnapshotTimers = new Map<string, number>();

/**
 * The layout-box height our own sizing wrote onto an img, keyed by the element.
 * The style guard restores *this* value rather than the embed's height: a
 * quarter-turned member keeps an un-rotated box that is deliberately taller than
 * the embed it sits in, and putting the embed's height back would erase the box
 * the turn is measured against.
 */
const sizedImgBoxH = new WeakMap<HTMLImageElement, number>();

/** Write an img's layout-box height and remember it for the guard. */
function setImgBoxHeight(img: HTMLImageElement, boxH: number): void {
  sizedImgBoxH.set(img, boxH);
  setStyleImportant(img, "height", `${boxH}px`);
}

/**
 * Keep a sized img's box ours.  Obsidian writes its own inline styles and
 * alignment classes onto embed images, and both outrank what we set; the guard
 * puts back the height the sizing wrote.  It also runs on our *own* writes — a
 * matching value is what makes that a no-op instead of a fight.
 */
function guardImgBox(img: HTMLImageElement): void {
  const guard = new MutationObserver((mutations, obs) => {
    for (const m of mutations) {
      if (m.type !== "attributes") continue;
      const attr = m.attributeName;
      if (attr !== "class" && attr !== "style") continue;
      const target = m.target as HTMLImageElement;
      const itemEl = target.closest<HTMLElement>(".internal-embed");
      if (!itemEl) continue;
      const knownBoxH = sizedImgBoxH.get(target);
      const expectedH = knownBoxH !== undefined ? `${knownBoxH}px` : itemEl.style.height;
      const hasClasses = hasObsidianAlignClass(target);
      const heightMismatch = attr === "style" && !!expectedH && target.style.height !== expectedH;
      if (!hasClasses && !heightMismatch) continue;
      obs.disconnect();
      if (hasClasses) {
        stripObsidianClasses(target);
      }
      if (heightMismatch) {
        log.debug("RM styleGuard restored img height", {
          fileName: getFileNameFromEmbed(itemEl),
          obsidianSet: target.style.height,
          restored: expectedH,
          source: knownBoxH !== undefined ? "writtenBoxH" : "embedHeight",
          attr,
          hadObsidianClasses: hasClasses,
        });
        setStyleImportant(target, "height", expectedH);
      }
      obs.observe(target, { attributes: true, attributeFilter: ["class", "style"] });
    }
  });
  guard.observe(img, { attributes: true, attributeFilter: ["class", "style"] });
}

function scheduleRmSnapshot(key: string, build: () => Record<string, unknown>): void {
  if (!isGeometryProbeEnabled()) return;
  const pending = rmSnapshotTimers.get(key);
  if (pending !== undefined) window.clearTimeout(pending);
  const id = window.setTimeout(() => {
    rmSnapshotTimers.delete(key);
    emitSnapshot(key, "DIAAGEO row", build());
  }, 200);
  rmSnapshotTimers.set(key, id);
}

/** One member's three frames, in the same shape the Live Preview widget
 *  reports, so a Reading Mode row and a Live Preview row can be compared. */
function rmMemberFrames(
  embed: HTMLElement,
  img: HTMLImageElement,
  model: {
    word: string;
    fill: number | null;
    share: number | null;
    boxH: number;
    drawn: number;
    expectedScale: number | null;
  }
): MemberFrames {
  const aspect = img.naturalWidth > 0 && img.naturalHeight > 0
    ? img.naturalWidth / img.naturalHeight
    : 1;
  const itemRect = embed.getBoundingClientRect();
  const imgRect = img.getBoundingClientRect();
  const cs = getComputedStyle(img);
  return {
    label: getFileNameFromEmbed(embed) || "(unknown)",
    model: {
      ...model,
      aspect: Number(aspect.toFixed(4)),
      boxW: Number((model.boxH * aspect).toFixed(2)),
    },
    wrote: {
      imgW: parseFloat(img.style.width) || null,
      imgH: parseFloat(img.style.height) || null,
      itemW: parseFloat(embed.style.width) || null,
      itemH: parseFloat(embed.style.height) || null,
      imgTransform: img.style.transform,
    },
    measured: {
      itemW: round2(itemRect.width),
      itemH: round2(itemRect.height),
      imgClientW: img.clientWidth,
      imgClientH: img.clientHeight,
      paintW: round2(imgRect.width),
      paintH: round2(imgRect.height),
      paintOffsetX: round2(imgRect.left - itemRect.left),
      paintOffsetY: round2(imgRect.top - itemRect.top),
      transform: cs.transform,
      display: cs.display,
    },
  };
}

/** Every embed's persisted rotate/flip, in item order — the frame the height
 *  model reads, since a quarter turn repaints a member's box on its side. */
function readOrientations(embeds: HTMLElement[]): Array<OrientationState | null> {
  return embeds.map((embed) => parseOrientationWord(embed.getAttribute("data-diaa-orientation") ?? ""));
}

/** Replay each embed's persisted rotate/flip word as a CSS transform on its
 *  <img>.  Identity / attribute-less embeds are skipped.
 *
 *  The scale is the fit that folds the turned rectangle back inside the
 *  rectangle it came from (`quarterTurnFitScale` — the same number the model's
 *  coefficient is built on, so the two cannot drift): a landscape keeps its
 *  height and narrows, a portrait keeps its width and shortens, and nothing is
 *  ever enlarged, cropped or left to overflow its slot.  Measuring a fit scale
 *  off the DOM would re-derive the same number from a box the turn obscures. */
function applyEmbedOrientations(embeds: HTMLElement[]): void {
  for (const embed of embeds) {
    const state = parseOrientationWord(embed.getAttribute("data-diaa-orientation") ?? "");
    if (!state || isIdentityOrientation(state)) continue;
    for (const img of Array.from(embed.querySelectorAll<HTMLImageElement>("img"))) {
      applyOrientationPreview(img, state, { scale: quarterTurnFitScale(naturalAspect(img)) });
    }
  }
}

/**
 * Size a standalone image embed the way the LP widget sizes a single-image row
 * (`layoutSingleImage`): derive the width the picture should take on the page,
 * turn that into the layout box the transform has to keep (`boxForScreenWidth`),
 * and write the *drawn* size onto the embed so its container hugs the picture.
 *
 * The two frames matters here: a quarter turn repaints the box on its side, so
 * the box is one aspect wider than what the reader sees, and the embed takes the
 * swapped (drawn) rectangle — handing the resulting fit scale to the transform
 * keeps the painted bitmap and the container in agreement.  Read-only: RM
 * renders, it never writes the note.
 *
 * `manualWidthPx` is a `single-manual` row's `|1|W`; null means the row follows
 * the size setting, exactly as the LP path reads the `S` flag.
 */
export function applyStandaloneSize(
  embed: HTMLElement,
  img: HTMLImageElement,
  manualWidthPx: number | null,
  options: ImageRowOptions
): void {
  let pendingFrames = 0;

  const layout = (): void => {
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (nw <= 0 || nh <= 0) return;

    const host = embed.parentElement;
    const containerWidth = Math.round(host?.getBoundingClientRect().width ?? 0);
    if (containerWidth <= 0) {
      // Detached or not laid out yet — the post-processor runs on sections
      // Obsidian may not have attached.  Retry briefly, then give up rather
      // than spin on a section that never lands.
      if (pendingFrames++ < 30 && embed.isConnected) window.requestAnimationFrame(layout);
      return;
    }

    const state = parseOrientationWord(embed.getAttribute("data-diaa-orientation") ?? "")
      ?? IDENTITY_STATE;
    const turned = state.turns % 2 === 1;
    const aspect = nw / nh;
    // Natural in the *screen* frame: a quarter turn swaps the bitmap's own
    // width and height, so a 2:1 landscape reads as half as wide turned as it
    // does upright.
    const naturalScreenW = orientedSize(state, nw, nh).width;

    const intendedScreenW = manualWidthPx != null
      ? manualWidthPx
      : options.singleImageSizeMode === "fixed"
        ? Math.max(SINGLE_IMAGE_MIN_WIDTH, Math.round(options.singleImageWidth))
        : Math.round(naturalScreenW);

    const renderScreenW = Math.max(1, manualWidthPx != null
      ? Math.min(intendedScreenW, containerWidth)
      : computeSingleImageWidth(
          options.singleImageSizeMode,
          options.singleImageWidth,
          naturalScreenW,
          containerWidth
        ));

    const box = boxForScreenWidth(renderScreenW, aspect, state);
    const imageW = Math.max(1, Math.round(box.width));
    const imageH = Math.max(1, Math.round(box.height));
    const shown = displayedImageSize(imageW, imageH, state, containerWidth);

    setStyleImportant(img, "object-fit", "contain");
    setStyleImportant(img, "display", "block");
    setImgBoxHeight(img, imageH);
    setStyleImportant(img, "width", "auto");
    // The box is allowed to be wider than the container once a turn has the
    // embed sized to the swapped rectangle; a max-width would clamp the box and
    // re-letterbox the bitmap, changing what is drawn.
    setStyleImportant(img, "max-width", turned ? "none" : "100%");

    if (turned) {
      setStyleImportant(embed, "width", `${Math.max(1, Math.round(shown.width))}px`);
      setStyleImportant(embed, "height", `${Math.max(1, Math.round(shown.height))}px`);
      // Centre the box in the embed.  A turn paints about the box's own centre,
      // and the box is one aspect taller than the swapped rectangle the embed
      // takes — pinned to the embed's top-left it would carry the picture half
      // the difference left and down, leaving the drawn rectangle the right size
      // but in the wrong place.  Centring both axes lands the box centre on the
      // embed centre, where the drawn rectangle coincides with the container.
      // inline-flex (not flex) keeps the embed inline-level, so the host block's
      // text-align still places it.
      setStyleImportant(embed, "display", "inline-flex");
      setStyleImportant(embed, "justify-content", "center");
      setStyleImportant(embed, "align-items", "center");
      setStyleImportant(img, "flex-shrink", "0");
    } else {
      embed.style.removeProperty("width");
      embed.style.removeProperty("height");
      // Undo a turn's centring: an even orientation is a shrink-wrapped
      // inline-block again, positioned by the host block's text-align.
      setStyleImportant(embed, "display", "inline-block");
      embed.style.removeProperty("justify-content");
      embed.style.removeProperty("align-items");
      img.style.removeProperty("flex-shrink");
    }

    // Replay the orientation: the note carries the turn as a word, and nothing
    // else in Reading Mode paints it.  The fit scale comes from the size the
    // embed was just given, so the picture and its container agree — a quarter
    // turn hands over `shown.scale`, an even orientation just rotates/flips.
    applyOrientationPreview(img, state, turned ? { scale: shown.scale } : undefined);

    log.debug("RM standalone size", {
      fileName: getFileNameFromEmbed(embed),
      containerWidth,
      manualWidthPx,
      mode: options.singleImageSizeMode,
      turned,
      naturalScreenW,
      intendedScreenW,
      renderScreenW,
      imageW,
      imageH,
      shown,
      orientation: orientationWord(state),
      // Whether the transform was actually replayed here — a quarter turn has
      // to paint through it, and this path has no other writer.
      transformNow: img.style.transform,
    });

    const fileName = getFileNameFromEmbed(embed);
    scheduleRmSnapshot(`rm-standalone:${fileName}`, () => ({
      side: "RM",
      scope: "standalone",
      fileName,
      containerWidth,
      manualWidthPx,
      mode: options.singleImageSizeMode,
      turned,
      members: [
        snapshotPayload(
          rmMemberFrames(embed, img, {
            word: orientationWord(state),
            fill: null,
            share: null,
            boxH: imageH,
            drawn: Math.max(1, Math.round(shown.height)),
            expectedScale: turned ? shown.scale : null,
          })
        ),
      ],
    }));
  };

  layout();
  if (!img.complete) img.addEventListener("load", layout, { once: true });

  // A lone image gets the same policing a row's members get: Obsidian writes
  // its own inline styles and alignment classes onto embed images, and either
  // one would undo the box and the transform the sizing just set.
  guardImgBox(img);

  // A pane resize changes the container width the picture is fitted to, and
  // the image itself does not fire anything — mirror the row path's observer.
  const host = embed.parentElement;
  if (host) {
    let lastWidth = 0;
    const sizeObserver = new ResizeObserver(() => {
      const w = embed.isConnected ? Math.round(host.getBoundingClientRect().width) : 0;
      if (w > 0 && w !== lastWidth) {
        lastWidth = w;
        layout();
      }
    });
    sizeObserver.observe(host);
    const detachObserver = new MutationObserver((_mutations, obs) => {
      if (!embed.isConnected) {
        obs.disconnect();
        sizeObserver.disconnect();
      }
    });
    detachObserver.observe(host, { childList: true });
  }
}

/** Extract the filename from an .internal-embed by reading the <img> src attribute. */
export function getFileNameFromEmbed(embed: HTMLElement): string {
  const img = embed.querySelector<HTMLImageElement>("img");
  if (!img) return "";
  const src = img.src || img.getAttribute("src") || "";
  const match = src.match(/\/([^/?]+\.\w+)(?:\?|$)/);
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

/**
 * Mark an embed as shrink-wrapped, so the text-align its block carries can
 * place it.
 *
 * The class survives as the marker for "this image was pulled out of a mixed
 * text+image block" — nothing in the plugin reads it.  The shrink-wrap itself
 * is written inline, because Obsidian's own `.internal-embed` rule sets
 * `display` too and outranks a plugin class by specificity; inline is the only
 * placement that wins without the stylesheet carrying an `!important`.
 */
function markInlineEmbed(embed: HTMLElement): void {
  embed.addClass(CLASSES.rowInline);
  setStyleImportant(embed, "display", "inline-block");
  // An inline-block sits on the block's baseline, which reserves the font's
  // descender below it — the gap the reader sees under a lone picture (and, on
  // hover, between the picture and the ring drawn on the hosting block).  Top
  // alignment takes the box off the baseline, so the line holds just the box.
  setStyleImportant(embed, "vertical-align", "top");
  const cs = getComputedStyle(embed);
  log.debug("RM markInlineEmbed", {
    fileName: getFileNameFromEmbed(embed),
    display: cs.display,
    verticalAlign: cs.verticalAlign,
    lineHeight: cs.lineHeight,
    fontSize: cs.fontSize,
    hostTag: embed.parentElement?.tagName ?? null,
    hostClass: embed.parentElement?.className ?? null,
  });
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
    markInlineEmbed(embed);
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

  const wrapper = createDiv();
  wrapper.setAttribute("data-diaa-standalone", "true");
  wrapper.style.setProperty("text-align", textAlign, "important");
  markInlineEmbed(embed);
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

  const row = createDiv();
  row.className = CLASSES.row;
  row.setAttribute("data-diaa-group", "true");
  const { justifyContent } = alignmentToCSS(
    embeds.length === 1 ? (alignments[0] ?? options.alignment) : options.alignment
  );
  // The space one junction between adjacent pictures occupies.  Reading Mode
  // renders no dividers, but the figure has to match the widget's all the same:
  // it is what each row's height model divides off, and a narrower figure here
  // would make the same note draw its pictures at a different size per mode.
  const interItemSpace = computeInterItemSpace(options.gap, options.enableDividers);
  row.style.cssText = [
    `display:flex`,
    `align-items:flex-start`,
    `justify-content:${justifyContent}`,
    `gap:${interItemSpace}px`,
    `width:100%`,
    `overflow:hidden`,
  ].join(";");

  let rowH = options.defaultRowHeight;
  const firstImg = embeds[0].querySelector<HTMLImageElement>("img");
  if (firstImg?.naturalWidth) {
    rowH = Math.min(options.defaultRowHeight * 3, Math.max(50, rowH));
  }
  // The starting height is the row's floor until the sizing pass lands.  Below
  // the breakpoint there is no such pass to land, so it is not written at all:
  // the media query's `height: auto` would lose to it and hold the row at a
  // desktop height across the whole narrow session.
  if (!isNarrowViewport()) row.style.height = `${rowH}px`;

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
    embed.style.setProperty("justify-content", ji, "important");
    // The item's fixed styling.  Obsidian's own embed rules set these same
    // properties — sometimes inline — so an inline declaration is the only
    // placement that outranks them without the stylesheet carrying
    // `!important` for each one.  Only flex / justify-content are per-row.
    setStyleImportant(embed, "margin", "0");
    setStyleImportant(embed, "padding", "0");
    setStyleImportant(embed, "overflow", "hidden");
    setStyleImportant(embed, "min-width", "50px");
    setStyleImportant(embed, "position", "relative");
    setStyleImportant(embed, "display", "flex");
    // A quarter-turned member paints the box on its side, scaled down to fit
    // back inside it, so the embed takes the painted height and the box — a
    // different rectangle now — has to sit centred in it.
    const turned = (parseOrientationWord(embed.getAttribute("data-diaa-orientation") ?? "")
      ?.turns ?? 0) % 2 === 1;
    setStyleImportant(embed, "align-items", turned ? "center" : "flex-start");

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
      img.style.setProperty("object-position", oi, "important");
      // The image's geometry is written inline rather than left to the
      // stylesheet: Obsidian's own embed rules set the same properties, and an
      // inline declaration is the only thing that outranks them.  Fill-the-item
      // is the pre-sizing state; applySizes swaps the width to `auto` for the
      // size-by-height rows.
      setStyleImportant(img, "width", "100%");
      setStyleImportant(img, "height", "100%");
      setStyleImportant(img, "object-fit", "contain");
      setStyleImportant(img, "display", "block");
      setStyleImportant(img, "margin", "0");

      guardImgBox(img);

      img.__diaa_alignment = (embed.getAttribute("data-diaa-alignment") || undefined) as "left" | "center" | "right" | undefined;
      img.__diaa_onAlign = (newAlign: "left" | "center" | "right" | undefined) => {
        if (newAlign) {
          embed.setAttribute("data-diaa-alignment", newAlign);
        } else {
          embed.removeAttribute("data-diaa-alignment");
        }
        img.__diaa_alignment = newAlign;
        const align = newAlign ?? options.alignment;
        const { justifyContent: j2, objectPosition: o2 } = alignmentToCSS(align);
        embed.style.setProperty("justify-content", j2, "important");
        img.style.setProperty("object-position", o2, "important");
        if (app && sourcePath) {
          const effectiveAlign = newAlign ?? options.alignment;
          const fn = getFileNameFromEmbed(embed);
          if (fn) storePendingAlignment(sourcePath, fn, effectiveAlign);
        }
      };
      // Read-only reset surface so RM renders the reset row greyed-out.
      attachDiaImageMarkers(img, {
        manualSingle: () => false,
        resetTarget: () => ({
          mode: options.singleImageSizeMode,
          width: options.singleImageWidth,
        }),
        resetSingleManual: null,
        screenWidth: null,
        memberFill: null,
      });
    }
    row.appendChild(embed);
  }

  // Apply the row members' rotate/flip immediately (pre-sizing), then again
  // inside applySizes once heights are known so the fit-scale is accurate.
  applyEmbedOrientations(embeds);

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
      if (row.isConnected) window.requestAnimationFrame(() => applySizes());
      return;
    }
    const currentMetas = imgs.map((img) => ({
      naturalWidth: img.naturalWidth || 0,
      naturalHeight: img.naturalHeight || 0,
    }));
    const allReady = currentMetas.every((m) => m.naturalWidth > 0);
    if (!allReady) {
      if (row.isConnected) window.requestAnimationFrame(() => applySizes());
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

    const validatedGrows = validateRowFlexGrows(finalGrows, currentMetas, containerWidth, interItemSpace);
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

    /** Diagnostics (temporary): the box height and drawn height the sizing
     *  model asked of each member, kept for the settle-time snapshot. */
    const modelBoxH: number[] = new Array<number>(n).fill(0);
    const modelDrawnH: number[] = new Array<number>(n).fill(0);

    // Below the narrow-screen breakpoint the media query wraps the row and the
    // stylesheet sizes it; any inline pixel height left here outranks that, so
    // the row is handed over wholesale.  The images then follow their item's
    // width with the height coming from their own aspect ratio, which is what a
    // wrapped row wants — a desktop pixel height would letterbox them.
    if (isNarrowViewport()) {
      row.style.removeProperty("height");
      for (const embed of embeds) {
        embed.style.removeProperty("height");
        for (const img of Array.from(embed.querySelectorAll<HTMLImageElement>("img"))) {
          setStyleImportant(img, "width", "100%");
          setStyleImportant(img, "height", "auto");
        }
      }
      return;
    }

    if (n > 1 && hasScale) {
      const orientations = readOrientations(embeds);
      const { heights, boxes } = computeScaleBasedHeights(
        finalGrows, currentMetas, scales, containerWidth, interItemSpace, options.defaultRowHeight, orientations
      );
      for (let i = 0; i < n; i++) {
        // The <img> holds the un-rotated bitmap and the embed takes what the
        // member actually paints.  The two are one rectangle upright and part
        // only on a quarter turn, where the drawing is folded back inside the
        // box: the cell then has to follow the drawing, or a balanced row leaves
        // the turned picture centred in a taller cell with a gap under the row.
        modelBoxH[i] = boxes[i];
        modelDrawnH[i] = heights[i];
        embeds[i].style.setProperty("flex", `${finalGrows[i]} 1 0%`, "important");
        embeds[i].style.setProperty("height", `${heights[i]}px`, "important");
        const embedImg = embeds[i].querySelector<HTMLImageElement>("img");
        if (embedImg) {
          stripObsidianClasses(embedImg);
          setImgBoxHeight(embedImg, boxes[i]);
          setStyleImportant(embedImg, "width", "auto");
          embedImg.addClass(CLASSES.imgAuto);
        }
      }
      const rowCellH = heights.length > 0 ? Math.max(...heights) : 0;
      row.style.height = `${rowCellH}px`;
      log.debug("RM applySizes scale-based heights", {
        rowCellH,
        heights,
        boxes,
      });
    } else {
      const rowHeightPx = computeRowHeight(
        finalGrows,
        currentMetas,
        containerWidth,
        interItemSpace,
        options.defaultRowHeight
      );
      // No member carries a fill: every box is the uniform height, and a quarter
      // turn repaints its box on its side, scaled down to fit back inside it.  The
      // cell follows that drawing, the rule the scale branch keeps, so a turned
      // member's column hugs its picture instead of holding a taller box around it.
      const uniforms = readOrientations(embeds);
      const drawnOf = (j: number): number => {
        const meta = currentMetas[j];
        const ar = meta.naturalWidth / meta.naturalHeight;
        return Math.round(rowHeightPx * drawnHeightCoefficient(meta, 1, uniforms[j]) * ar);
      };
      let rowCellH = 0;
      for (let j = 0; j < n; j++) {
        const drawn = drawnOf(j);
        modelBoxH[j] = rowHeightPx;
        modelDrawnH[j] = drawn;
        embeds[j].style.setProperty("flex", `${finalGrows[j]} 1 0%`, "important");
        embeds[j].style.setProperty("height", `${drawn}px`, "important");
        const embedImg = embeds[j].querySelector<HTMLImageElement>("img");
        if (embedImg) {
          stripObsidianClasses(embedImg);
          setImgBoxHeight(embedImg, rowHeightPx);
          setStyleImportant(embedImg, "width", "auto");
          embedImg.addClass(CLASSES.imgAuto);
        }
        if (drawn > rowCellH) rowCellH = drawn;
      }
      row.style.height = `${rowCellH > 0 ? rowCellH : rowHeightPx}px`;
    }

    applyEmbedOrientations(embeds);

    // ── Diagnostics: one snapshot per row, taken after everything settles ──
    {
      const key = `rm-row:${embeds.map((e) => getFileNameFromEmbed(e)).join("|")}`;
      const orientations = readOrientations(embeds);
      const modelBox = modelBoxH.slice();
      const modelDrawn = modelDrawnH.slice();
      const usedFill = n > 1 && hasScale;
      scheduleRmSnapshot(key, () => {
        const members: Array<Record<string, unknown>> = [];
        for (let i = 0; i < embeds.length; i++) {
          const img = embeds[i].querySelector<HTMLImageElement>("img");
          if (!img) continue;
          members.push(snapshotPayload(
            rmMemberFrames(embeds[i], img, {
              word: orientationWord(orientations[i] ?? IDENTITY_STATE),
              fill: usedFill ? (scales[i] ?? null) : null,
              share: finalGrows[i] ?? null,
              boxH: modelBox[i] ?? 0,
              drawn: modelDrawn[i] ?? 0,
              expectedScale: null,
            })
          ));
        }
        return {
          side: "RM",
          scope: "row",
          containerWidth,
          rowSetH: row.style.height,
          n,
          hasScale,
          members,
        };
      });
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
        log.debug("RM ROW render diagnostic", {
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
    window.requestAnimationFrame(() => {
      rowDiagnostic();
      window.requestAnimationFrame(() => rowDiagnostic());
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
        log.debug("RM ROW1_IMG0 render snapshot", {
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
      window.requestAnimationFrame(() => {
        trackImage0();
        window.requestAnimationFrame(() => trackImage0());
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

  // Crossing the breakpoint changes what the row's geometry should be — the
  // row width alone does not capture it (a pane can cross the breakpoint with
  // its own width unchanged), so the switch re-runs the sizing itself.
  const offNarrow = onNarrowViewportChange(() => {
    if (row.isConnected) applySizes();
  });

  const cleanupObserver = () => { sizeObserver.disconnect(); offNarrow(); };
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
    window.requestAnimationFrame(() => applySizes());
  }

  let remainingLoads = metas.filter((m) => m.naturalWidth === 0).length;
  if (remainingLoads > 0) {
    for (const img of imgs) {
      if (img.naturalWidth > 0) continue;
      const onLoad = () => {
        remainingLoads--;
        if (remainingLoads <= 0) {
          window.requestAnimationFrame(() => applySizes());
        }
      };
      if (img.complete) {
        onLoad();
      } else {
        img.addEventListener("load", onLoad, { once: true });
      }
    }
    if (remainingLoads === 0) {
      window.requestAnimationFrame(() => applySizes());
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

    window.setTimeout(() => {
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
    // The hover ring is drawn on this block, so its rect is what the user sees
    // as the drop surface; compare it against the embed it wraps.
    {
      const blockRect = block.getBoundingClientRect();
      const embedRect = embed.getBoundingClientRect();
      log.debug("RM makeDraggable host", {
        fileName: getFileNameFromEmbed(embed),
        blockTag: block.tagName,
        blockClass: block.className,
        blockW: round2(blockRect.width),
        blockH: round2(blockRect.height),
        embedW: round2(embedRect.width),
        embedH: round2(embedRect.height),
        offsetTop: round2(embedRect.top - blockRect.top),
        offsetLeft: round2(embedRect.left - blockRect.left),
        blockInlineH: block.style.height,
        embedInlineH: embed.style.height,
      });
    }

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

      const indicator = createDiv();
      indicator.className = "diaa-drop-indicator";
      if (e.clientX < midX) {
        indicator.setCssStyles({ left: "0" });
      } else {
        indicator.setCssStyles({ right: "0" });
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

      void handleImageDrop(
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
