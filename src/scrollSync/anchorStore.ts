import { buildImageLineRe } from "../constants";
import { ImageRowIndex } from "./viewportAnchor";

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

// ── Misc state ──────────────────────────────────────────────────────

// File whose RM has completed initial post-processor render.
let _rmRenderedFile = "";

export function getRMRenderedFile(): string {
  return _rmRenderedFile;
}

export function setRMRenderedFile(path: string): void {
  _rmRenderedFile = path;
}

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
