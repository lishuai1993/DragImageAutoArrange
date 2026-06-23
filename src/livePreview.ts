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
} from "@codemirror/state";
import { detectImageGroups } from "./imageDetector";
import type { ImageGroup } from "./imageDetector";
import { ImageRowWidget, ImageRowOptions } from "./imageRowWidget";
import { DragImageSettings } from "./settings";
import { logger } from "./logger";

/**
 * CodeMirror Widget that renders a static flex row of images.
 * Interactive features (drag, resize, divider) are Reading Mode only.
 */
class StaticImageRowWidget extends WidgetType {
  private group: ImageGroup;
  private options: ImageRowOptions;
  private innerWidget: ImageRowWidget | null = null;

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
    for (let i = 0; i < a.images.length; i++) {
      if (a.images[i].raw !== b.images[i].raw) return false;
    }
    return true;
  }

  toDOM(_view: EditorView): HTMLElement {
    try {
      logger.debug("StaticImageRowWidget toDOM", {
        imageCount: this.group.images.length,
        files: this.group.images.map((i) => i.fileName),
      });
      this.innerWidget = new ImageRowWidget(this.group, this.options);
      return this.innerWidget.build();
    } catch (e) {
      logger.error("StaticImageRowWidget toDOM error", { error: String(e) });
      const fallback = document.createElement("span");
      fallback.textContent = "(image row render error)";
      return fallback;
    }
  }

  updateDOM(_element: HTMLElement, _view: EditorView): boolean {
    return false;
  }

  ignoreEvent(event: Event): boolean {
    return event.type === "dragstart" || event.type === "dragover" ||
           event.type === "dragend"   || event.type === "drop" ||
           event.type === "dragleave" || event.type === "dragenter";
  }

  destroy(): void {
    logger.debug("StaticImageRowWidget destroyed");
    this.innerWidget?.destroy();
    this.innerWidget = null;
  }
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

    const doc = state.doc.toString();
    if (!doc) return Decoration.none;

    const settings = getSettings();
    const baseOptions = getOptions();

    const staticOptions: ImageRowOptions = {
      ...baseOptions,
      enableDividers: false,
      enableResize: false,
    };

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
    });

    const builder = new RangeSetBuilder<Decoration>();
    let decorationAdded = false;

    for (const group of groups) {
      try {
        if (group.images.length < 2) continue;

        const lineCount = state.doc.lines;
        const lineStart1 = group.lineStart + 1;
        const lineEnd1 = group.lineEnd;

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
            widget: new StaticImageRowWidget(group, staticOptions),
            block: true,
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
      if (tr.docChanged) {
        logger.debug("LivePreview StateField recomputing (docChanged)");
        return buildDecorations(tr.state, getOptions, getSettings, isEnabled);
      }
      return _oldDecos;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  return Prec.highest(field);
}
