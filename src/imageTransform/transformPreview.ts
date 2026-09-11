/**
 * CSS preview of an in-flight orientation on a rendered <img> (P3).
 *
 * The physical file is only rewritten when its note closes; until then the
 * orientation is a live CSS transform so the user sees the result before it is
 * baked in.  Applying the identity removes the transform.
 */

import type { OrientationState } from './orientation';
import { orientationToCss } from './orientation';

/**
 * Fit scale for an odd quarter-turn preview. The layout box is sized for the
 * un-rotated aspect, so a bare `rotate(90deg|270deg)` makes the image's visual
 * bounding box exceed the box (width↔height swap) and the row's overflow:hidden
 * clips the edges. A uniform scale brings the rotated content back inside the
 * original box (letterboxed), showing the whole image. Mirrors / 180° don't grow
 * the bounding box and need no scale. Returns '' when no scale is needed.
 */
function fitScaleForQuarterTurn(img: HTMLImageElement): string {
    const cw = img.clientWidth;
    const ch = img.clientHeight;
    if (cw <= 0 || ch <= 0) return '';
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    // object-fit:contain content size inside the layout box. Without a loaded
    // natural size fall back to assuming the content fills the box.
    const aspect = nw > 0 && nh > 0 ? nw / nh : cw / ch;
    let rw: number;
    let rh: number;
    if (cw / ch >= aspect) {
        rh = ch; // box is wider-than-content: height limited
        rw = ch * aspect;
    } else {
        rw = cw; // box is narrower-than-content: width limited
        rh = cw / aspect;
    }
    // After a quarter turn the drawn content measures (rh × rw); scale it down
    // only when it would exceed the box, never up.
    const k = Math.min(cw / rh, ch / rw);
    if (!Number.isFinite(k) || k >= 1) return '';
    return `scale(${Number(k.toFixed(4))})`;
}

export function applyOrientationPreview(
    img: HTMLImageElement,
    state: OrientationState
): void {
    let css = orientationToCss(state);
    if (css && state.turns % 2 === 1) {
        const fit = fitScaleForQuarterTurn(img);
        if (fit) css = `${fit} ${css}`;
    }
    img.style.transform = css;
}

export function clearOrientationPreview(img: HTMLImageElement): void {
    img.setCssStyles({ transform: '' });
}
