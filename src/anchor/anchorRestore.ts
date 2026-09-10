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


import {
  ensureImageRowIndexFromCM,
  clampRatioWarn,
  lineBlockByNumber,
  lpInset,
  nearestImgRowsByLine,
  rmTextBlocks,
  imgIndexToSelector,
  computeScrollPct,
  captureContentAnchor,
  extractCandidates,
  captureAnchorLP,
  captureAnchorRM,
  nearestImgRowsRM,
  rmRowBounds,
  captureImageRowRM,
  findBestTextLine,
  rmLedgerYForLine,
  anchorTargetLine,
  computeDocH,
} from "./anchorCapture";

// ── anchorRestore (extracted from scrollAnchor.ts in P3 split) ──

export function scheduleRestoreAccuracyCheck(
  app: App, mode: string, anchor: ViewportAnchor, kind: string,
  restoreScrollTop: number, restoreDocH: number,
): void {
  if (state._accuracyTimer) clearTimeout(state._accuracyTimer);
  const capturedDocRatio = anchor.kind === "text" ? anchor.docRatio : -1;
  const expectedOffset = anchor.kind === "text" ? anchor.anchorOffset : -1;
  const frag = anchor.kind === "text" ? anchor.anchorText.slice(0, 40) : "";
  state._accuracyTimer = setTimeout(() => {
    state._accuracyTimer = null;
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



export function restoreImageRowInLP(
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



export function restoreImageRowInRM(
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



export function restoreImageGapInLP(
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



export function restoreImageGapInRM(
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



export function restoreTextInLP(
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


export function restoreTextInRM(
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

  log.debug("VIEWPORT ledger debug: restoreTextInRM about to call rmLedgerYForLine", {
    anchorLine: anchor.anchorLine, anchorTotalLines: anchor.totalLines, filePath,
  });
  const ledgerY = anchor.anchorLine && anchor.anchorLine > 0
    ? rmLedgerYForLine(app, anchor.anchorLine, filePath, anchor.totalLines)
    : -1;
  log.debug("VIEWPORT ledger debug: rmLedgerYForLine returned", { ledgerY: Math.round(ledgerY) });

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
          const embed = findEmbedByLine(previewEl, r.startLine);
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
      const embed = findEmbedByLine(previewEl, line);
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



export function nativeScrollToLine(app: App, targetLine: number): boolean {
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



