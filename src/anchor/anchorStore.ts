import { buildImageLineRe } from "../constants";
import { ImageRowIndex } from "./viewportAnchor";
import { logger } from "../logger";
import { LedgerSection } from "./anchorMath";

// ── Cross-mode viewport sync state ──────────────────────────────────
// The shared, mutable state behind RM↔LP scroll synchronization, kept
// behind a narrow accessor interface (same "module-private + accessors"
// convention as rmAlignStore.ts). scrollAnchor.ts owns the DOM/timing
// machinery (RAF ids, scroll-tracking cleanups) locally; only the state
// that multiple capture/restore/mode-switch functions share lives here.

// ── Anchor type ─────────────────────────────────────────────────────

export type ViewportAnchor =
  | {
      kind: "text";
      anchorText: string;    // trimmed source/rendered text of the anchor line
      anchorContext?: string; // 3-line normalized context: prevLineTail + "\n" +
                             // currentLine + "\n" + nextLineHead. Used as the
                             // primary match key in template-heavy docs where
                             // single-line fragments are ambiguous; falls back
                             // to anchorText when context match fails.
      headingHint?: string;  // nearest preceding heading text (normalized, no #
                             // markers). Used as a secondary disambiguation
                             // prior when context matching still has multiple
                             // candidates. Experimental (Phase 4.2).
      anchorOffset: number;  // pixel distance from viewport top to the line top
      anchorLine?: number;   // 1-based source line at capture (LP capture only).
                             // Lets the RM restore park at the renderer height
                             // ledger's Y for this line while the first-show
                             // layout is still transient (DOM rects lie there).
      nearestImgBefore: number; // image-row index just above (0 if none)
      nearestImgAfter: number;  // image-row index just below (0 if none)
      docRatio: number;      // block top ÷ scroll height (0..1); -1 if unmeasurable.
                             // Mode-independent position prior for disambiguating
                             // multiple matches when no nearest image row is known.
      totalLines: number;    // total source lines in capture-mode doc (-1 if RM).
    }
  | { kind: "image-row"; imageRowIndex: number; intraRowRatio: number }
  | {
      kind: "image-gap";
      imgBefore: number; // image-row index above the gap (0 = boundary/text)
      imgAfter: number;  // image-row index below the gap (0 = boundary/text)
      gapRatio: number;  // normalized center position within the blank gap
    };

/** A per-mode "last seen" anchor slot: the anchor plus the file it belongs to
 *  (the file guard prevents seeding a switch from an unrelated document). */
export type LastAnchorSlot = { anchor: ViewportAnchor | null; file: string };

// ── Image row index cache ───────────────────────────────────────────

const _imageRowIndexCache = new Map<string, ImageRowIndex[]>();

export function setImageRowIndex(filePath: string, index: ImageRowIndex[]): void {
  _imageRowIndexCache.set(filePath, index);
}

export function getImageRowIndex(filePath: string): ImageRowIndex[] | undefined {
  return _imageRowIndexCache.get(filePath);
}

export function invalidateImageRowIndex(filePath: string): void {
  _imageRowIndexCache.delete(filePath);
}

// ── Active anchor (the one being restored right now) ────────────────

let _activeAnchor: ViewportAnchor | null = null;

export function getActiveAnchor(): ViewportAnchor | null {
  return _activeAnchor;
}

export function setActiveAnchor(anchor: ViewportAnchor | null): void {
  _activeAnchor = anchor;
}

// ── Per-mode last anchors ───────────────────────────────────────────
// Kept separate so the scroll noise generated when the INCOMING view
// becomes visible (e.g. LP editor firing a scroll at its stale scrollTop)
// cannot overwrite the OUTGOING mode's anchor.

let _rmLastAnchor: ViewportAnchor | null = null;
let _rmLastAnchorFile = "";
let _lpLastAnchor: ViewportAnchor | null = null;
let _lpLastAnchorFile = "";

export function setRMLastAnchor(anchor: ViewportAnchor | null, file: string): void {
  _rmLastAnchor = anchor;
  _rmLastAnchorFile = file;
}

export function getRMLastAnchor(): LastAnchorSlot {
  return { anchor: _rmLastAnchor, file: _rmLastAnchorFile };
}

export function setLPLastAnchor(anchor: ViewportAnchor | null, file: string): void {
  _lpLastAnchor = anchor;
  _lpLastAnchorFile = file;
}

export function getLPLastAnchor(): LastAnchorSlot {
  return { anchor: _lpLastAnchor, file: _lpLastAnchorFile };
}

// ── Multi-anchor list (RM capture) ───────────────────────────────────
// In addition to the single primary anchor, capture up to 3 visible text
// blocks from RM. On LP restore, resolve all of them and validate spatial
// consistency — a consensus across multiple anchors is more robust than
// any single anchor's disambiguation priors when the fragment is ambiguous.

let _rmLastAnchorList: ViewportAnchor[] = [];
let _rmLastAnchorListFile = "";

export function setRMLastAnchorList(anchors: ViewportAnchor[], file: string): void {
  _rmLastAnchorList = anchors;
  _rmLastAnchorListFile = file;
}

export function getRMLastAnchorList(): { anchors: ViewportAnchor[]; file: string } {
  return { anchors: _rmLastAnchorList, file: _rmLastAnchorListFile };
}

// ── Fallback scroll percentage ──────────────────────────────────────

let _fallbackPct = -1;
let _lastFallbackPct = -1;

export function getFallbackPct(): number {
  return _fallbackPct;
}

export function setFallbackPct(pct: number): void {
  _fallbackPct = pct;
}

export function getLastFallbackPct(): number {
  return _lastFallbackPct;
}

export function setLastFallbackPct(pct: number): void {
  _lastFallbackPct = pct;
}

// ── Mode-switch tracking ────────────────────────────────────────────

let _lastMode = "";
let _lastDocH = 0;

export function getLastMode(): string {
  return _lastMode;
}

export function setLastMode(mode: string): void {
  _lastMode = mode;
}

export function getLastDocH(): number {
  return _lastDocH;
}

export function setLastDocH(docH: number): void {
  _lastDocH = docH;
}

// ── Editor dirty flag ──────────────────────────────────────────────
// Obsidian syncs `this.data` with the CM editor on every change, so we
// can't detect unsaved edits by comparing `this.data` with `editor.getValue()`.
// Instead, maintain our own flag from the editor-change event and clear it
// after pre-save or on mode switch.

let _editorDirty = false;

export function getEditorDirty(): boolean {
  return _editorDirty;
}

export function setEditorDirty(dirty: boolean): void {
  _editorDirty = dirty;
}

// ── Misc state ──────────────────────────────────────────────────────

// Single source of truth for "is this line an image row?". Defaults to the
// full built-in extension set; readingMode overrides it via setImageLineRe so
// a user's custom imageExtensions is honored identically everywhere.
let _imgLineRe: RegExp = buildImageLineRe("png,jpg,jpeg,gif,webp,svg,bmp,avif");

export function getImageLineRe(): RegExp {
  return _imgLineRe;
}

export function setImageLineRe(re: RegExp): void {
  _imgLineRe = re;
}


const log = logger.channel("scrollAnchor");

// ── Shared mutable scroll-sync state (P3 split) ──
// All module-local `let` state from the old scrollAnchor.ts now lives in this
// single const object. A const *binding* is immutable, but its *properties*
// are writable and (as an imported binding) can be mutated from the feature
// modules without tripping TS2632 (no reassignment of an imported binding).
export const state: {
  _rmDeferredRestoreId: number | null;
  _rmLoopGuardActive: boolean;
  _accuracyTimer: number | null;
  _restoreGuardDepth: number;
  _restoreGuardTimeoutId: number | null;
  _lastGuardExitMs: number;
  _rmTrackedEl: HTMLElement | null;
  _rmScrollCleanup: (() => void) | null;
  _lastScrollLogTs: number;
  _rmSuppressCount: number;
  _rmSilenceCount: number;
  _lpSuppressCount: number;
  _lpSilenceCount: number;
  _rmRestoreStartTime: number;
  _rmNativeTried: boolean;
  _rmFramesSinceNative: number;
  _rmHoldId: number | null;
  _rmHoldCleanup: (() => void) | null;
  _rmHoldChainId: number | null;
  _earlyRestoreId: number | null;
  _lpEarlyRestoreDone: boolean;
  _rmEarlyRestoreDone: boolean;
  _lpTrackedEl: HTMLElement | null;
  _lpScrollCleanup: (() => void) | null;
  _lpDeferredRestoreId: number | null;
} = {
  _rmDeferredRestoreId: null,
  _rmLoopGuardActive: false,
  _accuracyTimer: null,
  _restoreGuardDepth: 0,
  _restoreGuardTimeoutId: null,
  _lastGuardExitMs: 0,
  _rmTrackedEl: null,
  _rmScrollCleanup: null,
  _lastScrollLogTs: 0,
  _rmSuppressCount: 0,
  _rmSilenceCount: 0,
  _lpSuppressCount: 0,
  _lpSilenceCount: 0,
  _rmRestoreStartTime: 0,
  _rmNativeTried: false,
  _rmFramesSinceNative: 0,
  _rmHoldId: null,
  _rmHoldCleanup: null,
  _rmHoldChainId: null,
  _earlyRestoreId: null,
  _lpEarlyRestoreDone: false,
  _rmEarlyRestoreDone: false,
  _lpTrackedEl: null,
  _lpScrollCleanup: null,
  _lpDeferredRestoreId: null,
};

// ── Read-only constants / shared maps (imported by name) ──
export const MIN_ANCHOR_TEXT_LEN = 4;
export const TABLE_ROW_RE = /^\s*[|│├┌└]/;
export const TABLE_SPLIT_RE = /[|│┬┴┼┤├]/;
export const BOX_DRAWING_RE = /[─-╿]/g;
export const _sectionSnapshot = new Map<string, LedgerSection[]>();
export const _snapshotLineCount = new Map<string, number>();
export const LEDGER_DOCH_TOLERANCE = 0.2;  // ledger sum vs live scrollHeight sanity band
export const LEDGER_PARK_TOL_MIN = 1500;   // px — legitimate estimate drift stays far below
export const LEDGER_PARK_TOL_FRAC = 0.05;  // of docH — transient discrepancy is ~65% of docH
export const RATIO_GATE_TOL = 0.15;        // LP vs RM docRatio naturally differs by a few pts
export const ENABLE_NATIVE_SCROLL = true;
export const SILENCE_WINDOW_MS = 300;
export const RM_RESTORE_TIMEOUT_MS = 5000;
export const NATIVE_RETRY_INTERVAL = 30; // frames between setEphemeralState re-pushes (text anchors)
export const RM_EMBED_WAIT_MS = 500;     // P4-C2: per-cycle budget to await the target embed
                                         // appearing in the DOM (image anchors). ~= the old
                                         // NATIVE_RETRY_INTERVAL cadence (30 frames), but gated on
                                         // the real MutationObserver signal instead of a frame count.
export const RM_HOLD_TIMEOUT_MS = 2000;
export const RM_HOLD_CALM_FRAMES = 6; // consecutive no-correction frames = settled
export const EARLY_RESTORE_MAX_FRAMES = 25; // B-4: 6→25 — give cold RM render + post-processor time to build target DOM after content edits
export const RM_EARLY_HOLD_FRAMES = 4;

// ── State-touching helpers (used by the feature modules) ──

export function getRMDeferredRestoreId(): number | null {
  return state._rmDeferredRestoreId;
}



export function rmLoopEnterGuard(): void {
  if (!state._rmLoopGuardActive) { enterRestoreGuard(); state._rmLoopGuardActive = true; }
}


export function cancelAllRestoreChains(): void {
  if (state._rmHoldId !== null) {
    cancelAnimationFrame(state._rmHoldId);
    state._rmHoldId = null;
  }
  if (state._rmHoldCleanup) {
    state._rmHoldCleanup();
    state._rmHoldCleanup = null;
  }
  if (state._rmDeferredRestoreId !== null) {
    cancelAnimationFrame(state._rmDeferredRestoreId);
    state._rmDeferredRestoreId = null;
  }
  if (state._lpDeferredRestoreId !== null) {
    cancelAnimationFrame(state._lpDeferredRestoreId);
    state._lpDeferredRestoreId = null;
  }
  if (state._earlyRestoreId !== null) {
    cancelAnimationFrame(state._earlyRestoreId);
    state._earlyRestoreId = null;
  }
  cancelRMHoldChain();
}



export function applySnapshotLineDelta(
  file: string, newLineCount: number, editLine: number,
): void {
  const oldCount = _snapshotLineCount.get(file);
  const snap = _sectionSnapshot.get(file);
  if (oldCount === undefined || !snap || snap.length === 0) return;

  const delta = newLineCount - oldCount;
  if (delta === 0) { _snapshotLineCount.set(file, newLineCount); return; }

  // Iterate backwards — splicing while iterating is safe this way.
  for (let i = snap.length - 1; i >= 0; i--) {
    const sec = snap[i];
    const { lineStart, lineEnd } = sec;
    if (lineStart !== undefined && lineStart > editLine) {
      sec.lineStart = lineStart + delta;
      if (lineEnd !== undefined) sec.lineEnd = lineEnd + delta;
    } else if (lineEnd !== undefined && lineEnd >= editLine) {
      snap.splice(i, 1);
    }
  }

  _snapshotLineCount.set(file, newLineCount);
}

// ── RM height-ledger lookup ─────────────────────────────
// Obsidian's preview renderer keeps a JS height ledger (renderer.sections)
// that survives display:none — it's why docH is full-scale on the very first
// frame of a mode switch. During that first-show window the DOM sits in a
// transient compact layout (leading spacers not yet re-established), so DOM
// rects lie about positions while the ledger already knows the settled truth.
// Read the ledger directly; anything unexpected → -1 and the caller falls
// back to DOM measurement / the docRatio prior.


export function setLastAnchor(anchor: ViewportAnchor | null, file: string): void {
  setRMLastAnchor(anchor, file);
  if (anchor && file && !getLPLastAnchor().anchor) {
    setLPLastAnchor(anchor, file);
  }
}

// ── Small helpers ──────────────────────────────────────

/** Clamp a raw ratio into [0,1], warning when the measured geometry produced
 *  an out-of-range value (a signal the layout drifted from expectations). */


export function rmLoopExitGuard(): void {
  if (state._rmLoopGuardActive) { exitRestoreGuard(); state._rmLoopGuardActive = false; }
}



export function enterRestoreGuard(): void {
  state._restoreGuardDepth++;
  if (state._restoreGuardTimeoutId) window.clearTimeout(state._restoreGuardTimeoutId);
  state._restoreGuardTimeoutId = window.setTimeout(() => {
    log.warn("RESTORE_GUARD safety timeout — force-released");
    state._restoreGuardDepth = 0;
    state._lastGuardExitMs = performance.now();
  }, 2000);
}


export function setSectionSnapshot(file: string, secs: LedgerSection[], totalLines?: number): void {
  _sectionSnapshot.set(file, secs);
  if (totalLines !== undefined && totalLines > 0) {
    _snapshotLineCount.set(file, totalLines);
  }
}

/** Apply a line-count delta to the snapshot after an edit before a full re-warmup.
 *  Sections entirely after editLine get their lineStart/lineEnd shifted by delta.
 *  Sections that straddle editLine are removed (stale), falling back to live ledger. */


export function exitRestoreGuard(): void {
  state._restoreGuardDepth = Math.max(0, state._restoreGuardDepth - 1);
  if (state._restoreGuardDepth === 0 && state._restoreGuardTimeoutId) {
    window.clearTimeout(state._restoreGuardTimeoutId);
    state._restoreGuardTimeoutId = null;
    state._lastGuardExitMs = performance.now();
  }
}


export function isRestoreGuardActive(): boolean { return state._restoreGuardDepth > 0; }


export function isInSilenceWindow(): boolean {
  return state._lastGuardExitMs > 0 && (performance.now() - state._lastGuardExitMs) < SILENCE_WINDOW_MS;
}

// ── Native line-based scroll ──────────────────────────────────────────
// Two-phase restore engine (Solution A): when a precise pixel restore fails
// because the target row isn't rendered (cold RM / virtualized region), coerce
// the renderer to build DOM around the target line itself instead of crawling
// from scrollTop=0. This eliminates the ~1.5s "jump to document head" during
// the first switch to a deep region. Falls back to the legacy percentage-based
// coarse-jump (restoreScrollPct) when native scroll is unavailable or fails.

/** Derive a best-effort source-line number from the active anchor for the
 *  native scroll engine. Returns 0 when no reliable line is derivable. */


export function cancelRMHoldChain(): void {
  if (state._rmHoldChainId !== null) {
    cancelAnimationFrame(state._rmHoldChainId);
    state._rmHoldChainId = null;
  }
}



export function getScrollAnchor(): ViewportAnchor | null {
  return getActiveAnchor();
}

// Called from readingMode.ts afterRender (RM context) → RM slot.
// When the afterRender fires while the active view is still in source mode
// (e.g. during warmup), the captured anchor actually describes the LP view.
// Seed the LP slot too so scheduleEarlyRestore can use it for the first real
// LP→RM switch. The guard (LP slot empty) prevents overwriting a real LP
// anchor set by a prior RM→LP switch.


export function cancelRMDeferredRestore(): void {
  if (state._rmDeferredRestoreId !== null) {
    cancelAnimationFrame(state._rmDeferredRestoreId);
    state._rmDeferredRestoreId = null;
  }
  rmLoopExitGuard();
}



