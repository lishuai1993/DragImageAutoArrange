import { Plugin, MarkdownView, type Editor, type MarkdownFileInfo } from "obsidian";
import { activeMarkdownView } from "./utils";
import { editorCmOf } from "./obsidianInternals";
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
import { installReadingModeImageDoubleClickZoom } from "./imageRender/rmImageDoubleClick";
import { setEditorDirty } from "./anchor/anchorStore";
import { exportPreservedSizes, importPreservedSizes, type MultiImageSizeData } from "./imageRender/imageRowWidget";
import { ImageRowOptions } from "./types";
import { openUnifiedImageMenu } from "./imageMenu/unifiedContextMenu";
import { closeAllMenus, setMenuScale } from "./imageMenu/menuUi";
import { createImageMenuFacade, type ImageMenuFacade } from "./imageMenu/imageMenuHost";
import {
  toggleContextMenu,
  TOGGLE_CONTEXT_MENU_COMMAND_ID,
  TOGGLE_CONTEXT_MENU_COMMAND_ID_ZH,
  TOGGLE_CONTEXT_MENU_NAMES,
} from "./imageMenu/contextMenuToggle";
import { findMarkdownViewForElement } from "./imageMenu/imageSource";
import { installReferencePaste } from "./imageMenu/referencePaste";
import { logger } from "./logger";
import { setLanguage } from "./i18n/language";
const log = logger.channel("main");

/** The plugin's own slice of `data.json`. Other modules (the image-menu host)
 *  own additional top-level keys, so every field here is optional and writes
 *  merge into the loaded object rather than replacing it. */
interface PersistedPluginData {
  settings?: DragImageSettings;
  preservedSizes?: Record<string, MultiImageSizeData>;
}

export default class DragImageAutoArrangePlugin
  extends Plugin
  implements IDragImagePlugin
{
  settings: DragImageSettings = {
    language: "en",
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
    enableReadingModeDoubleClickZoom: true,
    menuScalePercent: 100,
    logLevel: "ERROR",
    logToFile: false,
  };

  /** Image right-click menu runtime (settings store + facade). */
  private imageMenu: ImageMenuFacade | null = null;

  async onload(): Promise<void> {
    // Init the file logger inside this plugin's own folder. `manifest.dir` is
    // the vault-relative path Obsidian loaded the plugin from, so the log lands
    // next to main.js wherever the plugin is installed — the community build
    // ships as `drag-image-auto-arrange/`, a dev checkout may sit anywhere.
    const pluginDir = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
    await logger.init(this.app.vault.adapter, `${pluginDir}/log.txt`);

    // ── Apply persisted logging config before the first log call ─────
    // Level gate + file sink come from settings, so a release install is quiet
    // (ERROR → console only) while the settings tab can raise verbosity live.
    this.settings = await loadSettings(this);
    logger.setMinLevel(this.settings.logLevel);
    logger.setFileEnabled(this.settings.logToFile);
    // Before anything draws: the settings tab and the context menu resolve
    // their copy through the language singleton as they render.
    setLanguage(this.settings.language);

    log.info("Plugin loading", { version: this.manifest.version });

    // ── Unified image context menu ────────────────────────────────────
    // Registered on WINDOW in capture phase so it runs BEFORE any other
    // plugin's contextmenu handler. Routes every image inside a markdown note
    // to the unified menu; everything else keeps Obsidian's native menu.
    //
    // Window, not document: capture order is window → document → target, and
    // listeners sharing a node and phase run in registration order. A rival
    // plugin that also listens in capture — or one loaded after us, as an
    // off→on toggle reload makes us — would otherwise get its listener in
    // first, and our stopImmediatePropagation could no longer stop a handler
    // that had already run, so both menus opened. Window capture is upstream
    // of every document listener, so nothing can precede us.
    //
    // Registered via registerDomEvent so Obsidian detaches the handler on
    // disable — otherwise a disable→enable toggle reload (the supported way to
    // pick up a rebuilt main.js without restarting Obsidian) would stack a
    // second capture handler and open the image menu twice per right-click.
    this.registerDomEvent(window, "contextmenu", (e) => {
      const target = e.target as HTMLElement;
      if (!target?.tagName) return;

      const img = (target.tagName === "IMG" ? target : target.closest?.("img")) as
        | HTMLImageElement
        | null;
      if (!img || !this.imageMenu) return;

      // Master switch: with the menu off, DIAA claims nothing at all — the
      // event is left alone so Obsidian's own menu, or another plugin's,
      // shows as it normally would. Checked before every other gate, because
      // it is a bypass and not another condition on showing our menu.
      if (!this.imageMenu.settings.enableContextMenu) return;

      // Only notes we can write into — canvas/other surfaces keep the native menu.
      if (!findMarkdownViewForElement(this.app, img)) return;

      // Reading Mode read-only gate: when disabled, let Obsidian's own menu show.
      if (!this.settings.enableReadingModeContextMenu && img.closest(".markdown-preview-view")) {
        return;
      }

      // Geometry of a menu fight: `defaultPrevented` says a handler upstream of
      // us already claimed the event, and an open `.menu` says one is on screen
      // — either means a second menu is competing. The target's own document,
      // not the global one, so a popped-out window is counted correctly.
      const doc = img.ownerDocument;
      log.debug("LOG_IMAGE_CONTEXTMENU_CLAIM", {
        defaultPrevented: e.defaultPrevented,
        openMenus: doc.querySelectorAll(".menu").length,
      });

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      setMenuScale(this.settings.menuScalePercent / 100);
      void openUnifiedImageMenu(e, img, { app: this.app, facade: this.imageMenu });
    }, true);

    // Reading Mode image preview gesture: single-click → double-click, covering
    // every image Obsidian renders there. The setting is read live per event, so
    // toggling it in settings applies without a plugin reload.
    this.register(
      installReadingModeImageDoubleClickZoom(
        () => this.settings.enableReadingModeDoubleClickZoom
      )
    );

    // Restore preserved per-image sizes from previous session
    const rawData = (await this.loadData()) as PersistedPluginData | null;
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

    // ── Global warmup scheduler ──────────────────────────────────────
    registerWarmupRunner(runWarmup);
    this.register(installUserActivityListener());

    // P0: warm active tab after layout settles (restored tabs after restart).
    this.app.workspace.onLayoutReady(() => {
      const file = this.app.workspace.getActiveFile()?.path ?? "";
      requestP0Warmup(this.app, file);
      // P1/P2: queue the remaining tabs after a short delay (let P0 settle first).
      window.setTimeout(() => requestGlobalWarmup(this.app), 3000);
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
        const mode = activeMarkdownView(this.app)?.getMode?.() ?? "";
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
        const path = info.file?.path;
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

    // Commands: rescan image groups. One per language, registered side by side
    // rather than renamed on a language switch — a command name is also what a
    // hotkey binds to, so both exist from the start and neither has to move.
    const rescan = {
      editorCallback: (_editor: Editor, view: MarkdownView | MarkdownFileInfo) => {
        log.info("Command: rescan-image-groups");
        if (view instanceof MarkdownView && view.previewMode) {
          view.previewMode.rerender(true);
        } else if (_editor) {
          _editor.refresh();
        }
      },
    };
    this.addCommand({
      ...rescan,
      id: "rescan-image-groups",
      name: "Rescan image groups in current note",
    });
    this.addCommand({
      ...rescan,
      id: "rescan-image-groups-zh",
      name: "重新扫描当前笔记的图片分组",
    });

    log.info("Plugin loaded successfully");

    // ── 图片右键菜单能力 ────────────────────────────────────────────
    // 载入图片菜单设置（住在 DIAA 数据对象的 imageMenu 键下，首次载入会把旧键
    // 迁移过来），并把门面交给右键菜单与设置页使用。
    const imageMenu = await createImageMenuFacade(this);
    this.imageMenu = imageMenu;
    log.info("Image context menu feature set ready");

    // The way back for anyone who switches the menu off from the menu itself —
    // its palette label is what the switch-off notice puts on the clipboard, so
    // the user can find this command in 设置 → 快捷键 without recalling it.
    const switchMenu = { callback: () => void toggleContextMenu(imageMenu) };
    this.addCommand({
      ...switchMenu,
      id: TOGGLE_CONTEXT_MENU_COMMAND_ID,
      name: TOGGLE_CONTEXT_MENU_NAMES.en,
    });
    this.addCommand({
      ...switchMenu,
      id: TOGGLE_CONTEXT_MENU_COMMAND_ID_ZH,
      name: TOGGLE_CONTEXT_MENU_NAMES.zh,
    });

    // 设置页要编辑图片菜单的设置项（文件信息 / 删除前确认 / 文件操作），因此
    // 等门面就绪后再注册，把设置读写面交给它。
    this.addSettingTab(new DragImageSettingTab(this.app, this, imageMenu));

    // 库内粘贴一张「复制图像」得到的图时，落成引用而不是新建附件。
    this.register(installReferencePaste(this.app));
  }

  onunload(): void {
    log.info("Plugin unloading");
    // Drop any open menu and its transient document listeners so a disable→enable
    // toggle reload leaves no leaked global handlers behind.
    closeAllMenus();
    // Plugin.onunload is typed void, so the teardown sequence runs in a detached
    // async IIFE instead of making this method itself async.
    void (async () => {
      await logger.dispose();
    })();
  }

  async saveSettings(): Promise<void> {
    // Merge instead of replacing so the image-menu settings namespace
    // (imageMenu) written by the image-menu host is never dropped.
    const data = ((await this.loadData()) ?? {}) as PersistedPluginData;
    data.settings = this.settings;
    data.preservedSizes = exportPreservedSizes();
    await this.saveData(data);
    // Notify both Live Preview and Reading Mode views so they rebuild with fresh options
    this.app.workspace.iterateAllLeaves((leaf) => {
      // Live Preview / Source mode: dispatch settingsChanged annotation to rebuild decorations
      const cm = editorCmOf(leaf.view);
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
      const cm = editorCmOf(leaf.view);
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
      const cm = editorCmOf(leaf.view);
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
