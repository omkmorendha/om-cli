/**
 * The shared Frontend interface and cross-frontend helpers (spec tui.html §09).
 *
 * Both the headless `StdoutFrontend` (tui.html §10) and the eventual OpenTUI
 * `TuiFrontend` implement this one interface so `main.ts` can pick a frontend at
 * boot without the core knowing which is live. The core depends only on this
 * interface and the canonical `AgentEvent` stream — never on OpenTUI.
 *
 * Direction of data (spec §01):
 *   - Core → frontend: a read-only `AsyncIterable<AgentEvent>` (render only).
 *   - Frontend → core: exactly two callbacks — `onSubmit(text, signal)` and
 *     `onApproval(id, decision)`. No third channel, no shared mutable state.
 *
 * NOTE ON THE APPROVAL SEAM (binding code vs. idealized spec):
 *   The committed `PermissionGate` (permission/gate.ts) is UI-agnostic: it is
 *   constructed with a `requestApproval(req) => Promise<ApprovalResponse>`
 *   callback and has NO `gate.resolve(...)` method. `main.ts` owns a
 *   `Map<string, (r: ApprovalResponse) => void>` of pending resolvers. When the
 *   gate calls `requestApproval`, main.ts surfaces an `approval.request`
 *   AgentEvent through the active render stream and parks the resolver in that
 *   map. The frontend renders the prompt, collects a choice, and calls
 *   `frontend.onApproval(id, decision)`; main.ts maps that `Decision` back to an
 *   `ApprovalResponse` via `decisionToResponse` and resolves the parked promise.
 *   This module exports both directions of that mapping so main.ts and every
 *   frontend share one translation.
 */

import type {
  AgentEvent,
  ApprovalResponse,
  Decision,
  ToolResult,
} from "../core/types.ts";

/**
 * The contract every frontend implements. Kept deliberately tiny so v0 can run
 * headless (M1–M4) and swap in the OpenTUI frontend (M5) without touching the
 * core or providers (spec §09).
 */
export interface Frontend {
  /** Prepare the frontend (TUI: await createCliRenderer; stdout: ~no-op). */
  mount(): Promise<void>;

  /** Render one turn's worth of core events to completion. */
  render(events: AsyncIterable<AgentEvent>): Promise<void>;

  /**
   * Core → frontend callback registered by main.ts. The frontend invokes it
   * when the user submits a line, handing over the text plus the `AbortSignal`
   * that scopes the resulting turn (Ctrl-C unwind, spec §08).
   */
  onSubmit?: (text: string, signal: AbortSignal) => void;

  /**
   * Core → frontend callback registered by main.ts. The frontend invokes it
   * with the user's decision for a pending `approval.request` id. A deny still
   * flows back so the core can synthesize a tool result (loop invariant §05).
   */
  onApproval?: (id: string, decision: Decision) => void;

  /** Tear down (TUI: restore terminal; stdout: flush). */
  dispose(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Approval mapping — shared by every frontend and by main.ts (spec §07)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map a user's `ApprovalResponse` ("once" | "session" | "deny") to the
 * canonical `Decision` shape the core consumes (types.ts §8).
 *
 *   once    → { allowed: true }
 *   session → { allowed: true, remember: "session" }
 *   deny    → { allowed: false, reason: "denied by user" }
 */
export function toDecision(resp: ApprovalResponse): Decision {
  switch (resp) {
    case "once":
      return { allowed: true };
    case "session":
      return { allowed: true, remember: "session" };
    case "deny":
      return { allowed: false, reason: "denied by user" };
  }
}

/**
 * Inverse of {@link toDecision}: collapse a `Decision` back to the
 * `ApprovalResponse` the gate's `requestApproval` promise expects.
 *
 * main.ts uses this when `frontend.onApproval(id, decision)` fires: it resolves
 * the parked `requestApproval` promise with `decisionToResponse(decision)` so
 * the gate sees the same "once" | "session" | "deny" vocabulary it asked with.
 */
export function decisionToResponse(decision: Decision): ApprovalResponse {
  if (!decision.allowed) return "deny";
  return decision.remember === "session" ? "session" : "once";
}

// ─────────────────────────────────────────────────────────────────────────────
// Display helpers — shared by the stdout and (future) TUI frontends
// ─────────────────────────────────────────────────────────────────────────────

/** Default cap for a single rendered display line (chars, not bytes). */
export const DISPLAY_LINE_LIMIT = 2000;

/**
 * Collapse a possibly-large / multi-line string to a compact, single-line form
 * suitable for an inline status line. Newlines become spaces so a noisy tool
 * result cannot smear across the scrollback, and the whole thing is hard-capped
 * with an ellipsis. This is a *display* truncation, distinct from the model
 * facing byte-cap in tools/truncate.ts.
 */
export function truncateForDisplay(s: string, limit: number = DISPLAY_LINE_LIMIT): string {
  const oneLine = s.replace(/\s*\n+\s*/g, " ").trim();
  if (oneLine.length <= limit) return oneLine;
  return oneLine.slice(0, Math.max(0, limit - 1)) + "…";
}

/**
 * Render a `tool.result` as a single status line shared by frontends:
 *
 *   "[result] ok: <short content>"        when output.ok
 *   "[result] ERR: <short error|content>" otherwise
 *
 * On failure the explicit `error` is preferred over `content` when present,
 * since `content` may just echo the error anyway (types.ts ToolResult.error).
 */
export function renderToolResultLine(
  output: ToolResult,
  limit: number = DISPLAY_LINE_LIMIT,
): string {
  if (output.ok) {
    return `[result] ok: ${truncateForDisplay(output.content, limit)}`;
  }
  const detail = output.error ?? output.content;
  return `[result] ERR: ${truncateForDisplay(detail, limit)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rich tool-card helpers (pure, framework-free, unit-tested)
//
// These shape a tool call's raw `input` / `ToolResult` into compact, human
// strings for the TUI's tool cards. They live here (not in tui.ts) precisely so
// they can be tested without a TTY: tui.ts only wraps their output in OpenTUI
// renderables. None of them import OpenTUI.
// ─────────────────────────────────────────────────────────────────────────────

/** Narrow an unknown tool input to a record so we can read string fields off it. */
function asRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

/** Read a string field from an unknown input, or "" if absent / non-string. */
function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  return typeof v === "string" ? v : "";
}

/** Read a finite number field from an unknown input, or undefined. */
function num(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Collapse an absolute path to something legible in a narrow card: strip a
 * leading `cwd/` so in-project paths show relative, and elide the middle of very
 * long paths to `a/b/…/y/z`. Cosmetic only — never used to resolve a path.
 */
export function shortenPath(path: string, cwd?: string, max = 48): string {
  let p = path;
  if (cwd && cwd.length > 0) {
    const prefix = cwd.endsWith("/") ? cwd : cwd + "/";
    if (p.startsWith(prefix)) p = p.slice(prefix.length);
    else if (p === cwd) p = ".";
  }
  if (p.length <= max) return p;
  const segs = p.split("/");
  if (segs.length <= 2) return "…" + p.slice(p.length - (max - 1));
  const first = segs[0] ?? "";
  const last = segs[segs.length - 1] ?? "";
  const tailIdx = segs.length - 1;
  // Grow the tail from the end until we'd exceed max, keeping the first segment.
  let tail = last;
  for (let i = tailIdx - 1; i > 0; i--) {
    const next = segs[i] + "/" + tail;
    if (first.length + 4 + next.length > max) break;
    tail = next;
  }
  return `${first}/…/${tail}`;
}

/**
 * A concise one-line summary of a tool call for the card's body, tailored per
 * tool so the user reads *intent* ("edit src/x.ts · 1 occurrence") rather than
 * raw JSON. Falls back to compact JSON for unknown tools.
 *
 *   read   → "src/parser.ts · lines 10–40"
 *   ls     → "src/"
 *   glob   → "src/**\/*.ts"
 *   grep   → "/TODO/ in src"
 *   write  → "src/new.ts · 1.2 KB"
 *   edit   → "src/parser.ts"
 *   bash   → "bun test"
 */
export function summarizeToolInput(name: string, input: unknown, cwd?: string): string {
  const r = asRecord(input);
  switch (name) {
    case "read": {
      const path = shortenPath(str(r, "path"), cwd);
      const offset = num(r, "offset");
      const limit = num(r, "limit");
      if (offset !== undefined && limit !== undefined) {
        return `${path} ${glyphDot} lines ${offset}–${offset + limit - 1}`;
      }
      if (offset !== undefined) return `${path} ${glyphDot} from line ${offset}`;
      if (limit !== undefined) return `${path} ${glyphDot} first ${limit} lines`;
      return path;
    }
    case "ls":
      return shortenPath(str(r, "path"), cwd) || ".";
    case "glob": {
      const pattern = str(r, "pattern");
      const where = str(r, "cwd");
      return where ? `${pattern} ${glyphDot} in ${shortenPath(where, cwd)}` : pattern;
    }
    case "grep": {
      const pattern = str(r, "pattern");
      const where = str(r, "path");
      const pat = `/${pattern}/`;
      return where ? `${pat} ${glyphDot} in ${shortenPath(where, cwd)}` : pat;
    }
    case "write": {
      const path = shortenPath(str(r, "path"), cwd);
      const bytes = Buffer.byteLength(str(r, "content"), "utf8");
      return `${path} ${glyphDot} ${formatBytes(bytes)}`;
    }
    case "edit":
      return shortenPath(str(r, "path"), cwd);
    case "bash": {
      const where = str(r, "cwd");
      const cmd = truncateForDisplay(str(r, "command"), 120);
      return where ? `${cmd}  (in ${shortenPath(where, cwd)})` : cmd;
    }
    default: {
      if (typeof input === "string") return truncateForDisplay(input, 120);
      try {
        return truncateForDisplay(JSON.stringify(input), 120);
      } catch {
        return String(input);
      }
    }
  }
}

/** A middle dot used inside summaries; kept local to avoid a theme import here. */
const glyphDot = "·";

/**
 * Format a byte count compactly: "812 B", "1.2 KB", "3.4 MB". Used by write
 * summaries and result metadata lines.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format an elapsed duration compactly for the status bar: "0.4s", "12s",
 * "1m04s". Input is milliseconds.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m${String(rem).padStart(2, "0")}s`;
}

/**
 * Format a token count for the header: raw under 1000, otherwise "12.3k". Keeps
 * the running usage compact in a tight header.
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  return `${(n / 1000).toFixed(1)}k`;
}

/**
 * A short, human result line for a tool card (distinct from
 * {@link renderToolResultLine}, which is the headless `[result] …` form). On
 * success it prefers a structured count from `meta` (lines/entries/matches/
 * bytes) when present, falling back to the first line of content. On failure it
 * surfaces the error.
 */
export function summarizeToolResult(output: ToolResult, limit = 160): string {
  if (!output.ok) {
    return truncateForDisplay(output.error ?? output.content, limit);
  }
  const meta = output.meta ?? {};
  const metaNum = (k: string): number | undefined =>
    typeof meta[k] === "number" && Number.isFinite(meta[k] as number)
      ? (meta[k] as number)
      : undefined;

  const parts: string[] = [];
  const lines = metaNum("lines");
  const totalLines = metaNum("totalLines");
  const count = metaNum("count");
  const matches = metaNum("matches");
  const bytes = metaNum("bytes");
  const removed = metaNum("removed");
  const added = metaNum("added");
  const line = metaNum("line");
  const exitCode = metaNum("exitCode");
  const durationMs = metaNum("durationMs");

  if (lines !== undefined) {
    parts.push(totalLines !== undefined && totalLines !== lines ? `${lines}/${totalLines} lines` : `${lines} lines`);
  }
  if (count !== undefined) parts.push(`${count} ${count === 1 ? "entry" : "entries"}`);
  if (matches !== undefined) parts.push(`${matches} ${matches === 1 ? "match" : "matches"}`);
  if (removed !== undefined || added !== undefined) {
    const at = line !== undefined ? ` at line ${line}` : "";
    parts.push(`-${removed ?? 0}/+${added ?? 0} bytes${at}`);
  } else if (bytes !== undefined && lines === undefined) {
    parts.push(formatBytes(bytes));
  }
  if (exitCode !== undefined) parts.push(`exit ${exitCode}`);
  if (durationMs !== undefined) parts.push(formatDuration(durationMs));
  if (meta["truncated"] === true) parts.push("truncated");

  if (parts.length > 0) return parts.join(` ${glyphDot} `);
  // No structured meta: fall back to the first non-empty content line.
  const firstLine = output.content.split("\n").find((l) => l.trim().length > 0) ?? "";
  return truncateForDisplay(firstLine || "done", limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// Diff segmentation (pure, unit-tested)
//
// edit/write previews benefit from a colorized old→new diff. We compute a tiny
// line-level diff as plain data (an array of typed segments); tui.ts maps each
// segment to a colored StyledText chunk. Returning data — not OpenTUI nodes —
// is what keeps this testable.
// ─────────────────────────────────────────────────────────────────────────────

/** One line of a rendered diff: context, removed, or added. */
export interface DiffSegment {
  kind: "context" | "remove" | "add";
  text: string;
}

/**
 * A minimal line-level diff between two strings. This is deliberately *not* a
 * Myers diff: it strips the common leading and trailing lines (the unchanged
 * frame), then renders everything in between as a removed-block followed by an
 * added-block. For the small old_string→new_string substitutions the `edit`
 * tool performs, this reads cleanly and is cheap and predictable.
 *
 * `context` controls how many unchanged framing lines to keep on each side.
 */
export function diffLines(oldStr: string, newStr: string, context = 2): DiffSegment[] {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  // Length of the common prefix / suffix (in whole lines).
  let pre = 0;
  while (pre < oldLines.length && pre < newLines.length && oldLines[pre] === newLines[pre]) {
    pre++;
  }
  let suf = 0;
  while (
    suf < oldLines.length - pre &&
    suf < newLines.length - pre &&
    oldLines[oldLines.length - 1 - suf] === newLines[newLines.length - 1 - suf]
  ) {
    suf++;
  }

  const removed = oldLines.slice(pre, oldLines.length - suf);
  const added = newLines.slice(pre, newLines.length - suf);

  const segments: DiffSegment[] = [];
  // Leading context (the last `context` lines of the common prefix).
  const preStart = Math.max(0, pre - context);
  for (let i = preStart; i < pre; i++) {
    segments.push({ kind: "context", text: oldLines[i] ?? "" });
  }
  for (const line of removed) segments.push({ kind: "remove", text: line });
  for (const line of added) segments.push({ kind: "add", text: line });
  // Trailing context (the first `context` lines of the common suffix).
  const sufLines = oldLines.slice(oldLines.length - suf, oldLines.length - suf + context);
  for (const line of sufLines) segments.push({ kind: "context", text: line });

  return segments;
}
