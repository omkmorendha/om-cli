/**
 * OpenTUI frontend (spec tui.html §§02–08) — the rich M5 rendering frontend.
 *
 * `TuiFrontend` implements the shared `Frontend` interface (frontend.ts §09) on
 * top of @opentui/core 0.3.0, so `main.ts` can swap it in for the headless
 * `StdoutFrontend` without the core, providers, or tools knowing which is live.
 * It is a pure *consumer* of the core's `AgentEvent` stream and a *producer* of
 * exactly two things back into the core: submitted user text (`onSubmit`) and
 * approval decisions (`onApproval`). It owns rendering state only — never
 * session state (spec §01).
 *
 * What this revamp renders (vs. the old barebones version):
 *   - Assistant replies as **streamed markdown** (headings, lists, inline code,
 *     fenced code blocks) via `MarkdownRenderable`, with a graceful fallback to
 *     styled plain text if the markdown/tree-sitter stack can't initialize.
 *   - **Per-tool cards** — read / bash / edit / write / glob / grep each get a
 *     tailored one-line summary, an accent color, and an animated spinner while
 *     in flight; edits/writes show a colorized diff; bash streams its live
 *     output into the card (routed via `emitToolOutput`, fed by `ctx.emit`).
 *   - A two-part **header** (cwd · provider/model) plus a live **status bar**
 *     (spinner · state · elapsed · token usage incl. prompt-cache) that updates
 *     every frame while a turn runs.
 *   - A **welcome state** when the scrollback is empty and a **footer** key-hint
 *     line, so the harness is legible on first run.
 *
 * ── API reality vs. the idealized spec ──────────────────────────────────────
 * The spec's snippets are slightly idealized; the binding facts of the verified
 * 0.3.0 API (from the package .d.ts) are:
 *   - Every Renderable constructor is `(ctx: RenderContext, options)`. The
 *     `CliRenderer` from `createCliRenderer()` *is* the RenderContext, so we pass
 *     `this.renderer` as the first arg to every `new …Renderable(...)`.
 *   - Global keypresses arrive via `renderer.keyInput` (a `KeyHandler`) emitting
 *     `"keypress"` with a `KeyEvent` (`.name`, `.ctrl`).
 *   - `InputRenderable` submit is the `InputRenderableEvents.ENTER` event.
 *   - `SelectRenderable` choice is `SelectRenderableEvents.ITEM_SELECTED`.
 *   - Scrollback children attach to `scrollbox.content.add(...)`.
 *   - `MarkdownRenderable` requires a `syntaxStyle`; a `treeSitterClient` is
 *     optional (only enables code highlighting) and is wired in lazily.
 *
 * ── Testability seam ────────────────────────────────────────────────────────
 * This file needs a real TTY to mount, so the smoke test (tui.test.ts) stays
 * *below* mount(): construction is inert and every renderer touch is guarded by
 * a mount check. `render()` is also safe before mount — it no-ops on the UI side
 * but still drains the event stream so the driver loop never deadlocks. The pure
 * string/diff shaping lives in frontend.ts and is unit-tested there.
 *
 * Stdout discipline: the renderer owns stdout for its alt-screen output; we never
 * `console.log`. Diagnostics go through the injected `Logger` (stderr/file).
 */

import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  MarkdownRenderable,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  StyledText,
  SyntaxStyle,
  TextRenderable,
  createCliRenderer,
  getTreeSitterClient,
  t,
  bold,
  dim,
  fg,
} from "@opentui/core";
import type {
  CliRenderer,
  KeyEvent,
  SelectOption,
  SyntaxStyle as SyntaxStyleType,
  TextChunk,
  TreeSitterClient,
} from "@opentui/core";

/** The renderable used for an assistant block: markdown when available, else text. */
type AssistantBlock = TextRenderable | MarkdownRenderable;

import type { AgentEvent, Decision, ToolResult, Usage } from "../core/types.ts";
import type { Logger } from "../util/logger.ts";
import { nullLogger } from "../util/logger.ts";
import {
  diffLines,
  formatDuration,
  formatTokens,
  shortenPath,
  summarizeToolInput,
  summarizeToolResult,
  toDecision,
  truncateForDisplay,
} from "./frontend.ts";
import type { DiffSegment, Frontend } from "./frontend.ts";
import {
  SPINNER_INTERVAL_MS,
  colorForTool,
  glyph,
  palette,
  spinnerFrame,
  statusColor,
} from "./theme.ts";

/** Construction-time options. All optional so the smoke test can `new` it bare. */
export interface TuiFrontendOptions {
  /** Project path shown in the header. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Provider/model label shown in the header, e.g. "anthropic · sonnet". */
  providerLabel?: string;
  /** Scoped logger; defaults to a no-op so construction never needs a sink. */
  log?: Logger;
}

/** A live tool card: its box, the accent-colored title line, body, and status. */
interface ToolCard {
  box: BoxRenderable;
  /** The body text (diff, streamed bash output, or a result tail). */
  body: TextRenderable;
  /** Whether `body` is currently attached to `box` (mounted eagerly or lazily). */
  bodyMounted: boolean;
  /** The status/result line; carries the spinner while in flight. */
  status: TextRenderable;
  /** Tool name, used to pick the spinner accent and decide on streaming. */
  name: string;
  /** Accumulated live output for tools that stream (bash); null otherwise. */
  liveOutput: string | null;
  /** True until tool.result lands — drives the animated spinner. */
  running: boolean;
}

/** The three approval choices surfaced in the Select widget. */
const APPROVAL_OPTIONS: SelectOption[] = [
  { name: "Allow once", description: "Run this one call", value: "once" },
  { name: "Allow for session", description: "Auto-allow this tool the rest of the session", value: "session" },
  { name: "Deny", description: "Reject this call", value: "deny" },
];

/** Max characters of streamed bash output to keep mounted in a card body. */
const LIVE_OUTPUT_TAIL = 4000;

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
  private welcome: BoxRenderable | undefined;
  private statusBar: BoxRenderable | undefined;
  private statusText: TextRenderable | undefined;
  private approvalBar: BoxRenderable | undefined;
  private approvalLabel: TextRenderable | undefined;
  private select: SelectRenderable | undefined;
  private input: InputRenderable | undefined;
  private footerText: TextRenderable | undefined;

  /**
   * Markdown rendering stack, built lazily in mount() and only if it initializes
   * cleanly. When `markdown` is null we fall back to styled TextRenderables for
   * assistant blocks — the TUI still works, just without rich markdown.
   */
  private markdown: {
    syntaxStyle: SyntaxStyleType;
    treeSitterClient: TreeSitterClient | null;
  } | null = null;

  /** The live assistant block (markdown or text) currently receiving deltas. */
  private liveAssistant: AssistantBlock | null = null;
  /** Accumulated text for the live assistant block. */
  private liveAssistantText = "";

  /** Tool cards keyed by tool-call id, so tool.result can update the right card. */
  private readonly toolCards = new Map<string, ToolCard>();
  /** The id of the most-recently-started, still-running tool (emit target). */
  private activeToolId: string | undefined;

  /** The current turn's abort controller (set on submit, cleared on turn.done). */
  private activeAbort: AbortController | undefined;
  /** The id of the in-flight approval request; non-null only while the bar is up. */
  private pendingApprovalId: string | undefined;

  /** Idle Ctrl-C disarm flag: a second consecutive Ctrl-C at idle exits. */
  private ctrlCArmed = false;
  private disposed = false;

  // ── Live status state (drives the status bar) ──────────────────────────────
  /** Spinner animation timer; ticks every SPINNER_INTERVAL_MS while a turn runs. */
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  /** Spinner frame counter. */
  private spinnerTick = 0;
  /** Wall-clock ms at turn start, for the elapsed readout. Null when idle. */
  private turnStartedAt: number | null = null;
  /** Human label of what the turn is doing right now ("thinking", "read", …). */
  private statusVerb = "thinking";
  /** Latest cumulative usage from turn.done, shown in the header. */
  private usage: Usage = { inputTokens: 0, outputTokens: 0 };

  constructor(opts: TuiFrontendOptions = {}) {
    this.cwd = opts.cwd ?? process.cwd();
    this.providerLabel = opts.providerLabel ?? "";
    this.log = (opts.log ?? nullLogger()).child("tui");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Mount / teardown
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Build the renderer and the region tree once. Everything that touches a real
   * TTY lives here, so constructing the class is side-effect-free.
   */
  async mount(): Promise<void> {
    if (this.renderer) return; // idempotent
    // We own Ctrl-C ourselves (turn-abort vs. exit), so disable the renderer's
    // built-in exit-on-Ctrl-C and route the key through our handler instead.
    const renderer = await createCliRenderer({
      exitOnCtrlC: false,
      backgroundColor: palette.bg,
    });
    this.renderer = renderer;

    const root = new BoxRenderable(renderer, {
      flexDirection: "column",
      flexGrow: 1,
      backgroundColor: palette.bg,
    });

    root.add(this.buildHeader(renderer));
    root.add(this.buildScrollback(renderer));
    root.add(this.buildStatusBar(renderer));
    root.add(this.buildApprovalBar(renderer));
    root.add(this.buildInput(renderer));
    root.add(this.buildFooter(renderer));
    renderer.root.add(root);

    this.initMarkdown();

    this.wireInput();
    this.wireSelect();
    this.wireKeys();

    this.input?.focus();
    this.refreshHeader();
    renderer.start();
    this.log.info("tui mounted");
  }

  /** Tear down the renderer and restore the terminal. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stopSpinner();
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
  // Region construction (mount-time only)
  // ───────────────────────────────────────────────────────────────────────────

  private buildHeader(renderer: CliRenderer): BoxRenderable {
    const header = new BoxRenderable(renderer, {
      height: 1,
      flexShrink: 0,
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: palette.surface,
    });
    this.headerText = new TextRenderable(renderer, { content: "" });
    header.add(this.headerText);
    return header;
  }

  private buildScrollback(renderer: CliRenderer): ScrollBoxRenderable {
    const scrollback = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      scrollY: true,
      stickyScroll: true,
      stickyStart: "bottom",
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 2,
      paddingRight: 2,
      backgroundColor: palette.bg,
    });
    this.scrollback = scrollback;
    // Welcome card — removed on the first appended block.
    this.welcome = this.buildWelcome(renderer);
    scrollback.content.add(this.welcome);
    return scrollback;
  }

  private buildWelcome(renderer: CliRenderer): BoxRenderable {
    const box = new BoxRenderable(renderer, {
      flexDirection: "column",
      border: true,
      borderColor: palette.border,
      borderStyle: "rounded",
      title: " om-cli ",
      titleAlignment: "left",
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 2,
      paddingRight: 2,
      backgroundColor: palette.surface,
    });
    const heading = new TextRenderable(renderer, {
      content: t`${fg(palette.purple)(bold(`${glyph.assistant} a terminal-native agentic coding harness`))}`,
    });
    const tips = new TextRenderable(renderer, {
      content: t`${dim(
        "Ask a question or describe a task. om can read, edit, and run code —\n" +
          "you approve anything that writes to disk or runs a command.",
      )}`,
    });
    const provider = this.providerLabel
      ? new TextRenderable(renderer, {
          content: t`${dim(`${glyph.dot} `)}${fg(palette.blue)(this.providerLabel)}`,
        })
      : undefined;
    box.add(heading);
    box.add(new TextRenderable(renderer, { content: "" }));
    box.add(tips);
    if (provider) {
      box.add(new TextRenderable(renderer, { content: "" }));
      box.add(provider);
    }
    return box;
  }

  private buildStatusBar(renderer: CliRenderer): BoxRenderable {
    const bar = new BoxRenderable(renderer, {
      visible: false,
      height: 1,
      flexShrink: 0,
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: palette.surface,
    });
    this.statusBar = bar;
    this.statusText = new TextRenderable(renderer, { content: "" });
    bar.add(this.statusText);
    return bar;
  }

  private buildApprovalBar(renderer: CliRenderer): BoxRenderable {
    const bar = new BoxRenderable(renderer, {
      visible: false,
      flexShrink: 0,
      border: true,
      borderStyle: "rounded",
      borderColor: palette.orange,
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: palette.surfaceAlt,
    });
    this.approvalBar = bar;
    this.approvalLabel = new TextRenderable(renderer, { content: "" });
    this.select = new SelectRenderable(renderer, {
      options: APPROVAL_OPTIONS,
      showDescription: true,
      wrapSelection: true,
      backgroundColor: palette.surfaceAlt,
      textColor: palette.fg,
      descriptionColor: palette.muted,
      focusedBackgroundColor: palette.surfaceAlt,
      selectedBackgroundColor: palette.orange,
      selectedTextColor: palette.bg,
      selectedDescriptionColor: palette.bg,
    });
    bar.add(this.approvalLabel);
    bar.add(this.select);
    return bar;
  }

  private buildInput(renderer: CliRenderer): BoxRenderable {
    const wrap = new BoxRenderable(renderer, {
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: palette.bg,
    });
    const marker = new TextRenderable(renderer, {
      content: t`${fg(palette.green)(bold(glyph.user))} `,
    });
    this.input = new InputRenderable(renderer, {
      placeholder: "Ask om-cli…  (Enter to send)",
      flexGrow: 1,
      backgroundColor: palette.bg,
      textColor: palette.fg,
      placeholderColor: palette.faint,
    });
    wrap.add(marker);
    wrap.add(this.input);
    return wrap;
  }

  private buildFooter(renderer: CliRenderer): BoxRenderable {
    const footer = new BoxRenderable(renderer, {
      height: 1,
      flexShrink: 0,
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: palette.bg,
    });
    this.footerText = new TextRenderable(renderer, { content: this.footerContent() });
    footer.add(this.footerText);
    return footer;
  }

  /**
   * Build the markdown stack lazily. `SyntaxStyle.create()` and the
   * `MarkdownRenderable` constructor touch the native lib, so we guard the whole
   * thing — if anything throws, we leave `this.markdown` null and fall back to
   * styled text. Tree-sitter (code highlighting) is initialized fire-and-forget
   * because its worker may be unavailable in a plain run; markdown still renders
   * without it.
   */
  private initMarkdown(): void {
    try {
      // SyntaxStyle.create() touches the native lib; guard the whole stack so a
      // failure degrades to styled text rather than taking down the TUI.
      const syntaxStyle = SyntaxStyle.create();
      this.markdown = { syntaxStyle, treeSitterClient: null };
      this.log.info("markdown rendering enabled");

      // Tree-sitter (code-block highlighting) is optional and its worker may be
      // unavailable in a plain run (e.g. the `web-tree-sitter` peer isn't
      // present). Initialize fire-and-forget and attach the client only on
      // success; markdown still renders (just unhighlighted code) without it.
      //
      // Crucially, the client is an EventEmitter that emits "error"/"worker:log"
      // — an unhandled "error" event would *throw*, and any worker log written
      // to stderr could corrupt the alt-screen. So we sink all of its diagnostic
      // events into our logger (stderr/file) and swallow them here.
      try {
        const client = getTreeSitterClient();
        const sink = (kind: string) => (msg: unknown): void =>
          this.log.debug(`tree-sitter ${kind}`, { message: String(msg) });
        client.on("error", sink("error"));
        client.on("warning", sink("warning"));
        client.on("worker:log", (_type: unknown, message: unknown) =>
          this.log.debug("tree-sitter worker", { message: String(message) }),
        );
        void client
          .initialize()
          .then(() => {
            if (this.markdown) this.markdown.treeSitterClient = client;
            this.log.debug("tree-sitter ready; code blocks will highlight");
          })
          .catch((err: unknown) => {
            this.log.debug("tree-sitter unavailable; code blocks unstyled", {
              error: err instanceof Error ? err.message : String(err),
            });
          });
      } catch (err) {
        this.log.debug("tree-sitter client construction failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      this.markdown = null;
      this.log.warn("markdown unavailable; falling back to styled text", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Render: one turn's events to completion
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Render one turn's events to completion. Each event maps to an in-place
   * mutation of the region tree (spec §05). Safe to call before mount(): the UI
   * mutations no-op, but the stream is still fully drained so the driver loop in
   * main.ts never deadlocks.
   */
  async render(events: AsyncIterable<AgentEvent>): Promise<void> {
    this.beginTurn();
    try {
      for await (const ev of events) {
        switch (ev.type) {
          case "text.delta":
            this.statusVerb = "thinking";
            this.appendAssistantDelta(ev.text);
            break;
          case "text.done":
            this.sealAssistant();
            break;
          case "tool.start":
            this.statusVerb = ev.name;
            this.startToolCard(ev.id, ev.name, ev.input);
            break;
          case "tool.result":
            this.finishToolCard(ev.id, ev.output);
            break;
          case "approval.request":
            this.showApproval(ev.id, ev.tool, ev.preview);
            break;
          case "turn.done":
            this.usage = ev.usage;
            this.refreshHeader();
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
      this.endTurn();
      this.activeAbort = undefined;
      this.refocusInput();
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Live output routing (ctx.emit → active tool card)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Route an incremental tool-output chunk (e.g. live bash stdout, fed from
   * `ctx.emit` in main.ts) into the active tool card's body. This is what keeps
   * live output *inside the alt-screen* instead of corrupting it via stdout. A
   * no-op if there is no active streaming card.
   */
  emitToolOutput(chunk: string): void {
    const id = this.activeToolId;
    if (id === undefined) return;
    const card = this.toolCards.get(id);
    if (!card || !card.running) return;
    card.liveOutput = (card.liveOutput ?? "") + chunk;
    if (card.liveOutput.length > LIVE_OUTPUT_TAIL) {
      card.liveOutput = "…" + card.liveOutput.slice(card.liveOutput.length - LIVE_OUTPUT_TAIL);
    }
    card.body.content = t`${dim(card.liveOutput)}`;
    this.scrollback?.scrollTo({ x: 0, y: Number.MAX_SAFE_INTEGER });
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
        // Ctrl-C while parked on an approval: abort the active turn and deny the
        // prompt, so the blocked gate unblocks and the loop unwinds cleanly
        // rather than leaving the user stuck choosing y/a/n (spec §08).
        if (ev.ctrl && ev.name === "c") {
          this.log.info("ctrl-c: aborting turn (approval pending)");
          this.activeAbort?.abort();
          return this.resolveApproval(toDecision("deny"));
        }
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
        this.flashFooter(t`${fg(palette.orange)("press Ctrl-C again to exit")}`);
        return;
      }

      // 3. Ctrl-D on an empty input: exit.
      if (ev.ctrl && ev.name === "d" && (!this.input || this.input.value.length === 0)) {
        void this.exit();
        return;
      }

      // Any other key disarms the idle Ctrl-C exit latch.
      if (this.ctrlCArmed) {
        this.ctrlCArmed = false;
        this.resetFooter();
      }
    });
  }

  /** Dispose then exit the process. Mirrors the spec's Ctrl-D/Ctrl-C behavior. */
  private async exit(): Promise<void> {
    await this.dispose();
    process.exit(0);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Turn lifecycle + status bar
  // ───────────────────────────────────────────────────────────────────────────

  /** Start-of-turn: show the status bar, start the spinner, blur the input. */
  private beginTurn(): void {
    this.blurInput();
    this.turnStartedAt = this.now();
    this.statusVerb = "thinking";
    if (this.statusBar) this.statusBar.visible = true;
    this.startSpinner();
    this.refreshStatus();
  }

  /** End-of-turn: hide the status bar, stop the spinner. */
  private endTurn(): void {
    this.stopSpinner();
    this.turnStartedAt = null;
    if (this.statusBar) this.statusBar.visible = false;
  }

  /** Begin the spinner animation loop (idempotent). Drives status + tool cards. */
  private startSpinner(): void {
    if (this.spinnerTimer) return;
    this.spinnerTimer = setInterval(() => {
      this.spinnerTick++;
      this.refreshStatus();
      this.tickToolCards();
    }, SPINNER_INTERVAL_MS);
  }

  /** Stop the spinner animation loop (idempotent). */
  private stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
  }

  /** Re-render the live status bar (spinner · verb · elapsed · usage). */
  private refreshStatus(): void {
    const statusText = this.statusText;
    if (!statusText || this.turnStartedAt === null) return;
    const spin = spinnerFrame(this.spinnerTick);
    const elapsed = formatDuration(this.now() - this.turnStartedAt);
    const verb = this.statusVerb === "thinking" ? "thinking" : `running ${this.statusVerb}`;
    statusText.content = t`${fg(palette.yellow)(spin)} ${fg(palette.fg)(verb)}${dim("…")}  ${dim(
      `${glyph.dot} ${elapsed}`,
    )}  ${dim(`${glyph.dot} ${this.usageSummary()}`)}  ${dim(`${glyph.dot} esc/Ctrl-C to interrupt`)}`;
  }

  /** Advance the spinner on every in-flight tool card's status line. */
  private tickToolCards(): void {
    if (this.toolCards.size === 0) return;
    const spin = spinnerFrame(this.spinnerTick);
    for (const card of this.toolCards.values()) {
      if (!card.running) continue;
      card.status.content = t`${fg(palette.yellow)(spin)} ${dim("running…")}`;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Event → render mutations: assistant text (markdown)
  // ───────────────────────────────────────────────────────────────────────────

  /** Append a streamed assistant delta, creating the live block lazily. */
  private appendAssistantDelta(text: string): void {
    const scrollback = this.scrollback;
    const renderer = this.renderer;
    if (!scrollback || !renderer) return;
    this.clearWelcome();
    if (!this.liveAssistant) {
      this.liveAssistantText = "";
      this.liveAssistant = this.createAssistantBlock(renderer);
      scrollback.content.add(this.liveAssistant);
    }
    this.liveAssistantText += text;
    this.setAssistantContent(this.liveAssistant, this.liveAssistantText);
  }

  /**
   * Create the renderable for an assistant block — a streaming
   * `MarkdownRenderable` when the markdown stack is available, else a styled
   * `TextRenderable` wrapped to flow as one block.
   */
  private createAssistantBlock(renderer: CliRenderer): AssistantBlock {
    if (this.markdown) {
      try {
        return new MarkdownRenderable(renderer, {
          content: "",
          streaming: true,
          syntaxStyle: this.markdown.syntaxStyle,
          ...(this.markdown.treeSitterClient
            ? { treeSitterClient: this.markdown.treeSitterClient }
            : {}),
          fg: palette.fg,
          marginBottom: 1,
        });
      } catch (err) {
        this.log.warn("markdown block creation failed; using text", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return new TextRenderable(renderer, { content: "", fg: palette.fg, marginBottom: 1 });
  }

  /** Push accumulated text into an assistant block (markdown or plain text). */
  private setAssistantContent(block: AssistantBlock, text: string): void {
    // Both MarkdownRenderable and TextRenderable expose a `content` setter; the
    // markdown one re-parses incrementally because we created it with streaming.
    block.content = text;
  }

  /**
   * Seal the live assistant block so the next text run starts fresh. For a
   * streaming markdown block, flip `streaming` off to finalize trailing tokens.
   */
  private sealAssistant(): void {
    const block = this.liveAssistant;
    if (block instanceof MarkdownRenderable) {
      try {
        block.streaming = false;
      } catch {
        /* finalize is best-effort */
      }
    }
    this.liveAssistant = null;
    this.liveAssistantText = "";
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Event → render mutations: user line, tool cards, errors
  // ───────────────────────────────────────────────────────────────────────────

  /** Append the user's submitted line as its own block in the scrollback. */
  private appendUserLine(text: string): void {
    const scrollback = this.scrollback;
    const renderer = this.renderer;
    if (!scrollback || !renderer) return;
    this.clearWelcome();
    this.sealAssistant(); // keep ordering chronological
    const line = new TextRenderable(renderer, {
      content: t`${fg(palette.blue)(bold(`${glyph.user} `))}${fg(palette.fg)(text)}`,
      marginTop: 1,
      marginBottom: 1,
    });
    scrollback.content.add(line);
  }

  /** Create a tool card on tool.start and register it under its call id. */
  private startToolCard(id: string, name: string, input: unknown): void {
    const scrollback = this.scrollback;
    const renderer = this.renderer;
    if (!scrollback || !renderer) return;
    this.clearWelcome();
    this.sealAssistant(); // a tool starting closes the current assistant text run

    const accent = colorForTool(name);
    const box = new BoxRenderable(renderer, {
      border: true,
      borderStyle: "rounded",
      borderColor: palette.border,
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
      marginBottom: 1,
      backgroundColor: palette.surface,
    });
    // Title line: a colored glyph + tool name + summarized args.
    const title = new TextRenderable(renderer, {
      content: t`${fg(accent)(bold(`${glyph.tool} ${name}`))}  ${fg(palette.muted)(
        summarizeToolInput(name, input, this.cwd),
      )}`,
    });
    box.add(title);

    // Body: a colorized diff up front for edit/write; for bash it starts empty
    // but is mounted now so live streamed output is visible as it arrives. Other
    // tools mount the body lazily in finishToolCard (a short result tail).
    const diff = this.diffForTool(name, input);
    const streams = name === "bash";
    const body = new TextRenderable(renderer, {
      content: diff ?? t`${dim(streams ? "…" : "")}`,
      marginTop: diff || streams ? 1 : 0,
    });
    const bodyMounted = Boolean(diff) || streams;
    if (bodyMounted) box.add(body);

    const status = new TextRenderable(renderer, {
      content: t`${fg(palette.yellow)(spinnerFrame(this.spinnerTick))} ${dim("running…")}`,
      marginTop: 1,
    });
    box.add(status);

    scrollback.content.add(box);
    this.toolCards.set(id, {
      box,
      body,
      bodyMounted,
      status,
      name,
      liveOutput: null,
      running: true,
    });
    this.activeToolId = id;
  }

  /** Build a colorized diff body for edit/write tool inputs, or null otherwise. */
  private diffForTool(name: string, input: unknown): StyledText | null {
    const r = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
    if (name === "edit") {
      const oldStr = typeof r.old_string === "string" ? r.old_string : "";
      const newStr = typeof r.new_string === "string" ? r.new_string : "";
      if (!oldStr && !newStr) return null;
      return this.renderDiff(diffLines(oldStr, newStr));
    }
    if (name === "write") {
      const content = typeof r.content === "string" ? r.content : "";
      if (!content) return null;
      // A fresh write has no "old" side; show the first lines as additions.
      const head = content.split("\n").slice(0, 12);
      const segs: DiffSegment[] = head.map((line) => ({ kind: "add", text: line }));
      if (content.split("\n").length > 12) segs.push({ kind: "context", text: "…" });
      return this.renderDiff(segs);
    }
    return null;
  }

  /** Map diff segments to a single StyledText with +/- gutters and colors. */
  private renderDiff(segments: DiffSegment[]): StyledText {
    const chunks: TextChunk[] = segments.map((seg) => {
      const line = truncateForDisplay(seg.text, 200);
      if (seg.kind === "add") return fg(palette.green)(`+ ${line}\n`);
      if (seg.kind === "remove") return fg(palette.red)(`- ${line}\n`);
      return dim(`  ${line}\n`);
    });
    return new StyledText(chunks);
  }

  /** Update the matching tool card on tool.result (ok/err status + result line). */
  private finishToolCard(id: string, output: ToolResult): void {
    const card = this.toolCards.get(id);
    if (!card) return;
    card.running = false;
    if (this.activeToolId === id) this.activeToolId = undefined;

    const ok = output.ok;
    const mark = ok ? glyph.ok : glyph.err;
    const color = ok ? statusColor.ok : statusColor.error;
    card.box.borderColor = ok ? palette.border : palette.red;
    card.status.content = t`${fg(color)(bold(mark))} ${fg(color)(summarizeToolResult(output))}`;

    // Show a short content tail in the body when the tool didn't stream live
    // output and isn't a diff tool (edit/write already show their diff). This
    // makes a grep/read/ls result visible inline without scrolling.
    const isDiffTool = card.name === "edit" || card.name === "write";
    if (card.liveOutput === null && ok && output.content.trim().length > 0 && !isDiffTool) {
      const allLines = output.content.split("\n");
      const preview = allLines.slice(0, 8).join("\n");
      const more = allLines.length > 8;
      card.body.content = t`${dim(preview + (more ? "\n…" : ""))}`;
      card.body.marginTop = 1;
      // Mount lazily if it wasn't mounted up front (only bash mounts eagerly).
      if (!card.bodyMounted) {
        card.box.insertBefore(card.body, card.status);
        card.bodyMounted = true;
      }
    }
  }

  /** Render a non-fatal/fatal error as a distinct line in the scrollback. */
  private appendError(message: string, fatal: boolean): void {
    const scrollback = this.scrollback;
    const renderer = this.renderer;
    if (!scrollback || !renderer) return;
    this.clearWelcome();
    this.sealAssistant();
    const tag = fatal ? "error (fatal)" : "error";
    const line = new TextRenderable(renderer, {
      content: t`${fg(palette.red)(bold(`${glyph.error} ${tag}`))} ${fg(palette.red)(
        truncateForDisplay(message),
      )}`,
      marginTop: 1,
      marginBottom: 1,
    });
    scrollback.content.add(line);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Approval bar
  // ───────────────────────────────────────────────────────────────────────────

  /** Show the approval bar, focus the Select, blur the input (spec §07). */
  private showApproval(id: string, tool: string, preview: string): void {
    this.pendingApprovalId = id;
    const accent = colorForTool(tool);
    if (this.approvalBar) {
      // Box titles are plain strings (no inline color); the accent comes from
      // the bar's orange border + the colored tool name in the label below.
      this.approvalBar.title = ` ${glyph.approval} approval required `;
      this.approvalBar.visible = true;
    }
    if (this.approvalLabel) {
      this.approvalLabel.content = t`${fg(accent)(bold(tool))}  ${fg(palette.fg)(
        truncateForDisplay(preview, 200),
      )}\n${dim(`${glyph.dot} y allow once   ${glyph.dot} a allow session   ${glyph.dot} n deny`)}`;
    }
    this.blurInput();
    this.select?.focus();
    // main.ts has the loop blocked in the gate's requestApproval promise;
    // resolveApproval routes our Decision back through onApproval to unblock it.
  }

  /**
   * Resolve the in-flight approval with a decision, route it back to the core,
   * then hide the bar. A no-op if no approval is pending so a stray y/a/n cannot
   * fire onApproval.
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

  // ───────────────────────────────────────────────────────────────────────────
  // Header / footer / focus helpers
  // ───────────────────────────────────────────────────────────────────────────

  private blurInput(): void {
    this.input?.blur();
  }

  private refocusInput(): void {
    // Don't steal focus from an open approval modal.
    if (this.pendingApprovalId !== undefined) return;
    this.input?.focus();
  }

  /** Remove the welcome card the first time real content is appended. */
  private clearWelcome(): void {
    const welcome = this.welcome;
    if (!welcome) return;
    this.welcome = undefined;
    try {
      this.scrollback?.content.remove(welcome.id);
    } catch {
      /* already detached */
    }
  }

  /** Re-render the header line (cwd · provider/model · usage). */
  private refreshHeader(): void {
    if (this.headerText) this.headerText.content = this.headerContent();
  }

  /** Compose the header StyledText. */
  private headerContent(): StyledText {
    const sep = dim(`  ${glyph.sep}  `);
    const home = fg(palette.purple)(bold("om-cli"));
    const cwd = fg(palette.muted)(shortenPath(this.cwd, undefined, 40));
    const provider = this.providerLabel ? fg(palette.blue)(this.providerLabel) : dim("no provider");
    const usage = dim(this.usageSummary());
    return t`${home}${sep}${cwd}${sep}${provider}${sep}${usage}`;
  }

  /** Compact running-usage string for the header / status bar. */
  private usageSummary(): string {
    const u = this.usage;
    const base = `${formatTokens(u.inputTokens)} in ${glyph.dot} ${formatTokens(u.outputTokens)} out`;
    const cache = u.cacheReadTokens ? ` ${glyph.dot} ${formatTokens(u.cacheReadTokens)} cached` : "";
    return `${base}${cache}`;
  }

  /** The steady-state footer hint line. */
  private footerContent(): StyledText {
    const key = fg(palette.muted);
    return t`${dim(`${glyph.user} `)}${key("Enter")}${dim(" send  ")}${key("Ctrl-C")}${dim(
      " interrupt/exit  ",
    )}${key("Ctrl-D")}${dim(" exit")}`;
  }

  /** Temporarily replace the footer (e.g. the Ctrl-C exit hint). */
  private flashFooter(content: StyledText): void {
    if (this.footerText) this.footerText.content = content;
  }

  /** Restore the steady-state footer. */
  private resetFooter(): void {
    if (this.footerText) this.footerText.content = this.footerContent();
  }

  /**
   * Monotonic-ish clock. We avoid argless `Date.now()` plumbing concerns by
   * using `performance.now()`, which is always available in Bun and is exactly
   * what an elapsed timer wants.
   */
  private now(): number {
    return performance.now();
  }
}
