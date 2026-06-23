import { DataAdapter } from "obsidian";

type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: unknown;
}

class Logger {
  private buffer: LogEntry[] = [];
  private adapter: DataAdapter | null = null;
  private logPath = "";
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  /** Call once during plugin load to enable file logging. Clears previous log. */
  init(adapter: DataAdapter, logPath: string): void {
    this.adapter = adapter;
    this.logPath = logPath;
    // Clear previous session's log
    adapter.write(logPath, "").catch(() => {});
    console.log(`[DragImg] Logger initialized, logPath=${logPath}`);
    this.flushTimer = setInterval(() => this.flush(), 5000);
  }

  /** Call on plugin unload to flush remaining entries, then clear log. */
  async dispose(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
    // Clear log on exit
    if (this.adapter) {
      try { await this.adapter.write(this.logPath, ""); } catch { /* ignore */ }
    }
    this.adapter = null;
  }

  info(message: string, data?: unknown): void {
    this.write("INFO", message, data);
  }
  warn(message: string, data?: unknown): void {
    this.write("WARN", message, data);
  }
  error(message: string, data?: unknown): void {
    this.write("ERROR", message, data);
  }
  debug(message: string, data?: unknown): void {
    this.write("DEBUG", message, data);
  }

  private write(level: LogLevel, message: string, data?: unknown): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data,
    };
    this.buffer.push(entry);
    const dataStr = data !== undefined ? ` ${JSON.stringify(data)}` : "";
    console.log(`[DragImg] [${level}] ${message}${dataStr}`);
  }

  async flush(): Promise<void> {
    if (!this.adapter || this.buffer.length === 0 || this.flushing) return;
    this.flushing = true;
    try {
      const lines = this.buffer.map(
        (e) => `[${e.timestamp}] [${e.level}] ${e.message}` +
          (e.data !== undefined ? ` ${JSON.stringify(e.data)}` : "")
      );
      this.buffer = [];
      const newContent = lines.join("\n") + "\n";
      let existing = "";
      try {
        existing = await this.adapter.read(this.logPath);
      } catch {
        // File doesn't exist yet — that's fine
      }
      await this.adapter.write(this.logPath, existing + newContent);
    } catch (e) {
      console.error("[DragImg] Failed to flush log:", e);
    } finally {
      this.flushing = false;
    }
  }
}

/** Singleton logger instance */
export const logger = new Logger();
