import { App, MarkdownView } from "obsidian";
import { logger } from "../logger";
const log = logger.channel("scrollAnchor");
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
  nearestIndexBy, ledgerYForLine, ledgerTotalHeight, extrapolateLedgerY, sectionIndexEstimateY, LedgerSection,
  clientTopToDocY, scrollTopToPct, pctToScrollTop,
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
  getImageLineRe, setRMLastAnchorList, getRMLastAnchorList,
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
    log.warn("VIEWPORT ratio out of range", { where, raw: Math.round(raw * 1000) / 1000 });
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
    return scrollTopToPct(sd.scrollTop, sd.scrollHeight, sd.clientHeight);
  }

  if (mode === "preview") {
    const previewEl = getRMPreviewEl(app) as HTMLElement;
    if (!previewEl || previewEl.clientHeight === 0) return -1;
    return scrollTopToPct(previewEl.scrollTop, previewEl.scrollHeight, previewEl.clientHeight);
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

/** Table row start chars: `|` + Unicode box-drawing verticals. */
const TABLE_ROW_RE = /^\s*[|│├┌└]/;

/** Table cell separators: `|` + box-drawing verticals / junctions. */
const TABLE_SPLIT_RE = /[|│┬┴┼┤├]/;

/** Strip all Box Drawing block chars (U+2500–U+257F) from cell content. */
const BOX_DRAWING_RE = /[─-╿]/g;

/** Split a source line into anchor-text candidates.
 *  YAML frontmatter lines are skipped — they are metadata, not content.
 *  Table rows are split into individual cell texts for cross-mode matching. */
function extractCandidates(
  lineText: string,
  lineNum: number,
  fmEndLine: number | undefined
): string[] {
  if (fmEndLine !== undefined && lineNum <= fmEndLine + 1) return [];
  if (TABLE_ROW_RE.test(lineText)) {
    return lineText
      .split(TABLE_SPLIT_RE)
      .map((c: string) => c.replace(BOX_DRAWING_RE, "").trim())
      .filter((c: string) => c.length > 0);
  }
  return [lineText];
}

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
  // Detect YAML frontmatter bounds so its key-value pairs are never captured
  // as anchor candidates. Primary: scan for `---` delimiters (most reliable,
  // no dependency on cache warmth). Fallback: metadataCache yaml section.
  let fmEndLine: number | undefined;
  if (totalLines > 1) {
    let yamlStart = -1;
    for (let li = 1; li <= Math.min(50, totalLines); li++) {
      if (cm.state.doc.line(li).text.trim() === "---") {
        if (yamlStart < 0) { yamlStart = li; }
        else { fmEndLine = li; break; }
      }
    }
  }
  if (fmEndLine === undefined) {
    const fc = app.metadataCache.getFileCache(view.file);
    fmEndLine = fc?.sections?.find(s => (s as any).type === "yaml")?.position?.end?.line;
  }

  // ── Structural improvement A: pre-compute un-anchorable regions ──────
  // Instead of enumerating every non-body text pattern (whack-a-mole), mark
  // the entire interior of fenced code blocks as excluded. Only the fence
  // markers need to be pattern-matched; everything between them is excluded
  // regardless of content. This closes the gap that let ASCII-tree content
  // lines inside ``` blocks pass through every existing filter.
  const codeBlockRanges: [number, number][] = [];
  for (let li = 1; li <= totalLines; li++) {
    const t = cm.state.doc.line(li).text;
    if (/^\s*`{3,}/.test(t) || /^\s*~{3,}/.test(t)) {
      const last = codeBlockRanges[codeBlockRanges.length - 1];
      if (last && last[1] < 0) {
        last[1] = li; // closing fence
      } else {
        codeBlockRanges.push([li, -1]); // opening fence
      }
    }
  }
  for (const r of codeBlockRanges) { if (r[1] < 0) r[1] = totalLines; }

  const isInCodeBlock = (line: number): boolean => {
    for (const [lo, hi] of codeBlockRanges) {
      if (line >= lo && line <= hi) return true;
    }
    return false;
  };

  const topBlock = cm.lineBlockAtHeight(scrollTop - inset);
  const topLine = Math.max(1, cm.state.doc.lineAt(topBlock.from).number);

  for (let i = topLine; i <= totalLines; i++) {
    const lineObj = cm.state.doc.line(i);
    const lb = cm.lineBlockAt(lineObj.from);
    const screenTop = lb.top - scrollTop + inset;
    if (screenTop >= clientH) break; // past the viewport bottom
    // ── Quality gate B: line must be at or below the viewport top ──────
    // A line whose block top is above the viewport (negative screenTop) is
    // not truly visible — it was already scrolled past. Skip it and keep
    // scanning for the first genuine visible line.
    if (screenTop < 0) continue;
    if (!lineObj.text.trim()) continue;
    if (getImageLineRe().test(lineObj.text)) continue;
    // ── Region gate A: skip lines in un-anchorable regions ─────────────
    if (fmEndLine !== undefined && i <= fmEndLine) continue;
    if (isInCodeBlock(i)) continue;
    // Single-line patterns still excluded here.
    if (/^\s*[-*_]{3,}\s*$/.test(lineObj.text)) continue; // horizontal rule
    if (/^\s*<\/?[a-zA-Z]/.test(lineObj.text)) continue;   // HTML tag line

    const candidates = extractCandidates(lineObj.text, i, fmEndLine);
    for (const raw of candidates) {
      const text = normalizeAnchorText(raw);
      if (text.length < MIN_ANCHOR_TEXT_LEN) continue;
      const { before, after } = nearestImgRowsByLine(imgIndex, i);
      // Build 3-line context: prev tail + current + next head (all normalized).
      // Increases fragment uniqueness in template-heavy documents (Phase 4).
      const prevTail = i > 1
        ? normalizeAnchorText(cm.state.doc.line(i - 1).text).slice(-60)
        : "";
      const nextHead = i < totalLines
        ? normalizeAnchorText(cm.state.doc.line(i + 1).text).slice(0, 60)
        : "";
      const context = [prevTail, text, nextHead].join("\n").trim();
      // Nearest preceding heading (Phase 4.2): scan backward for a heading line
      // and normalize it — the # markers are stripped, leaving just the title text.
      let headingHint: string | undefined;
      for (let hi = i - 1; hi >= 1; hi--) {
        const ht = cm.state.doc.line(hi).text;
        if (/^\s*#{1,6}\s/.test(ht)) {
          headingHint = normalizeAnchorText(ht) || undefined;
          break;
        }
      }
      return {
        kind: "text",
        anchorText: text.slice(0, 100),
        anchorContext: context || undefined,
        headingHint,
        anchorOffset: screenTop,
        anchorLine: i,
        nearestImgBefore: before,
        nearestImgAfter: after,
        docRatio: sd.scrollHeight > 0 ? lb.top / sd.scrollHeight : -1,
        totalLines: cm.state.doc.lines,
      };
    }
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
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    const rect = block.getBoundingClientRect();
    if (rect.bottom <= viewportTopClient) continue;
    if (rect.top >= viewportBottomClient) break;
    if (block.closest("pre, code, table")) continue;
    const text = normalizeAnchorText(block.textContent ?? "");
    if (text.length < MIN_ANCHOR_TEXT_LEN) continue;
    const blockTopDoc = clientTopToDocY(rect.top, previewRect.top, previewEl.scrollTop);
    const { before, after } = nearestImgRowsRM(previewEl, imgIndex, previewRect, blockTopDoc);
    // Build 3-block context from nearest text-bearing neighbors (Phase 4).
    const prevTail = bi > 0
      ? normalizeAnchorText(blocks[bi - 1].textContent ?? "").slice(-60)
      : "";
    const nextHead = bi < blocks.length - 1
      ? normalizeAnchorText(blocks[bi + 1].textContent ?? "").slice(0, 60)
      : "";
    const context = [prevTail, text, nextHead].join("\n").trim();
    // Nearest preceding heading (Phase 4.2): scan backward in block list.
    let headingHint: string | undefined;
    for (let hi = bi - 1; hi >= 0; hi--) {
      if (/^H[1-6]$/.test(blocks[hi].tagName)) {
        headingHint = normalizeAnchorText(blocks[hi].textContent ?? "") || undefined;
        break;
      }
    }
    return {
      kind: "text",
      anchorText: text.slice(0, 100),
      anchorContext: context || undefined,
      headingHint,
      anchorOffset: rect.top - viewportTopClient,
      nearestImgBefore: before,
      nearestImgAfter: after,
      docRatio: previewEl.scrollHeight > 0 ? blockTopDoc / previewEl.scrollHeight : -1,
      totalLines: -1,
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
      const eTop = clientTopToDocY(eRect.top, previewRect.top, previewEl.scrollTop);
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
    const t = clientTopToDocY(r.top, previewRect.top, previewEl.scrollTop);
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
    const embedTop = clientTopToDocY(rect.top, previewRect.top, previewEl.scrollTop);
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
    log.warn("VIEWPORT RM data-diaa-line unmapped (line-base mismatch?)", {
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

// Timer for deferred restore-accuracy check (800ms post-restore).
let _accuracyTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRestoreAccuracyCheck(
  app: App, mode: string, anchor: ViewportAnchor, kind: string,
  restoreScrollTop: number, restoreDocH: number,
): void {
  if (_accuracyTimer) clearTimeout(_accuracyTimer);
  const capturedDocRatio = anchor.kind === "text" ? anchor.docRatio : -1;
  const expectedOffset = anchor.kind === "text" ? anchor.anchorOffset : -1;
  const frag = anchor.kind === "text" ? anchor.anchorText.slice(0, 40) : "";
  _accuracyTimer = setTimeout(() => {
    _accuracyTimer = null;
    const v = (app.workspace.activeLeaf?.view as any);
    const curMode = v?.getMode?.() ?? "";
    if (curMode !== mode) return; // mode changed since restore, stale check

    let curScrollTop = 0, curDocH = 0;
    let anchorElFound = false;
    let actualViewportOffset = -1;

    if (mode === "preview") {
      const previewEl = getRMPreviewEl(app) as HTMLElement | null;
      if (!previewEl) return;
      curScrollTop = previewEl.scrollTop;
      curDocH = previewEl.scrollHeight;
      // Try to locate the anchor element in RM DOM
      if (anchor.kind === "text" && frag) {
        const norm = (s: string) => s.replace(/\s+/g, " ").trim();
        const blocks = Array.from(previewEl.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, pre, div.cm-line"));
        for (const b of blocks) {
          if (norm(b.textContent ?? "").includes(frag)) {
            const rect = b.getBoundingClientRect();
            const previewRect = previewEl.getBoundingClientRect();
            actualViewportOffset = rect.top - previewRect.top;
            anchorElFound = true;
            break;
          }
        }
      }
    } else if (mode === "source") {
      const sd = (v?.editor?.cm?.scrollDOM) as HTMLElement | null;
      if (sd) { curScrollTop = sd.scrollTop; curDocH = sd.scrollHeight; }
    }

    const restoredDocRatio = curDocH > 0 ? curScrollTop / curDocH : -1;
    const ratioDrift = capturedDocRatio >= 0 && restoredDocRatio >= 0
      ? Math.round((restoredDocRatio - capturedDocRatio) * 1000) / 10 // percentage points, 1 decimal
      : -999;
    const pxError = anchorElFound && expectedOffset >= 0
      ? Math.round(actualViewportOffset - expectedOffset)
      : -999;
    const docHDrift = restoreDocH > 0 ? curDocH - restoreDocH : 0;
    const scrollTopDrift = curScrollTop - restoreScrollTop;

    log.info("VIEWPORT restore-accuracy", {
      mode, kind, frag,
      capturedDocRatio: Math.round(capturedDocRatio * 100),
      restoredDocRatio: Math.round(restoredDocRatio * 100),
      ratioDrift,
      anchorElFound,
      actualViewportOffset: anchorElFound ? Math.round(actualViewportOffset) : -1,
      expectedViewportOffset: Math.round(expectedOffset),
      pxError,
      docHDrift: Math.round(docHDrift),
      scrollTopDrift: Math.round(scrollTopDrift),
    });
  }, 800);
}

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
    // Schedule a deferred accuracy check (self-debouncing: repeated calls within
    // the settle-hold reschedule the timer, so it fires only 800ms after calm).
    const curDocH = computeDocH(app, mode);
    let curScrollTop = 0;
    if (mode === "preview") {
      curScrollTop = (getRMPreviewEl(app) as HTMLElement)?.scrollTop ?? 0;
    } else if (mode === "source") {
      curScrollTop = (view?.editor?.cm?.scrollDOM as HTMLElement)?.scrollTop ?? 0;
    }
    scheduleRestoreAccuracyCheck(app, mode, anchor, anchor.kind, curScrollTop, curDocH);
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

  log.info("VIEWPORT anchor-restored", {
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
    const t = clientTopToDocY(r.top, previewRect.top, previewEl.scrollTop);
    const b = t + r.height;
    if (t < rowTop) rowTop = t;
    if (b > rowBottom) rowBottom = b;
  }

  const rowH = rowBottom - rowTop;
  const targetY = imageRowTargetY(rowTop, rowH, intraRowRatio, 0, previewEl.clientHeight);
  previewEl.scrollTop = targetY;

  log.info("VIEWPORT anchor-restored", {
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

  log.info("VIEWPORT anchor-restored", {
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

  log.info("VIEWPORT anchor-restored", {
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

  const total = cm.state.doc.lines;

  // Phase 4: if we have a multi-line context, prefer it for matching —
  // 3-line fingerprints are far less ambiguous in template-heavy documents.
  const ctxFrag = anchor.anchorContext;
  const lines: number[] = [];
  if (ctxFrag) {
    for (let i = 1; i <= total; i++) {
      const norm = normalizeAnchorText(cm.state.doc.line(i).text);
      if (!norm) continue;
      const prevTail = i > 1
        ? normalizeAnchorText(cm.state.doc.line(i - 1).text).slice(-60)
        : "";
      const nextHead = i < total
        ? normalizeAnchorText(cm.state.doc.line(i + 1).text).slice(0, 60)
        : "";
      const ctx = [prevTail, norm, nextHead].join("\n").trim();
      if (ctx && ctx.includes(ctxFrag)) {
        lines.push(i);
      }
    }
  }
  // Fall back to single-line matching when context yields no hits (e.g.
  // cross-mode mismatch between LP source lines and RM DOM blocks).
  if (lines.length === 0) {
    for (let i = 1; i <= total; i++) {
      const norm = normalizeAnchorText(cm.state.doc.line(i).text);
      if (norm && norm.includes(frag)) {
        lines.push(i);
      }
    }
  }
  // 2-line sliding window: when RM renders two LP source lines as one DOM
  // block (e.g. bold heading + list item), neither single line fully matches
  // the cross-mode anchor text. Joining adjacent normalized lines bridges this.
  if (lines.length === 0 && total > 1) {
    for (let i = 1; i < total; i++) {
      const normA = normalizeAnchorText(cm.state.doc.line(i).text);
      const normB = normalizeAnchorText(cm.state.doc.line(i + 1).text);
      if (!normA || !normB) continue;
      if ((normA + " " + normB).includes(frag)) {
        lines.push(i);
      }
    }
  }
  if (lines.length === 0) return 0;
  if (lines.length === 1) return lines[0];

  // Phase 4.2: when multiple context matches exist, prefer candidates under
  // the same heading as the capture point. In template-heavy documents the
  // heading is often the only stable differentiator between repeated sections.
  if (anchor.headingHint && lines.length > 1) {
    const withHeading: number[] = [];
    for (const ln of lines) {
      for (let hi = ln - 1; hi >= 1; hi--) {
        const ht = cm.state.doc.line(hi).text;
        if (/^\s*#{1,6}\s/.test(ht)) {
          if (normalizeAnchorText(ht) === anchor.headingHint) {
            withHeading.push(ln);
          }
          break;
        }
      }
    }
    if (withHeading.length > 0) {
      if (withHeading.length === 1) return withHeading[0];
      // Narrow the candidate set; remaining priors disambiguate within it.
      lines.length = 0;
      lines.push(...withHeading);
    }
    // If headingHint matched nothing, keep the full candidate set — the
    // heading may differ across modes (e.g. RM renders a heading as plain
    // text in a different block), so this prior is advisory, not binding.
  }

  // Multiple matches: disambiguate by the strongest prior available.
  // 0) Direct anchor-line number (ledger-derived from RM or native from LP).
  //    It is a strong hint, but when ledger-derived it is an ESTIMATE that
  //    can be off by a few lines. Validate the best match against docRatio;
  //    if the winner contradicts the captured position, try the next-closest
  //    candidates before giving up.
  const sd = cm.scrollDOM;
  const scrollH = sd?.scrollHeight ?? 0;
  if (anchor.anchorLine && anchor.anchorLine > 0) {
    // Sort by distance to anchorLine so we try closest candidates first.
    const sorted = [...lines].sort((a, b) => Math.abs(a - anchor.anchorLine!) - Math.abs(b - anchor.anchorLine!));
    if (anchor.docRatio >= 0 && scrollH > 0) {
      for (const ln of sorted) {
        const ratio = lineBlockByNumber(cm, asLine1(ln)).top / scrollH;
        if (Math.abs(ratio - anchor.docRatio) <= RATIO_GATE_TOL) {
          return ln;
        }
      }
      // No candidate passed the consistency gate — fall through to other priors.
    } else {
      // No docRatio to cross-check — trust anchorLine alone (LP-captured anchors
      // always have docRatio, so this only runs for pre-docRatio RM captures).
      return sorted[0];
    }
  }
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
  if (anchor.docRatio >= 0 && scrollH > 0) {
    const ratios = lines.map(ln => lineBlockByNumber(cm, asLine1(ln)).top / scrollH);
    return lines[nearestIndexBy(ratios, anchor.docRatio)];
  }

  // 3) No reliable prior — refuse to guess (picking lines[0] would jump the
  //    viewport to the document top); let the caller degrade to the nearest
  //    image row or the coarse fallback percentage instead.
  log.info("VIEWPORT text-match-lp", {
    frag: frag.slice(0, 40),
    anchorCtx: ctxFrag ? "yes" : "no",
    ctxHits: ctxFrag ? lines.length > 0 ? lines.length : 0 : -1,
    singleHits: lines.length > 0 ? lines.length : (() => { let c = 0; for (let i = 1; i <= total; i++) { const norm = normalizeAnchorText(cm.state.doc.line(i).text); if (norm && norm.includes(frag)) c++; } return c; })(),
    candidates: lines.length,
    anchorLine: anchor.anchorLine ?? -1,
    imgB: anchor.nearestImgBefore, imgA: anchor.nearestImgAfter,
    docRatio: Math.round(anchor.docRatio * 100),
    headingHint: anchor.headingHint ? anchor.headingHint.slice(0, 30) : "",
    result: 0,
  });
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
    log.info("VIEWPORT anchor-restored", {
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
      log.info("VIEWPORT anchor-restored", {
        mode: "source", kind: "text-degraded", refLine,
        targetY: Math.round(targetY), actualY: Math.round(sd.scrollTop),
      });
      // Return false so the early-restore poll retries text matching on the
      // next frame (degraded positioning is only a stopgap, not a success).
      return false;
    }
  }
  log.info("VIEWPORT text unresolvable in LP", { frag: anchor.anchorText.slice(0, 30) });
  return false;
}

// ── RM section-height snapshot ──────────────────────────
// After warmup, the renderer's section heights may be zeroed when the
// reading view returns to display:none. Save a snapshot while the warmup
// override keeps layout alive, so the first real LP→RM switch can park
// at the correct Y before the renderer re-measures.
const _sectionSnapshot = new Map<string, LedgerSection[]>();
const _snapshotLineCount = new Map<string, number>();

export function setSectionSnapshot(file: string, secs: LedgerSection[], totalLines?: number): void {
  _sectionSnapshot.set(file, secs);
  if (totalLines !== undefined && totalLines > 0) {
    _snapshotLineCount.set(file, totalLines);
  }
}

/** Apply a line-count delta to the snapshot after an edit before a full re-warmup.
 *  Sections entirely after editLine get their lineStart/lineEnd shifted by delta.
 *  Sections that straddle editLine are removed (stale), falling back to live ledger. */
export function applySnapshotLineDelta(
  file: string, newLineCount: number, editLine: number,
): void {
  const oldCount = _snapshotLineCount.get(file);
  const snap = _sectionSnapshot.get(file);
  if (oldCount === undefined || !snap || snap.length === 0) return;

  const delta = newLineCount - oldCount;
  if (delta === 0) { _snapshotLineCount.set(file, newLineCount); return; }

  // Iterate backwards — splicing while iterating is safe this way.
  for (let i = snap.length - 1; i >= 0; i--) {
    const sec = snap[i];
    if (sec.lineStart > editLine) {
      sec.lineStart += delta;
      sec.lineEnd += delta;
    } else if (sec.lineEnd >= editLine) {
      snap.splice(i, 1);
    }
  }

  _snapshotLineCount.set(file, newLineCount);
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
  log.info("VIEWPORT ledger debug: rmLedgerYForLine called", {
    line1, totalLines: totalLines ?? "undefined", file: file ?? "undefined",
  });
  const view = app.workspace.activeLeaf?.view as any;
  const secs = view?.previewMode?.renderer?.sections;
  if (!Array.isArray(secs) || secs.length === 0) {
    log.debug("VIEWPORT ledger unavailable", {
      hasRenderer: !!view?.previewMode?.renderer,
      sectionsType: typeof secs,
    });
    // Fall through to snapshot below.
  } else {
    const total = ledgerTotalHeight(secs);
    if (total <= 0) {
      log.debug("VIEWPORT ledger all-zero", {
        len: secs.length,
        sampleHeight: typeof secs[0]?.height,
      });
      // Fall through to snapshot below — heights zeroed after warmup override removed.
    } else {
      const docH = (getRMPreviewEl(app) as HTMLElement | null)?.scrollHeight ?? 0;
      if (docH > 0 && Math.abs(total - docH) / docH > LEDGER_DOCH_TOLERANCE) {
        log.debug("VIEWPORT ledger distrusted", { total: Math.round(total), docH });
      } else {
        const y = ledgerYForLine(secs, line1 - 1);
        if (y >= 0) return y;
        log.debug("VIEWPORT ledger line-out-of-range", {
          line: line1, secLen: secs.length,
          lastLineEnd: secs[secs.length - 1]?.lineEnd,
        });
      }
    }
  }

  // Fallback: when all sections lack lineStart/lineEnd, estimate Y from
  // proportional section heights.
  if (Array.isArray(secs) && secs.length > 0 && totalLines && totalLines > 0) {
    const heights = secs.map((s: any) => (s.height as number) ?? 0);
    const totalH = heights.reduce((a, b) => a + b, 0);
    if (totalH > 0) {
      const y = sectionIndexEstimateY(heights, totalLines, line1);
      log.info("VIEWPORT ledger debug: live estimateY", {
        line1, totalLines, heightsLen: heights.length, totalH, estY: Math.round(y),
      });
      if (y >= 0) return y;
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
        log.debug("VIEWPORT snapshot distrusted", { total: Math.round(total), docH });
        return -1;
      }
      const y = ledgerYForLine(snap, line1 - 1);
      if (y >= 0) return y;
      if (totalLines && totalLines > 0) {
        const heights = snap.map((s: any) => (s.height as number) ?? 0);
        const totalH = heights.reduce((a, b) => a + b, 0);
        if (totalH > 0) {
          const y2 = sectionIndexEstimateY(heights, totalLines, line1);
          log.info("VIEWPORT ledger debug: snapshot estimateY", {
            line1, totalLines, heightsLen: heights.length, totalH, estY: Math.round(y2),
          });
          if (y2 >= 0) return y2;
        }
      }
    }
  }

  // Both live ledger and warmup snapshot failed — try extrapolation from the
  // last known section for lines near the document tail.
  if (Array.isArray(secs) && secs.length > 0 && totalLines && totalLines > 0) {
    const docH = (getRMPreviewEl(app) as HTMLElement | null)?.scrollHeight ?? 0;
    if (docH > 0) {
      const y = extrapolateLedgerY(secs, line1, totalLines, docH);
      if (y >= 0) return y;
    }
  }
  if (snap && snap.length > 0 && totalLines && totalLines > 0) {
    const docH = (getRMPreviewEl(app) as HTMLElement | null)?.scrollHeight ?? 0;
    if (docH > 0) {
      const y = extrapolateLedgerY(snap, line1, totalLines, docH);
      if (y >= 0) return y;
    }
  }

  log.info("VIEWPORT ledger debug: all fallbacks failed, returning -1", {
    line1, totalLines: totalLines ?? "undefined",
  });
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

  // Phase 4: prefer 3-block context matching over single-block (mirrors
  // findBestTextLine). Falls back to single-block when context is absent
  // or yields no hits.
  let matches: HTMLElement[];
  const ctxFrag = anchor.anchorContext;
  if (ctxFrag) {
    const ctxMatches: HTMLElement[] = [];
    for (let bi = 0; bi < blocks.length; bi++) {
      const text = normalizeAnchorText(blocks[bi].textContent ?? "");
      if (!text) continue;
      const prevTail = bi > 0
        ? normalizeAnchorText(blocks[bi - 1].textContent ?? "").slice(-60)
        : "";
      const nextHead = bi < blocks.length - 1
        ? normalizeAnchorText(blocks[bi + 1].textContent ?? "").slice(0, 60)
        : "";
      const ctx = [prevTail, text, nextHead].join("\n").trim();
      if (ctx && ctx.includes(ctxFrag)) {
        ctxMatches.push(blocks[bi]);
      }
    }
    matches = ctxMatches.length > 0
      ? ctxMatches
      : frag
        ? blocks.filter(b => normalizeAnchorText(b.textContent ?? "").includes(frag))
        : [];
  } else {
    matches = frag
      ? blocks.filter(b => normalizeAnchorText(b.textContent ?? "").includes(frag))
      : [];
  }

  log.info("VIEWPORT ledger debug: restoreTextInRM about to call rmLedgerYForLine", {
    anchorLine: anchor.anchorLine, anchorTotalLines: anchor.totalLines, filePath,
  });
  const ledgerY = anchor.anchorLine && anchor.anchorLine > 0
    ? rmLedgerYForLine(app, anchor.anchorLine, filePath, anchor.totalLines)
    : -1;
  log.info("VIEWPORT ledger debug: rmLedgerYForLine returned", { ledgerY: Math.round(ledgerY) });

  let chosen: HTMLElement | null = null;
  // ── diagnostic: text matching summary ──────────────────────────
  const _ctxHits = ctxFrag ? (() => {
    const m: HTMLElement[] = [];
    for (let bi = 0; bi < blocks.length; bi++) {
      const text = normalizeAnchorText(blocks[bi].textContent ?? "");
      if (!text) continue;
      const prevTail = bi > 0 ? normalizeAnchorText(blocks[bi - 1].textContent ?? "").slice(-60) : "";
      const nextHead = bi < blocks.length - 1 ? normalizeAnchorText(blocks[bi + 1].textContent ?? "").slice(0, 60) : "";
      const ctx = [prevTail, text, nextHead].join("\n").trim();
      if (ctx && ctx.includes(ctxFrag)) m.push(blocks[bi]);
    }
    return m.length;
  })() : -1;
  const _singleHits = frag ? blocks.filter(b => normalizeAnchorText(b.textContent ?? "").includes(frag)).length : -1;
  let _disambig = "";
  if (matches.length === 1) {
    chosen = matches[0];
    _disambig = "sole-match";
  } else if (matches.length > 1) {
    // Phase 4.2: prefer candidates under the same heading (advisory).
    if (anchor.headingHint) {
      const withHeading: HTMLElement[] = [];
      for (const m of matches) {
        const mi = blocks.indexOf(m);
        if (mi < 0) continue;
        for (let hi = mi - 1; hi >= 0; hi--) {
          if (/^H[1-6]$/.test(blocks[hi].tagName)) {
            if (normalizeAnchorText(blocks[hi].textContent ?? "") === anchor.headingHint) {
              withHeading.push(m);
            }
            break;
          }
        }
      }
      if (withHeading.length === 1) {
        chosen = withHeading[0];
        _disambig = "headingHint→sole";
      } else if (withHeading.length > 1) {
        // Narrow to heading-matched set for further disambiguation.
        while (matches.length > 0) matches.pop();
        matches.push(...withHeading);
        _disambig = "headingHint→" + withHeading.length;
        // Prefer heading elements only when the anchor text itself IS a
        // heading (matches a heading element's text). Otherwise a body-text
        // anchor inside a heading section would lose all body matches and
        // be forced onto the heading — a ~1000px positioning error.
        const headingEls = withHeading.filter(m => /^H[1-6]$/.test(m.tagName));
        if (headingEls.length > 0 && headingEls.some(h =>
            normalizeAnchorText(h.textContent ?? "") === anchor.anchorText)) {
          while (matches.length > 0) matches.pop();
          matches.push(...headingEls);
          _disambig = _disambig + "+h" + headingEls.length;
        }
      } else {
        _disambig = "headingHint→0of" + matches.length;
      }
    }

    // Disambiguate by the strongest prior available (mirrors findBestTextLine).
    if (!chosen) {
    const tops = matches.map(m => clientTopToDocY(m.getBoundingClientRect().top, previewRect.top, previewEl.scrollTop));

    // 0) Position-ratio prior — measured scrollTop/scrollHeight, not affected by
    //    RM section density unevenness, more reliable than the ledger estimate.
    if (anchor.docRatio >= 0 && previewEl.scrollHeight > 0) {
      const ratios = tops.map(t => t / previewEl.scrollHeight);
      chosen = matches[nearestIndexBy(ratios, anchor.docRatio)];
      _disambig = _disambig ? _disambig + "+ratio" : "ratio";
    }

    // 1) Nearest image row.
    if (!chosen) {
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
            expectedDocY = clientTopToDocY(eRect.top, previewRect.top, previewEl.scrollTop);
          }
        }
      }
      if (expectedDocY >= 0) {
        chosen = matches[nearestIndexBy(tops, expectedDocY)];
        _disambig = _disambig ? _disambig + "+img" : "img";
      }
    }

    // 2) anchorLine → ledger estimate (coarse proportional estimate, last resort).
    if (!chosen && ledgerY >= 0) {
      chosen = matches[nearestIndexBy(tops, ledgerY)];
      _disambig = _disambig ? _disambig + "+ledger" : "ledger";
    }
    // 3) else: no reliable prior — leave chosen null and degrade below rather
    //    than guessing matches[0] (which would jump to the document top).
    } // if (!chosen)
  }

  // ── diagnostic: text matching summary ──────────────────────────
  log.info("VIEWPORT text-match-rm", {
    frag: frag.slice(0, 40),
    anchorCtx: ctxFrag ? "yes" : "no",
    blocks: blocks.length,
    ctxHits: _ctxHits,
    singleHits: _singleHits,
    rawMatches: matches.length + (chosen ? 1 : 0), // after narrowing
    disambig: _disambig || "none",
    ledgerY: ledgerY >= 0 ? Math.round(ledgerY) : -1,
    headingHint: anchor.headingHint ? anchor.headingHint.slice(0, 30) : "",
    chosen: chosen ? normalizeAnchorText(chosen.textContent ?? "").slice(0, 40) : "(none)",
  });

  if (chosen) {
    const rect = chosen.getBoundingClientRect();
    const blockTop = clientTopToDocY(rect.top, previewRect.top, previewEl.scrollTop);

    // Only park at ledger when the DOM rect is clearly un-laid-out (transient
    // rect of zero). Otherwise trust the browser's measured position — it is
    // more precise than any estimate.
    if (rect.top === 0 && rect.bottom === 0 && ledgerY >= 0) {
      const targetY = textTargetY(ledgerY, 0, anchor.anchorOffset);
      previewEl.scrollTop = targetY;
      log.info("VIEWPORT anchor-restored", {
        mode: "preview", kind: "text-ledger-park",
        frag: frag.slice(0, 30), line: anchor.anchorLine,
        measuredTop: 0, ledgerY: Math.round(ledgerY),
        targetY: Math.round(targetY), actualY: Math.round(previewEl.scrollTop),
      });
      return true;
    }

    const targetY = textTargetY(blockTop, 0, anchor.anchorOffset);
    previewEl.scrollTop = targetY;
    log.info("VIEWPORT anchor-restored", {
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
    log.info("VIEWPORT anchor-restored", {
      mode: "preview", kind: "text-ledger-park",
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
        const eTop = clientTopToDocY(eRect.top, previewRect.top, previewEl.scrollTop);
        const targetY = anchor.nearestImgBefore > 0
          ? Math.max(0, eTop + eRect.height - anchor.anchorOffset)
          : Math.max(0, eTop - previewEl.clientHeight + anchor.anchorOffset);
        previewEl.scrollTop = targetY;
        log.info("VIEWPORT anchor-restored", {
          mode: "preview", kind: "text-degraded", refLine: line,
          targetY: Math.round(targetY), actualY: Math.round(previewEl.scrollTop),
        });
        // Return false so the early-restore poll retries text matching on the
        // next frame (degraded positioning is only a stopgap, not a success).
        return false;
      }
    }
  }
  log.info("VIEWPORT text unresolvable in RM", { frag: frag.slice(0, 30) });
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
// ── Structural improvement D: post-restore silence window ──────────────
// When the restore guard exits, the scrollTop write that triggered the guard
// may still have a scroll event queued in the browser. If that event fires
// after the guard is released, it gets treated as a valid user scroll and
// overwrites the correct anchor with whatever text happens to be at the
// forced scroll position (which could be inside a code block, frontmatter,
// etc.). A short silence window after guard exit drops these stale events.
let _lastGuardExitMs = 0;
const SILENCE_WINDOW_MS = 300;

function enterRestoreGuard(): void {
  _restoreGuardDepth++;
  if (_restoreGuardTimeoutId) clearTimeout(_restoreGuardTimeoutId);
  _restoreGuardTimeoutId = setTimeout(() => {
    log.warn("RESTORE_GUARD safety timeout — force-released");
    _restoreGuardDepth = 0;
    _lastGuardExitMs = performance.now();
  }, 2000);
}
function exitRestoreGuard(): void {
  _restoreGuardDepth = Math.max(0, _restoreGuardDepth - 1);
  if (_restoreGuardDepth === 0 && _restoreGuardTimeoutId) {
    clearTimeout(_restoreGuardTimeoutId);
    _restoreGuardTimeoutId = null;
    _lastGuardExitMs = performance.now();
  }
}
function isRestoreGuardActive(): boolean { return _restoreGuardDepth > 0; }
function isInSilenceWindow(): boolean {
  return _lastGuardExitMs > 0 && (performance.now() - _lastGuardExitMs) < SILENCE_WINDOW_MS;
}

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
      if (typeof cm.scrollIntoView === "function") {
        cm.scrollIntoView(pos, { y: "center" });
      } else {
        return false;
      }
      // CM height maps are virtual: scrollTop updates synchronously.
      // Wait one rAF for the scroll position to stabilize, then verify.
      const sd = cm.scrollDOM as HTMLElement | null;
      const before = sd?.scrollTop ?? -1;
      if (before >= 0) {
        requestAnimationFrame(() => {
          const after = sd?.scrollTop ?? -1;
          log.debug("VIEWPORT native-scroll LP", { targetLine, before: Math.round(before), after: Math.round(after) });
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
        log.debug("VIEWPORT native-scroll RM setEphemeralState", { targetLine });
        return true;
      }
      // Fall back to previewMode.applyScroll if available (Obsidian internal API).
      if (view.previewMode && typeof view.previewMode.applyScroll === "function") {
        view.previewMode.applyScroll(targetLine);
        log.debug("VIEWPORT native-scroll RM applyScroll", { targetLine });
        return true;
      }
      return false;
    }
  } catch (e) {
    // Any native-scroll exception → fall back to the legacy coarse-jump without
    // blocking the restore control flow.
    log.warn("VIEWPORT native-scroll failed", { targetLine, mode, error: String(e) });
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
      targetY = pctToScrollTop(pct, docH, viewportH);
      sd.scrollTop = targetY;
      actualY = sd.scrollTop;
    }
  } else if (mode === "preview") {
    const previewEl = getRMPreviewEl(app) as HTMLElement;
    if (previewEl && previewEl.scrollHeight > previewEl.clientHeight) {
      docH = previewEl.scrollHeight;
      viewportH = previewEl.clientHeight;
      targetY = pctToScrollTop(pct, previewEl.scrollHeight, viewportH);
      previewEl.scrollTop = targetY;
      actualY = previewEl.scrollTop;
    }
  }

  if (targetY < 0) return false; // no scroll space yet — keep the pct for retry

  setFallbackPct(-1);
  log.info("VIEWPORT fallback-restored", {
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
let _rmSuppressCount = 0;
let _rmSilenceCount = 0;
let _lpSuppressCount = 0;
let _lpSilenceCount = 0;
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
        if (anchor.anchorLine && anchor.anchorLine > 0) info.line = anchor.anchorLine;
        if (anchor.anchorContext) info.ctx = anchor.anchorContext.slice(0, 60);
        if (anchor.headingHint) info.hdg = anchor.headingHint.slice(0, 30);
        info.imgB = anchor.nearestImgBefore;
        info.imgA = anchor.nearestImgAfter;
        info.ratio = Math.round(anchor.docRatio * 100);
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
  if (side === "RM") {
    if (_rmSuppressCount > 0 || _rmSilenceCount > 0) {
      info.suppressed = _rmSuppressCount;
      info.silenced = _rmSilenceCount;
    }
    _rmSuppressCount = 0;
    _rmSilenceCount = 0;
  } else {
    if (_lpSuppressCount > 0 || _lpSilenceCount > 0) {
      info.suppressed = _lpSuppressCount;
      info.silenced = _lpSilenceCount;
    }
    _lpSuppressCount = 0;
    _lpSilenceCount = 0;
  }
  log.debug(`SCROLL ${side}`, info);
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
    if (isRestoreGuardActive()) { _rmSuppressCount++; return; }
    if (isInSilenceWindow()) { _rmSilenceCount++; return; }
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
const RM_HOLD_TIMEOUT_MS = 2000;
const RM_HOLD_CALM_FRAMES = 6; // consecutive no-correction frames = settled
let _rmHoldId: number | null = null;
let _rmHoldCleanup: (() => void) | null = null;
let _rmHoldChainId: number | null = null;
let _earlyRestoreId: number | null = null;
let _lpEarlyRestoreDone = false;
let _rmEarlyRestoreDone = false;

function cancelRMHoldChain(): void {
  if (_rmHoldChainId !== null) {
    cancelAnimationFrame(_rmHoldChainId);
    _rmHoldChainId = null;
  }
}

function cancelAllRestoreChains(): void {
  if (_rmHoldId !== null) {
    cancelAnimationFrame(_rmHoldId);
    _rmHoldId = null;
  }
  if (_rmHoldCleanup) {
    _rmHoldCleanup();
    _rmHoldCleanup = null;
  }
  if (_rmDeferredRestoreId !== null) {
    cancelAnimationFrame(_rmDeferredRestoreId);
    _rmDeferredRestoreId = null;
  }
  if (_lpDeferredRestoreId !== null) {
    cancelAnimationFrame(_lpDeferredRestoreId);
    _lpDeferredRestoreId = null;
  }
  if (_earlyRestoreId !== null) {
    cancelAnimationFrame(_earlyRestoreId);
    _earlyRestoreId = null;
  }
  cancelRMHoldChain();
}

export function startRMSettleHold(app: App, seedAnchor: ViewportAnchor): void {
  cancelAllRestoreChains();
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
  let firstCorrectionPx = 0;
  let lastCorrectionPx = 0;
  let maxDriftPx = 0;
  let firstTick = true;

  const finish = (reason: string, recapture: boolean) => {
    _rmHoldId = null;
    _rmHoldCleanup = null;
    cleanup();
    setActiveAnchor(null);
    log.info("VIEWPORT settle-hold end", {
      reason, corrections,
      firstPx: Math.round(firstCorrectionPx),
      lastPx: Math.round(lastCorrectionPx),
      maxDriftPx: Math.round(maxDriftPx),
      ms: Math.round(performance.now() - start),
      scrollTop: hookedEl ? Math.round(hookedEl.scrollTop) : -1,
    });
    if (!recapture) return;
    // Guard: if settle-hold landed at document head abnormally, the
    // captured anchor would be garbage — skip to avoid polluting the
    // RM slot and fallback percentage.
    if (hookedEl && hookedEl.scrollTop <= 0 && reason !== "stable") return;
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
      // Spurious re-render replaced the preview DOM — force re-restore
		// instead of accepting the new (possibly empty) DOM's values.
      if (hookedEl) detach(hookedEl);
      attach(el);
      hookedEl = el;
      enterRestoreGuard();
      setActiveAnchor(seedAnchor);
      restoreContentAnchor(app);
      exitRestoreGuard();
      lastTop = el.scrollTop;
      lastDocH = el.scrollHeight;
      calm = 0;
    }

    if (firstTick) {
      firstTick = false;
      if (el.scrollTop > 0) {
        // Early restore already positioned us; use current values as baseline
        // instead of re-restoring against a layout that may still be settling.
        lastTop = el.scrollTop;
        lastDocH = el.scrollHeight;
        calm++;
        _rmHoldId = requestAnimationFrame(tick);
        return;
      }
    }

    const docH = el.scrollHeight;
    const top = el.scrollTop;
    const moved = docH !== lastDocH || Math.abs(top - lastTop) > 1;
    if (moved) {
      // Track max layout drift between ticks (before correction).
      const drift = Math.abs(top - lastTop);
      if (drift > maxDriftPx) maxDriftPx = drift;

      // Layout reflowed (or an external write scrolled us) — re-pin.
      // enterRestoreGuard also refreshes the guard's 2s safety timer, so a
      // hold that keeps correcting can't be force-released mid-flight.
      enterRestoreGuard();
      setActiveAnchor(seedAnchor);
      const ok = restoreContentAnchor(app);
      if (!ok) setActiveAnchor(null); // target block mid-rerender; retry next frame
      exitRestoreGuard();
      const newTop = el.scrollTop;
      const correctionPx = Math.abs(newTop - top);
      if (correctionPx > 2) {
        if (corrections === 0) firstCorrectionPx = correctionPx;
        lastCorrectionPx = correctionPx;
        corrections++; calm = 0;
      } else calm++;
      lastTop = newTop;
      lastDocH = el.scrollHeight;
    } else {
      calm++;
    }

    if (calm >= RM_HOLD_CALM_FRAMES) { finish("stable", true); return; }
    if (performance.now() - start > RM_HOLD_TIMEOUT_MS) { finish("timeout", true); return; }
    _rmHoldId = requestAnimationFrame(tick);
  };
  log.debug("VIEWPORT settle-hold start", {
    scrollTop: Math.round(lastTop), docH: lastDocH,
  });
  _rmHoldId = requestAnimationFrame(tick);
}

function scheduleRMDeferredRestore(app: App): void {
  if (_rmDeferredRestoreId !== null) {
    cancelAnimationFrame(_rmDeferredRestoreId);
    _rmDeferredRestoreId = null;
  }
  cancelAllRestoreChains(); // a new restore session supersedes any settling hold
  rmLoopExitGuard();    // close any prior session's guard (its closure is gone)
  _rmRestoreStartTime = performance.now();
  _rmNativeTried = false;
  _rmFramesSinceNative = 0;
  let _rmLastSeenDocH = -1;
  // Stable-degraded counter: when restoreContentAnchor returns false
  // (text-degraded) and the scroller isn't moving, further retries won't help.
  let _rmStableDegraded = 0;
  let _rmLastSeenScrollTop = -1;
  const STABLE_DEGRADED_EXIT = 8;
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
      log.info("VIEWPORT deferred-restore aborted: file changed", { targetFile, curFile });
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
        // Stable-degraded exit: when restoreContentAnchor keeps returning
        // false and the scroller position isn't changing (native-scroll
        // made no progress), further retries won't help. Exit silently.
        const curScrollTop = previewEl.scrollTop;
        if (curScrollTop === _rmLastSeenScrollTop) {
          _rmStableDegraded++;
          if (_rmStableDegraded >= STABLE_DEGRADED_EXIT) {
            setActiveAnchor(null); setFallbackPct(-1);
            _rmDeferredRestoreId = null;
            _rmNativeTried = false;
            exitGuardOnce();
            return;
          }
        } else {
          _rmStableDegraded = 0;
          _rmLastSeenScrollTop = curScrollTop;
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
    if (isRestoreGuardActive()) { _lpSuppressCount++; return; }
    if (isInSilenceWindow()) { _lpSilenceCount++; return; }
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
      log.info("VIEWPORT deferred-restore aborted: file changed", { targetFile, curFile });
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

    // Guard the post-restore anchor capture: a scroll event from the restore
    // write may still be queued and would overwrite _lpLastAnchor with wrong
    // text if it fires after us. Suppress scroll-capture for 50ms so any
    // queued event lands inside the guard window.
    enterRestoreGuard();
    const anchor = captureContentAnchor(app);
    if (anchor) {
      setLPLastAnchor(anchor, view?.file?.path ?? "");
    } else {
      setLPLastAnchor(null, getLPLastAnchor().file);
    }
    setTimeout(() => exitRestoreGuard(), 50);
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
    log.debug("SWITCH probe", {
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
  cancelRMHoldChain();
  const start = performance.now();
  const hold = () => {
    _rmHoldChainId = null;
    const view = app.workspace.activeLeaf?.view as any;
    if ((view?.getMode?.() ?? "") !== "preview") return; // switched away
    if ((view?.file?.path ?? "") !== file) return;       // file changed
    // Skip frames where the RM preview DOM has no content yet
    // (post-processor may be mid-flight). Don't count these
    // against the fixed hold budget.
    const previewEl = getRMPreviewEl(app) as HTMLElement | null;
    const hasContent = previewEl && previewEl.scrollHeight > previewEl.clientHeight + 100;
    if (!hasContent && performance.now() - start < 5000) {
      _rmHoldChainId = requestAnimationFrame(hold);
      return;
    }
    const before = previewEl?.scrollTop ?? -1;
    applyEarly(app, seedAnchor, seedPct);                // override the preview revert
    if (--holdFrames > 0) {
      // If scrollTop didn't change after the assertion, the revert either
      // didn't happen or was already corrected — no need for further holds.
      const after = (getRMPreviewEl(app) as HTMLElement | null)?.scrollTop ?? -2;
      if (after === before) return;
      _rmHoldChainId = requestAnimationFrame(hold);
    }
  };
  _rmHoldChainId = requestAnimationFrame(hold);
}

/** RM→LP (source) early restore, invoked in the Promise microtask after setState
 *  resolves. CM is non-virtualized — its scrollDOM is mounted when setState
 *  resolves. CM auto-restores its own stale scroll position on mount (from the
 *  last time LP was visible), which may be hundreds of px away from where the
 *  user is currently reading. We must overwrite it BEFORE the browser composites
 *  the frame, otherwise the user sees a flash of the wrong position.
 *
 *  Strategy: write on the very first rAF where CM's scrollDOM has a non-zero
 *  clientHeight. No docH-stability wait — delaying the write just lets the stale
 *  position linger on screen longer, making the correction jump more visible.
 *  After the write, set _lpEarlyRestoreDone so handleModeSwitch won't re-seed
 *  from the RM slot; don't re-seed the anchor so the deferred restore won't
 *  issue a redundant second write. On cold CM where the anchor can't resolve,
 *  fall back to native line scroll + one rAF retry. */
function scheduleEarlyRestoreLP(app: App, fromMode: string, file: string): void {
  _lpEarlyRestoreDone = false;
  _rmEarlyRestoreDone = false;
  const src = getRMLastAnchor();
  if (!(src.file === file && src.anchor)) return;
  const seedAnchor = src.anchor;
  const seedPct = getLastFallbackPct();

  // Short-circuit: RM scrollTop was at or near the document top. No text
  // matching needed — the user was at the top in RM, they belong at the top
  // in LP. Text matching can mis-map a common first-heading phrase to a
  // later occurrence (e.g. TOC entry), producing a large downward offset.
  if (seedPct >= 0 && seedPct <= 0.02) {
    _lpEarlyRestoreDone = true;
    const sd = (app.workspace.activeLeaf?.view as any)?.editor?.cm?.scrollDOM as HTMLElement | null;
    if (sd && sd.clientHeight > 0) {
      sd.scrollTop = 0;
      log.info("VIEWPORT anchor-restored", { mode: "source", kind: "top-shortcut", targetY: 0 });
    }
    return;
  }

  if (_earlyRestoreId !== null) {
    cancelAnimationFrame(_earlyRestoreId);
    _earlyRestoreId = null;
  }

  let frames = 4;
  let nativeTried = false;
  let guardActive = false;
  // ── Structural improvement C: hard exit after consecutive degraded frames ──
  // When applyEarly falls to text-degraded (which returns false by design),
  // the poll must not retry indefinitely — each retry writes scrollTop to the
  // same position, creating visible flicker without making progress. After 5
  // consecutive degraded frames (~80ms), accept the degraded position and stop.
  let degradedFrames = 0;
  const DEGRADED_EXIT = 5;

  const exitGuardIfNeeded = () => {
    if (guardActive) { exitRestoreGuard(); guardActive = false; }
  };

  const poll = () => {
    _earlyRestoreId = null;
    const view = app.workspace.activeLeaf?.view as any;
    if ((view?.getMode?.() ?? "") !== "source") { _lpEarlyRestoreDone = true; exitGuardIfNeeded(); return; }
    if ((view?.file?.path ?? "") !== file) { _lpEarlyRestoreDone = true; exitGuardIfNeeded(); return; }
    const sc = view?.editor?.cm?.scrollDOM as HTMLElement | null;
    if (!sc || sc.clientHeight === 0) {
      if (--frames > 0) { _earlyRestoreId = requestAnimationFrame(poll); }
      else { _lpEarlyRestoreDone = true; }
      return;
    }
    // Suppress scroll events during early restore so the stale CM auto-scroll
    // (and scroll events from our forced write) cannot pollute _lpLastAnchor
    // with wrong-position text. Enter once, exit once when the poll settles.
    if (!guardActive) {
      enterRestoreGuard();
      guardActive = true;
    }
    let ok = applyEarly(app, seedAnchor, seedPct);
    // Hard-exit gate C: too many consecutive degraded frames → accept and stop.
    if (!ok) {
      degradedFrames++;
      if (degradedFrames >= DEGRADED_EXIT) {
        _lpEarlyRestoreDone = true;
        exitGuardIfNeeded();
        return;
      }
    } else {
      degradedFrames = 0;
    }
    // Multi-anchor fallback: if the primary anchor can't resolve (fragment
    // is ambiguous and spatial priors are insufficient to disambiguate),
    // try each sibling anchor captured from the same RM viewport — one of
    // them may have a more unique fragment or stronger priors.
    if (!ok && seedAnchor.kind === 'text') {
      const list = getRMLastAnchorList();
      if (list.file === file && list.anchors.length > 1) {
        for (const sibling of list.anchors) {
          if (sibling.kind !== 'text') continue;
          if (sibling.anchorText === seedAnchor.anchorText) continue;
          if (applyEarly(app, sibling, seedPct)) {
            ok = true;
            degradedFrames = 0;
            log.info('VIEWPORT anchor-fallback', {
              from: seedAnchor.anchorText.slice(0, 20),
              to: sibling.anchorText.slice(0, 20),
            });
            break;
          }
        }
      }
    }
    if (!ok && !nativeTried) {
      nativeTried = true;
      const line = anchorTargetLine(app);
      if (nativeScrollToLine(app, line)) {
        if (--frames > 0) { _earlyRestoreId = requestAnimationFrame(poll); }
        else { _lpEarlyRestoreDone = true; exitGuardIfNeeded(); }
        return;
      }
    }
    _lpEarlyRestoreDone = true;
    exitGuardIfNeeded();
    // Don't re-seed: we want the deferred restore to be a no-op (no active
    // anchor) so it won't issue a second write that looks like jitter.

    // ── Phase-2 refinement ─────────────────────────────────────────
    // CM's height map continues to build for ~100ms after display:none→visible.
    // The early write above used lb.top values that may be based on estimated
    // line heights. Schedule a deferred cross-check: once the height map
    // settles, re-compute targetY and correct the scroll position if the
    // line's block-top has shifted.
    if (ok && seedAnchor.kind === "text") {
      const saved = seedAnchor;
      setTimeout(() => {
        try {
          const v = app.workspace.activeLeaf?.view as any;
          if ((v?.getMode?.() ?? "") !== "source") return;
          if ((v?.file?.path ?? "") !== file) return;
          const cm = v?.editor?.cm;
          const sd = cm?.scrollDOM as HTMLElement | null;
          if (!sd || sd.clientHeight === 0) return;
          const line = findBestTextLine(cm, saved, file);
          if (line > 0) {
            const lb = lineBlockByNumber(cm, asLine1(line));
            const inset = lpInset(cm, sd);
            const refined = textTargetY(lb.top, inset, saved.anchorOffset);
            const drift = refined - sd.scrollTop;
            if (Math.abs(drift) > 15) {
              sd.scrollTop = refined;
              log.info("VIEWPORT lp-refined", {
                line, drift: Math.round(drift),
                capturedOffset: Math.round(saved.anchorOffset),
              });
            }
          }
        } catch { /* refinement must never throw */ }
      }, 100);
    }
  };

  _earlyRestoreId = requestAnimationFrame(poll);
}

/** Seed the active anchor from the OUTGOING mode's slot (same source as
 *  handleModeSwitch, with the same file guard), then poll rAF until the incoming
 *  view is laid out (frame N) and restore in that pre-paint frame. On RM-incoming
 *  switches, follow with a short hold loop (the RM preview reverts a single write;
 *  CM does not). Bails (letting the layout-change safety net take over) if there's
 *  nothing to restore or the geometry never settles within EARLY_RESTORE_MAX_FRAMES.
 *  Used for LP→RM only; RM→LP uses the Promise-chained scheduleEarlyRestoreLP. */
function scheduleEarlyRestore(app: App, fromMode: string, toMode: string, file: string): void {
  _lpEarlyRestoreDone = false; // reset for this new transition
  _rmEarlyRestoreDone = false;
  const src = fromMode === "preview" ? getRMLastAnchor() : getLPLastAnchor();
  if (!(src.file === file && src.anchor)) return; // nothing to restore early
  const seedAnchor = src.anchor;
  const seedPct = getLastFallbackPct();

  // Cancel any previous early restore before starting a new one.
  if (_earlyRestoreId !== null) {
    cancelAnimationFrame(_earlyRestoreId);
    _earlyRestoreId = null;
  }

  let frames = EARLY_RESTORE_MAX_FRAMES;
  let nativeTried = false;
  let guardActive = false;
  // ── Structural improvement C: hard exit after consecutive degraded frames ──
  let degradedFrames = 0;
  const DEGRADED_EXIT = 5;

  const exitGuardIfNeeded = () => {
    if (guardActive) { exitRestoreGuard(); guardActive = false; }
  };

  const poll = () => {
    _earlyRestoreId = null;
    const view = app.workspace.activeLeaf?.view as any;
    if ((view?.getMode?.() ?? "") !== toMode) { _rmEarlyRestoreDone = true; exitGuardIfNeeded(); return; }
    if ((view?.file?.path ?? "") !== file) { _rmEarlyRestoreDone = true; exitGuardIfNeeded(); return; }
    const sc = incomingScrollerOf(view, toMode);
    if (!sc || sc.clientHeight === 0) {
      if (--frames > 0) { _earlyRestoreId = requestAnimationFrame(poll); }
      else { _rmEarlyRestoreDone = true; }
      return;
    }
    // Suppress scroll events during early restore so the forced write (and any
    // stale scroller auto-restore) cannot pollute the incoming mode's anchor slot.
    if (!guardActive) {
      enterRestoreGuard();
      guardActive = true;
    }
    // frame N, pre-paint: try precise pixel restore first (cached views).
    // On cold RM render the target embeds may not exist yet — fall back to
    // native line-based scroll to force the renderer to build DOM around the
    // target, then retry. If even that fails, let layout-change handle it.
    let ok = applyEarly(app, seedAnchor, seedPct);
    // Hard-exit gate C: too many consecutive degraded frames → accept and stop.
    if (!ok) {
      degradedFrames++;
      if (degradedFrames >= DEGRADED_EXIT) {
        _rmEarlyRestoreDone = true;
        exitGuardIfNeeded();
        return;
      }
    } else {
      degradedFrames = 0;
    }
    // Multi-anchor fallback: if the primary anchor can't resolve (fragment
    // is ambiguous and spatial priors are insufficient to disambiguate),
    // try each sibling anchor captured from the same RM viewport — one of
    // them may have a more unique fragment or stronger priors.
    if (!ok && seedAnchor.kind === 'text') {
      const list = getRMLastAnchorList();
      if (list.file === file && list.anchors.length > 1) {
        for (const sibling of list.anchors) {
          if (sibling.kind !== 'text') continue;
          if (sibling.anchorText === seedAnchor.anchorText) continue;
          if (applyEarly(app, sibling, seedPct)) {
            ok = true;
            degradedFrames = 0;
            log.info('VIEWPORT anchor-fallback', {
              from: seedAnchor.anchorText.slice(0, 20),
              to: sibling.anchorText.slice(0, 20),
            });
            break;
          }
        }
      }
    }
    if (!ok && !nativeTried) {
      nativeTried = true;
      const line = anchorTargetLine(app);
      if (nativeScrollToLine(app, line)) {
        if (--frames > 0) { _earlyRestoreId = requestAnimationFrame(poll); }
        else { _rmEarlyRestoreDone = true; exitGuardIfNeeded(); }
        return;
      }
    }
    _rmEarlyRestoreDone = true;
    exitGuardIfNeeded();
    if (toMode === "preview") scheduleRMHold(app, file, seedAnchor, seedPct, RM_EARLY_HOLD_FRAMES);
  };
  _earlyRestoreId = requestAnimationFrame(poll);
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
      const inc = incomingScrollerOf(this, toMode);
      log.debug("SWITCH setState-enter", {
        t: Math.round(performance.now()),
        from: fromMode || "?", to: toMode || "?", file, isSwitch,
        incomingBuilt: !!inc, clientH: inc?.clientHeight ?? -1,
        scrollTop: inc ? Math.round(inc.scrollTop) : -1,
      });

      // ── RM DOM bloat diagnosis ──────────────────────────────────────
      // Hypothesis: RM preview DOM retains <img>/<embed> across switches,
      // and the accumulated nodes slow down CM's full-document layout when
      // it becomes visible (RM→LP).  Capture outgoing RM DOM stats for
      // correlation with the CM mount latency logged in setState-raf.
      if (isSwitch && fromMode === "preview") {
        try {
          const outgoingEl = (this?.contentEl ?? this?.containerEl) as HTMLElement | undefined;
          const rmView = outgoingEl?.querySelector(".markdown-preview-view") as HTMLElement | null;
          if (rmView) {
            const all = rmView.querySelectorAll("*");
            const imgs = rmView.querySelectorAll("img");
            const embeds = rmView.querySelectorAll("embed, iframe, .internal-embed, .image-embed");
            const totalNodes = rmView.getElementsByTagName?.("*")?.length ?? all.length;
            log.info("RM-DOM-STATS", {
              file,
              totalNodes,
              imgCount: imgs.length,
              embedCount: embeds.length,
              scrollHeight: Math.round(rmView.scrollHeight),
              clientHeight: Math.round(rmView.clientHeight),
              // ratio > 1 means virtualized content is loaded
              virtualRatio: Math.round(rmView.scrollHeight / Math.max(1, rmView.clientHeight)),
            });
          }
        } catch { /* diagnostic must never throw */ }
      }
      const self = this;
      requestAnimationFrame(() => {
        try {
          const nowMode = self?.getMode?.() ?? "?";
          const sc = incomingScrollerOf(self, nowMode);
          log.debug("SWITCH setState-raf", {
            t: Math.round(performance.now()), mode: nowMode,
            clientH: sc?.clientHeight ?? -1,
            scrollTop: sc ? Math.round(sc.scrollTop) : -1,
          });
        } catch { /* diagnostic must never throw */ }
      });
    } catch { /* diagnostic must never throw */ }

    const ret = original.call(this, state, result);
    if (isSwitch) {
      if (toMode === "source") {
        // RM→LP: CM is non-virtualized, scrollDOM is ready when setState resolves.
        // Use .then() microtask to skip the rAF wait (up to 16ms) and restore
        // before the height-map reconstruction tail grows (24→354ms with images).
        ret.then(() => {
          try { scheduleEarlyRestoreLP(app, fromMode, file); } catch { /* never break setState */ }
        });
      } else {
        // LP→RM: RM preview is virtualized, keep rAF polling.
        try { scheduleEarlyRestore(app, fromMode, toMode, file); } catch { /* never break setState */ }
      }
    }
    // Defend against spurious internal setState that re-renders the RM preview
    // from scratch, discarding our restored scroll position. Obsidian fires these
    // with mode="preview" but no file (isSwitch=false) during post-switch re-layout.
    // Snapshot the current RM scrollTop; if the reset drops it to 0, re-apply.
    if (!isSwitch && toMode === "preview") {
      const sc = incomingScrollerOf(this, "preview");
      const saved = sc?.scrollTop ?? 0;

      const rmAnchor = getRMLastAnchor().anchor;
      // Defend when scrollTop > 0 (normal snapshot), or when we have a
      // stored anchor whose scrollTop was already trashed to 0 by
      // concurrent DOM disruption (e.g. post-processor widget destroy).
      if (saved > 0 || rmAnchor) {
        ret.then(() => {
          requestAnimationFrame(() => {
            const sc2 = incomingScrollerOf(this, "preview");
            if (sc2 && sc2.scrollTop === 0 && sc2.scrollHeight > sc2.clientHeight) {
              if (saved > 0) {
                sc2.scrollTop = saved;
              } else if (rmAnchor) {
                setActiveAnchor(rmAnchor);
                restoreContentAnchor(app);
              }
              log.debug("SWITCH spurious-reset defended", { saved, hadAnchor: !!rmAnchor });
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
  cancelAllRestoreChains(); // kill any pending RM restore chains from prior switches
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
        ...(a.anchorLine && a.anchorLine > 0 ? { line: a.anchorLine } : {}),
        ...(a.anchorContext ? { ctx: a.anchorContext.slice(0, 60) } : {}),
        ...(a.headingHint ? { hdg: a.headingHint.slice(0, 30) } : {}),
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
  log.info("VIEWPORT mode-switch", {
    from: lastMode, to: mode, trigger, file,
    oldDocH: getLastDocH(), newDocH,
    docHRatio: getLastDocH() > 0 && newDocH > 0 ? Math.round(newDocH / getLastDocH() * 100) : 0,
  });
  // Flush buffered RM alignment changes on RM→LP switch so the LP
  // editor picks up the updated markdown before scroll is restored.
  if (lastMode === "preview" && mode === "source") {
    const pendingCount = getPendingAlignmentCount();
    log.info("ALIGN flush trigger: RM→LP switch", { pendingCount });
    const modified = flushPendingAlignments(app);
    log.info("ALIGN flush done", { modifiedFiles: [...modified], remaining: getPendingAlignmentCount() });
    for (const path of modified) invalidateImageRowIndex(path);
    // Immediately rebuild the index for the current file so the deferred
    // restore (which fires next) can use image-row-based disambiguation
    // instead of falling back to the unreliable cross-mode docRatio.
    if (modified.has(file)) ensureImageRowIndexFromCM(app);
  }
  // Seed the restore anchor from the OUTGOING mode's slot, so the
  // incoming view's stale-scroll noise can't hijack it.
  // When the early restore (from setState) has already handled this
  // transition, skip re-seeding to avoid a redundant second restore
  // from the deferred-restore path.
  if (lastMode === "preview" && mode === "source" && _lpEarlyRestoreDone) {
    _lpEarlyRestoreDone = false;
  } else if (lastMode === "source" && mode === "preview" && _rmEarlyRestoreDone) {
    _rmEarlyRestoreDone = false;
  } else {
    const src = lastMode === "preview" ? getRMLastAnchor() : getLPLastAnchor();
    if (src.file === file && src.anchor) {
      setActiveAnchor(src.anchor);
      // Also seed the coarse fallback percentage: the RM deferred restore uses
      // it to force-render a virtualized target region when the precise anchor
      // can't resolve yet. Cleared on the first successful precise restore.
      if (getLastFallbackPct() >= 0) setFallbackPct(getLastFallbackPct());
      log.info("VIEWPORT anchor-captured", {
        fromMode: lastMode,
        ...anchorLogFields(src.anchor),
      });
    } else if (src.file === file && getLastFallbackPct() >= 0) {
      setFallbackPct(getLastFallbackPct());
      log.info("VIEWPORT fallback-captured", { fromMode: lastMode, pct: Math.round(getLastFallbackPct() * 100) });
    }
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

  log.info("VIEWPORT", {
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
    log.info("VIEWPORT flush-start", { pendingCount: getPendingAlignmentCount() });
    const modified = flushPendingAlignments(app);
    for (const path of modified) invalidateImageRowIndex(path);
  }, 0));
}
