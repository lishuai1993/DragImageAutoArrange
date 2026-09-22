// ── TEMP-DIAG: alignment-change geometry + flash provenance ────────────
// Standalone instrumentation for two open field reports:
//   (1) a Reading-Mode alignment change leaves the picture placed wrong, and
//       part of it sits outside the blue hover ring;
//   (2) an amber band still blinks through on a mode switch.
//
// Nothing here changes what the renderer does — every function only records.
// The two report-critical moments had no logging at all before this file: the
// alignment click handlers wrote DOM and stayed silent, and the flash strip
// dropped everything it did not act on without a trace.  Delete this file and
// its call sites (tagged `TEMP-DIAG` in readingMode.ts / rmFlexRow.ts /
// rmAlignStore.ts) once both reports are closed.
//
// What each record is for:
//   RM ALIGN DIAG   one element's written style next to its measured box, taken
//                   before and after an alignment write and again over the next
//                   frames.  `rect` is the *painted* box (a transform counts),
//                   `box` the layout box: for a turned member the two disagree
//                   on purpose, and that disagreement is what a picture leaving
//                   its frame looks like from here.  `overhangRing` is in the
//                   same record: how far the picture reaches past the element
//                   the hover ring is drawn on, per side.
//   RM SIZES RUN    one line per sizing pass, so a pass re-run after an
//                   alignment change can be told from the first build.
//   RM FLUSH DIAG   what a buffered alignment write actually dispatched, and
//                   from which mode.
//   RM FLASH DIAG   every element that ever carries the flash class, whether
//                   the strip claimed it, and how long after the watch began.
//   RM FLASH HEARTBEAT  proves the sweep ran, counting zero as loudly as any
//                   other number: no record is not the same as no band.

import { logger } from "../logger";

const log = logger.channel("tmpdiag");

/** Element class names a mode-switch band is known to arrive under. */
const BAND_CLASS_KEYWORDS = ["is-flashing", "is-flash", "is-highlighted", "is-search-match", "is-match"];

/** How long the shadow watch below keeps recording.  Longer than the strip's
 *  own window on purpose: whether the band arrives *after* that window closes
 *  is one of the things this is here to answer. */
const SHADOW_WATCH_MS = 10_000;
const SHADOW_SWEEP_MS = 150;
const BAND_HEARTBEAT_MS = 1_000;

function stamp(): number {
  return Math.round(performance.now());
}

/** The probes are for a diagnosing session, whose first step is raising the log
 *  level to DEBUG.  While it is not, the one-shot records cost a logger call
 *  that will be dropped anyway, and the sampling watch below is not started. */
function probesEnabled(): boolean {
  return logger.getMinLevel() === "DEBUG";
}

function cls(el: Element): string {
  return (el.className ?? "").toString().slice(0, 70);
}

/** One element: what was written to it, its layout box, its painted box. */
export function diagBox(el: Element | null): Record<string, unknown> {
  if (!el) return { absent: true };
  const html = el as HTMLElement;
  const rect = el.getBoundingClientRect();
  return {
    tag: html.tagName,
    cls: cls(el),
    rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
    box: [html.offsetWidth, html.offsetHeight],
    inline: {
      w: html.style.width || null,
      h: html.style.height || null,
      display: html.style.display || null,
      justify: html.style.justifyContent || null,
      alignItems: html.style.alignItems || null,
      textAlign: html.style.textAlign || null,
      objectPos: html.style.objectPosition || null,
      transform: html.style.transform || null,
      flex: html.style.flex || null,
      overflow: html.style.overflow || null,
      verticalAlign: html.style.verticalAlign || null,
    },
  };
}

/** How far `inner`'s painted box reaches past `container`'s, per side. */
export function diagOverhang(
  container: Element | null,
  inner: Element | null
): Record<string, number> | null {
  if (!container || !inner) return null;
  const c = container.getBoundingClientRect();
  const i = inner.getBoundingClientRect();
  return {
    left: Math.round(c.left - i.left),
    top: Math.round(c.top - i.top),
    right: Math.round(i.right - c.right),
    bottom: Math.round(i.bottom - c.bottom),
  };
}

/** A row's members in DOM order — their size *and* their place, so a member
 *  that moved rather than a picture that shifted can be told apart. */
function diagMembers(row: Element | null): Array<Record<string, unknown>> {
  if (!row) return [];
  return Array.from(row.querySelectorAll<HTMLElement>(".internal-embed")).map((e, i) => {
    const r = e.getBoundingClientRect();
    return {
      i,
      style: e.style.flex || null,
      inlineH: e.style.height || null,
      justify: e.style.justifyContent || null,
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  });
}

/**
 * One alignment-moment record: the embed, its img, its host, its row, and the
 * element the hover ring is drawn on, each written style beside measured box.
 */
export function diagAlign(reason: string, embed: HTMLElement, extra: Record<string, unknown> = {}): void {
  if (!probesEnabled()) return;
  const img = embed.querySelector<HTMLImageElement>("img");
  const ring = embed.closest<HTMLElement>(".diaa-draggable");
  const row = embed.closest<HTMLElement>(".diaa-row");
  log.debug("RM ALIGN DIAG", {
    reason,
    t: stamp(),
    ...extra,
    attr: {
      alignment: embed.getAttribute("data-diaa-alignment"),
      orientation: embed.getAttribute("data-diaa-orientation"),
      grow: embed.getAttribute("data-diaa-flexgrow"),
      scale: embed.getAttribute("data-diaa-scale"),
      line: embed.getAttribute("data-diaa-line"),
    },
    natural: img ? `${img.naturalWidth}x${img.naturalHeight}` : null,
    embed: diagBox(embed),
    img: diagBox(img),
    host: diagBox(embed.parentElement),
    ring: diagBox(ring),
    row: diagBox(row),
    overhangRing: diagOverhang(ring, img),
    overhangEmbed: diagOverhang(embed, img),
    members: diagMembers(row),
  });
}

/** The same record over the frames after the write: placement can settle on a
 *  later frame (a sizing pass, a ResizeObserver, Obsidian's own reflow), and
 *  the moment it changes is the moment worth having. */
export function diagAlignFrames(reason: string, embed: HTMLElement, extra: Record<string, unknown> = {}): void {
  if (!probesEnabled()) return;
  let n = 0;
  const step = (): void => {
    n++;
    if (n > 5 || !embed.isConnected) return;
    diagAlign(`${reason}:layout${n}`, embed, extra);
    window.requestAnimationFrame(step);
  };
  window.requestAnimationFrame(step);
}

let _sizesRuns = 0;

/** One line per sizing pass.  A pass re-run after an alignment change (frame
 *  counter 2+) with the same member set is what a post-edit re-layout is. */
export function diagSizesRun(embeds: HTMLElement[], imgs: HTMLImageElement[]): void {
  if (!probesEnabled()) return;
  log.debug("RM SIZES RUN", {
    run: ++_sizesRuns,
    t: stamp(),
    embeds: embeds.length,
    imgs: imgs.length,
    rows: embeds.map((e) => ({
      fn: e.getAttribute("src") ?? "",
      connected: e.isConnected,
      w: Math.round(e.getBoundingClientRect().width),
      grow: e.style.flex || null,
      h: e.style.height || null,
    })),
  });
}

/** What a buffered alignment write put into the document. */
export function diagFlush(
  sourcePath: string,
  edits: Array<{ line: number; before: string; after: string }>,
  dispatched: boolean,
  mode: string,
  bufferedLeft: number
): void {
  if (!probesEnabled()) return;
  log.debug("RM FLUSH DIAG", {
    t: stamp(),
    sourcePath,
    mode,
    dispatched,
    edits,
    bufferedLeft,
  });
}

// ── Flash provenance ───────────────────────────────────────────────────
// The strip acts on `.is-flashing` alone and, when it does not act, says
// nothing — so a band the user still sees has three possible explanations that
// look identical in the log: the element never had that class, it had it but
// outside the strip's window, or it had it and no predicate matched.  The
// shadow watch below records all three, and keeps recording past the strip's
// own window.

const _bandSeen = new WeakMap<HTMLElement, number>();
let _shadowObserver: MutationObserver | null = null;
let _shadowTimers: number[] = [];
let _shadowStart = 0;

/** Whether the strip's own window (3.5 s from the same moment) is still open. */
function withinStripWindow(): boolean {
  return stamp() - _shadowStart <= 3500;
}

export function diagFlashWatchStart(highlightVar: string): void {
  _shadowStart = stamp();
  const on = probesEnabled();
  log.debug("RM FLASH WATCH", {
    t: _shadowStart,
    highlightVar: highlightVar.trim() || "(unset)",
    shadowWatchMs: SHADOW_WATCH_MS,
    sampling: on,
  });

  if (!on || _shadowObserver) return;
  _shadowObserver = new MutationObserver((records) => {
    for (const r of records) {
      const target = r.target as HTMLElement | null;
      if (!target || typeof target.className !== "string") continue;
      const hit = BAND_CLASS_KEYWORDS.some((k) => target.classList.contains(k));
      if (hit) diagFlashSeen(target, "class-gained");
    }
  });
  _shadowObserver.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["class"],
  });

  _shadowTimers.push(
    window.setInterval(() => {
      diagBandSweep();
    }, SHADOW_SWEEP_MS)
  );
  _shadowTimers.push(
    window.setInterval(() => {
      if (!probesEnabled()) return;
      log.debug("RM FLASH HEARTBEAT", {
        t: stamp(),
        watchAgeMs: stamp() - _shadowStart,
        flashingNow: document.querySelectorAll(".is-flashing").length,
        bandNow: elementsPaintedWithHighlight().length,
      });
    }, BAND_HEARTBEAT_MS)
  );
  _shadowTimers.push(
    window.setTimeout(() => {
      for (const id of _shadowTimers) {
        window.clearInterval(id);
        window.clearTimeout(id);
      }
      _shadowTimers = [];
      _shadowObserver?.disconnect();
      _shadowObserver = null;
      log.debug("RM FLASH WATCH end", { t: stamp(), watchMs: SHADOW_WATCH_MS });
    }, SHADOW_WATCH_MS)
  );
}

/** Every element currently flashing, plus whatever is painted with the theme's
 *  highlight colour.  Called from the shadow sweep; records nothing when the
 *  document is clean, so silence in the log is a positive result. */
function diagBandSweep(): void {
  if (!probesEnabled()) return;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(".is-flashing"))) {
    diagFlashSeen(el, "sweep-flashing");
  }
  for (const el of elementsPaintedWithHighlight()) {
    diagFlashSeen(el, "sweep-highlight-bg");
  }
}

/** Elements painted with the highlight background — the band's colour, however
 *  it got there.  Bounded on purpose: only what our rows and their blocks could
 *  be showing through. */
function elementsPaintedWithHighlight(): HTMLElement[] {
  const want = getComputedStyle(document.documentElement)
    .getPropertyValue("--text-highlight-bg")
    .trim();
  if (!want) return [];
  const out: HTMLElement[] = [];
  const seeds = document.querySelectorAll<HTMLElement>(".diaa-row, .diaa-row-inline");
  const seen = new Set<HTMLElement>();
  for (const seed of Array.from(seeds)) {
    let cur: HTMLElement | null = seed;
    for (let d = 0; cur && d < 6; d++) {
      if (seen.has(cur)) break;
      seen.add(cur);
      if (getComputedStyle(cur).backgroundColor === want) out.push(cur);
      cur = cur.parentElement;
    }
  }
  return out;
}

/** One flash sighting: what carries the paint, whether it is ours, and how
 *  this sighting relates to the strip's window.  A repeat sighting of the same
 *  element is a relapse — the strip cleared it and it came back. */
export function diagFlashSeen(el: HTMLElement, how: string): void {
  if (!probesEnabled()) return;
  const n = (_bandSeen.get(el) ?? 0) + 1;
  _bandSeen.set(el, n);
  const cs = getComputedStyle(el);
  const chain: string[] = [];
  let cur: HTMLElement | null = el.parentElement;
  for (let d = 0; cur && d < 6; d++) {
    chain.push(`${cur.tagName}.${cls(cur)}`);
    cur = cur.parentElement;
  }
  log.debug("RM FLASH DIAG", {
    how,
    t: stamp(),
    watchAgeMs: stamp() - _shadowStart,
    stripWindowOpen: withinStripWindow(),
    sighting: n,
    tag: el.tagName,
    cls: cls(el),
    bg: cs.backgroundColor,
    flashing: el.classList.contains("is-flashing"),
    holdsDiaa: el.querySelector("[data-diaa-group], [data-diaa-standalone], .diaa-row-inline") !== null,
    diaaSelf: el.matches("[data-diaa-group], [data-diaa-standalone], .diaa-row-inline"),
    // The strip's second limb: an image embed exists here even though no marker
    // of ours does yet — the case a flash that arrives before the render needs.
    holdsEmbed: el.matches(".image-embed") || el.querySelector(".image-embed") !== null,
    ancestors: chain,
  });
}
