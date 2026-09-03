/**
 * Session-scoped store of in-flight rotation/flip orientations (P3).
 *
 * Keyed by the *image file's vault path*; each entry remembers the markdown note
 * that last edited it (so the close-of-note flush in main.ts knows when to write
 * the file).  Nothing here persists across sessions — if the user closes a note
 * the flush writes the composed orientation into the image file itself, so the
 * next open renders it from disk.
 */

import { logger } from '../logger';
import type { OrientationState } from './orientation';
import { isIdentityOrientation } from './orientation';

const log = logger.channel('transformStore');

interface PendingTransform {
    notePath: string;
    state: OrientationState;
}

const _pending = new Map<string, PendingTransform>();

export function getPendingTransform(imagePath: string): PendingTransform | null {
    return _pending.get(imagePath) ?? null;
}

export function getPendingState(imagePath: string): OrientationState | null {
    return _pending.get(imagePath)?.state ?? null;
}

/** Record an orientation applied from `notePath`; identity clears the entry. */
export function setPendingTransform(
    imagePath: string,
    notePath: string,
    state: OrientationState
): void {
    if (isIdentityOrientation(state)) {
        clearPendingTransform(imagePath);
        return;
    }
    _pending.set(imagePath, { notePath, state });
    log.debug('transform pending', { imagePath, notePath, turns: state.turns, mirror: state.mirror });
}

export function clearPendingTransform(imagePath: string): void {
    if (_pending.delete(imagePath)) {
        log.debug('transform pending cleared', { imagePath });
    }
}

export function pendingTransformCount(): number {
    return _pending.size;
}

export interface PendingEntry {
    imagePath: string;
    notePath: string;
    state: OrientationState;
}

/** Snapshot of every pending transform (paths whose file is not yet written). */
export function listPendingTransforms(): PendingEntry[] {
    const out: PendingEntry[] = [];
    for (const [imagePath, p] of _pending) {
        out.push({ imagePath, notePath: p.notePath, state: p.state });
    }
    return out;
}
