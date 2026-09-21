/**
 * A gate for high-volume debug logs.
 *
 * Some of the render paths write a debug line per frame, and a settle burst
 * repeats the same payload dozens of times. `hasChanged` collapses those to the
 * frames that actually differ, so a debug log stays readable without any of the
 * callers having to track the previous value themselves.
 *
 * Always on, and deliberately so: it removes repeated frames from logs that
 * already exist rather than adding anything of its own. Per-key, because
 * several rows settle at once and a single shared value would suppress a
 * change in one row whenever another row happened to be quieter.
 */

const lastChanged = new Map<string, string>();

/**
 * True the first time a key is seen and whenever its payload differs from the
 * last one. A payload that cannot be serialised is treated as always changed —
 * the caller asked for a log line, and dropping it silently would be worse
 * than printing it twice.
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
