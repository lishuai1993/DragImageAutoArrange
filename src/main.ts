import { Plugin, MarkdownView } from "obsidian";
import {
  DragImageSettings,
  DragImageSettingTab,
  IDragImagePlugin,
  loadSettings,
} from "./settings";
import { createReadingModeProcessor } from "./readingMode";
import { schedulePendingFlush, onViewModeChange, invalidateImageRowIndex, installEarlyModeSwitchRestore } from "./scrollSync/scrollAnchor";
import { scheduleWarmupProbe, cancelWarmupProbe } from "./scrollSync/warmupProbe";
import { createLivePreviewPlugin, createStandaloneDropPlugin, settingsChanged, resetSingleImageManualFlags, resetImageAlignmentFlags } from "./livePreview";
import { exportPreservedSizes, importPreservedSizes } from "./imageRowWidget";
import { ImageRowOptions } from "./types";
import { showImageAlignmentMenu } from "./alignmentContextMenu";
import { logger } from "./logger";

export default class DragImageAutoArrangePlugin
  extends Plugin
  implements IDragImagePlugin
{
  settings: DragImageSettings = {
    enabled: false,
    defaultRowHeight: 200,
    maxImagesPerRow: 10,
    gapSize: 4,
    snapSensitivity: 3,
    enableDragReorder: true,
    enableResize: true,
    enableDividers: true,
    imageExtensions: "png,jpg,jpeg,gif,webp,svg,bmp,avif",
    topBarSensitivity: 12,
    ghostImageWidth: 120,
    dragOpacity: 60,
    alignment: "left",
    singleImageSizeMode: "natural",
    singleImageWidth: 400,
    enableReadingModeContextMenu: true,
  };

  async onload(): Promise<void> {
    // Init file logger (hardcoded path for debugging)
    await logger.init(
      this.app.vault.adapter,
      ".obsidian/plugins/obsidian-DragImageAutoArrange/log.txt"
    );
    logger.info("Plugin loading", { version: this.manifest.version });

    // ── Per-image alignment context menu ──────────────────────────────
    // Registered at document level in capture phase so it runs BEFORE any
    // other plugin's contextmenu handler (including those on CodeMirror
    // or editor wrappers that would otherwise intercept the event).
    document.addEventListener("contextmenu", (e) => {
      const target = e.target as HTMLElement;
      if (!target?.tagName) return;

      // Find the nearest DIAA-managed <img> — either the target itself
      // or an ancestor img that has the __diaa_onAlign callback stored.
      const img = (target.tagName === "IMG" && (target as any).__diaa_onAlign)
        ? target as HTMLImageElement
        : target.closest?.("img") as HTMLImageElement | null;

      if (!img || !(img as any).__diaa_onAlign) return;

      // When RM context menu is disabled, silently pass through in Reading Mode
      if (!this.settings.enableReadingModeContextMenu && img.closest(".markdown-preview-view")) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      const alignment = (img as any).__diaa_alignment as "left" | "center" | "right" | undefined;
      const onAlign = (img as any).__diaa_onAlign as (a: "left" | "center" | "right" | undefined) => void;
      showImageAlignmentMenu(e, alignment, onAlign);
    }, true);

    this.settings = await loadSettings(this);
    // Restore preserved per-image sizes from previous session
    const rawData = await this.loadData();
    if (rawData?.preservedSizes) {
      importPreservedSizes(rawData.preservedSizes);
      logger.info("Preserved multi-image sizes restored from previous session");
    }
    logger.info("Settings loaded", {
      enabled: this.settings.enabled,
      maxImagesPerRow: this.settings.maxImagesPerRow,
      defaultRowHeight: this.settings.defaultRowHeight,
      gapSize: this.settings.gapSize,
      imageExtensions: this.settings.imageExtensions,
      enableDragReorder: this.settings.enableDragReorder,
      enableResize: this.settings.enableResize,
      enableDividers: this.settings.enableDividers,
    });

    this.addSettingTab(
      new DragImageSettingTab(this.app, this as IDragImagePlugin)
    );

    // Reading Mode processor with drag-to-merge support
    this.registerMarkdownPostProcessor(
      createReadingModeProcessor(
        this.app,
        () => this.buildImageRowOptions(),
        () => this.settings.enabled
      )
    );
    logger.info("Reading Mode processor registered");

    // Flush buffered RM alignment changes and drive cross-mode scroll
    // restore when the user switches views (RM ↔ LP).
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        schedulePendingFlush(this.app);
        onViewModeChange(this.app);
      })
    );

    // Approach X (Phase 1): restore scroll in the pre-paint frame of the
    // incoming view (via the setState hook) so mode switches don't flash the
    // native scroll position. Keeps Step-3.1 logging for verification. Removed
    // on unload.
    this.register(installEarlyModeSwitchRestore(this.app));

    // Warm-up probe (TEMPORARY, see warmupProbe.ts): background-render the
    // real previewMode shortly after a tab opens in LP, so the first real
    // LP→RM switch takes the hot path. Triggered on layout-ready (restored
    // tabs after restart) and on every file-open.
    this.app.workspace.onLayoutReady(() => scheduleWarmupProbe(this.app));
    this.registerEvent(
      this.app.workspace.on("file-open", () => scheduleWarmupProbe(this.app))
    );
    this.register(() => cancelWarmupProbe());

    // Invalidate the cached image-row index when the LP document changes.
    // ensureImageRowIndexFromCM only builds the index on a cache miss, so
    // adding/removing an image line in LP would otherwise leave stale line
    // ranges and misalign the next cross-mode scroll restore.
    this.registerEvent(
      this.app.workspace.on("editor-change", (_editor, info) => {
        const path = (info as any)?.file?.path;
        if (path) invalidateImageRowIndex(path);
      })
    );

    // Live Preview editor extension (CodeMirror ViewPlugin)
    this.registerEditorExtension(
      createLivePreviewPlugin(
        () => this.buildImageRowOptions(),
        () => this.settings,
        () => this.settings.enabled
      )
    );
    logger.info("Live Preview extension registered");

    // Standalone line drop handler (flex row → standalone)
    this.registerEditorExtension(
      createStandaloneDropPlugin(
        () => this.settings,
        () => this.settings.enabled
      )
    );
    logger.info("Standalone drop plugin registered");

    // Command: rescan image groups
    this.addCommand({
      id: "rescan-image-groups",
      name: "Rescan image groups in current note",
      editorCallback: (_editor, view) => {
        logger.info("Command: rescan-image-groups");
        if (view instanceof MarkdownView && view.previewMode) {
          view.previewMode.rerender(true);
        } else {
          _editor.refresh();
        }
      },
    });

    // Command: toggle auto-arrange
    this.addCommand({
      id: "toggle-image-arrange",
      name: "Toggle image auto-arrange (on/off)",
      callback: async () => {
        this.settings.enabled = !this.settings.enabled;
        logger.info("Command: toggle-image-arrange", {
          newValue: this.settings.enabled,
        });
        await this.saveSettings();
        const leaf = this.app.workspace.activeLeaf;
        if (leaf) {
          const state = leaf.getViewState();
          await leaf.setViewState({ type: state.type, state: state.state });
        }
      },
    });

    logger.info("Plugin loaded successfully");
  }

  async onunload(): Promise<void> {
    logger.info("Plugin unloading");
    await logger.dispose();
  }

  async saveSettings(): Promise<void> {
    await this.saveData({
      settings: this.settings,
      preservedSizes: exportPreservedSizes(),
    });
    // Notify both Live Preview and Reading Mode views so they rebuild with fresh options
    this.app.workspace.iterateAllLeaves((leaf) => {
      // Live Preview / Source mode: dispatch settingsChanged annotation to rebuild decorations
      const cm = (leaf.view as any)?.editor?.cm;
      if (cm?.dispatch) {
        cm.dispatch({ annotations: [settingsChanged.of(true)] });
      }
      // Reading Mode: force re-render so post-processor picks up new alignment
      if (leaf.view instanceof MarkdownView && leaf.view.previewMode) {
        leaf.view.previewMode.rerender(true);
      }
    });
  }

  /**
   * One-shot "override": clear every single-image row's manual size (S=1→0) in
   * all open Live Preview editors, so each re-derives its width from the current
   * size setting on the ensuing rebuild.
   */
  resetAllSingleImages(): void {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const cm = (leaf.view as any)?.editor?.cm;
      if (cm?.dispatch) {
        resetSingleImageManualFlags(
          cm,
          this.settings.maxImagesPerRow,
          this.settings.imageExtensions
        );
      }
      if (leaf.view instanceof MarkdownView && leaf.view.previewMode) {
        leaf.view.previewMode.rerender(true);
      }
    });
    logger.info("Command: reset all single images to current setting");
  }

  resetAllImageAlignments(): void {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const cm = (leaf.view as any)?.editor?.cm;
      if (cm?.dispatch) {
        resetImageAlignmentFlags(
          cm,
          this.settings.maxImagesPerRow,
          this.settings.imageExtensions,
          this.settings.alignment
        );
      }
      if (leaf.view instanceof MarkdownView && leaf.view.previewMode) {
        leaf.view.previewMode.rerender(true);
      }
    });
    logger.info("Command: reset all image alignments to current setting");
  }

  private buildImageRowOptions(): ImageRowOptions {
    const activeFile = this.app.workspace.getActiveFile();
    const sourcePath = activeFile?.path ?? "";
    return {
      defaultRowHeight: this.settings.defaultRowHeight,
      gap: this.settings.gapSize,
      enableDividers: this.settings.enableDividers,
      enableResize: this.settings.enableResize,
      snapSensitivity: this.settings.snapSensitivity,
      topBarSensitivity: this.settings.topBarSensitivity,
      ghostImageWidth: this.settings.ghostImageWidth,
      dragOpacity: this.settings.dragOpacity,
      alignment: this.settings.alignment,
      maxImagesPerRow: this.settings.maxImagesPerRow,
      imageExtensions: this.settings.imageExtensions,
      singleImageSizeMode: this.settings.singleImageSizeMode,
      singleImageWidth: this.settings.singleImageWidth,
      getResourcePath: (fileName: string) => {
        const url = this.resolveImagePath(fileName, sourcePath);
        if (!url) {
          logger.debug("Image not found in vault", { fileName, sourcePath });
        }
        return url;
      },
      sourcePath,
    };
  }

  private resolveImagePath(fileName: string, sourcePath: string): string {
    const decoded = decodeURIComponent(fileName);
    const file = this.app.metadataCache.getFirstLinkpathDest(decoded, sourcePath);
    if (file) {
      return this.app.vault.getResourcePath(file);
    }
    return "";
  }
}
