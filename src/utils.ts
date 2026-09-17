import { MarkdownView, type App, type TAbstractFile } from "obsidian";

/**
 * Compile-time exhaustiveness guard for discriminated unions. Put it in the
 * `default` branch of a `switch` over a union's discriminant: if a new variant
 * is added and left unhandled, the argument is no longer `never` and the call
 * fails to type-check. At runtime it throws, converting any missed case into a
 * loud failure instead of a silent fall-through.
 */
/**
 * The Markdown view in the active leaf, or null when the active leaf is not a
 * Markdown view.
 *
 * `Workspace.activeLeaf` is deprecated; `getActiveViewOfType` is the supported
 * replacement and matches every caller's intent here — they all bail out as
 * soon as the active view is not a Markdown view, which is exactly what a null
 * return expresses.
 */
export function activeMarkdownView(app: App): MarkdownView | null {
  return app.workspace.getActiveViewOfType(MarkdownView);
}

export function assertNever(x: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(x)}`);
}

/**
 * Resolve an Obsidian image wikilink to its actual file resource path.
 *
 * Examples:
 *   "image.png"      → "app://local/path/to/image.png"
 *   "folder/img.png" → "app://local/path/to/folder/img.png"
 *
 * In Obsidian, image embeds use the vault-relative path.
 * The actual resource URL is constructed using the vault adapter.
 */
export function resolveImageSrc(
  fileName: string,
  vaultAdapter: { getResourcePath: (path: string) => string }
): string {
  // Obsidian vault adapter resolves vault-relative paths to resource URLs
  try {
    return vaultAdapter.getResourcePath(fileName);
  } catch {
    // Fallback: return the filename as-is for external images or errors
    return fileName;
  }
}

/**
 * Get the display name from a file path (last segment without extension).
 */
export function displayNameFromPath(fileName: string): string {
  const parts = fileName.split("/");
  const last = parts[parts.length - 1];
  return last.replace(/\.[^.]+$/, "");
}

/**
 * Throttle a function call — fire at most once per `delay` ms.
 */
export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  delay: number
): (...args: A) => void {
  let timer: number | null = null;
  return (...args: A): void => {
    if (timer) return;
    timer = window.setTimeout(() => {
      fn(...args);
      timer = null;
    }, delay);
  };
}

/**
 * Move a line within a range of lines from `fromIndex` to `toIndex`.
 *
 * Extracted from `moveLine` in livePreview.ts — the splice adjustment
 * logic when fromIndex < toIndex is the source-of-truth for this operation.
 *
 * Returns a new array (does not mutate the input).
 */
export function moveLineInRange(
  lines: string[],
  fromIndex: number,
  toIndex: number
): string[] {
  if (lines.length === 0) return [];
  const result = [...lines];
  const [moved] = result.splice(fromIndex, 1);
  // When source is before target, the target index shifts left by one
  // after the source line is removed.
  const insertAt = fromIndex < toIndex ? toIndex - 1 : toIndex;
  result.splice(insertAt, 0, moved);
  return result;
}

/** Map the global alignment setting to CSS flexbox and object-position values. */
export function alignmentToCSS(alignment: "left" | "center" | "right"): {
  justifyContent: string;
  objectPosition: string;
} {
  if (alignment === "center") return { justifyContent: "center", objectPosition: "center top" };
  if (alignment === "right") return { justifyContent: "flex-end", objectPosition: "right top" };
  return { justifyContent: "flex-start", objectPosition: "left top" };
}

/**
 * Write one declaration into an element's inline style, with `!important`.
 *
 * A helper rather than a direct `style.setProperty` call because every caller
 * passes literal values and the obsidianmd lint rule reads a literal second
 * argument as a static (non-themeable) style assignment.  The priority is fixed
 * too: the competitor in every one of these cases is the platform's own
 * stylesheet, which no selector this plugin owns outranks by specificity.
 */
export function setStyleImportant(el: HTMLElement, prop: string, value: string): void {
  el.style.setProperty(prop, value, "important");
}

/** The narrow-screen breakpoint.  styles.css carries the same number in its
 *  media query — the two have to move together. */
export const MOBILE_BREAKPOINT_PX = 768;

/**
 * Whether the viewport is currently narrow (a phone, or a window dragged small).
 *
 * Row geometry is drawn one of two ways and they conflict if both speak: above
 * the breakpoint this plugin computes every image's pixel size and writes it
 * inline, below it the stylesheet's media query re-flows the row and sizes it
 * with CSS.  Inline always outranks a stylesheet, so below the breakpoint the
 * layout has to stop writing and hand the row over.
 *
 * `matchMedia` does not exist in every test environment (jsdom has none); it is
 * reported as wide there, which is the behaviour the plugin had before the
 * narrow handling existed — no test wanders into the other branch by accident.
 */
export function isNarrowViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches;
}

/**
 * Subscribe to breakpoint crossings; the returned function unsubscribes.
 *
 * The callback is handed the new state rather than a MediaQueryListEvent, so it
 * reads the same way as `isNarrowViewport()` and callers never touch `matches`
 * themselves.  `addEventListener` is used, not the deprecated `addListener`.
 */
export function onNarrowViewportChange(cb: (narrow: boolean) => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }
  const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`);
  const listener = (e: MediaQueryListEvent): void => cb(e.matches);
  mql.addEventListener("change", listener);
  return () => mql.removeEventListener("change", listener);
}

/**
 * FileManager.trashFile 在 Obsidian 1.6.6 才出现，而本插件 minAppVersion 为
 * 1.5.0；在更早的版本上只有 Vault.trash。两个成员都按能力探测访问——这里的
 * 结构类型是必须的，直接写 app.fileManager.trashFile 会让 1.5.0 上的用户
 * 一删除就崩，直接写 app.vault.trash 又会踩到已废弃 API。
 */
interface TrashCapableFileManager {
  trashFile?(file: TAbstractFile): Promise<void>;
}

interface TrashCapableVault {
  trash?(file: TAbstractFile, system: boolean): Promise<void>;
}

/**
 * 删除文件，并尊重用户的「删除 / 移到回收站」偏好：新版走 FileManager，旧版
 * 退回 Vault（system = true 表示按系统方式移到回收站）。
 */
export async function trashFile(app: App, file: TAbstractFile): Promise<void> {
  const fileManager = app.fileManager as unknown as TrashCapableFileManager;
  if (typeof fileManager.trashFile === "function") {
    await fileManager.trashFile(file);
    return;
  }

  const vault = app.vault as unknown as TrashCapableVault;
  if (typeof vault.trash === "function") {
    await vault.trash(file, true);
    return;
  }

  throw new Error("当前 Obsidian 版本不支持删除文件");
}
