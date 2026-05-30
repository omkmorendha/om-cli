/**
 * Headless stdout frontend (spec tui.html §10).
 *
 * The M1–M4 frontend and the permanent debug/CI path. It implements the shared
 * `Frontend` interface (§09) using only `process.stdout` / `process.stdin` — no
 * OpenTUI, no alt-screen — so the agent loop, providers, tools, and permission
 * gate can be proven before any terminal rendering exists. If a turn behaves
 * correctly here, the TUI is purely a rendering concern on top of the same
 * event set.
 *
 * Testability seam (the important part):
 *   `render(events)` is the unit under test. It is driven by a synthetic
 *   `AsyncIterable<AgentEvent>` and two injectable sinks supplied to the
 *   constructor:
 *     - `out(s)`     — where rendered text goes. Defaults to process.stdout.
 *     - `readKey(p)` — how an approval keypress is read. Defaults to a real
 *                      single-key stdin reader.
 *   Nothing inside `render()` touches the global process streams directly, so a
 *   test can capture every byte and script every approval answer.
 *
 * Input loop ownership:
 *   `mount()` is deliberately side-effect-light (it just prints a one-line
 *   banner via the same `out` sink). The stdin *line* loop that feeds
 *   `onSubmit` is driven by `main.ts`, NOT by this class — keeping mount()
 *   testable and the input source swappable at the wiring layer. `main.ts` reads
 *   lines (e.g. Bun's `for await (const line of console)`), creates a per-turn
 *   `AbortController`, and calls `frontend.onSubmit(line, controller.signal)`.
 *
 * Stdout discipline: logs go to stderr/file only (util/logger.ts). This
 * frontend owns stdout for its rendered output; the error event also goes to
 * stderr so it never corrupts the rendered stream.
 */

import type { AgentEvent, ApprovalResponse, Decision } from "../core/types.ts";
import { renderToolResultLine, toDecision, truncateForDisplay } from "./frontend.ts";
import type { Frontend } from "./frontend.ts";

/** A line/string sink — `process.stdout.write` shaped. */
export type OutSink = (s: string) => void;

/**
 * Reads a single approval keypress. Receives the prompt to display and resolves
 * with the raw key the user pressed (we only care about 'y' / 'a' / 'n').
 */
export type ReadKey = (prompt: string) => Promise<string>;

export interface StdoutFrontendOptions {
  /** Where rendered output goes. Defaults to process.stdout. */
  out?: OutSink;
  /** Approval keypress reader. Defaults to a raw-mode single-key stdin reader. */
  readKey?: ReadKey;
  /** Sink for error events. Defaults to process.stderr (never stdout). */
  err?: OutSink;
}

/**
 * Default approval-key reader: prints the prompt to stdout, flips stdin to raw
 * mode, reads one keypress, restores cooked mode, and resolves with the key.
 * Ctrl-C / Ctrl-D map to "n" (a safe deny) so a wedged prompt can be escaped.
 *
 * Only used when no `readKey` is injected; tests always inject their own.
 */
function defaultReadKey(out: OutSink): ReadKey {
  return (prompt: string) =>
    new Promise<string>((resolve) => {
      out(prompt);
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw ?? false;
      stdin.setRawMode?.(true);
      stdin.resume();

      const onData = (chunk: Buffer | string): void => {
        const key = chunk.toString("utf8");
        cleanup();
        // Ctrl-C (\x03) / Ctrl-D (\x04) escape the prompt as a deny.
        if (key === "\x03" || key === "\x04") {
          out("\n");
          resolve("n");
          return;
        }
        out(key + "\n");
        resolve(key);
      };

      const cleanup = (): void => {
        stdin.off("data", onData);
        stdin.setRawMode?.(wasRaw);
        stdin.pause();
      };

      stdin.on("data", onData);
    });
}

/**
 * Map a raw approval keypress to an `ApprovalResponse`:
 *   'a' → session, 'y' → once, anything else → deny.
 * Case-insensitive; the first character of the input is what counts.
 */
export function keyToResponse(key: string): ApprovalResponse {
  const k = key.trim().slice(0, 1).toLowerCase();
  if (k === "a") return "session";
  if (k === "y") return "once";
  return "deny";
}

export class StdoutFrontend implements Frontend {
  onSubmit?: (text: string, signal: AbortSignal) => void;
  onApproval?: (id: string, decision: Decision) => void;

  private readonly out: OutSink;
  private readonly err: OutSink;
  private readonly readKey: ReadKey;

  constructor(opts: StdoutFrontendOptions = {}) {
    this.out = opts.out ?? ((s) => void process.stdout.write(s));
    this.err = opts.err ?? ((s) => void process.stderr.write(s));
    this.readKey = opts.readKey ?? defaultReadKey(this.out);
  }

  /**
   * Side-effect-light: print a one-line banner via the out sink so a human sees
   * the frontend is live. The stdin line loop is driven by main.ts (see file
   * header), not here, so mount() stays trivially testable.
   */
  async mount(): Promise<void> {
    this.out("om-cli (headless)\n");
  }

  /**
   * Render one turn's events to completion. The single source of side effects is
   * the injected `out` / `err` / `readKey`, so this is fully drivable in tests
   * with a scripted async iterable.
   */
  async render(events: AsyncIterable<AgentEvent>): Promise<void> {
    for await (const ev of events) {
      switch (ev.type) {
        case "text.delta":
          // Streamed assistant text grows in place — no trailing newline yet.
          this.out(ev.text);
          break;

        case "text.done":
          // Seal the streamed block with a newline so the next line is fresh.
          this.out("\n");
          break;

        case "tool.start":
          this.out(`[tool] ${ev.name} ${truncateForDisplay(formatInput(ev.input))}\n`);
          break;

        case "tool.result":
          this.out(renderToolResultLine(ev.output) + "\n");
          break;

        case "approval.request": {
          const key = await this.readKey(`Allow ${ev.tool}? ${ev.preview} [y/a/n] `);
          this.onApproval?.(ev.id, toDecision(keyToResponse(key)));
          break;
        }

        case "turn.done":
          this.out(
            `[done] ${ev.stopReason} ` +
              `${ev.usage.inputTokens}/${ev.usage.outputTokens} tok\n`,
          );
          break;

        case "error":
          // Errors go to stderr so they never corrupt the rendered stdout stream.
          this.err(`[error] ${ev.message}${ev.fatal ? " (fatal)" : ""}\n`);
          break;
      }
    }
  }

  /** Nothing to restore for a plain stdout frontend. */
  async dispose(): Promise<void> {}
}

/** Render a tool's input for the `[tool]` line; JSON for objects, raw otherwise. */
function formatInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}
