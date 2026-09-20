/**
 * Geometry probe switch (temporary diagnostics).
 *
 * The layout bugs under investigation only reproduce in a live Obsidian window,
 * so the evidence has to be collected from log.txt.  A probe is a snapshot taken
 * at a known moment that always reaches the file, regardless of the configured
 * log level — otherwise the default ERROR gate would drop every INFO snapshot.
 *
 * Two entry points:
 *   - `emitSnapshot` — a keyed snapshot, emitted once per distinct payload so a
 *     settle loop cannot flood the file with the same frame;
 *   - `probeDebug`  — a raw one-off note for events that are not snapshots.
 *
 * `changed` is a separate, always-on helper used to collapse the pre-existing
 * high-volume debug logs (a per-frame dimension diff) down to actual changes.
 */

import { logger } from "../logger";

let enabled = false;
let seq = 0;
const lastSnapshot = new Map<string, string>();
const lastChanged = new Map<string, string>();

export function setGeometryProbeEnabled(value: boolean): void {
    if (enabled === value) return;
    enabled = value;
    lastSnapshot.clear();
    if (value) seq = 0;
}

export function isGeometryProbeEnabled(): boolean {
    return enabled;
}

/** Monotonic snapshot ordinal, so a reader can order snapshots across channels. */
export function nextProbeSeq(): number {
    return ++seq;
}

export function emitSnapshot(
    key: string,
    message: string,
    payload: Record<string, unknown>
): void {
    if (!enabled) return;
    let json: string;
    try {
        json = JSON.stringify(payload);
    } catch {
        return;
    }
    if (lastSnapshot.get(key) === json) return;
    lastSnapshot.set(key, json);
    logger.writeProbe(message, { seq: nextProbeSeq(), ...payload });
}

export function probeDebug(message: string, data?: Record<string, unknown>): void {
    if (!enabled) return;
    logger.writeProbe(message, { seq: nextProbeSeq(), ...(data ?? {}) });
}

/**
 * True the first time a key is seen and whenever its payload differs from the
 * last one.  Always on: it exists to strip repeated frames out of the existing
 * debug logs, not to add a probe.
 */
export function hasChanged(key: string, payload: unknown): boolean {
    let json: string;
    try {
        json = JSON.stringify(payload);
    } catch {
        return true;
    }
    if (lastChanged.get(key) === json) return false;
    lastChanged.set(key, json);
    return true;
}
