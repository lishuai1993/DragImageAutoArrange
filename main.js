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
    this.container.style.overflow = "hidden";
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
    item.style.flex = `${image.flexGrow} 1 0%`;
    item.style.position = "relative";
    item.style.overflow = "hidden";
    item.style.minWidth = "50px";
    item.style.minHeight = "0";
    item.style.height = "100%";
    item.dataset.index = String(index);
    const img = document.createElement("img");
    img.className = CLASSES.imageInner;
    img.alt = image.fileName;
    img.style.display = "block";
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "contain";
    img.style.objectPosition = "left top";
    img.dataset.index = String(index);
    const handleLoad = () => {
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;
      logger.debug("ImageRowWidget img onload", { index, file: image.fileName, naturalWidth: nw, naturalHeight: nh, complete: img.complete });
      this.loadedMetas.set(index, { naturalWidth: nw, naturalHeight: nh });
      this.applyLayout();
      requestAnimationFrame(() => this.updateHandlePositions(index));
    };
    img.onload = handleLoad;
    img.onerror = () => {
      logger.warn("Image load failed in widget", { fileName: image.fileName, index, src: img.src.substring(0, 80) });
      this.loadedMetas.set(index, { naturalWidth: 400, naturalHeight: 300 });
      img.style.backgroundColor = "#f0f0f0";
      img.alt = `[Not found: ${image.fileName}]`;
      this.applyLayout();
    };
    img.src = this.options.getResourcePath(image.fileName);
    if (img.complete && img.naturalWidth > 0) {
      logger.debug("ImageRowWidget img already complete", { index, file: image.fileName, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight });
      handleLoad();
    }
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
      let startHeight = 0;
      let maxHeight = 2e3;
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
        startHeight = parseFloat(this.container.style.height || "0");
        if (nItems === 1) {
          const meta = this.loadedMetas.get(index);
          if (meta && meta.naturalWidth > 0) {
            const aspect = meta.naturalWidth / meta.naturalHeight;
            maxHeight = aspect > 0 ? Math.round(AW / aspect) : 2e3;
          }
        }
        const displayRect = this.getImageContentRect(index);
        const displayW = displayRect ? displayRect.width : startWidth;
        scale = displayW > 0 ? startWidth / displayW : 1;
        if (currentOnMove) document.removeEventListener("mousemove", currentOnMove);
        if (currentOnUp) document.removeEventListener("mouseup", currentOnUp);
        currentOnMove = (ev) => {
          if (!dragging) return;
          if (nItems === 1) {
            const dx = ev.clientX - e.clientX;
            const dy = ev.clientY - e.clientY;
            const xSign = hd.relX < 0.5 ? -1 : 1;
            const ySign = hd.relY < 0.5 ? -1 : 1;
            const wx = 2 * Math.abs(hd.relX - 0.5);
            const wy = 2 * Math.abs(hd.relY - 0.5);
            const SENS2 = 1;
            const delta = wx + wy > 0 ? (dx * xSign * wx + dy * ySign * wy) / (wx + wy) * SENS2 : 0;
            const newHeight = Math.max(50, Math.min(maxHeight, Math.round(startHeight + delta)));
            const h = `${newHeight}px`;
            this.container.style.height = h;
            this.itemEls[0].style.height = h;
            this.imageEls[0].style.height = h;
            this.updateHandlePositions(0);
            return;
          }
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
          logger.debug("resize-mouseup", { index, finalFlex, nItems, timestamp: Date.now() });
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
    logger.debug("ImageRowWidget applyLayout", { allLoaded, hasExplicitWidth: this.group.images.some((img) => img.hasExplicitWidth), metaCount: metas.filter((m) => m.naturalWidth > 0).length, totalImages: this.group.images.length });
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
    if (containerWidth === 0) {
      requestAnimationFrame(() => this.recalculateRowHeight());
      return;
    }
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
    const upperClamp = n === 1 ? 2e3 : this.options.defaultRowHeight * 3;
    const clamped = Math.max(
      50,
      Math.min(upperClamp, Math.round(maxHeight))
    );
    this.rowHeight = clamped;
    logger.debug("ImageRowWidget recalculateRowHeight", { containerWidth, availableWidth, grows, totalGrow, maxHeight, clampedRowHeight: clamped, imageCount: n });
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
    if (!this.innerWidget || !this.group) return false;
    const doc = view.state.doc;
    const imgRegex = /^[\s]*!\[\[([^\]]+)\]\]/;
    const currentFiles = [];
    for (let i = this.group.lineStart; i < doc.lines; i++) {
      const text = doc.line(i + 1).text;
      const match = text.match(imgRegex);
      if (!match) break;
      currentFiles.push(match[1].split("|")[0]);
    }
    if (currentFiles.length !== this.group.images.length) return false;
    for (let i = 0; i < currentFiles.length; i++) {
      if (currentFiles[i] !== this.group.images[i].fileName) return false;
    }
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
