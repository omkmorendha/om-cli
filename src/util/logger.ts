/**
 * Structured logger for om-cli.
 *
 * Two sinks:
 *   - a JSONL file under .om/logs/<session>.jsonl (always on, full fidelity) for
 *     post-hoc debugging and development;
 *   - optional stderr output, gated by OM_LOG_LEVEL, for live dev (`bun run dev`).
 *
 * The TUI owns stdout for rendering, so human-facing log lines go to *stderr*
 * only — never stdout — to avoid corrupting the terminal UI (spec §10).
 *
 * Usage:
 *   const log = createLogger({ sessionId, dir: ".om/logs" });
 *   const toolLog = log.child("tool:read");
 *   toolLog.debug("reading file", { path });
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

export interface LogRecord {
  ts: string;
  level: Exclude<LogLevel, "silent">;
  scope: string;
  msg: string;
  data?: Record<string, unknown>;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  /** Returns a logger that prefixes its scope onto every record. */
  child(scope: string): Logger;
  /** Flush and close the file sink. */
  close(): Promise<void>;
}

export interface LoggerOptions {
  sessionId: string;
  /** Directory for the JSONL log file. Created if missing. Set null to disable file sink. */
  dir?: string | null;
  /** Console level for stderr. Defaults from OM_LOG_LEVEL env, else "silent". */
  level?: LogLevel;
  /** Console sink, injectable for tests. Defaults to process.stderr. */
  consoleSink?: (line: string) => void;
}

function envLevel(): LogLevel {
  const raw = (process.env.OM_LOG_LEVEL ?? "").toLowerCase();
  if (raw in LEVEL_ORDER) return raw as LogLevel;
  return "silent";
}

/** Redact obvious secrets from log data so API keys never hit disk (§11). */
const SECRET_KEY_RE = /(api[_-]?key|authorization|token|secret|password)/i;

/** True for a plain object/array we should recurse into (not Error, Date, etc). */
function isPlainContainer(v: unknown): v is Record<string, unknown> | unknown[] {
  if (Array.isArray(v)) return true;
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively redact secret-looking keys at any depth. A secret key blanks its
 * whole value (we never want a key/token leaking even nested under `headers`).
 * Bounded by depth and a seen-set so a deep or circular structure can't hang or
 * stack-overflow the logger.
 */
function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > 6 || !isPlainContainer(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, depth + 1, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY_RE.test(k) ? "«redacted»" : redactValue(v, depth + 1, seen);
  }
  return out;
}

function redact(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) return undefined;
  return redactValue(data, 0, new WeakSet()) as Record<string, unknown>;
}

/**
 * Internal shared sink shared by a root logger and all its children, so they
 * write to the same file handle and honor one close().
 */
class Sink {
  private fileWriter: Bun.FileSink | null = null;
  private readonly consoleLevel: number;
  private readonly consoleSink: (line: string) => void;
  private closed = false;

  constructor(opts: LoggerOptions) {
    this.consoleLevel = LEVEL_ORDER[opts.level ?? envLevel()];
    this.consoleSink = opts.consoleSink ?? ((line) => process.stderr.write(line + "\n"));

    if (opts.dir !== null) {
      const dir = opts.dir ?? ".om/logs";
      try {
        const path = `${dir}/${opts.sessionId}.jsonl`;
        // Bun.file().writer() creates parent dirs lazily on first write in 1.3.
        const file = Bun.file(path);
        this.fileWriter = file.writer();
      } catch {
        this.fileWriter = null;
      }
    }
  }

  write(rec: LogRecord): void {
    if (this.closed) return;
    if (this.fileWriter) {
      try {
        this.fileWriter.write(JSON.stringify(rec) + "\n");
        this.fileWriter.flush();
      } catch {
        // Never let logging crash the harness.
      }
    }
    if (LEVEL_ORDER[rec.level] >= this.consoleLevel) {
      const tag = rec.level.toUpperCase().padEnd(5);
      const extra = rec.data ? " " + JSON.stringify(rec.data) : "";
      this.consoleSink(`${rec.ts} ${tag} [${rec.scope}] ${rec.msg}${extra}`);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.fileWriter) {
      try {
        await this.fileWriter.end();
      } catch {
        /* ignore */
      }
    }
  }
}

class ScopedLogger implements Logger {
  constructor(private readonly sink: Sink, private readonly scope: string) {}

  private emit(level: Exclude<LogLevel, "silent">, msg: string, data?: Record<string, unknown>): void {
    this.sink.write({
      ts: new Date().toISOString(),
      level,
      scope: this.scope,
      msg,
      ...(data ? { data: redact(data)! } : {}),
    });
  }

  debug(msg: string, data?: Record<string, unknown>): void { this.emit("debug", msg, data); }
  info(msg: string, data?: Record<string, unknown>): void { this.emit("info", msg, data); }
  warn(msg: string, data?: Record<string, unknown>): void { this.emit("warn", msg, data); }
  error(msg: string, data?: Record<string, unknown>): void { this.emit("error", msg, data); }

  child(scope: string): Logger {
    return new ScopedLogger(this.sink, `${this.scope}:${scope}`);
  }

  close(): Promise<void> {
    return this.sink.close();
  }
}

export function createLogger(opts: LoggerOptions): Logger {
  return new ScopedLogger(new Sink(opts), "om");
}

/** A no-op logger for tests and contexts that don't want logging. */
export function nullLogger(): Logger {
  const noop: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() { return noop; },
    async close() {},
  };
  return noop;
}
