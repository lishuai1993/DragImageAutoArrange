#!/usr/bin/env python3
"""
Markdown 标题规范化工具
支持 Windows / macOS / Linux

用法:
    # 交互对比模式(默认) —— 自动打开浏览器对比,确认后写回
    python normalize_headings.py doc1.md doc2.md

    # 直接写回(跳过对比)
    python normalize_headings.py doc1.md --in-place

    # 仅生成预览文件
    python normalize_headings.py doc1.md --preview

    # 管道模式
    cat doc.md | python normalize_headings.py --stdin
"""

import re
import sys
import json
import argparse
import difflib
import webbrowser
import threading
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler

# ── 中文数字映射 ──────────────────────────────────────────────

_CN_NUMS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"]


def _to_cn(num: int) -> str:
    """阿拉伯数字 -> 中文数字 (1~99)"""
    if num <= 0:
        return str(num)
    if num <= 10:
        return _CN_NUMS[num]
    if num < 20:
        return f"十{_CN_NUMS[num - 10] if num > 10 else ''}"
    tens = num // 10
    ones = num % 10
    if ones == 0:
        return f"{_CN_NUMS[tens]}十"
    return f"{_CN_NUMS[tens]}十{_CN_NUMS[ones]}"


# ── 标题规范化 ────────────────────────────────────────────────

_HEADING_RE = re.compile(
    r"^(#{1,6})\s*"
    r"(?:"
    r"[一二三四五六七八九十]+、\s*"
    r"|\d+(?:\.\d+)*\.?\s*"
    r")?"
    r"(.*)",
    re.UNICODE,
)


def _find_min_heading_level(text: str) -> int | None:
    """找到文档中标题的最高层级(最小 # 数量),无标题返回 None。"""
    min_level = 7
    for line in text.splitlines():
        m = _HEADING_RE.match(line)
        if m:
            min_level = min(min_level, len(m.group(1)))
    return min_level if min_level <= 6 else None


def normalize_headings(md_text: str, base_level: int = 1) -> str:
    """处理单篇 markdown 文本,返回规范化后的文本。

    参数:
        md_text: 原始 markdown 文本
        base_level: 最高标题提升到的层级(1~4),设为 0 则维持原始层级不变
    """
    min_level = _find_min_heading_level(md_text)
    if min_level is None:
        return md_text  # 无标题,原样返回

    # 物理层级偏移量(控制 # 数量的增减)
    if base_level == 0:
        physical_offset = 0
    else:
        # offset ≤0 将最高层级提升; >0 则将最高层级降级
        physical_offset = base_level - min_level

    # 编号体系基准: 输出后最高层级对应的物理 # 数量
    numbering_base = min_level + physical_offset
    if numbering_base < 1:
        numbering_base = 1

    counters = [0, 0, 0, 0]
    lines = md_text.splitlines(keepends=True)
    result: list[str] = []

    for line in lines:
        m = _HEADING_RE.match(line.rstrip("\n\r"))
        if not m:
            result.append(line)
            continue

        hashes = m.group(1)
        original_level = len(hashes)
        title = m.group(2).strip() if m.group(2) else ""

        # 应用物理层级偏移,限制在 1~4 级
        physical_level = original_level + physical_offset
        if physical_level < 1:
            physical_level = 1
        if physical_level > 4:
            result.append(line)  # 超出 4 级的保留原文
            continue

        # 逻辑层级: 相对于编号基准,用于决定编号格式
        relative_level = physical_level - numbering_base + 1
        if relative_level < 1:
            relative_level = 1
        if relative_level > 4:
            result.append(line)
            continue

        idx = relative_level - 1
        counters[idx] += 1
        for i in range(idx + 1, 4):
            counters[i] = 0

        if relative_level == 1:
            num_str = f"{_to_cn(counters[0])}、"
        elif relative_level == 2:
            num_str = f"{counters[0]}.{counters[1]}"
        elif relative_level == 3:
            num_str = f"{counters[0]}.{counters[1]}.{counters[2]}"
        else:
            num_str = str(counters[3])

        title = title.lstrip()
        new_hashes = "#" * physical_level

        if relative_level == 1:
            new_line = f"{new_hashes} {num_str}{title}\n"
        elif relative_level == 4:
            new_line = f"{new_hashes} {num_str}. {title}\n"
        else:
            new_line = f"{new_hashes} {num_str} {title}\n"

        result.append(new_line)

    return "".join(result)


# ── 按行 diff ─────────────────────────────────────────────────

def _compute_diff(old_text: str, new_text: str) -> list[dict]:
    """逐行对比,返回结构化 diff 块列表。"""
    old_lines = old_text.splitlines(keepends=True)
    new_lines = new_text.splitlines(keepends=True)

    sm = difflib.SequenceMatcher(None, old_lines, new_lines)
    blocks: list[dict] = []

    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        block = {
            "type": tag,
            "old_lines": old_lines[i1:i2],
            "new_lines": new_lines[j1:j2],
        }
        blocks.append(block)

    return blocks


# ── HTML 页面模板 ─────────────────────────────────────────────

HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>标题规范化 —— 对比预览</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei","Hiragino Sans GB","Helvetica Neue",sans-serif;background:#1e1e1e;color:#d4d4d4;overflow:hidden;height:100vh;display:flex;flex-direction:column}

/* 顶栏 */
.toolbar{display:flex;align-items:center;gap:12px;padding:10px 20px;background:#252526;border-bottom:1px solid #3c3c3c;flex-shrink:0}
.toolbar .title{font-size:15px;font-weight:600;color:#e0e0e0;white-space:nowrap}
.toolbar select{background:#3c3c3c;color:#e0e0e0;border:1px solid #555;padding:6px 10px;border-radius:4px;font-size:13px;min-width:200px}
.toolbar .spacer{flex:1}
.btn{padding:7px 18px;border:none;border-radius:4px;font-size:13px;cursor:pointer;font-weight:600;transition:opacity .15s}
.btn:hover{opacity:.85}
.btn-confirm{background:#0e639c;color:#fff}
.btn-confirm-all{background:#16825d;color:#fff}
.btn-back{background:#5a1d1d;color:#fff}
.btn:disabled{opacity:.4;cursor:not-allowed}
.status{font-size:12px;padding:4px 10px;border-radius:3px}
.status-pending{background:#555;color:#ccc}
.status-done{background:#185727;color:#8f8}

/* 主区域 */
.main{flex:1;display:flex;overflow:hidden;position:relative}
.panel{flex:1;overflow-y:auto;overflow-x:auto;position:relative}
.panel::-webkit-scrollbar{width:8px}
.panel::-webkit-scrollbar-track{background:#1e1e1e}
.panel::-webkit-scrollbar-thumb{background:#424242;border-radius:4px}
.divider{width:4px;background:#3c3c3c;cursor:col-resize;flex-shrink:0;transition:background .15s}
.divider:hover{background:#0e639c}

.panel-header{position:sticky;top:0;z-index:2;background:#2d2d2d;padding:8px 16px;font-size:13px;font-weight:600;border-bottom:1px solid #3c3c3c;display:flex;justify-content:space-between}
.panel-header .change-count{font-weight:400;font-size:11px;color:#999}

/* diff 行 */
.line-row{display:flex;font-family:"SF Mono","Cascadia Code","Fira Code","JetBrains Mono",Menlo,Consolas,monospace;font-size:13px;line-height:22px;min-height:22px;white-space:pre}
.line-num{width:48px;min-width:48px;text-align:right;padding-right:12px;color:#858585;user-select:none;flex-shrink:0}
.line-text{flex:1;padding-right:8px;overflow:hidden}

/* diff 高亮 */
.line-eq{background:transparent}
.line-eq .line-text{color:#d4d4d4}
.line-ins{background:#1a3a1a}
.line-ins .line-text{color:#a5d6a5}
.line-del{background:#3a1a1a}
.line-del .line-text{color:#ef9a9a}
.line-chg{background:#3a3510}
.line-chg .line-text{color:#ffe082}
.line-skip{border-top:1px dashed #555;border-bottom:1px dashed #555;text-align:center;color:#888;font-style:italic;padding:4px 0}
.line-skip .line-text{color:#888;text-align:center;width:100%}

/* 空行占位 (左右行数不同步时) */
.line-empty{background:#1a1a1a}

/* 底部状态栏 */
.footer{display:flex;align-items:center;gap:10px;padding:6px 20px;background:#252526;border-top:1px solid #3c3c3c;font-size:12px;color:#888;flex-shrink:0}

/* toast */
.toast{position:fixed;bottom:60px;left:50%;transform:translateX(-50%);padding:10px 24px;border-radius:6px;font-size:14px;z-index:99;pointer-events:none;animation:fadeOut 2s forwards}
.toast-ok{background:#185727;color:#8f8}
.toast-err{background:#5a1d1d;color:#f88}
@keyframes fadeOut{0%,70%{opacity:1}100%{opacity:0}}
</style>
</head>
<body>

<div class="toolbar">
  <span class="title">📝 标题规范化 —— 对比预览</span>
  <span style="color:#666">|</span>
  <select id="fileSelect"></select>
  <span class="spacer"></span>
  <span class="status status-pending" id="statusBadge">待确认</span>
  <button class="btn btn-back" onclick="goBack()" title="放弃当前文件的修改">↩ 放弃</button>
  <button class="btn btn-confirm" onclick="confirmCurrent()">✓ 确认写入</button>
  <button class="btn btn-confirm-all" onclick="confirmAll()">✓ 全部确认</button>
</div>

<div class="main">
  <div class="panel" id="leftPanel">
    <div class="panel-header">
      <span>📄 原始文档</span>
      <span class="change-count" id="leftCount"></span>
    </div>
    <div id="leftContent"></div>
  </div>
  <div class="divider" id="divider"></div>
  <div class="panel" id="rightPanel">
    <div class="panel-header">
      <span>✅ 规范化后</span>
      <span class="change-count" id="rightCount"></span>
    </div>
    <div id="rightContent"></div>
  </div>
</div>

<div class="footer">
  <span>← 原始</span><span style="color:#555">|</span><span>规范化 →</span>
  <span class="spacer"></span>
  <span id="footerInfo"></span>
</div>
</body>
<script>
// ── 数据 ──
const FILE_DATA = __FILE_DATA_PLACEHOLDER__;

let currentIndex = 0;
let confirmedSet = new Set();

// ── 渲染 ──
function renderDiff(container, lines, side) {
  let html = '';
  for (const ln of lines) {
    let cls = '';
    if (ln.type === 'equal')   cls = 'line-eq';
    else if (ln.type === 'insert' && side === 'right') cls = 'line-ins';
    else if (ln.type === 'delete' && side === 'left')  cls = 'line-del';
    else if (ln.type === 'replace') cls = 'line-chg';
    else if (ln.type === 'skip')    cls = 'line-skip';

    if (ln.type === 'delete' && side === 'right') {
      html += `<div class="line-row line-empty"><span class="line-num"></span><span class="line-text"></span></div>`;
    } else if (ln.type === 'insert' && side === 'left') {
      html += `<div class="line-row line-empty"><span class="line-num"></span><span class="line-text"></span></div>`;
    } else {
      const num = side === 'left' ? ln.oldNum : ln.newNum;
      const text = (side === 'left' ? ln.oldText : ln.newText) || '';
      html += `<div class="line-row ${cls}"><span class="line-num">${num||''}</span><span class="line-text">${escHtml(text)}</span></div>`;
    }
  }
  container.innerHTML = html;
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// 将 diff blocks 展平为行级视图
function flattenBlocks(blocks) {
  const leftLines = [], rightLines = [];
  let oldNum = 0, newNum = 0;

  for (const b of blocks) {
    if (b.type === 'equal') {
      for (let i = 0; i < b.old_lines.length; i++) {
        oldNum++; newNum++;
        leftLines.push({type:'equal', oldNum, oldText:b.old_lines[i], newNum, newText:b.new_lines[i]});
        rightLines.push({type:'equal', oldNum, oldText:b.old_lines[i], newNum, newText:b.new_lines[i]});
      }
    } else if (b.type === 'replace') {
      const maxLen = Math.max(b.old_lines.length, b.new_lines.length);
      for (let i = 0; i < maxLen; i++) {
        const hasOld = i < b.old_lines.length;
        const hasNew = i < b.new_lines.length;
        if (hasOld) oldNum++;
        if (hasNew) newNum++;
        leftLines.push({
          type: hasOld ? 'replace' : 'insert',
          oldNum: hasOld ? oldNum : null,
          oldText: hasOld ? b.old_lines[i] : '',
          newNum: null, newText: ''
        });
        rightLines.push({
          type: hasNew ? 'replace' : 'delete',
          oldNum: null, oldText: '',
          newNum: hasNew ? newNum : null,
          newText: hasNew ? b.new_lines[i] : ''
        });
      }
    } else if (b.type === 'delete') {
      for (const l of b.old_lines) {
        oldNum++;
        leftLines.push({type:'delete', oldNum, oldText:l, newNum:null, newText:''});
        rightLines.push({type:'delete', oldNum:null, oldText:'', newNum:null, newText:''});
      }
    } else if (b.type === 'insert') {
      for (const l of b.new_lines) {
        newNum++;
        leftLines.push({type:'insert', oldNum:null, oldText:'', newNum:null, newText:''});
        rightLines.push({type:'insert', oldNum:null, oldText:'', newNum, newText:l});
      }
    }
  }
  return {leftLines, rightLines};
}

// ── 同步滚动 ──
let syncing = false;
document.getElementById('leftPanel').addEventListener('scroll', function() {
  if (syncing) return;
  syncing = true;
  document.getElementById('rightPanel').scrollTop = this.scrollTop;
  syncing = false;
});
document.getElementById('rightPanel').addEventListener('scroll', function() {
  if (syncing) return;
  syncing = true;
  document.getElementById('leftPanel').scrollTop = this.scrollTop;
  syncing = false;
});

// ── 文件切换 ──
const select = document.getElementById('fileSelect');
FILE_DATA.files.forEach((f, i) => {
  const opt = document.createElement('option');
  opt.value = i;
  opt.textContent = f.name + (confirmedSet.has(i) ? ' ✓' : '');
  select.appendChild(opt);
});
select.addEventListener('change', () => loadFile(parseInt(select.value)));

// ── 加载文件 ──
function loadFile(index) {
  currentIndex = index;
  const file = FILE_DATA.files[index];

  // flush previous
  document.getElementById('leftContent').innerHTML = '';
  document.getElementById('rightContent').innerHTML = '';

  fetch('/api/diff/' + index)
    .then(r => r.json())
    .then(data => {
      const {leftLines, rightLines} = flattenBlocks(data.blocks);
      renderDiff(document.getElementById('leftContent'), leftLines, 'left');
      renderDiff(document.getElementById('rightContent'), rightLines, 'right');

      // stats
      let addCount = 0, delCount = 0, chgCount = 0;
      for (const b of data.blocks) {
        if (b.type === 'insert') addCount += b.new_lines.length;
        else if (b.type === 'delete') delCount += b.old_lines.length;
        else if (b.type === 'replace') chgCount += Math.max(b.old_lines.length, b.new_lines.length);
      }
      document.getElementById('leftCount').textContent = delCount + ' 行删除, ' + chgCount + ' 行修改';
      document.getElementById('rightCount').textContent = addCount + ' 行新增, ' + chgCount + ' 行修改';
      document.getElementById('footerInfo').textContent = file.path;

      // update badge and buttons
      if (confirmedSet.has(index)) {
        document.getElementById('statusBadge').textContent = '已确认 ✓';
        document.getElementById('statusBadge').className = 'status status-done';
      } else {
        document.getElementById('statusBadge').textContent = '待确认';
        document.getElementById('statusBadge').className = 'status status-pending';
      }
      document.getElementById('leftPanel').scrollTop = 0;
      document.getElementById('rightPanel').scrollTop = 0;
    });
}

// ── 操作按钮 ──
function confirmCurrent() {
  const idx = currentIndex;
  fetch('/api/confirm/' + idx, {method:'POST'})
    .then(r => r.json())
    .then(data => {
      if (data.ok) {
        confirmedSet.add(idx);
        select.options[idx].textContent = FILE_DATA.files[idx].name + ' ✓';
        document.getElementById('statusBadge').textContent = '已确认 ✓';
        document.getElementById('statusBadge').className = 'status status-done';
        showToast('✓ 已写入: ' + FILE_DATA.files[idx].name);
        // auto-advance to next unconfirmed
        autoNext();
      } else {
        showToast('✗ 写入失败: ' + data.error, true);
      }
    });
}

function goBack() {
  if (confirmedSet.has(currentIndex)) {
    showToast('该文件已确认写入，无法放弃', true);
    return;
  }
  if (FILE_DATA.files.length <= 1) {
    showToast('只有一个文件，无法跳过', true);
    return;
  }
  // jump to next unconfirmed
  for (let i = 0; i < FILE_DATA.files.length; i++) {
    if (!confirmedSet.has(i) && i !== currentIndex) {
      select.value = i;
      loadFile(i);
      return;
    }
  }
  showToast('所有文件均已确认', true);
}

function confirmAll() {
  const pending = [];
  for (let i = 0; i < FILE_DATA.files.length; i++) {
    if (!confirmedSet.has(i)) pending.push(i);
  }
  if (pending.length === 0) {
    showToast('所有文件已确认完毕', true);
    return;
  }

  let done = 0;
  function next() {
    if (done >= pending.length) {
      showToast('✓ 全部写入完成! 可以关闭此页面');
      select.value = pending[0];
      loadFile(pending[0]);
      return;
    }
    const idx = pending[done];
    fetch('/api/confirm/' + idx, {method:'POST'})
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          confirmedSet.add(idx);
          select.options[idx].textContent = FILE_DATA.files[idx].name + ' ✓';
        }
        done++;
        next();
      });
  }
  next();
}

function autoNext() {
  for (let i = currentIndex + 1; i < FILE_DATA.files.length; i++) {
    if (!confirmedSet.has(i)) {
      select.value = i;
      loadFile(i);
      return;
    }
  }
  // check earlier
  for (let i = 0; i < currentIndex; i++) {
    if (!confirmedSet.has(i)) {
      select.value = i;
      loadFile(i);
      return;
    }
  }
  showToast('🎉 所有文件已确认完毕!');
}

function showToast(msg, isError) {
  const el = document.createElement('div');
  el.className = 'toast ' + (isError ? 'toast-err' : 'toast-ok');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

// ── 分隔条拖拽 ──
const divider = document.getElementById('divider');
let dragging = false;
divider.addEventListener('mousedown', e => { dragging = true; e.preventDefault(); });
document.addEventListener('mousemove', e => {
  if (!dragging) return;
  const left = document.getElementById('leftPanel');
  const main = document.querySelector('.main');
  const ratio = (e.clientX - main.getBoundingClientRect().left) / main.offsetWidth;
  left.style.flex = 'none';
  left.style.width = Math.max(200, Math.min(main.offsetWidth - 200, ratio * main.offsetWidth)) + 'px';
});
document.addEventListener('mouseup', () => { dragging = false; });

// ── 启动 ──
loadFile(0);
</script>
</html>"""


# ── HTTP 服务 ─────────────────────────────────────────────────

class _DiffHandler(BaseHTTPRequestHandler):
    """处理对比预览页面的 HTTP 请求。"""

    server_state: dict  # 由外部注入

    def log_message(self, format, *args):
        pass  # 静默日志

    def do_GET(self):
        if self.path == "/" or self.path == "/index.html":
            html = HTML_TEMPLATE.replace(
                "__FILE_DATA_PLACEHOLDER__",
                json.dumps({"files": self.server_state["meta"]}, ensure_ascii=False),
            )
            self._respond(200, "text/html; charset=utf-8", html.encode("utf-8"))
        elif self.path.startswith("/api/diff/"):
            try:
                idx = int(self.path.split("/")[-1])
                blocks = self.server_state["diffs"][idx]
                self._respond(200, "application/json", json.dumps({"blocks": blocks}, ensure_ascii=False).encode("utf-8"))
            except (IndexError, ValueError):
                self._respond(404, "text/plain", b"Not found")
        else:
            self._respond(404, "text/plain", b"Not found")

    def do_POST(self):
        if self.path.startswith("/api/confirm/"):
            try:
                idx = int(self.path.split("/")[-1])
                file_info = self.server_state["meta"][idx]
                normalized = self.server_state["normalized_texts"][idx]
                Path(file_info["path"]).write_text(normalized, encoding="utf-8")
                self._respond(200, "application/json", json.dumps({"ok": True}).encode("utf-8"))
            except Exception as e:
                self._respond(500, "application/json", json.dumps({"ok": False, "error": str(e)}).encode("utf-8"))
        else:
            self._respond(404, "text/plain", b"Not found")

    def _respond(self, code, content_type, body):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)


def _open_browser(port: int):
    """延迟打开浏览器(等待服务器就绪)。"""
    webbrowser.open(f"http://127.0.0.1:{port}")


def interactive_compare(filepaths: list[Path], base_level: int = 1) -> None:
    """对多个文件生成对比 HTML 并在浏览器中打开,用户确认后写回。"""
    meta = []
    diffs = []
    normalized_texts = []

    for fp in filepaths:
        original = fp.read_text(encoding="utf-8")
        normalized = normalize_headings(original, base_level)
        blocks = _compute_diff(original, normalized)

        meta.append({"name": fp.name, "path": str(fp.resolve())})
        diffs.append(blocks)
        normalized_texts.append(normalized)

    state = {
        "meta": meta,
        "diffs": diffs,
        "normalized_texts": normalized_texts,
    }

    # 绑定到 handler
    handler = type("_BoundHandler", (_DiffHandler,), {"server_state": state})

    server = HTTPServer(("127.0.0.1", 0), handler)
    port = server.server_address[1]

    # 延迟打开浏览器
    timer = threading.Timer(0.5, _open_browser, args=(port,))
    timer.start()

    print(f"对比页面: http://127.0.0.1:{port}")
    print("在浏览器中确认后,修改将自动写回原文件。按 Ctrl+C 退出。")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已退出。")
    finally:
        server.shutdown()


# ── 主入口 ────────────────────────────────────────────────────

def main():
    if sys.platform == "win32":
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except AttributeError:
            import io
            sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

    parser = argparse.ArgumentParser(
        description="Markdown 标题规范化",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""示例:
  python normalize_headings.py doc.md                交互对比,最高层级提升至一级
  python normalize_headings.py doc.md -b 2            交互对比,最高层级提升至二级
  python normalize_headings.py doc.md -b 0            交互对比,维持原始层级
  python normalize_headings.py doc.md -i -b 1         直接写回,最高层级提升至一级""",
    )
    parser.add_argument("files", nargs="*", type=Path, help="要处理的 markdown 文件")
    parser.add_argument(
        "-b", "--base-level", type=int, default=1, choices=[0, 1, 2, 3, 4],
        help="最高标题提升到的目标层级: 1~4 提升至对应层级, 0 维持原始层级不变 (默认: 1)",
    )
    parser.add_argument("-i", "--in-place", action="store_true", help="跳过预览,直接写回原文件")
    parser.add_argument("--preview", action="store_true", help="仅输出 .normalized.md 预览文件,不打开对比页面")
    parser.add_argument("--stdin", action="store_true", help="从 stdin 读取,输出到 stdout")
    args = parser.parse_args()

    if args.stdin:
        text = sys.stdin.buffer.read().decode("utf-8")
        sys.stdout.buffer.write(normalize_headings(text, args.base_level).encode("utf-8"))
        return

    if not args.files:
        parser.print_help()
        sys.exit(1)

    for fp in args.files:
        if not fp.exists():
            print(f"✗ 文件不存在: {fp}", file=sys.stderr)
            sys.exit(1)

    if args.in_place:
        for fp in args.files:
            text = fp.read_text(encoding="utf-8")
            fp.write_text(normalize_headings(text, args.base_level), encoding="utf-8")
            print(f"✓ 已写回: {fp}")
    elif args.preview:
        for fp in args.files:
            text = fp.read_text(encoding="utf-8")
            out = fp.with_suffix(".normalized.md")
            out.write_text(normalize_headings(text, args.base_level), encoding="utf-8")
            print(f"✓ 已输出: {out}")
    else:
        interactive_compare(args.files, args.base_level)


if __name__ == "__main__":
    main()
