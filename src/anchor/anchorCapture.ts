import { App, MarkdownView } from "obsidian";
import { logger } from "../logger";
import {
  getPendingAlignmentCount, clearFlushTimer, setFlushTimer, getFlushTimer, flushPendingAlignments,
} from "../imageRender/rmAlignStore";
import {
  classifyCenter, ImageRowIndex, Line1, asLine1, buildImageRowIndex,
} from "./viewportAnchor";
import {
  clamp01, intraRowRatio, gapRatioFromGeom, imageRowTargetY, gapJunction, gapTargetY, textTargetY,
  nearestIndexBy, ledgerYForLine, ledgerTotalHeight, extrapolateLedgerY, sectionIndexEstimateY,
  LedgerSection, clientTopToDocY, scrollTopToPct, pctToScrollTop,
} from "./anchorMath";
import { assertNever } from "../utils";
import { getRMPreviewEl, queryPreviewViewIn, findEmbedByLine } from "../scrollSync/domLocators";
import { normalizeAnchorText } from "./textAnchor";
import {
  ViewportAnchor, setImageRowIndex, getImageRowIndex, invalidateImageRowIndex,
  getActiveAnchor, setActiveAnchor, getFallbackPct, setFallbackPct, getLastFallbackPct,
  setLastFallbackPct, setRMLastAnchor, getRMLastAnchor, setLPLastAnchor, getLPLastAnchor,
  getLastMode, setLastMode, getLastDocH, setLastDocH, getImageLineRe,
  setRMLastAnchorList, getRMLastAnchorList,
  state,
  MIN_ANCHOR_TEXT_LEN,
  TABLE_ROW_RE,
  TABLE_SPLIT_RE,
  BOX_DRAWING_RE,
  _sectionSnapshot,
  _snapshotLineCount,
  LEDGER_DOCH_TOLERANCE,
  LEDGER_PARK_TOL_MIN,
  LEDGER_PARK_TOL_FRAC,
  RATIO_GATE_TOL,
  ENABLE_NATIVE_SCROLL,
  SILENCE_WINDOW_MS,
  RM_RESTORE_TIMEOUT_MS,
  NATIVE_RETRY_INTERVAL,
  RM_HOLD_TIMEOUT_MS,
  RM_HOLD_CALM_FRAMES,
  EARLY_RESTORE_MAX_FRAMES,
  RM_EARLY_HOLD_FRAMES,
  getRMDeferredRestoreId,
  rmLoopEnterGuard,
  cancelAllRestoreChains,
  applySnapshotLineDelta,
  setLastAnchor,
  rmLoopExitGuard,
  enterRestoreGuard,
  setSectionSnapshot,
  exitRestoreGuard,
  isRestoreGuardActive,
  isInSilenceWindow,
  cancelRMHoldChain,
  getScrollAnchor,
  cancelRMDeferredRestore,
} from "./anchorStore";

const log = logger.channel("scrollAnchor");


// ── anchorCapture (extracted from scrollAnchor.ts in P3 split) ──

export function ensureImageRowIndexFromCM(app: App): void {
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


export function clampRatioWarn(raw: number, where: string): number {
  const c = clamp01(raw);
  if (raw !== c) {
    log.warn("VIEWPORT ratio out of range", { where, raw: Math.round(raw * 1000) / 1000 });
  }
  return c;
}

/** CodeMirror line block by 1-based line number (correct API usage:
 *  lineBlockAt expects a character position, not a line number). */


export function lineBlockByNumber(cm: any, lineNo: Line1): any {
  const clamped = Math.max(1, Math.min(cm.state.doc.lines, lineNo));
  return cm.lineBlockAt(cm.state.doc.line(clamped).from);
}

/** Screen-space inset of CodeMirror block-coordinate 0 from the scroller's top
 *  edge, normalized to scrollTop=0. `blockInfo.top` is relative to `.cm-content`,
 *  which sits below Obsidian's inline title / properties inside `.cm-scroller`,
 *  so this inset must be added to convert block coords into true on-screen
 *  offsets that match RM's getBoundingClientRect-based measurements.
 *  Returns 0 when `documentTop` is unavailable (degrades to prior behavior). */


export function lpInset(cm: any, sd: HTMLElement): number {
  const docTop = cm?.documentTop;
  if (typeof docTop !== "number") return 0;
  return docTop - sd.getBoundingClientRect().top + sd.scrollTop;
}



export function nearestImgRowsByLine(
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


export function rmTextBlocks(previewEl: HTMLElement): HTMLElement[] {
  const els = Array.from(
    previewEl.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, .callout-title")
  ) as HTMLElement[];
  return els.filter(
    (e) => !e.closest(".internal-embed") && (e.textContent?.trim().length ?? 0) > 0
  );
}

/** Build a CSS selector matching all embeds whose data-diaa-line falls
 *  within an image row's source line range. */


export function imgIndexToSelector(imgRow: ImageRowIndex): string {
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


export function extractCandidates(
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



export function captureAnchorLP(app: App, filePath: string): ViewportAnchor | null {
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



export function captureAnchorRM(app: App, filePath: string): ViewportAnchor | null {
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



export function nearestImgRowsRM(
  previewEl: HTMLElement,
  imgIndex: ImageRowIndex[] | undefined,
  previewRect: DOMRect,
  blockTopDoc: number,
): { before: number; after: number } {
  let before = 0, after = 0;
  if (imgIndex) {
    for (const r of imgIndex) {
      const embed = findEmbedByLine(previewEl, r.startLine);
      if (!embed) continue;
      const eRect = embed.getBoundingClientRect();
      const eTop = clientTopToDocY(eRect.top, previewRect.top, previewEl.scrollTop);
      if (eTop < blockTopDoc) before = r.index;
      else if (after === 0) after = r.index;
    }
  }
  return { before, after };
}



export function rmRowBounds(
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



export function captureImageRowRM(
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


export function findBestTextLine(
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



export function rmLedgerYForLine(app: App, line1: number, file?: string, totalLines?: number): number {
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



export function anchorTargetLine(app: App): number {
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


export function computeDocH(app: App, mode: string): number {
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


