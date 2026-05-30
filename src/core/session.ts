/**
 * Session: the in-memory owner of a single conversation (spec v0 §9).
 *
 * A session holds the canonical message list, the assembled system prompt, the
 * running token usage, the per-session permission allowlist, and the set of
 * files read this session (handed to tools via ToolContext.readSet — §7).
 *
 * Alongside the live state it appends an on-disk, append-only JSONL transcript
 * at `.om/transcripts/<sessionId>.jsonl`. The transcript serializes the
 * canonical types directly (providers.html §02), so `replayTranscript` can
 * rebuild a `Message[]` with no vendor coupling — the basis for the resume
 * stretch goal.
 *
 * The transcript directory is configurable and can be disabled (pass `null`)
 * so tests and ephemeral sessions touch no disk.
 */

import type {
  ContentBlock,
  Message,
  Role,
  ToolCall,
  ToolResult,
  Usage,
} from "./types.ts";
import { addUsage, zeroUsage } from "./types.ts";
import type { Logger } from "../util/logger.ts";
import { nullLogger } from "../util/logger.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Transcript records
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One line of the JSONL transcript. Every record carries a wall-clock `ts` and
 * a discriminating `kind`. The first record of a fresh session is `session`
 * (the header), then a `message` record per mutation, plus `usage` records as
 * accounting accumulates.
 */
export type TranscriptRecord =
  | { ts: string; kind: "session"; sessionId: string; systemPrompt: string }
  | { ts: string; kind: "message"; message: Message }
  | { ts: string; kind: "usage"; usage: Usage; total: Usage };

export interface SessionOptions {
  /** The assembled system prompt (spec §9). Defaults to "". */
  systemPrompt?: string;
  /** Stable id; one is generated if omitted. */
  sessionId?: string;
  /**
   * Directory for the transcript file. Created lazily on first write.
   * Defaults to ".om/transcripts". Pass `null` to disable the transcript
   * entirely (no file is opened or written).
   */
  transcriptDir?: string | null;
  /** Scoped logger; defaults to a no-op. Tools log at debug, never contents. */
  log?: Logger;
}

/**
 * A sortable session id: a fixed-width millisecond timestamp followed by a
 * short random suffix. Lexicographic order matches creation order, and the
 * suffix avoids collisions when two sessions start in the same millisecond.
 *
 * Using the runtime clock and randomness here is intentional application code.
 */
export function generateSessionId(now: number = Date.now()): string {
  // 13 digits covers ms timestamps well past the year 2286; pad for stability.
  const stamp = now.toString().padStart(13, "0");
  const suffix = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `${stamp}-${suffix}`;
}

export class Session {
  readonly sessionId: string;
  readonly messages: Message[] = [];
  systemPrompt: string;
  usage: Usage = zeroUsage();
  /** Per-session permission allowlist, keyed by tool (+ optional arg signature). */
  readonly allowlist: Set<string> = new Set<string>();
  /** Absolute file paths read this session (gates the `edit` tool — §7). */
  readonly readSet: Set<string> = new Set<string>();

  private readonly log: Logger;
  private readonly transcriptDir: string | null;
  private writer: Bun.FileSink | null = null;
  private headerWritten = false;

  constructor(opts: SessionOptions = {}) {
    this.sessionId = opts.sessionId ?? generateSessionId();
    this.systemPrompt = opts.systemPrompt ?? "";
    this.transcriptDir =
      opts.transcriptDir === undefined ? ".om/transcripts" : opts.transcriptDir;
    this.log = (opts.log ?? nullLogger()).child("session");
  }

  /** Absolute path of the transcript file, or null when disabled. */
  get transcriptPath(): string | null {
    return this.transcriptDir === null
      ? null
      : `${this.transcriptDir}/${this.sessionId}.jsonl`;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Mutations
  // ───────────────────────────────────────────────────────────────────────────

  /** Append a fully-formed canonical message and record it to the transcript. */
  append(msg: Message): void {
    this.messages.push(msg);
    this.writeRecord({ ts: nowIso(), kind: "message", message: msg });
    this.log.debug("append", { role: msg.role, blocks: msg.content.length });
  }

  /**
   * Append the user-side message carrying a tool_result block for `call`
   * (§5 invariant: every tool call gets a result). Tool results are delivered
   * to both providers inside a user-role message.
   */
  appendToolResult(call: ToolCall, result: ToolResult): void {
    const block: ContentBlock = {
      type: "tool_result",
      callId: call.id,
      result,
    };
    this.append({ role: "user", content: [block] });
  }

  /** Convenience: append a plain assistant text turn. */
  appendAssistantText(text: string): void {
    this.appendText("assistant", text);
  }

  /** Convenience: append a plain user text turn. */
  appendUserText(text: string): void {
    this.appendText("user", text);
  }

  private appendText(role: Role, text: string): void {
    this.append({ role, content: [{ type: "text", text }] });
  }

  /** Accumulate token usage and record the delta + running total. */
  addUsage(u: Usage): void {
    this.usage = addUsage(this.usage, u);
    this.writeRecord({ ts: nowIso(), kind: "usage", usage: u, total: this.usage });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Transcript I/O
  // ───────────────────────────────────────────────────────────────────────────

  private writeRecord(rec: TranscriptRecord): void {
    if (this.transcriptDir === null) return;
    try {
      const w = this.openWriter();
      if (!w) return;
      if (!this.headerWritten) {
        this.headerWritten = true;
        w.write(
          JSON.stringify({
            ts: nowIso(),
            kind: "session",
            sessionId: this.sessionId,
            systemPrompt: this.systemPrompt,
          } satisfies TranscriptRecord) + "\n",
        );
      }
      w.write(JSON.stringify(rec) + "\n");
      w.flush();
    } catch (err) {
      // The transcript is best-effort: never let it crash the harness.
      this.log.warn("transcript write failed", { error: String(err) });
    }
  }

  private openWriter(): Bun.FileSink | null {
    if (this.writer) return this.writer;
    if (this.transcriptDir === null) return null;
    // Bun.file().writer() creates parent dirs lazily on first write (1.3).
    this.writer = Bun.file(this.transcriptPath!).writer();
    return this.writer;
  }

  /** Flush and close the transcript file handle. Idempotent. */
  async close(): Promise<void> {
    if (!this.writer) return;
    const w = this.writer;
    this.writer = null;
    try {
      await w.end();
    } catch (err) {
      this.log.warn("transcript close failed", { error: String(err) });
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Replay a transcript JSONL into a canonical `Message[]` — the resume stretch
 * goal (spec §9). Lines that are not `message` records (the session header,
 * usage records) are skipped; malformed lines are ignored so a partially
 * written tail does not abort the replay.
 */
export async function replayTranscript(path: string): Promise<Message[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const text = await file.text();
  const messages: Message[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // tolerate a torn final line
    }
    if (
      rec !== null &&
      typeof rec === "object" &&
      (rec as { kind?: unknown }).kind === "message"
    ) {
      const msg = (rec as { message?: unknown }).message;
      if (isMessage(msg)) messages.push(msg);
    }
  }
  return messages;
}

function isMessage(v: unknown): v is Message {
  return (
    v !== null &&
    typeof v === "object" &&
    typeof (v as { role?: unknown }).role === "string" &&
    Array.isArray((v as { content?: unknown }).content)
  );
}
