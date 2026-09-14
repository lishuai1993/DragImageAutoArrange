/**
 * Rotation / flip orientation math (P3).
 *
 * A displayed state is one of the 8 elements of the dihedral group D4,
 * canonicalised as `{ turns, mirror }`:
 *   forward = (mirror ? horizontalFlip : identity) ∘ rotateClockwise(turns * 90°)
 *
 * Composition happens in 2×2 integer matrix space so that user clicks compose
 * onto the *currently displayed* orientation (`newForward = op ∘ current`),
 * then the result is canonicalised back to `{ turns, mirror }`.  Everything here
 * is pure so the matrix algebra is unit-testable without an Obsidian runtime.
 *
 * Matrices are row-major `[a, b, c, d]` representing the linear map
 * `(x, y) → (a·x + b·y, c·x + d·y)`.
 */

export interface OrientationState {
    /** Clockwise quarter-turns (0..3). */
    turns: 0 | 1 | 2 | 3;
    /** True when a horizontal mirror is applied after the rotation. */
    mirror: boolean;
}

export type TransformOp =
    | 'rotate90cw'
    | 'rotate90ccw'
    | 'rotate180'
    | 'flipHorizontal'
    | 'flipVertical';

type Mat = readonly [number, number, number, number];

const ID = [1, 0, 0, 1] as const;

/** Clockwise 90° (row-major). Verified: source right edge maps to the bottom row. */
const R90CW: Mat = [0, -1, 1, 0];
const R90CCW: Mat = [0, 1, -1, 0];
const R180: Mat = [-1, 0, 0, -1];
const FLIP_H: Mat = [-1, 0, 0, 1]; // horizontal mirror (about the vertical axis)
const FLIP_V: Mat = [1, 0, 0, -1];

export const ORIENTATION_OPS: Record<TransformOp, Mat> = {
    rotate90cw: R90CW,
    rotate90ccw: R90CCW,
    rotate180: R180,
    flipHorizontal: FLIP_H,
    flipVertical: FLIP_V,
};

export const IDENTITY_STATE: OrientationState = { turns: 0, mirror: false };

function mul(a: Mat, b: Mat): Mat {
    const [a0, b0, c0, d0] = a;
    const [a1, b1, c1, d1] = b;
    return [
        a0 * a1 + b0 * c1,
        a0 * b1 + b0 * d1,
        c0 * a1 + d0 * c1,
        c0 * b1 + d0 * d1,
    ];
}

function rotPower(turns: number): Mat {
    let m: Mat = ID;
    for (let i = 0; i < turns; i++) m = mul(m, R90CW);
    return m;
}

/** Forward map (content space → displayed space) of a canonical state. */
export function stateToMatrix(state: OrientationState): Mat {
    const base = rotPower(state.turns);
    return state.mirror ? mul(FLIP_H, base) : base;
}

/** Resulting canvas/box dimensions when a `bw × bh` source is oriented. */
export function orientedSize(
    state: OrientationState,
    bw: number,
    bh: number
): { width: number; height: number } {
    const odd = state.turns % 2 === 1;
    return odd ? { width: bh, height: bw } : { width: bw, height: bh };
}

function det(m: Mat): number {
    return m[0] * m[3] - m[1] * m[2];
}

function matricesEqual(a: Mat, b: Mat): boolean {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/** Reduce an arbitrary D4 matrix back to canonical `{ turns, mirror }`. */
function matrixToState(m: Mat): OrientationState {
    const mirrored = det(m) < 0;
    // Undo the mirror so the remainder is a pure rotation: R = FLIP_H ∘ M.
    const pure: Mat = mirrored ? mul(FLIP_H, m) : m;
    for (let t = 0 as 0 | 1 | 2 | 3; t < 4; t = (t + 1) as 0 | 1 | 2 | 3) {
        if (matricesEqual(pure, rotPower(t))) {
            return { turns: t, mirror: mirrored };
        }
    }
    return IDENTITY_STATE;
}

/** Compose a user operation onto the current displayed orientation. */
export function composeOrientation(
    current: OrientationState,
    op: TransformOp
): OrientationState {
    return matrixToState(mul(ORIENTATION_OPS[op], stateToMatrix(current)));
}

export function isIdentityOrientation(state: OrientationState): boolean {
    return state.turns === 0 && !state.mirror;
}

// ── Word form of the eight states ───────────────────────────────────────
// The orientation rides in the embed line's parameter slot as a readable word,
// so a note stays legible by hand.  Eight words, eight states, both directions
// total: every state has exactly one spelling and every spelling one state.
// `orig` is a real code rather than an omitted-default, so once a row carries
// the slot it always says what it means.

export type OrientationWord =
    | 'orig' | 'r90' | 'r180' | 'r270'
    | 'fh' | 'fv' | 'r90fh' | 'r270fh';

const WORD_TO_STATE: Record<OrientationWord, OrientationState> = {
    orig: { turns: 0, mirror: false },
    r90: { turns: 1, mirror: false },
    r180: { turns: 2, mirror: false },
    r270: { turns: 3, mirror: false },
    fh: { turns: 0, mirror: true },
    // FLIP_H ∘ R180 = FLIP_V, so the mirrored half-turn reads as a plain flip.
    fv: { turns: 2, mirror: true },
    r90fh: { turns: 1, mirror: true },
    r270fh: { turns: 3, mirror: true },
};

const STATE_TO_WORD = new Map<string, OrientationWord>(
    (Object.entries(WORD_TO_STATE) as Array<[OrientationWord, OrientationState]>)
        .map(([word, state]) => [`${state.turns}:${state.mirror}`, word])
);

export function orientationWord(state: OrientationState): OrientationWord {
    return STATE_TO_WORD.get(`${state.turns}:${state.mirror}`) ?? 'orig';
}

export function isOrientationWord(token: string | undefined): token is OrientationWord {
    return token !== undefined && Object.prototype.hasOwnProperty.call(WORD_TO_STATE, token);
}

/**
 * Read the orientation word a `|`-joined param string opens with, or null when
 * it opens with anything else. A null return is not "identity" — it means the
 * slot is absent, which callers that must preserve an existing slot need to
 * tell apart from an explicit `orig`.
 */
export function parseOrientationWord(paramStr: string): OrientationState | null {
    const first = paramStr.split('|', 1)[0];
    return isOrientationWord(first) ? WORD_TO_STATE[first] : null;
}

/**
 * CSS transform that renders the current orientation.  The CSS function list is
 * applied right-to-left, so `scaleX(-1) rotate(θ)` yields FLIP_H ∘ R(turns),
 * exactly the same forward map used for canvas persistence.
 */
export function orientationToCss(state: OrientationState): string {
    if (isIdentityOrientation(state)) return '';
    const parts: string[] = [];
    if (state.mirror) parts.push('scaleX(-1)');
    if (state.turns > 0) parts.push(`rotate(${state.turns * 90}deg)`);
    return parts.join(' ');
}
