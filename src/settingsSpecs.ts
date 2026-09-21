/**
 * The settings tab's row table — the single source of truth both render paths
 * read: `DragImageSettingTab.display()` (Obsidian < 1.13) and
 * `DragImageSettingTab.getSettingDefinitions()` (1.13+). Adding or changing a
 * setting means editing this table; neither path keeps a hand-written copy.
 *
 * A row is either a `control` row — pure data, rendered by the framework on
 * 1.13+ and by `buildControlRow` below it — or a `render` row, whose body needs
 * imperative code (buttons, a composite control, decoration measured off the
 * DOM). A `render` row names an id that both paths resolve to one builder.
 *
 * Headings and row copy are `{ zh, en }` pairs, because this table is built once
 * at import and the tab can be drawn in either language; the render paths
 * resolve them with `t()`. See ./i18n/language.
 */

import type { Language, Localized } from "./i18n/language";

export type SliderKey =
  | "defaultRowHeight"
  | "maxImagesPerRow"
  | "gapSize"
  | "snapSensitivity"
  | "topBarSensitivity"
  | "ghostImageWidth"
  | "dragOpacity"
  | "menuScalePercent";

export type ToggleKey =
  | "enableDragReorder"
  | "enableResize"
  | "enableDividers"
  | "enableReadingModeContextMenu"
  | "enableReadingModeDoubleClickZoom"
  | "logToFile"
  | "geometryProbe";

export type DropdownKey = "alignment";

export type TextKey = "imageExtensions";

/** A row's copy, in both languages. Pairs rather than plain strings because this
 *  table is built once at import and has to be re-readable in either language;
 *  the render paths resolve them with `t()`. */
interface RowCopy {
  name: Localized;
  desc: Localized;
}

export interface SliderRow extends RowCopy {
  kind: "slider";
  key: SliderKey;
  min: number;
  max: number;
  step: number;
}

export interface ToggleRow extends RowCopy {
  kind: "toggle";
  key: ToggleKey;
}

export interface DropdownRow extends RowCopy {
  kind: "dropdown";
  key: DropdownKey;
  options: ReadonlyArray<readonly [value: string, label: Localized]>;
}

export interface TextRow extends RowCopy {
  kind: "text";
  key: TextKey;
}

export type ControlRow = SliderRow | ToggleRow | DropdownRow | TextRow;

/** Rows built imperatively; both paths call the same builder for each id. */
export type RenderRowId =
  | "language"
  | "singleImageSize"
  | "resetAlignments"
  | "resetSingleImages"
  | "logLevel";

export interface RenderRow extends RowCopy {
  kind: "render";
  id: RenderRowId;
}

export type RowSpec = ControlRow | RenderRow;

/** Sections handed to an existing module, which brings both its own heading and
 *  its own rows — so the spec carries neither. */
export type HostId = "imageMenuSection" | "maintenanceSection";

export type SectionSpec =
  | { kind: "group"; heading: Localized; rows: RowSpec[] }
  | { kind: "host"; id: HostId };

/** The display languages, in the order the switch draws them. Each label is
 *  written in the language it selects, so a segment is its own sample and
 *  neither label needs translating. */
export const LANGUAGE_OPTIONS: ReadonlyArray<readonly [Language, string]> = [
  ["zh", "中文"],
  ["en", "English"],
];

export const SETTINGS_SECTIONS: SectionSpec[] = [
  {
    kind: "group",
    heading: { zh: "界面语言", en: "Interface language" },
    rows: [
      {
        kind: "render",
        id: "language",
        name: { zh: "显示语言", en: "Display language" },
        desc: {
          zh: "设置页与图片右键菜单的显示语言，切换后立即生效。",
          en: "Language for the settings page and the image context menu. Applies immediately.",
        },
      },
    ],
  },
  {
    kind: "group",
    heading: { zh: "行布局与交互设置", en: "Row layout & interaction" },
    rows: [
      {
        kind: "slider",
        key: "defaultRowHeight",
        name: { zh: "默认行高", en: "Default row height" },
        desc: {
          zh: "图片行的默认统一高度（px），各行会按图片宽高比自适应。",
          en: "Default uniform height (px) for image rows. Individual rows adapt based on image aspect ratios.",
        },
        min: 80,
        max: 600,
        step: 10,
      },
      {
        kind: "slider",
        key: "maxImagesPerRow",
        name: { zh: "每行最大图片数", en: "Max images per row" },
        desc: {
          zh: "单行允许的最大图片数（1-10），超出的分组会被拆分。",
          en: "Maximum number of images allowed in a single row (1-10). Groups exceeding this limit are split.",
        },
        min: 2,
        max: 10,
        step: 1,
      },
      {
        kind: "slider",
        key: "gapSize",
        name: { zh: "图片间距", en: "Gap size" },
        desc: {
          zh: "一行内相邻图片之间的间距（px）。",
          en: "Spacing between images in a row (px).",
        },
        min: 0,
        max: 20,
        step: 1,
      },
      {
        kind: "slider",
        key: "snapSensitivity",
        name: { zh: "吸附灵敏度", en: "Snap sensitivity" },
        desc: {
          zh: "拖拽分隔线或缩放手柄时，相邻图片的高度差落在这个百分比（相对于它们的等高值）以内就吸附到位。设为 0 关闭吸附。",
          en: "When dragging a divider or resize handle, snap into place when the height difference between adjacent images falls within this percentage of their equilibrium (equal) height. Set to 0 to disable snapping.",
        },
        min: 0,
        max: 10,
        step: 1,
      },
      {
        kind: "slider",
        key: "topBarSensitivity",
        name: { zh: "顶部均衡条触发区", en: "Top bar activation zone" },
        desc: {
          zh: "距图片行顶部多少像素以内会浮出整行均衡条（4-40 px）。",
          en: "Pixel distance from the top of a flex row within which the global-balance top bar appears (4-40 px).",
        },
        min: 4,
        max: 40,
        step: 2,
      },
      {
        kind: "slider",
        key: "ghostImageWidth",
        name: { zh: "拖拽预览图宽度", en: "Ghost image width" },
        desc: {
          zh: "拖拽时跟随光标的预览图宽度（100-500 px）。",
          en: "Width (px) of the drag ghost image that follows the Cursor (100-500 px).",
        },
        min: 100,
        max: 500,
        step: 10,
      },
      {
        kind: "slider",
        key: "dragOpacity",
        name: { zh: "拖拽预览图透明度", en: "Drag ghost opacity" },
        desc: {
          zh: "拖拽过程中原图的透明度（10% 近乎不透明，90% 非常透明）。",
          en: "Transparency of the original image during drag (10% = nearly opaque, 90% = very transparent).",
        },
        min: 10,
        max: 90,
        step: 5,
      },
      {
        kind: "toggle",
        key: "enableDragReorder",
        name: { zh: "启用拖拽排序", en: "Enable drag reorder" },
        desc: {
          zh: "允许在一行内拖拽图片调整先后顺序。",
          en: "Allow dragging images within a row to reorder them.",
        },
      },
      {
        kind: "toggle",
        key: "enableResize",
        name: { zh: "启用缩放手柄", en: "Enable resize handles" },
        desc: {
          zh: "悬停时显示四角缩放手柄，用于调整单张图片的尺寸。",
          en: "Show corner resize handles on hover to adjust individual image sizes.",
        },
      },
      {
        kind: "toggle",
        key: "enableDividers",
        name: { zh: "启用列分隔线", en: "Enable column dividers" },
        desc: {
          zh: "在图片之间显示可拖拽的分隔线，用于调整宽度份额。",
          en: "Show draggable dividers between images to adjust width ratios.",
        },
      },
      {
        kind: "slider",
        key: "menuScalePercent",
        name: { zh: "右键菜单大小", en: "Context menu size" },
        desc: {
          zh: "图片右键菜单的缩放比例（50%–150%），菜单的内边距、间距、字体与图标按 10% 档同步缩放。",
          en: "Scale of the right-click image menu (50%–150%). Menu padding, spacing, fonts and icons scale together in 10% steps.",
        },
        min: 50,
        max: 150,
        step: 10,
      },
      {
        kind: "text",
        key: "imageExtensions",
        name: { zh: "图片扩展名", en: "Image extensions" },
        desc: {
          zh: "要识别的图片扩展名，逗号分隔（例如 PNG,JPG,GIF,webp）。",
          en: "Comma-separated list of image file extensions to detect (e.g., PNG,JPG,GIF,webp).",
        },
      },
    ],
  },
  {
    kind: "group",
    heading: { zh: "图片统一对齐设置", en: "Image alignment" },
    rows: [
      {
        kind: "dropdown",
        key: "alignment",
        name: { zh: "图片对齐", en: "Image alignment" },
        desc: {
          zh: "图片行的全局水平对齐方式。通过右键设置的单张图片对齐优先于此项。",
          en: "Global horizontal alignment for image rows. Per-image overrides set via right-click take priority.",
        },
        options: [
          ["left", { zh: "左对齐", en: "Left" }],
          ["center", { zh: "居中", en: "Center" }],
          ["right", { zh: "右对齐", en: "Right" }],
        ],
      },
      {
        kind: "render",
        id: "resetAlignments",
        name: { zh: "重置图片对齐", en: "Reset image alignments" },
        desc: {
          zh: "一次性操作：清除每张图片单独设置的对齐方式，全部回到上方的全局设置。",
          en: "One-shot: clear every image's per-image alignment override and revert to the global setting above.",
        },
      },
      {
        kind: "toggle",
        key: "enableReadingModeContextMenu",
        name: { zh: "启用阅读模式右键菜单", en: "Enable reading mode context menu" },
        desc: {
          zh: "开启后，阅读模式下右键图片会弹出对齐菜单。关闭时阅读模式保持只读——对齐只能在实时预览或源码模式下修改。",
          en: "When enabled, right-clicking an image in reading mode shows the alignment menu. When disabled, reading mode is read-only — alignment can only be changed in live preview or source mode.",
        },
      },
      {
        kind: "toggle",
        key: "enableReadingModeDoubleClickZoom",
        name: { zh: "阅读模式：双击预览图片", en: "Reading mode: double-click image to preview" },
        desc: {
          zh: "开启后，阅读模式下需双击才能打开图片预览，单击不再触发。关闭时保持 Obsidian 原生的单击行为。",
          en: "When enabled, opening an image's preview in reading mode requires a double click instead of a single click. When disabled, reading mode keeps Obsidian's native single-click behavior.",
        },
      },
    ],
  },
  {
    kind: "group",
    heading: { zh: "单图行图片尺寸设置", en: "Single image size" },
    rows: [
      {
        kind: "render",
        id: "singleImageSize",
        name: { zh: "单图尺寸", en: "Single image size" },
        desc: {
          zh: "独占一行的单张图片如何定尺寸。这里的宽度指画作在页面上实际占的宽，无论它来自本项还是来自手动拖拽四角。原始尺寸按图片的真实像素显示（超出编辑区宽时收缩），固定宽度按设定值渲染。旋转 90° 或 270° 会把图片钉在它当时显示的宽度上，以保持原有大小；右键「重置为设置宽度」可交还本项设置。",
          en: "How a lone image (a single-image row) is sized. The width is the one the picture takes across the page, whether it comes from here or from a manual corner-resize. Natural size shows images at their real pixel size, shrunk to fit the editor width; Fixed width renders single images at a set width. Rotating by 90° or 270° pins the image to the width it then shows, so the picture keeps the size it had; right-click “Reset to setting width” hands it back to this setting.",
        },
      },
      {
        kind: "render",
        id: "resetSingleImages",
        name: { zh: "重置单图尺寸", en: "Reset single image sizes" },
        desc: {
          zh: "一次性操作：清除每张单图的尺寸覆盖，重新套用当前的尺寸模式。",
          en: "One-shot: clear every single image's manual size override and re-apply the current mode.",
        },
      },
    ],
  },
  { kind: "host", id: "imageMenuSection" },
  {
    kind: "group",
    heading: { zh: "日志与调试设置", en: "Logging & debugging" },
    rows: [
      {
        kind: "render",
        id: "logLevel",
        name: { zh: "日志级别", en: "Log level" },
        desc: {
          zh: "低于所选级别的日志不会输出，同时作用于控制台与 log.txt。默认 error，仅记录错误。",
          en: "Logs below the selected level are dropped, for both the console and log.txt. The default, error, records errors only.",
        },
      },
      {
        kind: "toggle",
        key: "logToFile",
        name: { zh: "写入 log.txt", en: "Write log.txt" },
        desc: {
          zh: "开启后，符合级别的日志写入插件目录下的 log.txt（开启时清空一次，便于读取本次会话）。",
          en: "When enabled, logs at or above the level go to log.txt in the plugin folder. Turning it on clears the file once, so it only holds the current session.",
        },
      },
      {
        kind: "toggle",
        key: "geometryProbe",
        name: { zh: "诊断快照（临时）", en: "Geometry probe (temporary)" },
        desc: {
          zh: "开启后，布局过程中会把每张图的「模型 / 写入 / 实测」三组几何写入 log.txt（DIAAGEO 行），用于定位尺寸异常；快照忽略日志级别，但需 logToFile 通道可用。排查结束后请关闭。",
          en: "When enabled, layout writes each image's model / saved / measured geometry to log.txt (DIAAGEO lines) to pin down sizing anomalies. Snapshots ignore the log level but still need the logToFile channel. Turn it off when the investigation is over.",
        },
      },
    ],
  },
  { kind: "host", id: "maintenanceSection" },
];

/** Every control row in the table, in tab order — the keys `setControlValue` accepts. */
export const CONTROL_ROWS: ControlRow[] = SETTINGS_SECTIONS.flatMap((section) =>
  section.kind === "group"
    ? section.rows.filter((row): row is ControlRow => row.kind !== "render")
    : []
);
