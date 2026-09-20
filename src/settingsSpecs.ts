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
 */

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

export interface SliderRow {
  kind: "slider";
  key: SliderKey;
  name: string;
  desc: string;
  min: number;
  max: number;
  step: number;
}

export interface ToggleRow {
  kind: "toggle";
  key: ToggleKey;
  name: string;
  desc: string;
}

export interface DropdownRow {
  kind: "dropdown";
  key: DropdownKey;
  name: string;
  desc: string;
  options: ReadonlyArray<readonly [value: string, label: string]>;
}

export interface TextRow {
  kind: "text";
  key: TextKey;
  name: string;
  desc: string;
}

export type ControlRow = SliderRow | ToggleRow | DropdownRow | TextRow;

/** Rows built imperatively; both paths call the same builder for each id. */
export type RenderRowId =
  | "singleImageSize"
  | "resetAlignments"
  | "resetSingleImages"
  | "logLevel";

export interface RenderRow {
  kind: "render";
  id: RenderRowId;
  name: string;
  desc: string;
}

export type RowSpec = ControlRow | RenderRow;

/** Sections handed to an existing module, which brings both its own heading and
 *  its own rows — so the spec carries neither. */
export type HostId = "imageMenuSection" | "maintenanceSection";

export type SectionSpec =
  | { kind: "group"; heading: string; rows: RowSpec[] }
  | { kind: "host"; id: HostId };

export const SETTINGS_SECTIONS: SectionSpec[] = [
  {
    kind: "group",
    heading: "行布局与交互设置",
    rows: [
      {
        kind: "slider",
        key: "defaultRowHeight",
        name: "Default row height",
        desc: "Default uniform height (px) for image rows. Individual rows adapt based on image aspect ratios.",
        min: 80,
        max: 600,
        step: 10,
      },
      {
        kind: "slider",
        key: "maxImagesPerRow",
        name: "Max images per row",
        desc: "Maximum number of images allowed in a single row (1-10). Groups exceeding this limit are split.",
        min: 2,
        max: 10,
        step: 1,
      },
      {
        kind: "slider",
        key: "gapSize",
        name: "Gap size",
        desc: "Spacing between images in a row (px).",
        min: 0,
        max: 20,
        step: 1,
      },
      {
        kind: "slider",
        key: "snapSensitivity",
        name: "Snap sensitivity",
        desc: "When dragging a divider or resize handle, snap into place when the height difference between adjacent images falls within this percentage of their equilibrium (equal) height. Set to 0 to disable snapping.",
        min: 0,
        max: 10,
        step: 1,
      },
      {
        kind: "slider",
        key: "topBarSensitivity",
        name: "Top bar activation zone",
        desc: "Pixel distance from the top of a flex row within which the global-balance top bar appears (4-40 px).",
        min: 4,
        max: 40,
        step: 2,
      },
      {
        kind: "slider",
        key: "ghostImageWidth",
        name: "Ghost image width",
        desc: "Width (px) of the drag ghost image that follows the Cursor (100-500 px).",
        min: 100,
        max: 500,
        step: 10,
      },
      {
        kind: "slider",
        key: "dragOpacity",
        name: "Drag ghost opacity",
        desc: "Transparency of the original image during drag (10% = nearly opaque, 90% = very transparent).",
        min: 10,
        max: 90,
        step: 5,
      },
      {
        kind: "toggle",
        key: "enableDragReorder",
        name: "Enable drag reorder",
        desc: "Allow dragging images within a row to reorder them.",
      },
      {
        kind: "toggle",
        key: "enableResize",
        name: "Enable resize handles",
        desc: "Show corner resize handles on hover to adjust individual image sizes.",
      },
      {
        kind: "toggle",
        key: "enableDividers",
        name: "Enable column dividers",
        desc: "Show draggable dividers between images to adjust width ratios.",
      },
      {
        kind: "slider",
        key: "menuScalePercent",
        name: "Context menu size",
        desc: "Scale of the right-click image menu (50%–150%). Menu padding, spacing, fonts and icons scale together in 10% steps.",
        min: 50,
        max: 150,
        step: 10,
      },
      {
        kind: "text",
        key: "imageExtensions",
        name: "Image extensions",
        desc: "Comma-separated list of image file extensions to detect (e.g., PNG,JPG,GIF,webp).",
      },
    ],
  },
  {
    kind: "group",
    heading: "图片统一对齐设置",
    rows: [
      {
        kind: "dropdown",
        key: "alignment",
        name: "Image alignment",
        desc: "Global horizontal alignment for image rows. Per-image overrides set via right-click take priority.",
        options: [
          ["left", "Left"],
          ["center", "Center"],
          ["right", "Right"],
        ],
      },
      {
        kind: "render",
        id: "resetAlignments",
        name: "Reset image alignments",
        desc: "One-shot: clear every image's per-image alignment override and revert to the global setting above.",
      },
      {
        kind: "toggle",
        key: "enableReadingModeContextMenu",
        name: "Enable reading mode context menu",
        desc: "When enabled, right-clicking an image in reading mode shows the alignment menu. When disabled, reading mode is read-only — alignment can only be changed in live preview or source mode.",
      },
      {
        kind: "toggle",
        key: "enableReadingModeDoubleClickZoom",
        name: "Reading mode: double-click image to preview",
        desc: "When enabled, opening an image's preview in reading mode requires a double click instead of a single click. When disabled, reading mode keeps Obsidian's native single-click behavior.",
      },
    ],
  },
  {
    kind: "group",
    heading: "单图行图片尺寸设置",
    rows: [
      {
        kind: "render",
        id: "singleImageSize",
        name: "Single image size",
        desc: "How a lone image (a single-image row) is sized. The width is the one the picture takes across the page, whether it comes from here or from a manual corner-resize. Natural size shows images at their real pixel size, shrunk to fit the editor width; Fixed width renders single images at a set width. Rotating by 90° or 270° pins the image to the width it then shows, so the picture keeps the size it had; right-click「重置为设置宽度」hands it back to this setting.",
      },
      {
        kind: "render",
        id: "resetSingleImages",
        name: "Reset single image sizes",
        desc: "One-shot: clear every single image's manual size override and re-apply the current mode.",
      },
    ],
  },
  { kind: "host", id: "imageMenuSection" },
  {
    kind: "group",
    heading: "日志与调试设置",
    rows: [
      {
        kind: "render",
        id: "logLevel",
        name: "日志级别",
        desc: "低于所选级别的日志不会输出，同时作用于控制台与 log.txt。默认 error，仅记录错误。",
      },
      {
        kind: "toggle",
        key: "logToFile",
        name: "写入 log.txt",
        desc: "开启后，符合级别的日志写入插件目录下的 log.txt（开启时清空一次，便于读取本次会话）。",
      },
      {
        kind: "toggle",
        key: "geometryProbe",
        name: "诊断快照（临时）",
        desc: "开启后，布局过程中会把每张图的「模型 / 写入 / 实测」三组几何写入 log.txt（DIAAGEO 行），用于定位尺寸异常；快照忽略日志级别，但需 logToFile 通道可用。排查结束后请关闭。",
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
