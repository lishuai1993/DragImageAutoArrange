import { type App, type Editor, MarkdownView, type TFile } from 'obsidian';

/**
 * 从 DOM 认识一张图、以及认识它所在的笔记视图。
 *
 * 上下文菜单拿到的是事件目标，这里负责回答三个问题：目标是不是图、图的
 * 候选地址有哪些、它属于哪个 Markdown 视图（多窗格 / 弹出窗口下都要找对）。
 */

/** 工作区拥有的全部窗口，含弹出窗口。 */
export function getWorkspaceWindows(app: App): Window[] {
  const workspaceWindows = new Set<Window>([app.workspace.containerEl.win]);
  app.workspace.iterateAllLeaves(leaf => {
    workspaceWindows.add(leaf.view.containerEl.win);
  });
  return Array.from(workspaceWindows);
}

/**
 * 跨窗口安全的元素判定。弹出窗口里的节点在宿主窗口用 `instanceof` 判会失败，
 * 所以一律走 Obsidian 挂到 `Node` 上的 `instanceOf`。
 */
function asHtmlElement(target: EventTarget | null): HTMLElement | null {
  if (!target || typeof target !== 'object') return null;
  const candidate = target as HTMLElement;
  if (typeof candidate.instanceOf !== 'function') return null;
  return candidate.instanceOf(HTMLElement) ? candidate : null;
}

/** 事件目标向上找到最近的 `<img>`；不是图相关元素返回 null。 */
export function findImageElement(target: EventTarget | null): HTMLImageElement | null {
  const element = asHtmlElement(target);
  if (!element) return null;

  if (element.instanceOf(HTMLImageElement)) return element;

  const imageContext = element.closest(
    '.image-container, .image-embed, a.internal-embed[src*=".png"], a.internal-embed[src*=".jpg"], a.internal-embed[src*=".jpeg"], a.internal-embed[src*=".gif"], a.internal-embed[src*=".webp"], a.internal-embed[src*=".svg"]'
  );
  if (imageContext) return imageContext.querySelector('img');

  return null;
}

/** 一张图可能出现的全部地址来源，按优先级排列（已去空）。 */
export function getImageSourceCandidates(img: HTMLImageElement): string[] {
  return [img.getAttribute('data-src') ?? '', img.getAttribute('src') ?? '', img.currentSrc, img.src]
    .map(value => value.trim())
    .filter(Boolean);
}

/** 候选地址里第一个 http(s) 地址，没有则退回第一个候选。 */
export function getBestHttpImageSource(img: HTMLImageElement): string {
  const candidates = getImageSourceCandidates(img);
  return candidates.find(candidate => isHttpUrlString(candidate)) ?? candidates[0] ?? '';
}

/** 地址是否为远程（http/https）图片。 */
export function isRemoteImage(img: HTMLImageElement): boolean {
  return getImageSourceCandidates(img).some(source => isHttpUrlString(source));
}

export function isHttpUrlString(value: string): boolean {
  return /^\s*https?:\/\//i.test(value);
}

/**
 * 是否为指向本机 / 局域网的地址。这类请求会先弹一句提示：Obsidian 直接发
 * 起的请求不经过浏览器同源策略，用户有权知道自己在向内网取图。
 */
export function isLocalNetworkUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!isHttpUrlString(url.href)) return false;

    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host.endsWith('.local')) return true;

    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      const octets = host.split('.').map(part => Number(part));
      if (octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;

      const [a, b] = octets;
      if (a === 10) return true;
      if (a === 127) return true;
      if (a === 169 && b === 254) return true;
      if (a === 192 && b === 168) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      return false;
    }

    // IPv6 字面量在 URL.hostname 里带方括号，如 "[::1]"。
    if (host.startsWith('[') && host.endsWith(']')) {
      const ipv6 = host.slice(1, -1);
      if (ipv6 === '::1') return true;
      if (ipv6.startsWith('fe80:')) return true;
      if (ipv6.startsWith('fc') || ipv6.startsWith('fd')) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** 单个地址是否为 SVG。 */
export function isSvgUrl(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  if (!normalized) return false;

  if (normalized.startsWith('data:image/svg+xml')) return true;
  if (normalized.includes('image/svg+xml')) return true;

  try {
    return new URL(url).pathname.toLowerCase().endsWith('.svg');
  } catch {
    return normalized.split(/[?#]/, 1)[0].endsWith('.svg');
  }
}

/** 一张图的任一候选地址是 SVG 即认定它是矢量图。 */
export function isSvgSource(img: HTMLImageElement): boolean {
  return getImageSourceCandidates(img).some(source => isSvgUrl(source));
}

/** 拥有该元素的 Markdown 视图；多窗格下逐个比对内容区归属。 */
export function findMarkdownViewForElement(app: App, element: HTMLElement): MarkdownView | null {
  for (const leaf of app.workspace.getLeavesOfType('markdown')) {
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) continue;
    if (!view.file) continue;
    if (view.contentEl.contains(element)) return view;
  }
  return null;
}

/** 指定文件的 Markdown 编辑器；该文件没打开则返回 null。 */
export function findMarkdownEditorForFile(app: App, file: TFile): Editor | null {
  for (const leaf of app.workspace.getLeavesOfType('markdown')) {
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) continue;
    if (!view.file) continue;
    if (view.file.path !== file.path) continue;
    return view.editor;
  }
  return null;
}

/**
 * 面向用户的错误：消息可以直接展示给用户，不需要再包一层「操作失败」。
 * 用 `name` 打标，跨模块判定时不必依赖 `instanceof`。
 */
export function createUserVisibleError(message: string): Error {
  const error = new Error(message);
  error.name = 'UserVisibleError';
  return error;
}

export function isUserVisibleError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'UserVisibleError';
}
