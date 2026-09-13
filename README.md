# Drag Image Auto Arrange

Automatically arrange consecutive image embeds into side-by-side rows — like Feishu / Lark documents. Drag to reorder, drag the divider to resize, and each row keeps its own layout across sessions.

## Features

- **Automatic rows** — consecutive image embeds on adjacent lines are laid out side by side instead of stacking vertically.
- **Drag to reorder** — drag an image within a row, or onto another row, to move it.
- **Draggable dividers** — drag the divider between two images to shift the width split.
- **Height equalizer** — double-click the row's top balance line to make every image in a multi-image row the same height.
- **Corner handles** — drag a handle on an image's corner to change its size.
- **Per-image resize** — resize a standalone image, or pick a percentage of its natural width from the right-click menu.
- **Alignment** — align an image left, center, or right within its row.
- **Rotate / flip** — rotate by 90° / 180° and flip horizontally or vertically. The preview is applied live; the file is rewritten once, when the note is closed.
- **Right-click menu** — one unified menu for alignment, rotation, resizing, copy, cut, and file operations. Copy and cut put the bitmap on the clipboard together with the image's in-vault reference: pasting inside this vault lands as a `![[…]]` link instead of minting a duplicate attachment, while pasting into another vault or app yields the image itself — PNG and JPEG files go over byte-for-byte, lossy formats are re-encoded as JPEG. Cut additionally removes that one reference, and deletes the local file only when nothing else in the vault points at it.
- **Reading Mode support** — rows render in Reading Mode too, with editing operations greyed out.

## Installation

### From the community plugin directory

Search for **Drag Image Auto Arrange** in *Settings → Community plugins → Browse*, then install and enable it.

### Manually

Copy `main.js`, `manifest.json`, and `styles.css` into `<your vault>/.obsidian/plugins/drag-image-auto-arrange/`, then enable the plugin in *Settings → Community plugins*.

## Usage

Write image embeds on consecutive lines to place them in one row:

```markdown
![[sunset.png]]
![[harbor.png]]
![[market.png]]
```

The plugin detects the run of image lines, renders them as one row, and writes each member's layout back to the embed parameters as you drag and resize. A row with a single image is sized from the plugin settings until you resize it by hand.

Layout parameters are stored on the embed line itself, so the arrangement survives re-opening the note, syncing, and switching between Live Preview and Reading Mode.

## Settings

- **Max images per row** — how many consecutive images share one row.
- **Default row height / gap size** — base geometry for generated rows.
- **Image extensions** — which file extensions count as images.
- **Enable drag reorder / resize / dividers** — toggle individual interactions.
- **Log level and file logging** — diagnostics for troubleshooting; the release build is silent by default.

## Development

```bash
npm install
npm run dev     # watch build
npm run build   # type-check + production bundle
npm test        # unit tests
```

Releases are built and published by the workflow in `.github/workflows/release.yml`, which runs on any pushed tag and attaches `main.js`, `manifest.json`, and `styles.css` to the created Release.

## License

MIT — see [LICENSE](LICENSE).

---

# Drag Image Auto Arrange（中文）

自动把连续的图片嵌入排列成并排的多图行，效果类似飞书 / Lark 文档。可拖拽排序、拖拽分隔条调整宽度，每行都会各自记住布局。

## 功能

- **自动成行**：相邻行上的连续图片嵌入会自动并排显示，而不是逐张纵向堆叠。
- **拖拽排序**：可在行内拖动图片，也可拖到另一行，实现位置调整。
- **可拖拽分隔条**：拖动两张图之间的分隔条，即可改变宽度分配。
- **顶部均衡线**：双击多图行顶部的均衡线，即可快速让行内各图高度对齐。
- **角点手柄**：拖拽图像角点手柄即可改变图像大小。
- **单图缩放**：可缩放独立图片，也可在右键菜单中按原图宽度的百分比选择尺寸。
- **对齐**：可将图片在所在行内左对齐、居中或右对齐。
- **旋转 / 翻转**：支持 90° / 180° 旋转与水平、垂直翻转。预览实时生效，图片文件在关闭笔记时统一重写一次。
- **右键菜单**：对齐、旋转、缩放、复制、剪切与文件操作收敛在同一个菜单中。复制与剪切会把位图写入剪贴板，并一并带上该图在库内的引用：在本库粘贴落成 `![[…]]` 链接，而不是另存出一份重复附件；粘到其它仓库或 App 则落成图像本身 —— png / jpg 原样写入，webp、avif 等有损格式转码为 JPEG。剪切还会移除该处引用，并且仅当全库再无其他引用时才删除本地文件。
- **阅读模式支持**：多图行在阅读模式下同样渲染，编辑类操作置灰。

## 安装

### 从社区插件目录安装

在 *设置 → 第三方插件 → 浏览* 中搜索 **Drag Image Auto Arrange**，然后安装并启用。

### 手动安装

把 `main.js`、`manifest.json`、`styles.css` 复制到 `<你的库>/.obsidian/plugins/drag-image-auto-arrange/`，然后在 *设置 → 第三方插件* 中启用。

## 用法

把图片嵌入写在连续的行上，它们就会进入同一行：

```markdown
![[sunset.png]]
![[harbor.png]]
![[market.png]]
```

插件会识别这一串连续的图片行，将其渲染为一行；在你拖拽与缩放的同时，把每个成员的布局写回该嵌入行的参数中。只有一张图的单图行在手动缩放之前，会按插件设置决定尺寸。

布局参数保存在嵌入行本身，因此重新打开笔记、同步、以及在实时预览与阅读模式之间切换后，排版都能保持。

## 设置项

- **每行最多图片数**：一行最多容纳多少张连续图片。
- **默认行高 / 间距**：生成多图行时的基础几何参数。
- **图片扩展名**：哪些扩展名的文件被识别为图片。
- **启用拖拽排序 / 缩放 / 分隔条**：逐项开关各类交互。
- **日志级别与文件日志**：排障用的诊断开关；发布版默认静默。

## 开发

```bash
npm install
npm run dev     # 监听式构建
npm run build   # 类型检查 + 生产构建
npm test        # 单元测试
```

发布由 `.github/workflows/release.yml` 中的工作流完成：推送任意 Tag 即触发构建，并把 `main.js`、`manifest.json`、`styles.css` 作为附件上传到新建的 Release。

## 许可

MIT，详见 [LICENSE](LICENSE)。
