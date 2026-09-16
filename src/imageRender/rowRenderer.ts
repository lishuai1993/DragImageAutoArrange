/**
 * Shared DOM rendering helpers used by both Live Preview (imageRowWidget /
 * livePreview) and Reading Mode (readingMode).  This module is a leaf: it must
 * not import from imageRowWidget/livePreview/readingMode to avoid init cycles.
 */

import { CLASSES } from "../constants";

/** Obsidian alignment classes that override our flex layout and must be stripped. */
export const OBSIDIAN_ALIGN_CLASSES = [
  "image-position-center",
  "image-position-left",
  "image-position-right",
  "image-converter-aligned",
  "image-no-wrap",
] as const;

/** True if the img currently carries any Obsidian alignment class. */
export function hasObsidianAlignClass(img: HTMLElement): boolean {
  return OBSIDIAN_ALIGN_CLASSES.some((c) => img.classList.contains(c));
}

/**
 * Strip Obsidian alignment classes from an img element.
 * Returns true if the className actually changed (for before/after diagnostics).
 */
export function stripObsidianClasses(img: HTMLElement): boolean {
  const before = img.className;
  img.classList.remove(...OBSIDIAN_ALIGN_CLASSES);
  return img.className !== before;
}

/**
 * Neutralize Obsidian's intermediate wrapper elements (e.g. .image-resize-container)
 * between an img and a boundary element by tagging them with the
 * `diaa-contents` class, so the img behaves as a direct flex child.  Walks
 * from `img.parentElement` up to (but not including) `boundary`, skipping any
 * element listed in `skipEls`.
 */
export function neutralizeWrappers(
  img: HTMLElement,
  boundary: HTMLElement,
  skipEls: HTMLElement[] = []
): void {
  let el: HTMLElement | null = img.parentElement;
  while (el && el !== boundary) {
    if (!skipEls.includes(el)) {
      el.addClass(CLASSES.contents);
    }
    el = el.parentElement;
  }
}

/**
 * Create a custom fully-opaque drag ghost that follows the cursor, and hide the
 * browser's default semi-transparent ghost.  Returns a cleanup function (remove
 * the ghost + its dragover listener) that the caller should wire into `dragend`.
 * If the image has no natural dimensions yet, a no-op cleanup is returned.
 */
export function createDragGhost(
  img: HTMLImageElement | null | undefined,
  e: DragEvent,
  ghostWidth: number
): () => void {
  const noop = () => {};
  if (!img || img.naturalWidth <= 0 || !e.dataTransfer) return noop;

  // Hide the browser's default semi-transparent ghost with a transparent 1x1 pixel.
  const pixel = createEl("canvas");
  pixel.width = 1;
  pixel.height = 1;
  pixel.setCssStyles({ position: "fixed", left: "0", top: "0", pointerEvents: "none" });
  document.body.appendChild(pixel);
  e.dataTransfer.setDragImage(pixel, 0, 0);
  window.setTimeout(() => pixel.remove(), 0);

  // Custom fully-opaque ghost, initially at cursor (DPR-scaled for sharpness).
  const w = ghostWidth;
  const h = (img.naturalHeight / img.naturalWidth) * w;
  const dpr = window.devicePixelRatio || 1;
  const ghost = createEl("canvas");
  ghost.width = w * dpr;
  ghost.height = h * dpr;
  ghost.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;width:${w}px;height:${h}px;pointer-events:none;z-index:2147483647`;
  const ctx = ghost.getContext("2d");
  if (ctx) {
    ctx.scale(dpr, dpr);
    ctx.drawImage(img, 0, 0, w, h);
  }
  document.body.appendChild(ghost);

  const onDragOver = (ev: DragEvent) => {
    ghost.style.left = ev.clientX + "px";
    ghost.style.top = ev.clientY + "px";
  };
  document.addEventListener("dragover", onDragOver, true);

  return () => {
    document.removeEventListener("dragover", onDragOver, true);
    ghost.remove();
  };
}
