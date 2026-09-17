/**
 * CSS transform for a rendered <img> carrying a rotate/flip orientation, plus
 * the layout arithmetic that follows from it.
 *
 * The orientation is persisted as a row parameter, never baked into the file;
 * this module turns the parsed state into the visual transform.  Applying the
 * identity clears the transform.
 *
 * A CSS transform is a paint-time effect: it never changes the element's layout
 * box, so the box keeps holding the *un-rotated* bitmap.  A quarter turn swaps
 * the width and height of what is *drawn*: a `boxWidth × boxHeight` box paints
 * as `boxHeight × boxWidth`.  Two callers use that fact differently —
 *
 *   - a container meant to hug the picture is sized from `displayedImageSize`
 *     and the transform carries the matching fit scale;
 *   - a container with a fixed box (Reading Mode, multi-image members) keeps the
 *     box and needs the legacy fit scale that shrinks the drawing back inside
 *     it, which `applyOrientationPreview` measures when no scale is supplied.
 *
 * A lone image's width is written down in the second of these two frames: the
 * *box* holds the un-rotated bitmap, the *screen* is what the reader sees, and
 * `boxForScreenWidth` / `pinScreenWidthForTurn` convert between them.  The two
 * coincide for every even orientation and differ by one aspect for a quarter
 * turn.
 */

import type { OrientationState } from './orientation';
import { orientationToCss, orientedSize } from './orientation';

/** Size the `object-fit: contain` drawing occupies in a box, i.e. the content
 *  before any transform.  `aspect` is the image's natural width/height; a
 *  non-positive aspect is taken as the box's own, so the content fills it. */
function containedContent(
    boxWidth: number,
    boxHeight: number,
    aspect: number
): { width: number; height: number } {
    const a = aspect > 0 && Number.isFinite(aspect) ? aspect : boxWidth / boxHeight;
    return boxWidth / boxHeight >= a
        ? { width: boxHeight * a, height: boxHeight } // box wider than the content: height limited
        : { width: boxWidth, height: boxWidth / a }; // box narrower than the content: width limited
}

/** The image's natural aspect, falling back to the box's own when the bitmap
 *  has not reported a size. */
function naturalAspect(img: HTMLImageElement): number {
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (nw > 0 && nh > 0) return nw / nh;
    return img.clientHeight > 0 ? img.clientWidth / img.clientHeight : 1;
}

/**
 * Fit scale that shrinks a quarter turn's drawing back inside its own box. The
 * box is sized for the un-rotated aspect, so a bare `rotate(90deg|270deg)` makes
 * the drawing measure `boxHeight × boxWidth` and overflow it; scaling by this
 * factor letterboxes the whole image inside the original box. Returns 1 when
 * nothing needs shrinking — it never scales up.
 *
 * Both sides are measured about the box centre, and it is rounded to the four
 * decimals the CSS transform carries, so the drawn size predicted from this
 * matches the size the browser paints.
 */
function measuredQuarterTurnScale(img: HTMLImageElement): number {
    const bw = img.clientWidth;
    const bh = img.clientHeight;
    if (bw <= 0 || bh <= 0) return 1;
    const content = containedContent(bw, bh, naturalAspect(img));
    if (content.width <= 0 || content.height <= 0) return 1;
    // After a quarter turn the drawn content measures (content.h × content.w).
    const k = Math.min(bw / content.height, bh / content.width);
    return Number.isFinite(k) && k < 1 ? Number(k.toFixed(4)) : 1;
}

export interface PreviewOptions {
    /** Uniform fit scale prefixed onto the transform.  When supplied it is used
     *  verbatim (so a container sized by `displayedImageSize` paints exactly what
     *  that function predicted); when omitted the scale is measured off the
     *  element's own box for the fixed-box callers. */
    scale?: number;
}

export function applyOrientationPreview(
    img: HTMLImageElement,
    state: OrientationState,
    opts?: PreviewOptions
): void {
    let css = orientationToCss(state);
    if (css && state.turns % 2 === 1) {
        const k = opts?.scale ?? measuredQuarterTurnScale(img);
        if (k < 1) css = `scale(${k}) ${css}`;
    }
    img.style.transform = css;
}

/**
 * Size a container should take to hug the picture drawn for `state`, when the
 * image sits in a `boxWidth × boxHeight` layout box.  A quarter turn (odd
 * `turns`) swaps the drawn width and height — the picture's own scale is
 * untouched; everything else draws at the box's size.
 *
 * `maxWidth`, when given, is a hard page cap: if the swapped width would overrun
 * it the whole picture is scaled by a single fit factor so its width lands on
 * the cap.  The returned `scale` is that factor (1 when nothing is capped) and
 * must be handed to `applyOrientationPreview` so the painted picture and the
 * container agree.
 */
export function displayedImageSize(
    boxWidth: number,
    boxHeight: number,
    state: OrientationState,
    maxWidth?: number
): { width: number; height: number; scale: number } {
    if (boxWidth <= 0 || boxHeight <= 0) return { width: boxWidth, height: boxHeight, scale: 1 };
    const swapped = orientedSize(state, boxWidth, boxHeight);
    let scale = 1;
    if (maxWidth !== undefined && maxWidth > 0 && swapped.width > maxWidth) {
        const k = maxWidth / swapped.width;
        if (Number.isFinite(k) && k < 1) scale = Number(k.toFixed(4));
    }
    return { width: swapped.width * scale, height: swapped.height * scale, scale };
}

/** Aspect with the degenerate values filtered out, so callers can divide. */
function usableAspect(aspect: number): number {
    return aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
}

/**
 * The layout box that draws `screenWidth` across the page for `state`.
 *
 * The box holds the un-rotated bitmap, so its own aspect is always the bitmap's
 * (`aspect` = natural width / natural height) and an even orientation draws it
 * verbatim.  A quarter turn repaints it on its side, which puts the picture's
 * on-page width under the box's *height* — the box therefore has to be
 * `screenWidth × aspect` wide for the height it reports to land on
 * `screenWidth`.  Passing the result through `displayedImageSize` gets back the
 * size the reader sees.
 */
export function boxForScreenWidth(
    screenWidth: number,
    aspect: number,
    state: OrientationState
): { width: number; height: number } {
    const a = usableAspect(aspect);
    return state.turns % 2 === 1
        ? { width: screenWidth * a, height: screenWidth }
        : { width: screenWidth, height: screenWidth / a };
}

/**
 * The screen width a row must carry after a turn for the picture to come out
 * the size it went in at — the box is what holds that size, and a quarter turn
 * repaints the box on its side, so holding the box put means moving the written
 * width by one aspect.  Null when the turn leaves the box's handedness alone
 * (an even turn: 180° and both flips), where the written width is already right.
 */
export function pinScreenWidthForTurn(
    currentScreenWidth: number,
    aspect: number,
    current: OrientationState,
    next: OrientationState
): number | null {
    if (current.turns % 2 === next.turns % 2) return null;
    const a = usableAspect(aspect);
    return next.turns % 2 === 1 ? currentScreenWidth / a : currentScreenWidth * a;
}
