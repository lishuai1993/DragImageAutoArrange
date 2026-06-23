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
