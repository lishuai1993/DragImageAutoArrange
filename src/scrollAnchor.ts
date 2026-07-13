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
// Content-based anchor system with three tiers (priority order):
//   1. image-row  – viewport center lands inside an image row; uses
//      global image-row index + intra-row ratio (mode-independent).
//   2. text-search – viewport center is in a text region; uses a
//      text fragment + nearest image row indices for cross-mode search.
//   3. line-fallback – degraded fallback using source line number.

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

type ContentAnchorV2 =
	| { kind: "image-row"; imageRowIndex: number; intraRowRatio: number }
	| { kind: "text-search"; textFragment: string; nearestImgBefore: number; nearestImgAfter: number }
	| { kind: "line-fallback"; line: number; pixelOffset: number };

let _scrollAnchor: ContentAnchorV2 | null = null;
let _lastAnchor: ContentAnchorV2 | null = null;
let _lastAnchorFile = "";

// Fallback scroll percentage for regions without any image embeds.
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

export function getScrollAnchor(): ContentAnchorV2 | null {
	return _scrollAnchor;
}

function setScrollAnchor(a: ContentAnchorV2 | null): void {
	_scrollAnchor = a;
}

export function getFallbackPct(): number {
	return _fallbackPct;
}

function setFallbackPct(pct: number): void {
	_fallbackPct = pct;
}

export function setLastAnchor(anchor: ContentAnchorV2 | null, file: string): void {
	_lastAnchor = anchor;
	_lastAnchorFile = file;
}

export function setLastFallbackPct(pct: number): void {
	_lastFallbackPct = pct;
}

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

export function captureContentAnchor(app: App): ContentAnchorV2 | null {
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

function captureAnchorLP(app: App, filePath: string): ContentAnchorV2 | null {
  const view = (app.workspace.activeLeaf?.view as any);
  const cm = view.editor?.cm;
  const sd = cm?.scrollDOM;
  if (!sd || sd.clientHeight === 0) return null;

  ensureImageRowIndexFromCM(app);
  const imgIndex = getImageRowIndex(filePath);
  const viewportCenterY = sd.scrollTop + sd.clientHeight / 2;
  const totalLines = cm.state.doc.lines;
  const imgRe = /!\[\[.*\.(?:png|jpg|jpeg|gif|webp|svg|bmp|avif)/i;

  // Find the line at viewport center
  let centerLine = 1;
  let centerLb = cm.lineBlockAt(1);
  for (let i = 1; i <= totalLines; i++) {
    const lb = cm.lineBlockAt(i);
    if (lb.top <= viewportCenterY && lb.top + lb.height > viewportCenterY) {
      centerLine = i;
      centerLb = lb;
      break;
    }
  }

  // Check if centerLine belongs to an image row
  if (imgIndex) {
    const imgRow = imgIndex.find(r => centerLine >= r.startLine && centerLine <= r.endLine);
    if (imgRow) {
      const startLb = cm.lineBlockAt(imgRow.startLine);
      const endLb = cm.lineBlockAt(imgRow.endLine);
      const rowTop = startLb.top;
      const rowBottom = endLb.top + endLb.height;
      const rowH = rowBottom - rowTop;
      const ratio = rowH > 0 ? Math.max(0, Math.min(1, (viewportCenterY - rowTop) / rowH)) : 0.5;
      return { kind: "image-row", imageRowIndex: imgRow.index, intraRowRatio: ratio };
    }
  }

  // Text region: capture fragment + nearest image row indices
  const lineText = cm.state.doc.line(centerLine).text.trim();
  if (lineText) {
    let nearestBefore = 0, nearestAfter = 0;
    if (imgIndex) {
      for (const r of imgIndex) {
        if (r.endLine < centerLine) nearestBefore = r.index;
        if (r.startLine > centerLine && nearestAfter === 0) nearestAfter = r.index;
      }
    }
    return {
      kind: "text-search",
      textFragment: lineText.slice(0, 80),
      nearestImgBefore: nearestBefore,
      nearestImgAfter: nearestAfter,
    };
  }

  // Pure blank line: fall back to line-based
  return {
    kind: "line-fallback",
    line: centerLine,
    pixelOffset: viewportCenterY - centerLb.top,
  };
}

// ── RM (preview) anchor capture ───────────────────────

function captureAnchorRM(app: App, filePath: string): ContentAnchorV2 | null {
  const previewEl = document.querySelector(".markdown-preview-view") as HTMLElement;
  if (!previewEl || previewEl.clientHeight === 0) return null;

  const previewRect = previewEl.getBoundingClientRect();
  const viewportCenterY = previewEl.scrollTop + previewEl.clientHeight / 2;
  const embeds = previewEl.querySelectorAll(".internal-embed[data-diaa-line]");
  const imgIndex = getImageRowIndex(filePath);

  // Find closest image embed to viewport center
  let bestLine = 0, bestDist = Infinity, bestEmbedTop = 0, bestEmbedH = 0;

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
      bestEmbedTop = embedTop;
      bestEmbedH = rect.height;
    }
  }

  if (bestLine > 0 && imgIndex) {
    const imgRow = imgIndex.find(r => bestLine >= r.startLine && bestLine <= r.endLine);
    if (imgRow) {
      // Find the full image row pixel bounds in RM
      const rowEmbeds = previewEl.querySelectorAll(
        imgIndexToSelector(imgRow)
      );
      if (rowEmbeds.length > 0) {
        let rowTop = Infinity, rowBottom = -Infinity;
        for (const re of rowEmbeds) {
          const r = re.getBoundingClientRect();
          const t = r.top - previewRect.top + previewEl.scrollTop;
          const b = t + r.height;
          if (t < rowTop) rowTop = t;
          if (b > rowBottom) rowBottom = b;
        }
        const rowH = rowBottom - rowTop;
        const ratio = rowH > 0 ? Math.max(0, Math.min(1, (viewportCenterY - rowTop) / rowH)) : 0.5;
        return { kind: "image-row", imageRowIndex: imgRow.index, intraRowRatio: ratio };
      }
    }
  }

  // No image row at viewport center — try text fragment from DOM
  const cx = previewRect.left + previewRect.width / 2;
  const cy = previewRect.top + previewEl.clientHeight / 2;
  const elAtCenter = document.elementFromPoint(cx, cy);
  const textContent = elAtCenter?.textContent?.trim().slice(0, 80) ?? "";

  if (textContent && imgIndex) {
    let nearestBefore = 0, nearestAfter = 0;
    for (const r of imgIndex) {
      const re = previewEl.querySelector(`.internal-embed[data-diaa-line="${r.startLine}"]`) as HTMLElement;
      if (re) {
        const rect = re.getBoundingClientRect();
        const embedTop = rect.top - previewRect.top + previewEl.scrollTop;
        if (embedTop < viewportCenterY) nearestBefore = r.index;
        if (embedTop > viewportCenterY && nearestAfter === 0) nearestAfter = r.index;
      }
    }
    return {
      kind: "text-search",
      textFragment: textContent,
      nearestImgBefore: nearestBefore,
      nearestImgAfter: nearestAfter,
    };
  }

  // Fallback
  if (bestLine > 0) {
    return { kind: "line-fallback", line: bestLine, pixelOffset: viewportCenterY - bestEmbedTop };
  }
  return null;
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

export function restoreContentAnchor(app: App): void {
  if (!_scrollAnchor) return;
  const anchor = _scrollAnchor;
  _scrollAnchor = null;

  const leaf = app.workspace.activeLeaf;
  const view = (leaf?.view as any);
  const mode = view?.getMode?.() ?? "";
  const filePath = view?.file?.path ?? "";

  if (anchor.kind === "image-row") {
    restoreImageRowAnchor(app, mode, filePath, anchor.imageRowIndex, anchor.intraRowRatio);
  } else if (anchor.kind === "text-search") {
    restoreTextSearchAnchor(app, mode, filePath, anchor);
  } else {
    restoreLineFallbackAnchor(app, mode, anchor.line, anchor.pixelOffset);
  }
}

// ── image-row restore ──────────────────────────────────

function restoreImageRowAnchor(
  app: App, mode: string, filePath: string,
  imageRowIndex: number, intraRowRatio: number,
): void {
  if (mode === "source") {
    restoreImageRowInLP(app, filePath, imageRowIndex, intraRowRatio);
  } else if (mode === "preview") {
    restoreImageRowInRM(app, filePath, imageRowIndex, intraRowRatio);
  }
}

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

  const startLb = cm.lineBlockAt(imgRow.startLine);
  const endLb = cm.lineBlockAt(imgRow.endLine);
  const rowTop = startLb.top;
  const rowBottom = endLb.top + endLb.height;
  const targetY = Math.max(0, rowTop + (rowBottom - rowTop) * intraRowRatio - sd.clientHeight / 2);
  sd.scrollTop = targetY;

  logger.info("VIEWPORT anchor-restored", {
    mode: "source", kind: "image-row", imageRowIndex,
    ratio: Math.round(intraRowRatio * 100),
    rowTop: Math.round(rowTop), rowH: Math.round(rowBottom - rowTop),
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

  // Collect all embeds belonging to this image row
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

// ── text-search restore ────────────────────────────────

function restoreTextSearchAnchor(
  app: App, mode: string, filePath: string,
  anchor: Extract<ContentAnchorV2, { kind: "text-search" }>,
): void {
  if (mode === "source") {
    restoreTextSearchInLP(app, filePath, anchor);
  } else {
    restoreTextSearchInRM(app, filePath, anchor);
  }
}

function restoreTextSearchInLP(
  app: App, filePath: string,
  anchor: Extract<ContentAnchorV2, { kind: "text-search" }>,
): void {
  const view = (app.workspace.activeLeaf?.view as any);
  const cm = view.editor?.cm;
  const sd = cm?.scrollDOM;
  if (!sd || sd.clientHeight === 0) return;

  const docText = cm.state.doc.toString();
  let idx = docText.indexOf(anchor.textFragment);

  // If multiple occurrences, use nearest image rows to pick the right one
  if (idx >= 0) {
    const secondIdx = docText.indexOf(anchor.textFragment, idx + 1);
    if (secondIdx >= 0 && anchor.nearestImgBefore > 0) {
      const imgIndex = getImageRowIndex(filePath);
      const targetRow = imgIndex?.find(r => r.index === anchor.nearestImgBefore);
      if (targetRow) {
        const targetLine = targetRow.endLine + 1;
        let pos = 0, bestPos = -1, bestDist = Infinity;
        while ((pos = docText.indexOf(anchor.textFragment, pos)) >= 0) {
          const matchLine = cm.state.doc.lineAt(pos).number;
          const dist = Math.abs(matchLine - targetLine);
          if (dist < bestDist) { bestDist = dist; bestPos = pos; }
          pos++;
        }
        if (bestPos >= 0) idx = bestPos;
      }
    }
  }

  if (idx >= 0) {
    const line = cm.state.doc.lineAt(idx).number;
    const lb = cm.lineBlockAt(line);
    const targetY = Math.max(0, lb.top + lb.height / 2 - sd.clientHeight / 2);
    sd.scrollTop = targetY;

    logger.info("VIEWPORT anchor-restored", {
      mode: "source", kind: "text-search", line,
      textFragment: anchor.textFragment.slice(0, 30),
      targetY: Math.round(targetY), actualY: Math.round(sd.scrollTop),
    });
    return;
  }

  // Text not found — degrade to line-fallback using nearest image row
  logger.info("VIEWPORT text-search miss, degrading", {
    textFragment: anchor.textFragment.slice(0, 30),
  });
  if (anchor.nearestImgBefore > 0) {
    const imgIndex = getImageRowIndex(filePath);
    const imgRow = imgIndex?.find(r => r.index === anchor.nearestImgBefore);
    if (imgRow) {
      const lb = cm.lineBlockAt(imgRow.endLine + 1);
      const targetY = Math.max(0, lb.top + 30 - sd.clientHeight / 2);
      sd.scrollTop = targetY;
    }
  }
}

function restoreTextSearchInRM(
  app: App, filePath: string,
  anchor: Extract<ContentAnchorV2, { kind: "text-search" }>,
): void {
  const previewEl = document.querySelector(".markdown-preview-view") as HTMLElement;
  if (!previewEl || previewEl.clientHeight === 0) return;

  if (anchor.nearestImgBefore > 0 || anchor.nearestImgAfter > 0) {
    const imgIndex = getImageRowIndex(filePath);
    const refIdx = anchor.nearestImgBefore > 0 ? anchor.nearestImgBefore : anchor.nearestImgAfter;
    const imgRow = imgIndex?.find(r => r.index === refIdx);
    if (imgRow) {
      const startLine = anchor.nearestImgBefore > 0 ? imgRow.endLine : imgRow.startLine;
      const refEmbed = previewEl.querySelector(`.internal-embed[data-diaa-line="${startLine}"]`) as HTMLElement;
      if (refEmbed) {
        const previewRect = previewEl.getBoundingClientRect();
        const refRect = refEmbed.getBoundingClientRect();
        const refTop = refRect.top - previewRect.top + previewEl.scrollTop;
        const targetY = Math.max(0, refTop + (anchor.nearestImgBefore > 0 ? refRect.height + 40 : -40));
        previewEl.scrollTop = targetY;

        logger.info("VIEWPORT anchor-restored", {
          mode: "preview", kind: "text-search-degraded", refLine: startLine,
          targetY: Math.round(targetY), actualY: Math.round(previewEl.scrollTop),
        });
        return;
      }
    }
  }

  logger.info("VIEWPORT text-search unresolvable in RM");
}

// ── line-fallback restore (original behavior) ─────────

function restoreLineFallbackAnchor(app: App, mode: string, line: number, pixelOffset: number): void {
  if (mode === "source") {
    const view = (app.workspace.activeLeaf?.view as any);
    const cm = view.editor?.cm;
    const sd = cm?.scrollDOM;
    if (!sd || sd.clientHeight === 0) return;

    const lb = cm.lineBlockAt(line);
    const targetY = Math.max(0, lb.top + pixelOffset - sd.clientHeight / 2);
    sd.scrollTop = targetY;

    logger.info("VIEWPORT anchor-restored", {
      mode, kind: "line-fallback", line, offset: Math.round(pixelOffset),
      lineTop: Math.round(lb.top), targetY: Math.round(targetY),
      actualY: Math.round(sd.scrollTop),
    });
  } else if (mode === "preview") {
    const previewEl = document.querySelector(".markdown-preview-view") as HTMLElement;
    if (!previewEl || previewEl.clientHeight === 0) return;

    const embed = previewEl.querySelector(`.internal-embed[data-diaa-line="${line}"]`) as HTMLElement;
    if (!embed) {
      logger.info("VIEWPORT anchor-restore skip", { reason: "embed not found", line });
      return;
    }

    const previewRect = previewEl.getBoundingClientRect();
    const embedRect = embed.getBoundingClientRect();
    const embedTop = embedRect.top - previewRect.top + previewEl.scrollTop;
    const targetY = Math.max(0, embedTop + pixelOffset - previewEl.clientHeight / 2);
    previewEl.scrollTop = targetY;

    logger.info("VIEWPORT anchor-restored", {
      mode, kind: "line-fallback", line, offset: Math.round(pixelOffset),
      embedTop: Math.round(embedTop), targetY: Math.round(targetY),
      actualY: Math.round(previewEl.scrollTop),
    });
  }
}

// Legacy percentage-based restore kept as fallback for text-only regions.
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
			_lastAnchor = anchor;
			_lastAnchorFile = (_app.workspace.activeLeaf?.view as any)?.file?.path ?? "";
		}
		const pct = computeScrollPct(_app);
		if (pct >= 0) _lastFallbackPct = pct;
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
			_lastAnchor = anchor;
			_lastAnchorFile = (app.workspace.activeLeaf?.view as any)?.file?.path ?? "";
		}
		const pct = computeScrollPct(app);
		if (pct >= 0) _lastFallbackPct = pct;
		logViewportState(app, "rm-after-restore");
	};
	_rmDeferredRestoreId = requestAnimationFrame(attempt);
}

// ── LP scroll tracking ─────────────────────────────────────────────

let _lpScrollCleanup: (() => void) | null = null;

function ensureLPScrollTracking(app: App): void {
	if (_lpScrollCleanup) return;

	const cm = (app.workspace.activeLeaf?.view as any)?.editor?.cm;
	const sd = cm?.scrollDOM as HTMLElement | null;
	if (!sd) return;

	const onScroll = () => {
		const anchor = captureContentAnchor(app);
		if (anchor) {
			_lastAnchor = anchor;
			_lastAnchorFile = (app.workspace.activeLeaf?.view as any)?.file?.path ?? "";
		}
		const pct = computeScrollPct(app);
		if (pct >= 0) _lastFallbackPct = pct;
	};

	sd.addEventListener("scroll", onScroll, { passive: true });
	_lpScrollCleanup = () => {
		sd.removeEventListener("scroll", onScroll);
		_lpScrollCleanup = null;
	};
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
    if (_lastAnchorFile === file && _lastAnchor) {
      _scrollAnchor = _lastAnchor;
      logger.info("VIEWPORT anchor-captured", {
        fromMode: _lastMode,
        kind: _lastAnchor.kind,
        ...(_lastAnchor.kind === "image-row" ? {
          imageRowIndex: _lastAnchor.imageRowIndex,
          ratio: Math.round(_lastAnchor.intraRowRatio * 100),
        } : _lastAnchor.kind === "text-search" ? {
          textFragment: _lastAnchor.textFragment.slice(0, 30),
          nearestBefore: _lastAnchor.nearestImgBefore,
          nearestAfter: _lastAnchor.nearestImgAfter,
        } : {
          line: (_lastAnchor as any).line,
          offset: Math.round((_lastAnchor as any).pixelOffset),
        }),
      });
    } else if (_lastAnchorFile === file && _lastFallbackPct >= 0) {
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
        if (/!\[\[.*\.(?:png|jpg|jpeg|gif|webp|svg|bmp|avif)/i.test(line.text)) {
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
