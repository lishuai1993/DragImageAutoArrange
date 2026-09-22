// ── 一次性排障探针：旋转后的视口跳变取证 ─────────────────────────────
// 待查现象：对某张图执行旋转时，视口会跳到文档头；且**只在该图第一次旋转**
// （行文本第一次长出朝向槽位）时发生，槽位就位后后续旋转视口稳定。
//
// 要判定的假设：该 widget 块的高度在重建瞬间被遗忘，而 `StaticImageRowWidget`
// 未提供 `estimatedHeight`，CM6 于是取默认 -1；`HeightMap.point()` 里
// `if (height < 0) height = this.oracle.lineHeight`，块被按「一行」建模。
// 若该块未实测，`measure()` 的锚点补偿
// `diff = lineBlockAt(scrollAnchorPos).top - scrollAnchorHeight` 就会大幅为负，
// `scrollTop` 被夹到 0 —— 即跳到文首。
//
// ── 血泪约束：探针绝不能读布局 ──────────────────────────────────────
// `view.lineBlockAt()` / `lineBlockAtHeight()` 内部会先调 `readMeasured()`：
//
//     if (this.updateState == UpdateState.Updating)
//       throw new Error("Reading the editor layout isn't allowed during an update");
//
// 而本探针的调用点（widget 的 `toDOM` / `updateDOM` / `destroy`、`applyLayout`）
// 恰恰运行在 CM6 的更新周期内。一旦在那里读布局就会抛错：`toDOM` 有 try/catch
// 能兜住，但 `destroy()` 没有 —— 异常会中断整个更新周期，编辑器渲染残缺
// （源码模式空白、Live Preview ↔ 源码切换失灵）。所以：
//   · `note()` 只读 DOM/state 的普通字段，绝不触发布局测量；
//   · 需要块高度/锚点时，用 `snapshot()`，且只在空闲期调用（菜单点击、rAF、
//     scroll 事件）；
//   · 所有函数整体 try/catch —— 探针出错只能少打日志，不能影响编辑器。
//
// 成本：默认完全静默。只有 `openRotationWindow()` 打开约 1.5s 的窗口后
// `note()` 才写日志，窗口一关即恢复 no-op，发布版无影响。
// 读法：设置页把「日志级别」调到 INFO、打开「文件日志」，旋转一次，
// 在 log.txt 中检索 `[ROT`。
//
// 前后值只能说明「有人动了视口」，指认不了写入者。旋转窗口期间另给
// `scrollDOM` 罩一层写入口罩（见 `installSpy`），任何*程序性*写入都会留下
// 一条 `scrollTop SET`：`via` 是写入口（`scrollTop =` / `scrollTo` /
// `scrollBy` / `scrollIntoView`），`from`/`to` 是旧值与新值，`stack` 是调用链
// ——谁把视口拉到那个落点，看这一条。

import { EditorView } from "@codemirror/view";
import { logger } from "../logger";

const log = logger.channel("scrollDiag");

/** 窗口时长：覆盖旋转写入 → 装饰重建 → 数帧 settle。 */
const WINDOW_MS = 1500;
/** 采样帧数：足够看清 scrollTop 是在哪一帧被拉走的。 */
const FRAMES = 12;

/** ── 观测窗（TEMP-DIAG：任意手势后的长窗，含 mod+z 按键与逐帧采样）──────
 *  与旋转窗同一套探针，只把窗口拉长到几十秒，用来覆盖「手势 → 隔几秒再按
 *  Cmd+Z」的序列（剪切撤销的视口跳变取证）。 */
const WATCH_MS = 30000;
/** 帧预算：长窗按 60fps 估的上限，实际只记下面两个常量决定的行数。 */
const WATCH_FRAMES = 1800;
/** 前 1.5s 逐帧；之后每 20 帧取一帧 —— 30s 长窗也只写百余行。 */
const DENSE_FRAMES = 90;
const SPARSE_STEP = 20;

let active = false;
let seq = 0;
/** 被旋转的 0-based 行号；用于定位 widget 块。 */
let line0 = -1;
let view: EditorView | null = null;
let closeTimer: number | null = null;
let rafId = 0;
let framesLeft = 0;
let frameIndex = 0;
let scrollSink: (() => void) | null = null;
let keySink: ((ev: KeyboardEvent) => void) | null = null;

/** 探针是否处于开窗状态。调用方据此避免构造无用的日志载荷。 */
export function isActive(): boolean {
  return active;
}

/** 在任何时机都可安全读取的字段：不触碰布局测量。 */
function safeFields(v: EditorView): Record<string, unknown> {
  try {
    return {
      scrollTop: Math.round(v.scrollDOM.scrollTop),
      lineH: Math.round(v.defaultLineHeight),
      docLines: v.state.doc.lines,
      // 「撤销揭示的是谁」只能靠它和改动范围对照：CM6 揭示的是选区，
      // 而我们自己的手势从不移动选区。
      sel: v.state.selection?.main?.head ?? -1,
    };
  } catch (e) {
    return { fieldsErr: `safe:${String(e)}` };
  }
}

/** 布局测量：**只能在空闲期调用**（见文件头约束）。块高度 `h` 若≈`lineH`
 *  且 `est=-1`，即 CM6 把该块按一行建模 —— 这正是要取证的点。 */
function measure(v: EditorView): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  try {
    const doc = v.state.doc;
    const pos = line0 >= 0 && line0 < doc.lines ? doc.line(line0 + 1).from : 0;
    const b = v.lineBlockAt(pos);
    const w = b.widget;
    out.block = `top=${Math.round(b.top)} h=${Math.round(b.height)}` +
      (w ? ` est=${w.estimatedHeight}` : " widget=none");
  } catch (e) {
    out.block = `err:${String(e)}`;
  }
  try {
    const a = v.lineBlockAtHeight(v.scrollDOM.scrollTop);
    out.anchor = `top=${Math.round(a.top)} from=${a.from}`;
  } catch (e) {
    out.anchor = `err:${String(e)}`;
  }
  // 文档总高：区分「揭示把视口拉走」与「块高重估把内容顶走」——前者在事务
  // 那一帧就动，后者要等测量帧，且总量等于文档高的变化。
  try {
    out.docH = Number.isFinite(v.contentHeight) ? Math.round(v.contentHeight) : -1;
  } catch (e) {
    out.docH = `err:${String(e)}`;
  }
  return out;
}

/** 往当前窗口追加一条时间线记录；窗口关闭时为 no-op。
 *  只带安全字段 —— 会被更新周期内的回调调用。 */
export function note(tag: string, data?: Record<string, unknown>): void {
  if (!active || !view) return;
  try {
    const v = view;
    log.info(`[ROT ${String(++seq).padStart(3, "0")}] ${tag}`, { ...data, ...safeFields(v) });
  } catch {
    // 探针自身出错不得外溢到编辑器。
  }
}

/** 带布局测量的记录；**只在空闲期调用**（菜单点击 / rAF / scroll 事件）。 */
function snapshot(tag: string, data?: Record<string, unknown>): void {
  if (!active || !view) return;
  try {
    const v = view;
    log.info(`[ROT ${String(++seq).padStart(3, "0")}] ${tag}`, {
      ...data,
      ...safeFields(v),
      ...measure(v),
    });
  } catch {
    // 同上。
  }
}

function sampleFrames(depth: number): void {
  if (!active || !view || framesLeft <= 0) return;
  framesLeft--;
  const i = frameIndex++;
  const v = view;
  rafId = window.requestAnimationFrame(() => {
    if (!active || view !== v) return;
    // 短窗（旋转）逐帧记满；长窗只在前 1.5s 逐帧，之后抽样，免得刷爆日志。
    if (depth <= DENSE_FRAMES || i < DENSE_FRAMES || i % SPARSE_STEP === 0) {
      snapshot(`frame ${depth - framesLeft}`);
    }
    sampleFrames(depth);
  });
}

// ── 写入口罩：谁在动 scrollTop ──────────────────────────────────────
// `note()` / `snapshot()` 给出的是前后值，指认不了写入者。开窗期间给 scrollDOM
// 罩住四个程序性写入口——`scrollTop` 赋值，以及 `scrollTo` / `scrollBy` /
// `scrollIntoView`（后三者走「滚动元素」算法，不经过 scrollTop 的 IDL setter，
// 不单独罩住就会漏掉这类写入者）。命中即记 `via` / `from` / `to` / 调用栈。
//
// 口罩运行在编辑器的调用栈里，所以与 `note()` 同级受限：只允许
// `new Error().stack` 与普通 DOM 字段，绝不读布局。更要紧的是**放行优先**——
// 无论日志本身是否出错，写操作都必须原样落到元素上，且调用栈里的异常绝不许
// 外溢：一个会抛的 setter 比少打几行日志危险得多。因此这里每一处记录单独
// try/catch，转发调用在记录之后无条件执行。

/** 罩住的名字 → 罩住前的自有描述符（`undefined` 表示原先只有原型上的）。 */
interface Shadowed {
  name: string;
  desc: PropertyDescriptor | undefined;
}

let spyHost: HTMLElement | null = null;
let spyUndo: Shadowed[] = [];
let writeCount = 0;

/** 单次开窗最多记多少条写入——纯粹是防洪水的阀门。 */
const MAX_WRITES = 40;

/** 调用栈的前几帧压成一行；这是指认写入者的唯一凭据。 */
function callerChain(): string {
  try {
    return (new Error().stack ?? "")
      .split("\n")
      .slice(2, 10)
      .map((s) => s.trim().replace(/^at\s+/, ""))
      .join(" | ");
  } catch {
    return "";
  }
}

/** 一条程序性写入的记录。绝不许抛出——它跑在编辑器的调用栈里。 */
function logWrite(via: string, from: number | null, to: number | null): void {
  if (!active) return;
  if (writeCount >= MAX_WRITES) return;
  writeCount++;
  if (writeCount === MAX_WRITES) {
    log.info(`[ROT] scrollTop 写入已达 ${MAX_WRITES} 条上限，本次开窗不再记录`);
  }
  log.info(`[ROT ${String(++seq).padStart(3, "0")}] scrollTop SET`, {
    via,
    from,
    to,
    stack: callerChain(),
  });
}

/** 原型链上第一个带 get/set 的 `name` 描述符（浏览器的 `scrollTop` 挂在
 *  Element.prototype 上，而不是元素自身）。 */
function accessorOf(host: HTMLElement, name: string): PropertyDescriptor | null {
  let proto: object | null = host;
  while (proto) {
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    if (desc) return desc;
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  return null;
}

/** `scrollTo` / `scrollBy` 的目标位置：对象形式取 `.top`，坐标形式取第二参。 */
function targetOf(args: unknown[]): number | null {
  const first = args[0];
  if (typeof first === "object" && first !== null) {
    const top = (first as { top?: unknown }).top;
    return typeof top === "number" ? Math.round(top) : null;
  }
  const second = args[1];
  return typeof second === "number" ? Math.round(second) : null;
}

/** 罩住一个方法：先记一条再原样转发，返回值照旧透传。罩不住就跳过这个方法。 */
function shadowMethod(host: HTMLElement, name: string, via: string): void {
  try {
    const orig = (host as unknown as Record<string, unknown>)[name];
    if (typeof orig !== "function") return; // jsdom 未实现 scrollTo 之类
    const desc = Object.getOwnPropertyDescriptor(host, name);
    Object.defineProperty(host, name, {
      configurable: true,
      writable: true,
      enumerable: false,
      value: function (this: unknown, ...args: unknown[]): unknown {
        try {
          logWrite(via, null, targetOf(args));
        } catch {
          // 记录失败也必须放行。
        }
        return (orig as (...a: unknown[]) => unknown).apply(this, args);
      },
    });
    spyUndo.push({ name, desc });
  } catch {
    // 这个方法罩不住就算了，其余照罩。
  }
}

/** 罩住 `scrollDOM` 的所有程序性写入口。失败即当作没罩——绝不打断开窗。 */
function installSpy(host: HTMLElement): void {
  uninstallSpy();
  spyHost = host;
  writeCount = 0;
  try {
    const desc = accessorOf(host, "scrollTop");
    if (desc?.get && desc.set) {
      const undo = Object.getOwnPropertyDescriptor(host, "scrollTop");
      Object.defineProperty(host, "scrollTop", {
        configurable: true,
        enumerable: false,
        get(this: HTMLElement): number {
          return desc.get?.call(this) as number;
        },
        set(this: HTMLElement, value: number): void {
          let from: number | null = null;
          try {
            from = desc.get?.call(this) as number;
          } catch {
            // 读不出旧值不影响记录与放行。
          }
          try {
            logWrite("scrollTop =", from, value);
          } catch {
            // 记录失败也必须放行。
          }
          desc.set?.call(this, value);
        },
      });
      spyUndo.push({ name: "scrollTop", desc: undo });
    } else {
      log.info("[ROT] scrollTop 口罩未安装：宿主没有 scrollTop 访问器");
    }
    shadowMethod(host, "scrollTo", "scrollTo");
    shadowMethod(host, "scrollBy", "scrollBy");
    shadowMethod(host, "scrollIntoView", "scrollIntoView");
  } catch {
    uninstallSpy();
  }
}

/** 摘掉口罩，把罩住的名字逐个还原成罩住前的样子。 */
function uninstallSpy(): void {
  const host = spyHost;
  spyHost = null;
  writeCount = 0;
  if (!host) {
    spyUndo = [];
    return;
  }
  for (const { name, desc } of spyUndo.reverse()) {
    try {
      if (desc) Object.defineProperty(host, name, desc);
      else delete (host as unknown as Record<string, unknown>)[name];
    } catch {
      // 还原失败只能作罢：下一次开窗会重新罩。
    }
  }
  spyUndo = [];
}

/** 开窗并记录写入前的一帧；`line` 为 0-based 行号。 */
export function openRotationWindow(
  v: EditorView | null,
  line: number,
  lineText: string
): void {
  openWindow(v, line, lineText, WINDOW_MS, FRAMES);
}

/** 开一段长观测窗（TEMP-DIAG）。`line` 可传 -1（不指定观察块）。
 *
 *  与旋转窗的差别只有时长与采帧密度：窗口内持续逐帧/抽样记录 scrollTop、
 *  罩住 scrollDOM 的写入口、并记录 mod+z —— 「手势在前、Cmd+Z 在后隔几秒」
 *  这种序列只有长窗罩得住。 */
export function openViewportWatch(v: EditorView | null, ms = WATCH_MS, line = -1): void {
  openWindow(v, line, "", ms, WATCH_FRAMES);
}

/** 同上，但直接从 DOM 里的元素定位 EditorView（手柄、图片这类调用点手上
 *  只有元素）。定位失败按「没开窗」处理，绝不影响调用方。 */
export function openViewportWatchFor(el: HTMLElement, ms = WATCH_MS, line = -1): void {
  try {
    const host =
      el.closest<HTMLElement>(".cm-content") ?? el.closest<HTMLElement>(".cm-editor") ?? el;
    openViewportWatch(EditorView.findFromDOM(host), ms, line);
  } catch {
    // 探针不介入业务：定位不到就当作没开窗。
  }
}

function openWindow(
  v: EditorView | null,
  line: number,
  lineText: string,
  ms: number,
  frames: number
): void {
  try {
    closeRotationWindow();
    if (!v) {
      log.info("[ROT] open skipped: no EditorView", { line, lineText });
      return;
    }
    view = v;
    line0 = line;
    active = true;
    seq = -1; // 让开窗那一行固定为 [ROT 000]，便于检索
    snapshot("open (pre-write)", { line, lineText, ms });
    installSpy(v.scrollDOM);
    scrollSink = () => snapshot("scroll event");
    v.scrollDOM.addEventListener("scroll", scrollSink, { passive: true });
    // 按键本身不写视口，但它标出「Cmd+Z 是哪一刻到的」，与后续帧对照即知
    // 视口是在事务那一帧动，还是隔了几帧才被测量顶走。
    keySink = (ev: KeyboardEvent) => {
      const t = ev.target instanceof Element ? ev.target : null;
      note("keydown", {
        key: ev.key,
        mod: ev.metaKey || ev.ctrlKey,
        shift: ev.shiftKey,
        inEditor: !!t?.closest?.(".cm-content"),
      });
    };
    document.addEventListener("keydown", keySink, true);
    frameIndex = 0;
    framesLeft = frames;
    sampleFrames(frames);
    closeTimer = window.setTimeout(closeRotationWindow, ms);
  } catch {
    // 开窗失败就当作没开：不写日志、不监听、不影响编辑器。
    active = false;
    view = null;
    line0 = -1;
    uninstallSpy();
  }
}

/** 收窗；仍会记录一帧收口快照，便于对比起点与终点。 */
export function closeRotationWindow(): void {
  try {
    if (closeTimer !== null) {
      window.clearTimeout(closeTimer);
      closeTimer = null;
    }
    if (active && view) snapshot("close");
  } catch {
    // 同上。
  }
  try {
    if (rafId) {
      window.cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (scrollSink && view) view.scrollDOM.removeEventListener("scroll", scrollSink);
    if (keySink) document.removeEventListener("keydown", keySink, true);
    uninstallSpy();
  } catch {
    // 同上。
    uninstallSpy();
  }
  scrollSink = null;
  keySink = null;
  active = false;
  view = null;
  line0 = -1;
  framesLeft = 0;
}
