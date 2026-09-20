/**
 * Geometry snapshot — pure arithmetic for the layout diagnostics.
 *
 * Any rendering symptom is a divergence between three moments of one image:
 *
 *   - the MODEL   — what the layout engine computed (fill, share, drawn height);
 *   - the WRITE   — the style values we handed to the DOM;
 *   - the MEASURE — what the browser actually reports afterwards.
 *
 * These functions turn those three into a list of violated invariants, so the
 * log line says *which* link broke rather than leaving the reader to diff
 * numbers by eye.  Everything here is pure: no DOM, no logger.
 */

import type { OrientationState } from "../imageTransform/orientation";
import { IDENTITY_STATE, parseOrientationWord } from "../imageTransform/orientation";

/** The rectangle the layout engine computed for one image. */
export interface ModelGeometry {
    /** Row fill ratio, or null when the row carries no fill. */
    fill: number | null;
    /** Width share written onto this member; null for a lone image. */
    share: number | null;
    /** Orientation word ("orig", "r270", ...). */
    word: string;
    /** Natural width / height of the bitmap; 1 when unknown. */
    aspect: number;
    /** Layout box (the un-rotated rectangle) the model wants on the <img>. */
    boxW: number;
    boxH: number;
    /** Height the model wants the *container* to take, i.e. what the picture
     *  paints as — the item in LP, the embed in RM. */
    drawn: number;
    /** Transform scale the model expects for a quarter turn; null = not turned,
     *  in which case the fit scale is whatever the box itself implies. */
    expectedScale: number | null;
}

/** The values our own code set, read back from the style strings we wrote. */
export interface WroteGeometry {
    imgW: number | null;
    imgH: number | null;
    itemW: number | null;
    itemH: number | null;
    imgTransform: string;
}

/** What the browser reports after the write has settled. */
export interface MeasuredGeometry {
    /** Container box (the `.diaa-item` in LP, the `.internal-embed` in RM). */
    itemW: number;
    itemH: number;
    /** The <img> layout box, i.e. before any transform. */
    imgClientW: number;
    imgClientH: number;
    /** The <img> painted rectangle, i.e. after the transform. */
    paintW: number;
    paintH: number;
    /** Painted rect top-left relative to the container's top-left. */
    paintOffsetX: number;
    paintOffsetY: number;
    transform: string;
    display: string;
}

export interface MemberFrames {
    label: string;
    model: ModelGeometry;
    wrote: WroteGeometry;
    measured: MeasuredGeometry;
}

export const FAIL = {
    boxWrite: "I1.box-write",
    boxSurvived: "I2.box-survived",
    boxWidth: "I2.box-width",
    transformMissing: "I3.transform-missing",
    transformScale: "I3.transform-scale",
    paintMismatch: "I4.paint",
    slotHeight: "I5.slot-height",
    fillArithmetic: "I6.fill-arith",
    paintOverflow: "I7.paint-overflow",
} as const;

export type FailCode = (typeof FAIL)[keyof typeof FAIL];

const DEFAULT_TOL = 1;

export function orientationOf(word: string): OrientationState {
    return parseOrientationWord(word) ?? IDENTITY_STATE;
}

export function isQuarterTurn(word: string): boolean {
    return orientationOf(word).turns % 2 === 1;
}

/** Fit scale that shrinks a quarter turn's drawing back inside a box whose
 *  content fills it — the case the fixed-box callers measure at runtime. */
export function quarterTurnFitScale(boxW: number, boxH: number): number {
    if (boxW <= 0 || boxH <= 0) return 1;
    const k = Math.min(boxW / boxH, boxH / boxW);
    return Number.isFinite(k) && k < 1 ? Number(k.toFixed(4)) : 1;
}

/** The rectangle `model` claims the picture will paint as. A quarter turn
 *  repaints the box on its side, so the box's height becomes the drawn width. */
export function predictedPaint(model: ModelGeometry): { width: number; height: number } {
    if (!isQuarterTurn(model.word)) return { width: model.boxW, height: model.boxH };
    const k = model.expectedScale ?? quarterTurnFitScale(model.boxW, model.boxH);
    return { width: model.boxH * k, height: model.boxW * k };
}

/** Uniform scale a computed transform applies. Null when there is no
 *  transform at all; 1 when the transform only rotates or flips. */
export function scaleOfTransform(transform: string): number | null {
    const t = transform.trim();
    if (!t || t === "none") return null;
    const matrix = /matrix\(([^)]+)\)/.exec(t);
    if (matrix) {
        const parts = matrix[1].split(",").map((s) => Number.parseFloat(s.trim()));
        if (parts.length >= 4 && parts.slice(0, 4).every(Number.isFinite)) {
            return Number(Math.hypot(parts[0], parts[1]).toFixed(4));
        }
    }
    const scale = /(^|[\s(])scale\(\s*([-0-9.eE]+)/.exec(t);
    if (scale) {
        const v = Number.parseFloat(scale[2]);
        if (Number.isFinite(v)) return Number(Math.abs(v).toFixed(4));
    }
    return 1;
}

/**
 * Which invariants the three frames disagree on, in report order.
 *
 * The container's own measured width is the slot: the fill and drawn-height
 * checks are anchored to the rectangle the member actually occupies, not to a
 * re-derivation of the flex arithmetic, which would only add its own rounding
 * to the verdict.
 */
export function memberFailures(frames: MemberFrames, tol: number = DEFAULT_TOL): FailCode[] {
    const { model, wrote, measured } = frames;
    const out: FailCode[] = [];
    const turned = isQuarterTurn(model.word);
    const predicted = predictedPaint(model);
    const slotW = measured.itemW;

    // A write other than the layout's own — the mutation observer putting the
    // item's height back on the img, say — shows up here as a changed witness.
    if (wrote.imgH !== null && Math.abs(wrote.imgH - model.boxH) > tol) {
        out.push(FAIL.boxWrite);
    }
    if (Math.abs(measured.imgClientH - model.boxH) > tol) {
        out.push(FAIL.boxSurvived);
    }
    if (model.boxW > 0 && Math.abs(measured.imgClientW - model.boxW) > tol) {
        out.push(FAIL.boxWidth);
    }

    if (turned) {
        const scale = scaleOfTransform(measured.transform);
        if (scale === null) {
            out.push(FAIL.transformMissing);
        } else if (model.expectedScale !== null && Math.abs(scale - model.expectedScale) > 1e-3) {
            out.push(FAIL.transformScale);
        }
    }

    if (
        Math.abs(measured.paintW - predicted.width) > tol ||
        Math.abs(measured.paintH - predicted.height) > tol
    ) {
        out.push(FAIL.paintMismatch);
    }

    if (Math.abs(measured.itemH - model.drawn) > tol) {
        out.push(FAIL.slotHeight);
    }

    if (model.fill !== null && slotW > 0) {
        if (
            Math.abs(measured.paintW - model.fill * slotW) > tol ||
            Math.abs(measured.paintH - model.drawn) > tol
        ) {
            out.push(FAIL.fillArithmetic);
        }
    }

    if (
        measured.paintOffsetX < -tol ||
        measured.paintOffsetY < -tol ||
        measured.paintOffsetX + measured.paintW > measured.itemW + tol ||
        measured.paintOffsetY + measured.paintH > measured.itemH + tol
    ) {
        out.push(FAIL.paintOverflow);
    }

    return out;
}

/** Compact payload for the log line: the three frames plus the verdict. */
export function snapshotPayload(
    frames: MemberFrames,
    failures?: FailCode[]
): Record<string, unknown> {
    const failed = failures ?? memberFailures(frames);
    const predicted = predictedPaint(frames.model);
    return {
        label: frames.label,
        word: frames.model.word,
        fill: frames.model.fill,
        share: frames.model.share,
        drawn: round(frames.model.drawn),
        box: [round(frames.model.boxW), round(frames.model.boxH)],
        wrote: {
            img: [frames.wrote.imgW, frames.wrote.imgH],
            itemH: frames.wrote.itemH,
            tf: frames.wrote.imgTransform,
        },
        measured: {
            item: [round(frames.measured.itemW), round(frames.measured.itemH)],
            imgBox: [round(frames.measured.imgClientW), round(frames.measured.imgClientH)],
            paint: [round(frames.measured.paintW), round(frames.measured.paintH)],
            offset: [round(frames.measured.paintOffsetX), round(frames.measured.paintOffsetY)],
            tf: frames.measured.transform,
            display: frames.measured.display,
        },
        predicted: [round(predicted.width), round(predicted.height)],
        fails: failed,
        ok: failed.length === 0,
    };
}

function round(v: number): number {
    return Number.isFinite(v) ? Math.round(v * 100) / 100 : v;
}

/** Two decimals is enough to tell a real geometry drift from sub-pixel noise. */
export function round2(v: number): number {
    return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}
