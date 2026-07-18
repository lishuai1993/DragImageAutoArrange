import { App, MarkdownView } from "obsidian";
import { logger } from "../logger";
import {
  getPendingAlignmentCount,
  clearFlushTimer,
  setFlushTimer,
  getFlushTimer,
  flushPendingAlignments,
} from "../rmAlignStore";
import {
  classifyCenter, ImageRowIndex, Line1, asLine1, buildImageRowIndex,
} from "./viewportAnchor";
import {
  clamp01, intraRowRatio, gapRatioFromGeom,
  imageRowTargetY, gapJunction, gapTargetY, textTargetY,
  nearestIndexBy, ledgerYForLine, ledgerTotalHeight, sectionIndexEstimateY, LedgerSection,
} from "./anchorMath";
import { assertNever } from "../utils";
import { normalizeAnchorText } from "./textAnchor";
import {
  ViewportAnchor,
  setImageRowIndex, getImageRowIndex, invalidateImageRowIndex,
  getActiveAnchor, setActiveAnchor,
  getFallbackPct, setFallbackPct, getLastFallbackPct, setLastFallbackPct,
  setRMLastAnchor, getRMLastAnchor, setLPLastAnchor, getLPLastAnchor,
  getLastMode, setLastMode, getLastDocH, setLastDocH,
  getImageLineRe,
} from "./anchorStore";

// Re-export the store accessors that form scrollAnchor's public API, so the
// import sites in main.ts / readingMode.ts stay unchanged after the state moved
// into anchorStore.ts.
export {
  setImageRowIndex, invalidateImageRowIndex, setImageLineRe,
  setLastFallbackPct, setRMRenderedFile, getFallbackPct,
} from "./anchorStore";

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
// ImageRowIndex type + buildImageRowIndex live in viewportAnchor.ts (pure
// module); the per-file cache + accessors live in anchorStore.ts.

/** Build index from CodeMirror doc lines (sync, used in LP scroll handlers). */
function ensureImageRowIndexFromCM(app: App): void {
  const view = (app.workspace.activeLeaf?.view as any);
  const filePath = view?.file?.path ?? "";
  if (!filePath || getImageRowIndex(filePath) !== undefined) return;

  const cm = view.editor?.cm;
  if (!cm) return;

  const lines: string[] = [];
  for (let i = 1; i <= cm.state.doc.lines; i++) {
    lines.push(cm.state.doc.line(i).text);
  }
  setImageRowIndex(filePath, buildImageRowIndex(lines, getImageLineRe()));
}

// ── Anchor types ──────────────────────────────────────
// ViewportAnchor type + the anchor/fallback/mode sync state live in
// anchorStore.ts. Only the RM scroll-tracking machinery (RAF id below,
// tracked elements + cleanups further down) stays local to this module.

// RAF id for pending deferred RM restore.
let _rmDeferredRestoreId: number | null = null;

// The RM deferred-restore loop's scroll-capture guard, module-scoped (not a
// closure flag) so that cancelRMDeferredRestore — called externally from
// readingMode.afterRender — can release it. A closure flag leaks the guard on
// cancel (and on session replacement), muting scroll capture until the 2s
// safety timeout fires.
let _rmLoopGuardActive = false;
function rmLoopEnterGuard(): void {
  if (!_rmLoopGuardActive) { enterRestoreGuard(); _rmLoopGuardActive = true; }
}
function rmLoopExitGuard(): void {
  if (_rmLoopGuardActive) { exitRestoreGuard(); _rmLoopGuardActive = false; }
}

export function getRMDeferredRestoreId(): number | null {
  return _rmDeferredRestoreId;
}

export function cancelRMDeferredRestore(): void {
  if (_rmDeferredRestoreId !== null) {
    cancelAnimationFrame(_rmDeferredRestoreId);
    _rmDeferredRestoreId = null;
  }
  rmLoopExitGuard();
}

export function getScrollAnchor(): ViewportAnchor | null {
  return getActiveAnchor();
}

// Called from readingMode.ts afterRender (RM context) → RM slot.
// When the afterRender fires while the active view is still in source mode
// (e.g. during warmup), the captured anchor actually describes the LP view.
// Seed the LP slot too so scheduleEarlyRestore can use it for the first real
// LP→RM switch. The guard (LP slot empty) prevents overwriting a real LP
// anchor set by a prior RM→LP switch.
export function setLastAnchor(anchor: ViewportAnchor | null, file: string): void {
  setRMLastAnchor(anchor, file);
  if (anchor && file && !getLPLastAnchor().anchor) {
    setLPLastAnchor(anchor, file);
  }
}

// ── Small helpers ──────────────────────────────────────

/** Clamp a raw ratio into [0,1], warning when the measured geometry produced
 *  an out-of-range value (a signal the layout drifted from expectations). */
function clampRatioWarn(raw: number, where: string): number {
  const c = clamp01(raw);
  if (raw !== c) {
    logger.warn("VIEWPORT ratio out of range", { where, raw: Math.round(raw * 1000) / 1000 });
  }
  return c;
}

/** CodeMirror line block by 1-based line number (correct API usage:
 *  lineBlockAt expects a character position, not a line number). */
function lineBlockByNumber(cm: any, lineNo: Line1): any {
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
    previewEl.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, .callout-title")
  ) as HTMLElement[];
  return els.filter(
    (e) => !e.closest(".internal-embed") && (e.textContent?.trim().length ?? 0) > 0
  );
}

/** Build a CSS selector matching all embeds whose data-diaa-line falls
 *  within an image row's source line range. */
function imgIndexToSelector(imgRow: ImageRowIndex): string {
  const parts: string[] = [];
  for (let ln: number = imgRow.startLine; ln <= imgRow.endLine; ln++) {
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
    const previewEl = getRMPreviewEl(app) as HTMLElement;
    if (!previewEl || previewEl.clientHeight === 0) return -1;
    const maxScroll = previewEl.scrollHeight - previewEl.clientHeight;
    return maxScroll > 0 ? previewEl.scrollTop / maxScroll : 0;
  }

  return -1;
}

/** The active view's reading-mode scroll container. RM-side capture/restore must
 *  query WITHIN the active MarkdownView — a global `document.querySelector`
 *  can hit a hidden/zero-height `.markdown-preview-view` from another leaf or a
 *  mid-switch stub, which silently makes all RM geometry read 0 and degrades
 *  cross-mode sync to LP-only. Scoping to the active view's contentEl fixes it. */
function getRMPreviewEl(app: App): HTMLElement | null {
  const view = app.workspace.activeLeaf?.view as any;
  const container = (view?.contentEl ?? view?.containerEl) as HTMLElement | undefined;
  return (container?.querySelector(".markdown-preview-view") as HTMLElement | null) ?? null;
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

// Minimum normalized anchor-text length. Shorter frags (e.g. the 2-char table
// cell "页面") match hundreds of lines across a long document and defeat every
// disambiguation prior — skip them and anchor on the next richer line instead.
const MIN_ANCHOR_TEXT_LEN = 4;

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
    if (!lineObj.text.trim()) continue;                 // blank line
    if (getImageLineRe().test(lineObj.text)) continue; // image line
    // Table row: LP would capture the whole "| a | b |" source line, but RM's
    // text blocks are individual td/th CELLS — a row-level frag is never a
    // substring of a cell's text, so such anchors are unresolvable in RM
    // (observed as the 2.5s bounce-to-head). Anchor on the next non-table line.
    if (/^\s*\|/.test(lineObj.text)) continue;
    const text = normalizeAnchorText(lineObj.text);
    if (text.length < MIN_ANCHOR_TEXT_LEN) continue;
    const { before, after } = nearestImgRowsByLine(imgIndex, i);
    return {
      kind: "text",
      anchorText: text.slice(0, 100),
      anchorOffset: screenTop,
      anchorLine: i,
      nearestImgBefore: before,
      nearestImgAfter: after,
      docRatio: sd.scrollHeight > 0 ? lb.top / sd.scrollHeight : -1,
      totalLines: cm.state.doc.lines,
    };
  }

  // Strategy B: viewport has no visible text → image-row or image-gap anchor.
  if (imgIndex && imgIndex.length > 0) {
    const centerScreen = clientH / 2;
    const centerBlock = cm.lineBlockAtHeight(scrollTop + centerScreen - inset);
    const centerLine = asLine1(cm.state.doc.lineAt(centerBlock.from).number);
    const isBlank = (n: number) => cm.state.doc.line(n).text.trim() === "";
    const isImage = (n: number) => getImageLineRe().test(cm.state.doc.line(n).text);
    const cls = classifyCenter(totalLines, isBlank, isImage, imgIndex, centerLine);

    if (cls.kind === "image-row") {
      const imgRow = imgIndex.find(r => r.index === cls.imageRowIndex)!;
      const startLb = lineBlockByNumber(cm, imgRow.startLine);
      const endLb = lineBlockByNumber(cm, imgRow.endLine);
      const rowTop = startLb.top - scrollTop + inset;
      const rowBottom = endLb.top + endLb.height - scrollTop + inset;
      const ratio = clampRatioWarn(intraRowRatio(centerScreen, rowTop, rowBottom - rowTop), "LP image-row");
      return { kind: "image-row", imageRowIndex: imgRow.index, intraRowRatio: ratio };
    }

    if (cls.kind === "image-gap") {
      const upRow = cls.imgBefore > 0 ? imgIndex.find(r => r.index === cls.imgBefore) : undefined;
      const downRow = cls.imgAfter > 0 ? imgIndex.find(r => r.index === cls.imgAfter) : undefined;
      let gapRatio = 0.5;
      if (upRow && downRow) {
        const upLb = lineBlockByNumber(cm, upRow.endLine);
        const downLb = lineBlockByNumber(cm, downRow.startLine);
        const upBottomScreen = upLb.top + upLb.height - scrollTop + inset;
        const downTopScreen = downLb.top - scrollTop + inset;
        gapRatio = clampRatioWarn(gapRatioFromGeom(centerScreen, upBottomScreen, downTopScreen), "LP image-gap");
      }
      return { kind: "image-gap", imgBefore: cls.imgBefore, imgAfter: cls.imgAfter, gapRatio };
    }
  }

  return null;
}

// ── RM (preview) anchor capture ───────────────────────

function captureAnchorRM(app: App, filePath: string): ViewportAnchor | null {
  const previewEl = getRMPreviewEl(app) as HTMLElement;
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
    // Table cells make terrible anchors: rmTextBlocks yields individual
    // td/th blocks whose text ("页面") is short and repeats all over the
    // document — the LP capture side skips table rows for the same reason.
    if (block.closest("table")) continue;
    const text = normalizeAnchorText(block.textContent ?? "");
    if (text.length < MIN_ANCHOR_TEXT_LEN) continue;
    const blockTopDoc = rect.top - previewRect.top + previewEl.scrollTop;
    const { before, after } = nearestImgRowsRM(previewEl, imgIndex, previewRect, blockTopDoc);
    return {
      kind: "text",
      anchorText: text.slice(0, 100),
      anchorOffset: rect.top - viewportTopClient,
      nearestImgBefore: before,
      nearestImgAfter: after,
      docRatio: previewEl.scrollHeight > 0 ? blockTopDoc / previewEl.scrollHeight : -1,
      totalLines: -1, // unavailable from RM; native-scroll uses other means
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

function rmRowBounds(
  previewEl: HTMLElement, previewRect: DOMRect, row: ImageRowIndex,
): { top: number; bottom: number } | null {
  const rowEmbeds = previewEl.querySelectorAll(imgIndexToSelector(row));
  if (rowEmbeds.length === 0) return null;
  let top = Infinity, bottom = -Infinity;
  for (const re of rowEmbeds) {
    const r = re.getBoundingClientRect();
    const t = r.top - previewRect.top + previewEl.scrollTop;
    const b = t + r.height;
    if (t < top) top = t;
    if (b > bottom) bottom = b;
  }
  return { top, bottom };
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
    const line = asLine1(parseInt(lineStr, 10));
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
  if (!imgRow) {
    // A rendered data-diaa-line embed that maps to NO image row means the
    // attribute base (set in readingMode.ts) drifted out of sync with
    // ImageRowIndex's 1-based startLine/endLine — the exact off-by-one that
    // silently froze RM anchoring before. Surface it instead of failing quietly.
    logger.warn("VIEWPORT RM data-diaa-line unmapped (line-base mismatch?)", {
      bestLine,
      imgRows: imgIndex.map(r => `${r.index}:${r.startLine}-${r.endLine}`),
    });
    return null;
  }

  const bounds = rmRowBounds(previewEl, previewRect, imgRow);
  if (!bounds) return null;
  const { top: rowTop, bottom: rowBottom } = bounds;

  // Center inside the nearest row → image-row anchor.
  if (viewportCenterY >= rowTop && viewportCenterY <= rowBottom) {
    const ratio = clampRatioWarn(intraRowRatio(viewportCenterY, rowTop, rowBottom - rowTop), "RM image-row");
    return { kind: "image-row", imageRowIndex: imgRow.index, intraRowRatio: ratio };
  }

  // Center outside the row → gap between two image rows (blanks collapse in RM,
  // leaving only block margins). Bracket by the adjacent image-row index.
  if (viewportCenterY < rowTop) {
    const upRow = imgIndex.find(r => r.index === imgRow.index - 1);
    const upBounds = upRow ? rmRowBounds(previewEl, previewRect, upRow) : null;
    const gapRatio = upBounds
      ? clampRatioWarn(gapRatioFromGeom(viewportCenterY, upBounds.bottom, rowTop), "RM gap-up")
      : 0.5;
    return { kind: "image-gap", imgBefore: upRow ? upRow.index : 0, imgAfter: imgRow.index, gapRatio };
  } else {
    const downRow = imgIndex.find(r => r.index === imgRow.index + 1);
    const downBounds = downRow ? rmRowBounds(previewEl, previewRect, downRow) : null;
    const gapRatio = downBounds
      ? clampRatioWarn(gapRatioFromGeom(viewportCenterY, rowBottom, downBounds.top), "RM gap-down")
      : 0.5;
    return { kind: "image-gap", imgBefore: imgRow.index, imgAfter: downRow ? downRow.index : 0, gapRatio };
  }
}

// ── Anchor restore ─────────────────────────────────────

export function restoreContentAnchor(app: App): boolean {
  const active = getActiveAnchor();
  if (!active) return false;
  const anchor = active;

  const leaf = app.workspace.activeLeaf;
  const view = (leaf?.view as any);
  const mode = view?.getMode?.() ?? "";
  const filePath = view?.file?.path ?? "";

  let ok = false;
  switch (anchor.kind) {
    case "image-row":
      if (mode === "source") ok = restoreImageRowInLP(app, filePath, anchor.imageRowIndex, anchor.intraRowRatio);
      else if (mode === "preview") ok = restoreImageRowInRM(app, filePath, anchor.imageRowIndex, anchor.intraRowRatio);
      break;
    case "image-gap":
      if (mode === "source") ok = restoreImageGapInLP(app, filePath, anchor.imgBefore, anchor.imgAfter, anchor.gapRatio);
      else if (mode === "preview") ok = restoreImageGapInRM(app, filePath, anchor.imgBefore, anchor.imgAfter, anchor.gapRatio);
      break;
    case "text":
      if (mode === "source") ok = restoreTextInLP(app, filePath, anchor);
      else if (mode === "preview") ok = restoreTextInRM(app, filePath, anchor);
      break;
    default:
      assertNever(anchor);
  }

  // Consume the anchor only on success. A failed RM restore means the target
  // section isn't rendered yet (RM virtualizes off-screen sections) — keeping
  // the anchor lets the deferred-restore retry loop and readingMode.afterRender
  // try again once the section (and its data-diaa-line embeds) exist.
  if (ok) {
    setActiveAnchor(null);
    setFallbackPct(-1);
  }
  return ok;
}

// ── image-row restore (Strategy B) ─────────────────────

function restoreImageRowInLP(
  app: App, filePath: string,
  imageRowIndex: number, intraRowRatio: number,
): boolean {
  const view = (app.workspace.activeLeaf?.view as any);
  const cm = view.editor?.cm;
  const sd = cm?.scrollDOM;
  if (!sd || sd.clientHeight === 0) return false;

  const imgIndex = getImageRowIndex(filePath);
  const imgRow = imgIndex?.find(r => r.index === imageRowIndex);
  if (!imgRow) return false;

  const startLb = lineBlockByNumber(cm, imgRow.startLine);
  const endLb = lineBlockByNumber(cm, imgRow.endLine);
  const inset = lpInset(cm, sd);
  const rowTop = startLb.top;
  const rowBottom = endLb.top + endLb.height;
  const targetY = imageRowTargetY(rowTop, rowBottom - rowTop, intraRowRatio, inset, sd.clientHeight);
  sd.scrollTop = targetY;

  logger.info("VIEWPORT anchor-restored", {
    mode: "source", kind: "image-row", imageRowIndex,
    ratio: Math.round(intraRowRatio * 100),
    rowTop: Math.round(rowTop), rowH: Math.round(rowBottom - rowTop), inset: Math.round(inset),
    targetY: Math.round(targetY), actualY: Math.round(sd.scrollTop),
  });
  return true;
}

function restoreImageRowInRM(
  app: App, filePath: string,
  imageRowIndex: number, intraRowRatio: number,
): boolean {
  const previewEl = getRMPreviewEl(app) as HTMLElement;
  if (!previewEl || previewEl.clientHeight === 0) return false;

  const imgIndex = getImageRowIndex(filePath);
  const imgRow = imgIndex?.find(r => r.index === imageRowIndex);
  if (!imgRow) return false;

  const sel = imgIndexToSelector(imgRow);
  const rowEmbeds = previewEl.querySelectorAll(sel);
  if (rowEmbeds.length === 0) return false;

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
  const targetY = imageRowTargetY(rowTop, rowH, intraRowRatio, 0, previewEl.clientHeight);
  previewEl.scrollTop = targetY;

  logger.info("VIEWPORT anchor-restored", {
    mode: "preview", kind: "image-row", imageRowIndex,
    ratio: Math.round(intraRowRatio * 100),
    rowTop: Math.round(rowTop), rowH: Math.round(rowH),
    targetY: Math.round(targetY), actualY: Math.round(previewEl.scrollTop),
  });
  return true;
}

// ── image-gap restore (Strategy B, blank between image rows) ────────

function restoreImageGapInLP(
  app: App, filePath: string,
  imgBefore: number, imgAfter: number, gapRatio: number,
): boolean {
  const view = (app.workspace.activeLeaf?.view as any);
  const cm = view.editor?.cm;
  const sd = cm?.scrollDOM;
  if (!sd || sd.clientHeight === 0) return false;

  const imgIndex = getImageRowIndex(filePath);
  if (!imgIndex) return false;
  const inset = lpInset(cm, sd);

  const upRow = imgBefore > 0 ? imgIndex.find(r => r.index === imgBefore) : undefined;
  const downRow = imgAfter > 0 ? imgIndex.find(r => r.index === imgAfter) : undefined;

  let upBottom: number | null = null;
  if (upRow) {
    const lb = lineBlockByNumber(cm, upRow.endLine);
    upBottom = lb.top + lb.height;
  }
  const downTop = downRow ? lineBlockByNumber(cm, downRow.startLine).top : null;

  const junction = gapJunction(upBottom, downTop, gapRatio);
  if (junction == null) return false;

  const targetY = gapTargetY(junction, inset, sd.clientHeight);
  sd.scrollTop = targetY;

  logger.info("VIEWPORT anchor-restored", {
    mode: "source", kind: "image-gap", imgBefore, imgAfter,
    ratio: Math.round(gapRatio * 100),
    junction: Math.round(junction), inset: Math.round(inset),
    targetY: Math.round(targetY), actualY: Math.round(sd.scrollTop),
  });
  return true;
}

function restoreImageGapInRM(
  app: App, filePath: string,
  imgBefore: number, imgAfter: number, gapRatio: number,
): boolean {
  const previewEl = getRMPreviewEl(app) as HTMLElement;
  if (!previewEl || previewEl.clientHeight === 0) return false;

  const imgIndex = getImageRowIndex(filePath);
  if (!imgIndex) return false;
  const previewRect = previewEl.getBoundingClientRect();

  const upRow = imgBefore > 0 ? imgIndex.find(r => r.index === imgBefore) : undefined;
  const downRow = imgAfter > 0 ? imgIndex.find(r => r.index === imgAfter) : undefined;
  const upBounds = upRow ? rmRowBounds(previewEl, previewRect, upRow) : null;
  const downBounds = downRow ? rmRowBounds(previewEl, previewRect, downRow) : null;

  const junction = gapJunction(
    upBounds ? upBounds.bottom : null,
    downBounds ? downBounds.top : null,
    gapRatio,
  );
  if (junction == null) return false;

  const targetY = gapTargetY(junction, 0, previewEl.clientHeight);
  previewEl.scrollTop = targetY;

  logger.info("VIEWPORT anchor-restored", {
    mode: "preview", kind: "image-gap", imgBefore, imgAfter,
    ratio: Math.round(gapRatio * 100),
    junction: Math.round(junction),
    targetY: Math.round(targetY), actualY: Math.round(previewEl.scrollTop),
  });
  return true;
}

// ── text restore (Strategy A) ──────────────────────────

function findBestTextLine(
  cm: any,
  anchor: Extract<ViewportAnchor, { kind: "text" }>,
  filePath: string,
): number {
  const frag = anchor.anchorText;
  if (!frag) return 0;

  // Scan source lines in the SAME normalized space the anchor was captured in,
  // so markdown syntax in the source can't defeat the match. Collect ALL
  // matches: capping the list head-biases the candidate set (a common frag's
  // first N hits cluster in the early document), which starves the priors
  // below of the correct deep occurrence.
  const lines: number[] = [];
  const total = cm.state.doc.lines;
  for (let i = 1; i <= total; i++) {
    const norm = normalizeAnchorText(cm.state.doc.line(i).text);
    if (norm && norm.includes(frag)) {
      lines.push(i);
    }
  }
  if (lines.length === 0) return 0;
  if (lines.length === 1) return lines[0];

  // Multiple matches: disambiguate by the strongest prior available.
  // 1) Nearest image row (anchors to a concrete row's neighborhood).
  const imgIndex = getImageRowIndex(filePath);
  let expectedLine = -1;
  if (anchor.nearestImgBefore > 0) {
    const r = imgIndex?.find(x => x.index === anchor.nearestImgBefore);
    if (r) expectedLine = r.endLine + 1;
  } else if (anchor.nearestImgAfter > 0) {
    const r = imgIndex?.find(x => x.index === anchor.nearestImgAfter);
    if (r) expectedLine = r.startLine - 1;
  }
  if (expectedLine >= 0) return lines[nearestIndexBy(lines, expectedLine)];

  // 2) Position-ratio prior: pick the match whose pixel position best matches
  //    where the anchor sat in the document. Robust to RM virtualization that
  //    leaves nearestImg at 0.
  const sd = cm.scrollDOM;
  const scrollH = sd?.scrollHeight ?? 0;
  if (anchor.docRatio >= 0 && scrollH > 0) {
    const ratios = lines.map(ln => lineBlockByNumber(cm, asLine1(ln)).top / scrollH);
    return lines[nearestIndexBy(ratios, anchor.docRatio)];
  }

  // 3) No reliable prior — refuse to guess (picking lines[0] would jump the
  //    viewport to the document top); let the caller degrade to the nearest
  //    image row or the coarse fallback percentage instead.
  return 0;
}

function restoreTextInLP(
  app: App, filePath: string,
  anchor: Extract<ViewportAnchor, { kind: "text" }>,
): boolean {
  const view = (app.workspace.activeLeaf?.view as any);
  const cm = view.editor?.cm;
  const sd = cm?.scrollDOM;
  if (!sd || sd.clientHeight === 0) return false;

  const line = findBestTextLine(cm, anchor, filePath);
  if (line > 0) {
    const lb = lineBlockByNumber(cm, asLine1(line));
    const inset = lpInset(cm, sd);
    const targetY = textTargetY(lb.top, inset, anchor.anchorOffset);
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
    return true;
  }

  // Degrade: position relative to the nearest image row.
  const imgIndex = getImageRowIndex(filePath);
  const refIdx = anchor.nearestImgBefore > 0 ? anchor.nearestImgBefore : anchor.nearestImgAfter;
  if (refIdx > 0 && imgIndex) {
    const r = imgIndex.find(x => x.index === refIdx);
    if (r) {
      const refLine = anchor.nearestImgBefore > 0 ? r.endLine + 1 : r.startLine - 1;
      const lb = lineBlockByNumber(cm, asLine1(refLine));
      const targetY = textTargetY(lb.top, lpInset(cm, sd), anchor.anchorOffset);
      sd.scrollTop = targetY;
      logger.info("VIEWPORT anchor-restored", {
        mode: "source", kind: "text-degraded", refLine,
        targetY: Math.round(targetY), actualY: Math.round(sd.scrollTop),
      });
      return true;
    }
  }
  logger.info("VIEWPORT text unresolvable in LP", { frag: anchor.anchorText.slice(0, 30) });
  return false;
}

// ── RM section-height snapshot ──────────────────────────
// After warmup, the renderer's section heights may be zeroed when the
// reading view returns to display:none. Save a snapshot while the warmup
// override keeps layout alive, so the first real LP→RM switch can park
// at the correct Y before the renderer re-measures.
const _sectionSnapshot = new Map<string, LedgerSection[]>();

export function setSectionSnapshot(file: string, secs: LedgerSection[]): void {
  _sectionSnapshot.set(file, secs);
}

export function clearSectionSnapshot(file?: string): void {
  if (file) _sectionSnapshot.delete(file);
  else _sectionSnapshot.clear();
}

// ── RM height-ledger lookup ─────────────────────────────
// Obsidian's preview renderer keeps a JS height ledger (renderer.sections)
// that survives display:none — it's why docH is full-scale on the very first
// frame of a mode switch. During that first-show window the DOM sits in a
// transient compact layout (leading spacers not yet re-established), so DOM
// rects lie about positions while the ledger already knows the settled truth.
// Read the ledger directly; anything unexpected → -1 and the caller falls
// back to DOM measurement / the docRatio prior.
const LEDGER_DOCH_TOLERANCE = 0.2;  // ledger sum vs live scrollHeight sanity band
const LEDGER_PARK_TOL_MIN = 1500;   // px — legitimate estimate drift stays far below
const LEDGER_PARK_TOL_FRAC = 0.05;  // of docH — transient discrepancy is ~65% of docH
const RATIO_GATE_TOL = 0.15;        // LP vs RM docRatio naturally differs by a few pts

function rmLedgerYForLine(app: App, line1: number, file?: string, totalLines?: number): number {
  const view = app.workspace.activeLeaf?.view as any;
  const secs = view?.previewMode?.renderer?.sections;
  if (!Array.isArray(secs) || secs.length === 0) {
    logger.debug("VIEWPORT ledger unavailable", {
      hasRenderer: !!view?.previewMode?.renderer,
      sectionsType: typeof secs,
    });
    // Fall through to snapshot below.
  } else {
    const total = ledgerTotalHeight(secs);
    if (total <= 0) {
      logger.debug("VIEWPORT ledger all-zero", {
        len: secs.length,
        sampleHeight: typeof secs[0]?.height,
      });
      // Fall through to snapshot below — heights zeroed after warmup override removed.
    } else {
      const docH = (getRMPreviewEl(app) as HTMLElement | null)?.scrollHeight ?? 0;
      if (docH > 0 && Math.abs(total - docH) / docH > LEDGER_DOCH_TOLERANCE) {
        logger.debug("VIEWPORT ledger distrusted", { total: Math.round(total), docH });
      } else {
        const y = ledgerYForLine(secs, line1 - 1);
        if (y >= 0) return y;
        // Live sections are structurally ok (non-empty, non-zero, docH matches)
        // but don't cover this line yet — the renderer is still building after
        // a display:none→block transition. Fall through to the snapshot.
        logger.debug("VIEWPORT ledger line-out-of-range", {
          line: line1, secLen: secs.length,
          lastLineEnd: secs[secs.length - 1]?.lineEnd,
        });
      }
    }
  }

  // Live ledger is empty / missing / distrusted — try the warm-up snapshot.
  const key = file ?? (app.workspace.activeLeaf?.view as any)?.file?.path ?? "";
  const snap = _sectionSnapshot.get(key);
  if (snap && snap.length > 0) {
    const total = ledgerTotalHeight(snap);
    if (total > 0) {
      const docH = (getRMPreviewEl(app) as HTMLElement | null)?.scrollHeight ?? 0;
      // Snapshot was taken under the warm-up override (viewport ~725px, not the
      // real 687px), so heights can drift a few percent. Allow a wider band.
      if (docH > 0 && Math.abs(total - docH) / docH > LEDGER_DOCH_TOLERANCE) {
        logger.debug("VIEWPORT snapshot distrusted", { total: Math.round(total), docH });
        return -1;
      }
      const y = ledgerYForLine(snap, line1 - 1);
      if (y >= 0) return y;
      // Snapshot entries also lack lineStart/lineEnd (Obsidian sections only
      // carry height). Fall back to proportion-based section-index estimation
      // using real measured heights, which naturally tracks large image gaps.
      if (totalLines && totalLines > 0) {
        const heights = snap.map((s: any) => typeof s.height === "number" ? s.height : 0);
        const estY = sectionIndexEstimateY(heights, totalLines, line1);
        if (estY >= 0) {
          logger.debug("VIEWPORT ledger section-index-estimate", {
            line: line1, totalLines, secLen: snap.length,
            ledgerY: Math.round(estY), totalH: Math.round(total),
          });
          return estY;
        }
      }
      return -1;
    }
  }
  return -1;
}

function restoreTextInRM(
  app: App, filePath: string,
  anchor: Extract<ViewportAnchor, { kind: "text" }>,
): boolean {
  const previewEl = getRMPreviewEl(app) as HTMLElement;
  if (!previewEl || previewEl.clientHeight === 0) return false;

  const previewRect = previewEl.getBoundingClientRect();
  const frag = anchor.anchorText;
  const blocks = rmTextBlocks(previewEl);
  const matches = frag
    ? blocks.filter(b => normalizeAnchorText(b.textContent ?? "").includes(frag))
    : [];

  let chosen: HTMLElement | null = null;
  if (matches.length === 1) {
    chosen = matches[0];
  } else if (matches.length > 1) {
    // Disambiguate by the strongest prior available (mirrors findBestTextLine).
    // 1) Nearest image row.
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
    const tops = matches.map(m => m.getBoundingClientRect().top - previewRect.top + previewEl.scrollTop);
    if (expectedDocY >= 0) {
      chosen = matches[nearestIndexBy(tops, expectedDocY)];
    } else if (anchor.docRatio >= 0 && previewEl.scrollHeight > 0) {
      // 2) Position-ratio prior.
      const ratios = tops.map(t => t / previewEl.scrollHeight);
      chosen = matches[nearestIndexBy(ratios, anchor.docRatio)];
    }
    // 3) else: no reliable prior — leave chosen null and degrade below rather
    //    than guessing matches[0] (which would jump to the document top).
  }

  const ledgerY = anchor.anchorLine && anchor.anchorLine > 0
    ? rmLedgerYForLine(app, anchor.anchorLine, filePath, anchor.totalLines)
    : -1;

  if (chosen) {
    const rect = chosen.getBoundingClientRect();
    const blockTop = rect.top - previewRect.top + previewEl.scrollTop;

    // Plausibility gate: a DOM rect that disagrees wildly with the ledger is
    // a first-show transient (block measured in the compact stack) — park at
    // the ledger position and let the settle-hold fine-pin once layout lands.
    const tol = Math.max(LEDGER_PARK_TOL_MIN, previewEl.scrollHeight * LEDGER_PARK_TOL_FRAC);
    if (ledgerY >= 0 && Math.abs(blockTop - ledgerY) > tol) {
      const targetY = textTargetY(ledgerY, 0, anchor.anchorOffset);
      previewEl.scrollTop = targetY;
      logger.info("VIEWPORT anchor-restored", {
        mode: "preview", kind: "text-ledger-park",
        frag: frag.slice(0, 30), line: anchor.anchorLine,
        measuredTop: Math.round(blockTop), ledgerY: Math.round(ledgerY),
        targetY: Math.round(targetY), actualY: Math.round(previewEl.scrollTop),
      });
      return true;
    }

    // No ledger available → docRatio plausibility gate (weaker prior, wider
    // band): refuse a measurement that contradicts the captured position.
    if (ledgerY < 0 && anchor.docRatio >= 0 && previewEl.scrollHeight > 0) {
      const measuredRatio = blockTop / previewEl.scrollHeight;
      if (Math.abs(measuredRatio - anchor.docRatio) > RATIO_GATE_TOL) {
        const parkY = anchor.docRatio * previewEl.scrollHeight;
        const targetY = textTargetY(parkY, 0, anchor.anchorOffset);
        previewEl.scrollTop = targetY;
        logger.info("VIEWPORT anchor-restored", {
          mode: "preview", kind: "text-ratio-park",
          frag: frag.slice(0, 30),
          measuredPct: Math.round(measuredRatio * 100),
          docPct: Math.round(anchor.docRatio * 100),
          targetY: Math.round(targetY), actualY: Math.round(previewEl.scrollTop),
        });
        return true;
      }
    }

    const targetY = textTargetY(blockTop, 0, anchor.anchorOffset);
    previewEl.scrollTop = targetY;
    logger.info("VIEWPORT anchor-restored", {
      mode: "preview", kind: "text",
      frag: frag.slice(0, 30),
      offset: Math.round(anchor.anchorOffset),
      targetY: Math.round(targetY), actualY: Math.round(previewEl.scrollTop),
    });
    return true;
  }

  // No DOM match yet (target section not rendered): the ledger still knows the
  // line's settled Y — park there instead of degrading to an image embed.
  if (ledgerY >= 0) {
    const targetY = textTargetY(ledgerY, 0, anchor.anchorOffset);
    previewEl.scrollTop = targetY;
    logger.info("VIEWPORT anchor-restored", {
      mode: "preview", kind: "text-ledger-park-nomatch",
      line: anchor.anchorLine, ledgerY: Math.round(ledgerY),
      targetY: Math.round(targetY), actualY: Math.round(previewEl.scrollTop),
    });
    return true;
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
        return true;
      }
    }
  }
  logger.info("VIEWPORT text unresolvable in RM", { frag: frag.slice(0, 30) });
  return false;
}

// ── Scroll-capture guard (derived from Approach X Phase 2 design) ────
// During a native-scroll→precise-restore window, scroll events fired by the
// forced scroll must not leak into the LastAnchor slot (they'd pollute the
// next mode switch with an intermediate scroll position). The guard is a
// re-entrant counter so overlapping restores (unlikely but possible) don't
// prematurely release the lock.

const ENABLE_NATIVE_SCROLL = true;
let _restoreGuardDepth = 0;
let _restoreGuardTimeoutId: ReturnType<typeof setTimeout> | null = null;

function enterRestoreGuard(): void {
  _restoreGuardDepth++;
  if (_restoreGuardTimeoutId) clearTimeout(_restoreGuardTimeoutId);
  _restoreGuardTimeoutId = setTimeout(() => {
    logger.warn("RESTORE_GUARD safety timeout — force-released");
    _restoreGuardDepth = 0;
  }, 2000);
}
function exitRestoreGuard(): void {
  _restoreGuardDepth = Math.max(0, _restoreGuardDepth - 1);
  if (_restoreGuardDepth === 0 && _restoreGuardTimeoutId) {
    clearTimeout(_restoreGuardTimeoutId);
    _restoreGuardTimeoutId = null;
  }
}
function isRestoreGuardActive(): boolean { return _restoreGuardDepth > 0; }

// ── Native line-based scroll ──────────────────────────────────────────
// Two-phase restore engine (Solution A): when a precise pixel restore fails
// because the target row isn't rendered (cold RM / virtualized region), coerce
// the renderer to build DOM around the target line itself instead of crawling
// from scrollTop=0. This eliminates the ~1.5s "jump to document head" during
// the first switch to a deep region. Falls back to the legacy percentage-based
// coarse-jump (restoreScrollPct) when native scroll is unavailable or fails.

/** Derive a best-effort source-line number from the active anchor for the
 *  native scroll engine. Returns 0 when no reliable line is derivable. */
function anchorTargetLine(app: App): number {
  const active = getActiveAnchor();
  if (!active) return 0;
  const view = (app.workspace.activeLeaf?.view as any);
  const filePath = view?.file?.path ?? "";
  if (!filePath) return 0;

  if (active.kind === "image-row") {
    const imgIndex = getImageRowIndex(filePath);
    const r = imgIndex?.find(x => x.index === active.imageRowIndex);
    return r?.startLine ?? 0;
  }
  if (active.kind === "image-gap") {
    const imgIndex = getImageRowIndex(filePath);
    if (active.imgAfter > 0) {
      const r = imgIndex?.find(x => x.index === active.imgAfter);
      return r?.startLine ?? 0;
    }
    if (active.imgBefore > 0) {
      const r = imgIndex?.find(x => x.index === active.imgBefore);
      return r ? (r.endLine + 1) : 0;
    }
    return 0;
  }
  // text anchors: prefer nearest image row; fall back to docRatio estimate
  if (active.kind === "text") {
    const imgIndex = getImageRowIndex(filePath);
    if (active.nearestImgAfter > 0) {
      const r = imgIndex?.find(x => x.index === active.nearestImgAfter);
      if (r) return r.startLine;
    }
    if (active.nearestImgBefore > 0) {
      const r = imgIndex?.find(x => x.index === active.nearestImgBefore);
      if (r) return r.endLine + 1;
    }
    // No nearby image row — estimate from docRatio * totalLines (captured
    // from the outgoing LP view). A rough line estimate is still enough to
    // steer the native scroll toward the right region so the renderer builds
    // DOM there, after which the precise pixel restore lands exactly.
    if (active.docRatio >= 0 && active.totalLines > 0) {
      return Math.max(1, Math.round(active.docRatio * active.totalLines));
    }
    return 0;
  }
  return 0;
}

/** Initiate a native, virtualization-aware scroll to targetLine in the
 *  ACTIVE view's editor / preview renderer. Returns true when a position
 *  change is detected within 3 rAFs. Returns false (→ fall back to pct
 *  coarse-jump) when the API is unavailable, the line is out of bounds, or
 *  no visible scroll movement occurs. */
function nativeScrollToLine(app: App, targetLine: number): boolean {
  if (!ENABLE_NATIVE_SCROLL || targetLine <= 0) return false;
  const view = (app.workspace.activeLeaf?.view as any);
  const mode = view?.getMode?.() ?? "";
  if (mode !== "source" && mode !== "preview") return false;

  try {
    if (mode === "source") {
      const cm = view.editor?.cm;
      if (!cm) return false;
      if (targetLine > (cm.state?.doc?.lines ?? 0)) return false;
      const pos = cm.state.doc.line(targetLine).from;
      cm.scrollIntoView(pos, { y: "center" });
      // CM height maps are virtual: scrollTop updates synchronously.
      // Wait one rAF for the scroll position to stabilize, then verify.
      const sd = cm.scrollDOM as HTMLElement | null;
      const before = sd?.scrollTop ?? -1;
      if (before >= 0) {
        requestAnimationFrame(() => {
          const after = sd?.scrollTop ?? -1;
          logger.debug("VIEWPORT native-scroll LP", { targetLine, before: Math.round(before), after: Math.round(after) });
        });
      }
      // scrollIntoView is reliable → treat as success; the next precise restore
      // runs in the same rAF poll and will measure the actual position.
      return true;
    }

    if (mode === "preview") {
      // Try setEphemeralState first (Obsidian's navigation hook). It tells the
      // preview renderer to center around this line, building DOM that includes
      // the target area — the same mechanism Obsidian uses for link / search jumps.
      if (typeof view.setEphemeralState === "function") {
        view.setEphemeralState({ line: targetLine });
        logger.debug("VIEWPORT native-scroll RM setEphemeralState", { targetLine });
        return true;
      }
      // Fall back to previewMode.applyScroll if available (Obsidian internal API).
      if (view.previewMode && typeof view.previewMode.applyScroll === "function") {
        view.previewMode.applyScroll(targetLine);
        logger.debug("VIEWPORT native-scroll RM applyScroll", { targetLine });
        return true;
      }
      return false;
    }
  } catch (e) {
    // Any native-scroll exception → fall back to the legacy coarse-jump without
    // blocking the restore control flow.
    logger.warn("VIEWPORT native-scroll failed", { targetLine, mode, error: String(e) });
    return false;
  }
  return false;
}

// Legacy percentage-based restore kept as final fallback.
/** Coarse percentage-based scroll restore. Returns true when the write actually
 *  landed. The pct is consumed ONLY on a successful write: on a cold RM render
 *  the scroller has no scroll space yet (scrollHeight == clientHeight), and
 *  consuming the pct on that failed attempt would leave nothing to apply once
 *  the height ledger materializes (~0.5s) — the retry loops call this every
 *  frame, so keeping the pct makes the coarse jump self-healing. */
export function restoreScrollPct(app: App): boolean {
  const pct = getFallbackPct();
  if (pct < 0) return false;

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
    const previewEl = getRMPreviewEl(app) as HTMLElement;
    if (previewEl && previewEl.scrollHeight > previewEl.clientHeight) {
      docH = previewEl.scrollHeight;
      viewportH = previewEl.clientHeight;
      targetY = pct * (previewEl.scrollHeight - viewportH);
      previewEl.scrollTop = targetY;
      actualY = previewEl.scrollTop;
    }
  }

  if (targetY < 0) return false; // no scroll space yet — keep the pct for retry

  setFallbackPct(-1);
  logger.info("VIEWPORT fallback-restored", {
    mode, pct: Math.round(pct * 100),
    targetY: Math.round(targetY), actualY: Math.round(actualY),
    docH, viewportH, maxScroll: Math.round(docH - viewportH),
  });
  return true;
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
  if (anchor) {
    switch (anchor.kind) {
      case "text":
        info.frag = anchor.anchorText.slice(0, 16);
        info.offset = Math.round(anchor.anchorOffset);
        break;
      case "image-row":
        info.imageRowIndex = anchor.imageRowIndex;
        info.ratio = Math.round(anchor.intraRowRatio * 100);
        break;
      case "image-gap":
        info.imgBefore = anchor.imgBefore;
        info.imgAfter = anchor.imgAfter;
        info.ratio = Math.round(anchor.gapRatio * 100);
        break;
      default:
        assertNever(anchor);
    }
  }
  if (side === "RM") {
    const cands = [".markdown-reading-view", ".markdown-preview-view", ".markdown-preview-sizer", ".markdown-preview-section"];
    info.scrollTops = cands
      .map(s => { const e = document.querySelector(s) as HTMLElement | null; return e ? `${s}=${Math.round(e.scrollTop)}` : `${s}=n/a`; })
      .join(" ");
  }
  logger.debug(`SCROLL ${side}`, info);
}

export function ensureRMScrollTracking(app: App): void {
  const previewEl = getRMPreviewEl(app) as HTMLElement | null;
  if (!previewEl || previewEl.clientHeight === 0) return;
  if (_rmTrackedEl === previewEl) return;

  if (_rmScrollCleanup) {
    _rmScrollCleanup();
    _rmScrollCleanup = null;
  }
  _rmTrackedEl = null;

  const onScroll = () => {
    if (isRestoreGuardActive()) return; // native-scroll window: don't capture intermediate state
    const anchor = captureContentAnchor(app);
    if (anchor) {
      setRMLastAnchor(anchor, (app.workspace.activeLeaf?.view as any)?.file?.path ?? "");
    } else {
      // No anchor at this position — drop any stale one so a later mode switch
      // falls back to the fresh scroll percentage instead of jumping to an
      // unrelated image row captured earlier. Keep the file (matches prior
      // behavior: only the anchor is nulled).
      setRMLastAnchor(null, getRMLastAnchor().file);
    }
    const pct = computeScrollPct(app);
    if (pct >= 0) setLastFallbackPct(pct);
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

// RM virtualizes off-screen sections, so a deep target row's embeds may not
// exist for the first several frames after a mode switch. Retry the precise
// restore until it lands; coarse-jump once toward the captured scroll percent
// to force the target region to render (its embeds then appear).
// Time-based timeout for RM cold-render retry loop (5 s). Removed the
// frame-count cap (RM_RESTORE_MAX_FRAMES) because setEphemeralState is async
// and the renderer may take >1 s to build DOM around a deep target line.
// native-scroll is re-pushed every NATIVE_RETRY_INTERVAL frames to keep the
// renderer moving toward the target region.
const RM_RESTORE_TIMEOUT_MS = 5000;
const NATIVE_RETRY_INTERVAL = 30; // frames between setEphemeralState re-pushes
let _rmRestoreStartTime = 0;
let _rmNativeTried = false;
let _rmFramesSinceNative = 0;

// ── RM settle-hold ──────────────────────────────────────────────────
// A successful RM restore during a cold render is NOT final: the write lands
// against a partially-stacked layout (rendered sections pile up at the sizer
// top while the total height is placeholder-estimated), and as the sections
// above the target get their real heights the content slides away under a
// frozen scrollTop — the viewport visibly drifts to an unrelated early
// section (~0.9s observed) until the renderer's async line navigation lands.
// The settle-hold re-pins the anchor on every frame the layout moves, keeping
// the target content glued to the viewport while the height ledger settles.
// Exits when the layout is calm, on user input (never fight the user), or on
// timeout.
const RM_HOLD_TIMEOUT_MS = 3000;
const RM_HOLD_CALM_FRAMES = 10; // consecutive no-correction frames = settled
let _rmHoldId: number | null = null;
let _rmHoldCleanup: (() => void) | null = null;

function cancelRMSettleHold(): void {
  if (_rmHoldId !== null) {
    cancelAnimationFrame(_rmHoldId);
    _rmHoldId = null;
  }
  if (_rmHoldCleanup) {
    _rmHoldCleanup();
    _rmHoldCleanup = null;
  }
}

export function startRMSettleHold(app: App, seedAnchor: ViewportAnchor): void {
  cancelRMSettleHold();
  const view = app.workspace.activeLeaf?.view as any;
  const file = view?.file?.path ?? "";
  let hookedEl = getRMPreviewEl(app) as HTMLElement | null;
  if (!hookedEl || !file) return;

  // Hold the scroll-capture guard across the whole hold: our corrective
  // writes dispatch their scroll events asynchronously, so a per-write guard
  // would release before the event fires and pollute the RM anchor slot.
  enterRestoreGuard();

  let userInterrupted = false;
  const onUser = () => { userInterrupted = true; };
  const attach = (el: HTMLElement) => {
    el.addEventListener("wheel", onUser, { passive: true });
    el.addEventListener("touchstart", onUser, { passive: true });
    el.addEventListener("pointerdown", onUser, { passive: true });
  };
  const detach = (el: HTMLElement) => {
    el.removeEventListener("wheel", onUser);
    el.removeEventListener("touchstart", onUser);
    el.removeEventListener("pointerdown", onUser);
  };
  attach(hookedEl);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (hookedEl) detach(hookedEl);
    exitRestoreGuard();
  };
  _rmHoldCleanup = cleanup;

  const start = performance.now();
  let lastTop = hookedEl.scrollTop;
  let lastDocH = hookedEl.scrollHeight;
  let calm = 0;
  let corrections = 0;

  const finish = (reason: string, recapture: boolean) => {
    _rmHoldId = null;
    _rmHoldCleanup = null;
    cleanup();
    setActiveAnchor(null);
    logger.debug("VIEWPORT settle-hold end", {
      reason, corrections,
      ms: Math.round(performance.now() - start),
      scrollTop: hookedEl ? Math.round(hookedEl.scrollTop) : -1,
    });
    if (!recapture) return;
    const anchor = captureContentAnchor(app);
    if (anchor) setRMLastAnchor(anchor, file);
    const pct = computeScrollPct(app);
    if (pct >= 0) setLastFallbackPct(pct);
    driveViewportTransition(app, "rm-settle-hold");
  };

  const tick = () => {
    _rmHoldId = null;
    const v = app.workspace.activeLeaf?.view as any;
    if ((v?.getMode?.() ?? "") !== "preview" || (v?.file?.path ?? "") !== file) {
      finish("view-changed", false);
      return;
    }
    if (userInterrupted) {
      finish("user-input", false);
      return;
    }
    const el = getRMPreviewEl(app) as HTMLElement | null;
    if (!el) {
      finish("preview-gone", false);
      return;
    }
    if (el !== hookedEl) {
      // Spurious re-render replaced the preview DOM — rebase on the new one.
      if (hookedEl) detach(hookedEl);
      attach(el);
      hookedEl = el;
      lastTop = el.scrollTop;
      lastDocH = el.scrollHeight;
    }

    const docH = el.scrollHeight;
    const top = el.scrollTop;
    const moved = docH !== lastDocH || Math.abs(top - lastTop) > 1;
    if (moved) {
      // Layout reflowed (or an external write scrolled us) — re-pin.
      // enterRestoreGuard also refreshes the guard's 2s safety timer, so a
      // hold that keeps correcting can't be force-released mid-flight.
      enterRestoreGuard();
      setActiveAnchor(seedAnchor);
      const ok = restoreContentAnchor(app);
      if (!ok) setActiveAnchor(null); // target block mid-rerender; retry next frame
      exitRestoreGuard();
      const newTop = el.scrollTop;
      if (Math.abs(newTop - top) > 2) { corrections++; calm = 0; } else calm++;
      lastTop = newTop;
      lastDocH = el.scrollHeight;
    } else {
      calm++;
    }

    if (calm >= RM_HOLD_CALM_FRAMES) { finish("stable", true); return; }
    if (performance.now() - start > RM_HOLD_TIMEOUT_MS) { finish("timeout", true); return; }
    _rmHoldId = requestAnimationFrame(tick);
  };
  logger.debug("VIEWPORT settle-hold start", {
    scrollTop: Math.round(lastTop), docH: lastDocH,
  });
  _rmHoldId = requestAnimationFrame(tick);
}

function scheduleRMDeferredRestore(app: App): void {
  if (_rmDeferredRestoreId !== null) {
    cancelAnimationFrame(_rmDeferredRestoreId);
    _rmDeferredRestoreId = null;
  }
  cancelRMSettleHold(); // a new restore session supersedes any settling hold
  rmLoopExitGuard();    // close any prior session's guard (its closure is gone)
  _rmRestoreStartTime = performance.now();
  _rmNativeTried = false;
  _rmFramesSinceNative = 0;
  let _rmLastSeenDocH = -1;
  const targetFile = (app.workspace.activeLeaf?.view as any)?.file?.path ?? "";

  const enterGuardOnce = rmLoopEnterGuard;
  const exitGuardOnce = rmLoopExitGuard;

  const attempt = () => {
    const mode = (app.workspace.activeLeaf?.view as any)?.getMode?.() ?? "";
    if (mode !== "preview") { _rmDeferredRestoreId = null; exitGuardOnce(); return; }

    // Abort if the user switched documents during the retry window.
    const curFile = (app.workspace.activeLeaf?.view as any)?.file?.path ?? "";
    if (curFile !== targetFile) {
      _rmDeferredRestoreId = null;
      _rmNativeTried = false;
      exitGuardOnce();
      setActiveAnchor(null); setFallbackPct(-1);
      logger.info("VIEWPORT deferred-restore aborted: file changed", { targetFile, curFile });
      return;
    }

    const previewEl = getRMPreviewEl(app) as HTMLElement | null;
    if (!previewEl || previewEl.clientHeight === 0) {
      _rmDeferredRestoreId = requestAnimationFrame(attempt);
      return;
    }

    ensureRMScrollTracking(app);

    if (getActiveAnchor()) {
      const seedAnchor = getActiveAnchor()!; // restoreContentAnchor consumes it on success
      const ok = restoreContentAnchor(app);
      const elapsed = performance.now() - _rmRestoreStartTime;
      if (!ok && elapsed < RM_RESTORE_TIMEOUT_MS) {
        // Periodically re-push native-scroll so the renderer keeps building
        // DOM toward the target region (cold RM may need multiple pushes).
        _rmFramesSinceNative++;
        if (_rmFramesSinceNative >= NATIVE_RETRY_INTERVAL) {
          _rmNativeTried = false;
          _rmFramesSinceNative = 0;
        }
        let advanced = false;
        if (!_rmNativeTried) {
          _rmNativeTried = true;
          const line = anchorTargetLine(app);
          if (nativeScrollToLine(app, line)) {
            enterGuardOnce();
            advanced = true;
            _rmDeferredRestoreId = requestAnimationFrame(attempt);
            return;
          }
        }
        if (!advanced && getFallbackPct() >= 0) {
          // Coarse-jump as soon as the height ledger is USABLE, not at the end
          // of the window: during the cold-render ramp docH swings >10% per
          // frame, and jumping on a partial ledger would steer the renderer
          // far from the target region. ±5% frame-over-frame is stable enough;
          // restoreScrollPct itself keeps the pct un-consumed until the write
          // actually lands, so calling every stable frame is self-healing.
          const docH = previewEl.scrollHeight;
          const stable = _rmLastSeenDocH > 0
            && docH >= _rmLastSeenDocH * 0.95 && docH <= _rmLastSeenDocH * 1.05;
          _rmLastSeenDocH = docH;
          if (stable) {
            enterGuardOnce();
            restoreScrollPct(app);
          }
        }
        _rmDeferredRestoreId = requestAnimationFrame(attempt);
        return;
      }
      if (ok) {
        // A cold-render restore success is not final: the layout is still
        // settling and the content will slide away under a frozen scrollTop.
        // Hand off to the settle-hold, which re-pins the anchor per frame.
        _rmDeferredRestoreId = null;
        _rmNativeTried = false;
        startRMSettleHold(app, seedAnchor); // enters its own guard first…
        exitGuardOnce();                    // …so capture stays suppressed across the handoff
        return;
      }
      // Timeout — clear the anchor.
      _rmNativeTried = false;
      exitGuardOnce();
      restoreScrollPct(app);
      setFallbackPct(-1); // end of session: drop the pct even if the write failed
    }
    _rmDeferredRestoreId = null;
    _rmNativeTried = false;
    exitGuardOnce();

    const anchor = captureContentAnchor(app);
    if (anchor) {
      setRMLastAnchor(anchor, (app.workspace.activeLeaf?.view as any)?.file?.path ?? "");
    } else {
      setRMLastAnchor(null, getRMLastAnchor().file);
    }
    const pct = computeScrollPct(app);
    if (pct >= 0) setLastFallbackPct(pct);
    driveViewportTransition(app, "rm-after-restore");
  };
  // Try synchronously first: at layout-change the incoming view is usually
  // already laid out, so the restore lands before frame 0 paints (no flash).
  // The clientHeight===0 guard inside `attempt` falls back to rAF polling when
  // geometry isn't ready yet (cold RM render / virtualized target region).
  attempt();
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
    if (isRestoreGuardActive()) return; // native-scroll window: don't capture intermediate state
    const anchor = captureContentAnchor(app);
    if (anchor) {
      setLPLastAnchor(anchor, (app.workspace.activeLeaf?.view as any)?.file?.path ?? "");
    } else {
      setLPLastAnchor(null, getLPLastAnchor().file);
    }
    const pct = computeScrollPct(app);
    if (pct >= 0) setLastFallbackPct(pct);
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
  const targetFile = (app.workspace.activeLeaf?.view as any)?.file?.path ?? "";
  let _lpNativeTried = false;
  let _lpGuardActive = false;

  const enterGuardOnce = () => {
    if (!_lpGuardActive) { enterRestoreGuard(); _lpGuardActive = true; }
  };
  const exitGuardOnce = () => {
    if (_lpGuardActive) { exitRestoreGuard(); _lpGuardActive = false; }
  };

  const attempt = () => {
    const view = (app.workspace.activeLeaf?.view as any);
    const mode = view?.getMode?.() ?? "";
    if (mode !== "source") { _lpDeferredRestoreId = null; exitGuardOnce(); return; }

    // Abort if the user switched documents during the retry window.
    const curFile = view?.file?.path ?? "";
    if (curFile !== targetFile) {
      _lpDeferredRestoreId = null;
      _lpNativeTried = false;
      exitGuardOnce();
      setActiveAnchor(null); setFallbackPct(-1);
      logger.info("VIEWPORT deferred-restore aborted: file changed", { targetFile, curFile });
      return;
    }

    const sd = view.editor?.cm?.scrollDOM as HTMLElement | null;
    if (!sd || sd.clientHeight === 0) {
      _lpDeferredRestoreId = requestAnimationFrame(attempt);
      return;
    }
    _lpDeferredRestoreId = null;

    ensureLPScrollTracking(app);
    if (getActiveAnchor()) {
      const ok = restoreContentAnchor(app);
      if (!ok) {
        if (!_lpNativeTried) {
          _lpNativeTried = true;
          const line = anchorTargetLine(app);
          if (nativeScrollToLine(app, line)) {
            enterGuardOnce();
            _lpDeferredRestoreId = requestAnimationFrame(attempt);
            return;
          }
        }
        // LP (CodeMirror) is not virtualized — lineBlockAt resolves any line
        // regardless of scroll, so a native-scroll failure is terminal. Clear
        // the anchor so it can't linger and hijack a later restore.
        setActiveAnchor(null); setFallbackPct(-1);
      }
    } else if (getFallbackPct() >= 0) {
      enterGuardOnce();
      restoreScrollPct(app);
      // LP's height map is authoritative from frame one — a failed write means
      // "unscrollable", never "not yet". Drop the pct to preserve one-shot
      // semantics (no stale pct hijacking a later restore).
      setFallbackPct(-1);
    }
    _lpNativeTried = false;
    exitGuardOnce();

    const anchor = captureContentAnchor(app);
    if (anchor) {
      setLPLastAnchor(anchor, view?.file?.path ?? "");
    } else {
      setLPLastAnchor(null, getLPLastAnchor().file);
    }
    const pct = computeScrollPct(app);
    if (pct >= 0) setLastFallbackPct(pct);
    driveViewportTransition(app, "lp-after-restore");
  };
  // Try synchronously first (see scheduleRMDeferredRestore): LP's CodeMirror is
  // laid out at layout-change time and not virtualized, so the restore lands
  // before frame 0 paints. The clientHeight===0 guard keeps the rAF fallback.
  attempt();
}

// ── View mode change driver ─────────────────────────────────────────

/** DIAGNOSTIC (mode-switch flicker): sample the active scroller's scrollTop
 *  over consecutive animation frames to trace the per-frame timeline of the
 *  switch — frame 0 (synchronous) is the incoming view's native-retained
 *  position; the visible flash is the frame where our deferred anchor-restore
 *  snaps scrollTop to the target. docH/viewportH expose whether the geometry is
 *  even settled yet. Remove once the flicker fix lands. */
function probeSwitchScroll(app: App, framesLeft: number, total: number): void {
  const view = app.workspace.activeLeaf?.view as any;
  const mode = view?.getMode?.() ?? "";
  let scroller: HTMLElement | null = null;
  if (mode === "preview") scroller = getRMPreviewEl(app);
  else if (mode === "source") scroller = (view?.editor?.cm?.scrollDOM ?? null) as HTMLElement | null;
  if (scroller) {
    logger.debug("SWITCH probe", {
      mode,
      frame: total - framesLeft,
      scrollTop: Math.round(scroller.scrollTop),
      docH: scroller.scrollHeight,
      viewportH: scroller.clientHeight,
    });
  }
  if (framesLeft > 1) requestAnimationFrame(() => probeSwitchScroll(app, framesLeft - 1, total));
}

// ── Early mode-switch restore (Approach X) + Step-3.1 ordering probe ──
// Monkeypatches MarkdownView.setState — the unified API entry every RM↔LP
// switch funnels through, which the Step-3.1 diagnosis proved runs BEFORE the
// incoming view's first native paint (frame N). We schedule a rAF that polls
// until the incoming scroller is laid out (frame N) and writes scrollTop to the
// anchor target IN THAT FRAME, before it paints — so the incoming content's
// first visible frame is already aligned (no native-position flash). The
// layout-change path in onViewModeChange stays intact as an idempotent safety
// net. The `SWITCH setState-*` logging is kept during Phase 1 for verification.

const EARLY_RESTORE_MAX_FRAMES = 6;
// RM (MarkdownPreviewView) re-applies its own retained scroll one frame after
// our early write, unlike CM which holds it. Re-assert the target for a few
// frames on RM-incoming switches to override that revert (see Step-3.1 Phase 2).
const RM_EARLY_HOLD_FRAMES = 4;
let _switchEntrySeq = 0;

/** The scroller that will show `mode` after the switch (same lookup the
 *  restore path uses), read from the view instance directly. */
function incomingScrollerOf(view: any, mode: string): HTMLElement | null {
  if (mode === "source") return (view?.editor?.cm?.scrollDOM ?? null) as HTMLElement | null;
  if (mode === "preview") {
    const c = (view?.contentEl ?? view?.containerEl) as HTMLElement | undefined;
    return (c?.querySelector(".markdown-preview-view") as HTMLElement | null) ?? null;
  }
  return null;
}

/** Re-seed the (consume-on-success) active anchor from the captured seed, then
 *  restore. Used for both the frame-N write and the RM hold re-asserts. */
function applyEarly(app: App, seedAnchor: ViewportAnchor, seedPct: number): boolean {
  setActiveAnchor(seedAnchor);
  if (seedPct >= 0) setFallbackPct(seedPct);
  return restoreContentAnchor(app);
}

/** Re-assert the RM restore for a few frames so the preview's one-frame scroll
 *  revert can't leave a visible dip before the layout-change safety net lands. */
function scheduleRMHold(
  app: App, file: string, seedAnchor: ViewportAnchor, seedPct: number, holdFrames: number
): void {
  const hold = () => {
    const view = app.workspace.activeLeaf?.view as any;
    if ((view?.getMode?.() ?? "") !== "preview") return; // switched away
    if ((view?.file?.path ?? "") !== file) return;       // file changed
    applyEarly(app, seedAnchor, seedPct);                // override the preview revert
    if (--holdFrames > 0) requestAnimationFrame(hold);
  };
  requestAnimationFrame(hold);
}

/** Seed the active anchor from the OUTGOING mode's slot (same source as
 *  handleModeSwitch, with the same file guard), then poll rAF until the incoming
 *  view is laid out (frame N) and restore in that pre-paint frame. On RM-incoming
 *  switches, follow with a short hold loop (the RM preview reverts a single write;
 *  CM does not). Bails (letting the layout-change safety net take over) if there's
 *  nothing to restore or the geometry never settles within EARLY_RESTORE_MAX_FRAMES. */
function scheduleEarlyRestore(app: App, fromMode: string, toMode: string, file: string): void {
  const src = fromMode === "preview" ? getRMLastAnchor() : getLPLastAnchor();
  if (!(src.file === file && src.anchor)) return; // nothing to restore early
  const seedAnchor = src.anchor;
  const seedPct = getLastFallbackPct();

  let frames = EARLY_RESTORE_MAX_FRAMES;
  let nativeTried = false;
  const poll = () => {
    const view = app.workspace.activeLeaf?.view as any;
    if ((view?.getMode?.() ?? "") !== toMode) return;   // switched away / superseded
    if ((view?.file?.path ?? "") !== file) return;      // file changed
    const sc = incomingScrollerOf(view, toMode);
    if (!sc || sc.clientHeight === 0) {                  // not laid out yet
      if (--frames > 0) requestAnimationFrame(poll);
      return;
    }
    // frame N, pre-paint: try precise pixel restore first (cached views).
    // On cold RM render the target embeds may not exist yet — fall back to
    // native line-based scroll to force the renderer to build DOM around the
    // target, then retry. If even that fails, let layout-change handle it.
    const ok = applyEarly(app, seedAnchor, seedPct);
    if (!ok && !nativeTried) {
      nativeTried = true;
      const line = anchorTargetLine(app);
      if (nativeScrollToLine(app, line)) {
        enterRestoreGuard();
        if (--frames > 0) requestAnimationFrame(poll);
        return;
      }
    }
    exitRestoreGuard();
    if (toMode === "preview") scheduleRMHold(app, file, seedAnchor, seedPct, RM_EARLY_HOLD_FRAMES);
  };
  requestAnimationFrame(poll);
}

/** Install the early-restore hook (Phase 1). Returns an un-patch function; pass
 *  it to `Plugin.register` so it's removed on unload. */
export function installEarlyModeSwitchRestore(app: App): () => void {
  const proto = MarkdownView.prototype as any;
  const original = proto.setState as (state: any, result: any) => Promise<void>;

  proto.setState = function (this: any, state: any, result: any): Promise<void> {
    let isSwitch = false, fromMode = "", toMode = "", file = "";
    try {
      fromMode = this?.getMode?.() ?? "";
      toMode = state?.mode ?? "";
      file = this?.file?.path ?? "";
      isSwitch = !!(fromMode && toMode && fromMode !== toMode
        && (toMode === "source" || toMode === "preview") && file);

      // Step-3.1 verification logging (kept through Phase 1).
      const seq = ++_switchEntrySeq;
      const inc = incomingScrollerOf(this, toMode);
      logger.debug("SWITCH setState-enter", {
        seq, t: Math.round(performance.now()),
        from: fromMode || "?", to: toMode || "?", file, isSwitch,
        incomingBuilt: !!inc, clientH: inc?.clientHeight ?? -1,
        scrollTop: inc ? Math.round(inc.scrollTop) : -1,
      });
      const self = this;
      requestAnimationFrame(() => {
        try {
          const nowMode = self?.getMode?.() ?? "?";
          const sc = incomingScrollerOf(self, nowMode);
          logger.debug("SWITCH setState-raf", {
            seq, t: Math.round(performance.now()), mode: nowMode,
            clientH: sc?.clientHeight ?? -1,
            scrollTop: sc ? Math.round(sc.scrollTop) : -1,
          });
        } catch { /* diagnostic must never throw */ }
      });
    } catch { /* diagnostic must never throw */ }

    const ret = original.call(this, state, result);
    if (isSwitch) {
      try { scheduleEarlyRestore(app, fromMode, toMode, file); } catch { /* never break setState */ }
    }
    // Defend against spurious internal setState that re-renders the RM preview
    // from scratch, discarding our restored scroll position. Obsidian fires these
    // with mode="preview" but no file (isSwitch=false) during post-switch re-layout.
    // Snapshot the current RM scrollTop; if the reset drops it to 0, re-apply.
    if (!isSwitch && toMode === "preview") {
      const sc = incomingScrollerOf(this, "preview");
      const saved = sc?.scrollTop ?? 0;
      if (saved > 0) {
        ret.then(() => {
          requestAnimationFrame(() => {
            const sc2 = incomingScrollerOf(this, "preview");
            if (sc2 && sc2.scrollTop === 0 && sc2.scrollHeight > sc2.clientHeight) {
              sc2.scrollTop = saved;
              logger.debug("SWITCH spurious-reset defended", { saved });
            }
          });
        });
      }
    }
    return ret;
  };

  return () => { proto.setState = original; };
}


/** Drive cross-mode scroll restore on view mode switches (RM ↔ LP).
 *  Called from main.ts on layout-change. driveViewportTransition performs the
 *  edge-triggered mode-switch detection (RM→LP flush + anchor seed); we then
 *  schedule a deferred restore for whichever mode we switched INTO. The RM
 *  reading view is often cached, so its post-processor afterRender may not
 *  re-run — scheduleRMDeferredRestore guarantees the restore fires anyway. */
export function onViewModeChange(app: App): void {
  const wasNotLP = getLastMode() !== "source";
  const wasNotRM = getLastMode() !== "preview";
  probeSwitchScroll(app, 10, 10); // DIAGNOSTIC: trace native→restore scroll timeline
  driveViewportTransition(app, "layout-change");
  const mode = (app.workspace.activeLeaf?.view as any)?.getMode?.() ?? "";
  if (mode === "source") {
    ensureLPScrollTracking(app);
    if (wasNotLP) scheduleLPDeferredRestore(app);
  } else if (mode === "preview") {
    if (wasNotRM) scheduleRMDeferredRestore(app);
  }
}

// ── Viewport diagnostic logging ────────────────────────────────────

/** Flatten an anchor into log fields, handling all three anchor kinds. */
function anchorLogFields(a: ViewportAnchor): Record<string, any> {
  switch (a.kind) {
    case "image-row":
      return { kind: a.kind, imageRowIndex: a.imageRowIndex, ratio: Math.round(a.intraRowRatio * 100) };
    case "image-gap":
      return { kind: a.kind, imgBefore: a.imgBefore, imgAfter: a.imgAfter, ratio: Math.round(a.gapRatio * 100) };
    case "text":
      return {
        kind: a.kind, frag: a.anchorText.slice(0, 30), offset: Math.round(a.anchorOffset),
        nearestBefore: a.nearestImgBefore, nearestAfter: a.nearestImgAfter,
        docRatio: Math.round(a.docRatio * 100),
      };
    default:
      return assertNever(a);
  }
}

function computeDocH(app: App, mode: string): number {
  if (mode === "source") {
    const sd = (app.workspace.activeLeaf?.view as any)?.editor?.cm?.scrollDOM;
    return sd?.scrollHeight ?? 0;
  }
  if (mode === "preview") {
    const el = getRMPreviewEl(app) as HTMLElement;
    return el?.scrollHeight ?? 0;
  }
  return 0;
}

/** Edge-triggered mode-switch side effects. On an RM↔LP switch it flushes
 *  buffered RM alignment edits (RM→LP only) and seeds the restore anchor /
 *  fallback percentage from the OUTGOING mode's slot, so the incoming view's
 *  stale-scroll noise can't hijack it. No-op when the mode is unchanged.
 *  Does NOT update lastMode — the caller (driveViewportTransition) owns that
 *  transition immediately after, preserving the "first observer wins" ordering. */
function handleModeSwitch(app: App, mode: string, file: string, trigger: string): void {
  const lastMode = getLastMode();
  if (!(lastMode && lastMode !== mode)) return;

  const newDocH = computeDocH(app, mode);
  logger.info("VIEWPORT mode-switch", {
    from: lastMode, to: mode, trigger, file,
    oldDocH: getLastDocH(), newDocH,
    docHRatio: getLastDocH() > 0 && newDocH > 0 ? Math.round(newDocH / getLastDocH() * 100) : 0,
  });
  // Flush buffered RM alignment changes on RM→LP switch so the LP
  // editor picks up the updated markdown before scroll is restored.
  if (lastMode === "preview" && mode === "source") {
    const pendingCount = getPendingAlignmentCount();
    logger.info("ALIGN flush trigger: RM→LP switch", { pendingCount });
    const modified = flushPendingAlignments(app);
    logger.info("ALIGN flush done", { modifiedFiles: [...modified], remaining: getPendingAlignmentCount() });
    for (const path of modified) invalidateImageRowIndex(path);
    // Immediately rebuild the index for the current file so the deferred
    // restore (which fires next) can use image-row-based disambiguation
    // instead of falling back to the unreliable cross-mode docRatio.
    if (modified.has(file)) ensureImageRowIndexFromCM(app);
  }
  // Seed the restore anchor from the OUTGOING mode's slot, so the
  // incoming view's stale-scroll noise can't hijack it.
  const src = lastMode === "preview" ? getRMLastAnchor() : getLPLastAnchor();
  if (src.file === file && src.anchor) {
    setActiveAnchor(src.anchor);
    // Also seed the coarse fallback percentage: the RM deferred restore uses
    // it to force-render a virtualized target region when the precise anchor
    // can't resolve yet. Cleared on the first successful precise restore.
    if (getLastFallbackPct() >= 0) setFallbackPct(getLastFallbackPct());
    logger.info("VIEWPORT anchor-captured", {
      fromMode: lastMode,
      ...anchorLogFields(src.anchor),
    });
  } else if (src.file === file && getLastFallbackPct() >= 0) {
    setFallbackPct(getLastFallbackPct());
    logger.info("VIEWPORT fallback-captured", { fromMode: lastMode, pct: Math.round(getLastFallbackPct() * 100) });
  }
}

/** Drive the per-event viewport state transition, then log. Called on every
 *  viewport event (layout-change / post-processor / after-restore); whichever
 *  fires first is the "first observer" that detects the mode switch and seeds
 *  the restore anchor. Owns all global-state writes (mode-switch side effects,
 *  lastMode, lastDocH); logViewportState below is now pure read + log. */
export function driveViewportTransition(app: App, trigger: string): void {
  const view = (app.workspace.activeLeaf?.view as any);
  const mode = view?.getMode?.() ?? "none";
  const file = view?.file?.path ?? "";

  handleModeSwitch(app, mode, file, trigger);
  setLastMode(mode);
  logViewportState(app, trigger);
  if (file) setLastDocH(computeDocH(app, mode));
}

function logViewportState(app: App, trigger: string): void {
  const leaf = app.workspace.activeLeaf;
  const view = (leaf?.view as any);
  const mode = view?.getMode?.() ?? "none";
  const file = view?.file?.path ?? "";

  if (!file) return;

  let scrollY = 0, viewportH = 0, docH = 0;
  const extra: Record<string, any> = {};

  if (mode === "preview") {
    const previewEl = getRMPreviewEl(app) as HTMLElement;
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
        if (getImageLineRe().test(line.text)) {
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
}

// ── Main exports ───────────────────────────────────────────────

/** Flush buffered RM alignment changes to markdown.
 *  Called from main.ts on layout-change; the RM→LP mode switch flushes
 *  separately via handleModeSwitch. Only fires when there are pending alignments. */
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
