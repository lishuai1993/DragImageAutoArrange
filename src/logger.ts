import { DataAdapter } from "obsidian";

export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

/** Severity order — a higher rank is more severe. The level gate lets a
 *  message through when its rank is >= the configured minimum. */
const LEVEL_RANK: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  channel: string;
  message: string;
  data?: unknown;
}

// ── LogChannel ──────────────────────────────────────────────────────────

class LogChannel {
  readonly name: string;
  readonly parent: LogChannel | null;
  readonly children = new Map<string, LogChannel>();

  private _outputToFile: boolean | null = null;
  private _outputToConsole: boolean | null = null;

  constructor(name: string, parent: LogChannel | null) {
    this.name = name;
    this.parent = parent;
    if (parent) parent.children.set(name.split(".").pop()!, this);
  }

  // ── outputToFile ──

  get outputToFile(): boolean {
    if (this._outputToFile !== null) return this._outputToFile;
    if (this.parent) return this.parent.outputToFile;
    return true; // root default
  }

  set outputToFile(v: boolean) { this._outputToFile = v; }

  resetOutputToFile(): void { this._outputToFile = null; }

  // ── outputToConsole ──

  get outputToConsole(): boolean {
    if (this._outputToConsole !== null) return this._outputToConsole;
    if (this.parent) return this.parent.outputToConsole;
    return true;
  }

  set outputToConsole(v: boolean) { this._outputToConsole = v; }

  resetOutputToConsole(): void { this._outputToConsole = null; }

  // ── Log methods ──

  info(message: string, data?: unknown): void {
    logger._write(this, "INFO", message, data);
  }
  debug(message: string, data?: unknown): void {
    logger._write(this, "DEBUG", message, data);
  }
  warn(message: string, data?: unknown): void {
    logger._write(this, "WARN", message, data);
  }
  error(message: string, data?: unknown): void {
    logger._write(this, "ERROR", message, data);
  }
}

// ── Logger singleton ────────────────────────────────────────────────────

const MAX_CHANNEL_DEPTH = 3;

class Logger {
  private _channels = new Map<string, LogChannel>();
  private _adapter: DataAdapter | null = null;
  private _logPath = "";
  private _buffer: LogEntry[] = [];
  private _flushTimer: ReturnType<typeof setInterval> | null = null;
  private _flushing = false;
  private _fileOutputFilter: string[] | null = null;
  /** Minimum severity emitted to either sink. Default DEBUG = emit everything,
   *  i.e. identical to the pre-gate behavior. */
  private _minLevel: LogLevel = "DEBUG";
  /** Master switch for the log.txt sink (settings-driven). */
  private _fileEnabled = true;

  // ── Lifecycle ──

  async init(adapter: DataAdapter, logPath: string): Promise<void> {
    this._adapter = adapter;
    this._logPath = logPath;
    try { await adapter.write(logPath, ""); } catch { /* ignore */ }
    this._flushTimer = setInterval(() => this.flush(), 5000);
  }

  async dispose(): Promise<void> {
    if (this._flushTimer) clearInterval(this._flushTimer);
    await this.flush();
    if (this._adapter) {
      try { await this._adapter.write(this._logPath, ""); } catch { /* ignore */ }
    }
    this._adapter = null;
  }

  // ── Channel management ──

  channel(name: string): LogChannel {
    const cached = this._channels.get(name);
    if (cached) return cached;

    const segments = name.split(".");
    if (segments.length > MAX_CHANNEL_DEPTH) {
      throw new Error(`[DragImg] Channel depth exceeds ${MAX_CHANNEL_DEPTH}: "${name}"`);
    }

    // Build ancestor chain
    let parent: LogChannel | null = null;
    let prefix = "";
    for (const seg of segments) {
      prefix = prefix ? `${prefix}.${seg}` : seg;
      let ch = this._channels.get(prefix);
      if (!ch) {
        ch = new LogChannel(prefix, parent);
        this._channels.set(prefix, ch);
      }
      parent = ch;
    }

    return this._channels.get(name)!;
  }

  listChannels(): { name: string; outputToFile: boolean; outputToConsole: boolean }[] {
    return [...this._channels.values()].map((ch) => ({
      name: ch.name,
      outputToFile: ch.outputToFile,
      outputToConsole: ch.outputToConsole,
    }));
  }

  // ── Batch control ──

  setAllFileOutput(v: boolean): void {
    for (const ch of this._channels.values()) ch.outputToFile = v;
  }

  setAllConsoleOutput(v: boolean): void {
    for (const ch of this._channels.values()) ch.outputToConsole = v;
  }

  // ── File output filter ──

  setFileOutputFilter(names: string[]): void {
    this._fileOutputFilter = [...names];
  }

  clearFileOutputFilter(): void {
    this._fileOutputFilter = null;
  }

  // ── Level gate + file sink switch (settings-driven) ──

  /** Drop any entry below `level` from both sinks. */
  setMinLevel(level: LogLevel): void {
    this._minLevel = level;
  }

  getMinLevel(): LogLevel {
    return this._minLevel;
  }

  /** Enable/disable the log.txt sink entirely. */
  setFileEnabled(enabled: boolean): void {
    this._fileEnabled = enabled;
    // Drop anything buffered while the sink is off so it can't linger.
    if (!enabled) this._buffer = [];
  }

  isFileEnabled(): boolean {
    return this._fileEnabled;
  }

  /** Truncate log.txt so the next session starts from a clean file. */
  async clearLogFile(): Promise<void> {
    if (!this._adapter) return;
    try { await this._adapter.write(this._logPath, ""); } catch { /* ignore */ }
  }

  // ── Backward-compatible direct log methods (use "default" channel) ──

  info(message: string, data?: unknown): void {
    this._write(this.channel("default"), "INFO", message, data);
  }
  debug(message: string, data?: unknown): void {
    this._write(this.channel("default"), "DEBUG", message, data);
  }
  warn(message: string, data?: unknown): void {
    this._write(this.channel("default"), "WARN", message, data);
  }
  error(message: string, data?: unknown): void {
    this._write(this.channel("default"), "ERROR", message, data);
  }

  // ── Internal ──

  _write(channel: LogChannel, level: LogLevel, message: string, data?: unknown): void {
    const rank = LEVEL_RANK[level];
    const toFile = this._fileEnabled && rank >= LEVEL_RANK[this._minLevel];
    const toConsole = channel.outputToConsole && rank >= LEVEL_RANK[this._minLevel];
    if (!toFile && !toConsole) return;

    if (toFile) {
      this._buffer.push({
        timestamp: new Date().toISOString(),
        level,
        channel: channel.name,
        message,
        data,
      });
    }
    if (toConsole) {
      const dataStr = data !== undefined ? ` ${JSON.stringify(data)}` : "";
      console.log(`[DragImg] [${level}] ${message}${dataStr}`);
    }
  }

  async flush(): Promise<void> {
    if (!this._adapter || !this._fileEnabled || this._buffer.length === 0 || this._flushing) return;
    this._flushing = true;
    try {
      const allowed = this._buffer.filter((entry) => {
        if (this._fileOutputFilter && !this._matchFilter(entry.channel)) return false;
        const ch = this._channels.get(entry.channel);
        if (ch && !ch.outputToFile) return false;
        return true;
      });
      this._buffer = [];
      if (allowed.length === 0) return;
      const lines = allowed.map(
        (e) => `[${e.timestamp}] [${e.level}] ${e.message}` +
          (e.data !== undefined ? ` ${JSON.stringify(e.data)}` : "")
      );
      const newContent = lines.join("\n") + "\n";
      let existing = "";
      try { existing = await this._adapter!.read(this._logPath); } catch { /* ignore */ }
      await this._adapter!.write(this._logPath, existing + newContent);
    } catch (e) {
      console.error("[DragImg] Failed to flush log:", e);
    } finally {
      this._flushing = false;
    }
  }

  private _matchFilter(channelName: string): boolean {
    if (!this._fileOutputFilter) return true;
    const filter = this._fileOutputFilter;
    let name = channelName;
    while (name) {
      if (filter.includes(name)) return true;
      const dot = name.lastIndexOf(".");
      if (dot < 0) break;
      name = name.slice(0, dot);
    }
    return false;
  }
}

export const logger = new Logger();
