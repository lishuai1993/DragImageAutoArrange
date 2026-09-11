import { App, WorkspaceLeaf } from "obsidian";
import { logger } from "../logger";
const log = logger.channel("warmupScheduler");
import { ENABLE_WARMUP_PROBE, cancelWarmupProbe } from "./warmupProbe";
import { applySnapshotLineDelta } from "./scrollAnchor";
import { viewInternals } from "../obsidianInternals";

// ── Constants ──────────────────────────────────────────────────────────

const COARSE_IDLE_MS = 1_000;        // 1s idle → line-delta patch on snapshot
const FINE_IDLE_MS = 5_000;          // 5s idle → full re-warmup
const USER_ACTIVE_WINDOW_MS = 500;   // considered "active" if interacted within this window
const USER_BUSY_BACKOFF_MS = 2000;   // wait 2s before retrying when user is busy
const P0_DELAY_MS = 500;             // P0: wait for LP editor to stabilise

// ── Types ──────────────────────────────────────────────────────────────

interface WarmupTask {
  file: string;
  leaf: WorkspaceLeaf;
  priority: 0 | 1 | 2;
  tabIndex: number;
  freqCount: number;
}

// ── Inject the warmup runner (avoids circular import) ──────────────────

type WarmupRunner = (
  app: App, targetLeaf: WorkspaceLeaf,
  signal?: { aborted: boolean },
) => Promise<void>;

let _runner: WarmupRunner | null = null;

export function registerWarmupRunner(runner: WarmupRunner): void {
  _runner = runner;
}

// ── State ──────────────────────────────────────────────────────────────

let _rmFrequency = new Map<string, number>();
let _warmedFiles = new Set<string>();
let _queue: WarmupTask[] = [];
let _p0RetryQueue: string[] = [];
let _activeAbort: { aborted: boolean } | null = null;
let _schedulerTimer: number | null = null;
let _coarseTimers = new Map<string, number>();
let _fineTimers = new Map<string, number>();
let _lastUserActivity = 0;
let _running = false;

// ── User-activity tracking ─────────────────────────────────────────────

function onUserActivity(): void {
  _lastUserActivity = performance.now();
}

function isUserActive(): boolean {
  return performance.now() - _lastUserActivity < USER_ACTIVE_WINDOW_MS;
}

/** Install document-level activity listeners. Returns a cleanup function. */
export function installUserActivityListener(): () => void {
  const opts = { passive: true, capture: true } as const;
  document.addEventListener("keydown", onUserActivity, opts);
  document.addEventListener("mousedown", onUserActivity, opts);
  document.addEventListener("wheel", onUserActivity, opts);
  log.info("WARMUP scheduler activity listener installed");
  return () => {
    document.removeEventListener("keydown", onUserActivity, opts);
    document.removeEventListener("mousedown", onUserActivity, opts);
    document.removeEventListener("wheel", onUserActivity, opts);
  };
}

// ── Leaf helpers ───────────────────────────────────────────────────────

function findLeafForFile(app: App, file: string): WorkspaceLeaf | null {
  let found: WorkspaceLeaf | null = null;
  app.workspace.iterateAllLeaves((leaf) => {
    if (!found && viewInternals(leaf.view)?.file?.path === file) found = leaf;
  });
  return found;
}

function isFileOpen(app: App, file: string): boolean {
  return findLeafForFile(app, file) !== null;
}

// ── Priority queue ─────────────────────────────────────────────────────

function compareTask(a: WarmupTask, b: WarmupTask): number {
  if (a.priority !== b.priority) return a.priority - b.priority;           // P0 < P1 < P2
  if (a.freqCount !== b.freqCount) return b.freqCount - a.freqCount;        // P1: higher freq first
  return a.tabIndex - b.tabIndex;                                           // P2: left → right
}

function collectAllLeaves(app: App): { leaf: WorkspaceLeaf; file: string; idx: number }[] {
  const result: { leaf: WorkspaceLeaf; file: string; idx: number }[] = [];
  let idx = 0;
  app.workspace.iterateAllLeaves((leaf) => {
    const file = viewInternals(leaf.view)?.file?.path;
    if (file && file.endsWith(".md")) {
      result.push({ leaf, file, idx: idx++ });
    }
  });
  return result;
}

function buildQueue(app: App): void {
  const activeFile = app.workspace.getActiveFile()?.path ?? "";
  const leaves = collectAllLeaves(app);

  const tasks: WarmupTask[] = [];
  for (const { leaf, file, idx } of leaves) {
    if (file === activeFile) continue;          // P0 handles the active tab
    if (_warmedFiles.has(file)) continue;       // already warmed this session

    const freqCount = _rmFrequency.get(file) ?? 0;
    const priority: 0 | 1 | 2 = freqCount > 0 ? 1 : 2;
    tasks.push({ file, leaf, priority, tabIndex: idx, freqCount });
  }

  tasks.sort(compareTask);
  _queue = tasks;
  log.info("WARMUP queue built", { total: tasks.length, p1: tasks.filter(t => t.priority === 1).length });
}

// ── Scheduler core ─────────────────────────────────────────────────────

/** Run a single warmup task for a given leaf. Uses the injected runner. */
async function executeTask(
  app: App, task: WarmupTask, signal: { aborted: boolean },
): Promise<void> {
  try {
    await _runner?.(app, task.leaf, signal);
  } catch (e) {
    log.warn("WARMUP task threw", { file: task.file, error: String(e) });
  }
  if (!signal.aborted) {
    _warmedFiles.add(task.file);
  }
}

/** Run P0 warmup for the active file. Preempts any running background task. */
async function runP0Warmup(app: App, file: string): Promise<void> {
  // Cancel legacy warmupProbe (clears global _active lock) so runWarmup can start.
  cancelWarmupProbe();

  // Preempt running P1/P2 task
  if (_activeAbort && _queue.length > 0 && _queue[0]?.priority >= 1) {
    _activeAbort.aborted = true;
    _activeAbort = null;
    if (_schedulerTimer) { window.clearTimeout(_schedulerTimer); _schedulerTimer = null; }
    log.debug("WARMUP background task preempted for P0", { file });
  }

  // Remove just-warmed flag so idle re-warmups aren't blocked
  _warmedFiles.delete(file);

  await new Promise(r => window.setTimeout(r, P0_DELAY_MS));

  // Guard: file still open and active
  const activeFile = app.workspace.getActiveFile()?.path ?? "";
  if (activeFile !== file) return;

  const leaf = findLeafForFile(app, file);
  if (!leaf) return;

  const signal = { aborted: false };
  const prevAbort = _activeAbort;
  _activeAbort = signal;

  try {
    await executeTask(app, { file, leaf, priority: 0, tabIndex: -1, freqCount: 0 }, signal);
  } finally {
    // Restore previous abort if it hasn't been replaced
    if (_activeAbort === signal) _activeAbort = prevAbort;
  }
}

/** Process the queue one task at a time, yielding between tasks. */
async function processNext(app: App): Promise<void> {
  if (_running || !ENABLE_WARMUP_PROBE) return;
  _running = true;

  while (_queue.length > 0 || _p0RetryQueue.length > 0) {
    // ── Drain P0 retry queue first (preempted P0s that were blocked). ──
    while (_p0RetryQueue.length > 0) {
      const retryFile = _p0RetryQueue.shift()!;
      const activeFile = app.workspace.getActiveFile()?.path ?? "";
      if (retryFile === activeFile && isFileOpen(app, retryFile)) {
        log.info("WARMUP P0 retry", { file: retryFile });
        _running = false;
        void runP0Warmup(app, retryFile);
        return; // runP0Warmup is async; the scheduler will resume naturally
      }
    }

    // ── Defer if user is actively interacting ──
    if (isUserActive()) {
      _schedulerTimer = window.setTimeout(() => {
        _schedulerTimer = null;
        _running = false;
        void processNext(app);
      }, USER_BUSY_BACKOFF_MS);
      _running = false;
      return;
    }

    const task = _queue.shift()!;

    // Stale check: file may have been warmed or closed while queued
    if (_warmedFiles.has(task.file)) continue;
    const activeFile = app.workspace.getActiveFile()?.path ?? "";
    if (task.file === activeFile) continue;
    if (!isFileOpen(app, task.file)) continue;

    const signal = { aborted: false };
    _activeAbort = signal;

    log.debug("WARMUP scheduler executing", {
      file: task.file, priority: task.priority, remaining: _queue.length,
    });

    await executeTask(app, task, signal);

    if (_activeAbort === signal) _activeAbort = null;
    if (signal.aborted) {
      log.debug("WARMUP task aborted", { file: task.file });
    }

    // ── Yield to event loop before next task ──
    if (_queue.length > 0) {
      await new Promise<void>(r => { _schedulerTimer = window.setTimeout(r, 0); });
      _schedulerTimer = null;
    }
  }

  _running = false;
  log.info("WARMUP queue drained");
}

// ── Public API ─────────────────────────────────────────────────────────

/** Record that a file was switched to RM. Feeds P1 priority ranking. */
export function recordRMSwitch(file: string): void {
  if (!file) return;
  _rmFrequency.set(file, (_rmFrequency.get(file) ?? 0) + 1);
}

/** Two-tier idle warmup after an edit:
 *  1s idle → coarse: line-delta patch on snapshot (no rendering)
 *  5s idle → fine: full re-warmup via runP0Warmup */
export function scheduleIdleWarmup(
  app: App, file: string, lineCount: number, editLine: number,
): void {
  if (!ENABLE_WARMUP_PROBE || !file) return;

  // ── 1s coarse timer: line-number delta on existing snapshot ──
  const oldCoarse = _coarseTimers.get(file);
  if (oldCoarse) window.clearTimeout(oldCoarse);
  _coarseTimers.set(file, window.setTimeout(() => {
    _coarseTimers.delete(file);
    const activeFile = app.workspace.getActiveFile()?.path ?? "";
    if (activeFile !== file) return;
    log.debug("WARMUP coarse delta", { file, lineCount, editLine });
    applySnapshotLineDelta(file, lineCount, editLine);
  }, COARSE_IDLE_MS));

  // ── 5s fine timer: full re-warmup ──
  const oldFine = _fineTimers.get(file);
  if (oldFine) window.clearTimeout(oldFine);
  _fineTimers.set(file, window.setTimeout(() => {
    _fineTimers.delete(file);
    const c = _coarseTimers.get(file);
    if (c) { window.clearTimeout(c); _coarseTimers.delete(file); }
    const activeFile = app.workspace.getActiveFile()?.path ?? "";
    if (activeFile !== file) return;
    log.info("WARMUP idle trigger", { file });
    void runP0Warmup(app, file);
  }, FINE_IDLE_MS));
}

/** Request P0 (immediate) warmup for the given file.
 *  Called on file-open and for the active tab on layout-ready. */
export function requestP0Warmup(app: App, file: string): void {
  if (!ENABLE_WARMUP_PROBE || !file) return;
  log.debug("WARMUP P0 requested", { file });
  void runP0Warmup(app, file);
}

/** Build the background queue (P1/P2) and start processing.
 *  Called on layout-ready after the active tab's P0 is scheduled. */
export function requestGlobalWarmup(app: App): void {
  if (!ENABLE_WARMUP_PROBE) return;
  buildQueue(app);
  if (_queue.length > 0) void processNext(app);
}

/** Clear all scheduler state. Called on plugin unload. */
export function cancelAllWarmups(): void {
  if (_activeAbort) _activeAbort.aborted = true;
  _activeAbort = null;
  if (_schedulerTimer) { window.clearTimeout(_schedulerTimer); _schedulerTimer = null; }
  for (const t of _coarseTimers.values()) window.clearTimeout(t);
  _coarseTimers.clear();
  for (const t of _fineTimers.values()) window.clearTimeout(t);
  _fineTimers.clear();
  _queue = [];
  _p0RetryQueue = [];
  _running = false;
  log.info("WARMUP all tasks cancelled");
}
