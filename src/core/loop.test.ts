/**
 * Tests for the agent loop (src/core/loop.ts).
 *
 * Everything is hermetic: a FAKE provider yields a scripted ProviderEvent
 * sequence (one script per provider round-trip), a small concrete registry
 * holds a trivial fake tool, and a real PermissionGate is driven by an injected
 * `requestApproval`. No network, no API keys, no disk (transcripts disabled).
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { runTurn, type ToolRegistry } from "./loop.ts";
import { Session } from "./session.ts";
import type {
  AgentEvent,
  Provider,
  ProviderEvent,
  ProviderRequest,
  Tool,
  ToolCall,
  ToolContext,
  ToolResult,
  ToolSpec,
} from "./types.ts";
import { ToolResult as ToolResultHelpers } from "./types.ts";
import { PermissionGate } from "../permission/gate.ts";
import { nullLogger } from "../util/logger.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A provider that replays a list of scripted rounds. Each round is one
 * ProviderEvent[] consumed by one `stream()` call, in order. Records how many
 * times it was streamed and the requests it received.
 */
class FakeProvider implements Provider {
  readonly id = "anthropic" as const;
  streamCount = 0;
  readonly requests: ProviderRequest[] = [];

  constructor(private readonly rounds: ProviderEvent[][]) {}

  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(req);
    const round = this.rounds[this.streamCount] ?? [];
    this.streamCount += 1;
    for (const ev of round) {
      yield ev;
    }
  }
}

/** A trivial tool that echoes its input message. Permission class is tunable. */
function makeFakeTool(opts: {
  name?: string;
  permission?: "read" | "write" | "exec";
  onRun?: (ctx: ToolContext) => void;
} = {}): Tool<{ msg: string }> {
  const schema = z.object({ msg: z.string() });
  return {
    name: opts.name ?? "echo",
    description: "Echo the given message back.",
    schema,
    permission: opts.permission ?? "read",
    preview(input) {
      return `echo ${input.msg}`;
    },
    async run(input, ctx): Promise<ToolResult> {
      opts.onRun?.(ctx);
      return ToolResultHelpers.ok(`echoed: ${input.msg}`);
    },
  };
}

/** A minimal concrete ToolRegistry over a set of Tools. */
class FakeRegistry implements ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  runCount = 0;

  constructor(tools: Tool<any>[]) {
    for (const t of tools) this.tools.set(t.name, t as Tool);
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: z.toJSONSchema(t.schema) as Record<string, unknown>,
    }));
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  async run(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    this.runCount += 1;
    const tool = this.tools.get(call.name);
    if (!tool) return ToolResultHelpers.error(`unknown tool: ${call.name}`);
    const parsed = tool.schema.safeParse(call.input);
    if (!parsed.success) {
      return ToolResultHelpers.error(`invalid input for ${call.name}`);
    }
    try {
      return await tool.run(parsed.data, ctx);
    } catch (err) {
      return ToolResultHelpers.error(err instanceof Error ? err.message : String(err));
    }
  }
}

/** Build a gate whose approval prompt always returns the given response. */
function makeGate(response: "once" | "session" | "deny"): PermissionGate {
  return new PermissionGate({
    config: { autoAllow: ["read"], allowCommands: [] },
    allowlist: new Set<string>(),
    requestApproval: async () => response,
    log: nullLogger(),
  });
}

/** A throwaway ToolContext for the loop. */
function makeCtx(signal: AbortSignal): ToolContext {
  return {
    cwd: "/tmp",
    signal,
    log: nullLogger(),
    readSet: new Set<string>(),
  };
}

/** Drain an AgentEvent generator into an array. */
async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function newSession(): Session {
  // transcriptDir null -> touches no disk.
  return new Session({ systemPrompt: "sys", transcriptDir: null });
}

function tc(id: string, name: string, input: unknown): ToolCall {
  return { id, name, input };
}

// ─────────────────────────────────────────────────────────────────────────────
// (1) text-only turn
// ─────────────────────────────────────────────────────────────────────────────

describe("runTurn — text-only turn", () => {
  test("forwards deltas, emits text.done then turn.done; appends one assistant message", async () => {
    const provider = new FakeProvider([
      [
        { type: "text.delta", text: "Hello, " },
        { type: "text.delta", text: "world" },
        { type: "done", stopReason: "end", usage: { inputTokens: 10, outputTokens: 5 } },
      ],
    ]);
    const session = newSession();
    const registry = new FakeRegistry([makeFakeTool()]);
    const ctx = makeCtx(new AbortController().signal);

    const events = await collect(
      runTurn({
        session,
        provider,
        registry,
        gate: makeGate("once"),
        model: "test-model",
        signal: ctx.signal,
        ctx,
      }),
    );

    const types = events.map((e) => e.type);
    expect(types).toEqual(["text.delta", "text.delta", "text.done", "turn.done"]);

    const done = events.find((e) => e.type === "text.done");
    expect(done && done.type === "text.done" ? done.text : "").toBe("Hello, world");

    const turnDone = events.at(-1)!;
    expect(turnDone.type).toBe("turn.done");
    if (turnDone.type === "turn.done") {
      expect(turnDone.stopReason).toBe("end");
      expect(turnDone.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    }

    // Only the provider was streamed once (no follow-up round-trip).
    expect(provider.streamCount).toBe(1);

    // Session got exactly one assistant text message appended.
    expect(session.messages.length).toBe(1);
    const msg = session.messages[0]!;
    expect(msg.role).toBe("assistant");
    expect(msg.content).toEqual([{ type: "text", text: "Hello, world" }]);

    // Usage accumulated on the session.
    expect(session.usage).toEqual({ inputTokens: 10, outputTokens: 5 });

    // The request carried the system prompt, model, and tool specs.
    expect(provider.requests[0]!.system).toBe("sys");
    expect(provider.requests[0]!.model).toBe("test-model");
    expect(provider.requests[0]!.tools.map((t) => t.name)).toEqual(["echo"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) one tool call, then a second round that ends
// ─────────────────────────────────────────────────────────────────────────────

describe("runTurn — single tool call", () => {
  test("emits tool.start + tool.result, runs the tool, then a second round ends the turn", async () => {
    const call = tc("call-1", "echo", { msg: "hi" });
    let toolRan = false;
    const provider = new FakeProvider([
      // Round 1: model requests the tool.
      [
        { type: "tool_call", call },
        { type: "done", stopReason: "tool_use", usage: { inputTokens: 8, outputTokens: 4 } },
      ],
      // Round 2: model wraps up with text.
      [
        { type: "text.delta", text: "done" },
        { type: "done", stopReason: "end", usage: { inputTokens: 3, outputTokens: 2 } },
      ],
    ]);
    const session = newSession();
    const registry = new FakeRegistry([
      makeFakeTool({ onRun: () => { toolRan = true; } }),
    ]);
    const ctx = makeCtx(new AbortController().signal);

    const events = await collect(
      runTurn({
        session,
        provider,
        registry,
        gate: makeGate("once"),
        model: "m",
        signal: ctx.signal,
        ctx,
      }),
    );

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "tool.start",
      "tool.result",
      "text.delta",
      "text.done",
      "turn.done",
    ]);

    expect(toolRan).toBe(true);
    expect(registry.runCount).toBe(1);
    expect(provider.streamCount).toBe(2);

    const start = events.find((e) => e.type === "tool.start")!;
    if (start.type === "tool.start") {
      expect(start.id).toBe("call-1");
      expect(start.name).toBe("echo");
      expect(start.input).toEqual({ msg: "hi" });
    }

    const result = events.find((e) => e.type === "tool.result")!;
    if (result.type === "tool.result") {
      expect(result.id).toBe("call-1");
      expect(result.output.ok).toBe(true);
      expect(result.output.content).toBe("echoed: hi");
    }

    const turnDone = events.at(-1)!;
    expect(turnDone.type === "turn.done" && turnDone.stopReason).toBe("end");

    // Session: assistant(tool_call) -> user(tool_result) -> assistant(text).
    expect(session.messages.map((m) => m.role)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
    expect(session.messages[0]!.content).toEqual([{ type: "tool_call", call }]);
    const toolResultBlock = session.messages[1]!.content[0]!;
    expect(toolResultBlock.type).toBe("tool_result");
    if (toolResultBlock.type === "tool_result") {
      expect(toolResultBlock.callId).toBe("call-1");
      expect(toolResultBlock.result.content).toBe("echoed: hi");
    }
    expect(session.messages[2]!.content).toEqual([{ type: "text", text: "done" }]);

    // Usage from both round-trips accumulated.
    expect(session.usage).toEqual({ inputTokens: 11, outputTokens: 6 });
  });

  test("a turn with both text and a tool call appends text + tool_call blocks together", async () => {
    const call = tc("c", "echo", { msg: "x" });
    const provider = new FakeProvider([
      [
        { type: "text.delta", text: "let me " },
        { type: "text.delta", text: "check" },
        { type: "tool_call", call },
        { type: "done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
      ],
      [{ type: "done", stopReason: "end", usage: { inputTokens: 0, outputTokens: 0 } }],
    ]);
    const session = newSession();
    const registry = new FakeRegistry([makeFakeTool()]);
    const ctx = makeCtx(new AbortController().signal);

    await collect(
      runTurn({ session, provider, registry, gate: makeGate("once"), model: "m", signal: ctx.signal, ctx }),
    );

    // The assistant message interleaves the text block then the tool_call block.
    expect(session.messages[0]!.content).toEqual([
      { type: "text", text: "let me check" },
      { type: "tool_call", call },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) denied tool
// ─────────────────────────────────────────────────────────────────────────────

describe("runTurn — denied tool", () => {
  test("a denied write tool yields ok:false result and the tool never runs", async () => {
    const call = tc("d1", "save", { msg: "data" });
    let toolRan = false;
    const provider = new FakeProvider([
      [
        { type: "tool_call", call },
        { type: "done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
      ],
      [{ type: "done", stopReason: "end", usage: { inputTokens: 0, outputTokens: 0 } }],
    ]);
    const session = newSession();
    const registry = new FakeRegistry([
      // write-class tool so the gate prompts (autoAllow is read-only).
      makeFakeTool({ name: "save", permission: "write", onRun: () => { toolRan = true; } }),
    ]);
    const ctx = makeCtx(new AbortController().signal);

    const events = await collect(
      runTurn({
        session,
        provider,
        registry,
        gate: makeGate("deny"),
        model: "m",
        signal: ctx.signal,
        ctx,
      }),
    );

    expect(toolRan).toBe(false);
    expect(registry.runCount).toBe(0);

    const result = events.find((e) => e.type === "tool.result")!;
    expect(result.type).toBe("tool.result");
    if (result.type === "tool.result") {
      expect(result.output.ok).toBe(false);
      expect(result.output.error).toBe("denied by user");
      expect(result.output.meta?.denied).toBe(true);
    }

    // The denied result is still appended (invariant: every call gets a result).
    const toolResultBlock = session.messages[1]!.content[0]!;
    expect(toolResultBlock.type).toBe("tool_result");
    if (toolResultBlock.type === "tool_result") {
      expect(toolResultBlock.result.ok).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (4) abort -> interrupted
// ─────────────────────────────────────────────────────────────────────────────

describe("runTurn — abort", () => {
  test("an abort before the tool runs yields an interrupted result and turn.done interrupted", async () => {
    const call = tc("a1", "echo", { msg: "y" });
    const ac = new AbortController();
    let toolRan = false;
    const provider = new FakeProvider([
      [
        { type: "tool_call", call },
        { type: "done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
      ],
    ]);
    const session = newSession();
    const registry = new FakeRegistry([
      makeFakeTool({ onRun: () => { toolRan = true; } }),
    ]);
    const ctx = makeCtx(ac.signal);

    // Abort the moment the provider round-trip finishes, before tool dispatch.
    // We drain manually so we can flip the signal at the right point.
    const gen = runTurn({
      session,
      provider,
      registry,
      gate: makeGate("once"),
      model: "m",
      signal: ac.signal,
      ctx,
    });

    const events: AgentEvent[] = [];
    for await (const ev of gen) {
      events.push(ev);
      // After tool.start fires, simulate the user hitting Ctrl-C.
      if (ev.type === "tool.start") ac.abort();
    }

    expect(toolRan).toBe(false);
    expect(registry.runCount).toBe(0);

    const types = events.map((e) => e.type);
    expect(types).toEqual(["tool.start", "tool.result", "turn.done"]);

    const result = events.find((e) => e.type === "tool.result")!;
    if (result.type === "tool.result") {
      expect(result.output.ok).toBe(false);
      expect(result.output.error).toBe("interrupted");
      expect(result.output.meta?.interrupted).toBe(true);
    }

    const turnDone = events.at(-1)!;
    expect(turnDone.type === "turn.done" && turnDone.stopReason).toBe("interrupted");

    // The interrupted result is appended (invariant).
    const block = session.messages[1]!.content[0]!;
    expect(block.type).toBe("tool_result");
    if (block.type === "tool_result") {
      expect(block.result.meta?.interrupted).toBe(true);
    }

    // The provider was NOT streamed a second time after the abort.
    expect(provider.streamCount).toBe(1);
  });

  test("an abort partway through a multi-tool turn finalizes every remaining call", async () => {
    // The model requests three tools in one turn. We abort after the first
    // tool's result; the loop must still append interrupted results for the
    // two trailing calls so the assistant message's tool_call ids are all
    // answered (both provider APIs require a result per id).
    const c1 = tc("m1", "echo", { msg: "a" });
    const c2 = tc("m2", "echo", { msg: "b" });
    const c3 = tc("m3", "echo", { msg: "c" });
    const ac = new AbortController();
    const provider = new FakeProvider([
      [
        { type: "tool_call", call: c1 },
        { type: "tool_call", call: c2 },
        { type: "tool_call", call: c3 },
        { type: "done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
      ],
    ]);
    const session = newSession();
    const registry = new FakeRegistry([makeFakeTool()]);
    const ctx = makeCtx(ac.signal);

    const gen = runTurn({
      session,
      provider,
      registry,
      gate: makeGate("once"),
      model: "m",
      signal: ac.signal,
      ctx,
    });

    const events: AgentEvent[] = [];
    for await (const ev of gen) {
      events.push(ev);
      // Abort right after the first tool's result lands.
      if (ev.type === "tool.result" && ev.id === "m1") ac.abort();
    }

    // Every one of the three calls produced exactly one tool.result, and the
    // turn ended interrupted.
    const resultIds = events
      .filter((e) => e.type === "tool.result")
      .map((e) => (e.type === "tool.result" ? e.id : ""));
    expect(resultIds).toEqual(["m1", "m2", "m3"]);

    const turnDone = events.at(-1)!;
    expect(turnDone.type === "turn.done" && turnDone.stopReason).toBe("interrupted");

    // Session history: assistant(3 tool_calls) + one user tool_result per call.
    const toolResults = session.messages.filter(
      (m) => m.role === "user" && m.content[0]?.type === "tool_result",
    );
    expect(toolResults.length).toBe(3);
    // The two trailing results are interrupted; the first ran normally.
    const resultFor = (id: string) =>
      toolResults
        .map((m) => m.content[0])
        .find((b) => b?.type === "tool_result" && b.callId === id);
    const b2 = resultFor("m2");
    const b3 = resultFor("m3");
    expect(b2?.type === "tool_result" && b2.result.meta?.interrupted).toBe(true);
    expect(b3?.type === "tool_result" && b3.result.meta?.interrupted).toBe(true);

    // No second provider round-trip after the abort.
    expect(provider.streamCount).toBe(1);
  });

  test("an abort before the first provider round-trip ends immediately", async () => {
    const ac = new AbortController();
    ac.abort();
    const provider = new FakeProvider([
      [{ type: "done", stopReason: "end", usage: { inputTokens: 0, outputTokens: 0 } }],
    ]);
    const session = newSession();
    const registry = new FakeRegistry([makeFakeTool()]);
    const ctx = makeCtx(ac.signal);

    const events = await collect(
      runTurn({ session, provider, registry, gate: makeGate("once"), model: "m", signal: ac.signal, ctx }),
    );

    expect(events.map((e) => e.type)).toEqual(["turn.done"]);
    const turnDone = events[0]!;
    expect(turnDone.type === "turn.done" && turnDone.stopReason).toBe("interrupted");
    // Never streamed the provider.
    expect(provider.streamCount).toBe(0);
    expect(session.messages.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (5) maxIterations guard
// ─────────────────────────────────────────────────────────────────────────────

describe("runTurn — turn cap", () => {
  test("a model that loops on tool calls forever trips the cap with a non-fatal error", async () => {
    const call = tc("loop", "echo", { msg: "again" });
    // Every round requests the tool again -> would loop forever.
    const round: ProviderEvent[] = [
      { type: "tool_call", call },
      { type: "done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
    ];
    // Provide more rounds than the cap so the provider never runs dry first.
    const provider = new FakeProvider(Array.from({ length: 10 }, () => round.slice()));
    const session = newSession();
    const registry = new FakeRegistry([makeFakeTool()]);
    const ctx = makeCtx(new AbortController().signal);

    const events = await collect(
      runTurn({
        session,
        provider,
        registry,
        gate: makeGate("once"),
        model: "m",
        signal: ctx.signal,
        ctx,
        maxIterations: 3,
      }),
    );

    // The provider was streamed exactly maxIterations times.
    expect(provider.streamCount).toBe(3);

    // The last two events: a non-fatal error, then turn.done with stopReason error.
    const errorEv = events.find((e) => e.type === "error");
    expect(errorEv).toBeDefined();
    if (errorEv && errorEv.type === "error") {
      expect(errorEv.fatal).toBe(false);
      expect(errorEv.message).toContain("3");
    }

    const turnDone = events.at(-1)!;
    expect(turnDone.type).toBe("turn.done");
    if (turnDone.type === "turn.done") {
      expect(turnDone.stopReason).toBe("error");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (6) provider error
// ─────────────────────────────────────────────────────────────────────────────

describe("runTurn — provider error", () => {
  test("a provider that throws mid-stream yields a fatal error then turn.done", async () => {
    const throwingProvider: Provider = {
      id: "anthropic",
      async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: "text.delta", text: "partial" };
        throw new Error("connection reset");
      },
    };
    const session = newSession();
    const registry = new FakeRegistry([makeFakeTool()]);
    const ctx = makeCtx(new AbortController().signal);

    const events = await collect(
      runTurn({ session, provider: throwingProvider, registry, gate: makeGate("once"), model: "m", signal: ctx.signal, ctx }),
    );

    const types = events.map((e) => e.type);
    // The partial delta was forwarded before the throw.
    expect(types).toEqual(["text.delta", "error", "turn.done"]);

    const errorEv = events.find((e) => e.type === "error")!;
    if (errorEv.type === "error") {
      expect(errorEv.fatal).toBe(true);
      expect(errorEv.message).toBe("connection reset");
    }

    // No assistant message was appended for the failed round-trip.
    expect(session.messages.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (7) unknown tool
// ─────────────────────────────────────────────────────────────────────────────

describe("runTurn — unknown tool", () => {
  test("a call to a tool not in the registry yields an ok:false result and skips the gate", async () => {
    const call = tc("u1", "nonexistent", {});
    let gateCalled = false;
    const provider = new FakeProvider([
      [
        { type: "tool_call", call },
        { type: "done", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
      ],
      [{ type: "done", stopReason: "end", usage: { inputTokens: 0, outputTokens: 0 } }],
    ]);
    const session = newSession();
    const registry = new FakeRegistry([makeFakeTool()]);
    const ctx = makeCtx(new AbortController().signal);
    const gate = new PermissionGate({
      config: { autoAllow: ["read"], allowCommands: [] },
      allowlist: new Set<string>(),
      requestApproval: async () => { gateCalled = true; return "once"; },
      log: nullLogger(),
    });

    const events = await collect(
      runTurn({ session, provider, registry, gate, model: "m", signal: ctx.signal, ctx }),
    );

    expect(gateCalled).toBe(false);
    expect(registry.runCount).toBe(0);

    const result = events.find((e) => e.type === "tool.result")!;
    if (result.type === "tool.result") {
      expect(result.output.ok).toBe(false);
      expect(result.output.error).toContain("unknown tool");
    }
  });
});
