/**
 * Entry point — boots the harness and wires every layer together (spec
 * tui.html §09 driver loop, v0.html §11 config/boot).
 *
 * This module is the *only* place the layers meet. It owns:
 *   1. argv parsing (--provider / --model / --headless / --tui / --help);
 *   2. config + API-key resolution (clear error when the key is missing);
 *   3. session + logger construction (.om/transcripts, .om/logs);
 *   4. system-prompt assembly (cwd, now, gitStatus, projectDoc);
 *   5. provider selection (anthropic | openai);
 *   6. the permission/approval seam (see "Approval seam" below);
 *   7. frontend selection (headless StdoutFrontend, or a lazily-imported
 *      TuiFrontend when a TTY is present and --tui is requested);
 *   8. the stdin input loop (one AbortController per turn; Ctrl-C aborts the
 *      active turn).
 *
 * ── Approval seam (binding code vs. idealized spec) ─────────────────────────
 * The committed `PermissionGate` is UI-agnostic: it takes a
 * `requestApproval(req) => Promise<ApprovalResponse>` callback and has NO
 * `gate.resolve(...)`. The loop (`runTurn`) does NOT yield `approval.request`
 * events — it only calls `gate.check`, which awaits `requestApproval`.
 *
 * So to surface the prompt through the *same* event stream the frontend is
 * already consuming, we multiplex: `requestApproval` pushes an
 * `approval.request` AgentEvent onto an {@link ApprovalMux} and parks the
 * promise's resolver in a Map keyed by the approval id. `mergeTurn` interleaves
 * those queued approval events with the loop's own events into one stream, which
 * is what we hand `frontend.render`. The frontend renders the prompt and calls
 * `frontend.onApproval(id, decision)`; we look up the parked resolver, map the
 * `Decision` back to an `ApprovalResponse` via `decisionToResponse`, and resolve
 * — unblocking `gate.check` inside the loop. The core (loop.ts/gate.ts/types.ts)
 * is untouched; the multiplexing lives entirely here.
 *
 * The pure pieces of that seam — `parseArgv`, `ApprovalMux`, and `mergeTurn` —
 * are exported so they can be unit-tested with no provider, network, or TTY.
 */

import { loadConfig, requireApiKey } from "./config.ts";
import type { Config, ConfigOverrides } from "./config.ts";
import { Session } from "./core/session.ts";
import { buildSystemPrompt, gitStatus, readProjectDoc } from "./core/prompt.ts";
import { runTurn } from "./core/loop.ts";
import type { RunTurnOptions } from "./core/loop.ts";
import { defaultRegistry } from "./tools/registry.ts";
import { PermissionGate } from "./permission/gate.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import { OpenAIProvider } from "./providers/openai.ts";
import { createLogger } from "./util/logger.ts";
import type { Logger } from "./util/logger.ts";
import { decisionToResponse } from "./tui/frontend.ts";
import type { Frontend } from "./tui/frontend.ts";
import { StdoutFrontend } from "./tui/stdout.ts";
import type {
  AgentEvent,
  ApprovalResponse,
  Decision,
  Provider,
  ProviderId,
  ToolContext,
} from "./core/types.ts";
import type { ApprovalRequest } from "./permission/gate.ts";

// ─────────────────────────────────────────────────────────────────────────────
// argv parsing (pure, exported, unit-tested)
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedArgs {
  /** Provider override (--provider), if a valid one was given. */
  provider?: ProviderId;
  /** Model override (--model). */
  model?: string;
  /** Force the headless stdout frontend (--headless). Wins over --tui. */
  headless: boolean;
  /** Request the OpenTUI frontend (--tui). Subject to a TTY being present. */
  tui: boolean;
  /** Print usage and exit (--help / -h). */
  help: boolean;
  /** Parse error message, if any flag was malformed. Non-fatal at parse time. */
  error?: string;
}

const PROVIDERS: readonly ProviderId[] = ["anthropic", "openai"];

function isProviderId(v: string): v is ProviderId {
  return (PROVIDERS as readonly string[]).includes(v);
}

/**
 * Parse the harness CLI flags out of an argv tail (i.e. `process.argv.slice(2)`).
 * Pure and total: never throws or touches process state. A malformed flag (e.g.
 * `--provider gemini`, or a value flag with no value) sets `.error` rather than
 * throwing, so the caller decides how to surface it.
 *
 * Supported forms: `--flag value`, `--flag=value`, and bare boolean flags.
 */
export function parseArgv(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { headless: false, tui: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === undefined) continue;

    // Split "--key=value" into key + inline value.
    const eq = raw.indexOf("=");
    const hasInline = raw.startsWith("--") && eq !== -1;
    const key = hasInline ? raw.slice(0, eq) : raw;
    const inlineValue = hasInline ? raw.slice(eq + 1) : undefined;

    /** Consume this flag's value: inline (`--k=v`) or the next argv token. */
    const takeValue = (): string | undefined => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) return undefined;
      i++;
      return next;
    };

    switch (key) {
      case "--help":
      case "-h":
        out.help = true;
        break;
      case "--headless":
        out.headless = true;
        break;
      case "--tui":
        out.tui = true;
        break;
      case "--provider": {
        const value = takeValue();
        if (value === undefined) {
          out.error = "--provider requires a value (anthropic | openai)";
        } else if (!isProviderId(value)) {
          out.error = `invalid --provider "${value}": expected anthropic | openai`;
        } else {
          out.provider = value;
        }
        break;
      }
      case "--model": {
        const value = takeValue();
        if (value === undefined) {
          out.error = "--model requires a value";
        } else {
          out.model = value;
        }
        break;
      }
      default:
        if (key.startsWith("-")) {
          out.error = `unknown flag: ${key}`;
        }
        // Bare positional args are ignored in v0 (no prompt-as-arg yet).
        break;
    }
  }

  return out;
}

/** Translate parsed flags into config overrides (only the ones that were set). */
export function overridesFromArgs(args: ParsedArgs): ConfigOverrides {
  const ov: ConfigOverrides = {};
  if (args.provider !== undefined) ov.provider = args.provider;
  if (args.model !== undefined) ov.model = args.model;
  return ov;
}

export const HELP_TEXT = [
  "om-cli — a terminal-native agentic coding harness",
  "",
  "Usage: om [options]",
  "",
  "Options:",
  "  --provider <anthropic|openai>  Override the configured provider",
  "  --model <name>                 Override the configured model",
  "  --headless                     Force the plain stdout frontend (no TUI)",
  "  --tui                          Use the OpenTUI frontend (needs a TTY)",
  "  -h, --help                     Show this help and exit",
  "",
  "Environment:",
  "  ANTHROPIC_API_KEY / OPENAI_API_KEY  Provider API key (required, never stored)",
  "  OM_PROVIDER / OM_MODEL              Config overrides (CLI flags win)",
  "  OM_LOG_LEVEL                        debug|info|warn|error (stderr log level)",
].join("\n");

// ─────────────────────────────────────────────────────────────────────────────
// Approval seam: ApprovalMux + mergeTurn (pure, exported, unit-tested)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single-consumer async queue of `approval.request` events.
 *
 * The gate's `requestApproval` (running deep inside `runTurn`) calls
 * {@link push} to enqueue a prompt; {@link mergeTurn} drains it concurrently
 * with the loop's own event stream so the prompt reaches the frontend through
 * the one merged stream. {@link close} releases any pending consumer when the
 * turn ends.
 *
 * Deliberately tiny and self-contained: no provider, no TTY, no timers — which
 * is exactly what makes it unit-testable.
 */
export class ApprovalMux {
  private readonly buffer: AgentEvent[] = [];
  private waiter: ((ev: AgentEvent | null) => void) | null = null;
  private closed = false;

  /** Enqueue an `approval.request` event for the merged stream to deliver. */
  push(req: ApprovalRequest): void {
    if (this.closed) return;
    const ev: AgentEvent = {
      type: "approval.request",
      id: req.id,
      tool: req.tool,
      preview: req.preview,
    };
    // Hand directly to a parked consumer if one is waiting; otherwise buffer.
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(ev);
    } else {
      this.buffer.push(ev);
    }
  }

  /**
   * Await the next queued approval event, or `null` once the mux is closed and
   * drained. Single-consumer: only `mergeTurn` calls this.
   */
  next(): Promise<AgentEvent | null> {
    const buffered = this.buffer.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (this.closed) return Promise.resolve(null);
    return new Promise<AgentEvent | null>((resolve) => {
      this.waiter = resolve;
    });
  }

  /** Signal end-of-turn: drains nothing new and wakes any parked consumer. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(null);
    }
  }
}

/**
 * Merge the loop's `AgentEvent` stream with the approval-request stream from a
 * {@link ApprovalMux} into one ordered `AsyncIterable<AgentEvent>`.
 *
 * Both sources are raced; whichever yields next is emitted. The loop source is
 * authoritative for completion: when it finishes we `close()` the mux and flush
 * any approval events it still holds, then end. (In practice the loop only ends
 * after every `gate.check` it issued has resolved, so the mux is already empty —
 * but flushing is cheap insurance against an ordering surprise.)
 *
 * Pure with respect to its inputs: give it a scripted loop generator and a mux,
 * push approval requests onto the mux, and the merged order is deterministic —
 * which is how the unit test drives it without a provider or TTY.
 */
export async function* mergeTurn(
  loop: AsyncIterable<AgentEvent>,
  mux: ApprovalMux,
): AsyncGenerator<AgentEvent> {
  const iterator = loop[Symbol.asyncIterator]();

  // Sentinel-tagged promises so we can tell which source settled.
  let loopNext: Promise<{ src: "loop"; res: IteratorResult<AgentEvent> }> | null =
    iterator.next().then((res) => ({ src: "loop" as const, res }));
  let muxNext: Promise<{ src: "mux"; ev: AgentEvent | null }> | null = mux
    .next()
    .then((ev) => ({ src: "mux" as const, ev }));

  let loopDone = false;

  while (loopNext || muxNext) {
    // Race only the live sources.
    const pending: Promise<
      | { src: "loop"; res: IteratorResult<AgentEvent> }
      | { src: "mux"; ev: AgentEvent | null }
    >[] = [];
    if (loopNext) pending.push(loopNext);
    if (muxNext) pending.push(muxNext);

    const winner = await Promise.race(pending);

    if (winner.src === "loop") {
      if (winner.res.done) {
        loopDone = true;
        loopNext = null;
        // The loop is the completion authority: close the mux so its stream
        // terminates, then drain whatever (if anything) remains.
        mux.close();
        // Re-arm the mux read if it isn't already pending so the drain proceeds.
        if (!muxNext) {
          muxNext = mux.next().then((ev) => ({ src: "mux" as const, ev }));
        }
      } else {
        yield winner.res.value;
        loopNext = iterator.next().then((res) => ({ src: "loop" as const, res }));
      }
    } else {
      // mux event
      if (winner.ev === null) {
        // Mux closed & drained.
        muxNext = null;
      } else {
        yield winner.ev;
        // Keep reading the mux only while the loop can still produce approvals,
        // or while the mux still has buffered events to flush after close.
        muxNext = mux.next().then((ev) => ({ src: "mux" as const, ev }));
      }
    }

    // Once the loop is done and the mux read returned null, both are null and
    // the while-condition ends the generator.
    if (loopDone && muxNext === null) break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider construction
// ─────────────────────────────────────────────────────────────────────────────

function buildProvider(provider: ProviderId, apiKey: string, log: Logger): Provider {
  switch (provider) {
    case "anthropic":
      return new AnthropicProvider(apiKey, { log });
    case "openai":
      return new OpenAIProvider(apiKey, { log });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Frontend selection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decide whether to run headless. `--headless` always wins; otherwise we use
 * the TUI only when `--tui` is asked for AND stdout is a real TTY. With no flag
 * and no TTY we fall back to headless so piped/CI runs work without a terminal.
 */
export function useTuiFrontend(args: ParsedArgs, isTty: boolean): boolean {
  if (args.headless) return false;
  if (!isTty) return false;
  return args.tui;
}

/**
 * Construct the chosen frontend. The TUI module is imported *dynamically* so a
 * headless run never needs OpenTUI or a TTY to be present on the import path.
 * If the TUI module is absent (not yet implemented) we degrade to stdout.
 */
async function makeFrontend(useTui: boolean, log: Logger): Promise<Frontend> {
  if (useTui) {
    try {
      const mod = (await import("./tui/tui.ts")) as {
        TuiFrontend: new () => Frontend;
      };
      return new mod.TuiFrontend();
    } catch (err) {
      log.warn("TUI frontend unavailable; falling back to stdout", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return new StdoutFrontend();
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgv(argv);

  if (args.help) {
    process.stdout.write(HELP_TEXT + "\n");
    return 0;
  }
  if (args.error) {
    process.stderr.write(`om-cli: ${args.error}\n\n${HELP_TEXT}\n`);
    return 2;
  }

  const cwd = process.cwd();

  // 1. Config (defaults → files → env → CLI flags).
  let config: Config;
  try {
    config = await loadConfig({ cwd, overrides: overridesFromArgs(args) });
  } catch (err) {
    process.stderr.write(`om-cli: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  // 2. API key (env only; clear error when missing).
  let apiKey: string;
  try {
    apiKey = requireApiKey(config.provider);
  } catch (err) {
    process.stderr.write(`om-cli: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  // 3. Session + logger (.om/transcripts, .om/logs).
  const session = new Session({ transcriptDir: ".om/transcripts" });
  const log = createLogger({ sessionId: session.sessionId, dir: ".om/logs" });

  // 4. System prompt (cwd, now, gitStatus, projectDoc) — set once on the session.
  const [git, projectDoc] = await Promise.all([gitStatus(cwd), readProjectDoc(cwd)]);
  session.systemPrompt = buildSystemPrompt({
    cwd,
    now: new Date(),
    ...(git !== null ? { gitStatus: git } : {}),
    ...(projectDoc !== null ? { projectDoc } : {}),
  });

  // 5. Provider + registry.
  const provider = buildProvider(config.provider, apiKey, log);
  const registry = defaultRegistry();

  // 6. Approval seam: a pending-resolver map + a per-turn mux. The gate pushes
  //    onto the *current* mux; mergeTurn drains it into the render stream.
  const pendingApprovals = new Map<string, (r: ApprovalResponse) => void>();
  let activeMux: ApprovalMux | null = null;

  const gate = new PermissionGate({
    config: {
      autoAllow: config.permissions.autoAllow,
      allowCommands: config.permissions.allowCommands,
    },
    allowlist: session.allowlist,
    log,
    requestApproval: (req: ApprovalRequest) =>
      new Promise<ApprovalResponse>((resolve) => {
        pendingApprovals.set(req.id, resolve);
        // If a turn is in flight, surface the prompt through its render stream.
        // If somehow none is active, deny safely rather than hang.
        if (activeMux) {
          activeMux.push(req);
        } else {
          pendingApprovals.delete(req.id);
          log.warn("approval requested with no active turn; denying", { id: req.id });
          resolve("deny");
        }
      }),
  });

  // 7. Frontend.
  const useTui = useTuiFrontend(args, Boolean(process.stdout.isTTY));
  const frontend = await makeFrontend(useTui, log);

  // The frontend reports the user's decision back here; resolve the parked
  // requestApproval promise so gate.check (inside the loop) unblocks.
  frontend.onApproval = (id: string, decision: Decision): void => {
    const resolve = pendingApprovals.get(id);
    if (resolve) {
      pendingApprovals.delete(id);
      resolve(decisionToResponse(decision));
    } else {
      log.warn("onApproval for unknown id", { id });
    }
  };

  // 8. Tool context — shared across turns; signal is swapped per turn below.
  //    We hold the live signal in a closure cell so ctx.signal always reflects
  //    the current turn's controller (the loop reads ctx.signal lazily).
  let turnSignal: AbortSignal = new AbortController().signal;
  const ctx: ToolContext = {
    cwd,
    get signal(): AbortSignal {
      return turnSignal;
    },
    log,
    readSet: session.readSet,
    emit: (chunk: string) => {
      // Live tool output streams to stdout in headless mode via the frontend's
      // own render path; for now route incremental chunks to stderr-free stdout.
      process.stdout.write(chunk);
    },
  };

  // onSubmit is the universal turn entry. The TUI frontend owns its own input
  // and calls this; the headless stdin line loop below ALSO routes through it
  // (never both for one frontend — see the `useTui` guard on the line loop).
  frontend.onSubmit = (text: string, signal: AbortSignal): void => {
    void runOneTurn(text, signal);
  };

  async function runOneTurn(text: string, signal: AbortSignal): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;

    session.appendUserText(trimmed);
    turnSignal = signal;

    const mux = new ApprovalMux();
    activeMux = mux;

    const opts: RunTurnOptions = {
      session,
      provider,
      registry,
      gate,
      model: config.model,
      signal,
      ctx,
    };

    try {
      await frontend.render(mergeTurn(runTurn(opts), mux));
    } catch (err) {
      log.error("turn render failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      mux.close();
      activeMux = null;
      // Any approvals still parked for this turn can never be answered now;
      // deny them so the gate's promises don't leak.
      for (const [id, resolve] of pendingApprovals) {
        pendingApprovals.delete(id);
        resolve("deny");
      }
    }
  }

  // ── Boot the frontend and drive the stdin input loop ───────────────────────
  await frontend.mount();

  // Ctrl-C aborts the *active* turn (rather than killing the process outright);
  // a second Ctrl-C with no active turn exits.
  let currentController: AbortController | null = null;
  const onSigint = (): void => {
    if (currentController && !currentController.signal.aborted) {
      currentController.abort();
      log.info("turn aborted by SIGINT");
    } else {
      void shutdown(130);
    }
  };
  process.on("SIGINT", onSigint);

  let exitCode = 0;
  let shuttingDown = false;
  async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    exitCode = code;
    process.off("SIGINT", onSigint);
    try {
      await frontend.dispose();
    } catch {
      /* ignore dispose errors on the way out */
    }
    await session.close();
    await log.close();
    process.exit(exitCode);
  }

  // The headless line loop: one AbortController per turn, awaiting each turn
  // before the next prompt so interleaving stays readable. Bun exposes a line
  // iterator on the global `console`. The TUI owns its own input and drives
  // turns via onSubmit instead, so we only run this loop when headless.
  if (!useTui) {
    try {
      for await (const line of console) {
        const controller = new AbortController();
        currentController = controller;
        // Drive the turn directly (awaitable) rather than the fire-and-forget
        // onSubmit, so the loop blocks until the turn completes and Ctrl-C
        // targets exactly this turn's controller.
        await runOneTurn(line, controller.signal);
        currentController = null;
      }
    } catch (err) {
      log.error("input loop failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      exitCode = 1;
    }
    await shutdown(exitCode);
  }

  // For the TUI path, control stays inside the frontend's own event loop until
  // it disposes; the process exits via the SIGINT/shutdown path.
  return exitCode;
}

// Run when invoked as the program entry (not when imported by a test).
if (import.meta.main) {
  void main();
}
