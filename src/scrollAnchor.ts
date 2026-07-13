import { App } from "obsidian";
import { buildImageLineRe } from "./constants";
import { logger } from "./logger";
import {
  getPendingAlignmentCount,
  clearFlushTimer,
  setFlushTimer,
  getFlushTimer,
  flushPendingAlignments,
} from "./rmAlignStore";

// ── Scroll sync for cross-mode viewport alignment ─────────────────
//
// Two-strategy content-based anchor system (priority order):
//   A. text (preferred) – the first visible non-blank, non-image line
//      at the top of the viewport. Records the line's text + its pixel
//      offset from the viewport top, plus the nearest image rows before
//      and after (for disambiguation / degraded fallback). Restored by
//      locating the same text in the target mode and reproducing the
//      offset.
//   B. image-row (backup) – used when the viewport contains only image
//      rows. Records the global image-row index + intra-row ratio, which
//      are mode-independent (no blank-line collapse or image scaling to
//      worry about).

// ── Image row indexing ────────────────────────────────

type ImageRowIndex = {
  index: number;       // global sequential number, 1-based
  startLine: number;   // first source line of this image row (1-based)
  endLine: number;     // last source line of this image row (1-based)
};

const _imageRowIndexCache = new Map<string, ImageRowIndex[]>();

export function buildImageRowIndex(lines: string[], imgRe: RegExp): ImageRowIndex[] {
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

export function setImageRowIndex(filePath: string, index: ImageRowIndex[]): void {
  _imageRowIndexCache.set(filePath, index);
}

function getImageRowIndex(filePath: string): ImageRowIndex[] | undefined {
  return _imageRowIndexCache.get(filePath);
}

export function invalidateImageRowIndex(filePath: string): void {
  _imageRowIndexCache.delete(filePath);
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

type ViewportAnchor =
  | {
      kind: "text";
      anchorText: string;    // trimmed source/rendered text of the anchor line
      anchorOffset: number;  // pixel distance from viewport top to the line top
      nearestImgBefore: number; // image-row index just above (0 if none)
      nearestImgAfter: number;  // image-row index just below (0 if none)
    }
  | { kind: "image-row"; imageRowIndex: number; intraRowRatio: number };

let _scrollAnchor: ViewportAnchor | null = null;
// Per-mode last anchors. Kept separate so the scroll noise generated when
// the INCOMING view becomes visible (e.g. LP editor firing a scroll at its
// stale scrollTop) cannot overwrite the OUTGOING mode's anchor.
let _rmLastAnchor: ViewportAnchor | null = null;
let _rmLastAnchorFile = "";
let _lpLastAnchor: ViewportAnchor | null = null;
let _lpLastAnchorFile = "";

// Fallback scroll percentage for regions without any usable anchor.
let _fallbackPct = -1;
let _lastFallbackPct = -1;

// File whose RM has completed initial post-processor render.
let _rmRenderedFile = "";

// RAF id for pending deferred RM restore.
let _rmDeferredRestoreId: number | null = null;

// Exposed for readingMode.ts afterRender
export function setRMRenderedFile(path: string): void {
  _rmRenderedFile = path;
}

export function getRMDeferredRestoreId(): number | null {
  return _rmDeferredRestoreId;
}

export function cancelRMDeferredRestore(): void {
  if (_rmDeferredRestoreId !== null) {
    cancelAnimationFrame(_rmDeferredRestoreId);
    _rmDeferredRestoreId = null;
  }
}

export function getScrollAnchor(): ViewportAnchor | null {
  return _scrollAnchor;
}

export function getFallbackPct(): number {
  return _fallbackPct;
}

// Called from readingMode.ts afterRender (RM context) → RM slot.
export function setLastAnchor(anchor: ViewportAnchor | null, file: string): void {
  _rmLastAnchor = anchor;
  _rmLastAnchorFile = file;
}

export function setLastFallbackPct(pct: number): void {
  _lastFallbackPct = pct;
}

// ── Small helpers ──────────────────────────────────────

const IMG_LINE_RE = /!\[\[.*\.(?:png|jpg|jpeg|gif|webp|svg|bmp|avif)/i;

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** CodeMirror line block by 1-based line number (correct API usage:
 *  lineBlockAt expects a character position, not a line number). */
function lineBlockByNumber(cm: any, lineNo: number): any {
  const clamped = Math.max(1, Math.min(cm.state.doc.lines, lineNo));
  return cm.lineBlockAt(cm.state.doc.line(clamped).from);
}

/** Screen-space inset of CodeMirror block-coordinate 0 from the scroller's top
 *  edge, normalized to scrollTop=0. `blockInfo.top` is relative to `.cm-content`,
 *  which sits below Obsidian's inline title / properties inside `.cm-scroller`,
 *  so this inset must be added to convert block coords into true on-screen
 *  offsets that match RM's getBoundingClientRect-based measurements.
 *  Returns 0 when `documentTop` is unavailable (degrades to prior behavior). */
function lpInset(cm: any, sd: HTMLElement): number {
  const docTop = cm?.documentTop;
  if (typeof docTop !== "number") return 0;
  return docTop - sd.getBoundingClientRect().top + sd.scrollTop;
}

function nearestImgRowsByLine(
  imgIndex: ImageRowIndex[] | undefined,
  line: number,
): { before: number; after: number } {
  let before = 0, after = 0;
  if (imgIndex) {
    for (const r of imgIndex) {
      if (r.endLine < line) before = r.index;
      if (r.startLine > line && after === 0) after = r.index;
    }
  }
  return { before, after };
}

/** Candidate text-bearing block elements in RM, in document order. */
function rmTextBlocks(previewEl: HTMLElement): HTMLElement[] {
  const els = Array.from(
    previewEl.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th")
  ) as HTMLElement[];
  return els.filter(
    (e) => !e.closest(".internal-embed") && (e.textContent?.trim().length ?? 0) > 0
  );
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

// ── Scroll percentage (legacy fallback) ────────────────

export function computeScrollPct(app: App): number {
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

// ── Anchor capture ─────────────────────────────────────

export function captureContentAnchor(app: App): ViewportAnchor | null {
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

function captureAnchorLP(app: App, filePath: string): ViewportAnchor | null {
  const view = (app.workspace.activeLeaf?.view as any);
  const cm = view.editor?.cm;
  const sd = cm?.scrollDOM;
  if (!sd || sd.clientHeight === 0) return null;

  ensureImageRowIndexFromCM(app);
  const imgIndex = getImageRowIndex(filePath);
  const scrollTop = sd.scrollTop;
  const clientH = sd.clientHeight;
  const inset = lpInset(cm, sd);
  const totalLines = cm.state.doc.lines;

  // Work in true on-screen offsets from the viewport top: a line at block
  // coordinate `lb.top` sits at `lb.top - scrollTop + inset` pixels below the
  // viewport top edge (matching RM's getBoundingClientRect frame).

  // Strategy A: first visible non-blank, non-image line from viewport top.
  const topBlock = cm.lineBlockAtHeight(scrollTop - inset);
  const topLine = cm.state.doc.lineAt(topBlock.from).number;

  for (let i = topLine; i <= totalLines; i++) {
    const lineObj = cm.state.doc.line(i);
    const lb = cm.lineBlockAt(lineObj.from);
    const screenTop = lb.top - scrollTop + inset;
    if (screenTop >= clientH) break; // past the viewport bottom
    const text = lineObj.text.trim();
    if (!text) continue;                 // blank line
    if (IMG_LINE_RE.test(lineObj.text)) continue; // image line
    const { before, after } = nearestImgRowsByLine(imgIndex, i);
    return {
      kind: "text",
      anchorText: text.slice(0, 100),
      anchorOffset: screenTop,
      nearestImgBefore: before,
      nearestImgAfter: after,
    };
  }

  // Strategy B: viewport is entirely image rows → image-row ratio.
  if (imgIndex && imgIndex.length > 0) {
    const centerScreen = clientH / 2;
    const centerBlock = cm.lineBlockAtHeight(scrollTop + centerScreen - inset);
    const centerLine = cm.state.doc.lineAt(centerBlock.from).number;
    const imgRow = imgIndex.find(r => centerLine >= r.startLine && centerLine <= r.endLine);
    if (imgRow) {
      const startLb = lineBlockByNumber(cm, imgRow.startLine);
      const endLb = lineBlockByNumber(cm, imgRow.endLine);
      const rowTop = startLb.top - scrollTop + inset;
      const rowBottom = endLb.top + endLb.height - scrollTop + inset;
      const rowH = rowBottom - rowTop;
      const ratio = rowH > 0 ? clamp01((centerScreen - rowTop) / rowH) : 0.5;
      return { kind: "image-row", imageRowIndex: imgRow.index, intraRowRatio: ratio };
    }
  }

  return null;
}

// ── RM (preview) anchor capture ───────────────────────

function captureAnchorRM(app: App, filePath: string): ViewportAnchor | null {
  const previewEl = document.querySelector(".markdown-preview-view") as HTMLElement;
  if (!previewEl || previewEl.clientHeight === 0) return null;

  const previewRect = previewEl.getBoundingClientRect();
  const viewportTopClient = previewRect.top;
  const viewportBottomClient = previewRect.top + previewEl.clientHeight;
  const imgIndex = getImageRowIndex(filePath);

  // Strategy A: first visible text block that is not an image embed.
  const blocks = rmTextBlocks(previewEl);
  for (const block of blocks) {
    const rect = block.getBoundingClientRect();
    if (rect.bottom <= viewportTopClient) continue; // above viewport
    if (rect.top >= viewportBottomClient) break;    // below viewport
    const text = (block.textContent ?? "").trim();
    if (!text) continue;
    const blockTopDoc = rect.top - previewRect.top + previewEl.scrollTop;
    const { before, after } = nearestImgRowsRM(previewEl, imgIndex, previewRect, blockTopDoc);
    return {
      kind: "text",
      anchorText: text.slice(0, 100),
      anchorOffset: rect.top - viewportTopClient,
      nearestImgBefore: before,
      nearestImgAfter: after,
    };
  }

  // Strategy B: viewport is entirely image rows → image-row ratio.
  return captureImageRowRM(previewEl, previewRect, imgIndex);
}

function nearestImgRowsRM(
  previewEl: HTMLElement,
  imgIndex: ImageRowIndex[] | undefined,
  previewRect: DOMRect,
  blockTopDoc: number,
): { before: number; after: number } {
  let before = 0, after = 0;
  if (imgIndex) {
    for (const r of imgIndex) {
      const embed = previewEl.querySelector(
        `.internal-embed[data-diaa-line="${r.startLine}"]`
      ) as HTMLElement | null;
      if (!embed) continue;
      const eRect = embed.getBoundingClientRect();
      const eTop = eRect.top - previewRect.top + previewEl.scrollTop;
      if (eTop < blockTopDoc) before = r.index;
      else if (after === 0) after = r.index;
    }
  }
  return { before, after };
}

function captureImageRowRM(
  previewEl: HTMLElement,
  previewRect: DOMRect,
  imgIndex: ImageRowIndex[] | undefined,
): ViewportAnchor | null {
  if (!imgIndex || imgIndex.length === 0) return null;
  const viewportCenterY = previewEl.scrollTop + previewEl.clientHeight / 2;
  const embeds = previewEl.querySelectorAll(".internal-embed[data-diaa-line]");

  let bestLine = 0, bestDist = Infinity;
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
    }
  }
  if (bestLine <= 0) return null;

  const imgRow = imgIndex.find(r => bestLine >= r.startLine && bestLine <= r.endLine);
  if (!imgRow) return null;

  const rowEmbeds = previewEl.querySelectorAll(imgIndexToSelector(imgRow));
  if (rowEmbeds.length === 0) return null;

  let rowTop = Infinity, rowBottom = -Infinity;
  for (const re of rowEmbeds) {
    const r = re.getBoundingClientRect();
    const t = r.top - previewRect.top + previewEl.scrollTop;
    const b = t + r.height;
    if (t < rowTop) rowTop = t;
    if (b > rowBottom) rowBottom = b;
  }
  const rowH = rowBottom - rowTop;
  const ratio = rowH > 0 ? clamp01((viewportCenterY - rowTop) / rowH) : 0.5;
  return { kind: "image-row", imageRowIndex: imgRow.index, intraRowRatio: ratio };
}

// ── Anchor restore ─────────────────────────────────────

export function restoreContentAnchor(app: App): void {
  if (!_scrollAnchor) return;
  const anchor = _scrollAnchor;
  _scrollAnchor = null;

  const leaf = app.workspace.activeLeaf;
  const view = (leaf?.view as any);
  const mode = view?.getMode?.() ?? "";
  const filePath = view?.file?.path ?? "";

  if (anchor.kind === "image-row") {
    if (mode === "source") restoreImageRowInLP(app, filePath, anchor.imageRowIndex, anchor.intraRowRatio);
    else if (mode === "preview") restoreImageRowInRM(app, filePath, anchor.imageRowIndex, anchor.intraRowRatio);
  } else {
    if (mode === "source") restoreTextInLP(app, filePath, anchor);
    else if (mode === "preview") restoreTextInRM(app, filePath, anchor);
  }
}

// ── image-row restore (Strategy B) ─────────────────────

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

  const startLb = lineBlockByNumber(cm, imgRow.startLine);
  const endLb = lineBlockByNumber(cm, imgRow.endLine);
  const inset = lpInset(cm, sd);
  const rowTop = startLb.top;
  const rowBottom = endLb.top + endLb.height;
  const targetY = Math.max(0, rowTop + inset + (rowBottom - rowTop) * intraRowRatio - sd.clientHeight / 2);
  sd.scrollTop = targetY;

  logger.info("VIEWPORT anchor-restored", {
    mode: "source", kind: "image-row", imageRowIndex,
    ratio: Math.round(intraRowRatio * 100),
    rowTop: Math.round(rowTop), rowH: Math.round(rowBottom - rowTop), inset: Math.round(inset),
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

// ── text restore (Strategy A) ──────────────────────────

function findBestTextLine(
  cm: any, docText: string,
  anchor: Extract<ViewportAnchor, { kind: "text" }>,
  filePath: string,
): number {
  const frag = anchor.anchorText;
  if (!frag) return 0;

  const positions: number[] = [];
  let pos = 0;
  while ((pos = docText.indexOf(frag, pos)) >= 0) {
    positions.push(pos);
    pos += frag.length;
    if (positions.length > 50) break;
  }
  if (positions.length === 0) return 0;
  if (positions.length === 1) return cm.state.doc.lineAt(positions[0]).number;

  // Multiple matches: disambiguate using the nearest image row.
  const imgIndex = getImageRowIndex(filePath);
  let expectedLine = -1;
  if (anchor.nearestImgBefore > 0) {
    const r = imgIndex?.find(x => x.index === anchor.nearestImgBefore);
    if (r) expectedLine = r.endLine + 1;
  } else if (anchor.nearestImgAfter > 0) {
    const r = imgIndex?.find(x => x.index === anchor.nearestImgAfter);
    if (r) expectedLine = r.startLine - 1;
  }
  if (expectedLine < 0) return cm.state.doc.lineAt(positions[0]).number;

  let bestPos = positions[0], bestDist = Infinity;
  for (const p of positions) {
    const ln = cm.state.doc.lineAt(p).number;
    const d = Math.abs(ln - expectedLine);
    if (d < bestDist) { bestDist = d; bestPos = p; }
  }
  return cm.state.doc.lineAt(bestPos).number;
}

function restoreTextInLP(
  app: App, filePath: string,
  anchor: Extract<ViewportAnchor, { kind: "text" }>,
): void {
  const view = (app.workspace.activeLeaf?.view as any);
  const cm = view.editor?.cm;
  const sd = cm?.scrollDOM;
  if (!sd || sd.clientHeight === 0) return;

  const docText = cm.state.doc.toString();
  const line = findBestTextLine(cm, docText, anchor, filePath);
  if (line > 0) {
    const lb = lineBlockByNumber(cm, line);
    const inset = lpInset(cm, sd);
    const targetY = Math.max(0, lb.top + inset - anchor.anchorOffset);
    sd.scrollTop = targetY;
    // Cross-check: coordsAtPos gives the true on-screen top after scrolling.
    let coordsOffset = -1;
    try {
      const c = cm.coordsAtPos(cm.state.doc.line(line).from);
      if (c) coordsOffset = Math.round(c.top - sd.getBoundingClientRect().top);
    } catch { /* pos may be off-screen */ }
    logger.info("VIEWPORT anchor-restored", {
      mode: "source", kind: "text", line,
      frag: anchor.anchorText.slice(0, 30),
      capturedOffset: Math.round(anchor.anchorOffset),
      lineTop: Math.round(lb.top), inset: Math.round(inset),
      documentTop: Math.round(cm.documentTop ?? 0),
      sdTop: Math.round(sd.getBoundingClientRect().top),
      targetY: Math.round(targetY), actualY: Math.round(sd.scrollTop),
      actualOffset: Math.round(lb.top - sd.scrollTop + inset),
      coordsOffset,
    });
    return;
  }

  // Degrade: position relative to the nearest image row.
  const imgIndex = getImageRowIndex(filePath);
  const refIdx = anchor.nearestImgBefore > 0 ? anchor.nearestImgBefore : anchor.nearestImgAfter;
  if (refIdx > 0 && imgIndex) {
    const r = imgIndex.find(x => x.index === refIdx);
    if (r) {
      const refLine = anchor.nearestImgBefore > 0 ? r.endLine + 1 : r.startLine - 1;
      const lb = lineBlockByNumber(cm, refLine);
      const targetY = Math.max(0, lb.top + lpInset(cm, sd) - anchor.anchorOffset);
      sd.scrollTop = targetY;
      logger.info("VIEWPORT anchor-restored", {
        mode: "source", kind: "text-degraded", refLine,
        targetY: Math.round(targetY), actualY: Math.round(sd.scrollTop),
      });
      return;
    }
  }
  logger.info("VIEWPORT text unresolvable in LP", { frag: anchor.anchorText.slice(0, 30) });
}

function restoreTextInRM(
  app: App, filePath: string,
  anchor: Extract<ViewportAnchor, { kind: "text" }>,
): void {
  const previewEl = document.querySelector(".markdown-preview-view") as HTMLElement;
  if (!previewEl || previewEl.clientHeight === 0) return;

  const previewRect = previewEl.getBoundingClientRect();
  const frag = anchor.anchorText;
  const blocks = rmTextBlocks(previewEl);
  const matches = frag
    ? blocks.filter(b => (b.textContent ?? "").includes(frag))
    : [];

  let chosen: HTMLElement | null = null;
  if (matches.length === 1) {
    chosen = matches[0];
  } else if (matches.length > 1) {
    // Disambiguate by proximity to the nearest image row.
    const imgIndex = getImageRowIndex(filePath);
    const refIdx = anchor.nearestImgBefore > 0 ? anchor.nearestImgBefore : anchor.nearestImgAfter;
    let expectedDocY = -1;
    if (refIdx > 0 && imgIndex) {
      const r = imgIndex.find(x => x.index === refIdx);
      if (r) {
        const embed = previewEl.querySelector(
          `.internal-embed[data-diaa-line="${r.startLine}"]`
        ) as HTMLElement | null;
        if (embed) {
          const eRect = embed.getBoundingClientRect();
          expectedDocY = eRect.top - previewRect.top + previewEl.scrollTop;
        }
      }
    }
    if (expectedDocY >= 0) {
      let best = matches[0], bestDist = Infinity;
      for (const m of matches) {
        const mRect = m.getBoundingClientRect();
        const mTop = mRect.top - previewRect.top + previewEl.scrollTop;
        const d = Math.abs(mTop - expectedDocY);
        if (d < bestDist) { bestDist = d; best = m; }
      }
      chosen = best;
    } else {
      chosen = matches[0];
    }
  }

  if (chosen) {
    const rect = chosen.getBoundingClientRect();
    const blockTop = rect.top - previewRect.top + previewEl.scrollTop;
    const targetY = Math.max(0, blockTop - anchor.anchorOffset);
    previewEl.scrollTop = targetY;
    logger.info("VIEWPORT anchor-restored", {
      mode: "preview", kind: "text",
      frag: frag.slice(0, 30),
      offset: Math.round(anchor.anchorOffset),
      targetY: Math.round(targetY), actualY: Math.round(previewEl.scrollTop),
    });
    return;
  }

  // Degrade: position relative to the nearest image row embed.
  const imgIndex = getImageRowIndex(filePath);
  const refIdx = anchor.nearestImgBefore > 0 ? anchor.nearestImgBefore : anchor.nearestImgAfter;
  if (refIdx > 0 && imgIndex) {
    const r = imgIndex.find(x => x.index === refIdx);
    if (r) {
      const line = anchor.nearestImgBefore > 0 ? r.endLine : r.startLine;
      const embed = previewEl.querySelector(
        `.internal-embed[data-diaa-line="${line}"]`
      ) as HTMLElement | null;
      if (embed) {
        const eRect = embed.getBoundingClientRect();
        const eTop = eRect.top - previewRect.top + previewEl.scrollTop;
        const targetY = anchor.nearestImgBefore > 0
          ? Math.max(0, eTop + eRect.height - anchor.anchorOffset)
          : Math.max(0, eTop - previewEl.clientHeight + anchor.anchorOffset);
        previewEl.scrollTop = targetY;
        logger.info("VIEWPORT anchor-restored", {
          mode: "preview", kind: "text-degraded", refLine: line,
          targetY: Math.round(targetY), actualY: Math.round(previewEl.scrollTop),
        });
        return;
      }
    }
  }
  logger.info("VIEWPORT text unresolvable in RM", { frag: frag.slice(0, 30) });
}

// Legacy percentage-based restore kept as final fallback.
export function restoreScrollPct(app: App): void {
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

let _rmTrackedEl: HTMLElement | null = null;
let _rmScrollCleanup: (() => void) | null = null;

// Throttled diagnostic: records the anchor's distance-to-viewport-top as
// the user scrolls, and (for RM) which container is actually scrolling.
let _lastScrollLogTs = 0;
function logScrollCapture(side: "RM" | "LP", el: HTMLElement, anchor: ViewportAnchor | null): void {
  const now = Date.now();
  if (now - _lastScrollLogTs < 150) return;
  _lastScrollLogTs = now;
  const info: Record<string, any> = { scrollTop: Math.round(el.scrollTop), kind: anchor?.kind ?? "none" };
  if (anchor?.kind === "text") {
    info.frag = anchor.anchorText.slice(0, 16);
    info.offset = Math.round(anchor.anchorOffset);
  } else if (anchor?.kind === "image-row") {
    info.imageRowIndex = anchor.imageRowIndex;
    info.ratio = Math.round(anchor.intraRowRatio * 100);
  }
  if (side === "RM") {
    const cands = [".markdown-reading-view", ".markdown-preview-view", ".markdown-preview-sizer", ".markdown-preview-section"];
    info.scrollTops = cands
      .map(s => { const e = document.querySelector(s) as HTMLElement | null; return e ? `${s}=${Math.round(e.scrollTop)}` : `${s}=n/a`; })
      .join(" ");
  }
  logger.debug(`SCROLL ${side}`, info);
}

export function ensureRMScrollTracking(_app: App): void {
  const previewEl = document.querySelector(".markdown-preview-view") as HTMLElement | null;
  if (!previewEl || previewEl.clientHeight === 0) return;
  if (_rmTrackedEl === previewEl) return;

  if (_rmScrollCleanup) {
    _rmScrollCleanup();
    _rmScrollCleanup = null;
  }
  _rmTrackedEl = null;

  const onScroll = () => {
    const anchor = captureContentAnchor(_app);
    if (anchor) {
      _rmLastAnchor = anchor;
      _rmLastAnchorFile = (_app.workspace.activeLeaf?.view as any)?.file?.path ?? "";
    }
    const pct = computeScrollPct(_app);
    if (pct >= 0) _lastFallbackPct = pct;
    logScrollCapture("RM", previewEl, anchor);
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

function scheduleRMDeferredRestore(app: App): void {
  if (_rmDeferredRestoreId !== null) {
    cancelAnimationFrame(_rmDeferredRestoreId);
    _rmDeferredRestoreId = null;
  }

  const attempt = () => {
    const mode = (app.workspace.activeLeaf?.view as any)?.getMode?.() ?? "";
    if (mode !== "preview") return;

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
      _rmLastAnchor = anchor;
      _rmLastAnchorFile = (app.workspace.activeLeaf?.view as any)?.file?.path ?? "";
    }
    const pct = computeScrollPct(app);
    if (pct >= 0) _lastFallbackPct = pct;
    logViewportState(app, "rm-after-restore");
  };
  _rmDeferredRestoreId = requestAnimationFrame(attempt);
}

// ── LP scroll tracking ─────────────────────────────────────────────

let _lpTrackedEl: HTMLElement | null = null;
let _lpScrollCleanup: (() => void) | null = null;

function ensureLPScrollTracking(app: App): void {
  const cm = (app.workspace.activeLeaf?.view as any)?.editor?.cm;
  const sd = cm?.scrollDOM as HTMLElement | null;
  if (!sd) return;
  if (_lpTrackedEl === sd) return;

  if (_lpScrollCleanup) {
    _lpScrollCleanup();
    _lpScrollCleanup = null;
  }
  _lpTrackedEl = null;

  const onScroll = () => {
    const anchor = captureContentAnchor(app);
    if (anchor) {
      _lpLastAnchor = anchor;
      _lpLastAnchorFile = (app.workspace.activeLeaf?.view as any)?.file?.path ?? "";
    }
    const pct = computeScrollPct(app);
    if (pct >= 0) _lastFallbackPct = pct;
    logScrollCapture("LP", sd, anchor);
  };

  sd.addEventListener("scroll", onScroll, { passive: true });
  _lpScrollCleanup = () => {
    sd.removeEventListener("scroll", onScroll);
    _lpScrollCleanup = null;
    _lpTrackedEl = null;
  };
  _lpTrackedEl = sd;
}

// ── LP deferred restore ─────────────────────────────────────────────

let _lpDeferredRestoreId: number | null = null;

function scheduleLPDeferredRestore(app: App): void {
  if (_lpDeferredRestoreId !== null) {
    cancelAnimationFrame(_lpDeferredRestoreId);
    _lpDeferredRestoreId = null;
  }

  const attempt = () => {
    const view = (app.workspace.activeLeaf?.view as any);
    const mode = view?.getMode?.() ?? "";
    if (mode !== "source") { _lpDeferredRestoreId = null; return; }

    const sd = view.editor?.cm?.scrollDOM as HTMLElement | null;
    if (!sd || sd.clientHeight === 0) {
      _lpDeferredRestoreId = requestAnimationFrame(attempt);
      return;
    }
    _lpDeferredRestoreId = null;

    ensureLPScrollTracking(app);
    if (_scrollAnchor) {
      restoreContentAnchor(app);
    } else if (_fallbackPct >= 0) {
      restoreScrollPct(app);
    }

    const anchor = captureContentAnchor(app);
    if (anchor) {
      _lpLastAnchor = anchor;
      _lpLastAnchorFile = view?.file?.path ?? "";
    }
    const pct = computeScrollPct(app);
    if (pct >= 0) _lastFallbackPct = pct;
    logViewportState(app, "lp-after-restore");
  };
  _lpDeferredRestoreId = requestAnimationFrame(attempt);
}

// ── View mode change driver ─────────────────────────────────────────

/** Drive cross-mode scroll restore on view mode switches (RM ↔ LP).
 *  Called from main.ts on layout-change. logViewportState performs the
 *  edge-triggered mode-switch detection (RM→LP flush + anchor seed); we then
 *  schedule a deferred restore for whichever mode we switched INTO. The RM
 *  reading view is often cached, so its post-processor afterRender may not
 *  re-run — scheduleRMDeferredRestore guarantees the restore fires anyway. */
export function onViewModeChange(app: App): void {
  const wasNotLP = _lastMode !== "source";
  const wasNotRM = _lastMode !== "preview";
  logViewportState(app, "layout-change");
  const mode = (app.workspace.activeLeaf?.view as any)?.getMode?.() ?? "";
  if (mode === "source") {
    ensureLPScrollTracking(app);
    if (wasNotLP) scheduleLPDeferredRestore(app);
  } else if (mode === "preview") {
    if (wasNotRM) scheduleRMDeferredRestore(app);
  }
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

export function logViewportState(app: App, trigger: string): void {
  const leaf = app.workspace.activeLeaf;
  const view = (leaf?.view as any);
  const mode = view?.getMode?.() ?? "none";
  const file = view?.file?.path ?? "";

  const modeChanged = _lastMode && _lastMode !== mode;
  if (modeChanged) {
    const newDocH = computeDocH(app, mode);
    logger.info("VIEWPORT mode-switch", {
      from: _lastMode, to: mode, trigger, file,
      oldDocH: _lastDocH, newDocH,
      docHRatio: _lastDocH > 0 && newDocH > 0 ? Math.round(newDocH / _lastDocH * 100) : 0,
    });
    // Flush buffered RM alignment changes on RM→LP switch so the LP
    // editor picks up the updated markdown before scroll is restored.
    if (_lastMode === "preview" && mode === "source") {
      const pendingCount = getPendingAlignmentCount();
      logger.info("ALIGN flush trigger: RM→LP switch", { pendingCount });
      const modified = flushPendingAlignments(app);
      logger.info("ALIGN flush done", { modifiedFiles: [...modified], remaining: getPendingAlignmentCount() });
      for (const path of modified) invalidateImageRowIndex(path);
    }
    // Seed the restore anchor from the OUTGOING mode's slot, so the
    // incoming view's stale-scroll noise can't hijack it.
    const srcAnchor = _lastMode === "preview" ? _rmLastAnchor : _lpLastAnchor;
    const srcFile = _lastMode === "preview" ? _rmLastAnchorFile : _lpLastAnchorFile;
    if (srcFile === file && srcAnchor) {
      _scrollAnchor = srcAnchor;
      logger.info("VIEWPORT anchor-captured", {
        fromMode: _lastMode,
        kind: srcAnchor.kind,
        ...(srcAnchor.kind === "image-row" ? {
          imageRowIndex: srcAnchor.imageRowIndex,
          ratio: Math.round(srcAnchor.intraRowRatio * 100),
        } : {
          frag: srcAnchor.anchorText.slice(0, 30),
          offset: Math.round(srcAnchor.anchorOffset),
          nearestBefore: srcAnchor.nearestImgBefore,
          nearestAfter: srcAnchor.nearestImgAfter,
        }),
      });
    } else if (srcFile === file && _lastFallbackPct >= 0) {
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
      const visImages: string[] = [];
      for (let i = 1; i <= totalLines; i++) {
        const line = cm.state.doc.line(i);
        if (IMG_LINE_RE.test(line.text)) {
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
    pending: getPendingAlignmentCount(),
    ...extra,
  });

  _lastDocH = docH;
}

// ── Main exports ───────────────────────────────────────────────

/** Flush buffered RM alignment changes to markdown.
 *  Called from main.ts on layout-change and from logViewportState on
 *  RM→LP mode switch.  Only fires when there are pending alignments. */
export function schedulePendingFlush(app: App): void {
  if (getPendingAlignmentCount() === 0) return;
  if (getFlushTimer()) clearFlushTimer();
  setFlushTimer(setTimeout(() => {
    setFlushTimer(0 as any);
    logger.info("VIEWPORT flush-start", { pendingCount: getPendingAlignmentCount() });
    const modified = flushPendingAlignments(app);
    for (const path of modified) invalidateImageRowIndex(path);
  }, 0));
}
