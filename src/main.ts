import { Plugin, MarkdownView, TFile } from "obsidian";
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
import { setEditorDirty } from "./anchor/anchorStore";
import { exportPreservedSizes, importPreservedSizes } from "./imageRender/imageRowWidget";
import { ImageRowOptions } from "./types";
import { openUnifiedImageMenu } from "./pixelPerfect/unifiedContextMenu";
import { closeAllMenus, setMenuScale } from "./pixelPerfect/menuUi";
import { createPixelPerfectFacade, type PixelPerfectFacade } from "./pixelPerfect/pixelPerfectHost";
import { findMarkdownViewForElement } from "./vendor/pixelPerfectImage/utils/utils";
import { logger } from "./logger";
import {
  listPendingTransforms,
  clearPendingTransform,
} from "./imageTransform/transformStore";
import { writeOrientationToFile } from "./imageTransform/transformWriter";
const log = logger.channel("main");

/** Vault paths of every markdown note currently open in a workspace leaf. */
function openMarkdownNotePaths(app: any): Set<string> {
  const paths = new Set<string>();
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const path = leaf.view?.file?.path;
    if (typeof path === "string" && path) paths.add(path);
  }
  return paths;
}

/** Serialize flush runs so overlapping layout events can't double-write a file. */
let _flushChain: Promise<void> = Promise.resolve();

/**
 * Bake the pending rotate/flip orientation of every image whose owning note has
 * just been closed (or no longer exists). Obsidian has no per-leaf close event,
 * so we diff the open-markdown-note set on layout-change / file-open instead —
 * an LP↔RM switch keeps the same note path open and never mis-triggers. A failed
 * write (deleted source, decode error) clears the entry so a closed note can't
 * leave a phantom transform retrying on every layout event.
 */
async function runDepartedFlush(app: any): Promise<void> {
  const openNotes = openMarkdownNotePaths(app);
  for (const entry of listPendingTransforms()) {
    if (openNotes.has(entry.notePath)) continue;
    const abstract = app.vault.getAbstractFileByPath(entry.imagePath);
    if (abstract instanceof TFile) {
      await writeOrientationToFile(app, abstract, entry.state);
    } else {
      log.warn("transform flush: source image gone", { imagePath: entry.imagePath });
    }
    clearPendingTransform(entry.imagePath);
  }
}

function flushDepartedTransforms(app: any): Promise<void> {
  _flushChain = _flushChain.then(() => runDepartedFlush(app));
  return _flushChain;
}

/** Bake every pending orientation — called on plugin unload. */
async function flushAllTransforms(app: any): Promise<void> {
  _flushChain = _flushChain.then(async () => {
    for (const entry of listPendingTransforms()) {
      const abstract = app.vault.getAbstractFileByPath(entry.imagePath);
      if (abstract instanceof TFile) {
        await writeOrientationToFile(app, abstract, entry.state);
      }
      clearPendingTransform(entry.imagePath);
    }
  });
  return _flushChain;
}

export default class DragImageAutoArrangePlugin
  extends Plugin
  implements IDragImagePlugin
{
  settings: DragImageSettings = {
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
    menuScalePercent: 100,
  };

  /** Merged Pixel Perfect Image runtime (PP settings + services + menu builder). */
  private pixelPerfect: PixelPerfectFacade | null = null;

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
      "transformStore",
      "transformWriter",
    ]);

    // ── Unified image context menu (DIA + Pixel Perfect Image) ────────
    // Registered at document level in capture phase so it runs BEFORE any
    // other plugin's contextmenu handler. Routes every image inside a markdown
    // note to the unified menu; everything else keeps Obsidian's native menu.
    // Registered via registerDomEvent so Obsidian detaches the handler on
    // disable — otherwise a disable→enable toggle reload (the supported way to
    // pick up a rebuilt main.js without restarting Obsidian) would stack a
    // second capture handler and open the image menu twice per right-click.
    this.registerDomEvent(document, "contextmenu", (e) => {
      const target = e.target as HTMLElement;
      if (!target?.tagName) return;

      const img = (target.tagName === "IMG" ? target : target.closest?.("img")) as
        | HTMLImageElement
        | null;
      if (!img || !this.pixelPerfect) return;
      // Only notes we can write into — canvas/other surfaces keep the native menu.
      if (!findMarkdownViewForElement(this.app, img)) return;

      // Reading Mode read-only gate: when disabled, let Obsidian's own menu show.
      if (!this.settings.enableReadingModeContextMenu && img.closest(".markdown-preview-view")) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      setMenuScale(this.settings.menuScalePercent / 100);
      void openUnifiedImageMenu(e, img, { app: this.app, facade: this.pixelPerfect });
    }, true);

    this.settings = await loadSettings(this);
    // Restore preserved per-image sizes from previous session
    const rawData = await this.loadData();
    if (rawData?.preservedSizes) {
      importPreservedSizes(rawData.preservedSizes);
      log.info("Preserved multi-image sizes restored from previous session");
    }
    log.info("Settings loaded", {
      maxImagesPerRow: this.settings.maxImagesPerRow,
      defaultRowHeight: this.settings.defaultRowHeight,
      gapSize: this.settings.gapSize,
      imageExtensions: this.settings.imageExtensions,
      enableDragReorder: this.settings.enableDragReorder,
      enableResize: this.settings.enableResize,
      enableDividers: this.settings.enableDividers,
    });

    // Reading Mode processor with drag-to-merge support
    this.registerMarkdownPostProcessor(
      createReadingModeProcessor(
        this.app,
        () => this.buildImageRowOptions()
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

    // ── P3 rotate/flip persistence ───────────────────────────────────
    // A rotation/flip is only a CSS preview until the note that applied it is
    // closed; these listeners bake the pending orientation into the image file
    // when the owning note departs. The full set also flushes on unload.
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        void flushDepartedTransforms(this.app);
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        void flushDepartedTransforms(this.app);
      })
    );

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
    // B-4: only invalidate the image-row index when the line count actually changes.
    // Parameter-only edits (image resize, alignment toggle) keep the same line count
    // and the same image-row structure, so the index stays valid for mode-switch
    // scroll restoration (image-row-based disambiguation + nearestImg priors).
    const _lastEditorLineCount = new Map<string, number>();
    this.registerEvent(
      this.app.workspace.on("editor-change", (editor, info) => {
        const path = (info as any)?.file?.path;
        if (!path) return;
        setEditorDirty(true);
        const newLineCount = editor.lineCount();
        const oldLineCount = _lastEditorLineCount.get(path);
        if (oldLineCount !== newLineCount) {
          invalidateImageRowIndex(path);
          _lastEditorLineCount.set(path, newLineCount);
          log.debug("B-4 image-row index invalidated", { path, oldLineCount, newLineCount });
        } else {
          log.debug("B-4 image-row index preserved (line count unchanged)", { path, lineCount: newLineCount });
        }
        scheduleIdleWarmup(this.app, path, newLineCount, editor.getCursor().line);
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
        () => this.settings
      )
    );
    log.info("Live Preview extension registered");

    // Standalone line drop handler (flex row → standalone)
    this.registerEditorExtension(
      createStandaloneDropPlugin(
        () => this.settings
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

    log.info("Plugin loaded successfully");

    // ── Merge Pixel Perfect Image into the unified context menu ──────
    // Loads PP settings into the DIA data namespace and wires PP services
    // (ImageService / FileService / MenuService) against our in-process host.
    this.pixelPerfect = await createPixelPerfectFacade(this);
    log.info("Pixel Perfect Image feature set merged", {
      customResizeSizes: this.pixelPerfect.host.settings.customResizeSizes,
    });

    // The settings tab edits PP-owned options (file info / resize presets /
    // delete confirmation / file operations), so it is registered only after
    // the merged host is ready and its settings object can be handed over.
    this.addSettingTab(
      new DragImageSettingTab(
        this.app,
        this as IDragImagePlugin,
        this.pixelPerfect.host
      )
    );
  }

  async onunload(): Promise<void> {
    log.info("Plugin unloading");
    // Drop any open menu and its transient document listeners so a disable→enable
    // toggle reload leaves no leaked global handlers behind.
    closeAllMenus();
    // Bake any orientation still pending so a note closed without a layout event
    // (window teardown, plugin disable) doesn't lose the user's rotation.
    await flushAllTransforms(this.app);
    await logger.dispose();
  }

  async saveSettings(): Promise<void> {
    // Merge instead of replacing so the PP settings namespace
    // (pixelPerfectImage) written by the pixelPerfect host is never dropped.
    const data = (await this.loadData()) ?? {};
    data.settings = this.settings;
    data.preservedSizes = exportPreservedSizes();
    await this.saveData(data);
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
      // Map an embed name to its vault file path so the widget can replay a
      // pending rotate/flip orientation from transformStore on a rebuilt <img>.
      // Same resolution as resolveImagePath (PP's store key is the file path).
      getImageVaultPath: (fileName: string) => {
        const decoded = decodeURIComponent(fileName);
        const file = this.app.metadataCache.getFirstLinkpathDest(decoded, sourcePath);
        return file?.path ?? null;
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
