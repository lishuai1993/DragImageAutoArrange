import { Plugin, MarkdownView } from "obsidian";
import {
  DragImageSettings,
  DragImageSettingTab,
  IDragImagePlugin,
  loadSettings,
} from "./settings";
import { createReadingModeProcessor } from "./readingMode";
import { createLivePreviewPlugin, createStandaloneDropPlugin, settingsChanged } from "./livePreview";
import { ImageRowOptions, exportPreservedSizes, importPreservedSizes } from "./imageRowWidget";
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
  };

  async onload(): Promise<void> {
    // Init file logger (hardcoded path for debugging)
    await logger.init(
      this.app.vault.adapter,
      ".obsidian/plugins/obsidian-DragImageAutoArrange/log.txt"
    );
    logger.info("Plugin loading", { version: this.manifest.version });

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
