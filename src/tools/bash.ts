/**
 * bash tool (spec tools.html §08).
 *
 * Runs a shell command via `Bun.spawn(["sh", "-lc", command])`. This is the
 * general-purpose escape hatch — build, test, git, package managers. stdout and
 * stderr are captured (interleaved as produced) and streamed live to the TUI via
 * `ctx.emit`. The turn's `AbortSignal` threads through so Ctrl-C kills the
 * process and unwinds the loop cleanly, and a `timeout_ms` timer kills the
 * process with SIGTERM if it overruns.
 *
 * Permission class `exec` -> prompt (the approval gate is the boundary; v0 has
 * no path jail).
 */

import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../core/types.ts";
import { ToolResult as TR } from "../core/types.ts";
import { truncate } from "./truncate.ts";

export const bashSchema = z.object({
  command: z.string().describe("Shell command to run via the system shell."),
  cwd: z.string().optional().describe("Working directory. Default: ctx.cwd."),
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(600_000)
    .default(120_000)
    .describe("Kill the process after this many ms."),
});

export type BashInput = z.infer<typeof bashSchema>;

/** Collapse a string to a single line and cap it at `max` chars (+ "…"). */
function oneLine(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max) + "…";
}

/**
 * Drain a ReadableStream of bytes, decoding each chunk to text, appending it to
 * `chunks` (in arrival order, interleaved with the other stream), and emitting
 * it live to the TUI. Returns when the stream ends.
 */
async function drain(
  stream: ReadableStream<Uint8Array>,
  decoder: TextDecoder,
  chunks: string[],
  ctx: ToolContext,
): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        const text = decoder.decode(value, { stream: true });
        if (text.length > 0) {
          chunks.push(text);
          ctx.emit?.(text);
        }
      }
    }
    const tail = decoder.decode();
    if (tail.length > 0) {
      chunks.push(tail);
      ctx.emit?.(tail);
    }
  } finally {
    reader.releaseLock();
  }
}

export const bashTool: Tool<BashInput> = {
  name: "bash",
  description:
    "Run a shell command via the system shell. Use for builds, tests, git, " +
    "package managers, and other shell tasks. Output is combined stdout+stderr.",
  schema: bashSchema,
  permission: "exec",

  preview(input: BashInput): string {
    return `bash ${oneLine(input.command, 80)}`;
  },

  async run(input: BashInput, ctx: ToolContext): Promise<ToolResult> {
    const cwd = input.cwd ?? ctx.cwd;
    const log = ctx.log.child("tool:bash");
    log.debug("spawn", { cwd, timeout_ms: input.timeout_ms });

    const start = performance.now();

    // Bail before spawning if the turn was already aborted.
    if (ctx.signal.aborted) {
      return TR.error("aborted", {
        command: input.command,
        cwd,
        exitCode: null,
        signal: "SIGTERM",
        durationMs: 0,
        truncated: false,
      });
    }

    // Ordered, interleaved stdout+stderr text as produced.
    const chunks: string[] = [];
    // A single decoder shared across both streams keeps arrival order intact in
    // `chunks` (each chunk is decoded independently with streaming continuation
    // handled per-stream below — but interleaving order is what we capture).
    const outDecoder = new TextDecoder();
    const errDecoder = new TextDecoder();

    const proc = Bun.spawn(["sh", "-lc", input.command], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });

    let timedOut = false;
    let aborted = false;

    // Timeout timer: SIGTERM the process if it overruns.
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, input.timeout_ms);

    // Abort handling: kill the process when the turn's signal fires.
    const onAbort = () => {
      aborted = true;
      proc.kill("SIGTERM");
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    let exitCode: number | null = null;
    try {
      await Promise.all([
        drain(proc.stdout as ReadableStream<Uint8Array>, outDecoder, chunks, ctx),
        drain(proc.stderr as ReadableStream<Uint8Array>, errDecoder, chunks, ctx),
      ]);
      exitCode = await proc.exited;
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
    }

    const durationMs = Math.round(performance.now() - start);
    const raw = chunks.join("");
    const { content, truncated } = truncate(raw);

    // When we kill the process (timeout/abort) Bun reports exit code 128+signal
    // (e.g. 143 for SIGTERM). The spec wants exitCode:null for "killed by
    // signal" and the signal name surfaced in meta.signal instead.
    const killed = timedOut || aborted;
    const signal: string | null = killed ? "SIGTERM" : null;
    const reportedExitCode: number | null = killed ? null : exitCode;

    const meta = {
      command: input.command,
      cwd,
      exitCode: reportedExitCode,
      signal,
      durationMs,
      truncated,
    };

    log.debug("done", { exitCode: reportedExitCode, signal, durationMs, truncated });

    if (aborted) {
      return TR.error("aborted", meta);
    }
    if (timedOut) {
      return {
        ok: false,
        content,
        error: `timed out after ${input.timeout_ms}ms`,
        meta,
      };
    }
    if (exitCode !== 0) {
      return {
        ok: false,
        content,
        error: `exited with code ${exitCode}`,
        meta,
      };
    }
    return { ok: true, content, meta };
  },
};

export default bashTool;
