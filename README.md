# Drag Image Auto Arrange

Automatically arrange consecutive image embeds into side-by-side rows — like Feishu / Lark documents. Drag to reorder, drag the divider to resize, and each row keeps its own layout across sessions.

## Features

- **Automatic rows** — consecutive image embeds on adjacent lines are laid out side by side instead of stacking vertically.
- **Drag to reorder** — drag an image within a row, or onto another row, to move it.
- **Draggable dividers** — drag the divider between two images to shift the width split.
- **Height equalizer** — double-click the row's top balance line to make every image in a multi-image row the same height. Dragging an image's own top or bottom edge snaps it to an equal-height neighbour and lights that side's balance bar.
- **Corner handles** — drag a handle on an image's corner to change its size. In a multi-image row, dragging outward stops once the image exactly fills its cell, and near full width it snaps silently to full: past that point neither the image nor the row height moves, and the note is not written.
- **Per-image resize** — resize a standalone image, or pick a percentage of its natural width from the right-click menu.
- **Alignment** — align an image left, center, or right within its row.
- **Rotate / flip** — rotate by 90° / 180° and flip horizontally or vertically. The orientation is stored as a parameter on the note line (a readable word such as `r90` / `fv`), so the image file itself is never re-encoded and each change is a single undoable edit. Reset returns the image to its original orientation.
- **Right-click menu** — one unified menu for alignment, rotation, resizing, copy, cut, and file operations. Copy and cut put the bitmap on the clipboard together with the image's in-vault reference: pasting inside this vault lands as a `![[…]]` link instead of minting a duplicate attachment, while pasting into another vault or app yields the image itself — PNG and JPEG files go over byte-for-byte, lossy formats are re-encoded as JPEG. Cut additionally removes that one reference, and deletes the local file only when nothing else in the vault points at it. The whole menu has a master switch in the settings tab: turn it off and images go back to Obsidian and to any other image plugin, with the command that turns it back on copied to your clipboard.
- **Reading Mode support** — rows render in Reading Mode too, including each image's rotate/flip orientation; editing operations are greyed out.
- **Interface language** — the settings tab and the image right-click menu switch between Chinese and English from one control at the top of the settings tab; English is the default. Command names are registered in both languages, so the command palette finds them whichever one you use.
- **Vault-wide maintenance** — two passes in the settings tab: clear everything the plugin wrote out of every note, or normalise every line it can host into the standard parameter form. Both scan the vault and show you the exact scope before writing.

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

- **Interface language** — Chinese or English for everything the plugin draws; English is the default.
- **Max images per row** — how many consecutive images share one row.
- **Default row height / gap size** — base geometry for generated rows.
- **Image extensions** — which file extensions count as images.
- **Enable drag reorder / resize / dividers** — toggle individual interactions.
- **Snap sensitivity** — how close a drag has to get before it snaps to a neighbour or to full width; set it to 0 to turn snapping off.
- **Image context menu** — the menu's own section holds its master switch and the order of its file operations.
- **Log level and file logging** — diagnostics for troubleshooting; the release build is silent by default.

## Maintenance

The foot of the plugin's settings tab holds two vault-wide passes. Both scan first and show the exact scope — how many notes were read, how many lines matched, how many files are involved — and only write after you confirm. Notes currently open are written through an editor transaction (a single `cmd+z` undoes the whole note); the rest go through `vault.process`. Files that fail are counted and named in `log.txt`.

- **Clear DIAA format (this vault)** — puts every image reference the plugin wrote back into Obsidian's own form, so uninstalling leaves nothing behind. An image alone on its line loses its whole parameter run; a reference inside prose, a list or a quote only loses the orientation / alignment words the plugin added, keeping Obsidian's own `|width` and `|widthxheight`. Run this before uninstalling; after clearing, disable the plugin immediately.
- **Normalise to the standard form (this vault)** — writes the two word slots (orientation, alignment) into every line the plugin can host, so a later rotate is a word-for-word replacement instead of the first write that grows the line's parameter run. Numeric slots are left untouched: a row's share follows from every member's natural pixel size and its fill ratio from the measured layout, neither of which exists before the row first renders, and a number invented here would be pinned as an explicit parameter. A hand-written `|400` / `|400x300` on a single-image row is kept as a manual width (`|1|400`).

Both passes are irreversible on notes already saved to disk. While the plugin is enabled, opening or editing a note writes its parameters back on the first frame — so to uninstall, close the open notes first, run **Clear DIAA format**, then disable the plugin immediately.

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
- **顶部均衡线**：双击多图行顶部的均衡线，即可快速让行内各图高度对齐；拖拽图片自身的上下边框时，会与等高的邻居吸附，并点亮该侧的均衡条。
- **角点手柄**：拖拽图像角点手柄即可改变图像大小。在多图行中，向外拖到图片恰好铺满本格即止，接近满格时会静默吸到满格；越过该点后图片与行高都不再变化，笔记也不会被写入。
- **单图缩放**：可缩放独立图片，也可在右键菜单中按原图宽度的百分比选择尺寸。
- **对齐**：可将图片在所在行内左对齐、居中或右对齐。
- **旋转 / 翻转**：支持 90° / 180° 旋转与水平、垂直翻转。朝向以行参数的形式写回笔记（可读词，如 `r90` / `fv`），原图文件自始至终不被重编码，每次操作都是一步可撤销的编辑；重置后回到原始朝向。
- **右键菜单**：对齐、旋转、缩放、复制、剪切与文件操作收敛在同一个菜单中。复制与剪切会把位图写入剪贴板，并一并带上该图在库内的引用：在本库粘贴落成 `![[…]]` 链接，而不是另存出一份重复附件；粘到其它仓库或 App 则落成图像本身 —— png / jpg 原样写入，webp、avif 等有损格式转码为 JPEG。剪切还会移除该处引用，并且仅当全库再无其他引用时才删除本地文件。整个菜单在设置页有总开关：关闭后图片交还 Obsidian 与其他图片插件处理，同时把重新开启的命令复制到剪贴板。
- **阅读模式支持**：多图行在阅读模式下同样渲染，旋转 / 翻转朝向一并呈现，编辑类操作置灰。
- **界面语言**：设置页最上方一个切换控件即可在中文与 English 之间切换设置页与图片右键菜单的语言，默认英文。命令名中英并排注册，命令面板在哪种语言下都能搜到。
- **全库格式维护**：设置页提供两个全库动作 —— 把插件写入的参数从全部笔记中清除，或把所有可托管的图片行归一化为标准参数格式。两者都先扫描、把改动范围显示给你，确认之后才写入。

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

- **界面语言**：插件自绘界面用中文还是 English；默认英文。
- **每行最多图片数**：一行最多容纳多少张连续图片。
- **默认行高 / 间距**：生成多图行时的基础几何参数。
- **图片扩展名**：哪些扩展名的文件被识别为图片。
- **启用拖拽排序 / 缩放 / 分隔条**：逐项开关各类交互。
- **吸附灵敏度**：拖拽要接近到什么程度才吸附到邻居或满格；设为 0 即关闭吸附。
- **图片右键菜单**：该板块自带总开关，以及菜单内文件操作的排列顺序。
- **日志级别与文件日志**：排障用的诊断开关；发布版默认静默。

## 维护

插件设置页底部有两个全库动作。两者都是先扫描、把改动范围显示给你（读过多少笔记、命中多少行、涉及多少文件），确认之后才写入。正在编辑器里打开的笔记走编辑器事务（该笔记一次 `cmd+z` 可整体撤销），其余文件走 `vault.process`；写失败的文件会计数并在 `log.txt` 中留痕。

- **清除 DIAA 格式（本库）**：把插件写入的图片参数还原为 Obsidian 原生形式，卸载插件后不在笔记里留痕。独处一行的图片清掉整个参数段；正文、列表、引用块里的图片只清插件加上的朝向 / 对齐词，Obsidian 原生的 `|宽度`、`|宽x高` 保留。卸载前先执行本动作，清除完成后立即停用插件。
- **归一化为标准格式（本库）**：为所有可托管的图片行补上两个词槽（朝向、对齐），此后旋转都是等长替换，而不是首次撑开参数段的那一次写入。数值槽一律不动 —— 份额取决于各成员的自然像素尺寸、填充比取决于实测布局，两者在行首次渲染前都不存在，在这里硬写一个数会被固定为显式参数。单图行手写的 `|400` / `|400x300` 会保留为手动宽度（`|1|400`）。

两个动作对已保存到磁盘的笔记都不可撤销。插件启用期间，笔记只要被打开或编辑，参数就会在第一帧被重新写回 —— 若要卸载，请先关闭所有打开的笔记，执行「清除 DIAA 格式」，然后立即停用插件。

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
