// ── Media-element abstraction ────────────────────────────────────────────
// DIAA's row model and layout math are extension-agnostic: they only need a
// natural aspect ratio per member.  What differs between a picture and a video
// is the bottom DOM element (<img> vs <video>) and where its natural size comes
// from (naturalWidth/naturalHeight + `complete` vs videoWidth/videoHeight +
// `loadedmetadata`).  These helpers fold that difference so the renderers and
// the transform preview treat both as one "media element".
//
// This module is a leaf: it must not import from the renderers or the transform
// code, which both import it.

export type MediaElement = HTMLImageElement | HTMLVideoElement;

/** Whether a media element is a video, by tag name (robust in test DOMs). */
export function isMediaVideo(el: HTMLElement | null | undefined): el is HTMLVideoElement {
  return !!el && el.tagName === "VIDEO";
}

/** The element's natural bitmap size, from whichever source its tag reports. */
export function mediaNaturalSize(
  el: MediaElement | null | undefined
): { w: number; h: number } {
  if (!el) return { w: 0, h: 0 };
  if (isMediaVideo(el)) return { w: el.videoWidth, h: el.videoHeight };
  return { w: el.naturalWidth, h: el.naturalHeight };
}

/** Whether the element has reported a natural size yet.  A video reaches that
 *  at `readyState >= HAVE_METADATA` (1); an image at `complete`. */
export function mediaLoaded(el: MediaElement | null | undefined): boolean {
  if (!el) return false;
  if (isMediaVideo(el)) return el.readyState >= 1;
  return el.complete;
}

/** First media element (`<img>` or `<video>`) inside `root`, or null. */
export function queryMedia(root: ParentNode): MediaElement | null {
  const el = root.querySelector("img, video");
  return el as MediaElement | null;
}

/** Every media element inside `root`, in document order. */
export function queryAllMedia(root: ParentNode): MediaElement[] {
  return Array.from(root.querySelectorAll<HTMLImageElement | HTMLVideoElement>("img, video"));
}

/** Re-run `cb` once the element next reports a natural size.  The call site
 *  gates this with `mediaLoaded`, so it only fires for elements still waiting —
 *  a video announces its size at `loadedmetadata`, an image at `load`. */
export function onMediaReady(el: MediaElement, cb: () => void): void {
  if (isMediaVideo(el)) el.addEventListener("loadedmetadata", cb, { once: true });
  else el.addEventListener("load", cb, { once: true });
}
