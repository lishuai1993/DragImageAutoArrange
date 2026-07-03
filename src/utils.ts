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
export function throttle<T extends (...args: any[]) => void>(
  fn: T,
  delay: number
): T {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return ((...args: any[]) => {
    if (timer) return;
    timer = setTimeout(() => {
      fn(...args);
      timer = null;
    }, delay);
  }) as T;
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
