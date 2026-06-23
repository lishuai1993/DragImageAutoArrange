# DragImageAutoArrange — Obsidian 多图并列插件实现方案

> **审查状态：待审查**
>
> 本文档为技术可行性分析与实现方案，供审查后再进入开发阶段。

**目标：** 在 Obsidian 中实现类似飞书云文档的多图并列功能——自动检测连续的图片嵌入，将它们渲染为等高并列行，支持拖拽排序、分栏线调整和单张缩放。

**技术栈：** TypeScript, Obsidian Plugin API, CodeMirror 6 (ViewPlugin + Decorations), HTML5 Drag & Drop, CSS Flexbox

---

## 一、可行性分析

### 1.1 核心挑战

Obsidian 的编辑器基于 **CodeMirror 6**，是文本编辑器而非富文本编辑器。飞书云文档是富文本编辑器，其"拖拽图片到另一张图片边缘出现蓝色竖线→合并为同一行"的交互，依赖于富文本编辑器的块级拖拽系统。

**CodeMirror 6 中没有"块级拖拽合并"的概念**——拖拽选中的文本就是移动文本，拖拽图片 widget 的行为由 CodeMirror 内部控制。

### 1.2 逐项可行性判定

| 飞书功能 | Obsidian 可行性 | 说明 |
|---|---|---|
| 多图自动等高并列 | ✅ 可行 | CSS Flexbox + JS 高度计算，完全可实现 |
| 检测连续图片自动成组 | ✅ 可行 | 解析 markdown 文本，检测连续的 `![[image]]` 行 |
| 拖拽图片到另一张侧边合并 | ⚠️ 降级实现 | 无法复制"蓝色竖线"交互；改为：检测行相邻即自动成组 + 组内拖拽排序 |
| 批量从文件夹拖入并排 | ✅ 可行 | 拖入时检测多张图片，插入为连续行 |
| 拖拽分栏线调整宽度比 | ✅ 可行 | 在渲染的 widget DOM 中实现 |
| 拖拽四角圆点缩放单张 | ✅ 可行 | 在渲染的 widget DOM 中实现 |
| 增删图片自动重排 | ✅ 可行 | ResizeObserver + MutationObserver |
| 窗口宽度自适应 | ✅ 可行 | CSS + ResizeObserver |
| 最多 10 张限制 | ✅ 可行 | 检测时限制 |
| GIF 兼容 | ✅ 可行 | 浏览器原生支持 |
| 移动端 | ⚠️ 部分支持 | Reading mode 可渲染，拖拽交互在触屏上体验降级 |

### 1.3 已有插件对比

| 插件 | 方式 | 差距 |
|---|---|---|
| **Image Grid** | `` ```image-grid `` 代码块 | 需要手动写代码块语法，不支持拖拽排序 |
| **Horizontal Blocks** | `` ```horizontal `` 代码块 + `---` 分隔 | 需代码块语法，不是原生 `![[image]]` |
| **Better Edit** | 内联 HTML/CSS 样式 | 产生的 markdown 不可移植，依赖插件渲染 |
| **Nice Gallery** | `` ```gallery `` 代码块 | 静态画廊，无拖拽交互 |

**本插件的差异点：无需特殊语法，自动检测连续的 `![[image]]` 嵌入即视为并列组，markdown 保持纯文本可移植。**

---

## 二、核心设计思路

### 2.1 一句话架构

> **自动检测连续的 `![[image]]` 行 → 在渲染层替换为自定义 flex 容器 → 在容器上叠加拖拽/缩放交互 → 交互结果回写到 markdown 源文本。**

### 2.2 用户使用流程

```
用户写作时:
  ![[a.png]]          ← 单独一行
  ![[b.png]]          ← 紧邻上一行（无空行/无文字）
  ![[c.png]]          ← 紧邻

插件自动渲染为:
  ┌──────────────────────────────┐
  │  [a.png] | [b.png] | [c.png] │  ← 等高并列，可拖拽调整
  └──────────────────────────────┘

用户插入空行或文字即可"拆组":
  ![[a.png]]
                           ← 空行打断组
  ![[b.png]]

用户拖入多张图片 → 自动插入为连续行 → 自动成组
```

### 2.3 成组判定规则

连续的 imagemarkdown 行构成一个"组"：

1. 每一行**只包含** `![[...]]` 图片嵌入（允许行首空格）
2. 行与行之间**没有空行**、**没有文字**
3. 单组最多 **10 张**图片
4. 支持的图片格式：png, jpg, jpeg, gif, webp, svg, bmp, avif

---

## 三、技术架构

### 3.1 双模式渲染架构

```
                    ┌──────────────────────┐
                    │    imageDetector.ts   │
                    │  (检测连续的 ![[..]]  │
                    │   行，返回组列表)      │
                    └──────────┬───────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                                 ▼
   ┌──────────────────┐              ┌──────────────────┐
   │  readingMode.ts  │              │ livePreview.ts   │
   │ MarkdownPost-    │              │ CodeMirror       │
   │ Processor        │              │ ViewPlugin       │
   │ (Reading View)   │              │ (Live Preview)   │
   └────────┬─────────┘              └────────┬─────────┘
            │                                 │
            └─────────────┬───────────────────┘
                          ▼
              ┌──────────────────────┐
              │  ImageRowWidget.ts   │
              │  (渲染 flex 容器 +    │
              │   挂载交互管理器)     │
              └──────────┬───────────┘
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
  ┌────────────┐ ┌────────────┐ ┌────────────┐
  │dragManager │ │resizeMgr  │ │dividerMgr  │
  │ (拖拽排序) │ │ (四角缩放) │ │ (分栏线)   │
  └────────────┘ └────────────┘ └────────────┘
```

### 3.2 文件结构

```
obsidian-DragImageAutoArrange/
├── src/
│   ├── main.ts                 # 插件入口：注册所有 processor/view/command
│   ├── settings.ts             # 设置 Tab（最大图片数、默认行高、开关）
│   ├── constants.ts            # 常量：CSS 类名、正则、默认值
│   ├── imageDetector.ts        # 纯函数：从 markdown 文本检测图片组
│   ├── layoutEngine.ts         # 纯函数：计算统一高度下的各图宽度
│   ├── readingMode.ts          # MarkdownPostProcessor 实现
│   ├── livePreview.ts          # CodeMirror ViewPlugin + DecorationSet
│   ├── imageRowWidget.ts       # DOM 构建：flex 容器 + 单张图片 DOM
│   ├── dragManager.ts          # HTML5 DnD：组内拖拽排序
│   ├── resizeManager.ts        # 鼠标事件：四角缩放圆点
│   ├── dividerManager.ts       # 鼠标事件：分栏线拖拽
│   └── utils.ts                # 工具函数（解析 wikilink、获取图片路径等）
├── styles.css                  # 所有 CSS 样式
├── manifest.json               # Obsidian 插件清单
├── package.json
├── tsconfig.json
├── esbuild.config.mjs
└── versions.json
```

### 3.3 关键接口设计

```typescript
// imageDetector.ts
interface ImageGroup {
  lineStart: number;    // 起始行号 (0-based)
  lineEnd: number;      // 结束行号 (exclusive)
  images: ImageEmbed[]; // 组内图片列表
}
interface ImageEmbed {
  line: number;         // 行号
  raw: string;          // 原始文本 "![[image.png]]"
  fileName: string;     // "image.png"
  width: number | null; // 用户指定的宽度（来自 |200 语法）
  flexGrow: number;     // 当前 flex-grow 值，默认 1
}

// layoutEngine.ts
function computeUniformHeight(
  images: ImageMeta[],     // 图片元数据（原始宽高）
  containerWidth: number,  // 容器可用宽度
  gap: number             // 间距
): LayoutResult;           // 统一高度 + 各图片渲染宽度

// imageRowWidget.ts
class ImageRowWidget {
  constructor(group: ImageGroup, sourceCallback: EditCallback);
  mount(container: HTMLElement): void;
  update(group: ImageGroup): boolean;  // 返回 false 表示无需重建
  destroy(): void;
}
```

---

## 四、分阶段实现计划

### 阶段 0：工程搭建

#### Task 0: 初始化项目脚手架

**创建文件：** `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `manifest.json`

- [ ] `npm init -y` 并安装依赖：`obsidian`, `@codemirror/view`, `@codemirror/state`, `typescript`, `esbuild`
- [ ] 配置 `tsconfig.json`（target: ES2020, module: commonjs）
- [ ] 配置 `esbuild.config.mjs`（打包为 commonjs 格式，external: obsidian）
- [ ] 编写 `manifest.json`（id: drag-image-auto-arrange, name, description）
- [ ] 验证：`npm run build` 成功输出 `main.js`

---

### 阶段 1：核心检测与渲染（MVP）

#### Task 1: 实现 imageDetector（核心检测逻辑）

**创建文件：** `src/imageDetector.ts`, `src/constants.ts`

纯函数模块，不依赖 Obsidian API：

```typescript
// 正则：匹配单独一行的图片嵌入
const IMAGE_LINE_RE = /^\s*!\[\[([^\]]+\.(png|jpg|jpeg|gif|webp|svg|bmp|avif))\]\](\|[0-9]+)?\s*$/i;

function detectImageGroups(text: string, maxImages: number): ImageGroup[];
```

- [ ] 将文本按 `\n` 分行
- [ ] 逐行匹配 `IMAGE_LINE_RE`
- [ ] 将连续匹配的行合并为一个 `ImageGroup`
- [ ] 超限时自动拆组（每 10 张为一组）
- [ ] 编写单元测试（纯函数，无需 Obsidian 环境即可测试）

#### Task 2: 实现 Reading Mode 渲染

**创建文件：** `src/readingMode.ts`, `src/imageRowWidget.ts`

- [ ] 注册 `MarkdownPostProcessor`
- [ ] 在渲染后的 DOM 中找到连续的 `<img>` 元素（位于 `.image-embed` 容器内）
- [ ] 将它们包裹在 flex 容器中
- [ ] 应用 CSS：`display: flex; align-items: flex-start; gap: 4px;`
- [ ] 实现等比例等高缩放：JS 读取各图片的 `naturalWidth/naturalHeight`，计算统一高度

**Reading Mode 的优势：** DOM 结构由 Obsidian 完全渲染，我们只需要：
1. `el.querySelectorAll('.image-embed img')` 找到所有图片
2. 检测它们在 DOM 中是否连续（相邻且父元素为相邻的 `<p>` 标签）
3. 包装为 flex 容器

#### Task 3: 实现 Live Preview 渲染

**创建文件：** `src/livePreview.ts`

这是最核心也最复杂的部分。使用 CodeMirror `ViewPlugin` + `Decoration.replace`：

```typescript
import { ViewPlugin, Decoration, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

// 方案：扫描整个文档（不仅是可视区），找到所有 ImageGroup
// 对每个 group，使用 Decoration.replace 替换整个文本范围
// Widget 内渲染 flex 容器

class ImageRowReplacementWidget extends WidgetType {
  // toDOM() 返回 flex 容器，渲染所有图片
  // eq() 比较 group 是否相同，避免不必要重建
}

const imageGridPlugin = ViewPlugin.fromClass(/* ... */, {
  decorations: v => v.decorations
});
```

关键点：
- 使用 `Prec.high()` 确保我们的 decoration 优先于 Obsidian 默认的 embed 渲染
- 需要在 `StateField` 而非 `ViewPlugin` 中管理 decorations（因为需要覆盖视口外的内容）
- Widget 的 `toDOM()` 必须在图片加载完成后重新计算高度

#### Task 4: 样式编写

**创建文件：** `styles.css`

- [ ] Flex 容器样式：`.drag-image-row { display: flex; align-items: flex-start; }`
- [ ] 图片样式：`.drag-image-row .image-item { flex-grow: 1; flex-basis: 0; overflow: hidden; }`
- [ ] 分栏线样式：`.drag-image-row .divider { width: 4px; cursor: col-resize; }`
- [ ] 缩放圆点样式：`.image-item .resize-handle { position: absolute; width: 8px; height: 8px; }`
- [ ] 拖拽预览样式：`.image-item.dragging { opacity: 0.5; }`
- [ ] 空状态：无

---

### 阶段 2：交互功能

#### Task 5: 组内拖拽排序

**创建文件：** `src/dragManager.ts`

- [ ] 在每张图片上设置 `draggable="true"`
- [ ] `dragstart`：保存被拖拽图片索引，设置拖拽图像
- [ ] `dragover`：计算插入位置，显示插入指示线
- [ ] `drop`：重新排列图片，更新 ImageGroup.images 顺序
- [ ] 通过 `EditCallback` 回写：交换对应行在 markdown 中的位置
- [ ] 动画过渡：CSS `transition: transform 0.2s`

```typescript
class DragManager {
  constructor(
    container: HTMLElement,
    images: HTMLElement[],
    onReorder: (fromIndex: number, toIndex: number) => void
  );
  attach(): void;
  detach(): void;
}
```

#### Task 6: 图片四角缩放

**创建文件：** `src/resizeManager.ts`

- [ ] 鼠标 hover 图片时，显示四个角的圆形手柄
- [ ] `mousedown` 在手柄上：开始缩放
- [ ] `mousemove`：计算新宽度，更新图片 `flex-grow` 样式
- [ ] `mouseup`：保存新的宽度比例到 markdown（使用 `|width` 语法）
- [ ] 约束：最小宽度 50px，保持宽高比

#### Task 7: 分栏线拖拽

**创建文件：** `src/dividerManager.ts`

- [ ] 在每两张图片之间渲染一个 4px 宽的分栏线
- [ ] `mousedown` 在分栏线上：开始拖拽
- [ ] `mousemove`：计算新的 flex-grow 比例
- [ ] `mouseup`：保存比例到 markdown
- [ ] 视觉反馈：hover 时高亮变蓝（类似飞书的蓝色分栏线）

#### Task 8: 批量拖入多张图片

**在 `src/main.ts` 中注册事件处理器**

- [ ] 监听编辑器的 `drop` 事件
- [ ] 检测是否有多个图片文件被拖入
- [ ] 拦截默认行为，改为插入连续的 `![[image1]]\n![[image2]]` 行
- [ ] 触发重新检测和渲染

---

### 阶段 3：自适应与联动

#### Task 9: 窗口/容器宽度自适应

- [ ] 使用 `ResizeObserver` 监听 flex 容器大小变化
- [ ] 触发 `layoutEngine` 重新计算
- [ ] 更新各图片的渲染尺寸
- [ ] 防抖处理（100ms）

#### Task 10: 增删图片自动重排

- [ ] 监听文档变化（CodeMirror `update.docChanged`）
- [ ] 检测图片组的边界是否变化
- [ ] 新增图片进入组 → 自动纳入并列
- [ ] 删除组内图片 → 重新计算宽高
- [ ] 组内图片被文字/空行打断 → 自动拆组

---

### 阶段 4：用户体验

#### Task 11: 设置面板

**创建文件：** `src/settings.ts`

```typescript
interface DragImageSettings {
  enabled: boolean;           // 总开关，默认 true
  defaultRowHeight: number;   // 默认统一高度 (px)，默认 200
  maxImagesPerRow: number;    // 单行最大图片数，默认 10
  gapSize: number;            // 图片间距 (px)，默认 4
  enableDragReorder: boolean; // 拖拽排序，默认 true
  enableResize: boolean;      // 角点缩放，默认 true
  enableDividers: boolean;    // 分栏线，默认 true
  imageExtensions: string;    // 识别的图片后缀，默认 "png,jpg,jpeg,gif,webp,svg,bmp"
}
```

- [ ] 注册 SettingTab
- [ ] 每个设置项有对应的 UI 控件
- [ ] 设置变更后触发全局刷新

#### Task 12: 命令注册

- [ ] `重新扫描当前文档中的图片组`
- [ ] `切换多图并列功能（开/关）`
- [ ] `将选中图片合并为并列组`
- [ ] `将选中图片组拆分为独立图片`

#### Task 13: 错误处理

- [ ] 图片加载失败时显示占位符
- [ ] 文件不存在时显示 broken image 图标
- [ ] 超大图片（如 5000px+ 宽）的性能保护

---

## 五、风险与降级策略

| 风险 | 概率 | 影响 | 降级策略 |
|---|---|---|---|
| Live Preview 中与 Obsidian 内置 embed 渲染冲突 | 中 | 图片重复渲染 | 使用 `Prec.high()` 提升优先级；检测到冲突时回退到 CSS-only 方案 |
| CodeMirror widget 中图片加载时序问题 | 中 | 初始高度为 0 | 图片 `onload` 后触发 `view.requestMeasure()`，重新计算 |
| 大文档性能问题 | 低 | 滚动卡顿 | 仅处理可视区 + 前后 buffer；懒加载图片 |
| Obsidian API 版本不兼容 | 低 | 插件不工作 | `manifest.json` 中锁定 `minAppVersion`，CI 测试多版本 |
| 与 Image Grid 等插件共存时冲突 | 低 | 样式混乱 | 使用特定的 CSS 命名空间 `.drag-image-*`，不覆盖通用样式 |

### 降级方案（如 Live Preview ViewPlugin 方案受阻）

如果 CodeMirror ViewPlugin 与 Obsidian 内置渲染冲突严重，可降级为：

1. **Live Preview 中仅用 CSS**：通过 CodeMirror 的 `Decoration.line` 给连续图片行加 `class`，CSS 中尝试用 `display: contents` 或 `flex` 改造布局
2. **放弃 Live Preview 的拖拽交互**：仅在 Reading Mode 中提供完整交互，Live Preview 中只做静态渲染

---

## 六、未实现/降级的飞书功能

以下功能**明确不在第一版范围内**：

1. **拖拽到图片边缘出现蓝色竖线的交互** — CodeMirror 不支持这种富文本级别的拖拽反馈
2. **移动端拖拽** — 移动端仅渲染静态并列，不提供拖拽交互
3. **图片 hover 工具栏（如"重置尺寸"按钮）** — 可用右键菜单代替
4. **混合内容行等宽非等高** — 仅支持纯图片行

---

## 七、审查要点

请审查以下关键决策：

1. **自动检测 vs 显式语法**：当前方案采用自动检测连续的 `![[image]]` 行。是否考虑增加显式标记（如 `%%image-group%%` 注释）作为保底方案？
2. **Live Preview 的 ViewPlugin + Decoration.replace 方案**：这是最复杂的部分。是否接受如果此方案受阻，降级为 CSS-only？
3. **图片宽度记忆**：当前方案通过 `![[image.png|200]]` 的 Obsidian 原生宽度语法记忆用户调整。是否足够？
4. **功能范围**：第一版是否只做到阶段 1+2（检测+渲染+交互）？阶段 3+4 的自适应和 UX 优化是否可后续迭代？
