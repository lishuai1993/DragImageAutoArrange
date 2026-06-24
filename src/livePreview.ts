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
  Prec,
  Annotation,
} from "@codemirror/state";
import { editorLivePreviewField } from "obsidian";
import { detectImageGroups } from "./imageDetector";
import type { ImageGroup } from "./imageDetector";
import { ImageRowWidget, ImageRowOptions } from "./imageRowWidget";
import { DragImageSettings } from "./settings";
import { logger } from "./logger";

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
  targetGroup: ImageGroup
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

    logger.debug("findStandaloneImageLine parsing URI", {
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
        logger.debug("findStandaloneImageLine found", { line: i - 1, lineText: lineText.substring(0, 60) });
        return i - 1; // 0-indexed
      }
    }
    return null;
  } catch (e) {
    logger.error("findStandaloneImageLine error", { error: String(e) });
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
  targetGroup: ImageGroup
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
  const insertAt = localTarget;
  originalLines.splice(insertAt, 0, moved);

  const insert = originalLines.join("\n") + (hadTrailingNewline ? "\n" : "");

  logger.info("LivePreview moveLine", {
    srcLine, targetLine, minLine, maxLine,
    fromPos, toPos,
    lineCount: originalLines.length + 1,
  });

  view.dispatch({
    changes: { from: fromPos, to: toPos, insert },
  });
}

/**
 * CodeMirror Widget that renders a flex row of images with interactive features.
 */
class StaticImageRowWidget extends WidgetType {
  private group: ImageGroup;
  private options: ImageRowOptions;
  private innerWidget: ImageRowWidget | null = null;
  private editorView: EditorView | null = null;

  constructor(group: ImageGroup, options: ImageRowOptions) {
    super();
    this.group = group;
    this.options = options;
    logger.debug("StaticImageRowWidget constructed", {
      imageCount: group.images.length,
      lineStart: group.lineStart,
      lineEnd: group.lineEnd,
    });
  }

  eq(other: StaticImageRowWidget): boolean {
    const a = this.group;
    const b = other.group;
    if (a.images.length !== b.images.length) return false;
    if (a.lineStart !== b.lineStart) return false;
    if (a.lineEnd !== b.lineEnd) return false;
    if (this.options.snapSensitivity !== other.options.snapSensitivity) return false;
    if (this.options.ghostImageWidth !== other.options.ghostImageWidth) return false;
    if (this.options.topBarSensitivity !== other.options.topBarSensitivity) return false;
    if (this.options.dragOpacity !== other.options.dragOpacity) return false;
    for (let i = 0; i < a.images.length; i++) {
      if (a.images[i].raw !== b.images[i].raw) return false;
    }
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    try {
      logger.debug("StaticImageRowWidget toDOM", {
        imageCount: this.group.images.length,
        files: this.group.images.map((i) => i.fileName),
      });
      this.editorView = view;
      this.innerWidget = new ImageRowWidget(this.group, this.options);
      const el = this.innerWidget.build();

      // Notify CodeMirror when the widget height changes after images load
      this.innerWidget.onLayoutChange = () => {
        this.editorView?.requestMeasure();
      };

      // Set up drag reorder within this row
      this.innerWidget.onReorder((fromIndex, toIndex) => {
        this.handleReorder(fromIndex, toIndex);
      });
      this.innerWidget.enableDragReorder();

      // Persist flex-grow changes back to markdown on drag end
      this.innerWidget.onPersist(() => {
        this.persistFlexGrows();
      });

      // Handle cross-row merge: drag a standalone image into this row
      this.innerWidget.onMergeExternal((insertAtIndex, dataTransfer) => {
        this.handleMergeExternal(insertAtIndex, dataTransfer);
      });

      return el;
    } catch (e) {
      logger.error("StaticImageRowWidget toDOM error", { error: String(e) });
      const fallback = document.createElement("span");
      fallback.textContent = "(image row render error)";
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

    logger.info("LivePreview drag reorder", {
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
    logger.debug("LivePreview post-reorder doc", {
      docLines: view.state.doc.lines,
      docLength: view.state.doc.length,
      docPreview: newDoc.substring(0, 500),
    });

    // Diagnostic: check DOM for leaked Obsidian image embeds after reorder
    const capturedView = view;
    requestAnimationFrame(() => {
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
        logger.debug("LivePreview post-reorder DOM check", {
          embedCount: allEmbeds.length,
          cmLineCount: capturedView.dom.querySelectorAll(".cm-line").length,
          embeds: embedInfo,
        });
      } catch (err) {
        logger.debug("LivePreview post-reorder DOM check error", {
          error: String(err),
        });
      }
    });
  }

  /**
   * Merge an image from another location into this flex row.
   * Supports both standalone (obsidian://open) and flex-row ("diaa-row:") sources.
   */
  private handleMergeExternal(insertAtIndex: number, dataTransfer: string): void {
    if (!this.editorView) return;
    const view = this.editorView;

    // Resolve source line from dataTransfer
    const srcLine = resolveSourceLine(view, dataTransfer, this.group);
    if (srcLine === null) {
      logger.debug("LivePreview mergeExternal: could not resolve source");
      return;
    }

    const targetLine = this.group.lineStart + insertAtIndex;
    if (srcLine === targetLine) return;

    logger.info("LivePreview cross-row merge", {
      srcLine, targetLine, insertAtIndex,
      dataTransfer: dataTransfer.substring(0, 40),
    });

    moveLine(view, srcLine, targetLine);
  }

  updateDOM(_element: HTMLElement, _view: EditorView): boolean {
    return false;
  }

  ignoreEvent(event: Event): boolean {
    return event.type.startsWith("drag");
  }

  destroy(): void {
    logger.debug("StaticImageRowWidget destroyed");
    this.innerWidget?.destroy();
    this.innerWidget = null;
  }

  /** Write current flex-grow values back to markdown as ![[file|width]]. */
  private persistFlexGrows(): void {
    if (!this.editorView || !this.innerWidget) return;

    const view = this.editorView;
    const images = this.group.images;
    const grows = this.innerWidget.getCurrentFlexGrows();

    // Collect line-level changes (descending order so positions stay valid)
    const changes: Array<{ from: number; to: number; insert: string }> = [];
    for (let i = 0; i < grows.length && i < images.length; i++) {
      const newLine = updateImageLineWidth(images[i].raw, grows[i]);
      if (newLine === images[i].raw) continue;

      const line = images[i].line + 1; // 1-indexed
      const pos = view.state.doc.line(line).from;
      changes.push({ from: pos, to: pos + images[i].raw.length, insert: newLine });
    }

    if (changes.length === 0) return;

    // Apply from bottom to top so earlier positions stay valid
    changes.sort((a, b) => b.from - a.from);
    view.dispatch({ changes });
  }
}

/** Replace or remove the |width parameter in an image embed line. */
function updateImageLineWidth(raw: string, flexGrow: number): string {
  const widthValue = Math.round(flexGrow * 100);
  // Strip everything between file extension and ]] (handles |width, |WxH, |width|WxH)
  let out = raw.replace(/\|[^\]]*(?=\]\])/, "");
  if (widthValue === 100) return out; // default → omit
  return out.replace(/\]\]/, `|${widthValue}]]`);
}

// ── State field for decorations ─────────────────────────────────

function buildDecorations(
  state: EditorView["state"],
  getOptions: () => ImageRowOptions,
  getSettings: () => DragImageSettings,
  isEnabled: () => boolean
): DecorationSet {
  try {
    if (!isEnabled()) {
      logger.debug("LivePreview decorations skipped (disabled)");
      return Decoration.none;
    }

    // Skip in source mode: editorLivePreviewField is only present/true in Live Preview
    if (!state.field(editorLivePreviewField, false)) {
      logger.debug("LivePreview decorations skipped (source mode)");
      return Decoration.none;
    }

    const doc = state.doc.toString();
    if (!doc) return Decoration.none;

    const settings = getSettings();
    const baseOptions = getOptions();

    const options = baseOptions;

    const groups = detectImageGroups(
      doc,
      settings.maxImagesPerRow,
      settings.imageExtensions
    );

    logger.debug("LivePreview buildDecorations", {
      groupCount: groups.length,
      enabled: isEnabled(),
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
          logger.debug("LivePreview skipping group (out of range)", {
            lineStart1, lineEnd1, lineCount,
          });
          continue;
        }

        const from = state.doc.line(lineStart1).from;
        const to = lineEnd1 < lineCount
          ? state.doc.line(lineEnd1 + 1).from
          : state.doc.length;

        logger.debug("LivePreview decoration range", {
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
          logger.debug("LivePreview skipping group (to <= from)", { from, to });
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
        logger.error("LivePreview widget creation error", {
          groupLineStart: group.lineStart,
          error: String(e),
        });
      }
    }

    const result = builder.finish();
    logger.debug("LivePreview decorations built", {
      decorationAdded,
      setSize: result.size,
    });
    return result;
  } catch (e) {
    logger.error("LivePreview buildDecorations error", { error: String(e) });
    return Decoration.none;
  }
}

/** Dispatch this annotation to force a decoration rebuild (e.g. after settings change). */
export const settingsChanged = Annotation.define<boolean>();

export function createLivePreviewPlugin(
  getOptions: () => ImageRowOptions,
  getSettings: () => DragImageSettings,
  isEnabled: () => boolean
) {
  // Track Live Preview state so we can rebuild decorations on mode switch
  let wasLivePreview = false;

  const field = StateField.define<DecorationSet>({
    create(state) {
      wasLivePreview = !!state.field(editorLivePreviewField, false);
      logger.debug("LivePreview StateField create", { wasLivePreview });
      return buildDecorations(state, getOptions, getSettings, isEnabled);
    },
    update(_oldDecos, tr) {
      const isLivePreview = !!tr.state.field(editorLivePreviewField, false);
      if (tr.docChanged || tr.annotation(settingsChanged) || wasLivePreview !== isLivePreview) {
        wasLivePreview = isLivePreview;
        return buildDecorations(tr.state, getOptions, getSettings, isEnabled);
      }
      return _oldDecos;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  return Prec.highest(field);
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
  getSettings: () => DragImageSettings,
  isEnabled: () => boolean
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
      private dropSide: "left" | "right" | null = null;

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
          this.dropIndicatorEl.style.boxShadow = "";
          this.dropIndicatorEl = null;
        }
        this.dropSide = null;
      }

      private findDropTarget(clientX: number, clientY: number) {
        const targetEl = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
        if (!targetEl || !this.view.dom.contains(targetEl)) return null;

        // Detect flex row widgets (our custom DOM, spans multiple lines)
        const flexRow = targetEl.closest(".drag-img-row") as HTMLElement | null;
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

        const embed = targetEl.closest(".internal-embed.image-embed") as HTMLElement | null;
        const cmLine = targetEl.closest(".cm-line") as HTMLElement | null;
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

      private showDropIndicator(targetInfo: any, clientX?: number) {
        this.clearDropIndicator();
        if (!targetInfo) return;

        // Flex row target: highlight the entire row
        if (targetInfo.isFlexRow) {
          const rowEl = targetInfo.element as HTMLElement;
          const rect = rowEl.getBoundingClientRect();
          const mid = rect.left + rect.width / 2;
          if (clientX !== undefined && clientX < mid) {
            rowEl.style.boxShadow = "inset 3px 0 0 #4a9eff";
            this.dropSide = "left";
          } else {
            rowEl.style.boxShadow = "inset -3px 0 0 #4a9eff";
            this.dropSide = "right";
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
            this.dropSide = "left";
          } else {
            indicatorEl.classList.add("diaa-drop-right");
            this.dropSide = "right";
          }
        } else {
          indicatorEl.classList.add("diaa-drop-target-line");
        }
        this.dropIndicatorEl = indicatorEl;
      }

      private setup() {
        this.editorEl = this.view.dom;

        // ── dragstart: capture on WINDOW. Store exact source line via posAtDOM.
        this.onDragStart = (e: DragEvent) => {
          const target = e.target as HTMLElement;
          const embed = target?.closest?.(".internal-embed.image-embed") as HTMLElement | null;
          if (!embed) {
            // Check if this is a flex row item drag (should not be intercepted here)
            const flexItem = target?.closest?.(".drag-img-item") as HTMLElement | null;
            logger.info("SD dragstart: not an obsidian embed", {
              targetTag: target?.tagName,
              targetClass: target?.className?.substring?.(0, 60) || "",
              isFlexItem: !!flexItem,
            });
            return;
          }

          const root = embed.getRootNode();
          const domNode: Element = root instanceof ShadowRoot ? root.host : embed;

          const pos = this.view.posAtDOM(domNode as Node);
          if (pos < 0) {
            logger.info("SD dragstart: posAtDOM failed", {
              tag: domNode.tagName,
              shadowRoot: root instanceof ShadowRoot,
            });
            return;
          }

          const line = this.view.state.doc.lineAt(pos).number - 1;
          e.dataTransfer!.setData("application/diaa-source", String(line));

          // Configurable opacity on the original image during drag
          embed.style.opacity = String(1 - getSettings().dragOpacity / 100);
          const restoreOpacity = () => { embed.style.opacity = ""; };
          embed.addEventListener("dragend", restoreOpacity, { once: true });

          // Custom fully-opaque ghost that follows cursor via dragover
          const img = embed.querySelector("img") as HTMLImageElement | null;
          if (img && img.naturalWidth > 0) {
            // Hide browser's default semi-transparent ghost with a transparent 1x1 pixel
            const pixel = document.createElement("canvas");
            pixel.width = 1;
            pixel.height = 1;
            pixel.style.cssText = "position:fixed;left:0;top:0;pointer-events:none";
            document.body.appendChild(pixel);
            e.dataTransfer!.setDragImage(pixel, 0, 0);
            setTimeout(() => pixel.remove(), 0);

            // Custom fully-opaque ghost, initially at cursor (with DPR for sharpness)
            const w = getSettings().ghostImageWidth;
            const h = (img.naturalHeight / img.naturalWidth) * w;
            const dpr = window.devicePixelRatio || 1;
            const ghost = document.createElement("canvas");
            ghost.width = w * dpr;
            ghost.height = h * dpr;
            ghost.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;width:${w}px;height:${h}px;pointer-events:none;z-index:2147483647`;
            const ctx = ghost.getContext("2d")!;
            ctx.scale(dpr, dpr);
            ctx.drawImage(img, 0, 0, w, h);
            document.body.appendChild(ghost);

            const onDragOver = (ev: DragEvent) => {
              ghost.style.left = ev.clientX + "px";
              ghost.style.top = ev.clientY + "px";
            };
            const onDragEnd = () => {
              document.removeEventListener("dragover", onDragOver, true);
              ghost.remove();
              embed.style.opacity = "";
            };
            document.addEventListener("dragover", onDragOver, true);
            embed.addEventListener("dragend", onDragEnd, { once: true });
          }

          logger.info("SD dragstart stored source line", { line, tag: domNode.tagName });
        };

        // ── dragover: capture on WINDOW, show drop target indicator ──
        this.onDragOver = (e: DragEvent) => {
          const hasDiaaSource = e.dataTransfer?.types.includes("application/diaa-source");
          const hasDiaaRow = e.dataTransfer?.types.includes("application/diaa-row");

          if (!hasDiaaSource && !hasDiaaRow) return;

          // For diaa-row: skip if target is inside a flex row (widget handles it)
          if (hasDiaaRow) {
            const targetEl = e.target as HTMLElement;
            if (targetEl?.closest?.(".drag-img-row")) {
              this.clearDropIndicator();
              return;
            }
          }

          if (!this.dragoverLogged) {
            this.dragoverLogged = true;
            logger.info("SD dragover first", { hasDiaaSource, hasDiaaRow });
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

          logger.info("SD drop enter", {
            hasDiaaSource: e.dataTransfer?.types.includes("application/diaa-source"),
            textPlain: textPlain.substring(0, 60),
          });

          if (!isEnabled()) return;

          // ── Flex row → standalone / blank line ──
          if (textPlain.startsWith("diaa-row:")) {
            const rowMatch = textPlain.match(/^diaa-row:(\d+):(\d+)$/);
            if (!rowMatch) return;

            // Skip if target is inside a flex row (widget handles inter-row merge)
            const targetEl = e.target as HTMLElement;
            if (targetEl?.closest?.(".drag-img-row")) return;

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

            logger.info("SD flex-row → standalone: moveLine", {
              srcLine, targetLine, dropLine: dropTarget.line, isImageLine: dropTarget.isImageLine,
            });

            e.preventDefault();
            e.stopPropagation();
            moveLine(this.view, srcLine, targetLine);
            return;
          }

          // ── Standalone → standalone (with left/right placement on image lines) ──
          if (!e.dataTransfer?.types.includes("application/diaa-source")) return;

          // Skip if target is inside a flex row (widget handles merge)
          if ((e.target as HTMLElement)?.closest?.(".drag-img-row")) return;

          const srcLine = parseInt(e.dataTransfer!.getData("application/diaa-source"), 10);
          if (isNaN(srcLine)) {
            logger.info("SD drop: could not parse source line from diaa-source");
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

          logger.info("SD standalone → standalone: moveLine", {
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
        logger.info("SD setup complete: handlers on window capture", {
          domTag: this.view.dom?.tagName,
        });
      }
    }
  );
}
