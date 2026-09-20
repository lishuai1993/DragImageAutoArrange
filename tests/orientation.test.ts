import { describe, it, expect } from 'vitest';
import {
    composeOrientation,
    isIdentityOrientation,
    isOrientationWord,
    orientationToCss,
    orientationWord,
    orientedSize,
    parseOrientationWord,
    quarterTurnFitScale,
    stateToMatrix,
    type OrientationState,
} from '../src/imageTransform/orientation';

// Note: identityOrientationFactory is not exported by the module; keep a local
// identity constant mirroring IDENTITY_STATE for readability.
const identity = (): OrientationState => ({ turns: 0, mirror: false });

describe('orientation algebra', () => {
    it('identity renders no CSS and reports identity', () => {
        const s = identity();
        expect(isIdentityOrientation(s)).toBe(true);
        expect(orientationToCss(s)).toBe('');
    });

    it('rotate90cw from identity is a pure clockwise quarter turn', () => {
        const s = composeOrientation(identity(), 'rotate90cw');
        expect(s).toEqual({ turns: 1, mirror: false });
        expect(orientationToCss(s)).toBe('rotate(90deg)');
    });

    it('two clockwise rotations compose to 180°', () => {
        const once = composeOrientation(identity(), 'rotate90cw');
        const twice = composeOrientation(once, 'rotate90cw');
        expect(twice).toEqual({ turns: 2, mirror: false });
        expect(orientationToCss(twice)).toBe('rotate(180deg)');
    });

    it('rotate90ccw undoes rotate90cw', () => {
        const cw = composeOrientation(identity(), 'rotate90cw');
        const back = composeOrientation(cw, 'rotate90ccw');
        expect(isIdentityOrientation(back)).toBe(true);
        expect(orientationToCss(back)).toBe('');
    });

    it('horizontal flip twice returns to identity', () => {
        const once = composeOrientation(identity(), 'flipHorizontal');
        expect(once).toEqual({ turns: 0, mirror: true });
        expect(orientationToCss(once)).toBe('scaleX(-1)');
        const twice = composeOrientation(once, 'flipHorizontal');
        expect(isIdentityOrientation(twice)).toBe(true);
    });

    it('vertical flip twice returns to identity', () => {
        const once = composeOrientation(identity(), 'flipVertical');
        const twice = composeOrientation(once, 'flipVertical');
        expect(isIdentityOrientation(twice)).toBe(true);
    });

    it('flipH then flipV is a 180° rotation', () => {
        const fh = composeOrientation(identity(), 'flipHorizontal');
        const fvAfter = composeOrientation(fh, 'flipVertical');
        expect(fvAfter).toEqual({ turns: 2, mirror: false });
    });

    it('the eight orientation states stay distinct', () => {
        const start = identity();
        const closed = new Set<string>([JSON.stringify(start)]);
        const stack: Array<{ s: OrientationState; by: string }> = [
            { s: start, by: '' },
        ];
        while (stack.length) {
            const { s } = stack.pop()!;
            for (const op of ['rotate90cw', 'flipHorizontal', 'flipVertical'] as const) {
                const next = composeOrientation(s, op);
                const key = JSON.stringify(next);
                if (!closed.has(key)) {
                    closed.add(key);
                    stack.push({ s: next, by: key });
                }
            }
        }
        expect(closed.size).toBe(8);
        const css = new Set<string>();
        for (const key of closed) {
            css.add(orientationToCss(JSON.parse(key) as OrientationState));
        }
        expect(css.size).toBe(8);
    });

    it('orientedSize swaps dimensions only for odd quarter turns', () => {
        expect(orientedSize({ turns: 0, mirror: false }, 10, 3)).toEqual({ width: 10, height: 3 });
        expect(orientedSize({ turns: 1, mirror: false }, 10, 3)).toEqual({ width: 3, height: 10 });
        expect(orientedSize({ turns: 3, mirror: false }, 10, 3)).toEqual({ width: 3, height: 10 });
        expect(orientedSize({ turns: 2, mirror: true }, 10, 3)).toEqual({ width: 10, height: 3 });
    });

    it('quarterTurnFitScale folds the turned rectangle back into its own box', () => {
        // The turned rectangle is the upright one on its side; fitting it back
        // inside means scaling by the ratio between the two aspects, and it is
        // never above 1 — a turn only ever shrinks a picture.
        expect(quarterTurnFitScale(16 / 9)).toBeCloseTo(9 / 16, 12);
        expect(quarterTurnFitScale(1 / 2)).toBeCloseTo(1 / 2, 12);
        expect(quarterTurnFitScale(1)).toBe(1);
        // Degenerate aspects fall back to no scaling rather than dividing by 0.
        expect(quarterTurnFitScale(0)).toBe(1);
        expect(quarterTurnFitScale(Number.NaN)).toBe(1);
        expect(quarterTurnFitScale(Number.POSITIVE_INFINITY)).toBe(1);
    });

    it('stateToMatrix of a mirror state has negative determinant', () => {
        const fh = composeOrientation(identity(), 'flipHorizontal');
        const m = stateToMatrix(fh);
        expect(m[0] * m[3] - m[1] * m[2]).toBe(-1);
    });
});

describe('orientation words', () => {
    const ALL_WORDS = ['orig', 'r90', 'r180', 'r270', 'fh', 'fv', 'r90fh', 'r270fh'] as const;

    it('spells each of the eight states with its own word', () => {
        const start = identity();
        const seen = new Map<string, string>();
        const stack: OrientationState[] = [start];
        const closed = new Map<string, OrientationState>([[JSON.stringify(start), start]]);
        while (stack.length) {
            const s = stack.pop()!;
            for (const op of ['rotate90cw', 'flipHorizontal', 'flipVertical'] as const) {
                const next = composeOrientation(s, op);
                const key = JSON.stringify(next);
                if (!closed.has(key)) {
                    closed.set(key, next);
                    stack.push(next);
                }
            }
        }
        expect(closed.size).toBe(ALL_WORDS.length);
        for (const state of closed.values()) {
            const word = orientationWord(state);
            expect(seen.has(word)).toBe(false);
            seen.set(word, word);
            expect(parseOrientationWord(word)).toEqual(state);
        }
        expect([...seen.keys()].sort()).toEqual([...ALL_WORDS].sort());
    });

    it('reads the word a param string opens with, ignoring what follows', () => {
        expect(parseOrientationWord('r90|left|120|48')).toEqual({ turns: 1, mirror: false });
        expect(parseOrientationWord('orig')).toEqual({ turns: 0, mirror: false });
        expect(parseOrientationWord('r270fh|0|400')).toEqual({ turns: 3, mirror: true });
    });

    it('reports no word for an absent or unrecognised slot', () => {
        expect(parseOrientationWord('')).toBeNull();
        expect(parseOrientationWord('left|120')).toBeNull();
        expect(parseOrientationWord('120|50')).toBeNull();
        expect(parseOrientationWord('r45')).toBeNull();
        expect(parseOrientationWord('constructor')).toBeNull();
    });

    it('recognises only the eight words', () => {
        expect(isOrientationWord('fv')).toBe(true);
        expect(isOrientationWord('left')).toBe(false);
        expect(isOrientationWord('100')).toBe(false);
        expect(isOrientationWord(undefined)).toBe(false);
    });
});
