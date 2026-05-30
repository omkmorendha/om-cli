/**
 * OpenTUI frontend (spec tui.html §§02–08).
 *
 * `TuiFrontend` is the M5 rendering frontend. It implements the shared
 * `Frontend` interface (frontend.ts §09) on top of @opentui/core 0.3.0, so
 * `main.ts` can swap it in for the headless `StdoutFrontend` without the core,
 * providers, or tools knowing which is live. It is a pure *consumer* of the
 * core's `AgentEvent` stream and a *producer* of exactly two things back into
 * the core: submitted user text (`onSubmit`) and approval decisions
 * (`onApproval`). It owns rendering state only — never session state.
 *
 * ── API reality vs. the idealized spec ──────────────────────────────────────
 * The spec's code snippets are slightly idealized. The binding facts of the
 * verified 0.3.0 API (discovered from the package .d.ts) are:
 *   - Every Renderable's constructor is `(ctx: RenderContext, options)`. The
 *     `CliRenderer` returned by `createCliRenderer()` *is* the RenderContext, so
 *     we pass `this.renderer` as the first arg to every `new …Renderable(...)`.
 *     (The spec writes `new BoxRenderable({...})` with no ctx — that is wrong.)
 *   - Global keypresses arrive via `renderer.keyInput` (a `KeyHandler`, not
 *     `keyHandler`) which emits `"keypress"` with a `KeyEvent` (`.name`, `.ctrl`).
 *   - `InputRenderable` surfaces submit via the `InputRenderableEvents.ENTER`
 *     event (an EventEmitter), not an `onSubmit` property.
 *   - `SelectRenderable` surfaces a choice via `SelectRenderableEvents.ITEM_SELECTED`
 *     and `getSelectedOption()`; its options carry an opaque `value`.
 *   - `padding` takes a number (or per-side `paddingLeft`/`paddingRight`), not the
 *     `{ left, right }` object the spec shows.
 *   - Usage fields are `inputTokens` / `outputTokens` (not `.input` / `.output`).
 *
 * ── Testability seam ────────────────────────────────────────────────────────
 * This file needs a real TTY to mount, so it is hard to unit-test. Every
 * renderer/renderable touch is guarded behind `mount()`; construction is inert.
 * The companion `tui.test.ts` constructs the class WITHOUT mounting and asserts
 * the `Frontend` shape. `render()` is also safe before mount (it no-ops on the
 * UI side but still drains the event stream so callers don't hang).
 *
 * Stdout discipline: the renderer owns stdout for its alt-screen output; we
 * never `console.log`. Diagnostics go through the injected `Logger` (stderr/file).
 */

import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  createCliRenderer,
  createTextAttributes,
} from "@opentui/core";
import type { CliRenderer, KeyEvent, SelectOption } from "@opentui/core";

import type { AgentEvent, Decision, ToolResult } from "../core/types.ts";
import type { Logger } from "../util/logger.ts";
import { nullLogger } from "../util/logger.ts";
import { renderToolResultLine, toDecision, truncateForDisplay } from "./frontend.ts";
import type { Frontend } from "./frontend.ts";

/** Construction-time options. All optional so the smoke test can `new` it bare. */
export interface TuiFrontendOptions {
  /** Project path shown in the header. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Provider/model label shown in the header, e.g. "anthropic · sonnet". */
  providerLabel?: string;
  /** Scoped logger; defaults to a no-op so construction never needs a sink. */
  log?: Logger;
}

/** A live tool card: the box, its body text, and a spinner/status line. */
interface ToolCard {
  box: BoxRenderable;
  body: TextRenderable;
  status: TextRenderable;
}

/** The three approval choices surfaced in the Select widget. */
const APPROVAL_OPTIONS: SelectOption[] = [
  { name: "Allow once", description: "Run this one call", value: "once" },
  { name: "Allow session", description: "Remember for this session", value: "session" },
  { name: "Deny", description: "Reject this call", value: "deny" },
];

export class TuiFrontend implements Frontend {
  onSubmit?: (text: string, signal: AbortSignal) => void;
  onApproval?: (id: string, decision: Decision) => void;

  private readonly cwd: string;
  private readonly providerLabel: string;
  private readonly log: Logger;

  // Renderer + region handles are only created in mount(); undefined until then.
  private renderer: CliRenderer | undefined;
  private headerText: TextRenderable | undefined;
  private scrollback: ScrollBoxRenderable | undefined;
  private approvalBar: BoxRenderable | undefined;
  private approvalLabel: TextRenderable | undefined;
  private select: SelectRenderable | undefined;
  private input: InputRenderable | undefined;

  /** The TextRenderable currently receiving text.delta; sealed on text.done. */
  private liveAssistant: TextRenderable | null = null;
  /** Accumulated text for the live assistant block (TextRenderable has no append). */
  private liveAssistantText = "";

  /** Tool cards keyed by tool-call id, so tool.result can update the right card. */
  private readonly toolCards = new Map<string, ToolCard>();

  /** The current turn's abort controller (set on submit, cleared on turn.done). */
  private activeAbort: AbortController | undefined;
  /** The id of the in-flight approval request; non-null only while the bar is up. */
  private pendingApprovalId: string | undefined;

  /** Idle Ctrl-C disarm flag: a second consecutive Ctrl-C at idle exits. */
  private ctrlCArmed = false;
  private disposed = false;

  constructor(opts: TuiFrontendOptions = {}) {
    this.cwd = opts.cwd ?? process.cwd();
    this.providerLabel = opts.providerLabel ?? "";
    this.log = (opts.log ?? nullLogger()).child("tui");
  }

  /**
   * Build the renderer and the four-region tree once. Everything that touches a
   * real TTY lives here, so constructing the class is side-effect-free.
   */
  async mount(): Promise<void> {
    if (this.renderer) return; // idempotent
    // We own Ctrl-C ourselves (turn-abort vs. exit), so disable the renderer's
    // built-in exit-on-Ctrl-C and route the key through our handler instead.
    const renderer = await createCliRenderer({ exitOnCtrlC: false });
    this.renderer = renderer;

    const root = new BoxRenderable(renderer, {
      flexDirection: "column",
      flexGrow: 1,
    });

    // ── Header: cwd + provider/model + running token usage ──────────────────
    const header = new BoxRenderable(renderer, {
      height: 1,
      paddingLeft: 1,
      paddingRight: 1,
    });
    this.headerText = new TextRenderable(renderer, {
      content: this.headerContent(0, 0),
      attributes: createTextAttributes({ bold: true }),
    });
    header.add(this.headerText);

    // ── Scrollback: grows to fill, sticky to the bottom as content arrives ──
    this.scrollback = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      scrollY: true,
      stickyScroll: true,
      stickyStart: "bottom",
      paddingLeft: 1,
      paddingRight: 1,
    });

    // ── Approval bar: hidden until an approval.request arrives ──────────────
    this.approvalBar = new BoxRenderable(renderer, {
      visible: false,
      border: true,
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
    });
    this.approvalLabel = new TextRenderable(renderer, { content: "" });
    this.select = new SelectRenderable(renderer, {
      options: APPROVAL_OPTIONS,
      showDescription: true,
      wrapSelection: true,
    });
    this.approvalBar.add(this.approvalLabel);
    this.approvalBar.add(this.select);

    // ── Input: focused at idle, blurred while a turn streams ────────────────
    this.input = new InputRenderable(renderer, {
      placeholder: "Ask om-cli…",
    });

    root.add(header);
    root.add(this.scrollback);
    root.add(this.approvalBar);
    root.add(this.input);
    renderer.root.add(root);

    this.wireInput();
    this.wireSelect();
    this.wireKeys();

    this.input.focus();
    renderer.start();
    this.log.info("tui mounted");
  }

  /**
   * Render one turn's events to completion. Each event is mapped to an in-place
   * mutation of the region tree (spec §05). Safe to call before mount(): the UI
   * mutations no-op, but the stream is still fully drained so the driver loop in
   * main.ts never deadlocks.
   */
  async render(events: AsyncIterable<AgentEvent>): Promise<void> {
    this.blurInput();
    try {
      for await (const ev of events) {
        switch (ev.type) {
          case "text.delta":
            this.appendAssistantDelta(ev.text);
            break;
          case "text.done":
            this.sealAssistant();
            break;
          case "tool.start":
            this.startToolCard(ev.id, ev.name, ev.input);
            break;
          case "tool.result":
            this.finishToolCard(ev.id, ev.output);
            break;
          case "approval.request":
            this.showApproval(ev.id, ev.tool, ev.preview);
            break;
          case "turn.done":
            this.applyUsage(ev.usage.inputTokens, ev.usage.outputTokens);
            break;
          case "error":
            this.appendError(ev.message, ev.fatal);
            break;
        }
      }
    } finally {
      // Whatever happened (clean end, error, abort), the turn is over: seal any
      // dangling assistant block, drop the abort handle, and refocus input.
      this.sealAssistant();
      this.hideApproval();
      this.activeAbort = undefined;
      this.refocusInput();
    }
  }

  /** Tear down the renderer and restore the terminal. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const renderer = this.renderer;
    this.renderer = undefined;
    if (renderer) {
      try {
        renderer.destroy();
      } catch (err) {
        this.log.warn("renderer destroy failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.log.info("tui disposed");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Wiring
  // ───────────────────────────────────────────────────────────────────────────

  /** On Enter: hand the trimmed line to the core, clear + blur the input. */
  private wireInput(): void {
    const input = this.input;
    if (!input) return;
    input.on(InputRenderableEvents.ENTER, (value: string) => {
      const trimmed = value.trim();
      input.value = "";
      this.ctrlCArmed = false; // typing/submitting disarms the idle exit
      if (trimmed.length === 0) return;
      if (this.activeAbort) return; // ignore submits while a turn is streaming

      // The TUI owns the in-flight turn's AbortController; its signal threads
      // through the provider stream and Bun.spawn for a clean Ctrl-C unwind.
      const controller = new AbortController();
      this.activeAbort = controller;
      this.appendUserLine(trimmed);
      this.onSubmit?.(trimmed, controller.signal);
    });
  }

  /** On Select choice: map to a Decision and resolve the pending approval. */
  private wireSelect(): void {
    const select = this.select;
    if (!select) return;
    select.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: SelectOption) => {
      const value = (option.value as string | undefined) ?? "deny";
      const decision = toDecision(value === "session" ? "session" : value === "once" ? "once" : "deny");
      this.resolveApproval(decision);
    });
  }

  /**
   * Global control keys (spec §08). Approval shortcuts win when the bar is up;
   * otherwise Ctrl-C aborts the turn (or, at idle, clears/exits) and Ctrl-D on an
   * empty input exits. Plain typing flows untouched to the focused input.
   */
  private wireKeys(): void {
    const renderer = this.renderer;
    if (!renderer) return;
    renderer.keyInput.on("keypress", (ev: KeyEvent) => {
      // 1. Approval shown: y / a / n resolve the blocked gate immediately.
      if (this.pendingApprovalId !== undefined) {
        if (ev.name === "y") return this.resolveApproval(toDecision("once"));
        if (ev.name === "a") return this.resolveApproval(toDecision("session"));
        if (ev.name === "n") return this.resolveApproval(toDecision("deny"));
        return; // swallow other keys while the modal is up
      }

      // 2. Ctrl-C: abort the active turn, or clear/exit at idle.
      if (ev.ctrl && ev.name === "c") {
        if (this.activeAbort) {
          this.log.info("ctrl-c: aborting turn");
          this.activeAbort.abort();
          this.ctrlCArmed = false;
          return;
        }
        if (this.input && this.input.value.length > 0) {
          this.input.value = "";
          this.ctrlCArmed = false;
          return;
        }
        // Idle + empty: first press arms, second press exits (shell-like).
        if (this.ctrlCArmed) {
          void this.exit();
          return;
        }
        this.ctrlCArmed = true;
        return;
      }

      // 3. Ctrl-D on an empty input: exit.
      if (ev.ctrl && ev.name === "d" && (!this.input || this.input.value.length === 0)) {
        void this.exit();
        return;
      }

      // Any other key disarms the idle Ctrl-C exit latch.
      this.ctrlCArmed = false;
    });
  }

  /** Dispose then exit the process. Mirrors the spec's Ctrl-D/Ctrl-C behavior. */
  private async exit(): Promise<void> {
    await this.dispose();
    process.exit(0);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Event → render mutations
  // ───────────────────────────────────────────────────────────────────────────

  /** Append a streamed assistant delta, creating the live block lazily. */
  private appendAssistantDelta(text: string): void {
    const scrollback = this.scrollback;
    const renderer = this.renderer;
    if (!scrollback || !renderer) return;
    if (!this.liveAssistant) {
      this.liveAssistantText = "";
      this.liveAssistant = new TextRenderable(renderer, { content: "" });
      scrollback.content.add(this.liveAssistant);
    }
    this.liveAssistantText += text;
    this.liveAssistant.content = this.liveAssistantText;
  }

  /** Seal the live assistant block so the next text run starts fresh. */
  private sealAssistant(): void {
    this.liveAssistant = null;
    this.liveAssistantText = "";
  }

  /** Append the user's submitted line as its own block in the scrollback. */
  private appendUserLine(text: string): void {
    const scrollback = this.scrollback;
    const renderer = this.renderer;
    if (!scrollback || !renderer) return;
    // Seal any dangling assistant block first so ordering stays chronological.
    this.sealAssistant();
    const line = new TextRenderable(renderer, {
      content: `> ${text}`,
      attributes: createTextAttributes({ bold: true }),
    });
    scrollback.content.add(line);
  }

  /** Create a tool card on tool.start and register it under its call id. */
  private startToolCard(id: string, name: string, input: unknown): void {
    const scrollback = this.scrollback;
    const renderer = this.renderer;
    if (!scrollback || !renderer) return;
    // A tool starting closes the current assistant text run.
    this.sealAssistant();

    const box = new BoxRenderable(renderer, {
      border: true,
      title: name,
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
    });
    const body = new TextRenderable(renderer, {
      content: truncateForDisplay(formatToolInput(input)),
    });
    const status = new TextRenderable(renderer, {
      content: "running…",
      attributes: createTextAttributes({ dim: true }),
    });
    box.add(body);
    box.add(status);
    scrollback.content.add(box);
    this.toolCards.set(id, { box, body, status });
  }

  /** Update the matching tool card on tool.result (ok/err status line). */
  private finishToolCard(id: string, output: ToolResult): void {
    const card = this.toolCards.get(id);
    if (!card) return;
    card.status.content = renderToolResultLine(output);
    card.status.fg = output.ok ? "#4ade80" : "#f87171";
  }

  /** Show the approval bar, focus the Select, blur the input (spec §07). */
  private showApproval(id: string, tool: string, preview: string): void {
    this.pendingApprovalId = id;
    if (this.approvalBar) this.approvalBar.title = `Allow ${tool}?`;
    if (this.approvalLabel) {
      this.approvalLabel.content = `${truncateForDisplay(preview)}   (y) once  (a) session  (n) deny`;
    }
    if (this.approvalBar) this.approvalBar.visible = true;
    this.blurInput();
    this.select?.focus();
    // main.ts has the loop blocked in the gate's requestApproval promise;
    // resolveApproval routes our Decision back through onApproval to unblock it.
  }

  /**
   * Resolve the in-flight approval (id stored in `pendingApprovalId`) with a
   * decision, route it back to the core via onApproval, then hide the bar. A
   * no-op if no approval is pending so a stray y/a/n cannot fire onApproval.
   */
  private resolveApproval(decision: Decision): void {
    const id = this.pendingApprovalId;
    if (id === undefined) return;
    this.hideApproval();
    this.onApproval?.(id, decision);
  }

  /** Hide the approval bar and clear pending state; refocus the input. */
  private hideApproval(): void {
    this.pendingApprovalId = undefined;
    this.select?.blur();
    if (this.approvalBar) this.approvalBar.visible = false;
    // Only refocus the input if a turn is still active (more events to come);
    // render()'s finally block handles the idle case.
    if (this.activeAbort) this.input?.focus();
  }

  /** Render a non-fatal/fatal error as a distinct line in the scrollback. */
  private appendError(message: string, fatal: boolean): void {
    const scrollback = this.scrollback;
    const renderer = this.renderer;
    if (!scrollback || !renderer) return;
    this.sealAssistant();
    const line = new TextRenderable(renderer, {
      content: `[error] ${truncateForDisplay(message)}${fatal ? " (fatal)" : ""}`,
    });
    line.fg = "#f87171";
    scrollback.content.add(line);
  }

  /** Update header token usage from the latest turn.done. */
  private applyUsage(inputTokens: number, outputTokens: number): void {
    if (this.headerText) this.headerText.content = this.headerContent(inputTokens, outputTokens);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Focus helpers
  // ───────────────────────────────────────────────────────────────────────────

  private blurInput(): void {
    this.input?.blur();
  }

  private refocusInput(): void {
    // Don't steal focus from an open approval modal.
    if (this.pendingApprovalId !== undefined) return;
    this.input?.focus();
  }

  /** Compose the one-line header string. */
  private headerContent(inputTokens: number, outputTokens: number): string {
    const provider = this.providerLabel ? `   ${this.providerLabel}` : "";
    const usage = `   ${inputTokens}/${outputTokens} tok`;
    return `om-cli  ${this.cwd}${provider}${usage}`;
  }
}

/** Render a tool's input for a card body: JSON for objects, raw for strings. */
function formatToolInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}
