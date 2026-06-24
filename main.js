"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => DragImageAutoArrangePlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian4 = require("obsidian");

// src/settings.ts
var import_obsidian = require("obsidian");

// src/constants.ts
var CSS_PREFIX = "drag-img";
var CLASSES = {
  row: `${CSS_PREFIX}-row`,
  imageItem: `${CSS_PREFIX}-item`,
  imageInner: `${CSS_PREFIX}-img`,
  divider: `${CSS_PREFIX}-divider`,
  resizeHandle: `${CSS_PREFIX}-resize-handle`,
  dropIndicator: `${CSS_PREFIX}-drop-indicator`,
  dragging: `${CSS_PREFIX}-dragging`,
  placeholder: `${CSS_PREFIX}-placeholder`,
  dividerActive: `${CSS_PREFIX}-divider-active`,
  dividerSnap: `${CSS_PREFIX}-divider-snap`,
  itemSnap: `${CSS_PREFIX}-snap`,
  topBar: `${CSS_PREFIX}-top-bar`,
  resizing: `${CSS_PREFIX}-resizing`
};
var DEFAULT_SETTINGS = {
  enabled: true,
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
  dragOpacity: 60
};
var DIVIDER_WIDTH = 4;
var RESIZE_HANDLE_SIZE = 10;
function buildImageLineRe(extensions) {
  const extList = extensions.split(",").map((s) => s.trim()).filter(Boolean).join("|");
  return new RegExp(
    `^\\s*!\\[\\[([^\\]]+\\.(?:${extList}))(?:\\|([^\\]]*))?\\]\\]\\s*$`,
    "i"
  );
}

// src/settings.ts
async function loadSettings(plugin) {
  const data = await plugin.loadData();
  return Object.assign({}, DEFAULT_SETTINGS, data ?? {});
}
var DragImageSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Drag Image Auto Arrange" });
    new import_obsidian.Setting(containerEl).setName("Enable plugin").setDesc("Toggle the image auto-arrange feature on or off.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
        this.plugin.settings.enabled = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Default row height").setDesc("Default uniform height (px) for image rows. Individual rows adapt based on image aspect ratios.").addSlider(
      (slider) => slider.setLimits(80, 600, 10).setValue(this.plugin.settings.defaultRowHeight).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.defaultRowHeight = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Max images per row").setDesc("Maximum number of images allowed in a single row (1-10). Groups exceeding this limit are split.").addSlider(
      (slider) => slider.setLimits(2, 10, 1).setValue(this.plugin.settings.maxImagesPerRow).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.maxImagesPerRow = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Gap size").setDesc("Spacing between images in a row (px).").addSlider(
      (slider) => slider.setLimits(0, 20, 1).setValue(this.plugin.settings.gapSize).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.gapSize = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Snap sensitivity").setDesc("When dragging a divider or resize handle, snap into place when the height difference between adjacent images falls within this percentage of their equilibrium (equal) height. Set to 0 to disable snapping.").addSlider(
      (slider) => slider.setLimits(0, 10, 1).setValue(this.plugin.settings.snapSensitivity).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.snapSensitivity = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Top bar activation zone").setDesc("Pixel distance from the top of a flex row within which the global-balance top bar appears (4-40 px).").addSlider(
      (slider) => slider.setLimits(4, 40, 2).setValue(this.plugin.settings.topBarSensitivity).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.topBarSensitivity = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Ghost image width").setDesc("Width (px) of the drag ghost image that follows the cursor (100-500 px).").addSlider(
      (slider) => slider.setLimits(100, 500, 10).setValue(this.plugin.settings.ghostImageWidth).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.ghostImageWidth = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Drag ghost opacity").setDesc("Transparency of the original image during drag (10% = nearly opaque, 90% = very transparent).").addSlider(
      (slider) => slider.setLimits(10, 90, 5).setValue(this.plugin.settings.dragOpacity).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.dragOpacity = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Enable drag reorder").setDesc("Allow dragging images within a row to reorder them.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.enableDragReorder).onChange(async (value) => {
        this.plugin.settings.enableDragReorder = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Enable resize handles").setDesc("Show corner resize handles on hover to adjust individual image sizes.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.enableResize).onChange(async (value) => {
        this.plugin.settings.enableResize = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Enable column dividers").setDesc("Show draggable dividers between images to adjust width ratios.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.enableDividers).onChange(async (value) => {
        this.plugin.settings.enableDividers = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Image extensions").setDesc("Comma-separated list of image file extensions to detect (e.g., png,jpg,gif,webp).").addText(
      (text) => text.setValue(this.plugin.settings.imageExtensions).onChange(async (value) => {
        this.plugin.settings.imageExtensions = value || DEFAULT_SETTINGS.imageExtensions;
        await this.plugin.saveSettings();
      })
    );
  }
};

// src/readingMode.ts
var import_obsidian2 = require("obsidian");

// src/logger.ts
var Logger = class {
  constructor() {
    this.buffer = [];
    this.adapter = null;
    this.logPath = "";
    this.flushTimer = null;
    this.flushing = false;
  }
  /** Call once during plugin load to enable file logging. Clears previous log. */
  init(adapter, logPath) {
    this.adapter = adapter;
    this.logPath = logPath;
    adapter.write(logPath, "").catch(() => {
    });
    console.log(`[DragImg] Logger initialized, logPath=${logPath}`);
    this.flushTimer = setInterval(() => this.flush(), 5e3);
  }
  /** Call on plugin unload to flush remaining entries, then clear log. */
  async dispose() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
    if (this.adapter) {
      try {
        await this.adapter.write(this.logPath, "");
      } catch {
      }
    }
    this.adapter = null;
  }
  info(message, data) {
    this.write("INFO", message, data);
  }
  warn(message, data) {
    this.write("WARN", message, data);
  }
  error(message, data) {
    this.write("ERROR", message, data);
  }
  debug(message, data) {
    this.write("DEBUG", message, data);
  }
  write(level, message, data) {
    const entry = {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      level,
      message,
      data
    };
    this.buffer.push(entry);
    const dataStr = data !== void 0 ? ` ${JSON.stringify(data)}` : "";
    console.log(`[DragImg] [${level}] ${message}${dataStr}`);
  }
  async flush() {
    if (!this.adapter || this.buffer.length === 0 || this.flushing) return;
    this.flushing = true;
    try {
      const lines = this.buffer.map(
        (e) => `[${e.timestamp}] [${e.level}] ${e.message}` + (e.data !== void 0 ? ` ${JSON.stringify(e.data)}` : "")
      );
      this.buffer = [];
      const newContent = lines.join("\n") + "\n";
      let existing = "";
      try {
        existing = await this.adapter.read(this.logPath);
      } catch {
      }
      await this.adapter.write(this.logPath, existing + newContent);
    } catch (e) {
      console.error("[DragImg] Failed to flush log:", e);
    } finally {
      this.flushing = false;
    }
  }
};
var logger = new Logger();

// src/readingMode.ts
function createReadingModeProcessor(app, getOptions, enabled) {
  return (el, ctx) => {
    const allEmbeds = el.querySelectorAll(".internal-embed.image-embed");
    logger.debug("ReadingMode processor invoked", {
      sourcePath: ctx.sourcePath,
      embedCount: allEmbeds.length,
      enabled: enabled()
    });
    if (!enabled()) return;
    const embeds = Array.from(allEmbeds);
    if (embeds.length === 0) return;
    const groups = buildEmbedGroups(embeds);
    const options = getOptions();
    logger.debug("ReadingMode processor", {
      embedCount: embeds.length,
      groupCount: groups.length,
      sourcePath: ctx.sourcePath,
      groups: groups.map((g) => g.length)
    });
    for (const group of groups) {
      if (group.length >= 2) {
        wrapAsFlexRow(group, options);
      }
    }
    makeImagesDraggable(app, ctx.sourcePath, embeds);
  };
}
function buildEmbedGroups(embeds) {
  const groups = [];
  let current = [];
  for (let i = 0; i < embeds.length; i++) {
    const embed = embeds[i];
    const block = findBlockParent(embed);
    if (current.length === 0) {
      current.push(embed);
      continue;
    }
    const prev = current[current.length - 1];
    const prevBlock = findBlockParent(prev);
    if (isImageOnlyBlock(prevBlock) && block && areAdjacentSiblings(prevBlock, block)) {
      current.push(embed);
    } else {
      if (current.length >= 2) groups.push([...current]);
      current = [embed];
    }
  }
  if (current.length >= 2) groups.push([...current]);
  return groups;
}
function findBlockParent(el) {
  let cur = el.parentElement;
  while (cur) {
    const d = window.getComputedStyle(cur).display;
    if (d === "block" || d === "flex" || d === "list-item") return cur;
    cur = cur.parentElement;
  }
  return el.parentElement;
}
function isImageOnlyBlock(block) {
  if (!block) return false;
  const hasImg = block.querySelector(".internal-embed.image-embed") !== null;
  if (!hasImg) return false;
  for (const child of Array.from(block.children)) {
    if (!child.classList.contains("internal-embed") || !child.classList.contains("image-embed")) {
      return false;
    }
  }
  return true;
}
function areAdjacentSiblings(a, b) {
  if (!a || !b || a.parentElement !== b.parentElement) return false;
  const sibs = Array.from(a.parentElement.children);
  return Math.abs(sibs.indexOf(a) - sibs.indexOf(b)) === 1;
}
function wrapAsFlexRow(embeds, options) {
  const firstBlock = findBlockParent(embeds[0]);
  if (!firstBlock) return;
  const blocks = /* @__PURE__ */ new Set();
  for (const e of embeds) {
    const b = findBlockParent(e);
    if (b) blocks.add(b);
  }
  const blockList = [...blocks];
  const row = document.createElement("div");
  row.className = CLASSES.row;
  row.setAttribute("data-diaa-group", "true");
  row.style.cssText = `display:flex;align-items:flex-start;gap:${options.gap}px;width:100%;overflow:hidden;`;
  let rowH = options.defaultRowHeight;
  const firstImg = embeds[0].querySelector("img");
  if (firstImg?.naturalWidth) {
    rowH = Math.min(options.defaultRowHeight * 3, Math.max(50, rowH));
  }
  row.style.height = `${rowH}px`;
  for (const b of blockList) {
    b.style.cssText = `flex:1 1 0;overflow:hidden;min-width:50px;position:relative;margin:0;padding:0;`;
    const imgs = Array.from(b.querySelectorAll("img"));
    for (const img of imgs) {
      img.style.cssText = "width:100%;height:100%;object-fit:contain;display:block;";
    }
    row.appendChild(b);
  }
  firstBlock.replaceWith(row);
  if (blockList[0] !== row.firstChild) {
    row.insertBefore(blockList[0], row.firstChild);
  }
}
var dragSrcEl = null;
var dragPlaceholders = [];
function makeImagesDraggable(app, sourcePath, embeds) {
  let draggableCount = 0;
  for (const embed of embeds) {
    const block = findBlockParent(embed);
    if (!block) {
      logger.debug("ReadingMode makeDraggable skip: no block parent", {
        embedTag: embed.tagName
      });
      continue;
    }
    block.setAttribute("draggable", "true");
    block.classList.add("diaa-draggable");
    for (const img of Array.from(block.querySelectorAll("img"))) {
      img.setAttribute("draggable", "false");
    }
    draggableCount++;
    block.addEventListener("dragstart", (e) => {
      logger.debug("ReadingMode dragstart", { sourcePath });
      dragSrcEl = block;
      block.classList.add(CLASSES.dragging);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", "");
    });
    block.addEventListener("dragend", () => {
      block.classList.remove(CLASSES.dragging);
      dragSrcEl = null;
      removeAllDropIndicators();
    });
    block.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (!dragSrcEl || dragSrcEl === block) return;
      removeAllDropIndicators();
      const rect = block.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      const indicator = document.createElement("div");
      indicator.className = "diaa-drop-indicator";
      indicator.style.cssText = "position:absolute;top:0;bottom:0;width:3px;background:#4a9eff;z-index:10;pointer-events:none;";
      if (e.clientX < midX) {
        indicator.style.left = "0";
      } else {
        indicator.style.right = "0";
      }
      block.style.position = block.style.position || "relative";
      block.appendChild(indicator);
      dragPlaceholders.push(indicator);
    });
    block.addEventListener("dragleave", () => {
      removeAllDropIndicators();
    });
    block.addEventListener("drop", (e) => {
      e.preventDefault();
      removeAllDropIndicators();
      if (!dragSrcEl || dragSrcEl === block) return;
      handleImageDrop(
        app,
        sourcePath,
        dragSrcEl,
        block,
        e.clientX < block.getBoundingClientRect().left + block.getBoundingClientRect().width / 2
      );
    });
  }
  logger.debug("ReadingMode makeDraggable done", {
    draggableCount,
    totalEmbeds: embeds.length
  });
}
function removeAllDropIndicators() {
  for (const p of dragPlaceholders) p.remove();
  dragPlaceholders = [];
}
async function handleImageDrop(app, sourcePath, srcBlock, dstBlock, insertBefore) {
  const srcEmbed = srcBlock.querySelector(".internal-embed.image-embed");
  const dstEmbed = dstBlock.querySelector(".internal-embed.image-embed");
  if (!srcEmbed || !dstEmbed) return;
  const allEmbeds = Array.from(
    document.querySelectorAll(".internal-embed.image-embed")
  );
  const srcDomIdx = allEmbeds.indexOf(srcEmbed);
  const dstDomIdx = allEmbeds.indexOf(dstEmbed);
  if (srcDomIdx < 0 || dstDomIdx < 0) return;
  const file = app.vault.getAbstractFileByPath(sourcePath);
  if (!(file instanceof import_obsidian2.TFile)) return;
  await app.vault.process(file, (content) => {
    const lines = content.split("\n");
    const imageLineNumbers = [];
    for (let i = 0; i < lines.length; i++) {
      if (isImageEmbedLine(lines[i])) {
        imageLineNumbers.push(i);
      }
    }
    if (srcDomIdx >= imageLineNumbers.length || dstDomIdx >= imageLineNumbers.length) {
      return content;
    }
    const srcLine = imageLineNumbers[srcDomIdx];
    const dstLine = imageLineNumbers[dstDomIdx];
    if (srcLine === dstLine) return content;
    logger.info("ReadingMode drag-drop reorder", {
      srcDomIdx,
      dstDomIdx,
      srcLine,
      dstLine,
      insertBefore,
      totalImages: imageLineNumbers.length
    });
    const [removed] = lines.splice(srcLine, 1);
    const adjustedDst = srcLine < dstLine ? dstLine - 1 : dstLine;
    const insertAt = insertBefore ? adjustedDst : adjustedDst + 1;
    lines.splice(insertAt, 0, removed);
    return lines.join("\n");
  });
}
function isImageEmbedLine(line) {
  const re = /^\s*!\[\[([^\]]+\.(?:png|jpg|jpeg|gif|webp|svg|bmp|avif))(?:\|\d+)?\]\]\s*$/i;
  return re.test(line);
}

// src/livePreview.ts
var import_view = require("@codemirror/view");
var import_state = require("@codemirror/state");
var import_obsidian3 = require("obsidian");

// src/imageDetector.ts
function parseImageLine(line, lineIndex, re) {
  const match = line.match(re);
  if (!match) return null;
  const fileName = match[1];
  const rawParam = match[2];
  const firstNum = rawParam ? rawParam.match(/^\d+/) : null;
  const explicitWidth = firstNum ? parseInt(firstNum[0], 10) : null;
  return {
    line: lineIndex,
    raw: line,
    fileName,
    explicitWidth,
    hasExplicitWidth: explicitWidth !== null,
    flexGrow: explicitWidth ? explicitWidth / 100 : 1
  };
}
function detectImageGroups(text, maxImagesPerRow, extensions) {
  const re = buildImageLineRe(extensions);
  const lines = text.split("\n");
  const groups = [];
  let currentGroup = [];
  logger.debug("detectImageGroups start", {
    lineCount: lines.length,
    maxImagesPerRow,
    extensions
  });
  const flushGroup = () => {
    if (currentGroup.length === 0) return;
    for (let i = 0; i < currentGroup.length; i += maxImagesPerRow) {
      const chunk = currentGroup.slice(i, i + maxImagesPerRow);
      groups.push({
        lineStart: chunk[0].line,
        lineEnd: chunk[chunk.length - 1].line + 1,
        images: [...chunk]
      });
    }
    currentGroup = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseImageLine(lines[i], i, re);
    if (parsed) {
      currentGroup.push(parsed);
    } else {
      flushGroup();
    }
  }
  flushGroup();
  logger.debug("detectImageGroups result", {
    groupCount: groups.length,
    groups: groups.map((g) => ({
      lineStart: g.lineStart,
      lineEnd: g.lineEnd,
      imageCount: g.images.length,
      files: g.images.map((img) => img.fileName)
    }))
  });
  return groups;
}

// src/layoutEngine.ts
function computeUniformHeight(metas, containerWidth, gap, minHeight, maxHeight) {
  const n = metas.length;
  if (n === 0) {
    return { rowHeight: minHeight, imageWidths: [], totalWidth: 0 };
  }
  let sumAspect = 0;
  for (const meta of metas) {
    if (meta.naturalWidth > 0 && meta.naturalHeight > 0) {
      sumAspect += meta.naturalWidth / meta.naturalHeight;
    } else {
      sumAspect += 4 / 3;
    }
  }
  const effectiveWidth = containerWidth > 0 ? containerWidth : 800;
  const totalGap = (n - 1) * gap;
  const h = (effectiveWidth - totalGap) / sumAspect;
  const rowHeight = Math.max(minHeight, Math.min(maxHeight, Math.round(h)));
  const imageWidths = [];
  for (const meta of metas) {
    if (meta.naturalWidth > 0 && meta.naturalHeight > 0) {
      imageWidths.push(
        Math.round(rowHeight * (meta.naturalWidth / meta.naturalHeight))
      );
    } else {
      imageWidths.push(Math.round(rowHeight * (4 / 3)));
    }
  }
  const totalWidth = imageWidths.reduce((s, w) => s + w, 0) + totalGap;
  return { rowHeight, imageWidths, totalWidth };
}
function computeFlexGrows(metas) {
  if (metas.length === 0) return [];
  const aspects = metas.map(
    (m) => m.naturalWidth > 0 && m.naturalHeight > 0 ? m.naturalWidth / m.naturalHeight : 4 / 3
  );
  const minAspect = Math.min(...aspects);
  return aspects.map((a) => Math.round(a / minAspect * 100) / 100);
}

// src/imageRowWidget.ts
var ImageRowWidget = class {
  constructor(group, options) {
    this.container = null;
    this.imageEls = [];
    this.itemEls = [];
    this.dividerEls = [];
    this.resizeHandles = [];
    this.handleDefs = [];
    this.resizeObserver = null;
    this.reorderCallback = null;
    this.resizeCallback = null;
    this.resizeEndCallback = null;
    this.dividerDragCallback = null;
    this.persistCallback = null;
    this.mergeExternalCallback = null;
    this.loadedMetas = /* @__PURE__ */ new Map();
    this.flexGrows = [];
    this.onLayoutChange = null;
    this.group = group;
    this.options = options;
    this.rowHeight = options.defaultRowHeight;
  }
  onReorder(cb) {
    this.reorderCallback = cb;
  }
  onResize(cb) {
    this.resizeCallback = cb;
  }
  onResizeEnd(cb) {
    this.resizeEndCallback = cb;
  }
  onDividerDrag(cb) {
    this.dividerDragCallback = cb;
  }
  onPersist(cb) {
    this.persistCallback = cb;
  }
  onMergeExternal(cb) {
    this.mergeExternalCallback = cb;
  }
  getCurrentFlexGrows() {
    return this.itemEls.map((el) => parseFloat(el.style.flexGrow || "1"));
  }
  /**
   * Create and return the root DOM element.
   */
  build() {
    logger.debug("ImageRowWidget build", {
      imageCount: this.group.images.length,
      files: this.group.images.map((i) => i.fileName),
      options: {
        defaultRowHeight: this.options.defaultRowHeight,
        gap: this.options.gap,
        enableDividers: this.options.enableDividers,
        enableResize: this.options.enableResize
      }
    });
    this.container = document.createElement("div");
    this.container.className = CLASSES.row;
    this.container.dataset.lineStart = String(this.group.lineStart);
    this.container.dataset.lineEnd = String(this.group.lineEnd);
    this.container.style.display = "flex";
    this.container.style.alignItems = "flex-start";
    this.container.style.gap = `${this.options.gap}px`;
    this.container.style.width = "100%";
    const topBar = document.createElement("div");
    topBar.className = CLASSES.topBar;
    this.container.appendChild(topBar);
    let topBarDblClickArmed = false;
    this.container.addEventListener("dblclick", (e) => {
      if (!topBarDblClickArmed) return;
      e.preventDefault();
      e.stopPropagation();
      this.snapAllToEquilibrium();
    });
    const sensitivity = this.options.topBarSensitivity;
    this.container.addEventListener("mousemove", (e) => {
      const rect = this.container.getBoundingClientRect();
      const offsetY = e.clientY - rect.top;
      if (offsetY <= sensitivity) {
        topBar.style.backgroundColor = "#4a9eff";
        topBarDblClickArmed = true;
      } else {
        topBar.style.backgroundColor = "";
        topBarDblClickArmed = false;
      }
    });
    this.container.addEventListener("mouseleave", () => {
      topBar.style.backgroundColor = "";
      topBarDblClickArmed = false;
    });
    const images = this.group.images;
    this.imageEls = [];
    this.itemEls = [];
    this.dividerEls = [];
    this.resizeHandles = [];
    for (let i = 0; i < images.length; i++) {
      if (i > 0 && this.options.enableDividers) {
        const divider = this.buildDivider(i - 1);
        this.container.appendChild(divider);
        this.dividerEls.push(divider);
      }
      const item = this.buildImageItem(images[i], i);
      this.container.appendChild(item);
    }
    this.resizeObserver = new ResizeObserver(() => {
      this.updateAllHandlePositions();
    });
    this.resizeObserver.observe(this.container);
    for (const item of this.itemEls) {
      this.resizeObserver.observe(item);
    }
    this.applyLayout();
    return this.container;
  }
  buildImageItem(image, index) {
    const item = document.createElement("div");
    item.className = CLASSES.imageItem;
    item.style.flex = `${image.flexGrow} 0 0%`;
    item.style.position = "relative";
    item.style.minWidth = "50px";
    item.style.minHeight = "0";
    item.style.height = "100%";
    item.style.transform = "translateZ(0)";
    item.dataset.index = String(index);
    const img = document.createElement("img");
    img.className = CLASSES.imageInner;
    img.src = this.options.getResourcePath(image.fileName);
    img.alt = image.fileName;
    img.style.display = "block";
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "contain";
    img.style.objectPosition = "left top";
    img.dataset.index = String(index);
    img.onload = () => {
      this.loadedMetas.set(index, {
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight
      });
      this.applyLayout();
      requestAnimationFrame(() => this.updateHandlePositions(index));
    };
    img.onerror = () => {
      logger.warn("Image load failed in widget", {
        fileName: image.fileName,
        index,
        src: img.src
      });
      this.loadedMetas.set(index, {
        naturalWidth: 400,
        naturalHeight: 300
      });
      img.style.backgroundColor = "#f0f0f0";
      img.alt = `[Not found: ${image.fileName}]`;
    };
    item.appendChild(img);
    this.imageEls.push(img);
    this.itemEls.push(item);
    if (this.options.enableResize) {
      const handles = this.buildResizeHandles(item, index);
      this.resizeHandles.push(handles);
      item.onmouseenter = () => {
        this.updateHandlePositions(index);
      };
    }
    return item;
  }
  buildDivider(leftIndex) {
    const divider = document.createElement("div");
    divider.className = CLASSES.divider;
    divider.style.flex = "0 0 auto";
    divider.style.width = `${DIVIDER_WIDTH}px`;
    divider.style.cursor = "col-resize";
    divider.style.alignSelf = "stretch";
    divider.style.backgroundColor = "transparent";
    divider.style.transition = "background-color 0.15s";
    divider.dataset.leftIndex = String(leftIndex);
    divider.onmouseenter = () => {
      divider.style.backgroundColor = "#4a9eff";
    };
    divider.onmouseleave = () => {
      divider.style.backgroundColor = "transparent";
    };
    divider.ondblclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.snapDividerToEquilibrium(leftIndex);
    };
    let dragging = false;
    let startX = 0;
    let startLeftFlex = 0;
    let startRightFlex = 0;
    let currentOnMove = null;
    let currentOnUp = null;
    divider.onmousedown = (e) => {
      dragging = true;
      startX = e.clientX;
      const leftItem = this.itemEls[leftIndex];
      const rightItem = this.itemEls[leftIndex + 1];
      startLeftFlex = parseFloat(leftItem?.style.flexGrow || "1");
      startRightFlex = parseFloat(rightItem?.style.flexGrow || "1");
      e.preventDefault();
      divider.classList.add(CLASSES.dividerActive);
      if (currentOnMove) document.removeEventListener("mousemove", currentOnMove);
      if (currentOnUp) document.removeEventListener("mouseup", currentOnUp);
      currentOnMove = (ev) => {
        if (!dragging) return;
        const dx = ev.clientX - startX;
        if (Math.abs(dx) < 3) return;
        const leftItem2 = this.itemEls[leftIndex];
        const rightItem2 = this.itemEls[leftIndex + 1];
        if (!leftItem2 || !rightItem2) return;
        const sensitivity = 0.5;
        let newLeft = Math.max(0.1, startLeftFlex + dx * sensitivity * 0.01);
        const total = startLeftFlex + startRightFlex;
        let newRight = total - newLeft;
        if (newRight < 0.1) {
          newRight = 0.1;
          newLeft = total - 0.1;
        }
        if (newLeft < 0.1) {
          newLeft = 0.1;
          newRight = total - 0.1;
        }
        const snapFactor = this.options.snapSensitivity / 100;
        if (snapFactor > 0) {
          const lm = this.loadedMetas.get(leftIndex);
          const rm = this.loadedMetas.get(leftIndex + 1);
          if (lm && rm && lm.naturalWidth > 0 && rm.naturalWidth > 0) {
            const la = lm.naturalWidth / lm.naturalHeight;
            const ra = rm.naturalWidth / rm.naturalHeight;
            const snapLeft = total * la / (la + ra);
            const snapRight = total - snapLeft;
            const heightDiff = Math.abs(newLeft / la - newRight / ra);
            const snapThreshold = total / (la + ra) * snapFactor;
            if (heightDiff < snapThreshold) {
              newLeft = snapLeft;
              newRight = snapRight;
              divider.classList.add(CLASSES.dividerSnap);
            } else {
              divider.classList.remove(CLASSES.dividerSnap);
            }
          }
        }
        leftItem2.style.flexGrow = String(newLeft);
        rightItem2.style.flexGrow = String(newRight);
        this.recalculateRowHeight();
        if (this.dividerDragCallback) {
          const ratio = newLeft / (newLeft + newRight);
          this.dividerDragCallback(leftIndex, ratio);
        }
      };
      currentOnUp = () => {
        dragging = false;
        divider.classList.remove(CLASSES.dividerActive);
        divider.classList.remove(CLASSES.dividerSnap);
        document.removeEventListener("mousemove", currentOnMove);
        document.removeEventListener("mouseup", currentOnUp);
        currentOnMove = null;
        currentOnUp = null;
      };
      document.addEventListener("mousemove", currentOnMove);
      document.addEventListener("mouseup", currentOnUp, { once: true });
    };
    divider._destroy = () => {
      if (currentOnMove) document.removeEventListener("mousemove", currentOnMove);
      if (currentOnUp) document.removeEventListener("mouseup", currentOnUp);
    };
    return divider;
  }
  /**
   * Compute the actual rendered image rect within a flex item,
   * accounting for object-fit: contain + object-position: left top.
   */
  getImageContentRect(index) {
    const item = this.itemEls[index];
    const img = this.imageEls[index];
    if (!item || !img) return null;
    void item.offsetHeight;
    const cw = item.clientWidth;
    const ch = item.clientHeight;
    if (cw === 0 || ch === 0) return null;
    const meta = this.loadedMetas.get(index);
    if (!meta || meta.naturalWidth === 0) return null;
    const imageAspect = meta.naturalWidth / meta.naturalHeight;
    const containerAspect = cw / ch;
    let displayW;
    let displayH;
    if (imageAspect > containerAspect) {
      displayW = cw;
      displayH = cw / imageAspect;
    } else {
      displayH = ch;
      displayW = ch * imageAspect;
    }
    return { left: 0, top: 0, width: displayW, height: displayH };
  }
  /** Reposition resize handles to match the actual image content rect. */
  updateHandlePositions(index) {
    const rect = this.getImageContentRect(index);
    const defs = this.handleDefs[index];
    if (!rect || !defs) return;
    const SZ = RESIZE_HANDLE_SIZE;
    for (const hd of defs) {
      hd.el.style.left = hd.relX * (rect.width - SZ) + "px";
      hd.el.style.top = hd.relY * (rect.height - SZ) + "px";
    }
  }
  /** Reposition all resize handles after a layout change. */
  updateAllHandlePositions() {
    for (let i = 0; i < this.itemEls.length; i++) {
      this.updateHandlePositions(i);
    }
  }
  buildResizeHandles(item, index) {
    const handles = [];
    const defs = [
      { el: null, relX: 0, relY: 0 },
      // nw corner
      { el: null, relX: 1, relY: 0 },
      // ne corner
      { el: null, relX: 0, relY: 1 },
      // sw corner
      { el: null, relX: 1, relY: 1 },
      // se corner
      { el: null, relX: 0.5, relY: 0 },
      // n edge midpoint
      { el: null, relX: 0.5, relY: 1 },
      // s edge midpoint
      { el: null, relX: 0, relY: 0.5 },
      // w edge midpoint
      { el: null, relX: 1, relY: 0.5 }
      // e edge midpoint
    ];
    const cursors = [
      "nw-resize",
      "ne-resize",
      "sw-resize",
      "se-resize",
      "n-resize",
      "s-resize",
      "w-resize",
      "e-resize"
    ];
    for (let i = 0; i < defs.length; i++) {
      const hd = defs[i];
      const handle = document.createElement("div");
      handle.className = CLASSES.resizeHandle;
      const important = (k, v) => handle.style.setProperty(k, v, "important");
      important("position", "absolute");
      important("width", `${RESIZE_HANDLE_SIZE}px`);
      important("height", `${RESIZE_HANDLE_SIZE}px`);
      important("border-radius", "2px");
      important("background-color", "#4a9eff");
      important("border", "1px solid white");
      important("z-index", "2");
      handle.style.cursor = cursors[i];
      let dragging = false;
      let currentOnMove = null;
      let currentOnUp = null;
      let AW = 0;
      let totalG = 0;
      let startFlex = 0;
      let startWidth = 0;
      let scale = 1;
      let nItems = 0;
      handle.onmousedown = (e) => {
        dragging = true;
        item.classList.add(CLASSES.resizing);
        logger.debug("resize-mousedown", { index, timestamp: Date.now(), relX: hd.relX, relY: hd.relY });
        e.preventDefault();
        e.stopPropagation();
        const containerRect = this.container.getBoundingClientRect();
        nItems = this.itemEls.length;
        AW = containerRect.width - (nItems - 1) * this.options.gap;
        totalG = 0;
        const grows = [];
        for (let j = 0; j < nItems; j++) {
          const g = parseFloat(this.itemEls[j].style.flexGrow || "1");
          grows.push(g);
          totalG += g;
        }
        startFlex = grows[index];
        startWidth = startFlex / totalG * AW;
        const displayRect = this.getImageContentRect(index);
        const displayW = displayRect ? displayRect.width : startWidth;
        scale = displayW > 0 ? startWidth / displayW : 1;
        if (currentOnMove) document.removeEventListener("mousemove", currentOnMove);
        if (currentOnUp) document.removeEventListener("mouseup", currentOnUp);
        currentOnMove = (ev) => {
          if (!dragging) return;
          const SENS = 0.4;
          const sign = hd.relX < 0.5 ? -1 : 1;
          const effectiveDx = (ev.clientX - e.clientX) * scale * SENS;
          const otherG = totalG - startFlex;
          const minW = 50;
          const maxW = AW - minW * (nItems - 1);
          const targetWidth = Math.max(minW, Math.min(maxW, startWidth + sign * effectiveDx));
          let newFlex = targetWidth * otherG / (AW - targetWidth);
          newFlex = Math.max(0.1, newFlex);
          const snapFactor = this.options.snapSensitivity / 100;
          if (snapFactor > 0) {
            const cm = this.loadedMetas.get(index);
            if (cm && cm.naturalWidth > 0) {
              const ca = cm.naturalWidth / cm.naturalHeight;
              let bestTarget = null;
              let bestScore = Infinity;
              if (index > 0) {
                const lm = this.loadedMetas.get(index - 1);
                if (lm && lm.naturalWidth > 0) {
                  const la = lm.naturalWidth / lm.naturalHeight;
                  const lf = parseFloat(this.itemEls[index - 1].style.flexGrow || "1");
                  const target = lf * ca / la;
                  const heightDiff = Math.abs(newFlex / ca - lf / la);
                  const snapThreshold = lf / la * snapFactor;
                  const score = snapThreshold > 0 ? heightDiff / snapThreshold : Infinity;
                  if (score < bestScore) {
                    bestScore = score;
                    bestTarget = target;
                  }
                }
              }
              if (index < this.itemEls.length - 1) {
                const rm = this.loadedMetas.get(index + 1);
                if (rm && rm.naturalWidth > 0) {
                  const ra = rm.naturalWidth / rm.naturalHeight;
                  const rf = parseFloat(this.itemEls[index + 1].style.flexGrow || "1");
                  const target = rf * ca / ra;
                  const heightDiff = Math.abs(newFlex / ca - rf / ra);
                  const snapThreshold = rf / ra * snapFactor;
                  const score = snapThreshold > 0 ? heightDiff / snapThreshold : Infinity;
                  if (score < bestScore) {
                    bestScore = score;
                    bestTarget = target;
                  }
                }
              }
              if (bestTarget !== null && bestScore < 1) {
                newFlex = bestTarget;
                item.classList.add(CLASSES.itemSnap);
              } else {
                item.classList.remove(CLASSES.itemSnap);
              }
            }
          }
          item.style.flexGrow = String(newFlex);
          this.recalculateRowHeight();
          this.updateHandlePositions(index);
        };
        currentOnUp = () => {
          dragging = false;
          item.classList.remove(CLASSES.resizing);
          item.classList.remove(CLASSES.itemSnap);
          const finalFlex = parseFloat(item.style.flexGrow || "1");
          logger.debug("resize-mouseup", { index, finalFlex, timestamp: Date.now() });
          if (this.resizeEndCallback) {
            this.resizeEndCallback(index, finalFlex);
          }
          document.removeEventListener("mousemove", currentOnMove);
          document.removeEventListener("mouseup", currentOnUp);
          currentOnMove = null;
          currentOnUp = null;
        };
        document.addEventListener("mousemove", currentOnMove);
        document.addEventListener("mouseup", currentOnUp, { once: true });
      };
      handle._destroy = () => {
        if (currentOnMove) document.removeEventListener("mousemove", currentOnMove);
        if (currentOnUp) document.removeEventListener("mouseup", currentOnUp);
      };
      item.appendChild(handle);
      hd.el = handle;
      handles.push(handle);
    }
    this.handleDefs.push(defs);
    return handles;
  }
  /**
   * Recalculate layout based on loaded image dimensions.
   */
  applyLayout() {
    if (!this.container || this.group.images.length === 0) return;
    const metas = [];
    for (let i = 0; i < this.group.images.length; i++) {
      const meta = this.loadedMetas.get(i);
      if (meta) {
        metas.push(meta);
      } else {
        metas.push({ naturalWidth: 0, naturalHeight: 0 });
      }
    }
    const allLoaded = metas.every((m) => m.naturalWidth > 0);
    if (allLoaded) {
      if (this.group.images.some((img) => img.hasExplicitWidth)) {
        this.recalculateRowHeight();
        return;
      }
      const containerWidth = this.container.getBoundingClientRect().width;
      if (containerWidth === 0) {
        requestAnimationFrame(() => this.applyLayout());
        return;
      }
      const result = computeUniformHeight(
        metas,
        containerWidth,
        this.options.gap,
        50,
        this.options.defaultRowHeight * 3
      );
      this.rowHeight = result.rowHeight;
      const h = `${this.rowHeight}px`;
      this.container.style.height = h;
      const grows = computeFlexGrows(metas);
      for (let i = 0; i < this.itemEls.length && i < grows.length; i++) {
        this.itemEls[i].style.flexGrow = String(grows[i]);
        this.group.images[i].flexGrow = grows[i];
      }
      for (let i = 0; i < this.itemEls.length; i++) {
        this.itemEls[i].style.height = h;
      }
      for (let i = 0; i < this.imageEls.length; i++) {
        this.imageEls[i].style.height = h;
      }
      logger.debug("ImageRowWidget layout applied", {
        containerWidth,
        rowHeight: result.rowHeight,
        flexGrows: grows,
        imageCount: metas.length
      });
      this.onLayoutChange?.();
      void this.container.offsetHeight;
      this.updateAllHandlePositions();
    } else {
      this.container.style.height = `${this.options.defaultRowHeight}px`;
    }
  }
  /**
   * Recalculate the flex container height after divider/resize drag so that
   * all images display fully without clipping.  Uses current flex-grow values
   * and natural aspect ratios — the tallest image determines the row height.
   */
  recalculateRowHeight() {
    if (!this.container || this.itemEls.length === 0) return;
    const containerWidth = this.container.getBoundingClientRect().width;
    if (containerWidth === 0) return;
    for (let i = 0; i < this.group.images.length; i++) {
      const meta = this.loadedMetas.get(i);
      if (!meta || meta.naturalWidth === 0) return;
    }
    const n = this.itemEls.length;
    const availableWidth = containerWidth - (n - 1) * this.options.gap;
    let totalGrow = 0;
    const grows = [];
    for (let i = 0; i < n; i++) {
      const g = parseFloat(this.itemEls[i].style.flexGrow || "1");
      grows.push(g);
      totalGrow += g;
    }
    let maxHeight = 0;
    for (let i = 0; i < n; i++) {
      const meta = this.loadedMetas.get(i);
      const w = grows[i] / totalGrow * availableWidth;
      const h2 = w / (meta.naturalWidth / meta.naturalHeight);
      maxHeight = Math.max(maxHeight, h2);
    }
    const clamped = Math.max(
      50,
      Math.min(this.options.defaultRowHeight * 3, Math.round(maxHeight))
    );
    this.rowHeight = clamped;
    const h = `${clamped}px`;
    this.container.style.height = h;
    for (let i = 0; i < this.itemEls.length; i++) {
      this.itemEls[i].style.height = h;
    }
    for (let i = 0; i < this.imageEls.length; i++) {
      this.imageEls[i].style.height = h;
    }
    this.onLayoutChange?.();
    void this.container.offsetHeight;
    this.updateAllHandlePositions();
  }
  /**
   * Double-click on divider: snap the two adjacent images to equal heights.
   */
  snapDividerToEquilibrium(leftIndex) {
    const lm = this.loadedMetas.get(leftIndex);
    const rm = this.loadedMetas.get(leftIndex + 1);
    if (!lm || !rm || lm.naturalWidth === 0 || rm.naturalWidth === 0) return;
    const la = lm.naturalWidth / lm.naturalHeight;
    const ra = rm.naturalWidth / rm.naturalHeight;
    const leftItem = this.itemEls[leftIndex];
    const rightItem = this.itemEls[leftIndex + 1];
    if (!leftItem || !rightItem) return;
    const total = parseFloat(leftItem.style.flexGrow || "1") + parseFloat(rightItem.style.flexGrow || "1");
    const snapLeft = total * la / (la + ra);
    const snapRight = total - snapLeft;
    leftItem.style.flexGrow = String(snapLeft);
    rightItem.style.flexGrow = String(snapRight);
    this.recalculateRowHeight();
    logger.info("Divider dblclick snap to equilibrium", {
      leftIndex,
      total,
      snapLeft,
      snapRight,
      la,
      ra
    });
  }
  /**
   * Double-click top bar: snap ALL images in the row to equal heights.
   * Distributes flex-grow proportionally to aspect ratios so every image
   * has the same rendered height.
   */
  snapAllToEquilibrium() {
    const n = this.itemEls.length;
    if (n < 2) return;
    const aspects = [];
    let totalGrow = 0;
    for (let i = 0; i < n; i++) {
      const meta = this.loadedMetas.get(i);
      if (!meta || meta.naturalWidth === 0) return;
      aspects.push(meta.naturalWidth / meta.naturalHeight);
      totalGrow += parseFloat(this.itemEls[i].style.flexGrow || "1");
    }
    const aspectSum = aspects.reduce((s, a) => s + a, 0);
    const grows = aspects.map((a) => totalGrow * a / aspectSum);
    for (let i = 0; i < n; i++) {
      this.itemEls[i].style.flexGrow = String(grows[i]);
    }
    this.recalculateRowHeight();
    logger.info("Top bar dblclick global snap", { totalGrow, aspectSum, grows });
  }
  /**
   * Update the flex-grow values from an external source (e.g., after reorder).
   */
  updateFlexGrows(grows) {
    this.flexGrows = grows;
    for (let i = 0; i < this.itemEls.length && i < grows.length; i++) {
      this.itemEls[i].style.flexGrow = String(grows[i]);
    }
    this.recalculateRowHeight();
  }
  /**
   * Call when the container width changes (e.g., window resize).
   */
  onContainerResize() {
    this.applyLayout();
  }
  /**
   * Enable drag reorder on the images in this row.
   * Call after build() and after setting onReorder callback.
   */
  enableDragReorder() {
    if (!this.container) return;
    for (let i = 0; i < this.itemEls.length; i++) {
      const item = this.itemEls[i];
      item.draggable = true;
      item.ondragstart = (e) => {
        e.stopPropagation();
        e.dataTransfer.effectAllowed = "move";
        const payload = `diaa-row:${this.group.lineStart}:${i}`;
        e.dataTransfer.setData("text/plain", payload);
        e.dataTransfer.setData("application/diaa-row", payload);
        item.classList.add(CLASSES.dragging);
        item.style.opacity = String(1 - this.options.dragOpacity / 100);
        const imgEl = this.imageEls[i];
        if (imgEl && imgEl.naturalWidth > 0) {
          const pixel = document.createElement("canvas");
          pixel.width = 1;
          pixel.height = 1;
          pixel.style.cssText = "position:fixed;left:0;top:0;pointer-events:none";
          document.body.appendChild(pixel);
          e.dataTransfer.setDragImage(pixel, 0, 0);
          setTimeout(() => pixel.remove(), 0);
          const w = this.options.ghostImageWidth;
          const h = imgEl.naturalHeight / imgEl.naturalWidth * w;
          const dpr = window.devicePixelRatio || 1;
          const ghost = document.createElement("canvas");
          ghost.width = w * dpr;
          ghost.height = h * dpr;
          ghost.style.width = w + "px";
          ghost.style.height = h + "px";
          ghost.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;width:${w}px;height:${h}px;pointer-events:none;z-index:2147483647`;
          const ctx = ghost.getContext("2d");
          ctx.scale(dpr, dpr);
          ctx.drawImage(imgEl, 0, 0, w, h);
          document.body.appendChild(ghost);
          const onDragOver = (ev) => {
            ghost.style.left = ev.clientX + "px";
            ghost.style.top = ev.clientY + "px";
          };
          const onDragEnd = () => {
            document.removeEventListener("dragover", onDragOver, true);
            ghost.remove();
          };
          document.addEventListener("dragover", onDragOver, true);
          item.addEventListener("dragend", onDragEnd, { once: true });
        }
        logger.info("ImageRowWidget dragstart", {
          index: i,
          groupLineStart: this.group.lineStart,
          payload,
          targetTag: e.target.tagName,
          targetClass: e.target.className?.substring?.(0, 40) || ""
        });
      };
      item.ondragend = (e) => {
        e.stopPropagation();
        item.classList.remove(CLASSES.dragging);
        item.style.opacity = "";
        for (const el of this.itemEls) {
          el.style.borderLeft = "";
          el.style.borderRight = "";
        }
      };
      item.ondragover = (e) => {
        e.stopPropagation();
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const rect = item.getBoundingClientRect();
        const mid = rect.left + rect.width / 2;
        for (const el of this.itemEls) {
          el.style.borderLeft = "";
          el.style.borderRight = "";
        }
        if (e.clientX < mid) {
          item.style.borderLeft = "3px solid #4a9eff";
        } else {
          item.style.borderRight = "3px solid #4a9eff";
        }
      };
      item.ondragleave = (e) => {
        e.stopPropagation();
        item.style.borderLeft = "";
        item.style.borderRight = "";
      };
      item.ondrop = (e) => {
        e.stopPropagation();
        e.preventDefault();
        item.style.borderLeft = "";
        item.style.borderRight = "";
        const data = e.dataTransfer.getData("text/plain");
        logger.debug("ImageRowWidget item ondrop", { i, data: data?.substring(0, 60) });
        if (!data) return;
        const rect = item.getBoundingClientRect();
        const mid = rect.left + rect.width / 2;
        const insertAt = e.clientX < mid ? i : i + 1;
        const rowMatch = data.match(/^diaa-row:(\d+):(\d+)$/);
        if (rowMatch) {
          const srcLineStart = parseInt(rowMatch[1], 10);
          const srcIndex = parseInt(rowMatch[2], 10);
          if (srcLineStart === this.group.lineStart) {
            const toIndex = srcIndex < insertAt ? insertAt - 1 : insertAt;
            if (srcIndex !== toIndex && srcIndex !== i && this.reorderCallback) {
              this.reorderCallback(srcIndex, toIndex);
            }
            return;
          }
          if (this.mergeExternalCallback) {
            logger.info("ImageRowWidget inter-row merge", { i, insertAt, srcLineStart, srcIndex });
            this.mergeExternalCallback(insertAt, data);
          }
          return;
        }
        if ((data.startsWith("diaa-standalone:") || data.startsWith("obsidian://open")) && this.mergeExternalCallback) {
          logger.info("ImageRowWidget cross-row merge from standalone", { i, insertAt, data: data.substring(0, 60) });
          this.mergeExternalCallback(insertAt, data);
        }
      };
    }
    if (this.container) {
      this.container.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      });
      this.container.addEventListener("drop", (e) => {
        e.preventDefault();
        const data = e.dataTransfer.getData("text/plain");
        logger.debug("ImageRowWidget container ondrop", { data: data?.substring(0, 60) });
        if (!data) return;
        const rowMatch = data.match(/^diaa-row:(\d+):(\d+)$/);
        const isStandalone = data.startsWith("diaa-standalone:") || data.startsWith("obsidian://open");
        if ((rowMatch || isStandalone) && this.mergeExternalCallback) {
          const containerRect = this.container.getBoundingClientRect();
          const mid = containerRect.left + containerRect.width / 2;
          const insertAt = e.clientX < mid ? 0 : this.itemEls.length;
          logger.info("ImageRowWidget cross-row merge (container)", { insertAt });
          this.mergeExternalCallback(insertAt, data);
        }
      });
    }
  }
  /**
   * Clean up all event listeners.
   */
  destroy() {
    for (const divider of this.dividerEls) {
      if (divider._destroy) divider._destroy();
    }
    for (const handles of this.resizeHandles) {
      for (const h of handles) {
        if (h._destroy) h._destroy();
      }
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.imageEls = [];
    this.itemEls = [];
    this.dividerEls = [];
    this.resizeHandles = [];
    this.handleDefs = [];
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
  }
};

// src/livePreview.ts
function findStandaloneImageLine(view, obsidianUri, targetGroup) {
  try {
    const match = obsidianUri.match(/[?&]file=([^&]+)/);
    if (!match) return null;
    const encodedPath = match[1];
    const filePath = decodeURIComponent(encodedPath);
    const fileName = filePath.split("/").pop();
    if (!fileName) return null;
    logger.debug("findStandaloneImageLine parsing URI", {
      encodedPath,
      fileName
    });
    const doc = view.state.doc;
    const groupLines = /* @__PURE__ */ new Set();
    for (let g = targetGroup.lineStart; g < targetGroup.lineEnd; g++) {
      groupLines.add(g);
    }
    for (let i = 1; i <= doc.lines; i++) {
      if (groupLines.has(i - 1)) continue;
      const lineText = doc.line(i).text;
      if (lineText.includes(fileName) && /^[\s]*!\[\[/.test(lineText)) {
        logger.debug("findStandaloneImageLine found", { line: i - 1, lineText: lineText.substring(0, 60) });
        return i - 1;
      }
    }
    return null;
  } catch (e) {
    logger.error("findStandaloneImageLine error", { error: String(e) });
    return null;
  }
}
function resolveSourceLine(view, dataTransfer, targetGroup) {
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
function moveLine(view, srcLine, targetLine) {
  if (srcLine === targetLine) return;
  const doc = view.state.doc;
  const minLine = Math.min(srcLine, targetLine);
  const maxLine = Math.max(srcLine, targetLine);
  const fromPos = doc.line(minLine + 1).from;
  const maxLineNum = maxLine + 1;
  const toPos = maxLineNum + 1 <= doc.lines ? doc.line(maxLineNum + 1).from : doc.length;
  const originalText = doc.sliceString(fromPos, toPos);
  const originalLines = originalText.split("\n");
  const hadTrailingNewline = originalText.endsWith("\n");
  if (hadTrailingNewline && originalLines.length > 0) {
    originalLines.pop();
  }
  const localSrc = srcLine - minLine;
  const localTarget = targetLine - minLine;
  const [moved] = originalLines.splice(localSrc, 1);
  const insertAt = localTarget;
  originalLines.splice(insertAt, 0, moved);
  const insert = originalLines.join("\n") + (hadTrailingNewline ? "\n" : "");
  logger.info("LivePreview moveLine", {
    srcLine,
    targetLine,
    minLine,
    maxLine,
    fromPos,
    toPos,
    lineCount: originalLines.length + 1
  });
  view.dispatch({
    changes: { from: fromPos, to: toPos, insert }
  });
}
function normalizeRaw(raw) {
  return raw.replace(/\|[^\]]*(?=\]\])/, "");
}
function applyFlexGrowChanges(view, images, grows) {
  const changes = [];
  for (let i = 0; i < grows.length && i < images.length; i++) {
    const newLine = updateImageLineWidth(images[i].raw, grows[i]);
    if (newLine === images[i].raw) continue;
    const line = images[i].line + 1;
    const lineObj = view.state.doc.line(line);
    changes.push({ from: lineObj.from, to: lineObj.from + lineObj.text.length, insert: newLine });
  }
  if (changes.length === 0) return;
  changes.sort((a, b) => b.from - a.from);
  view.dispatch({ changes });
}
var StaticImageRowWidget = class extends import_view.WidgetType {
  constructor(group, options) {
    super();
    this.innerWidget = null;
    this.editorView = null;
    this.persistTimer = null;
    this.group = group;
    this.options = options;
    logger.debug("StaticImageRowWidget constructed", {
      imageCount: group.images.length,
      lineStart: group.lineStart,
      lineEnd: group.lineEnd
    });
  }
  eq(other) {
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
      if (normalizeRaw(a.images[i].raw) !== normalizeRaw(b.images[i].raw)) return false;
    }
    return true;
  }
  toDOM(view) {
    try {
      logger.debug("StaticImageRowWidget toDOM", {
        imageCount: this.group.images.length,
        files: this.group.images.map((i) => i.fileName)
      });
      this.editorView = view;
      this.innerWidget = new ImageRowWidget(this.group, this.options);
      const el = this.innerWidget.build();
      this.innerWidget.onLayoutChange = () => {
        this.editorView?.requestMeasure();
      };
      this.innerWidget.onReorder((fromIndex, toIndex) => {
        this.handleReorder(fromIndex, toIndex);
      });
      this.innerWidget.enableDragReorder();
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
  handleReorder(fromIndex, toIndex) {
    if (!this.editorView) return;
    const view = this.editorView;
    const images = this.group.images;
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || fromIndex >= images.length || toIndex < 0 || toIndex >= images.length) return;
    const fromLine = images[fromIndex].line;
    const toLine = images[toIndex].line;
    const minLine = this.group.lineStart;
    const maxLine = this.group.lineEnd - 1;
    const doc = view.state.doc;
    const fromPos = doc.line(minLine + 1).from;
    const toPos = maxLine + 2 <= doc.lines ? doc.line(maxLine + 2).from : doc.length;
    const originalText = doc.sliceString(fromPos, toPos);
    const originalLines = originalText.split("\n");
    const localFrom = fromLine - minLine;
    const localTo = toLine - minLine;
    const [moved] = originalLines.splice(localFrom, 1);
    const insertAt = fromIndex < toIndex ? localTo - (fromLine < toLine ? 1 : 0) + 1 : localTo;
    originalLines.splice(insertAt, 0, moved);
    const insert = originalLines.join("\n");
    logger.info("LivePreview drag reorder", {
      fromIndex,
      toIndex,
      fromLine,
      toLine,
      minLine,
      maxLine,
      fromPos,
      toPos,
      docLength: doc.length,
      docLines: doc.lines,
      before: images.map((i) => i.raw),
      after: originalLines,
      originalLength: originalText.length,
      insertLength: insert.length
    });
    view.dispatch({
      changes: { from: fromPos, to: toPos, insert }
    });
    const newDoc = view.state.doc.toString();
    logger.debug("LivePreview post-reorder doc", {
      docLines: view.state.doc.lines,
      docLength: view.state.doc.length,
      docPreview: newDoc.substring(0, 500)
    });
    const capturedView = view;
    requestAnimationFrame(() => {
      try {
        const allEmbeds = capturedView.dom.querySelectorAll(
          ".internal-embed.image-embed"
        );
        const embedInfo = [];
        for (let i = 0; i < allEmbeds.length; i++) {
          const el = allEmbeds[i];
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
            parentClass: el.parentElement?.className?.substring(0, 60) || ""
          });
        }
        logger.debug("LivePreview post-reorder DOM check", {
          embedCount: allEmbeds.length,
          cmLineCount: capturedView.dom.querySelectorAll(".cm-line").length,
          embeds: embedInfo
        });
      } catch (err) {
        logger.debug("LivePreview post-reorder DOM check error", {
          error: String(err)
        });
      }
    });
  }
  /**
   * Merge an image from another location into this flex row.
   * Supports both standalone (obsidian://open) and flex-row ("diaa-row:") sources.
   */
  handleMergeExternal(insertAtIndex, dataTransfer) {
    if (!this.editorView) return;
    const view = this.editorView;
    const srcLine = resolveSourceLine(view, dataTransfer, this.group);
    if (srcLine === null) {
      logger.debug("LivePreview mergeExternal: could not resolve source");
      return;
    }
    const targetLine = this.group.lineStart + insertAtIndex;
    if (srcLine === targetLine) return;
    logger.info("LivePreview cross-row merge", {
      srcLine,
      targetLine,
      insertAtIndex,
      dataTransfer: dataTransfer.substring(0, 40)
    });
    moveLine(view, srcLine, targetLine);
  }
  updateDOM(_element, view) {
    if (this.innerWidget && this.group) {
      const doc = view.state.doc;
      const grows = [];
      for (let line = this.group.lineStart; line < this.group.lineEnd; line++) {
        const text = doc.line(line + 1).text;
        const match = text.match(/\|(\d+)(?:\]\]|\|)/);
        const flex = match ? parseInt(match[1], 10) / 100 : 1;
        grows.push(flex);
      }
      if (grows.length === this.group.images.length) {
        this.innerWidget.updateFlexGrows(grows);
      }
    }
    return true;
  }
  ignoreEvent(event) {
    if (event.type.startsWith("drag")) return true;
    const target = event.target;
    if (target?.closest?.("." + CLASSES.resizeHandle) || target?.closest?.("." + CLASSES.divider)) {
      return true;
    }
    return false;
  }
  destroy() {
    logger.debug("StaticImageRowWidget destroyed");
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    if (this.editorView && this.innerWidget) {
      const view = this.editorView;
      const images = [...this.group.images];
      const grows = this.innerWidget.getCurrentFlexGrows();
      setTimeout(() => applyFlexGrowChanges(view, images, grows), 0);
    }
    this.innerWidget?.destroy();
    this.innerWidget = null;
  }
  /** Write current flex-grow values back to markdown as ![[file|width]]. */
  persistFlexGrows() {
    if (!this.editorView || !this.innerWidget) return;
    applyFlexGrowChanges(
      this.editorView,
      this.group.images,
      this.innerWidget.getCurrentFlexGrows()
    );
  }
};
function updateImageLineWidth(raw, flexGrow) {
  const widthValue = Math.round(flexGrow * 100);
  let out = raw.replace(/\|[^\]]*(?=\]\])/, "");
  if (widthValue === 100) return out;
  return out.replace(/\]\]/, `|${widthValue}]]`);
}
function buildDecorations(state, getOptions, getSettings, isEnabled) {
  try {
    const stack = new Error().stack?.split("\n").slice(2, 8).join("\n") || "";
    logger.debug("buildDecorations invoked", { timestamp: Date.now(), stack });
    if (!isEnabled()) {
      logger.debug("LivePreview decorations skipped (disabled)");
      return import_view.Decoration.none;
    }
    if (!state.field(import_obsidian3.editorLivePreviewField, false)) {
      logger.debug("LivePreview decorations skipped (source mode)");
      return import_view.Decoration.none;
    }
    const doc = state.doc.toString();
    if (!doc) return import_view.Decoration.none;
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
      groups: groups.map((g) => ({
        lineStart: g.lineStart,
        lineEnd: g.lineEnd,
        count: g.images.length,
        files: g.images.map((i) => i.fileName),
        raws: g.images.map((i) => i.raw)
      }))
    });
    const builder = new import_state.RangeSetBuilder();
    let decorationAdded = false;
    for (const group of groups) {
      try {
        if (group.images.length < 1) continue;
        const lineCount = state.doc.lines;
        const lineStart1 = group.lineStart + 1;
        const lineEnd1 = group.lineEnd;
        if (lineStart1 > lineCount || lineEnd1 > lineCount) {
          logger.debug("LivePreview skipping group (out of range)", {
            lineStart1,
            lineEnd1,
            lineCount
          });
          continue;
        }
        const from = state.doc.line(lineStart1).from;
        const to = lineEnd1 < lineCount ? state.doc.line(lineEnd1 + 1).from : state.doc.length;
        logger.debug("LivePreview decoration range", {
          groupLineStart: group.lineStart,
          groupLineEnd: group.lineEnd,
          lineStart1,
          lineEnd1,
          lineCount,
          from,
          to,
          docLength: state.doc.length,
          imageCount: group.images.length
        });
        if (to <= from) {
          logger.debug("LivePreview skipping group (to <= from)", { from, to });
          continue;
        }
        builder.add(
          from,
          to,
          import_view.Decoration.replace({
            widget: new StaticImageRowWidget(group, options),
            block: true,
            inclusive: true
          })
        );
        decorationAdded = true;
      } catch (e) {
        logger.error("LivePreview widget creation error", {
          groupLineStart: group.lineStart,
          error: String(e)
        });
      }
    }
    const result = builder.finish();
    logger.debug("LivePreview decorations built", {
      decorationAdded,
      setSize: result.size
    });
    return result;
  } catch (e) {
    logger.error("LivePreview buildDecorations error", { error: String(e) });
    return import_view.Decoration.none;
  }
}
var settingsChanged = import_state.Annotation.define();
function createLivePreviewPlugin(getOptions, getSettings, isEnabled) {
  let wasLivePreview = false;
  const field = import_state.StateField.define({
    create(state) {
      wasLivePreview = !!state.field(import_obsidian3.editorLivePreviewField, false);
      logger.debug("LivePreview StateField create", { wasLivePreview });
      return buildDecorations(state, getOptions, getSettings, isEnabled);
    },
    update(_oldDecos, tr) {
      const isLivePreview = !!tr.state.field(import_obsidian3.editorLivePreviewField, false);
      const docChanged = tr.docChanged;
      const settingsAnnot = tr.annotation(settingsChanged);
      const lpChanged = wasLivePreview !== isLivePreview;
      if (docChanged || settingsAnnot || lpChanged) {
        logger.debug("StateField.update \u2192 buildDecorations", {
          docChanged,
          settingsAnnotation: !!settingsAnnot,
          livePreviewChanged: lpChanged,
          timestamp: Date.now()
        });
        wasLivePreview = isLivePreview;
        return buildDecorations(tr.state, getOptions, getSettings, isEnabled);
      }
      return _oldDecos;
    },
    provide: (f) => import_view.EditorView.decorations.from(f)
  });
  return import_state.Prec.highest(field);
}
function createStandaloneDropPlugin(getSettings, isEnabled) {
  return import_view.ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.editorEl = null;
        this.onDragStart = null;
        this.onDragOver = null;
        this.onDragLeave = null;
        this.onDragEnd = null;
        this.onDrop = null;
        this.dragoverLogged = false;
        this.dropIndicatorEl = null;
        this.dropSide = null;
        this.view = view;
        this.setup();
      }
      update(_update) {
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
      clearDropIndicator() {
        if (this.dropIndicatorEl) {
          this.dropIndicatorEl.classList.remove("diaa-drop-target-line", "diaa-drop-left", "diaa-drop-right");
          this.dropIndicatorEl.style.boxShadow = "";
          this.dropIndicatorEl = null;
        }
        this.dropSide = null;
      }
      findDropTarget(clientX, clientY) {
        const targetEl = document.elementFromPoint(clientX, clientY);
        if (!targetEl || !this.view.dom.contains(targetEl)) return null;
        const flexRow = targetEl.closest(".drag-img-row");
        if (flexRow) {
          const ls = parseInt(flexRow.dataset.lineStart || "", 10);
          const le = parseInt(flexRow.dataset.lineEnd || "", 10);
          if (!isNaN(ls) && !isNaN(le)) {
            const pos2 = this.view.posAtDOM(flexRow);
            if (pos2 >= 0) {
              return {
                pos: pos2,
                line: ls,
                isImageLine: false,
                isFlexRow: true,
                rowLineStart: ls,
                rowLineEnd: le,
                element: flexRow,
                cmLine: null
              };
            }
          }
        }
        const embed = targetEl.closest(".internal-embed.image-embed");
        const cmLine = targetEl.closest(".cm-line");
        const domEl = cmLine || embed;
        if (!domEl) return null;
        const pos = this.view.posAtDOM(domEl);
        if (pos < 0) return null;
        const line = this.view.state.doc.lineAt(pos).number - 1;
        return {
          pos,
          line,
          isImageLine: !!embed,
          isFlexRow: false,
          rowLineStart: null,
          rowLineEnd: null,
          element: domEl,
          cmLine: cmLine || null
        };
      }
      showDropIndicator(targetInfo, clientX) {
        this.clearDropIndicator();
        if (!targetInfo) return;
        if (targetInfo.isFlexRow) {
          const rowEl = targetInfo.element;
          const rect = rowEl.getBoundingClientRect();
          const mid = rect.left + rect.width / 2;
          if (clientX !== void 0 && clientX < mid) {
            rowEl.style.boxShadow = "inset 3px 0 0 #4a9eff";
            this.dropSide = "left";
          } else {
            rowEl.style.boxShadow = "inset -3px 0 0 #4a9eff";
            this.dropSide = "right";
          }
          this.dropIndicatorEl = rowEl;
          return;
        }
        const indicatorEl = targetInfo.cmLine || targetInfo.element;
        if (!indicatorEl) return;
        if (clientX !== void 0 && targetInfo.isImageLine) {
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
      setup() {
        this.editorEl = this.view.dom;
        this.onDragStart = (e) => {
          const target = e.target;
          const embed = target?.closest?.(".internal-embed.image-embed");
          if (!embed) {
            const flexItem = target?.closest?.(".drag-img-item");
            logger.info("SD dragstart: not an obsidian embed", {
              targetTag: target?.tagName,
              targetClass: target?.className?.substring?.(0, 60) || "",
              isFlexItem: !!flexItem
            });
            return;
          }
          const root = embed.getRootNode();
          const domNode = root instanceof ShadowRoot ? root.host : embed;
          const pos = this.view.posAtDOM(domNode);
          if (pos < 0) {
            logger.info("SD dragstart: posAtDOM failed", {
              tag: domNode.tagName,
              shadowRoot: root instanceof ShadowRoot
            });
            return;
          }
          const line = this.view.state.doc.lineAt(pos).number - 1;
          e.dataTransfer.setData("application/diaa-source", String(line));
          embed.style.opacity = String(1 - getSettings().dragOpacity / 100);
          const restoreOpacity = () => {
            embed.style.opacity = "";
          };
          embed.addEventListener("dragend", restoreOpacity, { once: true });
          const img = embed.querySelector("img");
          if (img && img.naturalWidth > 0) {
            const pixel = document.createElement("canvas");
            pixel.width = 1;
            pixel.height = 1;
            pixel.style.cssText = "position:fixed;left:0;top:0;pointer-events:none";
            document.body.appendChild(pixel);
            e.dataTransfer.setDragImage(pixel, 0, 0);
            setTimeout(() => pixel.remove(), 0);
            const w = getSettings().ghostImageWidth;
            const h = img.naturalHeight / img.naturalWidth * w;
            const dpr = window.devicePixelRatio || 1;
            const ghost = document.createElement("canvas");
            ghost.width = w * dpr;
            ghost.height = h * dpr;
            ghost.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;width:${w}px;height:${h}px;pointer-events:none;z-index:2147483647`;
            const ctx = ghost.getContext("2d");
            ctx.scale(dpr, dpr);
            ctx.drawImage(img, 0, 0, w, h);
            document.body.appendChild(ghost);
            const onDragOver = (ev) => {
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
        this.onDragOver = (e) => {
          const hasDiaaSource = e.dataTransfer?.types.includes("application/diaa-source");
          const hasDiaaRow = e.dataTransfer?.types.includes("application/diaa-row");
          if (!hasDiaaSource && !hasDiaaRow) return;
          if (hasDiaaRow) {
            const targetEl = e.target;
            if (targetEl?.closest?.(".drag-img-row")) {
              this.clearDropIndicator();
              return;
            }
          }
          if (!this.dragoverLogged) {
            this.dragoverLogged = true;
            logger.info("SD dragover first", { hasDiaaSource, hasDiaaRow });
          }
          const targetInfo = this.findDropTarget(e.clientX, e.clientY);
          if (!targetInfo) {
            this.clearDropIndicator();
            return;
          }
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          this.showDropIndicator(targetInfo, e.clientX);
        };
        this.onDrop = (e) => {
          this.clearDropIndicator();
          const textPlain = e.dataTransfer?.getData("text/plain") || "";
          logger.info("SD drop enter", {
            hasDiaaSource: e.dataTransfer?.types.includes("application/diaa-source"),
            textPlain: textPlain.substring(0, 60)
          });
          if (!isEnabled()) return;
          if (textPlain.startsWith("diaa-row:")) {
            const rowMatch = textPlain.match(/^diaa-row:(\d+):(\d+)$/);
            if (!rowMatch) return;
            const targetEl = e.target;
            if (targetEl?.closest?.(".drag-img-row")) return;
            const srcLineStart = parseInt(rowMatch[1], 10);
            const srcIndex = parseInt(rowMatch[2], 10);
            const srcLine2 = srcLineStart + srcIndex;
            const dropTarget2 = this.findDropTarget(e.clientX, e.clientY);
            if (!dropTarget2 || dropTarget2.isFlexRow) return;
            let targetLine2 = dropTarget2.line;
            if (dropTarget2.isImageLine) {
              const rect = dropTarget2.element.getBoundingClientRect();
              const mid = rect.left + rect.width / 2;
              if (e.clientX >= mid) targetLine2 = dropTarget2.line + 1;
            }
            if (srcLine2 === targetLine2) return;
            logger.info("SD flex-row \u2192 standalone: moveLine", {
              srcLine: srcLine2,
              targetLine: targetLine2,
              dropLine: dropTarget2.line,
              isImageLine: dropTarget2.isImageLine
            });
            e.preventDefault();
            e.stopPropagation();
            moveLine(this.view, srcLine2, targetLine2);
            return;
          }
          if (!e.dataTransfer?.types.includes("application/diaa-source")) return;
          if (e.target?.closest?.(".drag-img-row")) return;
          const srcLine = parseInt(e.dataTransfer.getData("application/diaa-source"), 10);
          if (isNaN(srcLine)) {
            logger.info("SD drop: could not parse source line from diaa-source");
            return;
          }
          const dropTarget = this.findDropTarget(e.clientX, e.clientY);
          let baseTargetLine;
          let targetLine;
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
          logger.info("SD standalone \u2192 standalone: moveLine", {
            srcLine,
            targetLine,
            baseTargetLine,
            side
          });
          e.preventDefault();
          e.stopPropagation();
          moveLine(this.view, srcLine, targetLine);
        };
        this.onDragLeave = (e) => {
          if (!e.dataTransfer?.types.includes("application/diaa-source") && !e.dataTransfer?.types.includes("application/diaa-row")) return;
          const relatedTarget = e.relatedTarget;
          if (!relatedTarget || !this.view.dom.contains(relatedTarget)) {
            this.clearDropIndicator();
          }
        };
        this.onDragEnd = (_e) => {
          this.clearDropIndicator();
        };
        window.addEventListener("dragstart", this.onDragStart, true);
        window.addEventListener("dragover", this.onDragOver, true);
        window.addEventListener("dragleave", this.onDragLeave, true);
        window.addEventListener("dragend", this.onDragEnd, true);
        window.addEventListener("drop", this.onDrop, true);
        logger.info("SD setup complete: handlers on window capture", {
          domTag: this.view.dom?.tagName
        });
      }
    }
  );
}

// src/main.ts
var DragImageAutoArrangePlugin = class extends import_obsidian4.Plugin {
  constructor() {
    super(...arguments);
    this.settings = {
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
      dragOpacity: 60
    };
  }
  async onload() {
    logger.init(
      this.app.vault.adapter,
      ".obsidian/plugins/obsidian-DragImageAutoArrange/log.txt"
    );
    logger.info("Plugin loading", { version: this.manifest.version });
    this.settings = await loadSettings(this);
    logger.info("Settings loaded", {
      enabled: this.settings.enabled,
      maxImagesPerRow: this.settings.maxImagesPerRow,
      defaultRowHeight: this.settings.defaultRowHeight,
      gapSize: this.settings.gapSize,
      imageExtensions: this.settings.imageExtensions,
      enableDragReorder: this.settings.enableDragReorder,
      enableResize: this.settings.enableResize,
      enableDividers: this.settings.enableDividers
    });
    this.addSettingTab(
      new DragImageSettingTab(this.app, this)
    );
    this.registerMarkdownPostProcessor(
      createReadingModeProcessor(
        this.app,
        () => this.buildImageRowOptions(),
        () => this.settings.enabled
      )
    );
    logger.info("Reading Mode processor registered");
    this.registerEditorExtension(
      createLivePreviewPlugin(
        () => this.buildImageRowOptions(),
        () => this.settings,
        () => this.settings.enabled
      )
    );
    logger.info("Live Preview extension registered");
    this.registerEditorExtension(
      createStandaloneDropPlugin(
        () => this.settings,
        () => this.settings.enabled
      )
    );
    logger.info("Standalone drop plugin registered");
    this.addCommand({
      id: "rescan-image-groups",
      name: "Rescan image groups in current note",
      editorCallback: (_editor, view) => {
        logger.info("Command: rescan-image-groups");
        if (view instanceof import_obsidian4.MarkdownView && view.previewMode) {
          view.previewMode.rerender(true);
        } else {
          _editor.refresh();
        }
      }
    });
    this.addCommand({
      id: "toggle-image-arrange",
      name: "Toggle image auto-arrange (on/off)",
      callback: async () => {
        this.settings.enabled = !this.settings.enabled;
        logger.info("Command: toggle-image-arrange", {
          newValue: this.settings.enabled
        });
        await this.saveSettings();
        const leaf = this.app.workspace.activeLeaf;
        if (leaf) {
          const state = leaf.getViewState();
          await leaf.setViewState({ type: state.type, state: state.state });
        }
      }
    });
    logger.info("Plugin loaded successfully");
  }
  async onunload() {
    logger.info("Plugin unloading");
    await logger.dispose();
  }
  async saveSettings() {
    await this.saveData(this.settings);
    this.app.workspace.iterateAllLeaves((leaf) => {
      const cm = leaf.view?.editor?.cm;
      if (cm?.dispatch) {
        cm.dispatch({ annotations: [settingsChanged.of(true)] });
      }
    });
  }
  buildImageRowOptions() {
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
      getResourcePath: (fileName) => {
        const url = this.resolveImagePath(fileName, sourcePath);
        if (!url) {
          logger.debug("Image not found in vault", { fileName, sourcePath });
        }
        return url;
      }
    };
  }
  resolveImagePath(fileName, sourcePath) {
    const decoded = decodeURIComponent(fileName);
    const file = this.app.metadataCache.getFirstLinkpathDest(decoded, sourcePath);
    if (file) {
      return this.app.vault.getResourcePath(file);
    }
    return "";
  }
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsic3JjL21haW4udHMiLCAic3JjL3NldHRpbmdzLnRzIiwgInNyYy9jb25zdGFudHMudHMiLCAic3JjL3JlYWRpbmdNb2RlLnRzIiwgInNyYy9sb2dnZXIudHMiLCAic3JjL2xpdmVQcmV2aWV3LnRzIiwgInNyYy9pbWFnZURldGVjdG9yLnRzIiwgInNyYy9sYXlvdXRFbmdpbmUudHMiLCAic3JjL2ltYWdlUm93V2lkZ2V0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBQbHVnaW4sIE1hcmtkb3duVmlldyB9IGZyb20gXCJvYnNpZGlhblwiO1xuaW1wb3J0IHtcbiAgRHJhZ0ltYWdlU2V0dGluZ3MsXG4gIERyYWdJbWFnZVNldHRpbmdUYWIsXG4gIElEcmFnSW1hZ2VQbHVnaW4sXG4gIGxvYWRTZXR0aW5ncyxcbn0gZnJvbSBcIi4vc2V0dGluZ3NcIjtcbmltcG9ydCB7IGNyZWF0ZVJlYWRpbmdNb2RlUHJvY2Vzc29yIH0gZnJvbSBcIi4vcmVhZGluZ01vZGVcIjtcbmltcG9ydCB7IGNyZWF0ZUxpdmVQcmV2aWV3UGx1Z2luLCBjcmVhdGVTdGFuZGFsb25lRHJvcFBsdWdpbiwgc2V0dGluZ3NDaGFuZ2VkIH0gZnJvbSBcIi4vbGl2ZVByZXZpZXdcIjtcbmltcG9ydCB7IEltYWdlUm93T3B0aW9ucyB9IGZyb20gXCIuL2ltYWdlUm93V2lkZ2V0XCI7XG5pbXBvcnQgeyBsb2dnZXIgfSBmcm9tIFwiLi9sb2dnZXJcIjtcblxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgRHJhZ0ltYWdlQXV0b0FycmFuZ2VQbHVnaW5cbiAgZXh0ZW5kcyBQbHVnaW5cbiAgaW1wbGVtZW50cyBJRHJhZ0ltYWdlUGx1Z2luXG57XG4gIHNldHRpbmdzOiBEcmFnSW1hZ2VTZXR0aW5ncyA9IHtcbiAgICBlbmFibGVkOiBmYWxzZSxcbiAgICBkZWZhdWx0Um93SGVpZ2h0OiAyMDAsXG4gICAgbWF4SW1hZ2VzUGVyUm93OiAxMCxcbiAgICBnYXBTaXplOiA0LFxuICAgIHNuYXBTZW5zaXRpdml0eTogMyxcbiAgICBlbmFibGVEcmFnUmVvcmRlcjogdHJ1ZSxcbiAgICBlbmFibGVSZXNpemU6IHRydWUsXG4gICAgZW5hYmxlRGl2aWRlcnM6IHRydWUsXG4gICAgaW1hZ2VFeHRlbnNpb25zOiBcInBuZyxqcGcsanBlZyxnaWYsd2VicCxzdmcsYm1wLGF2aWZcIixcbiAgICB0b3BCYXJTZW5zaXRpdml0eTogMTIsXG4gICAgZ2hvc3RJbWFnZVdpZHRoOiAxMjAsXG4gICAgZHJhZ09wYWNpdHk6IDYwLFxuICB9O1xuXG4gIGFzeW5jIG9ubG9hZCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICAvLyBJbml0IGZpbGUgbG9nZ2VyIChoYXJkY29kZWQgcGF0aCBmb3IgZGVidWdnaW5nKVxuICAgIGxvZ2dlci5pbml0KFxuICAgICAgdGhpcy5hcHAudmF1bHQuYWRhcHRlcixcbiAgICAgIFwiLm9ic2lkaWFuL3BsdWdpbnMvb2JzaWRpYW4tRHJhZ0ltYWdlQXV0b0FycmFuZ2UvbG9nLnR4dFwiXG4gICAgKTtcbiAgICBsb2dnZXIuaW5mbyhcIlBsdWdpbiBsb2FkaW5nXCIsIHsgdmVyc2lvbjogdGhpcy5tYW5pZmVzdC52ZXJzaW9uIH0pO1xuXG4gICAgdGhpcy5zZXR0aW5ncyA9IGF3YWl0IGxvYWRTZXR0aW5ncyh0aGlzKTtcbiAgICBsb2dnZXIuaW5mbyhcIlNldHRpbmdzIGxvYWRlZFwiLCB7XG4gICAgICBlbmFibGVkOiB0aGlzLnNldHRpbmdzLmVuYWJsZWQsXG4gICAgICBtYXhJbWFnZXNQZXJSb3c6IHRoaXMuc2V0dGluZ3MubWF4SW1hZ2VzUGVyUm93LFxuICAgICAgZGVmYXVsdFJvd0hlaWdodDogdGhpcy5zZXR0aW5ncy5kZWZhdWx0Um93SGVpZ2h0LFxuICAgICAgZ2FwU2l6ZTogdGhpcy5zZXR0aW5ncy5nYXBTaXplLFxuICAgICAgaW1hZ2VFeHRlbnNpb25zOiB0aGlzLnNldHRpbmdzLmltYWdlRXh0ZW5zaW9ucyxcbiAgICAgIGVuYWJsZURyYWdSZW9yZGVyOiB0aGlzLnNldHRpbmdzLmVuYWJsZURyYWdSZW9yZGVyLFxuICAgICAgZW5hYmxlUmVzaXplOiB0aGlzLnNldHRpbmdzLmVuYWJsZVJlc2l6ZSxcbiAgICAgIGVuYWJsZURpdmlkZXJzOiB0aGlzLnNldHRpbmdzLmVuYWJsZURpdmlkZXJzLFxuICAgIH0pO1xuXG4gICAgdGhpcy5hZGRTZXR0aW5nVGFiKFxuICAgICAgbmV3IERyYWdJbWFnZVNldHRpbmdUYWIodGhpcy5hcHAsIHRoaXMgYXMgSURyYWdJbWFnZVBsdWdpbilcbiAgICApO1xuXG4gICAgLy8gUmVhZGluZyBNb2RlIHByb2Nlc3NvciB3aXRoIGRyYWctdG8tbWVyZ2Ugc3VwcG9ydFxuICAgIHRoaXMucmVnaXN0ZXJNYXJrZG93blBvc3RQcm9jZXNzb3IoXG4gICAgICBjcmVhdGVSZWFkaW5nTW9kZVByb2Nlc3NvcihcbiAgICAgICAgdGhpcy5hcHAsXG4gICAgICAgICgpID0+IHRoaXMuYnVpbGRJbWFnZVJvd09wdGlvbnMoKSxcbiAgICAgICAgKCkgPT4gdGhpcy5zZXR0aW5ncy5lbmFibGVkXG4gICAgICApXG4gICAgKTtcbiAgICBsb2dnZXIuaW5mbyhcIlJlYWRpbmcgTW9kZSBwcm9jZXNzb3IgcmVnaXN0ZXJlZFwiKTtcblxuICAgIC8vIExpdmUgUHJldmlldyBlZGl0b3IgZXh0ZW5zaW9uIChDb2RlTWlycm9yIFZpZXdQbHVnaW4pXG4gICAgdGhpcy5yZWdpc3RlckVkaXRvckV4dGVuc2lvbihcbiAgICAgIGNyZWF0ZUxpdmVQcmV2aWV3UGx1Z2luKFxuICAgICAgICAoKSA9PiB0aGlzLmJ1aWxkSW1hZ2VSb3dPcHRpb25zKCksXG4gICAgICAgICgpID0+IHRoaXMuc2V0dGluZ3MsXG4gICAgICAgICgpID0+IHRoaXMuc2V0dGluZ3MuZW5hYmxlZFxuICAgICAgKVxuICAgICk7XG4gICAgbG9nZ2VyLmluZm8oXCJMaXZlIFByZXZpZXcgZXh0ZW5zaW9uIHJlZ2lzdGVyZWRcIik7XG5cbiAgICAvLyBTdGFuZGFsb25lIGxpbmUgZHJvcCBoYW5kbGVyIChmbGV4IHJvdyBcdTIxOTIgc3RhbmRhbG9uZSlcbiAgICB0aGlzLnJlZ2lzdGVyRWRpdG9yRXh0ZW5zaW9uKFxuICAgICAgY3JlYXRlU3RhbmRhbG9uZURyb3BQbHVnaW4oXG4gICAgICAgICgpID0+IHRoaXMuc2V0dGluZ3MsXG4gICAgICAgICgpID0+IHRoaXMuc2V0dGluZ3MuZW5hYmxlZFxuICAgICAgKVxuICAgICk7XG4gICAgbG9nZ2VyLmluZm8oXCJTdGFuZGFsb25lIGRyb3AgcGx1Z2luIHJlZ2lzdGVyZWRcIik7XG5cbiAgICAvLyBDb21tYW5kOiByZXNjYW4gaW1hZ2UgZ3JvdXBzXG4gICAgdGhpcy5hZGRDb21tYW5kKHtcbiAgICAgIGlkOiBcInJlc2Nhbi1pbWFnZS1ncm91cHNcIixcbiAgICAgIG5hbWU6IFwiUmVzY2FuIGltYWdlIGdyb3VwcyBpbiBjdXJyZW50IG5vdGVcIixcbiAgICAgIGVkaXRvckNhbGxiYWNrOiAoX2VkaXRvciwgdmlldykgPT4ge1xuICAgICAgICBsb2dnZXIuaW5mbyhcIkNvbW1hbmQ6IHJlc2Nhbi1pbWFnZS1ncm91cHNcIik7XG4gICAgICAgIGlmICh2aWV3IGluc3RhbmNlb2YgTWFya2Rvd25WaWV3ICYmIHZpZXcucHJldmlld01vZGUpIHtcbiAgICAgICAgICB2aWV3LnByZXZpZXdNb2RlLnJlcmVuZGVyKHRydWUpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIF9lZGl0b3IucmVmcmVzaCgpO1xuICAgICAgICB9XG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gQ29tbWFuZDogdG9nZ2xlIGF1dG8tYXJyYW5nZVxuICAgIHRoaXMuYWRkQ29tbWFuZCh7XG4gICAgICBpZDogXCJ0b2dnbGUtaW1hZ2UtYXJyYW5nZVwiLFxuICAgICAgbmFtZTogXCJUb2dnbGUgaW1hZ2UgYXV0by1hcnJhbmdlIChvbi9vZmYpXCIsXG4gICAgICBjYWxsYmFjazogYXN5bmMgKCkgPT4ge1xuICAgICAgICB0aGlzLnNldHRpbmdzLmVuYWJsZWQgPSAhdGhpcy5zZXR0aW5ncy5lbmFibGVkO1xuICAgICAgICBsb2dnZXIuaW5mbyhcIkNvbW1hbmQ6IHRvZ2dsZS1pbWFnZS1hcnJhbmdlXCIsIHtcbiAgICAgICAgICBuZXdWYWx1ZTogdGhpcy5zZXR0aW5ncy5lbmFibGVkLFxuICAgICAgICB9KTtcbiAgICAgICAgYXdhaXQgdGhpcy5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgY29uc3QgbGVhZiA9IHRoaXMuYXBwLndvcmtzcGFjZS5hY3RpdmVMZWFmO1xuICAgICAgICBpZiAobGVhZikge1xuICAgICAgICAgIGNvbnN0IHN0YXRlID0gbGVhZi5nZXRWaWV3U3RhdGUoKTtcbiAgICAgICAgICBhd2FpdCBsZWFmLnNldFZpZXdTdGF0ZSh7IHR5cGU6IHN0YXRlLnR5cGUsIHN0YXRlOiBzdGF0ZS5zdGF0ZSB9KTtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGxvZ2dlci5pbmZvKFwiUGx1Z2luIGxvYWRlZCBzdWNjZXNzZnVsbHlcIik7XG4gIH1cblxuICBhc3luYyBvbnVubG9hZCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBsb2dnZXIuaW5mbyhcIlBsdWdpbiB1bmxvYWRpbmdcIik7XG4gICAgYXdhaXQgbG9nZ2VyLmRpc3Bvc2UoKTtcbiAgfVxuXG4gIGFzeW5jIHNhdmVTZXR0aW5ncygpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCB0aGlzLnNhdmVEYXRhKHRoaXMuc2V0dGluZ3MpO1xuICAgIC8vIE5vdGlmeSBMaXZlIFByZXZpZXcgZWRpdG9ycyBzbyB0aGV5IHJlYnVpbGQgZGVjb3JhdGlvbnMgd2l0aCBmcmVzaCBvcHRpb25zXG4gICAgdGhpcy5hcHAud29ya3NwYWNlLml0ZXJhdGVBbGxMZWF2ZXMoKGxlYWYpID0+IHtcbiAgICAgIGNvbnN0IGNtID0gKGxlYWYudmlldyBhcyBhbnkpPy5lZGl0b3I/LmNtO1xuICAgICAgaWYgKGNtPy5kaXNwYXRjaCkge1xuICAgICAgICBjbS5kaXNwYXRjaCh7IGFubm90YXRpb25zOiBbc2V0dGluZ3NDaGFuZ2VkLm9mKHRydWUpXSB9KTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgYnVpbGRJbWFnZVJvd09wdGlvbnMoKTogSW1hZ2VSb3dPcHRpb25zIHtcbiAgICBjb25zdCBhY3RpdmVGaWxlID0gdGhpcy5hcHAud29ya3NwYWNlLmdldEFjdGl2ZUZpbGUoKTtcbiAgICBjb25zdCBzb3VyY2VQYXRoID0gYWN0aXZlRmlsZT8ucGF0aCA/PyBcIlwiO1xuICAgIHJldHVybiB7XG4gICAgICBkZWZhdWx0Um93SGVpZ2h0OiB0aGlzLnNldHRpbmdzLmRlZmF1bHRSb3dIZWlnaHQsXG4gICAgICBnYXA6IHRoaXMuc2V0dGluZ3MuZ2FwU2l6ZSxcbiAgICAgIGVuYWJsZURpdmlkZXJzOiB0aGlzLnNldHRpbmdzLmVuYWJsZURpdmlkZXJzLFxuICAgICAgZW5hYmxlUmVzaXplOiB0aGlzLnNldHRpbmdzLmVuYWJsZVJlc2l6ZSxcbiAgICAgIHNuYXBTZW5zaXRpdml0eTogdGhpcy5zZXR0aW5ncy5zbmFwU2Vuc2l0aXZpdHksXG4gICAgICB0b3BCYXJTZW5zaXRpdml0eTogdGhpcy5zZXR0aW5ncy50b3BCYXJTZW5zaXRpdml0eSxcbiAgICAgIGdob3N0SW1hZ2VXaWR0aDogdGhpcy5zZXR0aW5ncy5naG9zdEltYWdlV2lkdGgsXG4gICAgICBkcmFnT3BhY2l0eTogdGhpcy5zZXR0aW5ncy5kcmFnT3BhY2l0eSxcbiAgICAgIGdldFJlc291cmNlUGF0aDogKGZpbGVOYW1lOiBzdHJpbmcpID0+IHtcbiAgICAgICAgY29uc3QgdXJsID0gdGhpcy5yZXNvbHZlSW1hZ2VQYXRoKGZpbGVOYW1lLCBzb3VyY2VQYXRoKTtcbiAgICAgICAgaWYgKCF1cmwpIHtcbiAgICAgICAgICBsb2dnZXIuZGVidWcoXCJJbWFnZSBub3QgZm91bmQgaW4gdmF1bHRcIiwgeyBmaWxlTmFtZSwgc291cmNlUGF0aCB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdXJsO1xuICAgICAgfSxcbiAgICB9O1xuICB9XG5cbiAgcHJpdmF0ZSByZXNvbHZlSW1hZ2VQYXRoKGZpbGVOYW1lOiBzdHJpbmcsIHNvdXJjZVBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3QgZGVjb2RlZCA9IGRlY29kZVVSSUNvbXBvbmVudChmaWxlTmFtZSk7XG4gICAgY29uc3QgZmlsZSA9IHRoaXMuYXBwLm1ldGFkYXRhQ2FjaGUuZ2V0Rmlyc3RMaW5rcGF0aERlc3QoZGVjb2RlZCwgc291cmNlUGF0aCk7XG4gICAgaWYgKGZpbGUpIHtcbiAgICAgIHJldHVybiB0aGlzLmFwcC52YXVsdC5nZXRSZXNvdXJjZVBhdGgoZmlsZSk7XG4gICAgfVxuICAgIHJldHVybiBcIlwiO1xuICB9XG59XG4iLCAiaW1wb3J0IHsgQXBwLCBQbHVnaW5TZXR0aW5nVGFiLCBTZXR0aW5nIH0gZnJvbSBcIm9ic2lkaWFuXCI7XG5pbXBvcnQgeyBERUZBVUxUX1NFVFRJTkdTIH0gZnJvbSBcIi4vY29uc3RhbnRzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRHJhZ0ltYWdlU2V0dGluZ3Mge1xuICBlbmFibGVkOiBib29sZWFuO1xuICBkZWZhdWx0Um93SGVpZ2h0OiBudW1iZXI7XG4gIG1heEltYWdlc1BlclJvdzogbnVtYmVyO1xuICBnYXBTaXplOiBudW1iZXI7XG4gIHNuYXBTZW5zaXRpdml0eTogbnVtYmVyO1xuICBlbmFibGVEcmFnUmVvcmRlcjogYm9vbGVhbjtcbiAgZW5hYmxlUmVzaXplOiBib29sZWFuO1xuICBlbmFibGVEaXZpZGVyczogYm9vbGVhbjtcbiAgaW1hZ2VFeHRlbnNpb25zOiBzdHJpbmc7XG4gIHRvcEJhclNlbnNpdGl2aXR5OiBudW1iZXI7XG4gIGdob3N0SW1hZ2VXaWR0aDogbnVtYmVyO1xuICBkcmFnT3BhY2l0eTogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIElEcmFnSW1hZ2VQbHVnaW4ge1xuICBzZXR0aW5nczogRHJhZ0ltYWdlU2V0dGluZ3M7XG4gIHNhdmVTZXR0aW5ncygpOiBQcm9taXNlPHZvaWQ+O1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9hZFNldHRpbmdzKHBsdWdpbjogeyBsb2FkRGF0YSgpOiBQcm9taXNlPGFueT4gfSk6IFByb21pc2U8RHJhZ0ltYWdlU2V0dGluZ3M+IHtcbiAgY29uc3QgZGF0YSA9IGF3YWl0IHBsdWdpbi5sb2FkRGF0YSgpO1xuICByZXR1cm4gT2JqZWN0LmFzc2lnbih7fSwgREVGQVVMVF9TRVRUSU5HUywgZGF0YSA/PyB7fSk7XG59XG5cbmV4cG9ydCBjbGFzcyBEcmFnSW1hZ2VTZXR0aW5nVGFiIGV4dGVuZHMgUGx1Z2luU2V0dGluZ1RhYiB7XG4gIHBsdWdpbjogSURyYWdJbWFnZVBsdWdpbjtcblxuICBjb25zdHJ1Y3RvcihhcHA6IEFwcCwgcGx1Z2luOiBJRHJhZ0ltYWdlUGx1Z2luKSB7XG4gICAgc3VwZXIoYXBwLCBwbHVnaW4gYXMgYW55KTtcbiAgICB0aGlzLnBsdWdpbiA9IHBsdWdpbjtcbiAgfVxuXG4gIGRpc3BsYXkoKTogdm9pZCB7XG4gICAgY29uc3QgeyBjb250YWluZXJFbCB9ID0gdGhpcztcbiAgICBjb250YWluZXJFbC5lbXB0eSgpO1xuXG4gICAgY29udGFpbmVyRWwuY3JlYXRlRWwoXCJoMlwiLCB7IHRleHQ6IFwiRHJhZyBJbWFnZSBBdXRvIEFycmFuZ2VcIiB9KTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoXCJFbmFibGUgcGx1Z2luXCIpXG4gICAgICAuc2V0RGVzYyhcIlRvZ2dsZSB0aGUgaW1hZ2UgYXV0by1hcnJhbmdlIGZlYXR1cmUgb24gb3Igb2ZmLlwiKVxuICAgICAgLmFkZFRvZ2dsZSgodG9nZ2xlKSA9PlxuICAgICAgICB0b2dnbGVcbiAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MuZW5hYmxlZClcbiAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5lbmFibGVkID0gdmFsdWU7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICB9KVxuICAgICAgKTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoXCJEZWZhdWx0IHJvdyBoZWlnaHRcIilcbiAgICAgIC5zZXREZXNjKFwiRGVmYXVsdCB1bmlmb3JtIGhlaWdodCAocHgpIGZvciBpbWFnZSByb3dzLiBJbmRpdmlkdWFsIHJvd3MgYWRhcHQgYmFzZWQgb24gaW1hZ2UgYXNwZWN0IHJhdGlvcy5cIilcbiAgICAgIC5hZGRTbGlkZXIoKHNsaWRlcikgPT5cbiAgICAgICAgc2xpZGVyXG4gICAgICAgICAgLnNldExpbWl0cyg4MCwgNjAwLCAxMClcbiAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MuZGVmYXVsdFJvd0hlaWdodClcbiAgICAgICAgICAuc2V0RHluYW1pY1Rvb2x0aXAoKVxuICAgICAgICAgIC5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLmRlZmF1bHRSb3dIZWlnaHQgPSB2YWx1ZTtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgIH0pXG4gICAgICApO1xuXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZShcIk1heCBpbWFnZXMgcGVyIHJvd1wiKVxuICAgICAgLnNldERlc2MoXCJNYXhpbXVtIG51bWJlciBvZiBpbWFnZXMgYWxsb3dlZCBpbiBhIHNpbmdsZSByb3cgKDEtMTApLiBHcm91cHMgZXhjZWVkaW5nIHRoaXMgbGltaXQgYXJlIHNwbGl0LlwiKVxuICAgICAgLmFkZFNsaWRlcigoc2xpZGVyKSA9PlxuICAgICAgICBzbGlkZXJcbiAgICAgICAgICAuc2V0TGltaXRzKDIsIDEwLCAxKVxuICAgICAgICAgIC5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5tYXhJbWFnZXNQZXJSb3cpXG4gICAgICAgICAgLnNldER5bmFtaWNUb29sdGlwKClcbiAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5tYXhJbWFnZXNQZXJSb3cgPSB2YWx1ZTtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgIH0pXG4gICAgICApO1xuXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZShcIkdhcCBzaXplXCIpXG4gICAgICAuc2V0RGVzYyhcIlNwYWNpbmcgYmV0d2VlbiBpbWFnZXMgaW4gYSByb3cgKHB4KS5cIilcbiAgICAgIC5hZGRTbGlkZXIoKHNsaWRlcikgPT5cbiAgICAgICAgc2xpZGVyXG4gICAgICAgICAgLnNldExpbWl0cygwLCAyMCwgMSlcbiAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MuZ2FwU2l6ZSlcbiAgICAgICAgICAuc2V0RHluYW1pY1Rvb2x0aXAoKVxuICAgICAgICAgIC5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLmdhcFNpemUgPSB2YWx1ZTtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgIH0pXG4gICAgICApO1xuXG4gICAgbmV3IFNldHRpbmcoY29udGFpbmVyRWwpXG4gICAgICAuc2V0TmFtZShcIlNuYXAgc2Vuc2l0aXZpdHlcIilcbiAgICAgIC5zZXREZXNjKFwiV2hlbiBkcmFnZ2luZyBhIGRpdmlkZXIgb3IgcmVzaXplIGhhbmRsZSwgc25hcCBpbnRvIHBsYWNlIHdoZW4gdGhlIGhlaWdodCBkaWZmZXJlbmNlIGJldHdlZW4gYWRqYWNlbnQgaW1hZ2VzIGZhbGxzIHdpdGhpbiB0aGlzIHBlcmNlbnRhZ2Ugb2YgdGhlaXIgZXF1aWxpYnJpdW0gKGVxdWFsKSBoZWlnaHQuIFNldCB0byAwIHRvIGRpc2FibGUgc25hcHBpbmcuXCIpXG4gICAgICAuYWRkU2xpZGVyKChzbGlkZXIpID0+XG4gICAgICAgIHNsaWRlclxuICAgICAgICAgIC5zZXRMaW1pdHMoMCwgMTAsIDEpXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLnNuYXBTZW5zaXRpdml0eSlcbiAgICAgICAgICAuc2V0RHluYW1pY1Rvb2x0aXAoKVxuICAgICAgICAgIC5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLnNuYXBTZW5zaXRpdml0eSA9IHZhbHVlO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgfSlcbiAgICAgICk7XG5cbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgIC5zZXROYW1lKFwiVG9wIGJhciBhY3RpdmF0aW9uIHpvbmVcIilcbiAgICAgIC5zZXREZXNjKFwiUGl4ZWwgZGlzdGFuY2UgZnJvbSB0aGUgdG9wIG9mIGEgZmxleCByb3cgd2l0aGluIHdoaWNoIHRoZSBnbG9iYWwtYmFsYW5jZSB0b3AgYmFyIGFwcGVhcnMgKDQtNDAgcHgpLlwiKVxuICAgICAgLmFkZFNsaWRlcigoc2xpZGVyKSA9PlxuICAgICAgICBzbGlkZXJcbiAgICAgICAgICAuc2V0TGltaXRzKDQsIDQwLCAyKVxuICAgICAgICAgIC5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy50b3BCYXJTZW5zaXRpdml0eSlcbiAgICAgICAgICAuc2V0RHluYW1pY1Rvb2x0aXAoKVxuICAgICAgICAgIC5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLnRvcEJhclNlbnNpdGl2aXR5ID0gdmFsdWU7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICB9KVxuICAgICAgKTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoXCJHaG9zdCBpbWFnZSB3aWR0aFwiKVxuICAgICAgLnNldERlc2MoXCJXaWR0aCAocHgpIG9mIHRoZSBkcmFnIGdob3N0IGltYWdlIHRoYXQgZm9sbG93cyB0aGUgY3Vyc29yICgxMDAtNTAwIHB4KS5cIilcbiAgICAgIC5hZGRTbGlkZXIoKHNsaWRlcikgPT5cbiAgICAgICAgc2xpZGVyXG4gICAgICAgICAgLnNldExpbWl0cygxMDAsIDUwMCwgMTApXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLmdob3N0SW1hZ2VXaWR0aClcbiAgICAgICAgICAuc2V0RHluYW1pY1Rvb2x0aXAoKVxuICAgICAgICAgIC5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLmdob3N0SW1hZ2VXaWR0aCA9IHZhbHVlO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgfSlcbiAgICAgICk7XG5cbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgIC5zZXROYW1lKFwiRHJhZyBnaG9zdCBvcGFjaXR5XCIpXG4gICAgICAuc2V0RGVzYyhcIlRyYW5zcGFyZW5jeSBvZiB0aGUgb3JpZ2luYWwgaW1hZ2UgZHVyaW5nIGRyYWcgKDEwJSA9IG5lYXJseSBvcGFxdWUsIDkwJSA9IHZlcnkgdHJhbnNwYXJlbnQpLlwiKVxuICAgICAgLmFkZFNsaWRlcigoc2xpZGVyKSA9PlxuICAgICAgICBzbGlkZXJcbiAgICAgICAgICAuc2V0TGltaXRzKDEwLCA5MCwgNSlcbiAgICAgICAgICAuc2V0VmFsdWUodGhpcy5wbHVnaW4uc2V0dGluZ3MuZHJhZ09wYWNpdHkpXG4gICAgICAgICAgLnNldER5bmFtaWNUb29sdGlwKClcbiAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5kcmFnT3BhY2l0eSA9IHZhbHVlO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgfSlcbiAgICAgICk7XG5cbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgIC5zZXROYW1lKFwiRW5hYmxlIGRyYWcgcmVvcmRlclwiKVxuICAgICAgLnNldERlc2MoXCJBbGxvdyBkcmFnZ2luZyBpbWFnZXMgd2l0aGluIGEgcm93IHRvIHJlb3JkZXIgdGhlbS5cIilcbiAgICAgIC5hZGRUb2dnbGUoKHRvZ2dsZSkgPT5cbiAgICAgICAgdG9nZ2xlXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLmVuYWJsZURyYWdSZW9yZGVyKVxuICAgICAgICAgIC5vbkNoYW5nZShhc3luYyAodmFsdWUpID0+IHtcbiAgICAgICAgICAgIHRoaXMucGx1Z2luLnNldHRpbmdzLmVuYWJsZURyYWdSZW9yZGVyID0gdmFsdWU7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICB9KVxuICAgICAgKTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoXCJFbmFibGUgcmVzaXplIGhhbmRsZXNcIilcbiAgICAgIC5zZXREZXNjKFwiU2hvdyBjb3JuZXIgcmVzaXplIGhhbmRsZXMgb24gaG92ZXIgdG8gYWRqdXN0IGluZGl2aWR1YWwgaW1hZ2Ugc2l6ZXMuXCIpXG4gICAgICAuYWRkVG9nZ2xlKCh0b2dnbGUpID0+XG4gICAgICAgIHRvZ2dsZVxuICAgICAgICAgIC5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5lbmFibGVSZXNpemUpXG4gICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3MuZW5hYmxlUmVzaXplID0gdmFsdWU7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcbiAgICAgICAgICB9KVxuICAgICAgKTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoXCJFbmFibGUgY29sdW1uIGRpdmlkZXJzXCIpXG4gICAgICAuc2V0RGVzYyhcIlNob3cgZHJhZ2dhYmxlIGRpdmlkZXJzIGJldHdlZW4gaW1hZ2VzIHRvIGFkanVzdCB3aWR0aCByYXRpb3MuXCIpXG4gICAgICAuYWRkVG9nZ2xlKCh0b2dnbGUpID0+XG4gICAgICAgIHRvZ2dsZVxuICAgICAgICAgIC5zZXRWYWx1ZSh0aGlzLnBsdWdpbi5zZXR0aW5ncy5lbmFibGVEaXZpZGVycylcbiAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5lbmFibGVEaXZpZGVycyA9IHZhbHVlO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgfSlcbiAgICAgICk7XG5cbiAgICBuZXcgU2V0dGluZyhjb250YWluZXJFbClcbiAgICAgIC5zZXROYW1lKFwiSW1hZ2UgZXh0ZW5zaW9uc1wiKVxuICAgICAgLnNldERlc2MoXCJDb21tYS1zZXBhcmF0ZWQgbGlzdCBvZiBpbWFnZSBmaWxlIGV4dGVuc2lvbnMgdG8gZGV0ZWN0IChlLmcuLCBwbmcsanBnLGdpZix3ZWJwKS5cIilcbiAgICAgIC5hZGRUZXh0KCh0ZXh0KSA9PlxuICAgICAgICB0ZXh0XG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLmltYWdlRXh0ZW5zaW9ucylcbiAgICAgICAgICAub25DaGFuZ2UoYXN5bmMgKHZhbHVlKSA9PiB7XG4gICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5pbWFnZUV4dGVuc2lvbnMgPSB2YWx1ZSB8fCBERUZBVUxUX1NFVFRJTkdTLmltYWdlRXh0ZW5zaW9ucztcbiAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgIH0pXG4gICAgICApO1xuICB9XG59XG4iLCAiZXhwb3J0IGNvbnN0IENTU19QUkVGSVggPSBcImRyYWctaW1nXCI7XG5cbmV4cG9ydCBjb25zdCBDTEFTU0VTID0ge1xuICByb3c6IGAke0NTU19QUkVGSVh9LXJvd2AsXG4gIGltYWdlSXRlbTogYCR7Q1NTX1BSRUZJWH0taXRlbWAsXG4gIGltYWdlSW5uZXI6IGAke0NTU19QUkVGSVh9LWltZ2AsXG4gIGRpdmlkZXI6IGAke0NTU19QUkVGSVh9LWRpdmlkZXJgLFxuICByZXNpemVIYW5kbGU6IGAke0NTU19QUkVGSVh9LXJlc2l6ZS1oYW5kbGVgLFxuICBkcm9wSW5kaWNhdG9yOiBgJHtDU1NfUFJFRklYfS1kcm9wLWluZGljYXRvcmAsXG4gIGRyYWdnaW5nOiBgJHtDU1NfUFJFRklYfS1kcmFnZ2luZ2AsXG4gIHBsYWNlaG9sZGVyOiBgJHtDU1NfUFJFRklYfS1wbGFjZWhvbGRlcmAsXG4gIGRpdmlkZXJBY3RpdmU6IGAke0NTU19QUkVGSVh9LWRpdmlkZXItYWN0aXZlYCxcbiAgZGl2aWRlclNuYXA6IGAke0NTU19QUkVGSVh9LWRpdmlkZXItc25hcGAsXG4gIGl0ZW1TbmFwOiBgJHtDU1NfUFJFRklYfS1zbmFwYCxcbiAgdG9wQmFyOiBgJHtDU1NfUFJFRklYfS10b3AtYmFyYCxcbiAgcmVzaXppbmc6IGAke0NTU19QUkVGSVh9LXJlc2l6aW5nYCxcbn0gYXMgY29uc3Q7XG5cbmV4cG9ydCBjb25zdCBERUZBVUxUX1NFVFRJTkdTID0ge1xuICBlbmFibGVkOiB0cnVlLFxuICBkZWZhdWx0Um93SGVpZ2h0OiAyMDAsXG4gIG1heEltYWdlc1BlclJvdzogMTAsXG4gIGdhcFNpemU6IDQsXG4gIHNuYXBTZW5zaXRpdml0eTogMyxcbiAgZW5hYmxlRHJhZ1Jlb3JkZXI6IHRydWUsXG4gIGVuYWJsZVJlc2l6ZTogdHJ1ZSxcbiAgZW5hYmxlRGl2aWRlcnM6IHRydWUsXG4gIGltYWdlRXh0ZW5zaW9uczogXCJwbmcsanBnLGpwZWcsZ2lmLHdlYnAsc3ZnLGJtcCxhdmlmXCIsXG4gIHRvcEJhclNlbnNpdGl2aXR5OiAxMixcbiAgZ2hvc3RJbWFnZVdpZHRoOiAxMjAsXG4gIGRyYWdPcGFjaXR5OiA2MCxcbn0gYXMgY29uc3Q7XG5cbmV4cG9ydCBjb25zdCBNSU5fSU1BR0VfV0lEVEggPSA1MDtcbmV4cG9ydCBjb25zdCBESVZJREVSX1dJRFRIID0gNDtcbmV4cG9ydCBjb25zdCBSRVNJWkVfSEFORExFX1NJWkUgPSAxMDtcbmV4cG9ydCBjb25zdCBSRVNJWkVfREVCT1VOQ0VfTVMgPSAxMDA7XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZEltYWdlTGluZVJlKGV4dGVuc2lvbnM6IHN0cmluZyk6IFJlZ0V4cCB7XG4gIGNvbnN0IGV4dExpc3QgPSBleHRlbnNpb25zLnNwbGl0KFwiLFwiKS5tYXAocyA9PiBzLnRyaW0oKSkuZmlsdGVyKEJvb2xlYW4pLmpvaW4oXCJ8XCIpO1xuICAvLyBGb3JtYXQ6ICFbW2ZpbGVuYW1lfHdpZHRoXV0gb3IgIVtbZmlsZW5hbWV8V3hIXV0gb3IgIVtbZmlsZW5hbWV8d2lkdGh8V3hIXV1cbiAgLy8gTWF0Y2ggYW55dGhpbmcgYmV0d2VlbiB8IGFuZCBdXSAoT2JzaWRpYW4gZGltZW5zaW9ucywgcGx1Z2luIHdpZHRoLCBvciBib3RoKVxuICByZXR1cm4gbmV3IFJlZ0V4cChcbiAgICBgXlxcXFxzKiFcXFxcW1xcXFxbKFteXFxcXF1dK1xcXFwuKD86JHtleHRMaXN0fSkpKD86XFxcXHwoW15cXFxcXV0qKSk/XFxcXF1cXFxcXVxcXFxzKiRgLFxuICAgIFwiaVwiXG4gICk7XG59XG4iLCAiaW1wb3J0IHsgQXBwLCBURmlsZSwgTWFya2Rvd25Qb3N0UHJvY2Vzc29yQ29udGV4dCB9IGZyb20gXCJvYnNpZGlhblwiO1xuaW1wb3J0IHsgQ0xBU1NFUyB9IGZyb20gXCIuL2NvbnN0YW50c1wiO1xuaW1wb3J0IHsgSW1hZ2VSb3dPcHRpb25zIH0gZnJvbSBcIi4vaW1hZ2VSb3dXaWRnZXRcIjtcbmltcG9ydCB7IGxvZ2dlciB9IGZyb20gXCIuL2xvZ2dlclwiO1xuXG4vKipcbiAqIENyZWF0ZSBhIE1hcmtkb3duUG9zdFByb2Nlc3NvciB0aGF0OlxuICogMS4gQXV0by1kZXRlY3RzIGNvbnNlY3V0aXZlIGltYWdlIGVtYmVkcyBhbmQgcmVuZGVycyB0aGVtIGFzIGEgZmxleCByb3cuXG4gKiAyLiBNYWtlcyBzdGFuZGFsb25lIGltYWdlcyBkcmFnZ2FibGUgXHUyMDE0IGRyb3AgbmVhciBhbm90aGVyIGltYWdlIHRvIG1lcmdlLlxuICogMy4gV2l0aGluIGEgZmxleCByb3csIGltYWdlcyBhcmUgZHJhZ2dhYmxlIGZvciByZW9yZGVyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlUmVhZGluZ01vZGVQcm9jZXNzb3IoXG4gIGFwcDogQXBwLFxuICBnZXRPcHRpb25zOiAoKSA9PiBJbWFnZVJvd09wdGlvbnMsXG4gIGVuYWJsZWQ6ICgpID0+IGJvb2xlYW5cbikge1xuICByZXR1cm4gKGVsOiBIVE1MRWxlbWVudCwgY3R4OiBNYXJrZG93blBvc3RQcm9jZXNzb3JDb250ZXh0KSA9PiB7XG4gICAgLy8gQWx3YXlzIGxvZyBlbnRyeSBzbyB3ZSBjYW4gdGVsbCBpZiB0aGUgcHJvY2Vzc29yIGlzIGludm9rZWQgYXQgYWxsXG4gICAgY29uc3QgYWxsRW1iZWRzID0gZWwucXVlcnlTZWxlY3RvckFsbChcIi5pbnRlcm5hbC1lbWJlZC5pbWFnZS1lbWJlZFwiKTtcbiAgICBsb2dnZXIuZGVidWcoXCJSZWFkaW5nTW9kZSBwcm9jZXNzb3IgaW52b2tlZFwiLCB7XG4gICAgICBzb3VyY2VQYXRoOiBjdHguc291cmNlUGF0aCxcbiAgICAgIGVtYmVkQ291bnQ6IGFsbEVtYmVkcy5sZW5ndGgsXG4gICAgICBlbmFibGVkOiBlbmFibGVkKCksXG4gICAgfSk7XG5cbiAgICBpZiAoIWVuYWJsZWQoKSkgcmV0dXJuO1xuXG4gICAgY29uc3QgZW1iZWRzID0gQXJyYXkuZnJvbShhbGxFbWJlZHMpIGFzIEhUTUxFbGVtZW50W107XG4gICAgaWYgKGVtYmVkcy5sZW5ndGggPT09IDApIHJldHVybjtcblxuICAgIC8vIC0tLSBTdGVwIDE6IEdyb3VwIGNvbnNlY3V0aXZlIGVtYmVkcyAtLS1cbiAgICBjb25zdCBncm91cHMgPSBidWlsZEVtYmVkR3JvdXBzKGVtYmVkcyk7XG4gICAgY29uc3Qgb3B0aW9ucyA9IGdldE9wdGlvbnMoKTtcblxuICAgIGxvZ2dlci5kZWJ1ZyhcIlJlYWRpbmdNb2RlIHByb2Nlc3NvclwiLCB7XG4gICAgICBlbWJlZENvdW50OiBlbWJlZHMubGVuZ3RoLFxuICAgICAgZ3JvdXBDb3VudDogZ3JvdXBzLmxlbmd0aCxcbiAgICAgIHNvdXJjZVBhdGg6IGN0eC5zb3VyY2VQYXRoLFxuICAgICAgZ3JvdXBzOiBncm91cHMubWFwKChnKSA9PiBnLmxlbmd0aCksXG4gICAgfSk7XG5cbiAgICAvLyAtLS0gU3RlcCAyOiBXcmFwIGdyb3VwcyBpbiBmbGV4IHJvd3MsIG1ha2UgaXRlbXMgZHJhZ2dhYmxlIC0tLVxuICAgIGZvciAoY29uc3QgZ3JvdXAgb2YgZ3JvdXBzKSB7XG4gICAgICBpZiAoZ3JvdXAubGVuZ3RoID49IDIpIHtcbiAgICAgICAgd3JhcEFzRmxleFJvdyhncm91cCwgb3B0aW9ucyk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gLS0tIFN0ZXAgMzogTWFrZSBBTEwgaW1hZ2UgaXRlbXMgZHJhZ2dhYmxlIGZvciBtZXJnZS9yZW9yZGVyIC0tLVxuICAgIG1ha2VJbWFnZXNEcmFnZ2FibGUoYXBwLCBjdHguc291cmNlUGF0aCwgZW1iZWRzKTtcbiAgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwIEdyb3VwIGRldGVjdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuaW50ZXJmYWNlIEVtYmVkSW5mbyB7XG4gIGVsOiBIVE1MRWxlbWVudDtcbiAgYmxvY2s6IEhUTUxFbGVtZW50IHwgbnVsbDsgLy8gbmVhcmVzdCBibG9jay1sZXZlbCBwYXJlbnRcbn1cblxuZnVuY3Rpb24gYnVpbGRFbWJlZEdyb3VwcyhlbWJlZHM6IEhUTUxFbGVtZW50W10pOiBIVE1MRWxlbWVudFtdW10ge1xuICBjb25zdCBncm91cHM6IEhUTUxFbGVtZW50W11bXSA9IFtdO1xuICBsZXQgY3VycmVudDogSFRNTEVsZW1lbnRbXSA9IFtdO1xuXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgZW1iZWRzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgZW1iZWQgPSBlbWJlZHNbaV07XG4gICAgY29uc3QgYmxvY2sgPSBmaW5kQmxvY2tQYXJlbnQoZW1iZWQpO1xuXG4gICAgaWYgKGN1cnJlbnQubGVuZ3RoID09PSAwKSB7XG4gICAgICBjdXJyZW50LnB1c2goZW1iZWQpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgY29uc3QgcHJldiA9IGN1cnJlbnRbY3VycmVudC5sZW5ndGggLSAxXTtcbiAgICBjb25zdCBwcmV2QmxvY2sgPSBmaW5kQmxvY2tQYXJlbnQocHJldik7XG5cbiAgICBpZiAoaXNJbWFnZU9ubHlCbG9jayhwcmV2QmxvY2spICYmIGJsb2NrICYmIGFyZUFkamFjZW50U2libGluZ3MocHJldkJsb2NrLCBibG9jaykpIHtcbiAgICAgIGN1cnJlbnQucHVzaChlbWJlZCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGlmIChjdXJyZW50Lmxlbmd0aCA+PSAyKSBncm91cHMucHVzaChbLi4uY3VycmVudF0pO1xuICAgICAgY3VycmVudCA9IFtlbWJlZF07XG4gICAgfVxuICB9XG4gIGlmIChjdXJyZW50Lmxlbmd0aCA+PSAyKSBncm91cHMucHVzaChbLi4uY3VycmVudF0pO1xuXG4gIHJldHVybiBncm91cHM7XG59XG5cbmZ1bmN0aW9uIGZpbmRCbG9ja1BhcmVudChlbDogSFRNTEVsZW1lbnQpOiBIVE1MRWxlbWVudCB8IG51bGwge1xuICBsZXQgY3VyOiBIVE1MRWxlbWVudCB8IG51bGwgPSBlbC5wYXJlbnRFbGVtZW50O1xuICB3aGlsZSAoY3VyKSB7XG4gICAgY29uc3QgZCA9IHdpbmRvdy5nZXRDb21wdXRlZFN0eWxlKGN1cikuZGlzcGxheTtcbiAgICBpZiAoZCA9PT0gXCJibG9ja1wiIHx8IGQgPT09IFwiZmxleFwiIHx8IGQgPT09IFwibGlzdC1pdGVtXCIpIHJldHVybiBjdXI7XG4gICAgY3VyID0gY3VyLnBhcmVudEVsZW1lbnQ7XG4gIH1cbiAgcmV0dXJuIGVsLnBhcmVudEVsZW1lbnQ7XG59XG5cbmZ1bmN0aW9uIGlzSW1hZ2VPbmx5QmxvY2soYmxvY2s6IEhUTUxFbGVtZW50IHwgbnVsbCk6IGJvb2xlYW4ge1xuICBpZiAoIWJsb2NrKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGhhc0ltZyA9IGJsb2NrLnF1ZXJ5U2VsZWN0b3IoXCIuaW50ZXJuYWwtZW1iZWQuaW1hZ2UtZW1iZWRcIikgIT09IG51bGw7XG4gIGlmICghaGFzSW1nKSByZXR1cm4gZmFsc2U7XG4gIGZvciAoY29uc3QgY2hpbGQgb2YgQXJyYXkuZnJvbShibG9jay5jaGlsZHJlbikpIHtcbiAgICBpZiAoIWNoaWxkLmNsYXNzTGlzdC5jb250YWlucyhcImludGVybmFsLWVtYmVkXCIpIHx8ICFjaGlsZC5jbGFzc0xpc3QuY29udGFpbnMoXCJpbWFnZS1lbWJlZFwiKSkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn1cblxuZnVuY3Rpb24gYXJlQWRqYWNlbnRTaWJsaW5ncyhhOiBIVE1MRWxlbWVudCB8IG51bGwsIGI6IEhUTUxFbGVtZW50IHwgbnVsbCk6IGJvb2xlYW4ge1xuICBpZiAoIWEgfHwgIWIgfHwgYS5wYXJlbnRFbGVtZW50ICE9PSBiLnBhcmVudEVsZW1lbnQpIHJldHVybiBmYWxzZTtcbiAgY29uc3Qgc2licyA9IEFycmF5LmZyb20oYS5wYXJlbnRFbGVtZW50IS5jaGlsZHJlbik7XG4gIHJldHVybiBNYXRoLmFicyhzaWJzLmluZGV4T2YoYSkgLSBzaWJzLmluZGV4T2YoYikpID09PSAxO1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgRmxleCByb3cgd3JhcHBpbmcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIHdyYXBBc0ZsZXhSb3coZW1iZWRzOiBIVE1MRWxlbWVudFtdLCBvcHRpb25zOiBJbWFnZVJvd09wdGlvbnMpOiB2b2lkIHtcbiAgY29uc3QgZmlyc3RCbG9jayA9IGZpbmRCbG9ja1BhcmVudChlbWJlZHNbMF0pO1xuICBpZiAoIWZpcnN0QmxvY2spIHJldHVybjtcblxuICBjb25zdCBibG9ja3MgPSBuZXcgU2V0PEhUTUxFbGVtZW50PigpO1xuICBmb3IgKGNvbnN0IGUgb2YgZW1iZWRzKSB7XG4gICAgY29uc3QgYiA9IGZpbmRCbG9ja1BhcmVudChlKTtcbiAgICBpZiAoYikgYmxvY2tzLmFkZChiKTtcbiAgfVxuICBjb25zdCBibG9ja0xpc3QgPSBbLi4uYmxvY2tzXTtcblxuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gQ0xBU1NFUy5yb3c7XG4gIHJvdy5zZXRBdHRyaWJ1dGUoXCJkYXRhLWRpYWEtZ3JvdXBcIiwgXCJ0cnVlXCIpO1xuICByb3cuc3R5bGUuY3NzVGV4dCA9IGBkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6ZmxleC1zdGFydDtnYXA6JHtvcHRpb25zLmdhcH1weDt3aWR0aDoxMDAlO292ZXJmbG93OmhpZGRlbjtgO1xuXG4gIGxldCByb3dIID0gb3B0aW9ucy5kZWZhdWx0Um93SGVpZ2h0O1xuICBjb25zdCBmaXJzdEltZyA9IGVtYmVkc1swXS5xdWVyeVNlbGVjdG9yKFwiaW1nXCIpO1xuICBpZiAoZmlyc3RJbWc/Lm5hdHVyYWxXaWR0aCkge1xuICAgIHJvd0ggPSBNYXRoLm1pbihvcHRpb25zLmRlZmF1bHRSb3dIZWlnaHQgKiAzLCBNYXRoLm1heCg1MCwgcm93SCkpO1xuICB9XG4gIHJvdy5zdHlsZS5oZWlnaHQgPSBgJHtyb3dIfXB4YDtcblxuICBmb3IgKGNvbnN0IGIgb2YgYmxvY2tMaXN0KSB7XG4gICAgYi5zdHlsZS5jc3NUZXh0ID0gYGZsZXg6MSAxIDA7b3ZlcmZsb3c6aGlkZGVuO21pbi13aWR0aDo1MHB4O3Bvc2l0aW9uOnJlbGF0aXZlO21hcmdpbjowO3BhZGRpbmc6MDtgO1xuICAgIGNvbnN0IGltZ3MgPSBBcnJheS5mcm9tKGIucXVlcnlTZWxlY3RvckFsbDxIVE1MSW1hZ2VFbGVtZW50PihcImltZ1wiKSk7XG4gICAgZm9yIChjb25zdCBpbWcgb2YgaW1ncykge1xuICAgICAgaW1nLnN0eWxlLmNzc1RleHQgPSBcIndpZHRoOjEwMCU7aGVpZ2h0OjEwMCU7b2JqZWN0LWZpdDpjb250YWluO2Rpc3BsYXk6YmxvY2s7XCI7XG4gICAgfVxuICAgIHJvdy5hcHBlbmRDaGlsZChiKTtcbiAgfVxuXG4gIGZpcnN0QmxvY2sucmVwbGFjZVdpdGgocm93KTtcbiAgaWYgKGJsb2NrTGlzdFswXSAhPT0gcm93LmZpcnN0Q2hpbGQpIHtcbiAgICByb3cuaW5zZXJ0QmVmb3JlKGJsb2NrTGlzdFswXSwgcm93LmZpcnN0Q2hpbGQpO1xuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBEcmFnLXRvLW1lcmdlIC8gcmVvcmRlciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxubGV0IGRyYWdTcmNFbDogSFRNTEVsZW1lbnQgfCBudWxsID0gbnVsbDtcbmxldCBkcmFnUGxhY2Vob2xkZXJzOiBIVE1MRWxlbWVudFtdID0gW107XG5cbmZ1bmN0aW9uIG1ha2VJbWFnZXNEcmFnZ2FibGUoYXBwOiBBcHAsIHNvdXJjZVBhdGg6IHN0cmluZywgZW1iZWRzOiBIVE1MRWxlbWVudFtdKTogdm9pZCB7XG4gIGxldCBkcmFnZ2FibGVDb3VudCA9IDA7XG4gIGZvciAoY29uc3QgZW1iZWQgb2YgZW1iZWRzKSB7XG4gICAgY29uc3QgYmxvY2sgPSBmaW5kQmxvY2tQYXJlbnQoZW1iZWQpO1xuICAgIGlmICghYmxvY2spIHtcbiAgICAgIGxvZ2dlci5kZWJ1ZyhcIlJlYWRpbmdNb2RlIG1ha2VEcmFnZ2FibGUgc2tpcDogbm8gYmxvY2sgcGFyZW50XCIsIHtcbiAgICAgICAgZW1iZWRUYWc6IGVtYmVkLnRhZ05hbWUsXG4gICAgICB9KTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGJsb2NrLnNldEF0dHJpYnV0ZShcImRyYWdnYWJsZVwiLCBcInRydWVcIik7XG4gICAgYmxvY2suY2xhc3NMaXN0LmFkZChcImRpYWEtZHJhZ2dhYmxlXCIpO1xuICAgIC8vIFByZXZlbnQgbmF0aXZlIGltYWdlIGRyYWcgZnJvbSBvdmVycmlkaW5nIG91ciBibG9jay1sZXZlbCBkcmFnXG4gICAgZm9yIChjb25zdCBpbWcgb2YgQXJyYXkuZnJvbShibG9jay5xdWVyeVNlbGVjdG9yQWxsKFwiaW1nXCIpKSkge1xuICAgICAgaW1nLnNldEF0dHJpYnV0ZShcImRyYWdnYWJsZVwiLCBcImZhbHNlXCIpO1xuICAgIH1cbiAgICBkcmFnZ2FibGVDb3VudCsrO1xuXG4gICAgYmxvY2suYWRkRXZlbnRMaXN0ZW5lcihcImRyYWdzdGFydFwiLCAoZSkgPT4ge1xuICAgICAgbG9nZ2VyLmRlYnVnKFwiUmVhZGluZ01vZGUgZHJhZ3N0YXJ0XCIsIHsgc291cmNlUGF0aCB9KTtcbiAgICAgIGRyYWdTcmNFbCA9IGJsb2NrO1xuICAgICAgYmxvY2suY2xhc3NMaXN0LmFkZChDTEFTU0VTLmRyYWdnaW5nKTtcbiAgICAgIGUuZGF0YVRyYW5zZmVyIS5lZmZlY3RBbGxvd2VkID0gXCJtb3ZlXCI7XG4gICAgICBlLmRhdGFUcmFuc2ZlciEuc2V0RGF0YShcInRleHQvcGxhaW5cIiwgXCJcIik7XG4gICAgfSk7XG5cbiAgICBibG9jay5hZGRFdmVudExpc3RlbmVyKFwiZHJhZ2VuZFwiLCAoKSA9PiB7XG4gICAgICBibG9jay5jbGFzc0xpc3QucmVtb3ZlKENMQVNTRVMuZHJhZ2dpbmcpO1xuICAgICAgZHJhZ1NyY0VsID0gbnVsbDtcbiAgICAgIHJlbW92ZUFsbERyb3BJbmRpY2F0b3JzKCk7XG4gICAgfSk7XG5cbiAgICBibG9jay5hZGRFdmVudExpc3RlbmVyKFwiZHJhZ292ZXJcIiwgKGUpID0+IHtcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgIGUuZGF0YVRyYW5zZmVyIS5kcm9wRWZmZWN0ID0gXCJtb3ZlXCI7XG4gICAgICBpZiAoIWRyYWdTcmNFbCB8fCBkcmFnU3JjRWwgPT09IGJsb2NrKSByZXR1cm47XG5cbiAgICAgIHJlbW92ZUFsbERyb3BJbmRpY2F0b3JzKCk7XG4gICAgICBjb25zdCByZWN0ID0gYmxvY2suZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgICBjb25zdCBtaWRYID0gcmVjdC5sZWZ0ICsgcmVjdC53aWR0aCAvIDI7XG5cbiAgICAgIGNvbnN0IGluZGljYXRvciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBpbmRpY2F0b3IuY2xhc3NOYW1lID0gXCJkaWFhLWRyb3AtaW5kaWNhdG9yXCI7XG4gICAgICBpbmRpY2F0b3Iuc3R5bGUuY3NzVGV4dCA9XG4gICAgICAgIFwicG9zaXRpb246YWJzb2x1dGU7dG9wOjA7Ym90dG9tOjA7d2lkdGg6M3B4O2JhY2tncm91bmQ6IzRhOWVmZjt6LWluZGV4OjEwO3BvaW50ZXItZXZlbnRzOm5vbmU7XCI7XG4gICAgICBpZiAoZS5jbGllbnRYIDwgbWlkWCkge1xuICAgICAgICBpbmRpY2F0b3Iuc3R5bGUubGVmdCA9IFwiMFwiO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgaW5kaWNhdG9yLnN0eWxlLnJpZ2h0ID0gXCIwXCI7XG4gICAgICB9XG4gICAgICBibG9jay5zdHlsZS5wb3NpdGlvbiA9IGJsb2NrLnN0eWxlLnBvc2l0aW9uIHx8IFwicmVsYXRpdmVcIjtcbiAgICAgIGJsb2NrLmFwcGVuZENoaWxkKGluZGljYXRvcik7XG4gICAgICBkcmFnUGxhY2Vob2xkZXJzLnB1c2goaW5kaWNhdG9yKTtcbiAgICB9KTtcblxuICAgIGJsb2NrLmFkZEV2ZW50TGlzdGVuZXIoXCJkcmFnbGVhdmVcIiwgKCkgPT4ge1xuICAgICAgcmVtb3ZlQWxsRHJvcEluZGljYXRvcnMoKTtcbiAgICB9KTtcblxuICAgIGJsb2NrLmFkZEV2ZW50TGlzdGVuZXIoXCJkcm9wXCIsIChlKSA9PiB7XG4gICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICByZW1vdmVBbGxEcm9wSW5kaWNhdG9ycygpO1xuICAgICAgaWYgKCFkcmFnU3JjRWwgfHwgZHJhZ1NyY0VsID09PSBibG9jaykgcmV0dXJuO1xuXG4gICAgICBoYW5kbGVJbWFnZURyb3AoXG4gICAgICAgIGFwcCxcbiAgICAgICAgc291cmNlUGF0aCxcbiAgICAgICAgZHJhZ1NyY0VsLFxuICAgICAgICBibG9jayxcbiAgICAgICAgZS5jbGllbnRYIDwgYmxvY2suZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCkubGVmdCArIGJsb2NrLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpLndpZHRoIC8gMlxuICAgICAgKTtcbiAgICB9KTtcbiAgfVxuICBsb2dnZXIuZGVidWcoXCJSZWFkaW5nTW9kZSBtYWtlRHJhZ2dhYmxlIGRvbmVcIiwge1xuICAgIGRyYWdnYWJsZUNvdW50LFxuICAgIHRvdGFsRW1iZWRzOiBlbWJlZHMubGVuZ3RoLFxuICB9KTtcbn1cblxuZnVuY3Rpb24gcmVtb3ZlQWxsRHJvcEluZGljYXRvcnMoKTogdm9pZCB7XG4gIGZvciAoY29uc3QgcCBvZiBkcmFnUGxhY2Vob2xkZXJzKSBwLnJlbW92ZSgpO1xuICBkcmFnUGxhY2Vob2xkZXJzID0gW107XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZUltYWdlRHJvcChcbiAgYXBwOiBBcHAsXG4gIHNvdXJjZVBhdGg6IHN0cmluZyxcbiAgc3JjQmxvY2s6IEhUTUxFbGVtZW50LFxuICBkc3RCbG9jazogSFRNTEVsZW1lbnQsXG4gIGluc2VydEJlZm9yZTogYm9vbGVhblxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHNyY0VtYmVkID0gc3JjQmxvY2sucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCIuaW50ZXJuYWwtZW1iZWQuaW1hZ2UtZW1iZWRcIik7XG4gIGNvbnN0IGRzdEVtYmVkID0gZHN0QmxvY2sucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCIuaW50ZXJuYWwtZW1iZWQuaW1hZ2UtZW1iZWRcIik7XG4gIGlmICghc3JjRW1iZWQgfHwgIWRzdEVtYmVkKSByZXR1cm47XG5cbiAgLy8gVXNlIERPTSBvcmRlciB0byBtYXAgdG8gc291cmNlIGxpbmUgb3JkZXIuXG4gIC8vIEluIFJlYWRpbmcgTW9kZSwgRE9NIG9yZGVyIGFsd2F5cyBtYXRjaGVzIG1hcmtkb3duIHNvdXJjZSBvcmRlci5cbiAgY29uc3QgYWxsRW1iZWRzID0gQXJyYXkuZnJvbShcbiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKFwiLmludGVybmFsLWVtYmVkLmltYWdlLWVtYmVkXCIpXG4gICk7XG4gIGNvbnN0IHNyY0RvbUlkeCA9IGFsbEVtYmVkcy5pbmRleE9mKHNyY0VtYmVkKTtcbiAgY29uc3QgZHN0RG9tSWR4ID0gYWxsRW1iZWRzLmluZGV4T2YoZHN0RW1iZWQpO1xuICBpZiAoc3JjRG9tSWR4IDwgMCB8fCBkc3REb21JZHggPCAwKSByZXR1cm47XG5cbiAgY29uc3QgZmlsZSA9IGFwcC52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgoc291cmNlUGF0aCk7XG4gIGlmICghKGZpbGUgaW5zdGFuY2VvZiBURmlsZSkpIHJldHVybjtcblxuICBhd2FpdCBhcHAudmF1bHQucHJvY2VzcyhmaWxlLCAoY29udGVudDogc3RyaW5nKSA9PiB7XG4gICAgY29uc3QgbGluZXMgPSBjb250ZW50LnNwbGl0KFwiXFxuXCIpO1xuXG4gICAgLy8gRmluZCBhbGwgaW1hZ2UgZW1iZWQgbGluZSBudW1iZXJzIGluIHNvdXJjZSBvcmRlclxuICAgIGNvbnN0IGltYWdlTGluZU51bWJlcnM6IG51bWJlcltdID0gW107XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBsaW5lcy5sZW5ndGg7IGkrKykge1xuICAgICAgaWYgKGlzSW1hZ2VFbWJlZExpbmUobGluZXNbaV0pKSB7XG4gICAgICAgIGltYWdlTGluZU51bWJlcnMucHVzaChpKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoc3JjRG9tSWR4ID49IGltYWdlTGluZU51bWJlcnMubGVuZ3RoIHx8IGRzdERvbUlkeCA+PSBpbWFnZUxpbmVOdW1iZXJzLmxlbmd0aCkge1xuICAgICAgcmV0dXJuIGNvbnRlbnQ7XG4gICAgfVxuXG4gICAgY29uc3Qgc3JjTGluZSA9IGltYWdlTGluZU51bWJlcnNbc3JjRG9tSWR4XTtcbiAgICBjb25zdCBkc3RMaW5lID0gaW1hZ2VMaW5lTnVtYmVyc1tkc3REb21JZHhdO1xuXG4gICAgaWYgKHNyY0xpbmUgPT09IGRzdExpbmUpIHJldHVybiBjb250ZW50O1xuXG4gICAgbG9nZ2VyLmluZm8oXCJSZWFkaW5nTW9kZSBkcmFnLWRyb3AgcmVvcmRlclwiLCB7XG4gICAgICBzcmNEb21JZHgsXG4gICAgICBkc3REb21JZHgsXG4gICAgICBzcmNMaW5lLFxuICAgICAgZHN0TGluZSxcbiAgICAgIGluc2VydEJlZm9yZSxcbiAgICAgIHRvdGFsSW1hZ2VzOiBpbWFnZUxpbmVOdW1iZXJzLmxlbmd0aCxcbiAgICB9KTtcblxuICAgIC8vIE1vdmUgc3JjIGxpbmUgdG8gYmUgYmVmb3JlL2FmdGVyIGRzdCBsaW5lXG4gICAgY29uc3QgW3JlbW92ZWRdID0gbGluZXMuc3BsaWNlKHNyY0xpbmUsIDEpO1xuICAgIGNvbnN0IGFkanVzdGVkRHN0ID0gc3JjTGluZSA8IGRzdExpbmUgPyBkc3RMaW5lIC0gMSA6IGRzdExpbmU7XG4gICAgY29uc3QgaW5zZXJ0QXQgPSBpbnNlcnRCZWZvcmUgPyBhZGp1c3RlZERzdCA6IGFkanVzdGVkRHN0ICsgMTtcbiAgICBsaW5lcy5zcGxpY2UoaW5zZXJ0QXQsIDAsIHJlbW92ZWQpO1xuXG4gICAgcmV0dXJuIGxpbmVzLmpvaW4oXCJcXG5cIik7XG4gIH0pO1xufVxuXG4vKipcbiAqIENoZWNrIGlmIGEgbGluZSBpcyBhIHZhbGlkIHNpbmdsZS1pbWFnZSBlbWJlZCBsaW5lLlxuICogVXNlcyB0aGUgc2FtZSBsb2dpYyBhcyBpbWFnZURldGVjdG9yIGZvciBjb25zaXN0ZW5jeS5cbiAqL1xuZnVuY3Rpb24gaXNJbWFnZUVtYmVkTGluZShsaW5lOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgLy8gV2lkdGggc3BlY2lmaWVyIGlzIElOU0lERSBbWy4uLl1dLCBub3QgYWZ0ZXIgXV1cbiAgY29uc3QgcmUgPSAvXlxccyohXFxbXFxbKFteXFxdXStcXC4oPzpwbmd8anBnfGpwZWd8Z2lmfHdlYnB8c3ZnfGJtcHxhdmlmKSkoPzpcXHxcXGQrKT9cXF1cXF1cXHMqJC9pO1xuICByZXR1cm4gcmUudGVzdChsaW5lKTtcbn1cbiIsICJpbXBvcnQgeyBEYXRhQWRhcHRlciB9IGZyb20gXCJvYnNpZGlhblwiO1xuXG50eXBlIExvZ0xldmVsID0gXCJJTkZPXCIgfCBcIldBUk5cIiB8IFwiRVJST1JcIiB8IFwiREVCVUdcIjtcblxuaW50ZXJmYWNlIExvZ0VudHJ5IHtcbiAgdGltZXN0YW1wOiBzdHJpbmc7XG4gIGxldmVsOiBMb2dMZXZlbDtcbiAgbWVzc2FnZTogc3RyaW5nO1xuICBkYXRhPzogdW5rbm93bjtcbn1cblxuY2xhc3MgTG9nZ2VyIHtcbiAgcHJpdmF0ZSBidWZmZXI6IExvZ0VudHJ5W10gPSBbXTtcbiAgcHJpdmF0ZSBhZGFwdGVyOiBEYXRhQWRhcHRlciB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGxvZ1BhdGggPSBcIlwiO1xuICBwcml2YXRlIGZsdXNoVGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldEludGVydmFsPiB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGZsdXNoaW5nID0gZmFsc2U7XG5cbiAgLyoqIENhbGwgb25jZSBkdXJpbmcgcGx1Z2luIGxvYWQgdG8gZW5hYmxlIGZpbGUgbG9nZ2luZy4gQ2xlYXJzIHByZXZpb3VzIGxvZy4gKi9cbiAgaW5pdChhZGFwdGVyOiBEYXRhQWRhcHRlciwgbG9nUGF0aDogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy5hZGFwdGVyID0gYWRhcHRlcjtcbiAgICB0aGlzLmxvZ1BhdGggPSBsb2dQYXRoO1xuICAgIC8vIENsZWFyIHByZXZpb3VzIHNlc3Npb24ncyBsb2dcbiAgICBhZGFwdGVyLndyaXRlKGxvZ1BhdGgsIFwiXCIpLmNhdGNoKCgpID0+IHt9KTtcbiAgICBjb25zb2xlLmxvZyhgW0RyYWdJbWddIExvZ2dlciBpbml0aWFsaXplZCwgbG9nUGF0aD0ke2xvZ1BhdGh9YCk7XG4gICAgdGhpcy5mbHVzaFRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4gdGhpcy5mbHVzaCgpLCA1MDAwKTtcbiAgfVxuXG4gIC8qKiBDYWxsIG9uIHBsdWdpbiB1bmxvYWQgdG8gZmx1c2ggcmVtYWluaW5nIGVudHJpZXMsIHRoZW4gY2xlYXIgbG9nLiAqL1xuICBhc3luYyBkaXNwb3NlKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICh0aGlzLmZsdXNoVGltZXIpIGNsZWFySW50ZXJ2YWwodGhpcy5mbHVzaFRpbWVyKTtcbiAgICBhd2FpdCB0aGlzLmZsdXNoKCk7XG4gICAgLy8gQ2xlYXIgbG9nIG9uIGV4aXRcbiAgICBpZiAodGhpcy5hZGFwdGVyKSB7XG4gICAgICB0cnkgeyBhd2FpdCB0aGlzLmFkYXB0ZXIud3JpdGUodGhpcy5sb2dQYXRoLCBcIlwiKTsgfSBjYXRjaCB7IC8qIGlnbm9yZSAqLyB9XG4gICAgfVxuICAgIHRoaXMuYWRhcHRlciA9IG51bGw7XG4gIH1cblxuICBpbmZvKG1lc3NhZ2U6IHN0cmluZywgZGF0YT86IHVua25vd24pOiB2b2lkIHtcbiAgICB0aGlzLndyaXRlKFwiSU5GT1wiLCBtZXNzYWdlLCBkYXRhKTtcbiAgfVxuICB3YXJuKG1lc3NhZ2U6IHN0cmluZywgZGF0YT86IHVua25vd24pOiB2b2lkIHtcbiAgICB0aGlzLndyaXRlKFwiV0FSTlwiLCBtZXNzYWdlLCBkYXRhKTtcbiAgfVxuICBlcnJvcihtZXNzYWdlOiBzdHJpbmcsIGRhdGE/OiB1bmtub3duKTogdm9pZCB7XG4gICAgdGhpcy53cml0ZShcIkVSUk9SXCIsIG1lc3NhZ2UsIGRhdGEpO1xuICB9XG4gIGRlYnVnKG1lc3NhZ2U6IHN0cmluZywgZGF0YT86IHVua25vd24pOiB2b2lkIHtcbiAgICB0aGlzLndyaXRlKFwiREVCVUdcIiwgbWVzc2FnZSwgZGF0YSk7XG4gIH1cblxuICBwcml2YXRlIHdyaXRlKGxldmVsOiBMb2dMZXZlbCwgbWVzc2FnZTogc3RyaW5nLCBkYXRhPzogdW5rbm93bik6IHZvaWQge1xuICAgIGNvbnN0IGVudHJ5OiBMb2dFbnRyeSA9IHtcbiAgICAgIHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgbGV2ZWwsXG4gICAgICBtZXNzYWdlLFxuICAgICAgZGF0YSxcbiAgICB9O1xuICAgIHRoaXMuYnVmZmVyLnB1c2goZW50cnkpO1xuICAgIGNvbnN0IGRhdGFTdHIgPSBkYXRhICE9PSB1bmRlZmluZWQgPyBgICR7SlNPTi5zdHJpbmdpZnkoZGF0YSl9YCA6IFwiXCI7XG4gICAgY29uc29sZS5sb2coYFtEcmFnSW1nXSBbJHtsZXZlbH1dICR7bWVzc2FnZX0ke2RhdGFTdHJ9YCk7XG4gIH1cblxuICBhc3luYyBmbHVzaCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoIXRoaXMuYWRhcHRlciB8fCB0aGlzLmJ1ZmZlci5sZW5ndGggPT09IDAgfHwgdGhpcy5mbHVzaGluZykgcmV0dXJuO1xuICAgIHRoaXMuZmx1c2hpbmcgPSB0cnVlO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBsaW5lcyA9IHRoaXMuYnVmZmVyLm1hcChcbiAgICAgICAgKGUpID0+IGBbJHtlLnRpbWVzdGFtcH1dIFske2UubGV2ZWx9XSAke2UubWVzc2FnZX1gICtcbiAgICAgICAgICAoZS5kYXRhICE9PSB1bmRlZmluZWQgPyBgICR7SlNPTi5zdHJpbmdpZnkoZS5kYXRhKX1gIDogXCJcIilcbiAgICAgICk7XG4gICAgICB0aGlzLmJ1ZmZlciA9IFtdO1xuICAgICAgY29uc3QgbmV3Q29udGVudCA9IGxpbmVzLmpvaW4oXCJcXG5cIikgKyBcIlxcblwiO1xuICAgICAgbGV0IGV4aXN0aW5nID0gXCJcIjtcbiAgICAgIHRyeSB7XG4gICAgICAgIGV4aXN0aW5nID0gYXdhaXQgdGhpcy5hZGFwdGVyLnJlYWQodGhpcy5sb2dQYXRoKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvLyBGaWxlIGRvZXNuJ3QgZXhpc3QgeWV0IFx1MjAxNCB0aGF0J3MgZmluZVxuICAgICAgfVxuICAgICAgYXdhaXQgdGhpcy5hZGFwdGVyLndyaXRlKHRoaXMubG9nUGF0aCwgZXhpc3RpbmcgKyBuZXdDb250ZW50KTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zb2xlLmVycm9yKFwiW0RyYWdJbWddIEZhaWxlZCB0byBmbHVzaCBsb2c6XCIsIGUpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICB0aGlzLmZsdXNoaW5nID0gZmFsc2U7XG4gICAgfVxuICB9XG59XG5cbi8qKiBTaW5nbGV0b24gbG9nZ2VyIGluc3RhbmNlICovXG5leHBvcnQgY29uc3QgbG9nZ2VyID0gbmV3IExvZ2dlcigpO1xuIiwgImltcG9ydCB7XG4gIERlY29yYXRpb24sXG4gIERlY29yYXRpb25TZXQsXG4gIEVkaXRvclZpZXcsXG4gIFZpZXdQbHVnaW4sXG4gIFZpZXdVcGRhdGUsXG4gIFdpZGdldFR5cGUsXG59IGZyb20gXCJAY29kZW1pcnJvci92aWV3XCI7XG5pbXBvcnQge1xuICBSYW5nZVNldEJ1aWxkZXIsXG4gIFN0YXRlRmllbGQsXG4gIFByZWMsXG4gIEFubm90YXRpb24sXG59IGZyb20gXCJAY29kZW1pcnJvci9zdGF0ZVwiO1xuaW1wb3J0IHsgZWRpdG9yTGl2ZVByZXZpZXdGaWVsZCB9IGZyb20gXCJvYnNpZGlhblwiO1xuaW1wb3J0IHsgZGV0ZWN0SW1hZ2VHcm91cHMgfSBmcm9tIFwiLi9pbWFnZURldGVjdG9yXCI7XG5pbXBvcnQgdHlwZSB7IEltYWdlR3JvdXAsIEltYWdlRW1iZWQgfSBmcm9tIFwiLi9pbWFnZURldGVjdG9yXCI7XG5pbXBvcnQgeyBJbWFnZVJvd1dpZGdldCwgSW1hZ2VSb3dPcHRpb25zIH0gZnJvbSBcIi4vaW1hZ2VSb3dXaWRnZXRcIjtcbmltcG9ydCB7IERyYWdJbWFnZVNldHRpbmdzIH0gZnJvbSBcIi4vc2V0dGluZ3NcIjtcbmltcG9ydCB7IENMQVNTRVMgfSBmcm9tIFwiLi9jb25zdGFudHNcIjtcbmltcG9ydCB7IGxvZ2dlciB9IGZyb20gXCIuL2xvZ2dlclwiO1xuXG4vKipcbiAqIFBhcnNlIHRoZSBmaWxlIHBhdGggZnJvbSBhbiBvYnNpZGlhbjovL29wZW4gVVJJIGFuZCBzZWFyY2ggQUxMIGRvY3VtZW50IGxpbmVzXG4gKiBmb3IgYSBtYXRjaGluZyBpbWFnZSBlbWJlZC4gUmV0dXJucyB0aGUgMC1pbmRleGVkIGxpbmUgbnVtYmVyLCBvciBudWxsLlxuICovXG4vKipcbiAqIFBhcnNlIHRoZSBmaWxlIHBhdGggZnJvbSBhbiBvYnNpZGlhbjovL29wZW4gVVJJIGFuZCBzZWFyY2ggdGhlIGRvY3VtZW50XG4gKiBmb3IgdGhlIGNvcnJlc3BvbmRpbmcgc3RhbmRhbG9uZSBpbWFnZSBsaW5lIChub3QgcGFydCBvZiB0aGUgdGFyZ2V0IGdyb3VwKS5cbiAqL1xuZnVuY3Rpb24gZmluZFN0YW5kYWxvbmVJbWFnZUxpbmUoXG4gIHZpZXc6IEVkaXRvclZpZXcsXG4gIG9ic2lkaWFuVXJpOiBzdHJpbmcsXG4gIHRhcmdldEdyb3VwOiBJbWFnZUdyb3VwXG4pOiBudW1iZXIgfCBudWxsIHtcbiAgdHJ5IHtcbiAgICAvLyBEZWNvZGUgdGhlIGZpbGUgcGFyYW1ldGVyIGZyb20gb2JzaWRpYW46Ly9vcGVuP3ZhdWx0PS4uLiZmaWxlPTxlbmNvZGVkUGF0aD5cbiAgICBjb25zdCBtYXRjaCA9IG9ic2lkaWFuVXJpLm1hdGNoKC9bPyZdZmlsZT0oW14mXSspLyk7XG4gICAgaWYgKCFtYXRjaCkgcmV0dXJuIG51bGw7XG5cbiAgICBjb25zdCBlbmNvZGVkUGF0aCA9IG1hdGNoWzFdO1xuICAgIGNvbnN0IGZpbGVQYXRoID0gZGVjb2RlVVJJQ29tcG9uZW50KGVuY29kZWRQYXRoKTtcbiAgICAvLyBFeHRyYWN0IGp1c3QgdGhlIGZpbGVuYW1lIChsYXN0IHNlZ21lbnQgYWZ0ZXIgbGFzdCAvKVxuICAgIGNvbnN0IGZpbGVOYW1lID0gZmlsZVBhdGguc3BsaXQoXCIvXCIpLnBvcCgpO1xuICAgIGlmICghZmlsZU5hbWUpIHJldHVybiBudWxsO1xuXG4gICAgbG9nZ2VyLmRlYnVnKFwiZmluZFN0YW5kYWxvbmVJbWFnZUxpbmUgcGFyc2luZyBVUklcIiwge1xuICAgICAgZW5jb2RlZFBhdGgsXG4gICAgICBmaWxlTmFtZSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGRvYyA9IHZpZXcuc3RhdGUuZG9jO1xuICAgIGNvbnN0IGdyb3VwTGluZXMgPSBuZXcgU2V0PG51bWJlcj4oKTtcbiAgICBmb3IgKGxldCBnID0gdGFyZ2V0R3JvdXAubGluZVN0YXJ0OyBnIDwgdGFyZ2V0R3JvdXAubGluZUVuZDsgZysrKSB7XG4gICAgICBncm91cExpbmVzLmFkZChnKTtcbiAgICB9XG5cbiAgICAvLyBTZWFyY2ggZm9yICFbWy4uLmZpbGVOYW1lXV0gbGluZXMgdGhhdCBhcmUgbm90IGluIHRoZSB0YXJnZXQgZ3JvdXBcbiAgICBmb3IgKGxldCBpID0gMTsgaSA8PSBkb2MubGluZXM7IGkrKykge1xuICAgICAgaWYgKGdyb3VwTGluZXMuaGFzKGkgLSAxKSkgY29udGludWU7IC8vIDAtaW5kZXhlZFxuICAgICAgY29uc3QgbGluZVRleHQgPSBkb2MubGluZShpKS50ZXh0O1xuICAgICAgLy8gQ2hlY2sgaWYgdGhpcyBsaW5lIHJlZmVyZW5jZXMgdGhlIHNhbWUgZmlsZVxuICAgICAgaWYgKGxpbmVUZXh0LmluY2x1ZGVzKGZpbGVOYW1lKSAmJiAvXltcXHNdKiFcXFtcXFsvLnRlc3QobGluZVRleHQpKSB7XG4gICAgICAgIGxvZ2dlci5kZWJ1ZyhcImZpbmRTdGFuZGFsb25lSW1hZ2VMaW5lIGZvdW5kXCIsIHsgbGluZTogaSAtIDEsIGxpbmVUZXh0OiBsaW5lVGV4dC5zdWJzdHJpbmcoMCwgNjApIH0pO1xuICAgICAgICByZXR1cm4gaSAtIDE7IC8vIDAtaW5kZXhlZFxuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gbnVsbDtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGxvZ2dlci5lcnJvcihcImZpbmRTdGFuZGFsb25lSW1hZ2VMaW5lIGVycm9yXCIsIHsgZXJyb3I6IFN0cmluZyhlKSB9KTtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG4vKipcbiAqIFJlc29sdmUgdGhlIHNvdXJjZSBsaW5lIGluZGV4IGZyb20gYSBkcmFnIGRhdGFUcmFuc2ZlciBwYXlsb2FkLlxuICogU3VwcG9ydHM6XG4gKiAgIFwiZGlhYS1yb3c6PGxpbmVTdGFydD46PGluZGV4PlwiICAgXHUyMDE0IGZsZXggcm93IHNvdXJjZVxuICogICBcImRpYWEtc3RhbmRhbG9uZTo8bGluZU51bWJlcj5cIiAgIFx1MjAxNCBzdGFuZGFsb25lIHNvdXJjZSAoaW50ZXJjZXB0ZWQgYXQgZHJhZ3N0YXJ0KVxuICogICBcIm9ic2lkaWFuOi8vb3Blbi4uLlwiICAgICAgICAgICAgIFx1MjAxNCBmYWxsYmFjayBzdGFuZGFsb25lIHNvdXJjZSAobGVnYWN5KVxuICovXG5mdW5jdGlvbiByZXNvbHZlU291cmNlTGluZShcbiAgdmlldzogRWRpdG9yVmlldyxcbiAgZGF0YVRyYW5zZmVyOiBzdHJpbmcsXG4gIHRhcmdldEdyb3VwOiBJbWFnZUdyb3VwXG4pOiBudW1iZXIgfCBudWxsIHtcbiAgY29uc3Qgcm93TWF0Y2ggPSBkYXRhVHJhbnNmZXIubWF0Y2goL15kaWFhLXJvdzooXFxkKyk6KFxcZCspJC8pO1xuICBpZiAocm93TWF0Y2gpIHtcbiAgICByZXR1cm4gcGFyc2VJbnQocm93TWF0Y2hbMV0sIDEwKSArIHBhcnNlSW50KHJvd01hdGNoWzJdLCAxMCk7XG4gIH1cbiAgY29uc3Qgc3RhbmRhbG9uZU1hdGNoID0gZGF0YVRyYW5zZmVyLm1hdGNoKC9eZGlhYS1zdGFuZGFsb25lOihcXGQrKSQvKTtcbiAgaWYgKHN0YW5kYWxvbmVNYXRjaCkge1xuICAgIHJldHVybiBwYXJzZUludChzdGFuZGFsb25lTWF0Y2hbMV0sIDEwKTtcbiAgfVxuICBpZiAoZGF0YVRyYW5zZmVyLnN0YXJ0c1dpdGgoXCJvYnNpZGlhbjovL29wZW5cIikpIHtcbiAgICByZXR1cm4gZmluZFN0YW5kYWxvbmVJbWFnZUxpbmUodmlldywgZGF0YVRyYW5zZmVyLCB0YXJnZXRHcm91cCk7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKlxuICogTW92ZSBvbmUgZG9jdW1lbnQgbGluZSBmcm9tIHNyY0xpbmUgdG8gdGFyZ2V0TGluZS5cbiAqIFVzZXMgYSBzaW5nbGUgcmFuZ2UgcmVwbGFjZW1lbnQgKHNhbWUgcGF0dGVybiBhcyBpbnRyYS1yb3cgcmVvcmRlcilcbiAqIHRvIGF2b2lkIHNlcXVlbnRpYWwtYWRqdXN0bWVudCBpc3N1ZXMgd2l0aCB0d28gQ29kZU1pcnJvciBjaGFuZ2VzLlxuICovXG5mdW5jdGlvbiBtb3ZlTGluZSh2aWV3OiBFZGl0b3JWaWV3LCBzcmNMaW5lOiBudW1iZXIsIHRhcmdldExpbmU6IG51bWJlcik6IHZvaWQge1xuICBpZiAoc3JjTGluZSA9PT0gdGFyZ2V0TGluZSkgcmV0dXJuO1xuXG4gIGNvbnN0IGRvYyA9IHZpZXcuc3RhdGUuZG9jO1xuXG4gIGNvbnN0IG1pbkxpbmUgPSBNYXRoLm1pbihzcmNMaW5lLCB0YXJnZXRMaW5lKTtcbiAgY29uc3QgbWF4TGluZSA9IE1hdGgubWF4KHNyY0xpbmUsIHRhcmdldExpbmUpO1xuXG4gIGNvbnN0IGZyb21Qb3MgPSBkb2MubGluZShtaW5MaW5lICsgMSkuZnJvbTtcbiAgY29uc3QgbWF4TGluZU51bSA9IG1heExpbmUgKyAxOyAvLyAxLWluZGV4ZWRcbiAgY29uc3QgdG9Qb3MgPSBtYXhMaW5lTnVtICsgMSA8PSBkb2MubGluZXNcbiAgICA/IGRvYy5saW5lKG1heExpbmVOdW0gKyAxKS5mcm9tXG4gICAgOiBkb2MubGVuZ3RoO1xuXG4gIGNvbnN0IG9yaWdpbmFsVGV4dCA9IGRvYy5zbGljZVN0cmluZyhmcm9tUG9zLCB0b1Bvcyk7XG4gIGNvbnN0IG9yaWdpbmFsTGluZXMgPSBvcmlnaW5hbFRleHQuc3BsaXQoXCJcXG5cIik7XG4gIGNvbnN0IGhhZFRyYWlsaW5nTmV3bGluZSA9IG9yaWdpbmFsVGV4dC5lbmRzV2l0aChcIlxcblwiKTtcbiAgaWYgKGhhZFRyYWlsaW5nTmV3bGluZSAmJiBvcmlnaW5hbExpbmVzLmxlbmd0aCA+IDApIHtcbiAgICBvcmlnaW5hbExpbmVzLnBvcCgpOyAvLyByZW1vdmUgZW1wdHkgbGFzdCBlbnRyeSBmcm9tIHRyYWlsaW5nIFxcblxuICB9XG5cbiAgY29uc3QgbG9jYWxTcmMgPSBzcmNMaW5lIC0gbWluTGluZTtcbiAgY29uc3QgbG9jYWxUYXJnZXQgPSB0YXJnZXRMaW5lIC0gbWluTGluZTtcblxuICBjb25zdCBbbW92ZWRdID0gb3JpZ2luYWxMaW5lcy5zcGxpY2UobG9jYWxTcmMsIDEpO1xuICBjb25zdCBpbnNlcnRBdCA9IGxvY2FsVGFyZ2V0O1xuICBvcmlnaW5hbExpbmVzLnNwbGljZShpbnNlcnRBdCwgMCwgbW92ZWQpO1xuXG4gIGNvbnN0IGluc2VydCA9IG9yaWdpbmFsTGluZXMuam9pbihcIlxcblwiKSArIChoYWRUcmFpbGluZ05ld2xpbmUgPyBcIlxcblwiIDogXCJcIik7XG5cbiAgbG9nZ2VyLmluZm8oXCJMaXZlUHJldmlldyBtb3ZlTGluZVwiLCB7XG4gICAgc3JjTGluZSwgdGFyZ2V0TGluZSwgbWluTGluZSwgbWF4TGluZSxcbiAgICBmcm9tUG9zLCB0b1BvcyxcbiAgICBsaW5lQ291bnQ6IG9yaWdpbmFsTGluZXMubGVuZ3RoICsgMSxcbiAgfSk7XG5cbiAgdmlldy5kaXNwYXRjaCh7XG4gICAgY2hhbmdlczogeyBmcm9tOiBmcm9tUG9zLCB0bzogdG9Qb3MsIGluc2VydCB9LFxuICB9KTtcbn1cblxuLyoqXG4gKiBDb2RlTWlycm9yIFdpZGdldCB0aGF0IHJlbmRlcnMgYSBmbGV4IHJvdyBvZiBpbWFnZXMgd2l0aCBpbnRlcmFjdGl2ZSBmZWF0dXJlcy5cbiAqL1xuLyoqIFN0cmlwIGV2ZXJ5dGhpbmcgYmV0d2VlbiB0aGUgZmlyc3QgfCBhbmQgXV0gc28gd2lkZ2V0IGVxdWFsaXR5IGlnbm9yZXNcbiAqIHdpZHRoL2RpbWVuc2lvbiBtZXRhZGF0YSBcdTIwMTQgb25seSB0aGUgaW1hZ2UgZmlsZSBuYW1lIG1hdHRlcnMgZm9yIGlkZW50aXR5LiAqL1xuZnVuY3Rpb24gbm9ybWFsaXplUmF3KHJhdzogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJhdy5yZXBsYWNlKC9cXHxbXlxcXV0qKD89XFxdXFxdKS8sIFwiXCIpO1xufVxuXG4vKiogV3JpdGUgZmxleC1ncm93IHZhbHVlcyBiYWNrIHRvIG1hcmtkb3duIGFzICFbW2ZpbGV8d2lkdGhdXS5cbiAqICBFeHRyYWN0ZWQgc28gaXQgY2FuIGJlIGNhbGxlZCBib3RoIHN5bmNocm9ub3VzbHkgKGxlZ2FjeSkgYW5kIGRlZmVycmVkXG4gKiAgdmlhIHNldFRpbWVvdXQgKGZyb20gZGVzdHJveSwgd2hlcmUgdmlldy5kaXNwYXRjaCBpcyBpbGxlZ2FsKS4gKi9cbmZ1bmN0aW9uIGFwcGx5RmxleEdyb3dDaGFuZ2VzKFxuICB2aWV3OiBFZGl0b3JWaWV3LFxuICBpbWFnZXM6IEltYWdlRW1iZWRbXSxcbiAgZ3Jvd3M6IG51bWJlcltdXG4pOiB2b2lkIHtcbiAgY29uc3QgY2hhbmdlczogQXJyYXk8eyBmcm9tOiBudW1iZXI7IHRvOiBudW1iZXI7IGluc2VydDogc3RyaW5nIH0+ID0gW107XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgZ3Jvd3MubGVuZ3RoICYmIGkgPCBpbWFnZXMubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBuZXdMaW5lID0gdXBkYXRlSW1hZ2VMaW5lV2lkdGgoaW1hZ2VzW2ldLnJhdywgZ3Jvd3NbaV0pO1xuICAgIGlmIChuZXdMaW5lID09PSBpbWFnZXNbaV0ucmF3KSBjb250aW51ZTtcblxuICAgIGNvbnN0IGxpbmUgPSBpbWFnZXNbaV0ubGluZSArIDE7IC8vIDEtaW5kZXhlZFxuICAgIGNvbnN0IGxpbmVPYmogPSB2aWV3LnN0YXRlLmRvYy5saW5lKGxpbmUpO1xuICAgIGNoYW5nZXMucHVzaCh7IGZyb206IGxpbmVPYmouZnJvbSwgdG86IGxpbmVPYmouZnJvbSArIGxpbmVPYmoudGV4dC5sZW5ndGgsIGluc2VydDogbmV3TGluZSB9KTtcbiAgfVxuXG4gIGlmIChjaGFuZ2VzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuXG4gIC8vIEFwcGx5IGZyb20gYm90dG9tIHRvIHRvcCBzbyBlYXJsaWVyIHBvc2l0aW9ucyBzdGF5IHZhbGlkXG4gIGNoYW5nZXMuc29ydCgoYSwgYikgPT4gYi5mcm9tIC0gYS5mcm9tKTtcbiAgdmlldy5kaXNwYXRjaCh7IGNoYW5nZXMgfSk7XG59XG5cbmNsYXNzIFN0YXRpY0ltYWdlUm93V2lkZ2V0IGV4dGVuZHMgV2lkZ2V0VHlwZSB7XG4gIHByaXZhdGUgZ3JvdXA6IEltYWdlR3JvdXA7XG4gIHByaXZhdGUgb3B0aW9uczogSW1hZ2VSb3dPcHRpb25zO1xuICBwcml2YXRlIGlubmVyV2lkZ2V0OiBJbWFnZVJvd1dpZGdldCB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGVkaXRvclZpZXc6IEVkaXRvclZpZXcgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBwZXJzaXN0VGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG5cbiAgY29uc3RydWN0b3IoZ3JvdXA6IEltYWdlR3JvdXAsIG9wdGlvbnM6IEltYWdlUm93T3B0aW9ucykge1xuICAgIHN1cGVyKCk7XG4gICAgdGhpcy5ncm91cCA9IGdyb3VwO1xuICAgIHRoaXMub3B0aW9ucyA9IG9wdGlvbnM7XG4gICAgbG9nZ2VyLmRlYnVnKFwiU3RhdGljSW1hZ2VSb3dXaWRnZXQgY29uc3RydWN0ZWRcIiwge1xuICAgICAgaW1hZ2VDb3VudDogZ3JvdXAuaW1hZ2VzLmxlbmd0aCxcbiAgICAgIGxpbmVTdGFydDogZ3JvdXAubGluZVN0YXJ0LFxuICAgICAgbGluZUVuZDogZ3JvdXAubGluZUVuZCxcbiAgICB9KTtcbiAgfVxuXG4gIGVxKG90aGVyOiBTdGF0aWNJbWFnZVJvd1dpZGdldCk6IGJvb2xlYW4ge1xuICAgIGNvbnN0IGEgPSB0aGlzLmdyb3VwO1xuICAgIGNvbnN0IGIgPSBvdGhlci5ncm91cDtcbiAgICBpZiAoYS5pbWFnZXMubGVuZ3RoICE9PSBiLmltYWdlcy5sZW5ndGgpIHJldHVybiBmYWxzZTtcbiAgICBpZiAoYS5saW5lU3RhcnQgIT09IGIubGluZVN0YXJ0KSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGEubGluZUVuZCAhPT0gYi5saW5lRW5kKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKHRoaXMub3B0aW9ucy5zbmFwU2Vuc2l0aXZpdHkgIT09IG90aGVyLm9wdGlvbnMuc25hcFNlbnNpdGl2aXR5KSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKHRoaXMub3B0aW9ucy5naG9zdEltYWdlV2lkdGggIT09IG90aGVyLm9wdGlvbnMuZ2hvc3RJbWFnZVdpZHRoKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKHRoaXMub3B0aW9ucy50b3BCYXJTZW5zaXRpdml0eSAhPT0gb3RoZXIub3B0aW9ucy50b3BCYXJTZW5zaXRpdml0eSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmICh0aGlzLm9wdGlvbnMuZHJhZ09wYWNpdHkgIT09IG90aGVyLm9wdGlvbnMuZHJhZ09wYWNpdHkpIHJldHVybiBmYWxzZTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGEuaW1hZ2VzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBpZiAobm9ybWFsaXplUmF3KGEuaW1hZ2VzW2ldLnJhdykgIT09IG5vcm1hbGl6ZVJhdyhiLmltYWdlc1tpXS5yYXcpKSByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgdG9ET00odmlldzogRWRpdG9yVmlldyk6IEhUTUxFbGVtZW50IHtcbiAgICB0cnkge1xuICAgICAgbG9nZ2VyLmRlYnVnKFwiU3RhdGljSW1hZ2VSb3dXaWRnZXQgdG9ET01cIiwge1xuICAgICAgICBpbWFnZUNvdW50OiB0aGlzLmdyb3VwLmltYWdlcy5sZW5ndGgsXG4gICAgICAgIGZpbGVzOiB0aGlzLmdyb3VwLmltYWdlcy5tYXAoKGkpID0+IGkuZmlsZU5hbWUpLFxuICAgICAgfSk7XG4gICAgICB0aGlzLmVkaXRvclZpZXcgPSB2aWV3O1xuICAgICAgdGhpcy5pbm5lcldpZGdldCA9IG5ldyBJbWFnZVJvd1dpZGdldCh0aGlzLmdyb3VwLCB0aGlzLm9wdGlvbnMpO1xuICAgICAgY29uc3QgZWwgPSB0aGlzLmlubmVyV2lkZ2V0LmJ1aWxkKCk7XG5cbiAgICAgIC8vIE5vdGlmeSBDb2RlTWlycm9yIHdoZW4gdGhlIHdpZGdldCBoZWlnaHQgY2hhbmdlcyBhZnRlciBpbWFnZXMgbG9hZFxuICAgICAgdGhpcy5pbm5lcldpZGdldC5vbkxheW91dENoYW5nZSA9ICgpID0+IHtcbiAgICAgICAgdGhpcy5lZGl0b3JWaWV3Py5yZXF1ZXN0TWVhc3VyZSgpO1xuICAgICAgfTtcblxuICAgICAgLy8gU2V0IHVwIGRyYWcgcmVvcmRlciB3aXRoaW4gdGhpcyByb3dcbiAgICAgIHRoaXMuaW5uZXJXaWRnZXQub25SZW9yZGVyKChmcm9tSW5kZXgsIHRvSW5kZXgpID0+IHtcbiAgICAgICAgdGhpcy5oYW5kbGVSZW9yZGVyKGZyb21JbmRleCwgdG9JbmRleCk7XG4gICAgICB9KTtcbiAgICAgIHRoaXMuaW5uZXJXaWRnZXQuZW5hYmxlRHJhZ1Jlb3JkZXIoKTtcblxuICAgICAgLy8gRmxleC1ncm93IHZhbHVlcyBhcmUgcGVyc2lzdGVkIGluIGRlc3Ryb3koKSwgbm90IGR1cmluZyBpbnRlcmFjdGl2ZVxuICAgICAgLy8gcmVzaXplLCB0byBhdm9pZCB0cmlnZ2VyaW5nIGEgQ29kZU1pcnJvciBkZWNvcmF0aW9uIHJlYnVpbGQgYW5kIGZsYXNoLlxuXG4gICAgICAvLyBIYW5kbGUgY3Jvc3Mtcm93IG1lcmdlOiBkcmFnIGEgc3RhbmRhbG9uZSBpbWFnZSBpbnRvIHRoaXMgcm93XG4gICAgICB0aGlzLmlubmVyV2lkZ2V0Lm9uTWVyZ2VFeHRlcm5hbCgoaW5zZXJ0QXRJbmRleCwgZGF0YVRyYW5zZmVyKSA9PiB7XG4gICAgICAgIHRoaXMuaGFuZGxlTWVyZ2VFeHRlcm5hbChpbnNlcnRBdEluZGV4LCBkYXRhVHJhbnNmZXIpO1xuICAgICAgfSk7XG5cbiAgICAgIHJldHVybiBlbDtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBsb2dnZXIuZXJyb3IoXCJTdGF0aWNJbWFnZVJvd1dpZGdldCB0b0RPTSBlcnJvclwiLCB7IGVycm9yOiBTdHJpbmcoZSkgfSk7XG4gICAgICBjb25zdCBmYWxsYmFjayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICAgICAgZmFsbGJhY2sudGV4dENvbnRlbnQgPSBcIihpbWFnZSByb3cgcmVuZGVyIGVycm9yKVwiO1xuICAgICAgcmV0dXJuIGZhbGxiYWNrO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgaGFuZGxlUmVvcmRlcihmcm9tSW5kZXg6IG51bWJlciwgdG9JbmRleDogbnVtYmVyKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmVkaXRvclZpZXcpIHJldHVybjtcbiAgICBjb25zdCB2aWV3ID0gdGhpcy5lZGl0b3JWaWV3O1xuICAgIGNvbnN0IGltYWdlcyA9IHRoaXMuZ3JvdXAuaW1hZ2VzO1xuICAgIGlmIChmcm9tSW5kZXggPT09IHRvSW5kZXgpIHJldHVybjtcbiAgICBpZiAoZnJvbUluZGV4IDwgMCB8fCBmcm9tSW5kZXggPj0gaW1hZ2VzLmxlbmd0aCB8fFxuICAgICAgICB0b0luZGV4IDwgMCB8fCB0b0luZGV4ID49IGltYWdlcy5sZW5ndGgpIHJldHVybjtcblxuICAgIGNvbnN0IGZyb21MaW5lID0gaW1hZ2VzW2Zyb21JbmRleF0ubGluZTtcbiAgICBjb25zdCB0b0xpbmUgPSBpbWFnZXNbdG9JbmRleF0ubGluZTtcblxuICAgIC8vIFRoZXNlIGxpbmVzIGFyZSBhbHdheXMgY29uc2VjdXRpdmUgaW4gYSBncm91cFxuICAgIGNvbnN0IG1pbkxpbmUgPSB0aGlzLmdyb3VwLmxpbmVTdGFydDtcbiAgICBjb25zdCBtYXhMaW5lID0gdGhpcy5ncm91cC5saW5lRW5kIC0gMTtcblxuICAgIGNvbnN0IGRvYyA9IHZpZXcuc3RhdGUuZG9jO1xuICAgIGNvbnN0IGZyb21Qb3MgPSBkb2MubGluZShtaW5MaW5lICsgMSkuZnJvbTtcbiAgICBjb25zdCB0b1BvcyA9IG1heExpbmUgKyAyIDw9IGRvYy5saW5lc1xuICAgICAgPyBkb2MubGluZShtYXhMaW5lICsgMikuZnJvbVxuICAgICAgOiBkb2MubGVuZ3RoO1xuXG4gICAgLy8gUmVhZCB0aGUgb3JpZ2luYWwgdGV4dCByYW5nZSBpbmNsdWRpbmcgYWxsIG5ld2xpbmVzLCB0aGVuIHJlb3JkZXJcbiAgICAvLyB0aGUgbGluZXMgaW4tcGxhY2UgdG8gcHJlc2VydmUgdGhlIGV4YWN0IG5ld2xpbmUgc3RydWN0dXJlLlxuICAgIGNvbnN0IG9yaWdpbmFsVGV4dCA9IGRvYy5zbGljZVN0cmluZyhmcm9tUG9zLCB0b1Bvcyk7XG4gICAgY29uc3Qgb3JpZ2luYWxMaW5lcyA9IG9yaWdpbmFsVGV4dC5zcGxpdChcIlxcblwiKTtcblxuICAgIC8vIFJlb3JkZXIgd2l0aGluIHRoZSBncm91cCBsaW5lcyAobG9jYWwgaW5kaWNlcylcbiAgICBjb25zdCBsb2NhbEZyb20gPSBmcm9tTGluZSAtIG1pbkxpbmU7XG4gICAgY29uc3QgbG9jYWxUbyA9IHRvTGluZSAtIG1pbkxpbmU7XG5cbiAgICBjb25zdCBbbW92ZWRdID0gb3JpZ2luYWxMaW5lcy5zcGxpY2UobG9jYWxGcm9tLCAxKTtcbiAgICBjb25zdCBpbnNlcnRBdCA9IGZyb21JbmRleCA8IHRvSW5kZXhcbiAgICAgID8gKGxvY2FsVG8gLSAoZnJvbUxpbmUgPCB0b0xpbmUgPyAxIDogMCkpICsgMVxuICAgICAgOiBsb2NhbFRvO1xuICAgIG9yaWdpbmFsTGluZXMuc3BsaWNlKGluc2VydEF0LCAwLCBtb3ZlZCk7XG5cbiAgICBjb25zdCBpbnNlcnQgPSBvcmlnaW5hbExpbmVzLmpvaW4oXCJcXG5cIik7XG5cbiAgICBsb2dnZXIuaW5mbyhcIkxpdmVQcmV2aWV3IGRyYWcgcmVvcmRlclwiLCB7XG4gICAgICBmcm9tSW5kZXgsIHRvSW5kZXgsIGZyb21MaW5lLCB0b0xpbmUsXG4gICAgICBtaW5MaW5lLCBtYXhMaW5lLCBmcm9tUG9zLCB0b1BvcywgZG9jTGVuZ3RoOiBkb2MubGVuZ3RoLFxuICAgICAgZG9jTGluZXM6IGRvYy5saW5lcyxcbiAgICAgIGJlZm9yZTogaW1hZ2VzLm1hcChpID0+IGkucmF3KSxcbiAgICAgIGFmdGVyOiBvcmlnaW5hbExpbmVzLFxuICAgICAgb3JpZ2luYWxMZW5ndGg6IG9yaWdpbmFsVGV4dC5sZW5ndGgsXG4gICAgICBpbnNlcnRMZW5ndGg6IGluc2VydC5sZW5ndGgsXG4gICAgfSk7XG5cbiAgICB2aWV3LmRpc3BhdGNoKHtcbiAgICAgIGNoYW5nZXM6IHsgZnJvbTogZnJvbVBvcywgdG86IHRvUG9zLCBpbnNlcnQgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IG5ld0RvYyA9IHZpZXcuc3RhdGUuZG9jLnRvU3RyaW5nKCk7XG4gICAgbG9nZ2VyLmRlYnVnKFwiTGl2ZVByZXZpZXcgcG9zdC1yZW9yZGVyIGRvY1wiLCB7XG4gICAgICBkb2NMaW5lczogdmlldy5zdGF0ZS5kb2MubGluZXMsXG4gICAgICBkb2NMZW5ndGg6IHZpZXcuc3RhdGUuZG9jLmxlbmd0aCxcbiAgICAgIGRvY1ByZXZpZXc6IG5ld0RvYy5zdWJzdHJpbmcoMCwgNTAwKSxcbiAgICB9KTtcblxuICAgIC8vIERpYWdub3N0aWM6IGNoZWNrIERPTSBmb3IgbGVha2VkIE9ic2lkaWFuIGltYWdlIGVtYmVkcyBhZnRlciByZW9yZGVyXG4gICAgY29uc3QgY2FwdHVyZWRWaWV3ID0gdmlldztcbiAgICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgYWxsRW1iZWRzID0gY2FwdHVyZWRWaWV3LmRvbS5xdWVyeVNlbGVjdG9yQWxsKFxuICAgICAgICAgIFwiLmludGVybmFsLWVtYmVkLmltYWdlLWVtYmVkXCJcbiAgICAgICAgKTtcbiAgICAgICAgY29uc3QgZW1iZWRJbmZvOiBBcnJheTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4gPSBbXTtcbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBhbGxFbWJlZHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICBjb25zdCBlbCA9IGFsbEVtYmVkc1tpXSBhcyBIVE1MRWxlbWVudDtcbiAgICAgICAgICBjb25zdCByZWN0ID0gZWwuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgICAgICAgY29uc3QgaW1nID0gZWwucXVlcnlTZWxlY3RvcihcImltZ1wiKTtcbiAgICAgICAgICBlbWJlZEluZm8ucHVzaCh7XG4gICAgICAgICAgICBvZmZzZXRIZWlnaHQ6IGVsLm9mZnNldEhlaWdodCxcbiAgICAgICAgICAgIG9mZnNldFdpZHRoOiBlbC5vZmZzZXRXaWR0aCxcbiAgICAgICAgICAgIHJlY3RUb3A6IHJlY3QudG9wLFxuICAgICAgICAgICAgcmVjdEJvdHRvbTogcmVjdC5ib3R0b20sXG4gICAgICAgICAgICBkaXNwbGF5OiB3aW5kb3cuZ2V0Q29tcHV0ZWRTdHlsZShlbCkuZGlzcGxheSxcbiAgICAgICAgICAgIGltZ1NyYzogaW1nPy5nZXRBdHRyaWJ1dGUoXCJzcmNcIik/LnN1YnN0cmluZygwLCA4MCkgfHwgXCJcIixcbiAgICAgICAgICAgIHBhcmVudFRhZzogZWwucGFyZW50RWxlbWVudD8udGFnTmFtZSB8fCBcIlwiLFxuICAgICAgICAgICAgcGFyZW50Q2xhc3M6IGVsLnBhcmVudEVsZW1lbnQ/LmNsYXNzTmFtZT8uc3Vic3RyaW5nKDAsIDYwKSB8fCBcIlwiLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGxvZ2dlci5kZWJ1ZyhcIkxpdmVQcmV2aWV3IHBvc3QtcmVvcmRlciBET00gY2hlY2tcIiwge1xuICAgICAgICAgIGVtYmVkQ291bnQ6IGFsbEVtYmVkcy5sZW5ndGgsXG4gICAgICAgICAgY21MaW5lQ291bnQ6IGNhcHR1cmVkVmlldy5kb20ucXVlcnlTZWxlY3RvckFsbChcIi5jbS1saW5lXCIpLmxlbmd0aCxcbiAgICAgICAgICBlbWJlZHM6IGVtYmVkSW5mbyxcbiAgICAgICAgfSk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgbG9nZ2VyLmRlYnVnKFwiTGl2ZVByZXZpZXcgcG9zdC1yZW9yZGVyIERPTSBjaGVjayBlcnJvclwiLCB7XG4gICAgICAgICAgZXJyb3I6IFN0cmluZyhlcnIpLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBNZXJnZSBhbiBpbWFnZSBmcm9tIGFub3RoZXIgbG9jYXRpb24gaW50byB0aGlzIGZsZXggcm93LlxuICAgKiBTdXBwb3J0cyBib3RoIHN0YW5kYWxvbmUgKG9ic2lkaWFuOi8vb3BlbikgYW5kIGZsZXgtcm93IChcImRpYWEtcm93OlwiKSBzb3VyY2VzLlxuICAgKi9cbiAgcHJpdmF0ZSBoYW5kbGVNZXJnZUV4dGVybmFsKGluc2VydEF0SW5kZXg6IG51bWJlciwgZGF0YVRyYW5zZmVyOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuZWRpdG9yVmlldykgcmV0dXJuO1xuICAgIGNvbnN0IHZpZXcgPSB0aGlzLmVkaXRvclZpZXc7XG5cbiAgICAvLyBSZXNvbHZlIHNvdXJjZSBsaW5lIGZyb20gZGF0YVRyYW5zZmVyXG4gICAgY29uc3Qgc3JjTGluZSA9IHJlc29sdmVTb3VyY2VMaW5lKHZpZXcsIGRhdGFUcmFuc2ZlciwgdGhpcy5ncm91cCk7XG4gICAgaWYgKHNyY0xpbmUgPT09IG51bGwpIHtcbiAgICAgIGxvZ2dlci5kZWJ1ZyhcIkxpdmVQcmV2aWV3IG1lcmdlRXh0ZXJuYWw6IGNvdWxkIG5vdCByZXNvbHZlIHNvdXJjZVwiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCB0YXJnZXRMaW5lID0gdGhpcy5ncm91cC5saW5lU3RhcnQgKyBpbnNlcnRBdEluZGV4O1xuICAgIGlmIChzcmNMaW5lID09PSB0YXJnZXRMaW5lKSByZXR1cm47XG5cbiAgICBsb2dnZXIuaW5mbyhcIkxpdmVQcmV2aWV3IGNyb3NzLXJvdyBtZXJnZVwiLCB7XG4gICAgICBzcmNMaW5lLCB0YXJnZXRMaW5lLCBpbnNlcnRBdEluZGV4LFxuICAgICAgZGF0YVRyYW5zZmVyOiBkYXRhVHJhbnNmZXIuc3Vic3RyaW5nKDAsIDQwKSxcbiAgICB9KTtcblxuICAgIG1vdmVMaW5lKHZpZXcsIHNyY0xpbmUsIHRhcmdldExpbmUpO1xuICB9XG5cbiAgdXBkYXRlRE9NKF9lbGVtZW50OiBIVE1MRWxlbWVudCwgdmlldzogRWRpdG9yVmlldyk6IGJvb2xlYW4ge1xuICAgIC8vIFJlLXJlYWQgZmxleC1ncm93cyBmcm9tIGVkaXRvciB0ZXh0IChwZXJzaXN0RmxleEdyb3dzIG1heSBoYXZlXG4gICAgLy8gdXBkYXRlZCB0aGVtKS4gIFJldHVybmluZyB0cnVlIHRlbGxzIENvZGVNaXJyb3IgdGhlIGV4aXN0aW5nIERPTVxuICAgIC8vIGlzIHN0aWxsIGdvb2QgXHUyMDE0IG5vIHJlYnVpbGQsIG5vIGZsYXNoLlxuICAgIGlmICh0aGlzLmlubmVyV2lkZ2V0ICYmIHRoaXMuZ3JvdXApIHtcbiAgICAgIGNvbnN0IGRvYyA9IHZpZXcuc3RhdGUuZG9jO1xuICAgICAgY29uc3QgZ3Jvd3M6IG51bWJlcltdID0gW107XG4gICAgICBmb3IgKGxldCBsaW5lID0gdGhpcy5ncm91cC5saW5lU3RhcnQ7IGxpbmUgPCB0aGlzLmdyb3VwLmxpbmVFbmQ7IGxpbmUrKykge1xuICAgICAgICBjb25zdCB0ZXh0ID0gZG9jLmxpbmUobGluZSArIDEpLnRleHQ7XG4gICAgICAgIGNvbnN0IG1hdGNoID0gdGV4dC5tYXRjaCgvXFx8KFxcZCspKD86XFxdXFxdfFxcfCkvKTtcbiAgICAgICAgY29uc3QgZmxleCA9IG1hdGNoID8gcGFyc2VJbnQobWF0Y2hbMV0sIDEwKSAvIDEwMCA6IDE7XG4gICAgICAgIGdyb3dzLnB1c2goZmxleCk7XG4gICAgICB9XG4gICAgICBpZiAoZ3Jvd3MubGVuZ3RoID09PSB0aGlzLmdyb3VwLmltYWdlcy5sZW5ndGgpIHtcbiAgICAgICAgdGhpcy5pbm5lcldpZGdldC51cGRhdGVGbGV4R3Jvd3MoZ3Jvd3MpO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIGlnbm9yZUV2ZW50KGV2ZW50OiBFdmVudCk6IGJvb2xlYW4ge1xuICAgIGlmIChldmVudC50eXBlLnN0YXJ0c1dpdGgoXCJkcmFnXCIpKSByZXR1cm4gdHJ1ZTtcbiAgICBjb25zdCB0YXJnZXQgPSBldmVudC50YXJnZXQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICAgIGlmICh0YXJnZXQ/LmNsb3Nlc3Q/LihcIi5cIiArIENMQVNTRVMucmVzaXplSGFuZGxlKSB8fCB0YXJnZXQ/LmNsb3Nlc3Q/LihcIi5cIiArIENMQVNTRVMuZGl2aWRlcikpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBkZXN0cm95KCk6IHZvaWQge1xuICAgIGxvZ2dlci5kZWJ1ZyhcIlN0YXRpY0ltYWdlUm93V2lkZ2V0IGRlc3Ryb3llZFwiKTtcbiAgICBpZiAodGhpcy5wZXJzaXN0VGltZXIpIGNsZWFyVGltZW91dCh0aGlzLnBlcnNpc3RUaW1lcik7XG4gICAgdGhpcy5wZXJzaXN0VGltZXIgPSBudWxsO1xuICAgIC8vIERlZmVyOiB2aWV3LmRpc3BhdGNoKCkgaW5zaWRlIGEgQ29kZU1pcnJvciB1cGRhdGUgY3ljbGUgKGUuZy4gbW9kZVxuICAgIC8vIHN3aXRjaCwgZGVjb3JhdGlvbiByZW1vdmFsKSB0aHJvd3MgYW5kIGNvcnJ1cHRzIGRlY29yYXRpb25zLlxuICAgIC8vIENhcHR1cmUgc3RhdGUgYmVmb3JlIHRlYXJkb3duOyBkaXNwYXRjaCBpbiBuZXh0IGV2ZW50LWxvb3AgdGljay5cbiAgICBpZiAodGhpcy5lZGl0b3JWaWV3ICYmIHRoaXMuaW5uZXJXaWRnZXQpIHtcbiAgICAgIGNvbnN0IHZpZXcgPSB0aGlzLmVkaXRvclZpZXc7XG4gICAgICBjb25zdCBpbWFnZXMgPSBbLi4udGhpcy5ncm91cC5pbWFnZXNdO1xuICAgICAgY29uc3QgZ3Jvd3MgPSB0aGlzLmlubmVyV2lkZ2V0LmdldEN1cnJlbnRGbGV4R3Jvd3MoKTtcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gYXBwbHlGbGV4R3Jvd0NoYW5nZXModmlldywgaW1hZ2VzLCBncm93cyksIDApO1xuICAgIH1cbiAgICB0aGlzLmlubmVyV2lkZ2V0Py5kZXN0cm95KCk7XG4gICAgdGhpcy5pbm5lcldpZGdldCA9IG51bGw7XG4gIH1cblxuICAvKiogV3JpdGUgY3VycmVudCBmbGV4LWdyb3cgdmFsdWVzIGJhY2sgdG8gbWFya2Rvd24gYXMgIVtbZmlsZXx3aWR0aF1dLiAqL1xuICBwcml2YXRlIHBlcnNpc3RGbGV4R3Jvd3MoKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmVkaXRvclZpZXcgfHwgIXRoaXMuaW5uZXJXaWRnZXQpIHJldHVybjtcbiAgICBhcHBseUZsZXhHcm93Q2hhbmdlcyhcbiAgICAgIHRoaXMuZWRpdG9yVmlldyxcbiAgICAgIHRoaXMuZ3JvdXAuaW1hZ2VzLFxuICAgICAgdGhpcy5pbm5lcldpZGdldC5nZXRDdXJyZW50RmxleEdyb3dzKClcbiAgICApO1xuICB9XG59XG5cbi8qKiBSZXBsYWNlIG9yIHJlbW92ZSB0aGUgfHdpZHRoIHBhcmFtZXRlciBpbiBhbiBpbWFnZSBlbWJlZCBsaW5lLiAqL1xuZnVuY3Rpb24gdXBkYXRlSW1hZ2VMaW5lV2lkdGgocmF3OiBzdHJpbmcsIGZsZXhHcm93OiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCB3aWR0aFZhbHVlID0gTWF0aC5yb3VuZChmbGV4R3JvdyAqIDEwMCk7XG4gIC8vIFN0cmlwIGV2ZXJ5dGhpbmcgYmV0d2VlbiBmaWxlIGV4dGVuc2lvbiBhbmQgXV0gKGhhbmRsZXMgfHdpZHRoLCB8V3hILCB8d2lkdGh8V3hIKVxuICBsZXQgb3V0ID0gcmF3LnJlcGxhY2UoL1xcfFteXFxdXSooPz1cXF1cXF0pLywgXCJcIik7XG4gIGlmICh3aWR0aFZhbHVlID09PSAxMDApIHJldHVybiBvdXQ7IC8vIGRlZmF1bHQgXHUyMTkyIG9taXRcbiAgcmV0dXJuIG91dC5yZXBsYWNlKC9cXF1cXF0vLCBgfCR7d2lkdGhWYWx1ZX1dXWApO1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgU3RhdGUgZmllbGQgZm9yIGRlY29yYXRpb25zIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBidWlsZERlY29yYXRpb25zKFxuICBzdGF0ZTogRWRpdG9yVmlld1tcInN0YXRlXCJdLFxuICBnZXRPcHRpb25zOiAoKSA9PiBJbWFnZVJvd09wdGlvbnMsXG4gIGdldFNldHRpbmdzOiAoKSA9PiBEcmFnSW1hZ2VTZXR0aW5ncyxcbiAgaXNFbmFibGVkOiAoKSA9PiBib29sZWFuXG4pOiBEZWNvcmF0aW9uU2V0IHtcbiAgdHJ5IHtcbiAgICAvLyBDYXB0dXJlIHN0YWNrIHRvIGlkZW50aWZ5IHRoZSBjYWxsIGNoYWluIHRyaWdnZXJpbmcgYSByZWJ1aWxkLlxuICAgIC8vIEZpbHRlciB0byB0aGUgZmlyc3QgZmV3IGZyYW1lcyBhZnRlciBidWlsZERlY29yYXRpb25zIGl0c2VsZi5cbiAgICBjb25zdCBzdGFjayA9IG5ldyBFcnJvcigpLnN0YWNrPy5zcGxpdChcIlxcblwiKS5zbGljZSgyLCA4KS5qb2luKFwiXFxuXCIpIHx8IFwiXCI7XG4gICAgbG9nZ2VyLmRlYnVnKFwiYnVpbGREZWNvcmF0aW9ucyBpbnZva2VkXCIsIHsgdGltZXN0YW1wOiBEYXRlLm5vdygpLCBzdGFjayB9KTtcblxuICAgIGlmICghaXNFbmFibGVkKCkpIHtcbiAgICAgIGxvZ2dlci5kZWJ1ZyhcIkxpdmVQcmV2aWV3IGRlY29yYXRpb25zIHNraXBwZWQgKGRpc2FibGVkKVwiKTtcbiAgICAgIHJldHVybiBEZWNvcmF0aW9uLm5vbmU7XG4gICAgfVxuXG4gICAgLy8gU2tpcCBpbiBzb3VyY2UgbW9kZTogZWRpdG9yTGl2ZVByZXZpZXdGaWVsZCBpcyBvbmx5IHByZXNlbnQvdHJ1ZSBpbiBMaXZlIFByZXZpZXdcbiAgICBpZiAoIXN0YXRlLmZpZWxkKGVkaXRvckxpdmVQcmV2aWV3RmllbGQsIGZhbHNlKSkge1xuICAgICAgbG9nZ2VyLmRlYnVnKFwiTGl2ZVByZXZpZXcgZGVjb3JhdGlvbnMgc2tpcHBlZCAoc291cmNlIG1vZGUpXCIpO1xuICAgICAgcmV0dXJuIERlY29yYXRpb24ubm9uZTtcbiAgICB9XG5cbiAgICBjb25zdCBkb2MgPSBzdGF0ZS5kb2MudG9TdHJpbmcoKTtcbiAgICBpZiAoIWRvYykgcmV0dXJuIERlY29yYXRpb24ubm9uZTtcblxuICAgIGNvbnN0IHNldHRpbmdzID0gZ2V0U2V0dGluZ3MoKTtcbiAgICBjb25zdCBiYXNlT3B0aW9ucyA9IGdldE9wdGlvbnMoKTtcblxuICAgIGNvbnN0IG9wdGlvbnMgPSBiYXNlT3B0aW9ucztcblxuICAgIGNvbnN0IGdyb3VwcyA9IGRldGVjdEltYWdlR3JvdXBzKFxuICAgICAgZG9jLFxuICAgICAgc2V0dGluZ3MubWF4SW1hZ2VzUGVyUm93LFxuICAgICAgc2V0dGluZ3MuaW1hZ2VFeHRlbnNpb25zXG4gICAgKTtcblxuICAgIGxvZ2dlci5kZWJ1ZyhcIkxpdmVQcmV2aWV3IGJ1aWxkRGVjb3JhdGlvbnNcIiwge1xuICAgICAgZ3JvdXBDb3VudDogZ3JvdXBzLmxlbmd0aCxcbiAgICAgIGVuYWJsZWQ6IGlzRW5hYmxlZCgpLFxuICAgICAgZG9jTGVuZ3RoOiBkb2MubGVuZ3RoLFxuICAgICAgZG9jTGluZXM6IHN0YXRlLmRvYy5saW5lcyxcbiAgICAgIGdyb3VwczogZ3JvdXBzLm1hcChnID0+ICh7XG4gICAgICAgIGxpbmVTdGFydDogZy5saW5lU3RhcnQsXG4gICAgICAgIGxpbmVFbmQ6IGcubGluZUVuZCxcbiAgICAgICAgY291bnQ6IGcuaW1hZ2VzLmxlbmd0aCxcbiAgICAgICAgZmlsZXM6IGcuaW1hZ2VzLm1hcChpID0+IGkuZmlsZU5hbWUpLFxuICAgICAgICByYXdzOiBnLmltYWdlcy5tYXAoaSA9PiBpLnJhdyksXG4gICAgICB9KSksXG4gICAgfSk7XG5cbiAgICBjb25zdCBidWlsZGVyID0gbmV3IFJhbmdlU2V0QnVpbGRlcjxEZWNvcmF0aW9uPigpO1xuICAgIGxldCBkZWNvcmF0aW9uQWRkZWQgPSBmYWxzZTtcblxuICAgIGZvciAoY29uc3QgZ3JvdXAgb2YgZ3JvdXBzKSB7XG4gICAgICB0cnkge1xuICAgICAgICBpZiAoZ3JvdXAuaW1hZ2VzLmxlbmd0aCA8IDEpIGNvbnRpbnVlO1xuXG4gICAgICAgIGNvbnN0IGxpbmVDb3VudCA9IHN0YXRlLmRvYy5saW5lcztcbiAgICAgICAgY29uc3QgbGluZVN0YXJ0MSA9IGdyb3VwLmxpbmVTdGFydCArIDE7XG4gICAgICAgIGNvbnN0IGxpbmVFbmQxID0gZ3JvdXAubGluZUVuZDsgLy8gMC1pbmRleGVkIGV4Y2x1c2l2ZSA9PSBsYXN0IGxpbmUgaW4gMS1pbmRleGVkXG5cbiAgICAgICAgaWYgKGxpbmVTdGFydDEgPiBsaW5lQ291bnQgfHwgbGluZUVuZDEgPiBsaW5lQ291bnQpIHtcbiAgICAgICAgICBsb2dnZXIuZGVidWcoXCJMaXZlUHJldmlldyBza2lwcGluZyBncm91cCAob3V0IG9mIHJhbmdlKVwiLCB7XG4gICAgICAgICAgICBsaW5lU3RhcnQxLCBsaW5lRW5kMSwgbGluZUNvdW50LFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgZnJvbSA9IHN0YXRlLmRvYy5saW5lKGxpbmVTdGFydDEpLmZyb207XG4gICAgICAgIGNvbnN0IHRvID0gbGluZUVuZDEgPCBsaW5lQ291bnRcbiAgICAgICAgICA/IHN0YXRlLmRvYy5saW5lKGxpbmVFbmQxICsgMSkuZnJvbVxuICAgICAgICAgIDogc3RhdGUuZG9jLmxlbmd0aDtcblxuICAgICAgICBsb2dnZXIuZGVidWcoXCJMaXZlUHJldmlldyBkZWNvcmF0aW9uIHJhbmdlXCIsIHtcbiAgICAgICAgICBncm91cExpbmVTdGFydDogZ3JvdXAubGluZVN0YXJ0LFxuICAgICAgICAgIGdyb3VwTGluZUVuZDogZ3JvdXAubGluZUVuZCxcbiAgICAgICAgICBsaW5lU3RhcnQxLFxuICAgICAgICAgIGxpbmVFbmQxLFxuICAgICAgICAgIGxpbmVDb3VudCxcbiAgICAgICAgICBmcm9tLFxuICAgICAgICAgIHRvLFxuICAgICAgICAgIGRvY0xlbmd0aDogc3RhdGUuZG9jLmxlbmd0aCxcbiAgICAgICAgICBpbWFnZUNvdW50OiBncm91cC5pbWFnZXMubGVuZ3RoLFxuICAgICAgICB9KTtcblxuICAgICAgICBpZiAodG8gPD0gZnJvbSkge1xuICAgICAgICAgIGxvZ2dlci5kZWJ1ZyhcIkxpdmVQcmV2aWV3IHNraXBwaW5nIGdyb3VwICh0byA8PSBmcm9tKVwiLCB7IGZyb20sIHRvIH0pO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgYnVpbGRlci5hZGQoXG4gICAgICAgICAgZnJvbSxcbiAgICAgICAgICB0byxcbiAgICAgICAgICBEZWNvcmF0aW9uLnJlcGxhY2Uoe1xuICAgICAgICAgICAgd2lkZ2V0OiBuZXcgU3RhdGljSW1hZ2VSb3dXaWRnZXQoZ3JvdXAsIG9wdGlvbnMpLFxuICAgICAgICAgICAgYmxvY2s6IHRydWUsXG4gICAgICAgICAgICBpbmNsdXNpdmU6IHRydWUsXG4gICAgICAgICAgfSlcbiAgICAgICAgKTtcbiAgICAgICAgZGVjb3JhdGlvbkFkZGVkID0gdHJ1ZTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgbG9nZ2VyLmVycm9yKFwiTGl2ZVByZXZpZXcgd2lkZ2V0IGNyZWF0aW9uIGVycm9yXCIsIHtcbiAgICAgICAgICBncm91cExpbmVTdGFydDogZ3JvdXAubGluZVN0YXJ0LFxuICAgICAgICAgIGVycm9yOiBTdHJpbmcoZSksXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IHJlc3VsdCA9IGJ1aWxkZXIuZmluaXNoKCk7XG4gICAgbG9nZ2VyLmRlYnVnKFwiTGl2ZVByZXZpZXcgZGVjb3JhdGlvbnMgYnVpbHRcIiwge1xuICAgICAgZGVjb3JhdGlvbkFkZGVkLFxuICAgICAgc2V0U2l6ZTogcmVzdWx0LnNpemUsXG4gICAgfSk7XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGxvZ2dlci5lcnJvcihcIkxpdmVQcmV2aWV3IGJ1aWxkRGVjb3JhdGlvbnMgZXJyb3JcIiwgeyBlcnJvcjogU3RyaW5nKGUpIH0pO1xuICAgIHJldHVybiBEZWNvcmF0aW9uLm5vbmU7XG4gIH1cbn1cblxuLyoqIERpc3BhdGNoIHRoaXMgYW5ub3RhdGlvbiB0byBmb3JjZSBhIGRlY29yYXRpb24gcmVidWlsZCAoZS5nLiBhZnRlciBzZXR0aW5ncyBjaGFuZ2UpLiAqL1xuZXhwb3J0IGNvbnN0IHNldHRpbmdzQ2hhbmdlZCA9IEFubm90YXRpb24uZGVmaW5lPGJvb2xlYW4+KCk7XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVMaXZlUHJldmlld1BsdWdpbihcbiAgZ2V0T3B0aW9uczogKCkgPT4gSW1hZ2VSb3dPcHRpb25zLFxuICBnZXRTZXR0aW5nczogKCkgPT4gRHJhZ0ltYWdlU2V0dGluZ3MsXG4gIGlzRW5hYmxlZDogKCkgPT4gYm9vbGVhblxuKSB7XG4gIC8vIFRyYWNrIExpdmUgUHJldmlldyBzdGF0ZSBzbyB3ZSBjYW4gcmVidWlsZCBkZWNvcmF0aW9ucyBvbiBtb2RlIHN3aXRjaFxuICBsZXQgd2FzTGl2ZVByZXZpZXcgPSBmYWxzZTtcblxuICBjb25zdCBmaWVsZCA9IFN0YXRlRmllbGQuZGVmaW5lPERlY29yYXRpb25TZXQ+KHtcbiAgICBjcmVhdGUoc3RhdGUpIHtcbiAgICAgIHdhc0xpdmVQcmV2aWV3ID0gISFzdGF0ZS5maWVsZChlZGl0b3JMaXZlUHJldmlld0ZpZWxkLCBmYWxzZSk7XG4gICAgICBsb2dnZXIuZGVidWcoXCJMaXZlUHJldmlldyBTdGF0ZUZpZWxkIGNyZWF0ZVwiLCB7IHdhc0xpdmVQcmV2aWV3IH0pO1xuICAgICAgcmV0dXJuIGJ1aWxkRGVjb3JhdGlvbnMoc3RhdGUsIGdldE9wdGlvbnMsIGdldFNldHRpbmdzLCBpc0VuYWJsZWQpO1xuICAgIH0sXG4gICAgdXBkYXRlKF9vbGREZWNvcywgdHIpIHtcbiAgICAgIGNvbnN0IGlzTGl2ZVByZXZpZXcgPSAhIXRyLnN0YXRlLmZpZWxkKGVkaXRvckxpdmVQcmV2aWV3RmllbGQsIGZhbHNlKTtcbiAgICAgIGNvbnN0IGRvY0NoYW5nZWQgPSB0ci5kb2NDaGFuZ2VkO1xuICAgICAgY29uc3Qgc2V0dGluZ3NBbm5vdCA9IHRyLmFubm90YXRpb24oc2V0dGluZ3NDaGFuZ2VkKTtcbiAgICAgIGNvbnN0IGxwQ2hhbmdlZCA9IHdhc0xpdmVQcmV2aWV3ICE9PSBpc0xpdmVQcmV2aWV3O1xuICAgICAgaWYgKGRvY0NoYW5nZWQgfHwgc2V0dGluZ3NBbm5vdCB8fCBscENoYW5nZWQpIHtcbiAgICAgICAgbG9nZ2VyLmRlYnVnKFwiU3RhdGVGaWVsZC51cGRhdGUgXHUyMTkyIGJ1aWxkRGVjb3JhdGlvbnNcIiwge1xuICAgICAgICAgIGRvY0NoYW5nZWQsXG4gICAgICAgICAgc2V0dGluZ3NBbm5vdGF0aW9uOiAhIXNldHRpbmdzQW5ub3QsXG4gICAgICAgICAgbGl2ZVByZXZpZXdDaGFuZ2VkOiBscENoYW5nZWQsXG4gICAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICAgICAgICB9KTtcbiAgICAgICAgd2FzTGl2ZVByZXZpZXcgPSBpc0xpdmVQcmV2aWV3O1xuICAgICAgICByZXR1cm4gYnVpbGREZWNvcmF0aW9ucyh0ci5zdGF0ZSwgZ2V0T3B0aW9ucywgZ2V0U2V0dGluZ3MsIGlzRW5hYmxlZCk7XG4gICAgICB9XG4gICAgICByZXR1cm4gX29sZERlY29zO1xuICAgIH0sXG4gICAgcHJvdmlkZTogKGYpID0+IEVkaXRvclZpZXcuZGVjb3JhdGlvbnMuZnJvbShmKSxcbiAgfSk7XG5cbiAgcmV0dXJuIFByZWMuaGlnaGVzdChmaWVsZCk7XG59XG5cbi8qKlxuICogVmlld1BsdWdpbiB0aGF0IG9yY2hlc3RyYXRlcyBjcm9zcy1yb3cgZHJhZyBvcGVyYXRpb25zIGF0IHRoZSBjYXB0dXJlIHBoYXNlXG4gKiBvbiAuY20tZWRpdG9yIChhYm92ZSAuY20tY29udGVudCBpbiB0aGUgRE9NKS4gVGhpcyBlbnN1cmVzIG91ciBoYW5kbGVycyBmaXJlXG4gKiBiZWZvcmUgT2JzaWRpYW4ncyAuY20tY29udGVudC1sZXZlbCBoYW5kbGVycywgbGV0dGluZyB1cyBpbnRlcmNlcHQgYW5kIGJsb2NrXG4gKiBPYnNpZGlhbiBmcm9tIGR1cGxpY2F0aW5nIHN0YW5kYWxvbmUtaW1hZ2UgZHJvcHMuXG4gKlxuICogU2NlbmFyaW9zIGhhbmRsZWQgaGVyZTpcbiAqICAgMS4gRmxleCByb3cgXHUyMTkyIHN0YW5kYWxvbmUgbGluZSAoZGlhYS1yb3c6IGRhdGEgb24gbm9uLWZsZXgtcm93IHRhcmdldClcbiAqICAgMi4gU3RhbmRhbG9uZSBpbWFnZSBcdTIxOTIgZmxleCByb3cgKG9ic2lkaWFuOi8vb3BlbiBkYXRhIGludGVyY2VwdGVkIGF0IGRyYWdzdGFydFxuICogICAgICB2aWEgY3VzdG9tIE1JTUUsIGhhbmRsZWQgYXQgZHJvcCB0byBwcmV2ZW50IE9ic2lkaWFuIGNvcHkpXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVTdGFuZGFsb25lRHJvcFBsdWdpbihcbiAgZ2V0U2V0dGluZ3M6ICgpID0+IERyYWdJbWFnZVNldHRpbmdzLFxuICBpc0VuYWJsZWQ6ICgpID0+IGJvb2xlYW5cbikge1xuICByZXR1cm4gVmlld1BsdWdpbi5mcm9tQ2xhc3MoXG4gICAgY2xhc3Mge1xuICAgICAgcHJpdmF0ZSB2aWV3OiBFZGl0b3JWaWV3O1xuICAgICAgcHJpdmF0ZSBlZGl0b3JFbDogSFRNTEVsZW1lbnQgfCBudWxsID0gbnVsbDtcbiAgICAgIHByaXZhdGUgb25EcmFnU3RhcnQ6ICgoZTogRHJhZ0V2ZW50KSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICAgICAgcHJpdmF0ZSBvbkRyYWdPdmVyOiAoKGU6IERyYWdFdmVudCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcbiAgICAgIHByaXZhdGUgb25EcmFnTGVhdmU6ICgoZTogRHJhZ0V2ZW50KSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICAgICAgcHJpdmF0ZSBvbkRyYWdFbmQ6ICgoZTogRHJhZ0V2ZW50KSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICAgICAgcHJpdmF0ZSBvbkRyb3A6ICgoZTogRHJhZ0V2ZW50KSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICAgICAgcHJpdmF0ZSBkcmFnb3ZlckxvZ2dlZCA9IGZhbHNlO1xuICAgICAgcHJpdmF0ZSBkcm9wSW5kaWNhdG9yRWw6IEhUTUxFbGVtZW50IHwgbnVsbCA9IG51bGw7XG4gICAgICBwcml2YXRlIGRyb3BTaWRlOiBcImxlZnRcIiB8IFwicmlnaHRcIiB8IG51bGwgPSBudWxsO1xuXG4gICAgICBjb25zdHJ1Y3Rvcih2aWV3OiBFZGl0b3JWaWV3KSB7XG4gICAgICAgIHRoaXMudmlldyA9IHZpZXc7XG4gICAgICAgIHRoaXMuc2V0dXAoKTtcbiAgICAgIH1cblxuICAgICAgdXBkYXRlKF91cGRhdGU6IFZpZXdVcGRhdGUpIHtcbiAgICAgICAgaWYgKCF0aGlzLmVkaXRvckVsKSB0aGlzLnNldHVwKCk7XG4gICAgICB9XG5cbiAgICAgIGRlc3Ryb3koKSB7XG4gICAgICAgIHRoaXMuY2xlYXJEcm9wSW5kaWNhdG9yKCk7XG4gICAgICAgIGlmICh0aGlzLm9uRHJhZ1N0YXJ0KSB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImRyYWdzdGFydFwiLCB0aGlzLm9uRHJhZ1N0YXJ0LCB0cnVlKTtcbiAgICAgICAgaWYgKHRoaXMub25EcmFnT3Zlcikgd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJkcmFnb3ZlclwiLCB0aGlzLm9uRHJhZ092ZXIsIHRydWUpO1xuICAgICAgICBpZiAodGhpcy5vbkRyYWdMZWF2ZSkgd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJkcmFnbGVhdmVcIiwgdGhpcy5vbkRyYWdMZWF2ZSwgdHJ1ZSk7XG4gICAgICAgIGlmICh0aGlzLm9uRHJhZ0VuZCkgd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJkcmFnZW5kXCIsIHRoaXMub25EcmFnRW5kLCB0cnVlKTtcbiAgICAgICAgaWYgKHRoaXMub25Ecm9wKSB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImRyb3BcIiwgdGhpcy5vbkRyb3AsIHRydWUpO1xuICAgICAgfVxuXG4gICAgICBwcml2YXRlIGNsZWFyRHJvcEluZGljYXRvcigpIHtcbiAgICAgICAgaWYgKHRoaXMuZHJvcEluZGljYXRvckVsKSB7XG4gICAgICAgICAgdGhpcy5kcm9wSW5kaWNhdG9yRWwuY2xhc3NMaXN0LnJlbW92ZShcImRpYWEtZHJvcC10YXJnZXQtbGluZVwiLCBcImRpYWEtZHJvcC1sZWZ0XCIsIFwiZGlhYS1kcm9wLXJpZ2h0XCIpO1xuICAgICAgICAgIHRoaXMuZHJvcEluZGljYXRvckVsLnN0eWxlLmJveFNoYWRvdyA9IFwiXCI7XG4gICAgICAgICAgdGhpcy5kcm9wSW5kaWNhdG9yRWwgPSBudWxsO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuZHJvcFNpZGUgPSBudWxsO1xuICAgICAgfVxuXG4gICAgICBwcml2YXRlIGZpbmREcm9wVGFyZ2V0KGNsaWVudFg6IG51bWJlciwgY2xpZW50WTogbnVtYmVyKSB7XG4gICAgICAgIGNvbnN0IHRhcmdldEVsID0gZG9jdW1lbnQuZWxlbWVudEZyb21Qb2ludChjbGllbnRYLCBjbGllbnRZKSBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgICAgIGlmICghdGFyZ2V0RWwgfHwgIXRoaXMudmlldy5kb20uY29udGFpbnModGFyZ2V0RWwpKSByZXR1cm4gbnVsbDtcblxuICAgICAgICAvLyBEZXRlY3QgZmxleCByb3cgd2lkZ2V0cyAob3VyIGN1c3RvbSBET00sIHNwYW5zIG11bHRpcGxlIGxpbmVzKVxuICAgICAgICBjb25zdCBmbGV4Um93ID0gdGFyZ2V0RWwuY2xvc2VzdChcIi5kcmFnLWltZy1yb3dcIikgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICAgICAgICBpZiAoZmxleFJvdykge1xuICAgICAgICAgIGNvbnN0IGxzID0gcGFyc2VJbnQoZmxleFJvdy5kYXRhc2V0LmxpbmVTdGFydCB8fCBcIlwiLCAxMCk7XG4gICAgICAgICAgY29uc3QgbGUgPSBwYXJzZUludChmbGV4Um93LmRhdGFzZXQubGluZUVuZCB8fCBcIlwiLCAxMCk7XG4gICAgICAgICAgaWYgKCFpc05hTihscykgJiYgIWlzTmFOKGxlKSkge1xuICAgICAgICAgICAgY29uc3QgcG9zID0gdGhpcy52aWV3LnBvc0F0RE9NKGZsZXhSb3cpO1xuICAgICAgICAgICAgaWYgKHBvcyA+PSAwKSB7XG4gICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgcG9zLFxuICAgICAgICAgICAgICAgIGxpbmU6IGxzLFxuICAgICAgICAgICAgICAgIGlzSW1hZ2VMaW5lOiBmYWxzZSxcbiAgICAgICAgICAgICAgICBpc0ZsZXhSb3c6IHRydWUgYXMgY29uc3QsXG4gICAgICAgICAgICAgICAgcm93TGluZVN0YXJ0OiBscyxcbiAgICAgICAgICAgICAgICByb3dMaW5lRW5kOiBsZSxcbiAgICAgICAgICAgICAgICBlbGVtZW50OiBmbGV4Um93LFxuICAgICAgICAgICAgICAgIGNtTGluZTogbnVsbCBhcyBIVE1MRWxlbWVudCB8IG51bGwsXG4gICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgZW1iZWQgPSB0YXJnZXRFbC5jbG9zZXN0KFwiLmludGVybmFsLWVtYmVkLmltYWdlLWVtYmVkXCIpIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICAgICAgY29uc3QgY21MaW5lID0gdGFyZ2V0RWwuY2xvc2VzdChcIi5jbS1saW5lXCIpIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICAgICAgY29uc3QgZG9tRWwgPSBjbUxpbmUgfHwgZW1iZWQ7XG4gICAgICAgIGlmICghZG9tRWwpIHJldHVybiBudWxsO1xuXG4gICAgICAgIGNvbnN0IHBvcyA9IHRoaXMudmlldy5wb3NBdERPTShkb21FbCk7XG4gICAgICAgIGlmIChwb3MgPCAwKSByZXR1cm4gbnVsbDtcblxuICAgICAgICBjb25zdCBsaW5lID0gdGhpcy52aWV3LnN0YXRlLmRvYy5saW5lQXQocG9zKS5udW1iZXIgLSAxO1xuXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgcG9zLFxuICAgICAgICAgIGxpbmUsXG4gICAgICAgICAgaXNJbWFnZUxpbmU6ICEhZW1iZWQsXG4gICAgICAgICAgaXNGbGV4Um93OiBmYWxzZSBhcyBjb25zdCxcbiAgICAgICAgICByb3dMaW5lU3RhcnQ6IG51bGwgYXMgbnVtYmVyIHwgbnVsbCxcbiAgICAgICAgICByb3dMaW5lRW5kOiBudWxsIGFzIG51bWJlciB8IG51bGwsXG4gICAgICAgICAgZWxlbWVudDogZG9tRWwsXG4gICAgICAgICAgY21MaW5lOiBjbUxpbmUgfHwgbnVsbCxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgcHJpdmF0ZSBzaG93RHJvcEluZGljYXRvcih0YXJnZXRJbmZvOiBhbnksIGNsaWVudFg/OiBudW1iZXIpIHtcbiAgICAgICAgdGhpcy5jbGVhckRyb3BJbmRpY2F0b3IoKTtcbiAgICAgICAgaWYgKCF0YXJnZXRJbmZvKSByZXR1cm47XG5cbiAgICAgICAgLy8gRmxleCByb3cgdGFyZ2V0OiBoaWdobGlnaHQgdGhlIGVudGlyZSByb3dcbiAgICAgICAgaWYgKHRhcmdldEluZm8uaXNGbGV4Um93KSB7XG4gICAgICAgICAgY29uc3Qgcm93RWwgPSB0YXJnZXRJbmZvLmVsZW1lbnQgYXMgSFRNTEVsZW1lbnQ7XG4gICAgICAgICAgY29uc3QgcmVjdCA9IHJvd0VsLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgICAgICAgIGNvbnN0IG1pZCA9IHJlY3QubGVmdCArIHJlY3Qud2lkdGggLyAyO1xuICAgICAgICAgIGlmIChjbGllbnRYICE9PSB1bmRlZmluZWQgJiYgY2xpZW50WCA8IG1pZCkge1xuICAgICAgICAgICAgcm93RWwuc3R5bGUuYm94U2hhZG93ID0gXCJpbnNldCAzcHggMCAwICM0YTllZmZcIjtcbiAgICAgICAgICAgIHRoaXMuZHJvcFNpZGUgPSBcImxlZnRcIjtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcm93RWwuc3R5bGUuYm94U2hhZG93ID0gXCJpbnNldCAtM3B4IDAgMCAjNGE5ZWZmXCI7XG4gICAgICAgICAgICB0aGlzLmRyb3BTaWRlID0gXCJyaWdodFwiO1xuICAgICAgICAgIH1cbiAgICAgICAgICB0aGlzLmRyb3BJbmRpY2F0b3JFbCA9IHJvd0VsO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFByZWZlciAuY20tbGluZSBmb3IgaW5kaWNhdG9yIHN0eWxpbmdcbiAgICAgICAgY29uc3QgaW5kaWNhdG9yRWwgPSB0YXJnZXRJbmZvLmNtTGluZSB8fCB0YXJnZXRJbmZvLmVsZW1lbnQ7XG4gICAgICAgIGlmICghaW5kaWNhdG9yRWwpIHJldHVybjtcblxuICAgICAgICBpZiAoY2xpZW50WCAhPT0gdW5kZWZpbmVkICYmIHRhcmdldEluZm8uaXNJbWFnZUxpbmUpIHtcbiAgICAgICAgICBjb25zdCByZWN0ID0gaW5kaWNhdG9yRWwuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgICAgICAgY29uc3QgbWlkID0gcmVjdC5sZWZ0ICsgcmVjdC53aWR0aCAvIDI7XG4gICAgICAgICAgaWYgKGNsaWVudFggPCBtaWQpIHtcbiAgICAgICAgICAgIGluZGljYXRvckVsLmNsYXNzTGlzdC5hZGQoXCJkaWFhLWRyb3AtbGVmdFwiKTtcbiAgICAgICAgICAgIHRoaXMuZHJvcFNpZGUgPSBcImxlZnRcIjtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaW5kaWNhdG9yRWwuY2xhc3NMaXN0LmFkZChcImRpYWEtZHJvcC1yaWdodFwiKTtcbiAgICAgICAgICAgIHRoaXMuZHJvcFNpZGUgPSBcInJpZ2h0XCI7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGluZGljYXRvckVsLmNsYXNzTGlzdC5hZGQoXCJkaWFhLWRyb3AtdGFyZ2V0LWxpbmVcIik7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5kcm9wSW5kaWNhdG9yRWwgPSBpbmRpY2F0b3JFbDtcbiAgICAgIH1cblxuICAgICAgcHJpdmF0ZSBzZXR1cCgpIHtcbiAgICAgICAgdGhpcy5lZGl0b3JFbCA9IHRoaXMudmlldy5kb207XG5cbiAgICAgICAgLy8gXHUyNTAwXHUyNTAwIGRyYWdzdGFydDogY2FwdHVyZSBvbiBXSU5ET1cuIFN0b3JlIGV4YWN0IHNvdXJjZSBsaW5lIHZpYSBwb3NBdERPTS5cbiAgICAgICAgdGhpcy5vbkRyYWdTdGFydCA9IChlOiBEcmFnRXZlbnQpID0+IHtcbiAgICAgICAgICBjb25zdCB0YXJnZXQgPSBlLnRhcmdldCBhcyBIVE1MRWxlbWVudDtcbiAgICAgICAgICBjb25zdCBlbWJlZCA9IHRhcmdldD8uY2xvc2VzdD8uKFwiLmludGVybmFsLWVtYmVkLmltYWdlLWVtYmVkXCIpIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICAgICAgICBpZiAoIWVtYmVkKSB7XG4gICAgICAgICAgICAvLyBDaGVjayBpZiB0aGlzIGlzIGEgZmxleCByb3cgaXRlbSBkcmFnIChzaG91bGQgbm90IGJlIGludGVyY2VwdGVkIGhlcmUpXG4gICAgICAgICAgICBjb25zdCBmbGV4SXRlbSA9IHRhcmdldD8uY2xvc2VzdD8uKFwiLmRyYWctaW1nLWl0ZW1cIikgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICAgICAgICAgICAgbG9nZ2VyLmluZm8oXCJTRCBkcmFnc3RhcnQ6IG5vdCBhbiBvYnNpZGlhbiBlbWJlZFwiLCB7XG4gICAgICAgICAgICAgIHRhcmdldFRhZzogdGFyZ2V0Py50YWdOYW1lLFxuICAgICAgICAgICAgICB0YXJnZXRDbGFzczogdGFyZ2V0Py5jbGFzc05hbWU/LnN1YnN0cmluZz8uKDAsIDYwKSB8fCBcIlwiLFxuICAgICAgICAgICAgICBpc0ZsZXhJdGVtOiAhIWZsZXhJdGVtLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgY29uc3Qgcm9vdCA9IGVtYmVkLmdldFJvb3ROb2RlKCk7XG4gICAgICAgICAgY29uc3QgZG9tTm9kZTogRWxlbWVudCA9IHJvb3QgaW5zdGFuY2VvZiBTaGFkb3dSb290ID8gcm9vdC5ob3N0IDogZW1iZWQ7XG5cbiAgICAgICAgICBjb25zdCBwb3MgPSB0aGlzLnZpZXcucG9zQXRET00oZG9tTm9kZSBhcyBOb2RlKTtcbiAgICAgICAgICBpZiAocG9zIDwgMCkge1xuICAgICAgICAgICAgbG9nZ2VyLmluZm8oXCJTRCBkcmFnc3RhcnQ6IHBvc0F0RE9NIGZhaWxlZFwiLCB7XG4gICAgICAgICAgICAgIHRhZzogZG9tTm9kZS50YWdOYW1lLFxuICAgICAgICAgICAgICBzaGFkb3dSb290OiByb290IGluc3RhbmNlb2YgU2hhZG93Um9vdCxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGNvbnN0IGxpbmUgPSB0aGlzLnZpZXcuc3RhdGUuZG9jLmxpbmVBdChwb3MpLm51bWJlciAtIDE7XG4gICAgICAgICAgZS5kYXRhVHJhbnNmZXIhLnNldERhdGEoXCJhcHBsaWNhdGlvbi9kaWFhLXNvdXJjZVwiLCBTdHJpbmcobGluZSkpO1xuXG4gICAgICAgICAgLy8gQ29uZmlndXJhYmxlIG9wYWNpdHkgb24gdGhlIG9yaWdpbmFsIGltYWdlIGR1cmluZyBkcmFnXG4gICAgICAgICAgZW1iZWQuc3R5bGUub3BhY2l0eSA9IFN0cmluZygxIC0gZ2V0U2V0dGluZ3MoKS5kcmFnT3BhY2l0eSAvIDEwMCk7XG4gICAgICAgICAgY29uc3QgcmVzdG9yZU9wYWNpdHkgPSAoKSA9PiB7IGVtYmVkLnN0eWxlLm9wYWNpdHkgPSBcIlwiOyB9O1xuICAgICAgICAgIGVtYmVkLmFkZEV2ZW50TGlzdGVuZXIoXCJkcmFnZW5kXCIsIHJlc3RvcmVPcGFjaXR5LCB7IG9uY2U6IHRydWUgfSk7XG5cbiAgICAgICAgICAvLyBDdXN0b20gZnVsbHktb3BhcXVlIGdob3N0IHRoYXQgZm9sbG93cyBjdXJzb3IgdmlhIGRyYWdvdmVyXG4gICAgICAgICAgY29uc3QgaW1nID0gZW1iZWQucXVlcnlTZWxlY3RvcihcImltZ1wiKSBhcyBIVE1MSW1hZ2VFbGVtZW50IHwgbnVsbDtcbiAgICAgICAgICBpZiAoaW1nICYmIGltZy5uYXR1cmFsV2lkdGggPiAwKSB7XG4gICAgICAgICAgICAvLyBIaWRlIGJyb3dzZXIncyBkZWZhdWx0IHNlbWktdHJhbnNwYXJlbnQgZ2hvc3Qgd2l0aCBhIHRyYW5zcGFyZW50IDF4MSBwaXhlbFxuICAgICAgICAgICAgY29uc3QgcGl4ZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiY2FudmFzXCIpO1xuICAgICAgICAgICAgcGl4ZWwud2lkdGggPSAxO1xuICAgICAgICAgICAgcGl4ZWwuaGVpZ2h0ID0gMTtcbiAgICAgICAgICAgIHBpeGVsLnN0eWxlLmNzc1RleHQgPSBcInBvc2l0aW9uOmZpeGVkO2xlZnQ6MDt0b3A6MDtwb2ludGVyLWV2ZW50czpub25lXCI7XG4gICAgICAgICAgICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKHBpeGVsKTtcbiAgICAgICAgICAgIGUuZGF0YVRyYW5zZmVyIS5zZXREcmFnSW1hZ2UocGl4ZWwsIDAsIDApO1xuICAgICAgICAgICAgc2V0VGltZW91dCgoKSA9PiBwaXhlbC5yZW1vdmUoKSwgMCk7XG5cbiAgICAgICAgICAgIC8vIEN1c3RvbSBmdWxseS1vcGFxdWUgZ2hvc3QsIGluaXRpYWxseSBhdCBjdXJzb3IgKHdpdGggRFBSIGZvciBzaGFycG5lc3MpXG4gICAgICAgICAgICBjb25zdCB3ID0gZ2V0U2V0dGluZ3MoKS5naG9zdEltYWdlV2lkdGg7XG4gICAgICAgICAgICBjb25zdCBoID0gKGltZy5uYXR1cmFsSGVpZ2h0IC8gaW1nLm5hdHVyYWxXaWR0aCkgKiB3O1xuICAgICAgICAgICAgY29uc3QgZHByID0gd2luZG93LmRldmljZVBpeGVsUmF0aW8gfHwgMTtcbiAgICAgICAgICAgIGNvbnN0IGdob3N0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImNhbnZhc1wiKTtcbiAgICAgICAgICAgIGdob3N0LndpZHRoID0gdyAqIGRwcjtcbiAgICAgICAgICAgIGdob3N0LmhlaWdodCA9IGggKiBkcHI7XG4gICAgICAgICAgICBnaG9zdC5zdHlsZS5jc3NUZXh0ID0gYHBvc2l0aW9uOmZpeGVkO2xlZnQ6JHtlLmNsaWVudFh9cHg7dG9wOiR7ZS5jbGllbnRZfXB4O3dpZHRoOiR7d31weDtoZWlnaHQ6JHtofXB4O3BvaW50ZXItZXZlbnRzOm5vbmU7ei1pbmRleDoyMTQ3NDgzNjQ3YDtcbiAgICAgICAgICAgIGNvbnN0IGN0eCA9IGdob3N0LmdldENvbnRleHQoXCIyZFwiKSE7XG4gICAgICAgICAgICBjdHguc2NhbGUoZHByLCBkcHIpO1xuICAgICAgICAgICAgY3R4LmRyYXdJbWFnZShpbWcsIDAsIDAsIHcsIGgpO1xuICAgICAgICAgICAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChnaG9zdCk7XG5cbiAgICAgICAgICAgIGNvbnN0IG9uRHJhZ092ZXIgPSAoZXY6IERyYWdFdmVudCkgPT4ge1xuICAgICAgICAgICAgICBnaG9zdC5zdHlsZS5sZWZ0ID0gZXYuY2xpZW50WCArIFwicHhcIjtcbiAgICAgICAgICAgICAgZ2hvc3Quc3R5bGUudG9wID0gZXYuY2xpZW50WSArIFwicHhcIjtcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICBjb25zdCBvbkRyYWdFbmQgPSAoKSA9PiB7XG4gICAgICAgICAgICAgIGRvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJkcmFnb3ZlclwiLCBvbkRyYWdPdmVyLCB0cnVlKTtcbiAgICAgICAgICAgICAgZ2hvc3QucmVtb3ZlKCk7XG4gICAgICAgICAgICAgIGVtYmVkLnN0eWxlLm9wYWNpdHkgPSBcIlwiO1xuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJkcmFnb3ZlclwiLCBvbkRyYWdPdmVyLCB0cnVlKTtcbiAgICAgICAgICAgIGVtYmVkLmFkZEV2ZW50TGlzdGVuZXIoXCJkcmFnZW5kXCIsIG9uRHJhZ0VuZCwgeyBvbmNlOiB0cnVlIH0pO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGxvZ2dlci5pbmZvKFwiU0QgZHJhZ3N0YXJ0IHN0b3JlZCBzb3VyY2UgbGluZVwiLCB7IGxpbmUsIHRhZzogZG9tTm9kZS50YWdOYW1lIH0pO1xuICAgICAgICB9O1xuXG4gICAgICAgIC8vIFx1MjUwMFx1MjUwMCBkcmFnb3ZlcjogY2FwdHVyZSBvbiBXSU5ET1csIHNob3cgZHJvcCB0YXJnZXQgaW5kaWNhdG9yIFx1MjUwMFx1MjUwMFxuICAgICAgICB0aGlzLm9uRHJhZ092ZXIgPSAoZTogRHJhZ0V2ZW50KSA9PiB7XG4gICAgICAgICAgY29uc3QgaGFzRGlhYVNvdXJjZSA9IGUuZGF0YVRyYW5zZmVyPy50eXBlcy5pbmNsdWRlcyhcImFwcGxpY2F0aW9uL2RpYWEtc291cmNlXCIpO1xuICAgICAgICAgIGNvbnN0IGhhc0RpYWFSb3cgPSBlLmRhdGFUcmFuc2Zlcj8udHlwZXMuaW5jbHVkZXMoXCJhcHBsaWNhdGlvbi9kaWFhLXJvd1wiKTtcblxuICAgICAgICAgIGlmICghaGFzRGlhYVNvdXJjZSAmJiAhaGFzRGlhYVJvdykgcmV0dXJuO1xuXG4gICAgICAgICAgLy8gRm9yIGRpYWEtcm93OiBza2lwIGlmIHRhcmdldCBpcyBpbnNpZGUgYSBmbGV4IHJvdyAod2lkZ2V0IGhhbmRsZXMgaXQpXG4gICAgICAgICAgaWYgKGhhc0RpYWFSb3cpIHtcbiAgICAgICAgICAgIGNvbnN0IHRhcmdldEVsID0gZS50YXJnZXQgYXMgSFRNTEVsZW1lbnQ7XG4gICAgICAgICAgICBpZiAodGFyZ2V0RWw/LmNsb3Nlc3Q/LihcIi5kcmFnLWltZy1yb3dcIikpIHtcbiAgICAgICAgICAgICAgdGhpcy5jbGVhckRyb3BJbmRpY2F0b3IoKTtcbiAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cblxuICAgICAgICAgIGlmICghdGhpcy5kcmFnb3ZlckxvZ2dlZCkge1xuICAgICAgICAgICAgdGhpcy5kcmFnb3ZlckxvZ2dlZCA9IHRydWU7XG4gICAgICAgICAgICBsb2dnZXIuaW5mbyhcIlNEIGRyYWdvdmVyIGZpcnN0XCIsIHsgaGFzRGlhYVNvdXJjZSwgaGFzRGlhYVJvdyB9KTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBVc2UgZWxlbWVudEZyb21Qb2ludCBmb3IgcmVsaWFibGUgZGV0ZWN0aW9uIG9mIGltYWdlIGVtYmVkcyBhbmQgZmxleCByb3dzXG4gICAgICAgICAgY29uc3QgdGFyZ2V0SW5mbyA9IHRoaXMuZmluZERyb3BUYXJnZXQoZS5jbGllbnRYLCBlLmNsaWVudFkpO1xuICAgICAgICAgIGlmICghdGFyZ2V0SW5mbykge1xuICAgICAgICAgICAgdGhpcy5jbGVhckRyb3BJbmRpY2F0b3IoKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgICAgZS5kYXRhVHJhbnNmZXIhLmRyb3BFZmZlY3QgPSBcIm1vdmVcIjtcbiAgICAgICAgICB0aGlzLnNob3dEcm9wSW5kaWNhdG9yKHRhcmdldEluZm8sIGUuY2xpZW50WCk7XG4gICAgICAgIH07XG5cbiAgICAgICAgLy8gXHUyNTAwXHUyNTAwIGRyb3A6IGNhcHR1cmUgb24gV0lORE9XLCBoYW5kbGUgc3RhbmRhbG9uZSBcdTIxOTIgc3RhbmRhbG9uZSBhbmQgZmxleC1yb3cgXHUyMTkyIHN0YW5kYWxvbmUgXHUyNTAwXHUyNTAwXG4gICAgICAgIHRoaXMub25Ecm9wID0gKGU6IERyYWdFdmVudCkgPT4ge1xuICAgICAgICAgIHRoaXMuY2xlYXJEcm9wSW5kaWNhdG9yKCk7XG5cbiAgICAgICAgICBjb25zdCB0ZXh0UGxhaW4gPSBlLmRhdGFUcmFuc2Zlcj8uZ2V0RGF0YShcInRleHQvcGxhaW5cIikgfHwgXCJcIjtcblxuICAgICAgICAgIGxvZ2dlci5pbmZvKFwiU0QgZHJvcCBlbnRlclwiLCB7XG4gICAgICAgICAgICBoYXNEaWFhU291cmNlOiBlLmRhdGFUcmFuc2Zlcj8udHlwZXMuaW5jbHVkZXMoXCJhcHBsaWNhdGlvbi9kaWFhLXNvdXJjZVwiKSxcbiAgICAgICAgICAgIHRleHRQbGFpbjogdGV4dFBsYWluLnN1YnN0cmluZygwLCA2MCksXG4gICAgICAgICAgfSk7XG5cbiAgICAgICAgICBpZiAoIWlzRW5hYmxlZCgpKSByZXR1cm47XG5cbiAgICAgICAgICAvLyBcdTI1MDBcdTI1MDAgRmxleCByb3cgXHUyMTkyIHN0YW5kYWxvbmUgLyBibGFuayBsaW5lIFx1MjUwMFx1MjUwMFxuICAgICAgICAgIGlmICh0ZXh0UGxhaW4uc3RhcnRzV2l0aChcImRpYWEtcm93OlwiKSkge1xuICAgICAgICAgICAgY29uc3Qgcm93TWF0Y2ggPSB0ZXh0UGxhaW4ubWF0Y2goL15kaWFhLXJvdzooXFxkKyk6KFxcZCspJC8pO1xuICAgICAgICAgICAgaWYgKCFyb3dNYXRjaCkgcmV0dXJuO1xuXG4gICAgICAgICAgICAvLyBTa2lwIGlmIHRhcmdldCBpcyBpbnNpZGUgYSBmbGV4IHJvdyAod2lkZ2V0IGhhbmRsZXMgaW50ZXItcm93IG1lcmdlKVxuICAgICAgICAgICAgY29uc3QgdGFyZ2V0RWwgPSBlLnRhcmdldCBhcyBIVE1MRWxlbWVudDtcbiAgICAgICAgICAgIGlmICh0YXJnZXRFbD8uY2xvc2VzdD8uKFwiLmRyYWctaW1nLXJvd1wiKSkgcmV0dXJuO1xuXG4gICAgICAgICAgICBjb25zdCBzcmNMaW5lU3RhcnQgPSBwYXJzZUludChyb3dNYXRjaFsxXSwgMTApO1xuICAgICAgICAgICAgY29uc3Qgc3JjSW5kZXggPSBwYXJzZUludChyb3dNYXRjaFsyXSwgMTApO1xuICAgICAgICAgICAgY29uc3Qgc3JjTGluZSA9IHNyY0xpbmVTdGFydCArIHNyY0luZGV4O1xuXG4gICAgICAgICAgICAvLyBVc2UgZWxlbWVudEZyb21Qb2ludCBmb3IgcmVsaWFibGUgdGFyZ2V0IGRldGVjdGlvblxuICAgICAgICAgICAgY29uc3QgZHJvcFRhcmdldCA9IHRoaXMuZmluZERyb3BUYXJnZXQoZS5jbGllbnRYLCBlLmNsaWVudFkpO1xuICAgICAgICAgICAgaWYgKCFkcm9wVGFyZ2V0IHx8IGRyb3BUYXJnZXQuaXNGbGV4Um93KSByZXR1cm47XG5cbiAgICAgICAgICAgIGxldCB0YXJnZXRMaW5lID0gZHJvcFRhcmdldC5saW5lO1xuXG4gICAgICAgICAgICAvLyBXaGVuIGRyb3BwaW5nIG9uIGFuIGltYWdlIGxpbmUsIGNvbXB1dGUgbGVmdC9yaWdodCBwbGFjZW1lbnRcbiAgICAgICAgICAgIGlmIChkcm9wVGFyZ2V0LmlzSW1hZ2VMaW5lKSB7XG4gICAgICAgICAgICAgIGNvbnN0IHJlY3QgPSBkcm9wVGFyZ2V0LmVsZW1lbnQuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgICAgICAgICAgIGNvbnN0IG1pZCA9IHJlY3QubGVmdCArIHJlY3Qud2lkdGggLyAyO1xuICAgICAgICAgICAgICBpZiAoZS5jbGllbnRYID49IG1pZCkgdGFyZ2V0TGluZSA9IGRyb3BUYXJnZXQubGluZSArIDE7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChzcmNMaW5lID09PSB0YXJnZXRMaW5lKSByZXR1cm47XG5cbiAgICAgICAgICAgIGxvZ2dlci5pbmZvKFwiU0QgZmxleC1yb3cgXHUyMTkyIHN0YW5kYWxvbmU6IG1vdmVMaW5lXCIsIHtcbiAgICAgICAgICAgICAgc3JjTGluZSwgdGFyZ2V0TGluZSwgZHJvcExpbmU6IGRyb3BUYXJnZXQubGluZSwgaXNJbWFnZUxpbmU6IGRyb3BUYXJnZXQuaXNJbWFnZUxpbmUsXG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgICAgICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICAgICAgICAgIG1vdmVMaW5lKHRoaXMudmlldywgc3JjTGluZSwgdGFyZ2V0TGluZSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gXHUyNTAwXHUyNTAwIFN0YW5kYWxvbmUgXHUyMTkyIHN0YW5kYWxvbmUgKHdpdGggbGVmdC9yaWdodCBwbGFjZW1lbnQgb24gaW1hZ2UgbGluZXMpIFx1MjUwMFx1MjUwMFxuICAgICAgICAgIGlmICghZS5kYXRhVHJhbnNmZXI/LnR5cGVzLmluY2x1ZGVzKFwiYXBwbGljYXRpb24vZGlhYS1zb3VyY2VcIikpIHJldHVybjtcblxuICAgICAgICAgIC8vIFNraXAgaWYgdGFyZ2V0IGlzIGluc2lkZSBhIGZsZXggcm93ICh3aWRnZXQgaGFuZGxlcyBtZXJnZSlcbiAgICAgICAgICBpZiAoKGUudGFyZ2V0IGFzIEhUTUxFbGVtZW50KT8uY2xvc2VzdD8uKFwiLmRyYWctaW1nLXJvd1wiKSkgcmV0dXJuO1xuXG4gICAgICAgICAgY29uc3Qgc3JjTGluZSA9IHBhcnNlSW50KGUuZGF0YVRyYW5zZmVyIS5nZXREYXRhKFwiYXBwbGljYXRpb24vZGlhYS1zb3VyY2VcIiksIDEwKTtcbiAgICAgICAgICBpZiAoaXNOYU4oc3JjTGluZSkpIHtcbiAgICAgICAgICAgIGxvZ2dlci5pbmZvKFwiU0QgZHJvcDogY291bGQgbm90IHBhcnNlIHNvdXJjZSBsaW5lIGZyb20gZGlhYS1zb3VyY2VcIik7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gVXNlIGVsZW1lbnRGcm9tUG9pbnQgZm9yIHJlbGlhYmxlIGltYWdlIGVtYmVkIGRldGVjdGlvblxuICAgICAgICAgIGNvbnN0IGRyb3BUYXJnZXQgPSB0aGlzLmZpbmREcm9wVGFyZ2V0KGUuY2xpZW50WCwgZS5jbGllbnRZKTtcbiAgICAgICAgICBsZXQgYmFzZVRhcmdldExpbmU6IG51bWJlcjtcbiAgICAgICAgICBsZXQgdGFyZ2V0TGluZTogbnVtYmVyO1xuICAgICAgICAgIGxldCBzaWRlID0gXCJsZWZ0XCI7XG5cbiAgICAgICAgICBpZiAoZHJvcFRhcmdldCkge1xuICAgICAgICAgICAgYmFzZVRhcmdldExpbmUgPSBkcm9wVGFyZ2V0LmxpbmU7XG4gICAgICAgICAgICBpZiAoZHJvcFRhcmdldC5pc0ltYWdlTGluZSkge1xuICAgICAgICAgICAgICBjb25zdCByZWN0ID0gZHJvcFRhcmdldC5lbGVtZW50LmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgICAgICAgICAgICBjb25zdCBtaWQgPSByZWN0LmxlZnQgKyByZWN0LndpZHRoIC8gMjtcbiAgICAgICAgICAgICAgaWYgKGUuY2xpZW50WCA+PSBtaWQpIHtcbiAgICAgICAgICAgICAgICB0YXJnZXRMaW5lID0gYmFzZVRhcmdldExpbmUgKyAxO1xuICAgICAgICAgICAgICAgIHNpZGUgPSBcInJpZ2h0XCI7XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGFyZ2V0TGluZSA9IGJhc2VUYXJnZXRMaW5lO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICB0YXJnZXRMaW5lID0gYmFzZVRhcmdldExpbmU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNvbnN0IHBvcyA9IHRoaXMudmlldy5wb3NBdENvb3Jkcyh7IHg6IGUuY2xpZW50WCwgeTogZS5jbGllbnRZIH0pO1xuICAgICAgICAgICAgaWYgKHBvcyA9PT0gbnVsbCkgcmV0dXJuO1xuICAgICAgICAgICAgYmFzZVRhcmdldExpbmUgPSB0aGlzLnZpZXcuc3RhdGUuZG9jLmxpbmVBdChwb3MpLm51bWJlciAtIDE7XG4gICAgICAgICAgICB0YXJnZXRMaW5lID0gYmFzZVRhcmdldExpbmU7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKHNyY0xpbmUgPT09IHRhcmdldExpbmUpIHJldHVybjtcblxuICAgICAgICAgIGxvZ2dlci5pbmZvKFwiU0Qgc3RhbmRhbG9uZSBcdTIxOTIgc3RhbmRhbG9uZTogbW92ZUxpbmVcIiwge1xuICAgICAgICAgICAgc3JjTGluZSwgdGFyZ2V0TGluZSwgYmFzZVRhcmdldExpbmUsIHNpZGUsXG4gICAgICAgICAgfSk7XG5cbiAgICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICAgICAgICBtb3ZlTGluZSh0aGlzLnZpZXcsIHNyY0xpbmUsIHRhcmdldExpbmUpO1xuICAgICAgICB9O1xuXG4gICAgICAgIC8vIFx1MjUwMFx1MjUwMCBkcmFnbGVhdmU6IGNsZWFyIGluZGljYXRvciB3aGVuIGxlYXZpbmcgdGhlIGVkaXRvciBcdTI1MDBcdTI1MDBcbiAgICAgICAgdGhpcy5vbkRyYWdMZWF2ZSA9IChlOiBEcmFnRXZlbnQpID0+IHtcbiAgICAgICAgICBpZiAoIWUuZGF0YVRyYW5zZmVyPy50eXBlcy5pbmNsdWRlcyhcImFwcGxpY2F0aW9uL2RpYWEtc291cmNlXCIpICYmXG4gICAgICAgICAgICAgICFlLmRhdGFUcmFuc2Zlcj8udHlwZXMuaW5jbHVkZXMoXCJhcHBsaWNhdGlvbi9kaWFhLXJvd1wiKSkgcmV0dXJuO1xuICAgICAgICAgIGNvbnN0IHJlbGF0ZWRUYXJnZXQgPSBlLnJlbGF0ZWRUYXJnZXQgYXMgTm9kZSB8IG51bGw7XG4gICAgICAgICAgaWYgKCFyZWxhdGVkVGFyZ2V0IHx8ICF0aGlzLnZpZXcuZG9tLmNvbnRhaW5zKHJlbGF0ZWRUYXJnZXQpKSB7XG4gICAgICAgICAgICB0aGlzLmNsZWFyRHJvcEluZGljYXRvcigpO1xuICAgICAgICAgIH1cbiAgICAgICAgfTtcblxuICAgICAgICAvLyBcdTI1MDBcdTI1MDAgZHJhZ2VuZDogY2xlYW51cCBpbiBjYXNlIG9mIGNhbmNlbCAoRXNjYXBlKSBcdTI1MDBcdTI1MDBcbiAgICAgICAgdGhpcy5vbkRyYWdFbmQgPSAoX2U6IERyYWdFdmVudCkgPT4ge1xuICAgICAgICAgIHRoaXMuY2xlYXJEcm9wSW5kaWNhdG9yKCk7XG4gICAgICAgIH07XG5cbiAgICAgICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJkcmFnc3RhcnRcIiwgdGhpcy5vbkRyYWdTdGFydCwgdHJ1ZSk7XG4gICAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwiZHJhZ292ZXJcIiwgdGhpcy5vbkRyYWdPdmVyLCB0cnVlKTtcbiAgICAgICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJkcmFnbGVhdmVcIiwgdGhpcy5vbkRyYWdMZWF2ZSwgdHJ1ZSk7XG4gICAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwiZHJhZ2VuZFwiLCB0aGlzLm9uRHJhZ0VuZCwgdHJ1ZSk7XG4gICAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwiZHJvcFwiLCB0aGlzLm9uRHJvcCwgdHJ1ZSk7XG4gICAgICAgIGxvZ2dlci5pbmZvKFwiU0Qgc2V0dXAgY29tcGxldGU6IGhhbmRsZXJzIG9uIHdpbmRvdyBjYXB0dXJlXCIsIHtcbiAgICAgICAgICBkb21UYWc6IHRoaXMudmlldy5kb20/LnRhZ05hbWUsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgKTtcbn1cbiIsICJpbXBvcnQgeyBidWlsZEltYWdlTGluZVJlIH0gZnJvbSBcIi4vY29uc3RhbnRzXCI7XG5pbXBvcnQgeyBsb2dnZXIgfSBmcm9tIFwiLi9sb2dnZXJcIjtcblxuZXhwb3J0IGludGVyZmFjZSBJbWFnZUVtYmVkIHtcbiAgbGluZTogbnVtYmVyO1xuICByYXc6IHN0cmluZztcbiAgZmlsZU5hbWU6IHN0cmluZztcbiAgZXhwbGljaXRXaWR0aDogbnVtYmVyIHwgbnVsbDtcbiAgLyoqIGZsZXgtZ3JvdyBmcm9tIHx3aWR0aCBpbiBtYXJrZG93biAodHJ1ZSkgdnMgY29tcHV0ZWQgZnJvbSBhc3BlY3QgcmF0aW8gKGZhbHNlKSAqL1xuICBoYXNFeHBsaWNpdFdpZHRoOiBib29sZWFuO1xuICBmbGV4R3JvdzogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEltYWdlR3JvdXAge1xuICBsaW5lU3RhcnQ6IG51bWJlcjtcbiAgbGluZUVuZDogbnVtYmVyO1xuICBpbWFnZXM6IEltYWdlRW1iZWRbXTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBJbWFnZU1ldGEge1xuICBuYXR1cmFsV2lkdGg6IG51bWJlcjtcbiAgbmF0dXJhbEhlaWdodDogbnVtYmVyO1xufVxuXG4vKipcbiAqIFBhcnNlIGEgc2luZ2xlIGltYWdlIGVtYmVkIGxpbmUuXG4gKiBSZXR1cm5zIHBhcnNlZCBpbmZvIG9yIG51bGwgaWYgdGhlIGxpbmUgZG9lc24ndCBtYXRjaC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlSW1hZ2VMaW5lKFxuICBsaW5lOiBzdHJpbmcsXG4gIGxpbmVJbmRleDogbnVtYmVyLFxuICByZTogUmVnRXhwXG4pOiBJbWFnZUVtYmVkIHwgbnVsbCB7XG4gIGNvbnN0IG1hdGNoID0gbGluZS5tYXRjaChyZSk7XG4gIGlmICghbWF0Y2gpIHJldHVybiBudWxsO1xuXG4gIGNvbnN0IGZpbGVOYW1lID0gbWF0Y2hbMV07XG4gIGNvbnN0IHJhd1BhcmFtID0gbWF0Y2hbMl07XG4gIC8vIEV4dHJhY3QgZmlyc3QgbnVtYmVyIGZyb20gcGFyYW0gKGhhbmRsZXMgfHdpZHRoLCB8V3hILCB8d2lkdGh8V3hIKVxuICBjb25zdCBmaXJzdE51bSA9IHJhd1BhcmFtID8gcmF3UGFyYW0ubWF0Y2goL15cXGQrLykgOiBudWxsO1xuICBjb25zdCBleHBsaWNpdFdpZHRoID0gZmlyc3ROdW0gPyBwYXJzZUludChmaXJzdE51bVswXSwgMTApIDogbnVsbDtcblxuICByZXR1cm4ge1xuICAgIGxpbmU6IGxpbmVJbmRleCxcbiAgICByYXc6IGxpbmUsXG4gICAgZmlsZU5hbWUsXG4gICAgZXhwbGljaXRXaWR0aCxcbiAgICBoYXNFeHBsaWNpdFdpZHRoOiBleHBsaWNpdFdpZHRoICE9PSBudWxsLFxuICAgIGZsZXhHcm93OiBleHBsaWNpdFdpZHRoID8gZXhwbGljaXRXaWR0aCAvIDEwMCA6IDEsXG4gIH07XG59XG5cbi8qKlxuICogRGV0ZWN0IGNvbnNlY3V0aXZlIGltYWdlIGVtYmVkIGxpbmVzIGluIG1hcmtkb3duIHRleHQuXG4gKiBSZXR1cm5zIGFuIGFycmF5IG9mIEltYWdlR3JvdXBzIG9yZGVyZWQgYnkgbGluZSBwb3NpdGlvbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRldGVjdEltYWdlR3JvdXBzKFxuICB0ZXh0OiBzdHJpbmcsXG4gIG1heEltYWdlc1BlclJvdzogbnVtYmVyLFxuICBleHRlbnNpb25zOiBzdHJpbmdcbik6IEltYWdlR3JvdXBbXSB7XG4gIGNvbnN0IHJlID0gYnVpbGRJbWFnZUxpbmVSZShleHRlbnNpb25zKTtcbiAgY29uc3QgbGluZXMgPSB0ZXh0LnNwbGl0KFwiXFxuXCIpO1xuICBjb25zdCBncm91cHM6IEltYWdlR3JvdXBbXSA9IFtdO1xuICBsZXQgY3VycmVudEdyb3VwOiBJbWFnZUVtYmVkW10gPSBbXTtcblxuICBsb2dnZXIuZGVidWcoXCJkZXRlY3RJbWFnZUdyb3VwcyBzdGFydFwiLCB7XG4gICAgbGluZUNvdW50OiBsaW5lcy5sZW5ndGgsXG4gICAgbWF4SW1hZ2VzUGVyUm93LFxuICAgIGV4dGVuc2lvbnMsXG4gIH0pO1xuXG4gIGNvbnN0IGZsdXNoR3JvdXAgPSAoKSA9PiB7XG4gICAgaWYgKGN1cnJlbnRHcm91cC5sZW5ndGggPT09IDApIHJldHVybjtcbiAgICAvLyBTcGxpdCBvdmVyc2l6ZWQgZ3JvdXBzXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBjdXJyZW50R3JvdXAubGVuZ3RoOyBpICs9IG1heEltYWdlc1BlclJvdykge1xuICAgICAgY29uc3QgY2h1bmsgPSBjdXJyZW50R3JvdXAuc2xpY2UoaSwgaSArIG1heEltYWdlc1BlclJvdyk7XG4gICAgICBncm91cHMucHVzaCh7XG4gICAgICAgIGxpbmVTdGFydDogY2h1bmtbMF0ubGluZSxcbiAgICAgICAgbGluZUVuZDogY2h1bmtbY2h1bmsubGVuZ3RoIC0gMV0ubGluZSArIDEsXG4gICAgICAgIGltYWdlczogWy4uLmNodW5rXSxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBjdXJyZW50R3JvdXAgPSBbXTtcbiAgfTtcblxuICBmb3IgKGxldCBpID0gMDsgaSA8IGxpbmVzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VJbWFnZUxpbmUobGluZXNbaV0sIGksIHJlKTtcbiAgICBpZiAocGFyc2VkKSB7XG4gICAgICBjdXJyZW50R3JvdXAucHVzaChwYXJzZWQpO1xuICAgIH0gZWxzZSB7XG4gICAgICBmbHVzaEdyb3VwKCk7XG4gICAgfVxuICB9XG4gIGZsdXNoR3JvdXAoKTtcblxuICBsb2dnZXIuZGVidWcoXCJkZXRlY3RJbWFnZUdyb3VwcyByZXN1bHRcIiwge1xuICAgIGdyb3VwQ291bnQ6IGdyb3Vwcy5sZW5ndGgsXG4gICAgZ3JvdXBzOiBncm91cHMubWFwKChnKSA9PiAoe1xuICAgICAgbGluZVN0YXJ0OiBnLmxpbmVTdGFydCxcbiAgICAgIGxpbmVFbmQ6IGcubGluZUVuZCxcbiAgICAgIGltYWdlQ291bnQ6IGcuaW1hZ2VzLmxlbmd0aCxcbiAgICAgIGZpbGVzOiBnLmltYWdlcy5tYXAoKGltZykgPT4gaW1nLmZpbGVOYW1lKSxcbiAgICB9KSksXG4gIH0pO1xuXG4gIHJldHVybiBncm91cHM7XG59XG5cbi8qKlxuICogQ2hlY2sgaWYgYSBzaW5nbGUgbGluZSBpcyBhbiBpbWFnZSBlbWJlZCBsaW5lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNJbWFnZUxpbmUoXG4gIGxpbmU6IHN0cmluZyxcbiAgZXh0ZW5zaW9uczogc3RyaW5nXG4pOiBib29sZWFuIHtcbiAgcmV0dXJuIGJ1aWxkSW1hZ2VMaW5lUmUoZXh0ZW5zaW9ucykudGVzdChsaW5lKTtcbn1cbiIsICJpbXBvcnQgeyBJbWFnZU1ldGEgfSBmcm9tIFwiLi9pbWFnZURldGVjdG9yXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgTGF5b3V0UmVzdWx0IHtcbiAgLyoqIENvbXB1dGVkIHVuaWZvcm0gcm93IGhlaWdodCBpbiBweCAqL1xuICByb3dIZWlnaHQ6IG51bWJlcjtcbiAgLyoqIFJlbmRlcmVkIHdpZHRoIG9mIGVhY2ggaW1hZ2UgaW4gcHggKi9cbiAgaW1hZ2VXaWR0aHM6IG51bWJlcltdO1xuICAvKiogVG90YWwgcm93IHdpZHRoIGNvbnN1bWVkIChpbWFnZXMgKyBnYXBzKSwgaW4gcHggKi9cbiAgdG90YWxXaWR0aDogbnVtYmVyO1xufVxuXG4vKipcbiAqIENhbGN1bGF0ZSB0aGUgdW5pZm9ybSBoZWlnaHQgZm9yIGEgcm93IG9mIGltYWdlcyB0aGF0IGZpbGxzIHRoZSBjb250YWluZXIuXG4gKlxuICogRm9ybXVsYTpcbiAqICAgc3VtKGggKiAod19pIC8gaF9pKSkgKyAobi0xKSAqIGdhcCA9IGNvbnRhaW5lcldpZHRoXG4gKiAgIGggPSAoY29udGFpbmVyV2lkdGggLSAobi0xKSAqIGdhcCkgLyBzdW0od19pIC8gaF9pKVxuICpcbiAqIEVhY2ggaW1hZ2UgYXQgaGVpZ2h0IGggaGFzIHdpZHRoID0gaCAqICh3X2kgLyBoX2kpID0gaCAqIGFzcGVjdFJhdGlvLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY29tcHV0ZVVuaWZvcm1IZWlnaHQoXG4gIG1ldGFzOiBJbWFnZU1ldGFbXSxcbiAgY29udGFpbmVyV2lkdGg6IG51bWJlcixcbiAgZ2FwOiBudW1iZXIsXG4gIG1pbkhlaWdodDogbnVtYmVyLFxuICBtYXhIZWlnaHQ6IG51bWJlclxuKTogTGF5b3V0UmVzdWx0IHtcbiAgY29uc3QgbiA9IG1ldGFzLmxlbmd0aDtcbiAgaWYgKG4gPT09IDApIHtcbiAgICByZXR1cm4geyByb3dIZWlnaHQ6IG1pbkhlaWdodCwgaW1hZ2VXaWR0aHM6IFtdLCB0b3RhbFdpZHRoOiAwIH07XG4gIH1cblxuICAvLyBTdW0gb2YgYXNwZWN0IHJhdGlvcyAod2lkdGggLyBoZWlnaHQpXG4gIGxldCBzdW1Bc3BlY3QgPSAwO1xuICBmb3IgKGNvbnN0IG1ldGEgb2YgbWV0YXMpIHtcbiAgICBpZiAobWV0YS5uYXR1cmFsV2lkdGggPiAwICYmIG1ldGEubmF0dXJhbEhlaWdodCA+IDApIHtcbiAgICAgIHN1bUFzcGVjdCArPSBtZXRhLm5hdHVyYWxXaWR0aCAvIG1ldGEubmF0dXJhbEhlaWdodDtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gRmFsbGJhY2sgZm9yIGltYWdlcyB0aGF0IGhhdmVuJ3QgbG9hZGVkIHlldDogYXNzdW1lIDQ6M1xuICAgICAgc3VtQXNwZWN0ICs9IDQgLyAzO1xuICAgIH1cbiAgfVxuXG4gIC8vIERlZmF1bHQgY29udGFpbmVyIHdpZHRoXG4gIGNvbnN0IGVmZmVjdGl2ZVdpZHRoID0gY29udGFpbmVyV2lkdGggPiAwID8gY29udGFpbmVyV2lkdGggOiA4MDA7XG5cbiAgY29uc3QgdG90YWxHYXAgPSAobiAtIDEpICogZ2FwO1xuICBjb25zdCBoID0gKGVmZmVjdGl2ZVdpZHRoIC0gdG90YWxHYXApIC8gc3VtQXNwZWN0O1xuXG4gIC8vIENsYW1wIGhlaWdodFxuICBjb25zdCByb3dIZWlnaHQgPSBNYXRoLm1heChtaW5IZWlnaHQsIE1hdGgubWluKG1heEhlaWdodCwgTWF0aC5yb3VuZChoKSkpO1xuXG4gIC8vIENhbGN1bGF0ZSBpbmRpdmlkdWFsIHdpZHRocyBhdCB0aGUgZmluYWwgcm93SGVpZ2h0XG4gIGNvbnN0IGltYWdlV2lkdGhzOiBudW1iZXJbXSA9IFtdO1xuICBmb3IgKGNvbnN0IG1ldGEgb2YgbWV0YXMpIHtcbiAgICBpZiAobWV0YS5uYXR1cmFsV2lkdGggPiAwICYmIG1ldGEubmF0dXJhbEhlaWdodCA+IDApIHtcbiAgICAgIGltYWdlV2lkdGhzLnB1c2goXG4gICAgICAgIE1hdGgucm91bmQocm93SGVpZ2h0ICogKG1ldGEubmF0dXJhbFdpZHRoIC8gbWV0YS5uYXR1cmFsSGVpZ2h0KSlcbiAgICAgICk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGltYWdlV2lkdGhzLnB1c2goTWF0aC5yb3VuZChyb3dIZWlnaHQgKiAoNCAvIDMpKSk7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgdG90YWxXaWR0aCA9IGltYWdlV2lkdGhzLnJlZHVjZSgocywgdykgPT4gcyArIHcsIDApICsgdG90YWxHYXA7XG5cbiAgcmV0dXJuIHsgcm93SGVpZ2h0LCBpbWFnZVdpZHRocywgdG90YWxXaWR0aCB9O1xufVxuXG4vKipcbiAqIFJldHVybiBmbGV4LWdyb3cgdmFsdWVzIHByb3BvcnRpb25hbCB0byBuYXR1cmFsIGFzcGVjdCByYXRpb3MuXG4gKiBUaGVzZSBhcmUgdXNlZCBpbiBDU1MgZmxleCBsYXlvdXQgZm9yIHJlc3BvbnNpdmUgcm93cy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbXB1dGVGbGV4R3Jvd3MobWV0YXM6IEltYWdlTWV0YVtdKTogbnVtYmVyW10ge1xuICBpZiAobWV0YXMubGVuZ3RoID09PSAwKSByZXR1cm4gW107XG5cbiAgLy8gQ2FsY3VsYXRlIGFzcGVjdCByYXRpb3NcbiAgY29uc3QgYXNwZWN0cyA9IG1ldGFzLm1hcCgobSkgPT5cbiAgICBtLm5hdHVyYWxXaWR0aCA+IDAgJiYgbS5uYXR1cmFsSGVpZ2h0ID4gMFxuICAgICAgPyBtLm5hdHVyYWxXaWR0aCAvIG0ubmF0dXJhbEhlaWdodFxuICAgICAgOiA0IC8gM1xuICApO1xuXG4gIC8vIE5vcm1hbGl6ZSBzbyB0aGUgc21hbGxlc3QgYXNwZWN0IHJhdGlvIG1hcHMgdG8gZmxleC1ncm93IDFcbiAgY29uc3QgbWluQXNwZWN0ID0gTWF0aC5taW4oLi4uYXNwZWN0cyk7XG4gIHJldHVybiBhc3BlY3RzLm1hcCgoYSkgPT4gTWF0aC5yb3VuZCgoYSAvIG1pbkFzcGVjdCkgKiAxMDApIC8gMTAwKTtcbn1cbiIsICJpbXBvcnQgeyBDTEFTU0VTLCBESVZJREVSX1dJRFRILCBSRVNJWkVfSEFORExFX1NJWkUgfSBmcm9tIFwiLi9jb25zdGFudHNcIjtcbmltcG9ydCB7IEltYWdlR3JvdXAsIEltYWdlRW1iZWQsIEltYWdlTWV0YSB9IGZyb20gXCIuL2ltYWdlRGV0ZWN0b3JcIjtcbmltcG9ydCB7IGNvbXB1dGVGbGV4R3Jvd3MsIGNvbXB1dGVVbmlmb3JtSGVpZ2h0IH0gZnJvbSBcIi4vbGF5b3V0RW5naW5lXCI7XG5pbXBvcnQgeyByZXNvbHZlSW1hZ2VTcmMgfSBmcm9tIFwiLi91dGlsc1wiO1xuaW1wb3J0IHsgbG9nZ2VyIH0gZnJvbSBcIi4vbG9nZ2VyXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgSW1hZ2VSb3dPcHRpb25zIHtcbiAgZGVmYXVsdFJvd0hlaWdodDogbnVtYmVyO1xuICBnYXA6IG51bWJlcjtcbiAgZW5hYmxlRGl2aWRlcnM6IGJvb2xlYW47XG4gIGVuYWJsZVJlc2l6ZTogYm9vbGVhbjtcbiAgc25hcFNlbnNpdGl2aXR5OiBudW1iZXI7XG4gIHRvcEJhclNlbnNpdGl2aXR5OiBudW1iZXI7XG4gIGdob3N0SW1hZ2VXaWR0aDogbnVtYmVyO1xuICBkcmFnT3BhY2l0eTogbnVtYmVyO1xuICBnZXRSZXNvdXJjZVBhdGg6IChmaWxlTmFtZTogc3RyaW5nKSA9PiBzdHJpbmc7XG59XG5cbmV4cG9ydCB0eXBlIFJlb3JkZXJDYWxsYmFjayA9IChmcm9tSW5kZXg6IG51bWJlciwgdG9JbmRleDogbnVtYmVyKSA9PiB2b2lkO1xuZXhwb3J0IHR5cGUgUmVzaXplQ2FsbGJhY2sgPSAoaW1hZ2VJbmRleDogbnVtYmVyLCBuZXdGbGV4R3JvdzogbnVtYmVyKSA9PiB2b2lkO1xuZXhwb3J0IHR5cGUgUmVzaXplRW5kQ2FsbGJhY2sgPSAoaW1hZ2VJbmRleDogbnVtYmVyLCBuZXdGbGV4R3JvdzogbnVtYmVyKSA9PiB2b2lkO1xuZXhwb3J0IHR5cGUgRGl2aWRlckRyYWdDYWxsYmFjayA9IChsZWZ0SW5kZXg6IG51bWJlciwgcmF0aW86IG51bWJlcikgPT4gdm9pZDtcbmV4cG9ydCB0eXBlIFBlcnNpc3RDYWxsYmFjayA9ICgpID0+IHZvaWQ7XG5leHBvcnQgdHlwZSBNZXJnZUV4dGVybmFsQ2FsbGJhY2sgPSAoaW5zZXJ0QXRJbmRleDogbnVtYmVyLCBkYXRhVHJhbnNmZXI6IHN0cmluZykgPT4gdm9pZDtcblxuaW50ZXJmYWNlIEhhbmRsZURlZiB7XG4gIGVsOiBIVE1MRWxlbWVudDtcbiAgcmVsWDogbnVtYmVyOyAvLyAwPWxlZnQsIDAuNT1jZW50ZXIsIDE9cmlnaHQgKHJlbGF0aXZlIHRvIGltYWdlIGNvbnRlbnQgcmVjdClcbiAgcmVsWTogbnVtYmVyOyAvLyAwPXRvcCwgMC41PWNlbnRlciwgMT1ib3R0b20gKHJlbGF0aXZlIHRvIGltYWdlIGNvbnRlbnQgcmVjdClcbn1cblxuLyoqXG4gKiBCdWlsZHMgYW5kIG1hbmFnZXMgdGhlIERPTSBmb3IgYSBmbGV4IHJvdyBvZiBpbWFnZXMuXG4gKi9cbmV4cG9ydCBjbGFzcyBJbWFnZVJvd1dpZGdldCB7XG4gIGNvbnRhaW5lcjogSFRNTEVsZW1lbnQgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBpbWFnZUVsczogSFRNTEltYWdlRWxlbWVudFtdID0gW107XG4gIHByaXZhdGUgaXRlbUVsczogSFRNTEVsZW1lbnRbXSA9IFtdO1xuICBwcml2YXRlIGRpdmlkZXJFbHM6IEhUTUxFbGVtZW50W10gPSBbXTtcbiAgcHJpdmF0ZSByZXNpemVIYW5kbGVzOiBIVE1MRWxlbWVudFtdW10gPSBbXTtcbiAgcHJpdmF0ZSBoYW5kbGVEZWZzOiBIYW5kbGVEZWZbXVtdID0gW107XG4gIHByaXZhdGUgcmVzaXplT2JzZXJ2ZXI6IFJlc2l6ZU9ic2VydmVyIHwgbnVsbCA9IG51bGw7XG5cbiAgcHJpdmF0ZSBncm91cDogSW1hZ2VHcm91cDtcbiAgcHJpdmF0ZSBvcHRpb25zOiBJbWFnZVJvd09wdGlvbnM7XG4gIHByaXZhdGUgcmVvcmRlckNhbGxiYWNrOiBSZW9yZGVyQ2FsbGJhY2sgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSByZXNpemVDYWxsYmFjazogUmVzaXplQ2FsbGJhY2sgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSByZXNpemVFbmRDYWxsYmFjazogUmVzaXplRW5kQ2FsbGJhY2sgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBkaXZpZGVyRHJhZ0NhbGxiYWNrOiBEaXZpZGVyRHJhZ0NhbGxiYWNrIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgcGVyc2lzdENhbGxiYWNrOiBQZXJzaXN0Q2FsbGJhY2sgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBtZXJnZUV4dGVybmFsQ2FsbGJhY2s6IE1lcmdlRXh0ZXJuYWxDYWxsYmFjayB8IG51bGwgPSBudWxsO1xuXG4gIHByaXZhdGUgbG9hZGVkTWV0YXM6IE1hcDxudW1iZXIsIEltYWdlTWV0YT4gPSBuZXcgTWFwKCk7XG4gIHByaXZhdGUgcm93SGVpZ2h0OiBudW1iZXI7XG4gIHByaXZhdGUgZmxleEdyb3dzOiBudW1iZXJbXSA9IFtdO1xuICBvbkxheW91dENoYW5nZTogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG5cbiAgY29uc3RydWN0b3IoZ3JvdXA6IEltYWdlR3JvdXAsIG9wdGlvbnM6IEltYWdlUm93T3B0aW9ucykge1xuICAgIHRoaXMuZ3JvdXAgPSBncm91cDtcbiAgICB0aGlzLm9wdGlvbnMgPSBvcHRpb25zO1xuICAgIHRoaXMucm93SGVpZ2h0ID0gb3B0aW9ucy5kZWZhdWx0Um93SGVpZ2h0O1xuICB9XG5cbiAgb25SZW9yZGVyKGNiOiBSZW9yZGVyQ2FsbGJhY2spOiB2b2lkIHtcbiAgICB0aGlzLnJlb3JkZXJDYWxsYmFjayA9IGNiO1xuICB9XG4gIG9uUmVzaXplKGNiOiBSZXNpemVDYWxsYmFjayk6IHZvaWQge1xuICAgIHRoaXMucmVzaXplQ2FsbGJhY2sgPSBjYjtcbiAgfVxuICBvblJlc2l6ZUVuZChjYjogUmVzaXplRW5kQ2FsbGJhY2spOiB2b2lkIHtcbiAgICB0aGlzLnJlc2l6ZUVuZENhbGxiYWNrID0gY2I7XG4gIH1cbiAgb25EaXZpZGVyRHJhZyhjYjogRGl2aWRlckRyYWdDYWxsYmFjayk6IHZvaWQge1xuICAgIHRoaXMuZGl2aWRlckRyYWdDYWxsYmFjayA9IGNiO1xuICB9XG4gIG9uUGVyc2lzdChjYjogUGVyc2lzdENhbGxiYWNrKTogdm9pZCB7XG4gICAgdGhpcy5wZXJzaXN0Q2FsbGJhY2sgPSBjYjtcbiAgfVxuICBvbk1lcmdlRXh0ZXJuYWwoY2I6IE1lcmdlRXh0ZXJuYWxDYWxsYmFjayk6IHZvaWQge1xuICAgIHRoaXMubWVyZ2VFeHRlcm5hbENhbGxiYWNrID0gY2I7XG4gIH1cbiAgZ2V0Q3VycmVudEZsZXhHcm93cygpOiBudW1iZXJbXSB7XG4gICAgcmV0dXJuIHRoaXMuaXRlbUVscy5tYXAoKGVsKSA9PiBwYXJzZUZsb2F0KGVsLnN0eWxlLmZsZXhHcm93IHx8IFwiMVwiKSk7XG4gIH1cblxuICAvKipcbiAgICogQ3JlYXRlIGFuZCByZXR1cm4gdGhlIHJvb3QgRE9NIGVsZW1lbnQuXG4gICAqL1xuICBidWlsZCgpOiBIVE1MRWxlbWVudCB7XG4gICAgbG9nZ2VyLmRlYnVnKFwiSW1hZ2VSb3dXaWRnZXQgYnVpbGRcIiwge1xuICAgICAgaW1hZ2VDb3VudDogdGhpcy5ncm91cC5pbWFnZXMubGVuZ3RoLFxuICAgICAgZmlsZXM6IHRoaXMuZ3JvdXAuaW1hZ2VzLm1hcCgoaSkgPT4gaS5maWxlTmFtZSksXG4gICAgICBvcHRpb25zOiB7XG4gICAgICAgIGRlZmF1bHRSb3dIZWlnaHQ6IHRoaXMub3B0aW9ucy5kZWZhdWx0Um93SGVpZ2h0LFxuICAgICAgICBnYXA6IHRoaXMub3B0aW9ucy5nYXAsXG4gICAgICAgIGVuYWJsZURpdmlkZXJzOiB0aGlzLm9wdGlvbnMuZW5hYmxlRGl2aWRlcnMsXG4gICAgICAgIGVuYWJsZVJlc2l6ZTogdGhpcy5vcHRpb25zLmVuYWJsZVJlc2l6ZSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICB0aGlzLmNvbnRhaW5lciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgdGhpcy5jb250YWluZXIuY2xhc3NOYW1lID0gQ0xBU1NFUy5yb3c7XG4gICAgdGhpcy5jb250YWluZXIuZGF0YXNldC5saW5lU3RhcnQgPSBTdHJpbmcodGhpcy5ncm91cC5saW5lU3RhcnQpO1xuICAgIHRoaXMuY29udGFpbmVyLmRhdGFzZXQubGluZUVuZCA9IFN0cmluZyh0aGlzLmdyb3VwLmxpbmVFbmQpO1xuICAgIHRoaXMuY29udGFpbmVyLnN0eWxlLmRpc3BsYXkgPSBcImZsZXhcIjtcbiAgICB0aGlzLmNvbnRhaW5lci5zdHlsZS5hbGlnbkl0ZW1zID0gXCJmbGV4LXN0YXJ0XCI7XG4gICAgdGhpcy5jb250YWluZXIuc3R5bGUuZ2FwID0gYCR7dGhpcy5vcHRpb25zLmdhcH1weGA7XG4gICAgdGhpcy5jb250YWluZXIuc3R5bGUud2lkdGggPSBcIjEwMCVcIjtcblxuICAgIC8vIFRvcCBob3ZlciBiYXIgKHZpc3VhbCBpbmRpY2F0b3Igb25seSBcdTIwMTQgcG9pbnRlci1ldmVudHM6IG5vbmUgc28gaXRcbiAgICAvLyBuZXZlciBibG9ja3MgcmVzaXplIGhhbmRsZXMgYXQgdGhlIHRvcCBlZGdlIG9mIGltYWdlcykuXG4gICAgY29uc3QgdG9wQmFyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICB0b3BCYXIuY2xhc3NOYW1lID0gQ0xBU1NFUy50b3BCYXI7XG4gICAgdGhpcy5jb250YWluZXIuYXBwZW5kQ2hpbGQodG9wQmFyKTtcblxuICAgIC8vIERvdWJsZS1jbGljayBvbiBjb250YWluZXIgdG9wIGVkZ2UgXHUyMTkyIGVxdWFsaXplIGFsbCBpbWFnZSBoZWlnaHRzXG4gICAgbGV0IHRvcEJhckRibENsaWNrQXJtZWQgPSBmYWxzZTtcbiAgICB0aGlzLmNvbnRhaW5lci5hZGRFdmVudExpc3RlbmVyKFwiZGJsY2xpY2tcIiwgKGUpID0+IHtcbiAgICAgIGlmICghdG9wQmFyRGJsQ2xpY2tBcm1lZCkgcmV0dXJuO1xuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICAgIHRoaXMuc25hcEFsbFRvRXF1aWxpYnJpdW0oKTtcbiAgICB9KTtcblxuICAgIC8vIFNob3cvaGlkZSB0b3AgYmFyIGJhc2VkIG9uIG1vdXNlIHByb3hpbWl0eSB0byBjb250YWluZXIgdG9wXG4gICAgY29uc3Qgc2Vuc2l0aXZpdHkgPSB0aGlzLm9wdGlvbnMudG9wQmFyU2Vuc2l0aXZpdHk7XG4gICAgdGhpcy5jb250YWluZXIuYWRkRXZlbnRMaXN0ZW5lcihcIm1vdXNlbW92ZVwiLCAoZSkgPT4ge1xuICAgICAgY29uc3QgcmVjdCA9IHRoaXMuY29udGFpbmVyIS5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICAgIGNvbnN0IG9mZnNldFkgPSBlLmNsaWVudFkgLSByZWN0LnRvcDtcbiAgICAgIGlmIChvZmZzZXRZIDw9IHNlbnNpdGl2aXR5KSB7XG4gICAgICAgIHRvcEJhci5zdHlsZS5iYWNrZ3JvdW5kQ29sb3IgPSBcIiM0YTllZmZcIjtcbiAgICAgICAgdG9wQmFyRGJsQ2xpY2tBcm1lZCA9IHRydWU7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0b3BCYXIuc3R5bGUuYmFja2dyb3VuZENvbG9yID0gXCJcIjtcbiAgICAgICAgdG9wQmFyRGJsQ2xpY2tBcm1lZCA9IGZhbHNlO1xuICAgICAgfVxuICAgIH0pO1xuICAgIHRoaXMuY29udGFpbmVyLmFkZEV2ZW50TGlzdGVuZXIoXCJtb3VzZWxlYXZlXCIsICgpID0+IHtcbiAgICAgIHRvcEJhci5zdHlsZS5iYWNrZ3JvdW5kQ29sb3IgPSBcIlwiO1xuICAgICAgdG9wQmFyRGJsQ2xpY2tBcm1lZCA9IGZhbHNlO1xuICAgIH0pO1xuXG4gICAgY29uc3QgaW1hZ2VzID0gdGhpcy5ncm91cC5pbWFnZXM7XG4gICAgdGhpcy5pbWFnZUVscyA9IFtdO1xuICAgIHRoaXMuaXRlbUVscyA9IFtdO1xuICAgIHRoaXMuZGl2aWRlckVscyA9IFtdO1xuICAgIHRoaXMucmVzaXplSGFuZGxlcyA9IFtdO1xuXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBpbWFnZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgIC8vIERpdmlkZXIgYmVmb3JlIGltYWdlIChleGNlcHQgZmlyc3QpXG4gICAgICBpZiAoaSA+IDAgJiYgdGhpcy5vcHRpb25zLmVuYWJsZURpdmlkZXJzKSB7XG4gICAgICAgIGNvbnN0IGRpdmlkZXIgPSB0aGlzLmJ1aWxkRGl2aWRlcihpIC0gMSk7XG4gICAgICAgIHRoaXMuY29udGFpbmVyLmFwcGVuZENoaWxkKGRpdmlkZXIpO1xuICAgICAgICB0aGlzLmRpdmlkZXJFbHMucHVzaChkaXZpZGVyKTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgaXRlbSA9IHRoaXMuYnVpbGRJbWFnZUl0ZW0oaW1hZ2VzW2ldLCBpKTtcbiAgICAgIHRoaXMuY29udGFpbmVyLmFwcGVuZENoaWxkKGl0ZW0pO1xuICAgIH1cblxuICAgIC8vIFJlc2l6ZU9ic2VydmVyOiBhdXRvLXVwZGF0ZSBoYW5kbGUgcG9zaXRpb25zIHdoZW4gQU5ZIGxheW91dCBjaGFuZ2VcbiAgICAvLyBvY2N1cnMgKG91ciByZXNpemUsIE9ic2lkaWFuIG5hdGl2ZSByZXNpemUsIHdpbmRvdyByZXNpemUsIGV0Yy4pXG4gICAgdGhpcy5yZXNpemVPYnNlcnZlciA9IG5ldyBSZXNpemVPYnNlcnZlcigoKSA9PiB7XG4gICAgICB0aGlzLnVwZGF0ZUFsbEhhbmRsZVBvc2l0aW9ucygpO1xuICAgIH0pO1xuICAgIHRoaXMucmVzaXplT2JzZXJ2ZXIub2JzZXJ2ZSh0aGlzLmNvbnRhaW5lcik7XG4gICAgZm9yIChjb25zdCBpdGVtIG9mIHRoaXMuaXRlbUVscykge1xuICAgICAgdGhpcy5yZXNpemVPYnNlcnZlci5vYnNlcnZlKGl0ZW0pO1xuICAgIH1cblxuICAgIC8vIEluaXRpYWwgbGF5b3V0IHBhc3MgXHUyMDE0IHdpbGwgYmUgcmVmaW5lZCBhcyBpbWFnZXMgbG9hZFxuICAgIHRoaXMuYXBwbHlMYXlvdXQoKTtcblxuICAgIHJldHVybiB0aGlzLmNvbnRhaW5lcjtcbiAgfVxuXG4gIHByaXZhdGUgYnVpbGRJbWFnZUl0ZW0oaW1hZ2U6IEltYWdlRW1iZWQsIGluZGV4OiBudW1iZXIpOiBIVE1MRWxlbWVudCB7XG4gICAgY29uc3QgaXRlbSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgaXRlbS5jbGFzc05hbWUgPSBDTEFTU0VTLmltYWdlSXRlbTtcbiAgICBpdGVtLnN0eWxlLmZsZXggPSBgJHtpbWFnZS5mbGV4R3Jvd30gMCAwJWA7XG4gICAgaXRlbS5zdHlsZS5wb3NpdGlvbiA9IFwicmVsYXRpdmVcIjtcbiAgICBpdGVtLnN0eWxlLm1pbldpZHRoID0gXCI1MHB4XCI7XG4gICAgaXRlbS5zdHlsZS5taW5IZWlnaHQgPSBcIjBcIjtcbiAgICBpdGVtLnN0eWxlLmhlaWdodCA9IFwiMTAwJVwiO1xuICAgIGl0ZW0uc3R5bGUudHJhbnNmb3JtID0gXCJ0cmFuc2xhdGVaKDApXCI7XG4gICAgaXRlbS5kYXRhc2V0LmluZGV4ID0gU3RyaW5nKGluZGV4KTtcblxuICAgIGNvbnN0IGltZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJpbWdcIik7XG4gICAgaW1nLmNsYXNzTmFtZSA9IENMQVNTRVMuaW1hZ2VJbm5lcjtcbiAgICBpbWcuc3JjID0gdGhpcy5vcHRpb25zLmdldFJlc291cmNlUGF0aChpbWFnZS5maWxlTmFtZSk7XG4gICAgaW1nLmFsdCA9IGltYWdlLmZpbGVOYW1lO1xuICAgIGltZy5zdHlsZS5kaXNwbGF5ID0gXCJibG9ja1wiO1xuICAgIGltZy5zdHlsZS53aWR0aCA9IFwiMTAwJVwiO1xuICAgIGltZy5zdHlsZS5oZWlnaHQgPSBcIjEwMCVcIjtcbiAgICBpbWcuc3R5bGUub2JqZWN0Rml0ID0gXCJjb250YWluXCI7XG4gICAgaW1nLnN0eWxlLm9iamVjdFBvc2l0aW9uID0gXCJsZWZ0IHRvcFwiO1xuICAgIGltZy5kYXRhc2V0LmluZGV4ID0gU3RyaW5nKGluZGV4KTtcblxuICAgIGltZy5vbmxvYWQgPSAoKSA9PiB7XG4gICAgICB0aGlzLmxvYWRlZE1ldGFzLnNldChpbmRleCwge1xuICAgICAgICBuYXR1cmFsV2lkdGg6IGltZy5uYXR1cmFsV2lkdGgsXG4gICAgICAgIG5hdHVyYWxIZWlnaHQ6IGltZy5uYXR1cmFsSGVpZ2h0LFxuICAgICAgfSk7XG4gICAgICB0aGlzLmFwcGx5TGF5b3V0KCk7XG4gICAgICAvLyBEZWZlciBoYW5kbGUgcG9zaXRpb24gdXBkYXRlIHVudGlsIGFmdGVyIGJyb3dzZXIgcmVmbG93XG4gICAgICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4gdGhpcy51cGRhdGVIYW5kbGVQb3NpdGlvbnMoaW5kZXgpKTtcbiAgICB9O1xuXG4gICAgaW1nLm9uZXJyb3IgPSAoKSA9PiB7XG4gICAgICBsb2dnZXIud2FybihcIkltYWdlIGxvYWQgZmFpbGVkIGluIHdpZGdldFwiLCB7XG4gICAgICAgIGZpbGVOYW1lOiBpbWFnZS5maWxlTmFtZSxcbiAgICAgICAgaW5kZXgsXG4gICAgICAgIHNyYzogaW1nLnNyYyxcbiAgICAgIH0pO1xuICAgICAgdGhpcy5sb2FkZWRNZXRhcy5zZXQoaW5kZXgsIHtcbiAgICAgICAgbmF0dXJhbFdpZHRoOiA0MDAsXG4gICAgICAgIG5hdHVyYWxIZWlnaHQ6IDMwMCxcbiAgICAgIH0pO1xuICAgICAgaW1nLnN0eWxlLmJhY2tncm91bmRDb2xvciA9IFwiI2YwZjBmMFwiO1xuICAgICAgaW1nLmFsdCA9IGBbTm90IGZvdW5kOiAke2ltYWdlLmZpbGVOYW1lfV1gO1xuICAgIH07XG5cbiAgICBpdGVtLmFwcGVuZENoaWxkKGltZyk7XG4gICAgdGhpcy5pbWFnZUVscy5wdXNoKGltZyk7XG4gICAgdGhpcy5pdGVtRWxzLnB1c2goaXRlbSk7XG5cbiAgICAvLyBSZXNpemUgaGFuZGxlc1xuICAgIGlmICh0aGlzLm9wdGlvbnMuZW5hYmxlUmVzaXplKSB7XG4gICAgICBjb25zdCBoYW5kbGVzID0gdGhpcy5idWlsZFJlc2l6ZUhhbmRsZXMoaXRlbSwgaW5kZXgpO1xuICAgICAgdGhpcy5yZXNpemVIYW5kbGVzLnB1c2goaGFuZGxlcyk7XG4gICAgICBpdGVtLm9ubW91c2VlbnRlciA9ICgpID0+IHsgdGhpcy51cGRhdGVIYW5kbGVQb3NpdGlvbnMoaW5kZXgpOyB9O1xuICAgIH1cblxuICAgIHJldHVybiBpdGVtO1xuICB9XG5cbiAgcHJpdmF0ZSBidWlsZERpdmlkZXIobGVmdEluZGV4OiBudW1iZXIpOiBIVE1MRWxlbWVudCB7XG4gICAgY29uc3QgZGl2aWRlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgZGl2aWRlci5jbGFzc05hbWUgPSBDTEFTU0VTLmRpdmlkZXI7XG4gICAgZGl2aWRlci5zdHlsZS5mbGV4ID0gXCIwIDAgYXV0b1wiO1xuICAgIGRpdmlkZXIuc3R5bGUud2lkdGggPSBgJHtESVZJREVSX1dJRFRIfXB4YDtcbiAgICBkaXZpZGVyLnN0eWxlLmN1cnNvciA9IFwiY29sLXJlc2l6ZVwiO1xuICAgIGRpdmlkZXIuc3R5bGUuYWxpZ25TZWxmID0gXCJzdHJldGNoXCI7XG4gICAgZGl2aWRlci5zdHlsZS5iYWNrZ3JvdW5kQ29sb3IgPSBcInRyYW5zcGFyZW50XCI7XG4gICAgZGl2aWRlci5zdHlsZS50cmFuc2l0aW9uID0gXCJiYWNrZ3JvdW5kLWNvbG9yIDAuMTVzXCI7XG4gICAgZGl2aWRlci5kYXRhc2V0LmxlZnRJbmRleCA9IFN0cmluZyhsZWZ0SW5kZXgpO1xuXG4gICAgZGl2aWRlci5vbm1vdXNlZW50ZXIgPSAoKSA9PiB7XG4gICAgICBkaXZpZGVyLnN0eWxlLmJhY2tncm91bmRDb2xvciA9IFwiIzRhOWVmZlwiO1xuICAgIH07XG4gICAgZGl2aWRlci5vbm1vdXNlbGVhdmUgPSAoKSA9PiB7XG4gICAgICBkaXZpZGVyLnN0eWxlLmJhY2tncm91bmRDb2xvciA9IFwidHJhbnNwYXJlbnRcIjtcbiAgICB9O1xuXG4gICAgLy8gRG91YmxlLWNsaWNrIGRpdmlkZXIgXHUyMTkyIHNuYXAgdG8gZXF1YWwgaGVpZ2h0c1xuICAgIGRpdmlkZXIub25kYmxjbGljayA9IChlKSA9PiB7XG4gICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgICAgdGhpcy5zbmFwRGl2aWRlclRvRXF1aWxpYnJpdW0obGVmdEluZGV4KTtcbiAgICB9O1xuXG4gICAgLy8gRGl2aWRlciBkcmFnXG4gICAgbGV0IGRyYWdnaW5nID0gZmFsc2U7XG4gICAgbGV0IHN0YXJ0WCA9IDA7XG4gICAgbGV0IHN0YXJ0TGVmdEZsZXggPSAwO1xuICAgIGxldCBzdGFydFJpZ2h0RmxleCA9IDA7XG4gICAgbGV0IGN1cnJlbnRPbk1vdmU6ICgoZTogTW91c2VFdmVudCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcbiAgICBsZXQgY3VycmVudE9uVXA6ICgoKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuXG4gICAgZGl2aWRlci5vbm1vdXNlZG93biA9IChlKSA9PiB7XG4gICAgICBkcmFnZ2luZyA9IHRydWU7XG4gICAgICBzdGFydFggPSBlLmNsaWVudFg7XG4gICAgICBjb25zdCBsZWZ0SXRlbSA9IHRoaXMuaXRlbUVsc1tsZWZ0SW5kZXhdO1xuICAgICAgY29uc3QgcmlnaHRJdGVtID0gdGhpcy5pdGVtRWxzW2xlZnRJbmRleCArIDFdO1xuICAgICAgc3RhcnRMZWZ0RmxleCA9IHBhcnNlRmxvYXQobGVmdEl0ZW0/LnN0eWxlLmZsZXhHcm93IHx8IFwiMVwiKTtcbiAgICAgIHN0YXJ0UmlnaHRGbGV4ID0gcGFyc2VGbG9hdChyaWdodEl0ZW0/LnN0eWxlLmZsZXhHcm93IHx8IFwiMVwiKTtcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcblxuICAgICAgLy8gS2VlcCBkaXZpZGVyIHZpc2libGUgdGhyb3VnaG91dCB0aGUgZHJhZ1xuICAgICAgZGl2aWRlci5jbGFzc0xpc3QuYWRkKENMQVNTRVMuZGl2aWRlckFjdGl2ZSk7XG5cbiAgICAgIC8vIFJlZ2lzdGVyIGZyZXNoIGxpc3RlbmVycyBmb3IgZWFjaCBkcmFnIHNlc3Npb25cbiAgICAgIGlmIChjdXJyZW50T25Nb3ZlKSBkb2N1bWVudC5yZW1vdmVFdmVudExpc3RlbmVyKFwibW91c2Vtb3ZlXCIsIGN1cnJlbnRPbk1vdmUpO1xuICAgICAgaWYgKGN1cnJlbnRPblVwKSBkb2N1bWVudC5yZW1vdmVFdmVudExpc3RlbmVyKFwibW91c2V1cFwiLCBjdXJyZW50T25VcCk7XG5cbiAgICAgIGN1cnJlbnRPbk1vdmUgPSAoZXY6IE1vdXNlRXZlbnQpID0+IHtcbiAgICAgICAgaWYgKCFkcmFnZ2luZykgcmV0dXJuO1xuICAgICAgICBjb25zdCBkeCA9IGV2LmNsaWVudFggLSBzdGFydFg7XG4gICAgICAgIGlmIChNYXRoLmFicyhkeCkgPCAzKSByZXR1cm47XG5cbiAgICAgICAgY29uc3QgbGVmdEl0ZW0gPSB0aGlzLml0ZW1FbHNbbGVmdEluZGV4XTtcbiAgICAgICAgY29uc3QgcmlnaHRJdGVtID0gdGhpcy5pdGVtRWxzW2xlZnRJbmRleCArIDFdO1xuICAgICAgICBpZiAoIWxlZnRJdGVtIHx8ICFyaWdodEl0ZW0pIHJldHVybjtcblxuICAgICAgICBjb25zdCBzZW5zaXRpdml0eSA9IDAuNTtcbiAgICAgICAgbGV0IG5ld0xlZnQgPSBNYXRoLm1heCgwLjEsIHN0YXJ0TGVmdEZsZXggKyBkeCAqIHNlbnNpdGl2aXR5ICogMC4wMSk7XG4gICAgICAgIGNvbnN0IHRvdGFsID0gc3RhcnRMZWZ0RmxleCArIHN0YXJ0UmlnaHRGbGV4O1xuICAgICAgICBsZXQgbmV3UmlnaHQgPSB0b3RhbCAtIG5ld0xlZnQ7XG5cbiAgICAgICAgLy8gRW5mb3JjZSBtaW5pbXVtIG9uIGJvdGggc2lkZXNcbiAgICAgICAgaWYgKG5ld1JpZ2h0IDwgMC4xKSB7IG5ld1JpZ2h0ID0gMC4xOyBuZXdMZWZ0ID0gdG90YWwgLSAwLjE7IH1cbiAgICAgICAgaWYgKG5ld0xlZnQgPCAwLjEpIHsgbmV3TGVmdCA9IDAuMTsgbmV3UmlnaHQgPSB0b3RhbCAtIDAuMTsgfVxuXG4gICAgICAgIC8vIFNuYXA6IHdoZW4gYWRqYWNlbnQgaW1hZ2UgaGVpZ2h0cyBhcmUgbmVhcmx5IGVxdWFsLCBsb2NrIHRvIGVxdWlsaWJyaXVtLlxuICAgICAgICAvLyBTbmFwIHpvbmUgPSBlcXVpbGlicml1bUhlaWdodCBcdTAwRDcgc25hcFNlbnNpdGl2aXR5JS5cbiAgICAgICAgLy8gQ29uZGl0aW9uIHxsZWZ0SCAtIHJpZ2h0SHwgPCBlcUhlaWdodCBcdTAwRDcgc25hcEZhY3RvciBzaW1wbGlmaWVzIHRvXG4gICAgICAgIC8vICAgfG5ld0xlZnQvbGEgLSBuZXdSaWdodC9yYXwgPCB0b3RhbC8obGErcmEpIFx1MDBENyBzbmFwRmFjdG9yXG4gICAgICAgIGNvbnN0IHNuYXBGYWN0b3IgPSB0aGlzLm9wdGlvbnMuc25hcFNlbnNpdGl2aXR5IC8gMTAwO1xuICAgICAgICBpZiAoc25hcEZhY3RvciA+IDApIHtcbiAgICAgICAgICBjb25zdCBsbSA9IHRoaXMubG9hZGVkTWV0YXMuZ2V0KGxlZnRJbmRleCk7XG4gICAgICAgICAgY29uc3Qgcm0gPSB0aGlzLmxvYWRlZE1ldGFzLmdldChsZWZ0SW5kZXggKyAxKTtcbiAgICAgICAgICBpZiAobG0gJiYgcm0gJiYgbG0ubmF0dXJhbFdpZHRoID4gMCAmJiBybS5uYXR1cmFsV2lkdGggPiAwKSB7XG4gICAgICAgICAgICBjb25zdCBsYSA9IGxtLm5hdHVyYWxXaWR0aCAvIGxtLm5hdHVyYWxIZWlnaHQ7XG4gICAgICAgICAgICBjb25zdCByYSA9IHJtLm5hdHVyYWxXaWR0aCAvIHJtLm5hdHVyYWxIZWlnaHQ7XG4gICAgICAgICAgICBjb25zdCBzbmFwTGVmdCA9IHRvdGFsICogbGEgLyAobGEgKyByYSk7XG4gICAgICAgICAgICBjb25zdCBzbmFwUmlnaHQgPSB0b3RhbCAtIHNuYXBMZWZ0O1xuICAgICAgICAgICAgY29uc3QgaGVpZ2h0RGlmZiA9IE1hdGguYWJzKG5ld0xlZnQgLyBsYSAtIG5ld1JpZ2h0IC8gcmEpO1xuICAgICAgICAgICAgY29uc3Qgc25hcFRocmVzaG9sZCA9IHRvdGFsIC8gKGxhICsgcmEpICogc25hcEZhY3RvcjtcbiAgICAgICAgICAgIGlmIChoZWlnaHREaWZmIDwgc25hcFRocmVzaG9sZCkge1xuICAgICAgICAgICAgICBuZXdMZWZ0ID0gc25hcExlZnQ7XG4gICAgICAgICAgICAgIG5ld1JpZ2h0ID0gc25hcFJpZ2h0O1xuICAgICAgICAgICAgICBkaXZpZGVyLmNsYXNzTGlzdC5hZGQoQ0xBU1NFUy5kaXZpZGVyU25hcCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICBkaXZpZGVyLmNsYXNzTGlzdC5yZW1vdmUoQ0xBU1NFUy5kaXZpZGVyU25hcCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgbGVmdEl0ZW0uc3R5bGUuZmxleEdyb3cgPSBTdHJpbmcobmV3TGVmdCk7XG4gICAgICAgIHJpZ2h0SXRlbS5zdHlsZS5mbGV4R3JvdyA9IFN0cmluZyhuZXdSaWdodCk7XG5cbiAgICAgICAgdGhpcy5yZWNhbGN1bGF0ZVJvd0hlaWdodCgpO1xuXG4gICAgICAgIGlmICh0aGlzLmRpdmlkZXJEcmFnQ2FsbGJhY2spIHtcbiAgICAgICAgICBjb25zdCByYXRpbyA9IG5ld0xlZnQgLyAobmV3TGVmdCArIG5ld1JpZ2h0KTtcbiAgICAgICAgICB0aGlzLmRpdmlkZXJEcmFnQ2FsbGJhY2sobGVmdEluZGV4LCByYXRpbyk7XG4gICAgICAgIH1cbiAgICAgIH07XG5cbiAgICAgIGN1cnJlbnRPblVwID0gKCkgPT4ge1xuICAgICAgICBkcmFnZ2luZyA9IGZhbHNlO1xuICAgICAgICBkaXZpZGVyLmNsYXNzTGlzdC5yZW1vdmUoQ0xBU1NFUy5kaXZpZGVyQWN0aXZlKTtcbiAgICAgICAgZGl2aWRlci5jbGFzc0xpc3QucmVtb3ZlKENMQVNTRVMuZGl2aWRlclNuYXApO1xuICAgICAgICBkb2N1bWVudC5yZW1vdmVFdmVudExpc3RlbmVyKFwibW91c2Vtb3ZlXCIsIGN1cnJlbnRPbk1vdmUhKTtcbiAgICAgICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcihcIm1vdXNldXBcIiwgY3VycmVudE9uVXAhKTtcbiAgICAgICAgY3VycmVudE9uTW92ZSA9IG51bGw7XG4gICAgICAgIGN1cnJlbnRPblVwID0gbnVsbDtcbiAgICAgIH07XG5cbiAgICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJtb3VzZW1vdmVcIiwgY3VycmVudE9uTW92ZSk7XG4gICAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwibW91c2V1cFwiLCBjdXJyZW50T25VcCwgeyBvbmNlOiB0cnVlIH0pO1xuICAgIH07XG5cbiAgICBkaXZpZGVyLl9kZXN0cm95ID0gKCkgPT4ge1xuICAgICAgaWYgKGN1cnJlbnRPbk1vdmUpIGRvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJtb3VzZW1vdmVcIiwgY3VycmVudE9uTW92ZSk7XG4gICAgICBpZiAoY3VycmVudE9uVXApIGRvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJtb3VzZXVwXCIsIGN1cnJlbnRPblVwKTtcbiAgICB9O1xuXG4gICAgcmV0dXJuIGRpdmlkZXI7XG4gIH1cblxuICAvKipcbiAgICogQ29tcHV0ZSB0aGUgYWN0dWFsIHJlbmRlcmVkIGltYWdlIHJlY3Qgd2l0aGluIGEgZmxleCBpdGVtLFxuICAgKiBhY2NvdW50aW5nIGZvciBvYmplY3QtZml0OiBjb250YWluICsgb2JqZWN0LXBvc2l0aW9uOiBsZWZ0IHRvcC5cbiAgICovXG4gIHByaXZhdGUgZ2V0SW1hZ2VDb250ZW50UmVjdChpbmRleDogbnVtYmVyKTogeyBsZWZ0OiBudW1iZXI7IHRvcDogbnVtYmVyOyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlciB9IHwgbnVsbCB7XG4gICAgY29uc3QgaXRlbSA9IHRoaXMuaXRlbUVsc1tpbmRleF07XG4gICAgY29uc3QgaW1nID0gdGhpcy5pbWFnZUVsc1tpbmRleF07XG4gICAgaWYgKCFpdGVtIHx8ICFpbWcpIHJldHVybiBudWxsO1xuXG4gICAgLy8gRm9yY2Ugc3luY2hyb25vdXMgcmVmbG93IHNvIGNsaWVudFdpZHRoL2NsaWVudEhlaWdodCByZWZsZWN0IHRoZVxuICAgIC8vIG1vc3QgcmVjZW50IHN0eWxlIGNoYW5nZXMgKGhlaWdodCB1cGRhdGVzLCBmbGV4LWdyb3cgY2hhbmdlcywgZXRjLikuXG4gICAgdm9pZCBpdGVtLm9mZnNldEhlaWdodDtcblxuICAgIGNvbnN0IGN3ID0gaXRlbS5jbGllbnRXaWR0aDtcbiAgICBjb25zdCBjaCA9IGl0ZW0uY2xpZW50SGVpZ2h0O1xuICAgIGlmIChjdyA9PT0gMCB8fCBjaCA9PT0gMCkgcmV0dXJuIG51bGw7XG5cbiAgICBjb25zdCBtZXRhID0gdGhpcy5sb2FkZWRNZXRhcy5nZXQoaW5kZXgpO1xuICAgIGlmICghbWV0YSB8fCBtZXRhLm5hdHVyYWxXaWR0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG5cbiAgICBjb25zdCBpbWFnZUFzcGVjdCA9IG1ldGEubmF0dXJhbFdpZHRoIC8gbWV0YS5uYXR1cmFsSGVpZ2h0O1xuICAgIGNvbnN0IGNvbnRhaW5lckFzcGVjdCA9IGN3IC8gY2g7XG5cbiAgICBsZXQgZGlzcGxheVc6IG51bWJlcjtcbiAgICBsZXQgZGlzcGxheUg6IG51bWJlcjtcblxuICAgIGlmIChpbWFnZUFzcGVjdCA+IGNvbnRhaW5lckFzcGVjdCkge1xuICAgICAgLy8gSW1hZ2UgaXMgd2lkZXIgXHUyMDE0IGZpbGxzIGZ1bGwgd2lkdGgsIGhlaWdodCBjb25zdHJhaW5lZCBieSBhc3BlY3RcbiAgICAgIGRpc3BsYXlXID0gY3c7XG4gICAgICBkaXNwbGF5SCA9IGN3IC8gaW1hZ2VBc3BlY3Q7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIEltYWdlIGlzIHRhbGxlciBcdTIwMTQgZmlsbHMgZnVsbCBoZWlnaHQsIHdpZHRoIGNvbnN0cmFpbmVkIGJ5IGFzcGVjdFxuICAgICAgZGlzcGxheUggPSBjaDtcbiAgICAgIGRpc3BsYXlXID0gY2ggKiBpbWFnZUFzcGVjdDtcbiAgICB9XG5cbiAgICByZXR1cm4geyBsZWZ0OiAwLCB0b3A6IDAsIHdpZHRoOiBkaXNwbGF5VywgaGVpZ2h0OiBkaXNwbGF5SCB9O1xuICB9XG5cbiAgLyoqIFJlcG9zaXRpb24gcmVzaXplIGhhbmRsZXMgdG8gbWF0Y2ggdGhlIGFjdHVhbCBpbWFnZSBjb250ZW50IHJlY3QuICovXG4gIHByaXZhdGUgdXBkYXRlSGFuZGxlUG9zaXRpb25zKGluZGV4OiBudW1iZXIpOiB2b2lkIHtcbiAgICBjb25zdCByZWN0ID0gdGhpcy5nZXRJbWFnZUNvbnRlbnRSZWN0KGluZGV4KTtcbiAgICBjb25zdCBkZWZzID0gdGhpcy5oYW5kbGVEZWZzW2luZGV4XTtcbiAgICBpZiAoIXJlY3QgfHwgIWRlZnMpIHJldHVybjtcblxuICAgIGNvbnN0IFNaID0gUkVTSVpFX0hBTkRMRV9TSVpFO1xuICAgIGZvciAoY29uc3QgaGQgb2YgZGVmcykge1xuICAgICAgLy8gUG9zaXRpb24gaGFuZGxlcyBzbnVnIElOU0lERSB0aGUgaW1hZ2UgY29udGVudCBlZGdlcy5cbiAgICAgIC8vIHJlbFg9MCBcdTIxOTIgbGVmdCBlZGdlLCByZWxYPTEgXHUyMTkyIHJpZ2h0IGVkZ2UsIHJlbFg9MC41IFx1MjE5MiBob3Jpem9udGFsIGNlbnRlci5cbiAgICAgIGhkLmVsLnN0eWxlLmxlZnQgPSAoaGQucmVsWCAqIChyZWN0LndpZHRoIC0gU1opKSArIFwicHhcIjtcbiAgICAgIGhkLmVsLnN0eWxlLnRvcCA9IChoZC5yZWxZICogKHJlY3QuaGVpZ2h0IC0gU1opKSArIFwicHhcIjtcbiAgICB9XG4gIH1cblxuICAvKiogUmVwb3NpdGlvbiBhbGwgcmVzaXplIGhhbmRsZXMgYWZ0ZXIgYSBsYXlvdXQgY2hhbmdlLiAqL1xuICBwcml2YXRlIHVwZGF0ZUFsbEhhbmRsZVBvc2l0aW9ucygpOiB2b2lkIHtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHRoaXMuaXRlbUVscy5sZW5ndGg7IGkrKykge1xuICAgICAgdGhpcy51cGRhdGVIYW5kbGVQb3NpdGlvbnMoaSk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBidWlsZFJlc2l6ZUhhbmRsZXMoXG4gICAgaXRlbTogSFRNTEVsZW1lbnQsXG4gICAgaW5kZXg6IG51bWJlclxuICApOiBIVE1MRWxlbWVudFtdIHtcbiAgICBjb25zdCBoYW5kbGVzOiBIVE1MRWxlbWVudFtdID0gW107XG5cbiAgICBjb25zdCBkZWZzOiBIYW5kbGVEZWZbXSA9IFtcbiAgICAgIHsgZWw6IG51bGwhLCByZWxYOiAwLCByZWxZOiAwIH0sICAgICAvLyBudyBjb3JuZXJcbiAgICAgIHsgZWw6IG51bGwhLCByZWxYOiAxLCByZWxZOiAwIH0sICAgICAvLyBuZSBjb3JuZXJcbiAgICAgIHsgZWw6IG51bGwhLCByZWxYOiAwLCByZWxZOiAxIH0sICAgICAvLyBzdyBjb3JuZXJcbiAgICAgIHsgZWw6IG51bGwhLCByZWxYOiAxLCByZWxZOiAxIH0sICAgICAvLyBzZSBjb3JuZXJcbiAgICAgIHsgZWw6IG51bGwhLCByZWxYOiAwLjUsIHJlbFk6IDAgfSwgICAvLyBuIGVkZ2UgbWlkcG9pbnRcbiAgICAgIHsgZWw6IG51bGwhLCByZWxYOiAwLjUsIHJlbFk6IDEgfSwgICAvLyBzIGVkZ2UgbWlkcG9pbnRcbiAgICAgIHsgZWw6IG51bGwhLCByZWxYOiAwLCByZWxZOiAwLjUgfSwgICAvLyB3IGVkZ2UgbWlkcG9pbnRcbiAgICAgIHsgZWw6IG51bGwhLCByZWxYOiAxLCByZWxZOiAwLjUgfSwgICAvLyBlIGVkZ2UgbWlkcG9pbnRcbiAgICBdO1xuXG4gICAgY29uc3QgY3Vyc29ycyA9IFtcIm53LXJlc2l6ZVwiLCBcIm5lLXJlc2l6ZVwiLCBcInN3LXJlc2l6ZVwiLCBcInNlLXJlc2l6ZVwiLFxuICAgICAgXCJuLXJlc2l6ZVwiLCBcInMtcmVzaXplXCIsIFwidy1yZXNpemVcIiwgXCJlLXJlc2l6ZVwiXTtcblxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgZGVmcy5sZW5ndGg7IGkrKykge1xuICAgICAgY29uc3QgaGQgPSBkZWZzW2ldO1xuICAgICAgY29uc3QgaGFuZGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIGhhbmRsZS5jbGFzc05hbWUgPSBDTEFTU0VTLnJlc2l6ZUhhbmRsZTtcbiAgICAgIC8vIFVzZSBzZXRQcm9wZXJ0eSB3aXRoIFwiaW1wb3J0YW50XCIgdG8gZGVmZW5kIGFnYWluc3QgT2JzaWRpYW4gQ1NTXG4gICAgICAvLyB0aGF0IG1heSBhcHBseSAhaW1wb3J0YW50IG92ZXJyaWRlcyBpbnNpZGUgLmNtLWVtYmVkLWJsb2NrIGVsZW1lbnRzLlxuICAgICAgY29uc3QgaW1wb3J0YW50ID0gKGs6IHN0cmluZywgdjogc3RyaW5nKSA9PiBoYW5kbGUuc3R5bGUuc2V0UHJvcGVydHkoaywgdiwgXCJpbXBvcnRhbnRcIik7XG4gICAgICBpbXBvcnRhbnQoXCJwb3NpdGlvblwiLCBcImFic29sdXRlXCIpO1xuICAgICAgaW1wb3J0YW50KFwid2lkdGhcIiwgYCR7UkVTSVpFX0hBTkRMRV9TSVpFfXB4YCk7XG4gICAgICBpbXBvcnRhbnQoXCJoZWlnaHRcIiwgYCR7UkVTSVpFX0hBTkRMRV9TSVpFfXB4YCk7XG4gICAgICBpbXBvcnRhbnQoXCJib3JkZXItcmFkaXVzXCIsIFwiMnB4XCIpO1xuICAgICAgaW1wb3J0YW50KFwiYmFja2dyb3VuZC1jb2xvclwiLCBcIiM0YTllZmZcIik7XG4gICAgICBpbXBvcnRhbnQoXCJib3JkZXJcIiwgXCIxcHggc29saWQgd2hpdGVcIik7XG4gICAgICBpbXBvcnRhbnQoXCJ6LWluZGV4XCIsIFwiMlwiKTtcbiAgICAgIGhhbmRsZS5zdHlsZS5jdXJzb3IgPSBjdXJzb3JzW2ldO1xuXG4gICAgICAvLyBSZXNpemUgZHJhZyBcdTIwMTQgZmVlZGZvcndhcmQ6IGNvbXB1dGUgdGFyZ2V0IGZsZXgtZ3JvdyBkaXJlY3RseVxuICAgICAgLy8gZnJvbSBjdXJzb3IgcG9zaXRpb24gc28gdGhlIGhhbmRsZSBmb2xsb3dzIHRoZSBjdXJzb3IgMToxIHdpdGhvdXRcbiAgICAgIC8vIG92ZXJzaG9vdC9vc2NpbGxhdGlvbi5cbiAgICAgIGxldCBkcmFnZ2luZyA9IGZhbHNlO1xuICAgICAgbGV0IGN1cnJlbnRPbk1vdmU6ICgoZTogTW91c2VFdmVudCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcbiAgICAgIGxldCBjdXJyZW50T25VcDogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG5cbiAgICAgIC8vIENhcHR1cmUgbGF5b3V0IHN0YXRlIGF0IG1vdXNlZG93biBmb3Igd2lkdGgtYmFzZWQgZmVlZGZvcndhcmQuXG4gICAgICAvLyBDb252ZXJ0cyBjdXJzb3IgZHggXHUyMTkyIGl0ZW0gd2lkdGggY2hhbmdlIFx1MjE5MiBmbGV4LWdyb3csIHNvIGxlZnQvcmlnaHRcbiAgICAgIC8vIGhhbmRsZXMgc2NhbGUgc3ltbWV0cmljYWxseSBkZXNwaXRlIHRoZSBub25saW5lYXIgZmxleFx1MjE5MndpZHRoIG1hcHBpbmcuXG4gICAgICBsZXQgQVcgPSAwO1xuICAgICAgbGV0IHRvdGFsRyA9IDA7XG4gICAgICBsZXQgc3RhcnRGbGV4ID0gMDtcbiAgICAgIGxldCBzdGFydFdpZHRoID0gMDtcbiAgICAgIGxldCBzY2FsZSA9IDE7XG4gICAgICBsZXQgbkl0ZW1zID0gMDtcblxuICAgICAgaGFuZGxlLm9ubW91c2Vkb3duID0gKGUpID0+IHtcbiAgICAgICAgZHJhZ2dpbmcgPSB0cnVlO1xuICAgICAgICBpdGVtLmNsYXNzTGlzdC5hZGQoQ0xBU1NFUy5yZXNpemluZyk7XG4gICAgICAgIGxvZ2dlci5kZWJ1ZyhcInJlc2l6ZS1tb3VzZWRvd25cIiwgeyBpbmRleCwgdGltZXN0YW1wOiBEYXRlLm5vdygpLCByZWxYOiBoZC5yZWxYLCByZWxZOiBoZC5yZWxZIH0pO1xuICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG5cbiAgICAgICAgLy8gU25hcHNob3QgbGF5b3V0IHN0YXRlXG4gICAgICAgIGNvbnN0IGNvbnRhaW5lclJlY3QgPSB0aGlzLmNvbnRhaW5lciEuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgICAgIG5JdGVtcyA9IHRoaXMuaXRlbUVscy5sZW5ndGg7XG4gICAgICAgIEFXID0gY29udGFpbmVyUmVjdC53aWR0aCAtIChuSXRlbXMgLSAxKSAqIHRoaXMub3B0aW9ucy5nYXA7XG5cbiAgICAgICAgdG90YWxHID0gMDtcbiAgICAgICAgY29uc3QgZ3Jvd3M6IG51bWJlcltdID0gW107XG4gICAgICAgIGZvciAobGV0IGogPSAwOyBqIDwgbkl0ZW1zOyBqKyspIHtcbiAgICAgICAgICBjb25zdCBnID0gcGFyc2VGbG9hdCh0aGlzLml0ZW1FbHNbal0uc3R5bGUuZmxleEdyb3cgfHwgXCIxXCIpO1xuICAgICAgICAgIGdyb3dzLnB1c2goZyk7XG4gICAgICAgICAgdG90YWxHICs9IGc7XG4gICAgICAgIH1cbiAgICAgICAgc3RhcnRGbGV4ID0gZ3Jvd3NbaW5kZXhdO1xuICAgICAgICBzdGFydFdpZHRoID0gKHN0YXJ0RmxleCAvIHRvdGFsRykgKiBBVztcblxuICAgICAgICAvLyBTY2FsZTogaW1hZ2UtY29udGVudCB3aWR0aCB0byBpdGVtLXdpZHRoIHJhdGlvLlxuICAgICAgICAvLyBXaGVuIG9iamVjdC1maXQ6Y29udGFpbiBtYWtlcyB0aGUgaW1hZ2UgbmFycm93ZXIgdGhhbiB0aGUgaXRlbSxcbiAgICAgICAgLy8gYSBjdXJzb3IgZHggbWFwcyB0byBhIGxhcmdlciBpdGVtLXdpZHRoIGNoYW5nZSBzbyB0aGUgaGFuZGxlXG4gICAgICAgIC8vIHZpc3VhbGx5IHRyYWNrcyB0aGUgY3Vyc29yIDE6MS5cbiAgICAgICAgY29uc3QgZGlzcGxheVJlY3QgPSB0aGlzLmdldEltYWdlQ29udGVudFJlY3QoaW5kZXgpO1xuICAgICAgICBjb25zdCBkaXNwbGF5VyA9IGRpc3BsYXlSZWN0ID8gZGlzcGxheVJlY3Qud2lkdGggOiBzdGFydFdpZHRoO1xuICAgICAgICBzY2FsZSA9IGRpc3BsYXlXID4gMCA/IHN0YXJ0V2lkdGggLyBkaXNwbGF5VyA6IDE7XG5cbiAgICAgICAgaWYgKGN1cnJlbnRPbk1vdmUpIGRvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJtb3VzZW1vdmVcIiwgY3VycmVudE9uTW92ZSk7XG4gICAgICAgIGlmIChjdXJyZW50T25VcCkgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcihcIm1vdXNldXBcIiwgY3VycmVudE9uVXApO1xuXG4gICAgICAgIGN1cnJlbnRPbk1vdmUgPSAoZXY6IE1vdXNlRXZlbnQpID0+IHtcbiAgICAgICAgICBpZiAoIWRyYWdnaW5nKSByZXR1cm47XG5cbiAgICAgICAgICAvLyBXaWR0aC1iYXNlZCBmZWVkZm9yd2FyZDogZHggXHUyMTkyIHRhcmdldCB3aWR0aCBcdTIxOTIgZmxleC1ncm93LlxuICAgICAgICAgIC8vIERhbXBlbmVkIGJ5IFNFTlMgdG8gYXZvaWQgaHlwZXJzZW5zaXRpdmUgc2NhbGluZyBvbiB0YWxsIGltYWdlcy5cbiAgICAgICAgICBjb25zdCBTRU5TID0gMC40O1xuICAgICAgICAgIGNvbnN0IHNpZ24gPSBoZC5yZWxYIDwgMC41ID8gLTEgOiAxO1xuICAgICAgICAgIGNvbnN0IGVmZmVjdGl2ZUR4ID0gKGV2LmNsaWVudFggLSBlLmNsaWVudFgpICogc2NhbGUgKiBTRU5TO1xuICAgICAgICAgIGNvbnN0IG90aGVyRyA9IHRvdGFsRyAtIHN0YXJ0RmxleDtcbiAgICAgICAgICBjb25zdCBtaW5XID0gNTA7XG4gICAgICAgICAgY29uc3QgbWF4VyA9IEFXIC0gbWluVyAqIChuSXRlbXMgLSAxKTtcbiAgICAgICAgICBjb25zdCB0YXJnZXRXaWR0aCA9IE1hdGgubWF4KG1pblcsIE1hdGgubWluKG1heFcsIHN0YXJ0V2lkdGggKyBzaWduICogZWZmZWN0aXZlRHgpKTtcbiAgICAgICAgICBsZXQgbmV3RmxleCA9IHRhcmdldFdpZHRoICogb3RoZXJHIC8gKEFXIC0gdGFyZ2V0V2lkdGgpO1xuICAgICAgICAgIG5ld0ZsZXggPSBNYXRoLm1heCgwLjEsIG5ld0ZsZXgpO1xuXG4gICAgICAgICAgLy8gU25hcCB0byBuZWlnaGJvciB3aGVuIGhlaWdodHMgYmVjb21lIGVxdWFsXG4gICAgICAgICAgY29uc3Qgc25hcEZhY3RvciA9IHRoaXMub3B0aW9ucy5zbmFwU2Vuc2l0aXZpdHkgLyAxMDA7XG4gICAgICAgICAgaWYgKHNuYXBGYWN0b3IgPiAwKSB7XG4gICAgICAgICAgICBjb25zdCBjbSA9IHRoaXMubG9hZGVkTWV0YXMuZ2V0KGluZGV4KTtcbiAgICAgICAgICAgIGlmIChjbSAmJiBjbS5uYXR1cmFsV2lkdGggPiAwKSB7XG4gICAgICAgICAgICAgIGNvbnN0IGNhID0gY20ubmF0dXJhbFdpZHRoIC8gY20ubmF0dXJhbEhlaWdodDtcbiAgICAgICAgICAgICAgbGV0IGJlc3RUYXJnZXQ6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICAgICAgICAgICAgICBsZXQgYmVzdFNjb3JlID0gSW5maW5pdHk7XG5cbiAgICAgICAgICAgICAgaWYgKGluZGV4ID4gMCkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGxtID0gdGhpcy5sb2FkZWRNZXRhcy5nZXQoaW5kZXggLSAxKTtcbiAgICAgICAgICAgICAgICBpZiAobG0gJiYgbG0ubmF0dXJhbFdpZHRoID4gMCkge1xuICAgICAgICAgICAgICAgICAgY29uc3QgbGEgPSBsbS5uYXR1cmFsV2lkdGggLyBsbS5uYXR1cmFsSGVpZ2h0O1xuICAgICAgICAgICAgICAgICAgY29uc3QgbGYgPSBwYXJzZUZsb2F0KHRoaXMuaXRlbUVsc1tpbmRleCAtIDFdLnN0eWxlLmZsZXhHcm93IHx8IFwiMVwiKTtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IHRhcmdldCA9IGxmICogY2EgLyBsYTtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IGhlaWdodERpZmYgPSBNYXRoLmFicyhuZXdGbGV4IC8gY2EgLSBsZiAvIGxhKTtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IHNuYXBUaHJlc2hvbGQgPSAobGYgLyBsYSkgKiBzbmFwRmFjdG9yO1xuICAgICAgICAgICAgICAgICAgY29uc3Qgc2NvcmUgPSBzbmFwVGhyZXNob2xkID4gMCA/IGhlaWdodERpZmYgLyBzbmFwVGhyZXNob2xkIDogSW5maW5pdHk7XG4gICAgICAgICAgICAgICAgICBpZiAoc2NvcmUgPCBiZXN0U2NvcmUpIHsgYmVzdFNjb3JlID0gc2NvcmU7IGJlc3RUYXJnZXQgPSB0YXJnZXQ7IH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICBpZiAoaW5kZXggPCB0aGlzLml0ZW1FbHMubGVuZ3RoIC0gMSkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHJtID0gdGhpcy5sb2FkZWRNZXRhcy5nZXQoaW5kZXggKyAxKTtcbiAgICAgICAgICAgICAgICBpZiAocm0gJiYgcm0ubmF0dXJhbFdpZHRoID4gMCkge1xuICAgICAgICAgICAgICAgICAgY29uc3QgcmEgPSBybS5uYXR1cmFsV2lkdGggLyBybS5uYXR1cmFsSGVpZ2h0O1xuICAgICAgICAgICAgICAgICAgY29uc3QgcmYgPSBwYXJzZUZsb2F0KHRoaXMuaXRlbUVsc1tpbmRleCArIDFdLnN0eWxlLmZsZXhHcm93IHx8IFwiMVwiKTtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IHRhcmdldCA9IHJmICogY2EgLyByYTtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IGhlaWdodERpZmYgPSBNYXRoLmFicyhuZXdGbGV4IC8gY2EgLSByZiAvIHJhKTtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IHNuYXBUaHJlc2hvbGQgPSAocmYgLyByYSkgKiBzbmFwRmFjdG9yO1xuICAgICAgICAgICAgICAgICAgY29uc3Qgc2NvcmUgPSBzbmFwVGhyZXNob2xkID4gMCA/IGhlaWdodERpZmYgLyBzbmFwVGhyZXNob2xkIDogSW5maW5pdHk7XG4gICAgICAgICAgICAgICAgICBpZiAoc2NvcmUgPCBiZXN0U2NvcmUpIHsgYmVzdFNjb3JlID0gc2NvcmU7IGJlc3RUYXJnZXQgPSB0YXJnZXQ7IH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICBpZiAoYmVzdFRhcmdldCAhPT0gbnVsbCAmJiBiZXN0U2NvcmUgPCAxKSB7XG4gICAgICAgICAgICAgICAgbmV3RmxleCA9IGJlc3RUYXJnZXQ7XG4gICAgICAgICAgICAgICAgaXRlbS5jbGFzc0xpc3QuYWRkKENMQVNTRVMuaXRlbVNuYXApO1xuICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGl0ZW0uY2xhc3NMaXN0LnJlbW92ZShDTEFTU0VTLml0ZW1TbmFwKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cblxuICAgICAgICAgIGl0ZW0uc3R5bGUuZmxleEdyb3cgPSBTdHJpbmcobmV3RmxleCk7XG4gICAgICAgICAgdGhpcy5yZWNhbGN1bGF0ZVJvd0hlaWdodCgpO1xuICAgICAgICAgIHRoaXMudXBkYXRlSGFuZGxlUG9zaXRpb25zKGluZGV4KTtcbiAgICAgICAgfTtcblxuICAgICAgICBjdXJyZW50T25VcCA9ICgpID0+IHtcbiAgICAgICAgICBkcmFnZ2luZyA9IGZhbHNlO1xuICAgICAgICAgIGl0ZW0uY2xhc3NMaXN0LnJlbW92ZShDTEFTU0VTLnJlc2l6aW5nKTtcbiAgICAgICAgICBpdGVtLmNsYXNzTGlzdC5yZW1vdmUoQ0xBU1NFUy5pdGVtU25hcCk7XG4gICAgICAgICAgY29uc3QgZmluYWxGbGV4ID0gcGFyc2VGbG9hdChpdGVtLnN0eWxlLmZsZXhHcm93IHx8IFwiMVwiKTtcbiAgICAgICAgICBsb2dnZXIuZGVidWcoXCJyZXNpemUtbW91c2V1cFwiLCB7IGluZGV4LCBmaW5hbEZsZXgsIHRpbWVzdGFtcDogRGF0ZS5ub3coKSB9KTtcbiAgICAgICAgICBpZiAodGhpcy5yZXNpemVFbmRDYWxsYmFjaykge1xuICAgICAgICAgICAgdGhpcy5yZXNpemVFbmRDYWxsYmFjayhpbmRleCwgZmluYWxGbGV4KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcihcIm1vdXNlbW92ZVwiLCBjdXJyZW50T25Nb3ZlISk7XG4gICAgICAgICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcihcIm1vdXNldXBcIiwgY3VycmVudE9uVXAhKTtcbiAgICAgICAgICBjdXJyZW50T25Nb3ZlID0gbnVsbDtcbiAgICAgICAgICBjdXJyZW50T25VcCA9IG51bGw7XG4gICAgICAgIH07XG5cbiAgICAgICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcIm1vdXNlbW92ZVwiLCBjdXJyZW50T25Nb3ZlKTtcbiAgICAgICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcIm1vdXNldXBcIiwgY3VycmVudE9uVXAsIHsgb25jZTogdHJ1ZSB9KTtcbiAgICAgIH07XG5cbiAgICAgIGhhbmRsZS5fZGVzdHJveSA9ICgpID0+IHtcbiAgICAgICAgaWYgKGN1cnJlbnRPbk1vdmUpIGRvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJtb3VzZW1vdmVcIiwgY3VycmVudE9uTW92ZSk7XG4gICAgICAgIGlmIChjdXJyZW50T25VcCkgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcihcIm1vdXNldXBcIiwgY3VycmVudE9uVXApO1xuICAgICAgfTtcblxuICAgICAgaXRlbS5hcHBlbmRDaGlsZChoYW5kbGUpO1xuICAgICAgaGQuZWwgPSBoYW5kbGU7XG4gICAgICBoYW5kbGVzLnB1c2goaGFuZGxlKTtcbiAgICB9XG5cbiAgICB0aGlzLmhhbmRsZURlZnMucHVzaChkZWZzKTtcblxuICAgIHJldHVybiBoYW5kbGVzO1xuICB9XG5cbiAgLyoqXG4gICAqIFJlY2FsY3VsYXRlIGxheW91dCBiYXNlZCBvbiBsb2FkZWQgaW1hZ2UgZGltZW5zaW9ucy5cbiAgICovXG4gIHByaXZhdGUgYXBwbHlMYXlvdXQoKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmNvbnRhaW5lciB8fCB0aGlzLmdyb3VwLmltYWdlcy5sZW5ndGggPT09IDApIHJldHVybjtcblxuICAgIGNvbnN0IG1ldGFzOiBJbWFnZU1ldGFbXSA9IFtdO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgdGhpcy5ncm91cC5pbWFnZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IG1ldGEgPSB0aGlzLmxvYWRlZE1ldGFzLmdldChpKTtcbiAgICAgIGlmIChtZXRhKSB7XG4gICAgICAgIG1ldGFzLnB1c2gobWV0YSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBtZXRhcy5wdXNoKHsgbmF0dXJhbFdpZHRoOiAwLCBuYXR1cmFsSGVpZ2h0OiAwIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGFsbExvYWRlZCA9IG1ldGFzLmV2ZXJ5KChtKSA9PiBtLm5hdHVyYWxXaWR0aCA+IDApO1xuXG4gICAgaWYgKGFsbExvYWRlZCkge1xuICAgICAgLy8gV2hlbiBmbGV4LWdyb3dzIHdlcmUgbG9hZGVkIGZyb20gbWFya2Rvd24gfHdpZHRoLCB1c2UgdGhlIGN1cnJlbnRcbiAgICAgIC8vIGRpc3RyaWJ1dGlvbiB0byBjYWxjdWxhdGUgbWF4IGhlaWdodCAoYXZvaWRzIG92ZXJ3cml0aW5nIHVzZXIgYWRqdXN0bWVudHMpLlxuICAgICAgaWYgKHRoaXMuZ3JvdXAuaW1hZ2VzLnNvbWUoKGltZykgPT4gaW1nLmhhc0V4cGxpY2l0V2lkdGgpKSB7XG4gICAgICAgIHRoaXMucmVjYWxjdWxhdGVSb3dIZWlnaHQoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBjb250YWluZXJXaWR0aCA9IHRoaXMuY29udGFpbmVyLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpLndpZHRoO1xuICAgICAgLy8gRWxlbWVudCBub3QgaW4gRE9NIHlldCBcdTIwMTQgcmV0cnkgYWZ0ZXIgbGF5b3V0XG4gICAgICBpZiAoY29udGFpbmVyV2lkdGggPT09IDApIHtcbiAgICAgICAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHRoaXMuYXBwbHlMYXlvdXQoKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlc3VsdCA9IGNvbXB1dGVVbmlmb3JtSGVpZ2h0KFxuICAgICAgICBtZXRhcyxcbiAgICAgICAgY29udGFpbmVyV2lkdGgsXG4gICAgICAgIHRoaXMub3B0aW9ucy5nYXAsXG4gICAgICAgIDUwLFxuICAgICAgICB0aGlzLm9wdGlvbnMuZGVmYXVsdFJvd0hlaWdodCAqIDNcbiAgICAgICk7XG4gICAgICB0aGlzLnJvd0hlaWdodCA9IHJlc3VsdC5yb3dIZWlnaHQ7XG4gICAgICBjb25zdCBoID0gYCR7dGhpcy5yb3dIZWlnaHR9cHhgO1xuICAgICAgdGhpcy5jb250YWluZXIuc3R5bGUuaGVpZ2h0ID0gaDtcblxuICAgICAgY29uc3QgZ3Jvd3MgPSBjb21wdXRlRmxleEdyb3dzKG1ldGFzKTtcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgdGhpcy5pdGVtRWxzLmxlbmd0aCAmJiBpIDwgZ3Jvd3MubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgdGhpcy5pdGVtRWxzW2ldLnN0eWxlLmZsZXhHcm93ID0gU3RyaW5nKGdyb3dzW2ldKTtcbiAgICAgICAgdGhpcy5ncm91cC5pbWFnZXNbaV0uZmxleEdyb3cgPSBncm93c1tpXTtcbiAgICAgIH1cbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgdGhpcy5pdGVtRWxzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIHRoaXMuaXRlbUVsc1tpXS5zdHlsZS5oZWlnaHQgPSBoO1xuICAgICAgfVxuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCB0aGlzLmltYWdlRWxzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIHRoaXMuaW1hZ2VFbHNbaV0uc3R5bGUuaGVpZ2h0ID0gaDtcbiAgICAgIH1cblxuICAgICAgbG9nZ2VyLmRlYnVnKFwiSW1hZ2VSb3dXaWRnZXQgbGF5b3V0IGFwcGxpZWRcIiwge1xuICAgICAgICBjb250YWluZXJXaWR0aCxcbiAgICAgICAgcm93SGVpZ2h0OiByZXN1bHQucm93SGVpZ2h0LFxuICAgICAgICBmbGV4R3Jvd3M6IGdyb3dzLFxuICAgICAgICBpbWFnZUNvdW50OiBtZXRhcy5sZW5ndGgsXG4gICAgICB9KTtcbiAgICAgIHRoaXMub25MYXlvdXRDaGFuZ2U/LigpO1xuICAgICAgLy8gRm9yY2UgcmVmbG93IHNvIGhhbmRsZSBwb3NpdGlvbnMgdXNlIHRoZSBuZXcgZGltZW5zaW9uc1xuICAgICAgdm9pZCB0aGlzLmNvbnRhaW5lci5vZmZzZXRIZWlnaHQ7XG4gICAgICB0aGlzLnVwZGF0ZUFsbEhhbmRsZVBvc2l0aW9ucygpO1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBVc2UgYSBzZW5zaWJsZSBkZWZhdWx0IHVudGlsIGltYWdlcyBsb2FkXG4gICAgICB0aGlzLmNvbnRhaW5lci5zdHlsZS5oZWlnaHQgPSBgJHt0aGlzLm9wdGlvbnMuZGVmYXVsdFJvd0hlaWdodH1weGA7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFJlY2FsY3VsYXRlIHRoZSBmbGV4IGNvbnRhaW5lciBoZWlnaHQgYWZ0ZXIgZGl2aWRlci9yZXNpemUgZHJhZyBzbyB0aGF0XG4gICAqIGFsbCBpbWFnZXMgZGlzcGxheSBmdWxseSB3aXRob3V0IGNsaXBwaW5nLiAgVXNlcyBjdXJyZW50IGZsZXgtZ3JvdyB2YWx1ZXNcbiAgICogYW5kIG5hdHVyYWwgYXNwZWN0IHJhdGlvcyBcdTIwMTQgdGhlIHRhbGxlc3QgaW1hZ2UgZGV0ZXJtaW5lcyB0aGUgcm93IGhlaWdodC5cbiAgICovXG4gIHByaXZhdGUgcmVjYWxjdWxhdGVSb3dIZWlnaHQoKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmNvbnRhaW5lciB8fCB0aGlzLml0ZW1FbHMubGVuZ3RoID09PSAwKSByZXR1cm47XG5cbiAgICBjb25zdCBjb250YWluZXJXaWR0aCA9IHRoaXMuY29udGFpbmVyLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpLndpZHRoO1xuICAgIGlmIChjb250YWluZXJXaWR0aCA9PT0gMCkgcmV0dXJuO1xuXG4gICAgLy8gR3VhcmQ6IGFsbCBpbWFnZXMgbXVzdCBiZSBsb2FkZWQgKHdlIG5lZWQgbmF0dXJhbCBkaW1lbnNpb25zKVxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgdGhpcy5ncm91cC5pbWFnZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IG1ldGEgPSB0aGlzLmxvYWRlZE1ldGFzLmdldChpKTtcbiAgICAgIGlmICghbWV0YSB8fCBtZXRhLm5hdHVyYWxXaWR0aCA9PT0gMCkgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IG4gPSB0aGlzLml0ZW1FbHMubGVuZ3RoO1xuICAgIGNvbnN0IGF2YWlsYWJsZVdpZHRoID0gY29udGFpbmVyV2lkdGggLSAobiAtIDEpICogdGhpcy5vcHRpb25zLmdhcDtcblxuICAgIGxldCB0b3RhbEdyb3cgPSAwO1xuICAgIGNvbnN0IGdyb3dzOiBudW1iZXJbXSA9IFtdO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgbjsgaSsrKSB7XG4gICAgICBjb25zdCBnID0gcGFyc2VGbG9hdCh0aGlzLml0ZW1FbHNbaV0uc3R5bGUuZmxleEdyb3cgfHwgXCIxXCIpO1xuICAgICAgZ3Jvd3MucHVzaChnKTtcbiAgICAgIHRvdGFsR3JvdyArPSBnO1xuICAgIH1cblxuICAgIGxldCBtYXhIZWlnaHQgPSAwO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgbjsgaSsrKSB7XG4gICAgICBjb25zdCBtZXRhID0gdGhpcy5sb2FkZWRNZXRhcy5nZXQoaSkhO1xuICAgICAgY29uc3QgdyA9IChncm93c1tpXSAvIHRvdGFsR3JvdykgKiBhdmFpbGFibGVXaWR0aDtcbiAgICAgIGNvbnN0IGggPSB3IC8gKG1ldGEubmF0dXJhbFdpZHRoIC8gbWV0YS5uYXR1cmFsSGVpZ2h0KTtcbiAgICAgIG1heEhlaWdodCA9IE1hdGgubWF4KG1heEhlaWdodCwgaCk7XG4gICAgfVxuXG4gICAgY29uc3QgY2xhbXBlZCA9IE1hdGgubWF4KFxuICAgICAgNTAsXG4gICAgICBNYXRoLm1pbih0aGlzLm9wdGlvbnMuZGVmYXVsdFJvd0hlaWdodCAqIDMsIE1hdGgucm91bmQobWF4SGVpZ2h0KSlcbiAgICApO1xuICAgIHRoaXMucm93SGVpZ2h0ID0gY2xhbXBlZDtcblxuICAgIGNvbnN0IGggPSBgJHtjbGFtcGVkfXB4YDtcbiAgICB0aGlzLmNvbnRhaW5lci5zdHlsZS5oZWlnaHQgPSBoO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgdGhpcy5pdGVtRWxzLmxlbmd0aDsgaSsrKSB7XG4gICAgICB0aGlzLml0ZW1FbHNbaV0uc3R5bGUuaGVpZ2h0ID0gaDtcbiAgICB9XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCB0aGlzLmltYWdlRWxzLmxlbmd0aDsgaSsrKSB7XG4gICAgICB0aGlzLmltYWdlRWxzW2ldLnN0eWxlLmhlaWdodCA9IGg7XG4gICAgfVxuXG4gICAgdGhpcy5vbkxheW91dENoYW5nZT8uKCk7XG4gICAgLy8gRm9yY2UgcmVmbG93IHNvIGhhbmRsZSBwb3NpdGlvbnMgdXNlIHRoZSBuZXcgZGltZW5zaW9uc1xuICAgIHZvaWQgdGhpcy5jb250YWluZXIub2Zmc2V0SGVpZ2h0O1xuICAgIHRoaXMudXBkYXRlQWxsSGFuZGxlUG9zaXRpb25zKCk7XG4gIH1cblxuICAvKipcbiAgICogRG91YmxlLWNsaWNrIG9uIGRpdmlkZXI6IHNuYXAgdGhlIHR3byBhZGphY2VudCBpbWFnZXMgdG8gZXF1YWwgaGVpZ2h0cy5cbiAgICovXG4gIHByaXZhdGUgc25hcERpdmlkZXJUb0VxdWlsaWJyaXVtKGxlZnRJbmRleDogbnVtYmVyKTogdm9pZCB7XG4gICAgY29uc3QgbG0gPSB0aGlzLmxvYWRlZE1ldGFzLmdldChsZWZ0SW5kZXgpO1xuICAgIGNvbnN0IHJtID0gdGhpcy5sb2FkZWRNZXRhcy5nZXQobGVmdEluZGV4ICsgMSk7XG4gICAgaWYgKCFsbSB8fCAhcm0gfHwgbG0ubmF0dXJhbFdpZHRoID09PSAwIHx8IHJtLm5hdHVyYWxXaWR0aCA9PT0gMCkgcmV0dXJuO1xuXG4gICAgY29uc3QgbGEgPSBsbS5uYXR1cmFsV2lkdGggLyBsbS5uYXR1cmFsSGVpZ2h0O1xuICAgIGNvbnN0IHJhID0gcm0ubmF0dXJhbFdpZHRoIC8gcm0ubmF0dXJhbEhlaWdodDtcblxuICAgIGNvbnN0IGxlZnRJdGVtID0gdGhpcy5pdGVtRWxzW2xlZnRJbmRleF07XG4gICAgY29uc3QgcmlnaHRJdGVtID0gdGhpcy5pdGVtRWxzW2xlZnRJbmRleCArIDFdO1xuICAgIGlmICghbGVmdEl0ZW0gfHwgIXJpZ2h0SXRlbSkgcmV0dXJuO1xuXG4gICAgY29uc3QgdG90YWwgPSBwYXJzZUZsb2F0KGxlZnRJdGVtLnN0eWxlLmZsZXhHcm93IHx8IFwiMVwiKSArIHBhcnNlRmxvYXQocmlnaHRJdGVtLnN0eWxlLmZsZXhHcm93IHx8IFwiMVwiKTtcbiAgICBjb25zdCBzbmFwTGVmdCA9IHRvdGFsICogbGEgLyAobGEgKyByYSk7XG4gICAgY29uc3Qgc25hcFJpZ2h0ID0gdG90YWwgLSBzbmFwTGVmdDtcblxuICAgIGxlZnRJdGVtLnN0eWxlLmZsZXhHcm93ID0gU3RyaW5nKHNuYXBMZWZ0KTtcbiAgICByaWdodEl0ZW0uc3R5bGUuZmxleEdyb3cgPSBTdHJpbmcoc25hcFJpZ2h0KTtcblxuICAgIHRoaXMucmVjYWxjdWxhdGVSb3dIZWlnaHQoKTtcblxuICAgIGxvZ2dlci5pbmZvKFwiRGl2aWRlciBkYmxjbGljayBzbmFwIHRvIGVxdWlsaWJyaXVtXCIsIHtcbiAgICAgIGxlZnRJbmRleCxcbiAgICAgIHRvdGFsLFxuICAgICAgc25hcExlZnQsXG4gICAgICBzbmFwUmlnaHQsXG4gICAgICBsYSxcbiAgICAgIHJhLFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIERvdWJsZS1jbGljayB0b3AgYmFyOiBzbmFwIEFMTCBpbWFnZXMgaW4gdGhlIHJvdyB0byBlcXVhbCBoZWlnaHRzLlxuICAgKiBEaXN0cmlidXRlcyBmbGV4LWdyb3cgcHJvcG9ydGlvbmFsbHkgdG8gYXNwZWN0IHJhdGlvcyBzbyBldmVyeSBpbWFnZVxuICAgKiBoYXMgdGhlIHNhbWUgcmVuZGVyZWQgaGVpZ2h0LlxuICAgKi9cbiAgcHJpdmF0ZSBzbmFwQWxsVG9FcXVpbGlicml1bSgpOiB2b2lkIHtcbiAgICBjb25zdCBuID0gdGhpcy5pdGVtRWxzLmxlbmd0aDtcbiAgICBpZiAobiA8IDIpIHJldHVybjtcblxuICAgIC8vIEdhdGhlciBhc3BlY3QgcmF0aW9zOyBhbGwgaW1hZ2VzIG11c3QgYmUgbG9hZGVkXG4gICAgY29uc3QgYXNwZWN0czogbnVtYmVyW10gPSBbXTtcbiAgICBsZXQgdG90YWxHcm93ID0gMDtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IG47IGkrKykge1xuICAgICAgY29uc3QgbWV0YSA9IHRoaXMubG9hZGVkTWV0YXMuZ2V0KGkpO1xuICAgICAgaWYgKCFtZXRhIHx8IG1ldGEubmF0dXJhbFdpZHRoID09PSAwKSByZXR1cm47XG4gICAgICBhc3BlY3RzLnB1c2gobWV0YS5uYXR1cmFsV2lkdGggLyBtZXRhLm5hdHVyYWxIZWlnaHQpO1xuICAgICAgdG90YWxHcm93ICs9IHBhcnNlRmxvYXQodGhpcy5pdGVtRWxzW2ldLnN0eWxlLmZsZXhHcm93IHx8IFwiMVwiKTtcbiAgICB9XG5cbiAgICBjb25zdCBhc3BlY3RTdW0gPSBhc3BlY3RzLnJlZHVjZSgocywgYSkgPT4gcyArIGEsIDApO1xuICAgIGNvbnN0IGdyb3dzOiBudW1iZXJbXSA9IGFzcGVjdHMubWFwKChhKSA9PiAodG90YWxHcm93ICogYSkgLyBhc3BlY3RTdW0pO1xuXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBuOyBpKyspIHtcbiAgICAgIHRoaXMuaXRlbUVsc1tpXS5zdHlsZS5mbGV4R3JvdyA9IFN0cmluZyhncm93c1tpXSk7XG4gICAgfVxuXG4gICAgdGhpcy5yZWNhbGN1bGF0ZVJvd0hlaWdodCgpO1xuXG4gICAgbG9nZ2VyLmluZm8oXCJUb3AgYmFyIGRibGNsaWNrIGdsb2JhbCBzbmFwXCIsIHsgdG90YWxHcm93LCBhc3BlY3RTdW0sIGdyb3dzIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIFVwZGF0ZSB0aGUgZmxleC1ncm93IHZhbHVlcyBmcm9tIGFuIGV4dGVybmFsIHNvdXJjZSAoZS5nLiwgYWZ0ZXIgcmVvcmRlcikuXG4gICAqL1xuICB1cGRhdGVGbGV4R3Jvd3MoZ3Jvd3M6IG51bWJlcltdKTogdm9pZCB7XG4gICAgdGhpcy5mbGV4R3Jvd3MgPSBncm93cztcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHRoaXMuaXRlbUVscy5sZW5ndGggJiYgaSA8IGdyb3dzLmxlbmd0aDsgaSsrKSB7XG4gICAgICB0aGlzLml0ZW1FbHNbaV0uc3R5bGUuZmxleEdyb3cgPSBTdHJpbmcoZ3Jvd3NbaV0pO1xuICAgIH1cbiAgICB0aGlzLnJlY2FsY3VsYXRlUm93SGVpZ2h0KCk7XG4gIH1cblxuICAvKipcbiAgICogQ2FsbCB3aGVuIHRoZSBjb250YWluZXIgd2lkdGggY2hhbmdlcyAoZS5nLiwgd2luZG93IHJlc2l6ZSkuXG4gICAqL1xuICBvbkNvbnRhaW5lclJlc2l6ZSgpOiB2b2lkIHtcbiAgICB0aGlzLmFwcGx5TGF5b3V0KCk7XG4gIH1cblxuICAvKipcbiAgICogRW5hYmxlIGRyYWcgcmVvcmRlciBvbiB0aGUgaW1hZ2VzIGluIHRoaXMgcm93LlxuICAgKiBDYWxsIGFmdGVyIGJ1aWxkKCkgYW5kIGFmdGVyIHNldHRpbmcgb25SZW9yZGVyIGNhbGxiYWNrLlxuICAgKi9cbiAgZW5hYmxlRHJhZ1Jlb3JkZXIoKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmNvbnRhaW5lcikgcmV0dXJuO1xuXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCB0aGlzLml0ZW1FbHMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IGl0ZW0gPSB0aGlzLml0ZW1FbHNbaV07XG4gICAgICBpdGVtLmRyYWdnYWJsZSA9IHRydWU7XG5cbiAgICAgIGl0ZW0ub25kcmFnc3RhcnQgPSAoZSkgPT4ge1xuICAgICAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgICAgICBlLmRhdGFUcmFuc2ZlciEuZWZmZWN0QWxsb3dlZCA9IFwibW92ZVwiO1xuICAgICAgICAvLyBFbmNvZGUgc291cmNlOiBncm91cCBsaW5lU3RhcnQgKyBpbmRleCBzbyBhbnkgdGFyZ2V0IGNhbiBpZGVudGlmeSB0aGUgc291cmNlIGxpbmVcbiAgICAgICAgY29uc3QgcGF5bG9hZCA9IGBkaWFhLXJvdzoke3RoaXMuZ3JvdXAubGluZVN0YXJ0fToke2l9YDtcbiAgICAgICAgZS5kYXRhVHJhbnNmZXIhLnNldERhdGEoXCJ0ZXh0L3BsYWluXCIsIHBheWxvYWQpO1xuICAgICAgICAvLyBDdXN0b20gTUlNRSB0eXBlIGZvciBkcmFnb3ZlciBkZXRlY3Rpb24gKENocm9tZSBibG9ja3MgZ2V0RGF0YSBpbiBkcmFnb3ZlcilcbiAgICAgICAgZS5kYXRhVHJhbnNmZXIhLnNldERhdGEoXCJhcHBsaWNhdGlvbi9kaWFhLXJvd1wiLCBwYXlsb2FkKTtcbiAgICAgICAgaXRlbS5jbGFzc0xpc3QuYWRkKENMQVNTRVMuZHJhZ2dpbmcpO1xuICAgICAgICAvLyBDb25maWd1cmFibGUgb3BhY2l0eTogaGlnaGVyIGRyYWdPcGFjaXR5ID0gbW9yZSB0cmFuc3BhcmVudFxuICAgICAgICBpdGVtLnN0eWxlLm9wYWNpdHkgPSBTdHJpbmcoMSAtIHRoaXMub3B0aW9ucy5kcmFnT3BhY2l0eSAvIDEwMCk7XG5cbiAgICAgICAgLy8gQ3VzdG9tIGZ1bGx5LW9wYXF1ZSBnaG9zdCB0aGF0IGZvbGxvd3MgY3Vyc29yIHZpYSBkcmFnb3ZlclxuICAgICAgICBjb25zdCBpbWdFbCA9IHRoaXMuaW1hZ2VFbHNbaV07XG4gICAgICAgIGlmIChpbWdFbCAmJiBpbWdFbC5uYXR1cmFsV2lkdGggPiAwKSB7XG4gICAgICAgICAgLy8gSGlkZSBicm93c2VyJ3MgZGVmYXVsdCBzZW1pLXRyYW5zcGFyZW50IGdob3N0IHdpdGggYSB0cmFuc3BhcmVudCAxeDEgcGl4ZWxcbiAgICAgICAgICBjb25zdCBwaXhlbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJjYW52YXNcIik7XG4gICAgICAgICAgcGl4ZWwud2lkdGggPSAxO1xuICAgICAgICAgIHBpeGVsLmhlaWdodCA9IDE7XG4gICAgICAgICAgcGl4ZWwuc3R5bGUuY3NzVGV4dCA9IFwicG9zaXRpb246Zml4ZWQ7bGVmdDowO3RvcDowO3BvaW50ZXItZXZlbnRzOm5vbmVcIjtcbiAgICAgICAgICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKHBpeGVsKTtcbiAgICAgICAgICBlLmRhdGFUcmFuc2ZlciEuc2V0RHJhZ0ltYWdlKHBpeGVsLCAwLCAwKTtcbiAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHBpeGVsLnJlbW92ZSgpLCAwKTtcblxuICAgICAgICAgIC8vIEN1c3RvbSBmdWxseS1vcGFxdWUgZ2hvc3QsIGluaXRpYWxseSBhdCBjdXJzb3IgKHdpdGggRFBSIGZvciBzaGFycG5lc3MpXG4gICAgICAgICAgY29uc3QgdyA9IHRoaXMub3B0aW9ucy5naG9zdEltYWdlV2lkdGg7XG4gICAgICAgICAgY29uc3QgaCA9IChpbWdFbC5uYXR1cmFsSGVpZ2h0IC8gaW1nRWwubmF0dXJhbFdpZHRoKSAqIHc7XG4gICAgICAgICAgY29uc3QgZHByID0gd2luZG93LmRldmljZVBpeGVsUmF0aW8gfHwgMTtcbiAgICAgICAgICBjb25zdCBnaG9zdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJjYW52YXNcIik7XG4gICAgICAgICAgZ2hvc3Qud2lkdGggPSB3ICogZHByO1xuICAgICAgICAgIGdob3N0LmhlaWdodCA9IGggKiBkcHI7XG4gICAgICAgICAgZ2hvc3Quc3R5bGUud2lkdGggPSB3ICsgXCJweFwiO1xuICAgICAgICAgIGdob3N0LnN0eWxlLmhlaWdodCA9IGggKyBcInB4XCI7XG4gICAgICAgICAgZ2hvc3Quc3R5bGUuY3NzVGV4dCA9IGBwb3NpdGlvbjpmaXhlZDtsZWZ0OiR7ZS5jbGllbnRYfXB4O3RvcDoke2UuY2xpZW50WX1weDt3aWR0aDoke3d9cHg7aGVpZ2h0OiR7aH1weDtwb2ludGVyLWV2ZW50czpub25lO3otaW5kZXg6MjE0NzQ4MzY0N2A7XG4gICAgICAgICAgY29uc3QgY3R4ID0gZ2hvc3QuZ2V0Q29udGV4dChcIjJkXCIpITtcbiAgICAgICAgICBjdHguc2NhbGUoZHByLCBkcHIpO1xuICAgICAgICAgIGN0eC5kcmF3SW1hZ2UoaW1nRWwsIDAsIDAsIHcsIGgpO1xuICAgICAgICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoZ2hvc3QpO1xuXG4gICAgICAgICAgY29uc3Qgb25EcmFnT3ZlciA9IChldjogRHJhZ0V2ZW50KSA9PiB7XG4gICAgICAgICAgICBnaG9zdC5zdHlsZS5sZWZ0ID0gZXYuY2xpZW50WCArIFwicHhcIjtcbiAgICAgICAgICAgIGdob3N0LnN0eWxlLnRvcCA9IGV2LmNsaWVudFkgKyBcInB4XCI7XG4gICAgICAgICAgfTtcbiAgICAgICAgICBjb25zdCBvbkRyYWdFbmQgPSAoKSA9PiB7XG4gICAgICAgICAgICBkb2N1bWVudC5yZW1vdmVFdmVudExpc3RlbmVyKFwiZHJhZ292ZXJcIiwgb25EcmFnT3ZlciwgdHJ1ZSk7XG4gICAgICAgICAgICBnaG9zdC5yZW1vdmUoKTtcbiAgICAgICAgICB9O1xuICAgICAgICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJkcmFnb3ZlclwiLCBvbkRyYWdPdmVyLCB0cnVlKTtcbiAgICAgICAgICBpdGVtLmFkZEV2ZW50TGlzdGVuZXIoXCJkcmFnZW5kXCIsIG9uRHJhZ0VuZCwgeyBvbmNlOiB0cnVlIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgbG9nZ2VyLmluZm8oXCJJbWFnZVJvd1dpZGdldCBkcmFnc3RhcnRcIiwge1xuICAgICAgICAgIGluZGV4OiBpLFxuICAgICAgICAgIGdyb3VwTGluZVN0YXJ0OiB0aGlzLmdyb3VwLmxpbmVTdGFydCxcbiAgICAgICAgICBwYXlsb2FkLFxuICAgICAgICAgIHRhcmdldFRhZzogKGUudGFyZ2V0IGFzIEhUTUxFbGVtZW50KS50YWdOYW1lLFxuICAgICAgICAgIHRhcmdldENsYXNzOiAoZS50YXJnZXQgYXMgSFRNTEVsZW1lbnQpLmNsYXNzTmFtZT8uc3Vic3RyaW5nPy4oMCwgNDApIHx8IFwiXCIsXG4gICAgICAgIH0pO1xuICAgICAgfTtcblxuICAgICAgaXRlbS5vbmRyYWdlbmQgPSAoZSkgPT4ge1xuICAgICAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgICAgICBpdGVtLmNsYXNzTGlzdC5yZW1vdmUoQ0xBU1NFUy5kcmFnZ2luZyk7XG4gICAgICAgIGl0ZW0uc3R5bGUub3BhY2l0eSA9IFwiXCI7XG4gICAgICAgIGZvciAoY29uc3QgZWwgb2YgdGhpcy5pdGVtRWxzKSB7XG4gICAgICAgICAgZWwuc3R5bGUuYm9yZGVyTGVmdCA9IFwiXCI7XG4gICAgICAgICAgZWwuc3R5bGUuYm9yZGVyUmlnaHQgPSBcIlwiO1xuICAgICAgICB9XG4gICAgICB9O1xuXG4gICAgICBpdGVtLm9uZHJhZ292ZXIgPSAoZSkgPT4ge1xuICAgICAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgIGUuZGF0YVRyYW5zZmVyIS5kcm9wRWZmZWN0ID0gXCJtb3ZlXCI7XG4gICAgICAgIGNvbnN0IHJlY3QgPSBpdGVtLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgICAgICBjb25zdCBtaWQgPSByZWN0LmxlZnQgKyByZWN0LndpZHRoIC8gMjtcblxuICAgICAgICBmb3IgKGNvbnN0IGVsIG9mIHRoaXMuaXRlbUVscykge1xuICAgICAgICAgIGVsLnN0eWxlLmJvcmRlckxlZnQgPSBcIlwiO1xuICAgICAgICAgIGVsLnN0eWxlLmJvcmRlclJpZ2h0ID0gXCJcIjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoZS5jbGllbnRYIDwgbWlkKSB7XG4gICAgICAgICAgaXRlbS5zdHlsZS5ib3JkZXJMZWZ0ID0gXCIzcHggc29saWQgIzRhOWVmZlwiO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGl0ZW0uc3R5bGUuYm9yZGVyUmlnaHQgPSBcIjNweCBzb2xpZCAjNGE5ZWZmXCI7XG4gICAgICAgIH1cbiAgICAgIH07XG5cbiAgICAgIGl0ZW0ub25kcmFnbGVhdmUgPSAoZSkgPT4ge1xuICAgICAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgICAgICBpdGVtLnN0eWxlLmJvcmRlckxlZnQgPSBcIlwiO1xuICAgICAgICBpdGVtLnN0eWxlLmJvcmRlclJpZ2h0ID0gXCJcIjtcbiAgICAgIH07XG5cbiAgICAgIGl0ZW0ub25kcm9wID0gKGUpID0+IHtcbiAgICAgICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgICBpdGVtLnN0eWxlLmJvcmRlckxlZnQgPSBcIlwiO1xuICAgICAgICBpdGVtLnN0eWxlLmJvcmRlclJpZ2h0ID0gXCJcIjtcblxuICAgICAgICBjb25zdCBkYXRhID0gZS5kYXRhVHJhbnNmZXIhLmdldERhdGEoXCJ0ZXh0L3BsYWluXCIpO1xuICAgICAgICBsb2dnZXIuZGVidWcoXCJJbWFnZVJvd1dpZGdldCBpdGVtIG9uZHJvcFwiLCB7IGksIGRhdGE6IGRhdGE/LnN1YnN0cmluZygwLCA2MCkgfSk7XG5cbiAgICAgICAgaWYgKCFkYXRhKSByZXR1cm47XG5cbiAgICAgICAgY29uc3QgcmVjdCA9IGl0ZW0uZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgICAgIGNvbnN0IG1pZCA9IHJlY3QubGVmdCArIHJlY3Qud2lkdGggLyAyO1xuICAgICAgICBjb25zdCBpbnNlcnRBdCA9IGUuY2xpZW50WCA8IG1pZCA/IGkgOiBpICsgMTtcblxuICAgICAgICAvLyBGbGV4IHJvdyBzb3VyY2U6IFwiZGlhYS1yb3c6PGxpbmVTdGFydD46PGluZGV4PlwiXG4gICAgICAgIGNvbnN0IHJvd01hdGNoID0gZGF0YS5tYXRjaCgvXmRpYWEtcm93OihcXGQrKTooXFxkKykkLyk7XG4gICAgICAgIGlmIChyb3dNYXRjaCkge1xuICAgICAgICAgIGNvbnN0IHNyY0xpbmVTdGFydCA9IHBhcnNlSW50KHJvd01hdGNoWzFdLCAxMCk7XG4gICAgICAgICAgY29uc3Qgc3JjSW5kZXggPSBwYXJzZUludChyb3dNYXRjaFsyXSwgMTApO1xuXG4gICAgICAgICAgaWYgKHNyY0xpbmVTdGFydCA9PT0gdGhpcy5ncm91cC5saW5lU3RhcnQpIHtcbiAgICAgICAgICAgIC8vIEludHJhLXJvdyByZW9yZGVyIChzYW1lIGdyb3VwKVxuICAgICAgICAgICAgY29uc3QgdG9JbmRleCA9IHNyY0luZGV4IDwgaW5zZXJ0QXQgPyBpbnNlcnRBdCAtIDEgOiBpbnNlcnRBdDtcbiAgICAgICAgICAgIGlmIChzcmNJbmRleCAhPT0gdG9JbmRleCAmJiBzcmNJbmRleCAhPT0gaSAmJiB0aGlzLnJlb3JkZXJDYWxsYmFjaykge1xuICAgICAgICAgICAgICB0aGlzLnJlb3JkZXJDYWxsYmFjayhzcmNJbmRleCwgdG9JbmRleCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gSW50ZXItcm93OiBtb3ZlIGZyb20gYW5vdGhlciBmbGV4IHJvdyBpbnRvIHRoaXMgb25lXG4gICAgICAgICAgaWYgKHRoaXMubWVyZ2VFeHRlcm5hbENhbGxiYWNrKSB7XG4gICAgICAgICAgICBsb2dnZXIuaW5mbyhcIkltYWdlUm93V2lkZ2V0IGludGVyLXJvdyBtZXJnZVwiLCB7IGksIGluc2VydEF0LCBzcmNMaW5lU3RhcnQsIHNyY0luZGV4IH0pO1xuICAgICAgICAgICAgdGhpcy5tZXJnZUV4dGVybmFsQ2FsbGJhY2soaW5zZXJ0QXQsIGRhdGEpO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICAvLyBTdGFuZGFsb25lIHNvdXJjZTogZGlhYS1zdGFuZGFsb25lOjxsaW5lPiAoaW50ZXJjZXB0ZWQpIG9yIG9ic2lkaWFuOi8vb3BlbiBVUklcbiAgICAgICAgaWYgKChkYXRhLnN0YXJ0c1dpdGgoXCJkaWFhLXN0YW5kYWxvbmU6XCIpIHx8IGRhdGEuc3RhcnRzV2l0aChcIm9ic2lkaWFuOi8vb3BlblwiKSkgJiYgdGhpcy5tZXJnZUV4dGVybmFsQ2FsbGJhY2spIHtcbiAgICAgICAgICBsb2dnZXIuaW5mbyhcIkltYWdlUm93V2lkZ2V0IGNyb3NzLXJvdyBtZXJnZSBmcm9tIHN0YW5kYWxvbmVcIiwgeyBpLCBpbnNlcnRBdCwgZGF0YTogZGF0YS5zdWJzdHJpbmcoMCwgNjApIH0pO1xuICAgICAgICAgIHRoaXMubWVyZ2VFeHRlcm5hbENhbGxiYWNrKGluc2VydEF0LCBkYXRhKTtcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBDb250YWluZXItbGV2ZWwgZmFsbGJhY2s6IGFjY2VwdCBkcm9wcyB0aGF0IGxhbmQgYmV0d2VlbiBpdGVtcyBvciBvbiB0aGUgcm93IGJhY2tncm91bmRcbiAgICBpZiAodGhpcy5jb250YWluZXIpIHtcbiAgICAgIHRoaXMuY29udGFpbmVyLmFkZEV2ZW50TGlzdGVuZXIoXCJkcmFnb3ZlclwiLCAoZSkgPT4ge1xuICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgIGUuZGF0YVRyYW5zZmVyIS5kcm9wRWZmZWN0ID0gXCJtb3ZlXCI7XG4gICAgICB9KTtcblxuICAgICAgdGhpcy5jb250YWluZXIuYWRkRXZlbnRMaXN0ZW5lcihcImRyb3BcIiwgKGUpID0+IHtcbiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgICBjb25zdCBkYXRhID0gZS5kYXRhVHJhbnNmZXIhLmdldERhdGEoXCJ0ZXh0L3BsYWluXCIpO1xuICAgICAgICBsb2dnZXIuZGVidWcoXCJJbWFnZVJvd1dpZGdldCBjb250YWluZXIgb25kcm9wXCIsIHsgZGF0YTogZGF0YT8uc3Vic3RyaW5nKDAsIDYwKSB9KTtcbiAgICAgICAgaWYgKCFkYXRhKSByZXR1cm47XG5cbiAgICAgICAgLy8gT25seSBoYW5kbGUgbm9uLWludHJhLXJvdyBkcm9wcyBhdCBjb250YWluZXIgbGV2ZWwgKGludHJhLXJvdyBpcyBpdGVtLWxldmVsKVxuICAgICAgICBjb25zdCByb3dNYXRjaCA9IGRhdGEubWF0Y2goL15kaWFhLXJvdzooXFxkKyk6KFxcZCspJC8pO1xuICAgICAgICBjb25zdCBpc1N0YW5kYWxvbmUgPSBkYXRhLnN0YXJ0c1dpdGgoXCJkaWFhLXN0YW5kYWxvbmU6XCIpIHx8IGRhdGEuc3RhcnRzV2l0aChcIm9ic2lkaWFuOi8vb3BlblwiKTtcbiAgICAgICAgaWYgKChyb3dNYXRjaCB8fCBpc1N0YW5kYWxvbmUpICYmIHRoaXMubWVyZ2VFeHRlcm5hbENhbGxiYWNrKSB7XG4gICAgICAgICAgY29uc3QgY29udGFpbmVyUmVjdCA9IHRoaXMuY29udGFpbmVyIS5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICAgICAgICBjb25zdCBtaWQgPSBjb250YWluZXJSZWN0LmxlZnQgKyBjb250YWluZXJSZWN0LndpZHRoIC8gMjtcbiAgICAgICAgICBjb25zdCBpbnNlcnRBdCA9IGUuY2xpZW50WCA8IG1pZCA/IDAgOiB0aGlzLml0ZW1FbHMubGVuZ3RoO1xuICAgICAgICAgIGxvZ2dlci5pbmZvKFwiSW1hZ2VSb3dXaWRnZXQgY3Jvc3Mtcm93IG1lcmdlIChjb250YWluZXIpXCIsIHsgaW5zZXJ0QXQgfSk7XG4gICAgICAgICAgdGhpcy5tZXJnZUV4dGVybmFsQ2FsbGJhY2soaW5zZXJ0QXQsIGRhdGEpO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogQ2xlYW4gdXAgYWxsIGV2ZW50IGxpc3RlbmVycy5cbiAgICovXG4gIGRlc3Ryb3koKTogdm9pZCB7XG4gICAgZm9yIChjb25zdCBkaXZpZGVyIG9mIHRoaXMuZGl2aWRlckVscykge1xuICAgICAgaWYgKGRpdmlkZXIuX2Rlc3Ryb3kpIGRpdmlkZXIuX2Rlc3Ryb3koKTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBoYW5kbGVzIG9mIHRoaXMucmVzaXplSGFuZGxlcykge1xuICAgICAgZm9yIChjb25zdCBoIG9mIGhhbmRsZXMpIHtcbiAgICAgICAgaWYgKGguX2Rlc3Ryb3kpIGguX2Rlc3Ryb3koKTtcbiAgICAgIH1cbiAgICB9XG4gICAgdGhpcy5yZXNpemVPYnNlcnZlcj8uZGlzY29ubmVjdCgpO1xuICAgIHRoaXMucmVzaXplT2JzZXJ2ZXIgPSBudWxsO1xuICAgIHRoaXMuaW1hZ2VFbHMgPSBbXTtcbiAgICB0aGlzLml0ZW1FbHMgPSBbXTtcbiAgICB0aGlzLmRpdmlkZXJFbHMgPSBbXTtcbiAgICB0aGlzLnJlc2l6ZUhhbmRsZXMgPSBbXTtcbiAgICB0aGlzLmhhbmRsZURlZnMgPSBbXTtcbiAgICBpZiAodGhpcy5jb250YWluZXIpIHtcbiAgICAgIHRoaXMuY29udGFpbmVyLnJlbW92ZSgpO1xuICAgICAgdGhpcy5jb250YWluZXIgPSBudWxsO1xuICAgIH1cbiAgfVxufVxuXG4vLyBFeHRlbmQgSFRNTEVsZW1lbnQgdG8gaG9sZCBkZXN0cm95IGZ1bmN0aW9ucyAobm90IGV4cG9ydGVkKVxuZGVjbGFyZSBnbG9iYWwge1xuICBpbnRlcmZhY2UgSFRNTEVsZW1lbnQge1xuICAgIF9kZXN0cm95PzogKCkgPT4gdm9pZDtcbiAgfVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIjs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsSUFBQUEsbUJBQXFDOzs7QUNBckMsc0JBQStDOzs7QUNBeEMsSUFBTSxhQUFhO0FBRW5CLElBQU0sVUFBVTtBQUFBLEVBQ3JCLEtBQUssR0FBRyxVQUFVO0FBQUEsRUFDbEIsV0FBVyxHQUFHLFVBQVU7QUFBQSxFQUN4QixZQUFZLEdBQUcsVUFBVTtBQUFBLEVBQ3pCLFNBQVMsR0FBRyxVQUFVO0FBQUEsRUFDdEIsY0FBYyxHQUFHLFVBQVU7QUFBQSxFQUMzQixlQUFlLEdBQUcsVUFBVTtBQUFBLEVBQzVCLFVBQVUsR0FBRyxVQUFVO0FBQUEsRUFDdkIsYUFBYSxHQUFHLFVBQVU7QUFBQSxFQUMxQixlQUFlLEdBQUcsVUFBVTtBQUFBLEVBQzVCLGFBQWEsR0FBRyxVQUFVO0FBQUEsRUFDMUIsVUFBVSxHQUFHLFVBQVU7QUFBQSxFQUN2QixRQUFRLEdBQUcsVUFBVTtBQUFBLEVBQ3JCLFVBQVUsR0FBRyxVQUFVO0FBQ3pCO0FBRU8sSUFBTSxtQkFBbUI7QUFBQSxFQUM5QixTQUFTO0FBQUEsRUFDVCxrQkFBa0I7QUFBQSxFQUNsQixpQkFBaUI7QUFBQSxFQUNqQixTQUFTO0FBQUEsRUFDVCxpQkFBaUI7QUFBQSxFQUNqQixtQkFBbUI7QUFBQSxFQUNuQixjQUFjO0FBQUEsRUFDZCxnQkFBZ0I7QUFBQSxFQUNoQixpQkFBaUI7QUFBQSxFQUNqQixtQkFBbUI7QUFBQSxFQUNuQixpQkFBaUI7QUFBQSxFQUNqQixhQUFhO0FBQ2Y7QUFHTyxJQUFNLGdCQUFnQjtBQUN0QixJQUFNLHFCQUFxQjtBQUczQixTQUFTLGlCQUFpQixZQUE0QjtBQUMzRCxRQUFNLFVBQVUsV0FBVyxN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LGlCQUFpQixLQUFLLFNBQVM7QUFBQSxNQUMvQixhQUFhLEtBQUssU0FBUztBQUFBLE1BQzNCLGlCQUFpQixDQUFDLGFBQXFCO0FBQ3JDLGNBQU0sTUFBTSxLQUFLLGlCQUFpQixVQUFVLFVBQVU7QUFDdEQsWUFBSSxDQUFDLEtBQUs7QUFDUixpQkFBTyxNQUFNLDRCQUE0QixFQUFFLFVBQVUsV0FBVyxDQUFDO0FBQUEsUUFDbkU7QUFDQSxlQUFPO0FBQUEsTUFDVDtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQUEsRUFFUSxpQkFBaUIsVUFBa0IsWUFBNEI7QUFDckUsVUFBTSxVQUFVLG1CQUFtQixRQUFRO0FBQzNDLFVBQU0sT0FBTyxLQUFLLElBQUksY0FBYyxxQkFBcUIsU0FBUyxVQUFVO0FBQzVFLFFBQUksTUFBTTtBQUNSLGFBQU8sS0FBSyxJQUFJLE1BQU0sZ0JBQWdCLElBQUk7QUFBQSxJQUM1QztBQUNBLFdBQU87QUFBQSxFQUNUO0FBQ0Y7IiwKICAibmFtZXMiOiBbImltcG9ydF9vYnNpZGlhbiIsICJpbXBvcnRfb2JzaWRpYW4iLCAiaW1wb3J0X29ic2lkaWFuIiwgImxlZnRJdGVtIiwgInJpZ2h0SXRlbSIsICJoIiwgInBvcyIsICJzcmNMaW5lIiwgImRyb3BUYXJnZXQiLCAidGFyZ2V0TGluZSJdCn0K
