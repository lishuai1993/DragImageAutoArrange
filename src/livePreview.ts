import {
  Decoration,
  DecorationSet,
  EditorView,
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
  // Strip existing |width parameter
  let out = raw.replace(/\|(\d+)(\]\])/, "$2");
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
        if (group.images.length < 2) continue;

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
  const field = StateField.define<DecorationSet>({
    create(state) {
      logger.debug("LivePreview StateField create");
      return buildDecorations(state, getOptions, getSettings, isEnabled);
    },
    update(_oldDecos, tr) {
      if (tr.docChanged || tr.annotation(settingsChanged)) {
        return buildDecorations(tr.state, getOptions, getSettings, isEnabled);
      }
      return _oldDecos;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  return Prec.highest(field);
}
