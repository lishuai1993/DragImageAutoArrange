import { Plugin, MarkdownView } from "obsidian";
import {
  DragImageSettings,
  DragImageSettingTab,
  IDragImagePlugin,
  loadSettings,
} from "./settings";
import { createReadingModeProcessor } from "./imageRender/readingMode";
import { schedulePendingFlush, onViewModeChange, invalidateImageRowIndex, installEarlyModeSwitchRestore } from "./scrollSync/scrollAnchor";
import { runWarmup, cancelWarmupProbe } from "./scrollSync/warmupProbe";
import {
  registerWarmupRunner, installUserActivityListener,
  requestP0Warmup, requestGlobalWarmup, cancelAllWarmups,
  recordRMSwitch, scheduleIdleWarmup,
} from "./scrollSync/warmupScheduler";
import { createLivePreviewPlugin, createStandaloneDropPlugin, settingsChanged, resetSingleImageManualFlags, resetImageAlignmentFlags } from "./imageRender/livePreview";
import { exportPreservedSizes, importPreservedSizes } from "./imageRender/imageRowWidget";
import { ImageRowOptions } from "./types";
import { showImageAlignmentMenu } from "./interaction/alignmentContextMenu";
import { logger } from "./logger";
const log = logger.channel("main");

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
    log.info("Plugin loading", { version: this.manifest.version });

    // ── Log filter: only these channels write to log.txt ─────────────
    // Comment out to write all channels, or adjust the list to focus on
    // the module you're currently debugging.
    logger.setFileOutputFilter([
      "main",
      "scrollAnchor",
      "warmupProbe",
      "warmupScheduler",
    ]);

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
      log.info("Preserved multi-image sizes restored from previous session");
    }
    log.info("Settings loaded", {
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
    log.info("Reading Mode processor registered");

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

    // ── Global warmup scheduler ──────────────────────────────────────
    registerWarmupRunner(runWarmup);
    this.register(installUserActivityListener());

    // P0: warm active tab after layout settles (restored tabs after restart).
    this.app.workspace.onLayoutReady(() => {
      const file = this.app.workspace.getActiveFile()?.path ?? "";
      requestP0Warmup(this.app, file);
      // P1/P2: queue the remaining tabs after a short delay (let P0 settle first).
      setTimeout(() => requestGlobalWarmup(this.app), 3000);
    });

    // P0: warm every newly-opened file immediately.
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file) requestP0Warmup(this.app, file.path);
      })
    );

    // Track RM switch frequency for P1 prioritisation.
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        const mode = (this.app.workspace.activeLeaf?.view as any)?.getMode?.() ?? "";
        const file = this.app.workspace.getActiveFile()?.path ?? "";
        if (mode === "preview" && file) recordRMSwitch(file);
      })
    );

    // Two-tier idle warmup + image-row index invalidation on editor change.
    // Coarse (1s idle): line-delta patch on snapshot. Fine (5s idle): full re-warmup.
    this.registerEvent(
      this.app.workspace.on("editor-change", (editor, info) => {
        const path = (info as any)?.file?.path;
        if (!path) return;
        invalidateImageRowIndex(path);
        scheduleIdleWarmup(this.app, path, editor.lineCount(), editor.getCursor().line);
      })
    );

    this.register(() => {
      cancelWarmupProbe();
      cancelAllWarmups();
    });

    // Live Preview editor extension (CodeMirror ViewPlugin)
    this.registerEditorExtension(
      createLivePreviewPlugin(
        () => this.buildImageRowOptions(),
        () => this.settings,
        () => this.settings.enabled
      )
    );
    log.info("Live Preview extension registered");

    // Standalone line drop handler (flex row → standalone)
    this.registerEditorExtension(
      createStandaloneDropPlugin(
        () => this.settings,
        () => this.settings.enabled
      )
    );
    log.info("Standalone drop plugin registered");

    // Command: rescan image groups
    this.addCommand({
      id: "rescan-image-groups",
      name: "Rescan image groups in current note",
      editorCallback: (_editor, view) => {
        log.info("Command: rescan-image-groups");
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
        log.info("Command: toggle-image-arrange", {
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

    log.info("Plugin loaded successfully");
  }

  async onunload(): Promise<void> {
    log.info("Plugin unloading");
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
    log.info("Command: reset all single images to current setting");
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
    log.info("Command: reset all image alignments to current setting");
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
          log.debug("Image not found in vault", { fileName, sourcePath });
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
