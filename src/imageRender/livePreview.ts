import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import {
  RangeSetBuilder,
  StateField,
  StateEffect,
  Prec,
  Annotation,
} from "@codemirror/state";
import { editorLivePreviewField } from "obsidian";
import { detectRowGroups } from "../imageParse/imageDetector";
import type { RowGroup } from "../imageParse/imageDetector";
import { write as writeRowImage } from "../imageParse/rowParams";
import type { RowImage, Alignment } from "../imageParse/rowParams";
import { ImageRowWidget, ImageRowOptions, getSidebarWidths } from "./imageRowWidget";
import { DragImageSettings } from "../settings";
import { CLASSES } from "../constants";
import { computeFlexGrowsFromWidths } from "../imageLayout/layoutEngine";
import { logger } from "../logger";
const log = logger.channel("livePreview");
import { clampFlexGrow, clampScale, quantizeSizing } from "../imageLayout/parameterValidator";
import { stripEmbedParams, parseEmbedParams, embedParamString, stripSizingKeepOrientation } from "../imageParse/embedRaw";
import { IDENTITY_STATE, isOrientationWord, parseOrientationWord } from "../imageTransform/orientation";
import * as scrollDiag from "../scrollSync/scrollDiag";
import { createDragGhost, applyDropIndicator } from "./rowRenderer";

/**
 * Parse the file path from an obsidian://open URI and search ALL document lines
 * for a matching image embed. Returns the 0-indexed line number, or null.
 */
/**
 * Parse the file path from an obsidian://open URI and search the document
 * for the corresponding standalone image line (not part of the target group).
 */
function findStandaloneImageLine(
  view: EditorView,
  obsidianUri: string,
  targetGroup: RowGroup
): number | null {
  try {
    // Decode the file parameter from obsidian://open?vault=...&file=<encodedPath>
    const match = obsidianUri.match(/[?&]file=([^&]+)/);
    if (!match) return null;

    const encodedPath = match[1];
    const filePath = decodeURIComponent(encodedPath);
    // Extract just the filename (last segment after last /)
    const fileName = filePath.split("/").pop();
    if (!fileName) return null;

    log.debug("findStandaloneImageLine parsing URI", {
      encodedPath,
      fileName,
    });

    const doc = view.state.doc;
    const groupLines = new Set<number>();
    for (let g = targetGroup.lineStart; g < targetGroup.lineEnd; g++) {
      groupLines.add(g);
    }

    // Search for ![[...fileName]] lines that are not in the target group
    for (let i = 1; i <= doc.lines; i++) {
      if (groupLines.has(i - 1)) continue; // 0-indexed
      const lineText = doc.line(i).text;
      // Check if this line references the same file
      if (lineText.includes(fileName) && /^[\s]*!\[\[/.test(lineText)) {
        log.debug("findStandaloneImageLine found", { line: i - 1, lineText: lineText.substring(0, 60) });
        return i - 1; // 0-indexed
      }
    }
    return null;
  } catch (e) {
    log.error("findStandaloneImageLine error", { error: String(e) });
    return null;
  }
}

/**
 * Resolve the source line index from a drag dataTransfer payload.
 * Supports:
 *   "diaa-row:<lineStart>:<index>"   — flex row source
 *   "diaa-standalone:<lineNumber>"   — standalone source (intercepted at dragstart)
 *   "obsidian://open..."             — fallback standalone source (legacy)
 */
function resolveSourceLine(
  view: EditorView,
  dataTransfer: string,
  targetGroup: RowGroup
): number | null {
  const rowMatch = dataTransfer.match(/^diaa-row:(\d+):(\d+)$/);
  if (rowMatch) {
    return parseInt(rowMatch[1], 10) + parseInt(rowMatch[2], 10);
  }
  const standaloneMatch = dataTransfer.match(/^diaa-standalone:(\d+)$/);
  if (standaloneMatch) {
    return parseInt(standaloneMatch[1], 10);
  }
  if (dataTransfer.startsWith("obsidian://open")) {
    return findStandaloneImageLine(view, dataTransfer, targetGroup);
  }
  return null;
}

/**
 * Move one document line from srcLine to targetLine.
 * Uses a single range replacement (same pattern as intra-row reorder)
 * to avoid sequential-adjustment issues with two CodeMirror changes.
 */
function moveLine(view: EditorView, srcLine: number, targetLine: number): void {
  if (srcLine === targetLine) return;

  const doc = view.state.doc;

  const minLine = Math.min(srcLine, targetLine);
  const maxLine = Math.max(srcLine, targetLine);

  const fromPos = doc.line(minLine + 1).from;
  const maxLineNum = maxLine + 1; // 1-indexed
  const toPos = maxLineNum + 1 <= doc.lines
    ? doc.line(maxLineNum + 1).from
    : doc.length;

  const originalText = doc.sliceString(fromPos, toPos);
  const originalLines = originalText.split("\n");
  const hadTrailingNewline = originalText.endsWith("\n");
  if (hadTrailingNewline && originalLines.length > 0) {
    originalLines.pop(); // remove empty last entry from trailing \n
  }

  const localSrc = srcLine - minLine;
  const localTarget = targetLine - minLine;

  const [moved] = originalLines.splice(localSrc, 1);
  // When source is before target, the target index shifts left by one
  // after the source line is removed.
  const insertAt = localSrc < localTarget ? localTarget - 1 : localTarget;
  originalLines.splice(insertAt, 0, moved);

  const insert = originalLines.join("\n") + (hadTrailingNewline ? "\n" : "");

  log.info("LivePreview moveLine", {
    srcLine, targetLine, minLine, maxLine,
    fromPos, toPos,
    lineCount: originalLines.length + 1,
  });

  view.dispatch({
    changes: { from: fromPos, to: toPos, insert },
  });
}

/**
 * Immediately convert any "orphaned" single-image line to a bare `![[file]]`.
 * A single-image row is "clean" only as `![[file|S|W]]` with S ∈ {0,1}; a line
 * that just left a multi-image row still carries `|W|S` (first param is a weight
 * ≥ 2) and would be mis-read under single-image semantics.  Stripping it to bare
 * at drop time makes the identity transition (multi member → single) explicit,
 * so the rebuilt single widget re-derives the setting-driven width.  Idempotent.
 */
function convertOrphanedMultiSinglesToBare(
  view: EditorView,
  maxImagesPerRow: number,
  extensions: string
): void {
  const doc = view.state.doc;
  const groups = detectRowGroups(doc.toString(), maxImagesPerRow, extensions);
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  for (const g of groups) {
    if (g.kind !== "single") continue;
    const lineNum = g.images[0].line + 1;
    if (lineNum < 1 || lineNum > doc.lines) continue;
    const lineObj = doc.line(lineNum);
    const raw = lineObj.text;
    const parts = parseEmbedParams(raw);
    if (!parts) continue; // already bare
    const ALIGNMENTS = new Set(["left", "center", "right"]);
    let offset = isOrientationWord(parts[0]) ? 1 : 0;
    if (ALIGNMENTS.has(parts[offset])) offset += 1;
    const first = parseInt(parts[offset], 10);
    // Clean single `|S|W` or `|orientation|alignment|S|W` (S ∈ {0,1}) → untouched.
    if (parts.length > offset + 1 && (first === 0 || first === 1)) continue;
    // Sizing describes the row being left; an orientation stays with the image.
    const bare = stripSizingKeepOrientation(raw);
    if (bare !== raw) {
      changes.push({ from: lineObj.from, to: lineObj.from + raw.length, insert: bare });
    }
  }
  if (changes.length === 0) return;
  changes.sort((a, b) => b.from - a.from);
  view.dispatch({ changes });
}

/**
 * Measure the current rendered pixel width of every item in a rendered flex row.
 * Locates the row container by its `data-line-start` attribute and reads each
 * `.diaa-item` child in document (index) order.  Returns null if the row
 * isn't currently rendered.
 */
function measureItemWidths(view: EditorView, rowLineStart: number): number[] | null {
  const container = view.dom.querySelector<HTMLElement>(
    `.${CLASSES.row}[data-line-start="${rowLineStart}"]`
  );
  if (!container) return null;
  const items = container.querySelectorAll<HTMLElement>(`.${CLASSES.imageItem}`);
  if (items.length === 0) return null;
  return Array.from(items).map((el) => el.getBoundingClientRect().width);
}

/**
 * Extract the persisted scale (second |param, ×100) from an image embed line.
 * `![[a.webp|740|48]]` → 0.48; `![[a.webp|740]]` / `![[a.webp]]` → null.
 */
function parseScaleFromRaw(raw: string): number | null {
  const parts = parseEmbedParams(raw);
  if (!parts) return null;
  // Drop the orientation word first: it is not a sizing component, so counting
  // it would make a lone share code look like a share+scale pair.
  const sizing = isOrientationWord(parts[0]) ? parts.slice(1) : parts;
  if (sizing.length < 2) return null;
  const v = parseInt(sizing[sizing.length - 1], 10);
  return isFinite(v) && v > 0 ? v / 100 : null;
}


/**
 * CodeMirror Widget that renders a flex row of images with interactive features.
 */
/** Strip everything between the first | and ]] so widget equality ignores
 * width/dimension metadata — only the image file name matters for identity. */
export function normalizeRaw(raw: string): string {
  return stripEmbedParams(raw);
}

/** Write flex-grow values back to markdown as ![[file|width]].
 *  Extracted so it can be called both synchronously (legacy) and deferred
 *  via setTimeout (from destroy, where view.dispatch is illegal).
 *  Exported for the persist-decisions test (no-op detection is load-bearing). */
export function applyFlexGrowChanges(
  view: EditorView,
  images: RowImage[],
  grows: number[],
  scales?: (number | null)[],
  defaultAlignment?: "left" | "center" | "right"
): void {
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  for (let i = 0; i < grows.length && i < images.length; i++) {
    const img = images[i];
    if (img.display.kind !== "multi") continue;
    const fill = scales ? scales[i] : img.display.fill;
    const edited: RowImage = {
      ...img,
      alignment: img.alignment ?? defaultAlignment,
      display: {
        kind: "multi",
        // Rounded onto the persisted grid here, at the single funnel every
        // share write passes through: what the file records is then exactly
        // what the next render pass parses back, so a drag's continuous value
        // cannot leave the row a pixel off after the rebuild it triggers.
        share: quantizeSizing(clampFlexGrow(grows[i])),
        fill: fill != null ? quantizeSizing(clampScale(fill)) : null,
      },
    };
    const newLine = writeRowImage(edited);

    const line = img.line + 1; // 1-indexed
    if (line < 1 || line > view.state.doc.lines) continue;
    const lineObj = view.state.doc.line(line);
    // Anti-resurrection: a deferred persist may fire after a structural move
    // (moveLine) relocated this image. If the cached line no longer references
    // the same file, skip it — otherwise we'd rewrite a now-blank/different line
    // and resurrect the moved embed at its old position.
    if (!lineObj.text.includes(img.fileName)) continue;
    // Compare against the document, never against `img.raw`: a param-only write
    // does not rebuild the widget (`eqInner` strips the params before comparing),
    // so `img.raw` keeps whatever it held when the DOM was last built. A later
    // write whose text happens to equal that stale value would be discarded as a
    // no-op, and the note would silently keep the previous fill — which is what
    // Reading Mode, reading only the file, would keep showing.
    if (newLine === lineObj.text) continue;
    changes.push({ from: lineObj.from, to: lineObj.from + lineObj.text.length, insert: newLine });
  }

  if (changes.length === 0) return;

  // Apply from bottom to top so earlier positions stay valid
  changes.sort((a, b) => b.from - a.from);
  scrollDiag.note("追加 dispatch：applyFlexGrowChanges", {
    lines: changes.map((c) => c.insert),
  });
  view.dispatch({ changes });
}

/** A RowImage's flex-grammar share, as the destroy/flush persist compare reads
 *  it.  Multi members carry their live share in display.share; single rows never
 *  persist through the flex-grow path (they write |S|W via persistSingleImage),
 *  so their grow is just the flex divisor 1. */
function modelGrow(img: RowImage): number {
  return img.display.kind === "multi" ? img.display.share : 1;
}

/** A RowImage's live fill ratio (null = default), the multi-row scale analogue. */
function modelFill(img: RowImage): number | null {
  return img.display.kind === "multi" ? img.display.fill : null;
}

class StaticImageRowWidget extends WidgetType {
  private group: RowGroup;
  private options: ImageRowOptions;
  private innerWidget: ImageRowWidget | null = null;
  private editorView: EditorView | null = null;
  private persistTimer: number | null = null;

  constructor(group: RowGroup, options: ImageRowOptions) {
    super();
    this.group = group;
    this.options = options;
    log.debug("StaticImageRowWidget constructed", {
      imageCount: group.images.length,
      lineStart: group.lineStart,
      lineEnd: group.lineEnd,
    });
  }

  eq(other: StaticImageRowWidget): boolean {
    const same = this.eqInner(other);
    if (!same) scrollDiag.note("eq=false → setDOM（整块重建）", { reason: this.eqReason(other) });
    return same;
  }

  /** Diag only: name the field that refused reuse. Covers the discriminators a
   *  first rotation flips (raw params, orientation, display kind). */
  private eqReason(other: StaticImageRowWidget): string {
    const a = this.group;
    const b = other.group;
    if (a.images.length !== b.images.length) return "imageCount";
    if (a.lineStart !== b.lineStart) return "lineStart";
    if (a.lineEnd !== b.lineEnd) return "lineEnd";
    for (let i = 0; i < a.images.length; i++) {
      if (a.images[i].alignment !== b.images[i].alignment) return `alignment[${i}]`;
      if (normalizeRaw(a.images[i].raw) !== normalizeRaw(b.images[i].raw)) return `raw[${i}]`;
      if (a.images[i].display.kind !== b.images[i].display.kind) return `display[${i}]`;
      const ao = a.images[i].orientation;
      const bo = b.images[i].orientation;
      if (ao.turns !== bo.turns || ao.mirror !== bo.mirror) {
        return `orientation[${i}] t${ao.turns}/m${ao.mirror}→t${bo.turns}/m${bo.mirror}`;
      }
    }
    return "options/settings";
  }

  private eqInner(other: StaticImageRowWidget): boolean {
    const a = this.group;
    const b = other.group;
    if (a.images.length !== b.images.length) return false;
    if (a.lineStart !== b.lineStart) return false;
    if (a.lineEnd !== b.lineEnd) return false;
    if (this.options.snapSensitivity !== other.options.snapSensitivity) return false;
    if (this.options.ghostImageWidth !== other.options.ghostImageWidth) return false;
    if (this.options.topBarSensitivity !== other.options.topBarSensitivity) return false;
    if (this.options.dragOpacity !== other.options.dragOpacity) return false;
    if (this.options.alignment !== other.options.alignment) return false;
    if (this.options.defaultRowHeight !== other.options.defaultRowHeight) return false;
    if (this.options.gap !== other.options.gap) return false;
    if (this.options.enableResize !== other.options.enableResize) return false;
    if (this.options.enableDividers !== other.options.enableDividers) return false;
    if (this.options.singleImageSizeMode !== other.options.singleImageSizeMode) return false;
    if (this.options.singleImageWidth !== other.options.singleImageWidth) return false;
    // Single-image manual flag (S) is stripped by normalizeRaw, so compare the
    // typed display kind explicitly — flipping S=1→0 (override reset) or a
    // manual↔follow transition must force a rebuild.  A single row's display is
    // exactly {single-follow | single-manual}, so kind inequality is the manual
    // flag inequality.
    if (a.images.length === 1 && b.images.length === 1) {
      if (a.images[0].display.kind !== b.images[0].display.kind) return false;
    }
    for (let i = 0; i < a.images.length; i++) {
      if (normalizeRaw(a.images[i].raw) !== normalizeRaw(b.images[i].raw)) return false;
      if (a.images[i].alignment !== b.images[i].alignment) return false;
      // The orientation word is stripped by normalizeRaw with every other
      // param, so a rotate/flip would otherwise reuse the live widget — whose
      // stale model would then write its old orientation straight back over the
      // new one. Compare it explicitly to force the rebuild.
      const ao = a.images[i].orientation;
      const bo = b.images[i].orientation;
      if (ao.turns !== bo.turns || ao.mirror !== bo.mirror) return false;
    }
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    try {
      scrollDiag.note("toDOM 重建（块高度自此刻起被遗忘，回到 estimatedHeight）", {
        images: this.group.images.length,
      });
      log.debug("SCROLL_DIAG widget build (toDOM)", {
        lineStart: this.group.lineStart,
        lineEnd: this.group.lineEnd,
        imageCount: this.group.images.length,
        raws: this.group.images.map((i) => i.raw.slice(0, 40)),
        sidebars: getSidebarWidths(),
      });
      log.debug("StaticImageRowWidget toDOM", {
        imageCount: this.group.images.length,
        files: this.group.images.map((i) => i.fileName),
      });
      this.editorView = view;
      this.innerWidget = new ImageRowWidget(this.group, this.options);
      // Pass the current editor content width. view.contentDOM is the CM6
      // `.cm-content` element — always laid out and current, even though this
      // widget is still detached at toDOM time. Lets build()'s cache-restore
      // scale stale (wide-editor) heights to the current width instead of
      // relying on the stale module-global lastMeasuredWidth (the scroll-up
      // flicker after a sidebar resize).
      const editorContentWidth = Math.round(
        view.contentDOM.getBoundingClientRect().width
      );
      const el = this.innerWidget.build(editorContentWidth);

      // Notify CodeMirror when the widget height changes.
      // Use StateEffect to force an actual state change so CM6 runs
      // the full update cycle (measure → viewport → gutter sync).
      let version = 0;
      this.innerWidget.onLayoutChange = () => {
        const view = this.editorView;
        if (!view) return;
        log.debug("StaticImageRowWidget onLayoutChange → forceLayoutRefresh", {
          hasView: !!view,
          version: version + 1,
        });
        view.dispatch({
          effects: forceLayoutRefresh.of(++version),
        });
      };

      // Set up drag reorder within this row
      this.innerWidget.onReorder((fromIndex, toIndex) => {
        this.handleReorder(fromIndex, toIndex);
      });
      this.innerWidget.enableDragReorder();

      // Flex-grow values are persisted in destroy(), not during interactive
      // resize, to avoid triggering a CodeMirror decoration rebuild and flash.

      // Handle cross-row merge: drag a standalone image into this row
      this.innerWidget.onMergeExternal((insertAtIndex, dataTransfer) => {
        this.handleMergeExternal(insertAtIndex, dataTransfer);
      });

      // Auto-backfill: persist computed flexGrow + scale to markdown
      // immediately (not waiting for widget destroy) so Reading Mode
      // picks up the correct values without a tab-switch dance.
      this.innerWidget.onPersist(() => {
        if (!this.editorView) return;
        const images = this.group.images;
        log.debug("SCROLL_DIAG persist fired", {
          lineStart: this.group.lineStart,
          imageCount: images.length,
        });
        // Single-image rows persist as `![[file|W|S]]` (W=px width, S=0/1 flag).
        if (images.length === 1) {
          this.persistSingleImage();
          return;
        }
        const grows = this.innerWidget!.getCurrentFlexGrows().map((g) => clampFlexGrow(g));
        const scales = images.map((img) =>
          img.display.kind === "multi" && img.display.fill != null
            ? clampScale(img.display.fill)
            : null
        );
        log.debug("BALANCE StaticImageRowWidget onPersist", {
          grows,
          scales,
          imageCount: images.length,
        });
        applyFlexGrowChanges(this.editorView, images, grows, scales, this.options.alignment);
      });

      return el;
    } catch (e) {
      log.error("StaticImageRowWidget toDOM error", {
        error: String(e),
        stack: (e as Error)?.stack ?? "no stack",
        options: {
          alignment: this.options.alignment,
          defaultRowHeight: this.options.defaultRowHeight,
          gap: this.options.gap,
        },
        group: {
          imageCount: this.group.images.length,
          lineStart: this.group.lineStart,
          lineEnd: this.group.lineEnd,
        },
      });
      const fallback = createSpan();
      fallback.textContent = "(Image row render error)";
      return fallback;
    }
  }

  private handleReorder(fromIndex: number, toIndex: number): void {
    if (!this.editorView) return;
    const view = this.editorView;
    const images = this.group.images;
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || fromIndex >= images.length ||
        toIndex < 0 || toIndex >= images.length) return;

    try {
    const fromLine = images[fromIndex].line;
    const toLine = images[toIndex].line;

    // These lines are always consecutive in a group
    const minLine = this.group.lineStart;
    const maxLine = this.group.lineEnd - 1;

    const doc = view.state.doc;
    const fromPos = doc.line(minLine + 1).from;
    const toPos = maxLine + 2 <= doc.lines
      ? doc.line(maxLine + 2).from
      : doc.length;

    // Read the original text range including all newlines, then reorder
    // the lines in-place to preserve the exact newline structure.
    const originalText = doc.sliceString(fromPos, toPos);
    const originalLines = originalText.split("\n");

    // Reorder within the group lines (local indices)
    const localFrom = fromLine - minLine;
    const localTo = toLine - minLine;

    const [moved] = originalLines.splice(localFrom, 1);
    const insertAt = fromIndex < toIndex
      ? (localTo - (fromLine < toLine ? 1 : 0)) + 1
      : localTo;
    originalLines.splice(insertAt, 0, moved);

    const insert = originalLines.join("\n");

    log.info("LivePreview drag reorder", {
      fromIndex, toIndex, fromLine, toLine,
      minLine, maxLine, fromPos, toPos, docLength: doc.length,
      docLines: doc.lines,
      before: images.map(i => i.raw),
      after: originalLines,
      originalLength: originalText.length,
      insertLength: insert.length,
    });

    view.dispatch({
      changes: { from: fromPos, to: toPos, insert },
    });

    const newDoc = view.state.doc.toString();
    log.debug("LivePreview post-reorder doc", {
      docLines: view.state.doc.lines,
      docLength: view.state.doc.length,
      docPreview: newDoc.substring(0, 500),
    });

    // Diagnostic: check DOM for leaked Obsidian image embeds after reorder
    const capturedView = view;
    window.requestAnimationFrame(() => {
      try {
        const allEmbeds = capturedView.dom.querySelectorAll(
          ".internal-embed.image-embed"
        );
        const embedInfo: Array<Record<string, unknown>> = [];
        for (let i = 0; i < allEmbeds.length; i++) {
          const el = allEmbeds[i] as HTMLElement;
          const rect = el.getBoundingClientRect();
          const img = el.querySelector("img");
          embedInfo.push({
            offsetHeight: el.offsetHeight,
            offsetWidth: el.offsetWidth,
            rectTop: rect.top,
            rectBottom: rect.bottom,
            display: window.getComputedStyle(el).display,
            imgSrc: img?.getAttribute("src")?.substring(0, 80) || "",
            parentTag: el.parentElement?.tagName || "",
            parentClass: el.parentElement?.className?.substring(0, 60) || "",
          });
        }
        log.debug("LivePreview post-reorder DOM check", {
          embedCount: allEmbeds.length,
          cmLineCount: capturedView.dom.querySelectorAll(".cm-line").length,
          embeds: embedInfo,
        });
      } catch (err) {
        log.debug("LivePreview post-reorder DOM check error", {
          error: String(err),
        });
      }
    });
    } catch (e) {
      log.error("LivePreview handleReorder error", { error: String(e), stack: (e as Error)?.stack ?? "no stack" });
    }
  }

  /**
   * Merge an image from another location into this flex row.
   * Supports both standalone (obsidian://open) and flex-row ("diaa-row:") sources.
   */
  private handleMergeExternal(insertAtIndex: number, dataTransfer: string): void {
    if (!this.editorView) return;
    const view = this.editorView;

    try {
    // Resolve source line from dataTransfer
    const srcLine = resolveSourceLine(view, dataTransfer, this.group);
    if (srcLine === null) {
      log.debug("LivePreview mergeExternal: could not resolve source");
      return;
    }

    const targetLine = this.group.lineStart + insertAtIndex;
    if (srcLine === targetLine) return;

    log.info("LivePreview cross-row merge", {
      srcLine, targetLine, insertAtIndex,
      dataTransfer: dataTransfer.substring(0, 40),
    });

    // Row → row: recompute BOTH rows' flex-grow from current item widths so
    // the moved image participates in the target row's normalization and the
    // source row's remaining items stay proportional.  Scale is preserved.
    const rowMatch = dataTransfer.match(/^diaa-row:(\d+):(\d+)$/);
    if (rowMatch) {
      const srcRowLineStart = parseInt(rowMatch[1], 10);
      const srcIndex = parseInt(rowMatch[2], 10);
      // Source row === target row: dropping a row onto itself is not an external
      // merge. Intra-row reordering is handled by the reorder path; bail out here,
      // otherwise the same line is measured/rewritten as both source and target and
      // gets corrupted (duplicate embed on one line).
      if (srcRowLineStart === this.group.lineStart) return;
      this.recomputeFlexGrowsForMerge(view, srcRowLineStart, srcIndex, insertAtIndex);
    }

    moveLine(view, srcLine, targetLine);
    } catch (e) {
      log.error("LivePreview handleMergeExternal error", { error: String(e), stack: (e as Error)?.stack ?? "no stack" });
    }
  }

  /**
   * Recompute flex-grow for the source and target rows from their current item
   * pixel widths, preserving each line's scale.  Writes the new flex-grows in
   * place (a single dispatch) before the caller relocates the moved line, so
   * the moved image lands with a flex-grow on the target row's scale.
   */
  private recomputeFlexGrowsForMerge(
    view: EditorView,
    srcRowLineStart: number,
    srcIndex: number,
    insertAtIndex: number
  ): void {
    const srcWidths = measureItemWidths(view, srcRowLineStart);
    const tgtWidths = measureItemWidths(view, this.group.lineStart);
    if (!srcWidths || !tgtWidths) return;
    if (srcIndex < 0 || srcIndex >= srcWidths.length) return;

    const movedWidth = srcWidths[srcIndex];

    // Source row: remaining items (moved one removed) → normalized flex-grow.
    const srcRemaining = srcWidths.filter((_, j) => j !== srcIndex);
    const srcGrows = computeFlexGrowsFromWidths(srcRemaining);

    const doc = view.state.doc;
    const changes: Array<{ from: number; to: number; insert: string }> = [];
    const rewrite = (line0: number, grow: number, dropScale = false): void => {
      if (line0 < 0 || line0 >= doc.lines) return;
      const lineObj = doc.line(line0 + 1);
      const raw = lineObj.text;
      // The moved line may arrive from a single-image row where the second param
      // is a 0/1 flag, not a scale.  Drop it so the target multi-row backfills a
      // real scale instead of mis-reading the flag as a tiny ratio.
      const scale = dropScale ? null : parseScaleFromRaw(raw);
      const alignMatch = raw.match(/\|(left|center|right)\|/);
      const alignment = (alignMatch ? alignMatch[1] : this.options.alignment) as "left" | "center" | "right";
      const newText = buildMultiLine(raw, grow, scale, alignment);
      if (newText !== raw) {
        changes.push({ from: lineObj.from, to: lineObj.from + raw.length, insert: newText });
      }
    };
    // Strip every sizing |param, keeping any orientation word, so the rebuilt
    // multi-image widget computes an equilibrium layout (equal heights) from
    // natural aspect ratios while the image's rotate/flip survives the move.
    const rewriteBare = (line0: number): void => {
      if (line0 < 0 || line0 >= doc.lines) return;
      const lineObj = doc.line(line0 + 1);
      const raw = lineObj.text;
      const newText = stripSizingKeepOrientation(raw);
      if (newText !== raw) {
        changes.push({ from: lineObj.from, to: lineObj.from + raw.length, insert: newText });
      }
    };

    // Source remaining lines.
    if (srcRemaining.length === 1) {
      // Source row drops to a single image → convert it to a setting-driven
      // single immediately (bare embed), never leave it as a multi `|W|S` line.
      const j = srcWidths.findIndex((_, idx) => idx !== srcIndex);
      if (j >= 0) rewriteBare(srcRowLineStart + j);
    } else {
      let k = 0;
      for (let j = 0; j < srcWidths.length; j++) {
        if (j === srcIndex) continue;
        rewrite(srcRowLineStart + j, srcGrows[k++]);
      }
    }

    if (tgtWidths.length === 1) {
      // Target is a single-image row: single + incoming form a fresh multi-image
      // row that should start in equilibrium. Write both the moved line and the
      // existing target line as bare embeds (dropping the single-image `|S|W`
      // params, which would otherwise be mis-read under multi-image `|W|S`
      // semantics) and let the new widget balance them.
      rewriteBare(srcRowLineStart + srcIndex);
      rewriteBare(this.group.lineStart);
    } else {
      // Target already multi: insert the moved image's width and normalize the
      // whole row so proportions stay consistent.
      const insertPos = Math.max(0, Math.min(insertAtIndex, tgtWidths.length));
      const combined = [
        ...tgtWidths.slice(0, insertPos),
        movedWidth,
        ...tgtWidths.slice(insertPos),
      ];
      const tgtGrows = computeFlexGrowsFromWidths(combined);
      // Moved line → its slot in the target row (drop any single-image S flag).
      rewrite(srcRowLineStart + srcIndex, tgtGrows[insertPos], true);
      // Existing target lines → their (shifted) slots.
      for (let t = 0; t < tgtWidths.length; t++) {
        const slot = t < insertPos ? t : t + 1;
        rewrite(this.group.lineStart + t, tgtGrows[slot]);
      }
    }

    if (changes.length === 0) return;
    // Apply bottom-to-top so earlier line positions stay valid.
    changes.sort((a, b) => b.from - a.from);
    view.dispatch({ changes });
    log.info("LivePreview merge flex-grow recompute", {
      srcRowLineStart, srcIndex, insertAtIndex,
      tgtCount: tgtWidths.length, movedWidth: Math.round(movedWidth),
    });
  }


  updateDOM(_element: HTMLElement, view: EditorView): boolean {
    if (!this.innerWidget || !this.group) {
      scrollDiag.note("updateDOM → false（新实例 innerWidget 为空，走 toDOM 重建）");
      return false;
    }

    try {
    const doc = view.state.doc;

    // Detect whether the image group at this position has changed
    // composition (count or file names). If so, return false to force
    // CodeMirror to destroy+recreate the widget.
    const imgRegex = /^[\s]*!\[\[([^\]]+)\]\]/;
    const currentFiles: string[] = [];
    for (let i = this.group.lineStart; i < doc.lines; i++) {
      const text = doc.line(i + 1).text;
      const match = text.match(imgRegex);
      if (!match) break;
      currentFiles.push(match[1].split("|")[0]);
    }

    if (currentFiles.length !== this.group.images.length) {
      scrollDiag.note("updateDOM → false（成员数变化）", {
        was: this.group.images.length,
        now: currentFiles.length,
      });
      return false;
    }
    for (let i = 0; i < currentFiles.length; i++) {
      if (currentFiles[i] !== this.group.images[i].fileName) {
        scrollDiag.note("updateDOM → false（成员文件变化）", {
          index: i,
          was: this.group.images[i].fileName,
          now: currentFiles[i],
        });
        return false;
      }
    }

    // Single-image rows use the swapped `|S|W` param order; the flex-grow sync
    // below assumes multi-image `|W|...`, so skip it (single sizing is handled
    // by layoutSingleImage on rebuild).
    if (this.group.images.length === 1) {
      scrollDiag.note("updateDOM → true（单图行，沿用现有 DOM）");
      return true;
    }

    // Group composition unchanged: just sync flex-grows, no DOM rebuild
    const grows: number[] = [];
    for (let line = this.group.lineStart; line < this.group.lineEnd; line++) {
      const text = doc.line(line + 1).text;
      const match = text.match(/\|(\d+)(?:\]\]|\|)/);
      const flex = match ? parseInt(match[1], 10) / 100 : 1;
      grows.push(flex);
    }
    if (grows.length === this.group.images.length) {
      const safeGrows = grows.map((g) => clampFlexGrow(g));
      log.debug("BALANCE updateDOM syncing flex-grows from markdown", {
        growsFromMarkdown: grows,
        safeGrows,
        currentDOMFlexGrows: this.innerWidget.getCurrentFlexGrows(),
      });
      this.innerWidget.updateFlexGrows(safeGrows);
    }
    scrollDiag.note("updateDOM → true（多图行，同步 flex-grow，不重建）", { grows });
    return true;
    } catch (e) {
      log.error("LivePreview updateDOM error", { error: String(e), stack: (e as Error)?.stack ?? "no stack" });
      // Return false so CodeMirror safely destroys + recreates the widget.
      return false;
    }
  }

  ignoreEvent(event: Event): boolean {
    if (event.type.startsWith("drag")) return true;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.("." + CLASSES.resizeHandle) || target?.closest?.("." + CLASSES.divider)) {
      return true;
    }
    return false;
  }

  destroy(): void {
    scrollDiag.note("destroy", {
      images: this.group.images.length,
      willPersistGrows:
        !!this.innerWidget && this.group.images.length > 1,
    });
    log.debug("SCROLL_DIAG widget destroy", {
      lineStart: this.group.lineStart,
      imageCount: this.group.images.length,
    });
    if (this.persistTimer) window.clearTimeout(this.persistTimer);
    // Persist flex-grows and scale ratios for multi-image rows.
    if (this.editorView && this.innerWidget && this.group.images.length > 1) {
      const view = this.editorView;
      const images = this.group.images;
      const grows = this.innerWidget.getCurrentFlexGrows();
      const hasFlexChanges = grows.some((g, i) => {
        return Math.abs(g - modelGrow(images[i])) > 0.005;
      });
      if (hasFlexChanges || this.innerWidget._scaleDirtyImages.size > 0) {
        // Always include scales so they're preserved in markdown when
        // flexGrow changes (e.g. divider drag) without a scale change.
        const scales = images.map(modelFill);
        // Try synchronous dispatch first; fall back to setTimeout if the
        // view is already in a state where dispatch is illegal.
        try {
          applyFlexGrowChanges(view, images, grows, scales, this.options.alignment);
        } catch {
          this.persistTimer = window.setTimeout(() => {
            applyFlexGrowChanges(view, images, grows, scales, this.options.alignment);
          }, 0);
        }
      }
    }
    this.innerWidget?.destroy();
    this.innerWidget = null;
  }

  /** Synchronously persist pending flex-grow and scale changes.
   *  Called before creating a new widget to avoid setTimeout races. */
  flushPendingPersist(): void {
    if (!this.editorView || !this.innerWidget || this.group.images.length <= 1) return;
    const images = this.group.images;
    const grows = this.innerWidget.getCurrentFlexGrows();
    const hasFlexChanges = grows.some((g, i) => {
      return Math.abs(g - modelGrow(images[i])) > 0.005;
    });
    if (!hasFlexChanges && this.innerWidget._scaleDirtyImages.size === 0) return;
    const scales = images.map(modelFill);
    try {
      applyFlexGrowChanges(this.editorView, images, grows, scales, this.options.alignment);
    } catch {
      // View not ready for dispatch; persist will happen in destroy()
    }
  }

  /** Write current flex-grow values back to markdown as ![[file|width]]. */
  private persistFlexGrows(): void {
    if (!this.editorView || !this.innerWidget) return;
    applyFlexGrowChanges(
      this.editorView,
      this.group.images,
      this.innerWidget.getCurrentFlexGrows(),
      undefined,
      this.options.alignment
    );
  }

  /**
   * Persist a single-image row as `![[file|W|S]]`.  The typed display decides
   * S: manual rows write `|1|W` from display.widthPx; follow rows write `|0|W`
   * with the pixel width the widget last materialised (getSingleWidthPx), since
   * a single-follow carries no width in the model.  Serialisation delegates to
   * rowParams.write() over the model, so no parallel single-line formatter stays.
   */
  private persistSingleImage(): void {
    if (!this.editorView) return;
    const img = this.group.images[0];
    if (!img) return;
    const widthPx = img.display.kind === "single-manual"
      ? img.display.widthPx
      : (this.innerWidget?.getSingleWidthPx() ?? 1);
    const manual = img.display.kind === "single-manual";
    const lineNum = img.line + 1; // 1-indexed
    const doc = this.editorView.state.doc;
    if (lineNum < 1 || lineNum > doc.lines) return;
    const lineObj = doc.line(lineNum);
    // Anti-resurrection: skip if a structural move relocated this image and the
    // cached line no longer references it.
    if (!lineObj.text.includes(img.fileName)) return;
    const align = img.alignment ?? this.options.alignment;
    const newText = writeRowImage(
      { ...img, alignment: align },
      manual ? {} : { followWidthPx: widthPx }
    );
    if (newText === lineObj.text) return;
    scrollDiag.note("追加 dispatch：persistSingleImage", {
      line: img.line,
      from: lineObj.text,
      to: newText,
    });
    this.editorView.dispatch({
      changes: { from: lineObj.from, to: lineObj.from + lineObj.text.length, insert: newText },
    });
    log.debug("Single-image persist", {
      line: img.line, widthPx, sFlag: manual ? 1 : 0, alignment: align,
    });
  }
}

/** Serialise a flex-grow + scale + alignment onto a raw multi-row embed line.
 *  Cross-row merge rewrites lines read straight from the doc (not through a
 *  RowGroup), so the model is synthesised for write().  Replaces the deleted
 *  updateImageLineWidth (its multi grammar now lives solely in rowParams.write). */
function buildMultiLine(
  raw: string,
  grow: number,
  scale: number | null,
  alignment: Alignment | undefined
): string {
  return writeRowImage({
    line: 0,
    raw,
    fileName: "",
    alignment,
    // The line is rewritten for its sizing only; whatever orientation it
    // already carries must survive the rewrite.
    orientation: parseOrientationWord(embedParamString(raw)) ?? IDENTITY_STATE,
    hasSizing: true,
    display: { kind: "multi", share: grow, fill: scale },
  });
}

/**
 * "Reset all single images to the current setting": flip the S flag of every
 * manually-sized (S=1) single-image line to 0.  The eq() single-image manual
 * comparison then forces those widgets to rebuild and re-derive W from the
 * setting.  One-shot; invoked from the settings "override" action.
 */
export function resetSingleImageManualFlags(
  view: EditorView,
  maxImagesPerRow: number,
  extensions: string
): void {
  const doc = view.state.doc;
  const groups = detectRowGroups(doc.toString(), maxImagesPerRow, extensions);
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  for (const g of groups) {
    if (g.kind !== "single") continue;
    const img = g.images[0];
    if (img.display.kind !== "single-manual") continue;
    const lineNum = img.line + 1;
    if (lineNum < 1 || lineNum > doc.lines) continue;
    const lineObj = doc.line(lineNum);
    // Follow rows keep the manual pixel width (now setting-driven) as their seed.
    const newText = writeRowImage(
      { ...img, display: { kind: "single-follow" }, hasSizing: true },
      { followWidthPx: img.display.widthPx }
    );
    if (newText !== lineObj.text) {
      changes.push({ from: lineObj.from, to: lineObj.from + lineObj.text.length, insert: newText });
    }
  }
  if (changes.length === 0) return;
  changes.sort((a, b) => b.from - a.from);
  view.dispatch({ changes });
  log.info("LivePreview reset single-image manual flags", { count: changes.length });
}

/**
 * "Reset all image alignments": strip per-image alignment params from every
 * image embed line, reverting to the global alignment setting.
 */
export function resetImageAlignmentFlags(
  view: EditorView,
  maxImagesPerRow: number,
  extensions: string,
  defaultAlignment: "left" | "center" | "right"
): void {
  const doc = view.state.doc;
  const groups = detectRowGroups(doc.toString(), maxImagesPerRow, extensions);
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  for (const g of groups) {
    for (const img of g.images) {
      const lineNum = img.line + 1;
      if (lineNum < 1 || lineNum > doc.lines) continue;
      const lineObj = doc.line(lineNum);
      const line = lineObj.text;
      // Replace any per-image alignment with the global default.
      // Lines already lacking alignment also get the default prepended.
      if (/\|(left|center|right)\|/.test(line)) {
        const reverted = line.replace(/\|(left|center|right)\|/, `|${defaultAlignment}|`);
        if (reverted !== line) {
          changes.push({ from: lineObj.from, to: lineObj.from + line.length, insert: reverted });
        }
      }
    }
  }
  if (changes.length === 0) return;
  changes.sort((a, b) => b.from - a.from);
  view.dispatch({ changes });
  log.info("LivePreview reset image alignment flags", { count: changes.length });
}

// ── State field for decorations ─────────────────────────────────

function buildDecorations(
  state: EditorView["state"],
  getOptions: () => ImageRowOptions,
  getSettings: () => DragImageSettings
): DecorationSet {
  try {
    // Capture stack to identify the call chain triggering a rebuild.
    // Filter to the first few frames after buildDecorations itself.
    const stack = new Error().stack?.split("\n").slice(2, 8).join("\n") || "";
    log.debug("buildDecorations invoked", { timestamp: Date.now(), stack });

    // Skip in source mode: editorLivePreviewField is only present/true in Live Preview
    if (!state.field(editorLivePreviewField, false)) {
      log.debug("LivePreview decorations skipped (source mode)");
      return Decoration.none;
    }

    const doc = state.doc.toString();
    if (!doc) return Decoration.none;

    const settings = getSettings();
    const baseOptions = getOptions();

    const options = baseOptions;

    const groups = detectRowGroups(
      doc,
      settings.maxImagesPerRow,
      settings.imageExtensions
    );
    // detectRowGroups types every row up front: multi members parse |W|S and
    // single rows parse their own |S|W grammar, so no post-hoc remap pass needed.

    log.debug("LivePreview buildDecorations", {
      groupCount: groups.length,
      docLength: doc.length,
      docLines: state.doc.lines,
      groups: groups.map(g => ({
        lineStart: g.lineStart,
        lineEnd: g.lineEnd,
        count: g.images.length,
        files: g.images.map(i => i.fileName),
        raws: g.images.map(i => i.raw),
      })),
    });

    const builder = new RangeSetBuilder<Decoration>();
    let decorationAdded = false;

    for (const group of groups) {
      try {
        if (group.images.length < 1) continue;

        const lineCount = state.doc.lines;
        const lineStart1 = group.lineStart + 1;
        const lineEnd1 = group.lineEnd; // 0-indexed exclusive == last line in 1-indexed

        if (lineStart1 > lineCount || lineEnd1 > lineCount) {
          log.debug("LivePreview skipping group (out of range)", {
            lineStart1, lineEnd1, lineCount,
          });
          continue;
        }

        const from = state.doc.line(lineStart1).from;
        const to = lineEnd1 < lineCount
          ? state.doc.line(lineEnd1 + 1).from
          : state.doc.length;

        log.debug("LivePreview decoration range", {
          groupLineStart: group.lineStart,
          groupLineEnd: group.lineEnd,
          lineStart1,
          lineEnd1,
          lineCount,
          from,
          to,
          docLength: state.doc.length,
          imageCount: group.images.length,
        });

        if (to <= from) {
          log.debug("LivePreview skipping group (to <= from)", { from, to });
          continue;
        }

        builder.add(
          from,
          to,
          Decoration.replace({
            widget: new StaticImageRowWidget(group, options),
            block: true,
            inclusive: true,
          })
        );
        decorationAdded = true;
      } catch (e) {
        log.error("LivePreview widget creation error", {
          groupLineStart: group.lineStart,
          error: String(e),
        });
      }
    }

    const result = builder.finish();
    log.debug("LivePreview decorations built", {
      decorationAdded,
      setSize: result.size,
    });
    return result;
  } catch (e) {
    log.error("LivePreview buildDecorations error", { error: String(e) });
    return Decoration.none;
  }
}

/** Dispatch this annotation to force a decoration rebuild (e.g. after settings change). */
export const settingsChanged = Annotation.define<boolean>();

/**
 * StateEffect and StateField to force CM6 to run a full update cycle
 * (viewport re-measurement + gutter sync) during interactive resize drag.
 *
 * Without this, dispatch({}) is a no-op because startState === state,
 * so CM6 skips the entire update cycle and line numbers never reflow.
 * Each dispatch increments a counter, guaranteeing state actually changes.
 */
export const forceLayoutRefresh = StateEffect.define<number>();
export const layoutVersionField = StateField.define<number>({
  create() { return 0; },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(forceLayoutRefresh)) return e.value;
    }
    return value;
  }
});

export function createLivePreviewPlugin(
  getOptions: () => ImageRowOptions,
  getSettings: () => DragImageSettings
) {
  // Track Live Preview state so we can rebuild decorations on mode switch
  let wasLivePreview = false;

  const field = StateField.define<DecorationSet>({
    create(state) {
      wasLivePreview = !!state.field(editorLivePreviewField, false);
      log.debug("LivePreview StateField create", { wasLivePreview });
      return buildDecorations(state, getOptions, getSettings);
    },
    update(_oldDecos, tr) {
      const isLivePreview = !!tr.state.field(editorLivePreviewField, false);
      const docChanged = tr.docChanged;
      const settingsAnnot = tr.annotation(settingsChanged);
      const lpChanged = wasLivePreview !== isLivePreview;
      if (docChanged || settingsAnnot || lpChanged) {
        log.debug("StateField.update → buildDecorations", {
          docChanged,
          settingsAnnotation: !!settingsAnnot,
          livePreviewChanged: lpChanged,
          timestamp: Date.now(),
        });
        wasLivePreview = isLivePreview;
        return buildDecorations(tr.state, getOptions, getSettings);
      }
      return _oldDecos;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  return [layoutVersionField, Prec.highest(field)];
}

/** A resolved drag/drop target under the cursor. `findDropTarget` always
 *  produces the full shape, with the row-specific fields set to null for a
 *  non-row target (and vice versa). */
interface DropTarget {
  /** CodeMirror document position of the target element. */
  pos: number;
  /** 0-based source line of the target. */
  line: number;
  isImageLine: boolean;
  isFlexRow: boolean;
  rowLineStart: number | null;
  rowLineEnd: number | null;
  element: HTMLElement;
  cmLine: HTMLElement | null;
}

/**
 * ViewPlugin that orchestrates cross-row drag operations at the capture phase
 * on .cm-editor (above .cm-content in the DOM). This ensures our handlers fire
 * before Obsidian's .cm-content-level handlers, letting us intercept and block
 * Obsidian from duplicating standalone-image drops.
 *
 * Scenarios handled here:
 *   1. Flex row → standalone line (diaa-row: data on non-flex-row target)
 *   2. Standalone image → flex row (obsidian://open data intercepted at dragstart
 *      via custom MIME, handled at drop to prevent Obsidian copy)
 */
export function createStandaloneDropPlugin(
  getSettings: () => DragImageSettings
) {
  return ViewPlugin.fromClass(
    class {
      private view: EditorView;
      private editorEl: HTMLElement | null = null;
      private onDragStart: ((e: DragEvent) => void) | null = null;
      private onDragOver: ((e: DragEvent) => void) | null = null;
      private onDragLeave: ((e: DragEvent) => void) | null = null;
      private onDragEnd: ((e: DragEvent) => void) | null = null;
      private onDrop: ((e: DragEvent) => void) | null = null;
      private dragoverLogged = false;
      private dropIndicatorEl: HTMLElement | null = null;

      constructor(view: EditorView) {
        this.view = view;
        this.setup();
      }

      update(_update: ViewUpdate) {
        if (!this.editorEl) this.setup();
      }

      destroy() {
        this.clearDropIndicator();
        if (this.onDragStart) window.removeEventListener("dragstart", this.onDragStart, true);
        if (this.onDragOver) window.removeEventListener("dragover", this.onDragOver, true);
        if (this.onDragLeave) window.removeEventListener("dragleave", this.onDragLeave, true);
        if (this.onDragEnd) window.removeEventListener("dragend", this.onDragEnd, true);
        if (this.onDrop) window.removeEventListener("drop", this.onDrop, true);
      }

      private clearDropIndicator() {
        if (this.dropIndicatorEl) {
          this.dropIndicatorEl.classList.remove("diaa-drop-target-line", "diaa-drop-left", "diaa-drop-right");
          applyDropIndicator(this.dropIndicatorEl, null);
          this.dropIndicatorEl = null;
        }
      }

      private findDropTarget(clientX: number, clientY: number): DropTarget | null {
        const targetEl = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
        if (!targetEl || !this.view.dom.contains(targetEl)) return null;

        // Detect flex row widgets (our custom DOM, spans multiple lines)
        const flexRow = targetEl.closest<HTMLElement>(".diaa-row");
        if (flexRow) {
          const ls = parseInt(flexRow.dataset.lineStart || "", 10);
          const le = parseInt(flexRow.dataset.lineEnd || "", 10);
          if (!isNaN(ls) && !isNaN(le)) {
            const pos = this.view.posAtDOM(flexRow);
            if (pos >= 0) {
              return {
                pos,
                line: ls,
                isImageLine: false,
                isFlexRow: true as const,
                rowLineStart: ls,
                rowLineEnd: le,
                element: flexRow,
                cmLine: null as HTMLElement | null,
              };
            }
          }
        }

        const embed = targetEl.closest<HTMLElement>(".internal-embed.image-embed");
        const cmLine = targetEl.closest<HTMLElement>(".cm-line");
        const domEl = cmLine || embed;
        if (!domEl) return null;

        const pos = this.view.posAtDOM(domEl);
        if (pos < 0) return null;

        const line = this.view.state.doc.lineAt(pos).number - 1;

        return {
          pos,
          line,
          isImageLine: !!embed,
          isFlexRow: false as const,
          rowLineStart: null as number | null,
          rowLineEnd: null as number | null,
          element: domEl,
          cmLine: cmLine || null,
        };
      }

      private showDropIndicator(targetInfo: DropTarget, clientX?: number) {
        this.clearDropIndicator();

        // Flex row target: bar the row's leading or trailing edge.
        // The shadow is drawn outward, never inset: an inset shadow paints under
        // the element's content, and a row's items cover it completely, so the
        // marker would never be visible.  A non-inset 3px bar sits just outside
        // the row's box, where nothing paints over it.
        if (targetInfo.isFlexRow) {
          const rowEl = targetInfo.element;
          const rect = rowEl.getBoundingClientRect();
          const mid = rect.left + rect.width / 2;
          if (clientX !== undefined && clientX < mid) {
            rowEl.setCssStyles({ boxShadow: "-3px 0 0 0 #4a9eff" });
          } else {
            rowEl.setCssStyles({ boxShadow: "3px 0 0 0 #4a9eff" });
          }
          this.dropIndicatorEl = rowEl;
          return;
        }

        // Prefer .cm-line for indicator styling
        const indicatorEl = targetInfo.cmLine || targetInfo.element;
        if (!indicatorEl) return;

        if (clientX !== undefined && targetInfo.isImageLine) {
          const rect = indicatorEl.getBoundingClientRect();
          const mid = rect.left + rect.width / 2;
          if (clientX < mid) {
            indicatorEl.classList.add("diaa-drop-left");
            applyDropIndicator(indicatorEl, "left");
          } else {
            indicatorEl.classList.add("diaa-drop-right");
            applyDropIndicator(indicatorEl, "right");
          }
        } else {
          indicatorEl.classList.add("diaa-drop-target-line");
          applyDropIndicator(indicatorEl, "line");
        }
        this.dropIndicatorEl = indicatorEl;
      }

      private setup() {
        this.editorEl = this.view.dom;

        // ── dragstart: capture on WINDOW. Store exact source line via posAtDOM.
        this.onDragStart = (e: DragEvent) => {
          const target = e.target as HTMLElement;
          const embed = target?.closest?.<HTMLElement>(".internal-embed.image-embed");
          if (!embed) {
            // Check if this is a flex row item drag (should not be intercepted here)
            const flexItem = target?.closest?.<HTMLElement>(".diaa-item");
            log.info("SD dragstart: not an obsidian embed", {
              targetTag: target?.tagName,
              targetClass: target?.className?.substring?.(0, 60) || "",
              isFlexItem: !!flexItem,
            });
            return;
          }

          const root = embed.getRootNode();
          const domNode: Element = root.instanceOf(ShadowRoot) ? root.host : embed;

          const pos = this.view.posAtDOM(domNode);
          if (pos < 0) {
            log.info("SD dragstart: posAtDOM failed", {
              tag: domNode.tagName,
              shadowRoot: root.instanceOf(ShadowRoot),
            });
            return;
          }

          const line = this.view.state.doc.lineAt(pos).number - 1;
          e.dataTransfer!.setData("application/diaa-source", String(line));

          // Configurable opacity on the original image during drag
          embed.style.opacity = String(1 - getSettings().dragOpacity / 100);
          const restoreOpacity = () => { embed.setCssStyles({ opacity: "" }); };
          embed.addEventListener("dragend", restoreOpacity, { once: true });

          // Custom fully-opaque ghost that follows cursor via dragover
          const img = embed.querySelector("img");
          const cleanupGhost = createDragGhost(img, e, getSettings().ghostImageWidth);
          embed.addEventListener("dragend", cleanupGhost, { once: true });

          log.info("SD dragstart stored source line", { line, tag: domNode.tagName });
        };

        // ── dragover: capture on WINDOW, show drop target indicator ──
        this.onDragOver = (e: DragEvent) => {
          const hasDiaaSource = e.dataTransfer?.types.includes("application/diaa-source");
          const hasDiaaRow = e.dataTransfer?.types.includes("application/diaa-row");

          if (!hasDiaaSource && !hasDiaaRow) return;

          // For diaa-row: skip if target is inside a flex row (widget handles it)
          if (hasDiaaRow) {
            const targetEl = e.target as HTMLElement;
            if (targetEl?.closest?.(".diaa-row")) {
              this.clearDropIndicator();
              return;
            }
          }

          if (!this.dragoverLogged) {
            this.dragoverLogged = true;
            log.info("SD dragover first", { hasDiaaSource, hasDiaaRow });
          }

          // Use elementFromPoint for reliable detection of image embeds and flex rows
          const targetInfo = this.findDropTarget(e.clientX, e.clientY);
          if (!targetInfo) {
            this.clearDropIndicator();
            return;
          }

          e.preventDefault();
          e.dataTransfer!.dropEffect = "move";
          this.showDropIndicator(targetInfo, e.clientX);
        };

        // ── drop: capture on WINDOW, handle standalone → standalone and flex-row → standalone ──
        this.onDrop = (e: DragEvent) => {
          this.clearDropIndicator();

          const textPlain = e.dataTransfer?.getData("text/plain") || "";

          log.info("SD drop enter", {
            hasDiaaSource: e.dataTransfer?.types.includes("application/diaa-source"),
            textPlain: textPlain.substring(0, 60),
          });

          // ── Flex row → standalone / blank line ──
          if (textPlain.startsWith("diaa-row:")) {
            const rowMatch = textPlain.match(/^diaa-row:(\d+):(\d+)$/);
            if (!rowMatch) return;

            // Skip if target is inside a flex row (widget handles inter-row merge)
            const targetEl = e.target as HTMLElement;
            if (targetEl?.closest?.(".diaa-row")) return;

            const srcLineStart = parseInt(rowMatch[1], 10);
            const srcIndex = parseInt(rowMatch[2], 10);
            const srcLine = srcLineStart + srcIndex;

            // Use elementFromPoint for reliable target detection
            const dropTarget = this.findDropTarget(e.clientX, e.clientY);
            if (!dropTarget || dropTarget.isFlexRow) return;

            let targetLine = dropTarget.line;

            // When dropping on an image line, compute left/right placement
            if (dropTarget.isImageLine) {
              const rect = dropTarget.element.getBoundingClientRect();
              const mid = rect.left + rect.width / 2;
              if (e.clientX >= mid) targetLine = dropTarget.line + 1;
            }

            if (srcLine === targetLine) return;

            log.info("SD flex-row → standalone: moveLine", {
              srcLine, targetLine, dropLine: dropTarget.line, isImageLine: dropTarget.isImageLine,
            });

            e.preventDefault();
            e.stopPropagation();
            moveLine(this.view, srcLine, targetLine);
            // Identity transition (multi member → single): strip the dragged line
            // and any source-row leftover that just became single to bare, now.
            const sdSettings = getSettings();
            convertOrphanedMultiSinglesToBare(this.view, sdSettings.maxImagesPerRow, sdSettings.imageExtensions);
            return;
          }

          // ── Standalone → standalone (with left/right placement on image lines) ──
          if (!e.dataTransfer?.types.includes("application/diaa-source")) return;

          // Skip if target is inside a flex row (widget handles merge)
          if ((e.target as HTMLElement)?.closest?.(".diaa-row")) return;

          const srcLine = parseInt(e.dataTransfer.getData("application/diaa-source"), 10);
          if (isNaN(srcLine)) {
            log.info("SD drop: could not parse source line from diaa-source");
            return;
          }

          // Use elementFromPoint for reliable image embed detection
          const dropTarget = this.findDropTarget(e.clientX, e.clientY);
          let baseTargetLine: number;
          let targetLine: number;
          let side = "left";

          if (dropTarget) {
            baseTargetLine = dropTarget.line;
            if (dropTarget.isImageLine) {
              const rect = dropTarget.element.getBoundingClientRect();
              const mid = rect.left + rect.width / 2;
              if (e.clientX >= mid) {
                targetLine = baseTargetLine + 1;
                side = "right";
              } else {
                targetLine = baseTargetLine;
              }
            } else {
              targetLine = baseTargetLine;
            }
          } else {
            const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY });
            if (pos === null) return;
            baseTargetLine = this.view.state.doc.lineAt(pos).number - 1;
            targetLine = baseTargetLine;
          }

          if (srcLine === targetLine) return;

          log.info("SD standalone → standalone: moveLine", {
            srcLine, targetLine, baseTargetLine, side,
          });

          e.preventDefault();
          e.stopPropagation();
          moveLine(this.view, srcLine, targetLine);
        };

        // ── dragleave: clear indicator when leaving the editor ──
        this.onDragLeave = (e: DragEvent) => {
          if (!e.dataTransfer?.types.includes("application/diaa-source") &&
              !e.dataTransfer?.types.includes("application/diaa-row")) return;
          const relatedTarget = e.relatedTarget as Node | null;
          if (!relatedTarget || !this.view.dom.contains(relatedTarget)) {
            this.clearDropIndicator();
          }
        };

        // ── dragend: cleanup in case of cancel (Escape) ──
        this.onDragEnd = (_e: DragEvent) => {
          this.clearDropIndicator();
        };

        window.addEventListener("dragstart", this.onDragStart, true);
        window.addEventListener("dragover", this.onDragOver, true);
        window.addEventListener("dragleave", this.onDragLeave, true);
        window.addEventListener("dragend", this.onDragEnd, true);
        window.addEventListener("drop", this.onDrop, true);
        log.info("SD setup complete: handlers on window capture", {
          domTag: this.view.dom?.tagName,
        });
      }
    }
  );
}
