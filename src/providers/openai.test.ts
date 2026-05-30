import { describe, expect, test } from "bun:test";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";

import {
  toResponsesInput,
  toResponsesTools,
  toUsage,
  buildResponsesRequest,
  ResponsesParser,
} from "./openai.ts";
import type { Message, ProviderEvent, ProviderRequest, ToolSpec } from "../core/types.ts";
import { ToolResult } from "../core/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers: synthetic SDK events. We only fill the fields the parser reads, and
// cast through unknown so we don't have to construct the full SDK shapes.
// ─────────────────────────────────────────────────────────────────────────────

function ev(e: Record<string, unknown>): ResponseStreamEvent {
  return e as unknown as ResponseStreamEvent;
}

function textDelta(delta: string, output_index = 0): ResponseStreamEvent {
  return ev({
    type: "response.output_text.delta",
    delta,
    output_index,
    content_index: 0,
    item_id: "msg_1",
    logprobs: [],
    sequence_number: 0,
  });
}

function fnAdded(output_index: number, call_id: string, name: string, item_id = "item_x"): ResponseStreamEvent {
  return ev({
    type: "response.output_item.added",
    output_index,
    sequence_number: 0,
    item: { type: "function_call", call_id, name, arguments: "", id: item_id },
  });
}

function fnArgsDelta(output_index: number, delta: string, item_id = "item_x"): ResponseStreamEvent {
  return ev({
    type: "response.function_call_arguments.delta",
    output_index,
    delta,
    item_id,
    sequence_number: 0,
  });
}

function fnArgsDone(output_index: number, args: string, name: string, item_id = "item_x"): ResponseStreamEvent {
  return ev({
    type: "response.function_call_arguments.done",
    output_index,
    arguments: args,
    name,
    item_id,
    sequence_number: 0,
  });
}

function fnItemDone(output_index: number, call_id: string, name: string, args: string): ResponseStreamEvent {
  return ev({
    type: "response.output_item.done",
    output_index,
    sequence_number: 0,
    item: { type: "function_call", call_id, name, arguments: args, id: "item_x" },
  });
}

function completed(
  opts: { inputTokens?: number; outputTokens?: number; reason?: string } = {},
): ResponseStreamEvent {
  return ev({
    type: "response.completed",
    sequence_number: 0,
    response: {
      usage: {
        input_tokens: opts.inputTokens ?? 0,
        output_tokens: opts.outputTokens ?? 0,
        total_tokens: (opts.inputTokens ?? 0) + (opts.outputTokens ?? 0),
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
      incomplete_details: opts.reason ? { reason: opts.reason } : null,
    },
  });
}

/** Drive the parser through a list of events, returning the full ProviderEvent stream. */
function run(events: ResponseStreamEvent[], aborted = false): ProviderEvent[] {
  const parser = new ResponsesParser();
  const out: ProviderEvent[] = [];
  for (const e of events) out.push(...parser.push(e));
  out.push(parser.finish(aborted));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// toResponsesInput
// ─────────────────────────────────────────────────────────────────────────────

describe("toResponsesInput", () => {
  test("maps assistant text to an assistant-role message item", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "hello there" }] },
    ];
    const items = toResponsesInput(messages);
    expect(items).toEqual([
      { role: "assistant", content: "hello there" },
    ] as unknown as typeof items);
  });

  test("maps user text to an input_text message item", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "fix the bug" }] },
    ];
    const items = toResponsesInput(messages);
    expect(items).toEqual([
      { role: "user", content: [{ type: "input_text", text: "fix the bug" }] },
    ] as unknown as typeof items);
  });

  test("maps tool_call to a function_call item with stringified arguments", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            call: { id: "call_42", name: "read", input: { path: "a.ts", limit: 10 } },
          },
        ],
      },
    ];
    const items = toResponsesInput(messages);
    expect(items).toEqual([
      {
        type: "function_call",
        call_id: "call_42",
        name: "read",
        arguments: JSON.stringify({ path: "a.ts", limit: 10 }),
      },
    ] as unknown as typeof items);
  });

  test("maps tool_result to a function_call_output keyed by callId", () => {
    const messages: Message[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            callId: "call_42",
            result: ToolResult.ok("file contents here"),
          },
        ],
      },
    ];
    const items = toResponsesInput(messages);
    expect(items).toEqual([
      { type: "function_call_output", call_id: "call_42", output: "file contents here" },
    ] as unknown as typeof items);
  });

  test("flattens an interleaved assistant turn (text + tool_call) into sibling items", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me read it" },
          { type: "tool_call", call: { id: "c1", name: "read", input: { path: "x" } } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", callId: "c1", result: ToolResult.error("nope") }],
      },
    ];
    const items = toResponsesInput(messages) as unknown as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ role: "assistant" });
    expect(items[1]).toMatchObject({ type: "function_call", call_id: "c1", name: "read" });
    expect(items[2]).toMatchObject({
      type: "function_call_output",
      call_id: "c1",
      output: "nope",
    });
  });

  test("serializes undefined/empty tool input as {}", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_call", call: { id: "c", name: "ls", input: undefined } }],
      },
    ];
    const items = toResponsesInput(messages) as unknown as Array<Record<string, unknown>>;
    expect(items[0]!.arguments).toBe("{}");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toResponsesTools
// ─────────────────────────────────────────────────────────────────────────────

describe("toResponsesTools", () => {
  test("wraps each spec in a flat function tool with parameters", () => {
    const specs: ToolSpec[] = [
      {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ];
    const tools = toResponsesTools(specs);
    expect(tools).toEqual([
      {
        type: "function",
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        strict: false,
      },
    ]);
  });

  test("maps an empty list to an empty list", () => {
    expect(toResponsesTools([])).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toUsage
// ─────────────────────────────────────────────────────────────────────────────

describe("toUsage", () => {
  test("extracts input/output tokens", () => {
    expect(
      toUsage({
        input_tokens: 120,
        output_tokens: 45,
        total_tokens: 165,
        input_tokens_details: { cached_tokens: 30 },
        output_tokens_details: { reasoning_tokens: 0 },
      } as never),
    ).toEqual({ inputTokens: 120, outputTokens: 45 });
  });

  test("returns zero usage for null/undefined", () => {
    expect(toUsage(null)).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(toUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildResponsesRequest
// ─────────────────────────────────────────────────────────────────────────────

describe("buildResponsesRequest", () => {
  test("sets instructions, store:false, stream:true and serializes input/tools", () => {
    const req: ProviderRequest = {
      system: "You are a helpful CLI.",
      model: "gpt-x",
      signal: new AbortController().signal,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [{ name: "ls", description: "list", parameters: { type: "object" } }],
    };
    const body = buildResponsesRequest(req);
    expect(body.model).toBe("gpt-x");
    expect(body.instructions).toBe("You are a helpful CLI.");
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.input).toHaveLength(1);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toMatchObject({ type: "function", name: "ls" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ResponsesParser
// ─────────────────────────────────────────────────────────────────────────────

describe("ResponsesParser", () => {
  test("plain text turn → text deltas then done{end}", () => {
    const out = run([
      textDelta("Hello"),
      textDelta(", world"),
      completed({ inputTokens: 10, outputTokens: 3 }),
    ]);
    expect(out).toEqual([
      { type: "text.delta", text: "Hello" },
      { type: "text.delta", text: ", world" },
      { type: "done", stopReason: "end", usage: { inputTokens: 10, outputTokens: 3 } },
    ]);
  });

  test("tool turn → accumulates args, emits tool_call on item.done, done{tool_use}", () => {
    const out = run([
      fnAdded(0, "call_1", "read"),
      fnArgsDelta(0, '{"path":'),
      fnArgsDelta(0, '"a.ts"}'),
      fnItemDone(0, "call_1", "read", '{"path":"a.ts"}'),
      completed({ inputTokens: 50, outputTokens: 12 }),
    ]);
    expect(out).toEqual([
      { type: "tool_call", call: { id: "call_1", name: "read", input: { path: "a.ts" } } },
      { type: "done", stopReason: "tool_use", usage: { inputTokens: 50, outputTokens: 12 } },
    ]);
  });

  test("emits exactly one tool_call when both arguments.done and item.done fire", () => {
    const out = run([
      fnAdded(0, "call_9", "write"),
      fnArgsDelta(0, '{"x":1}'),
      fnArgsDone(0, '{"x":1}', "write"),
      fnItemDone(0, "call_9", "write", '{"x":1}'),
      completed(),
    ]);
    const toolCalls = out.filter((e) => e.type === "tool_call");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toEqual({
      type: "tool_call",
      call: { id: "call_9", name: "write", input: { x: 1 } },
    });
  });

  test("emits tool_call via arguments.done path even without item.done", () => {
    const out = run([
      fnAdded(2, "call_a", "bash"),
      fnArgsDelta(2, '{"cmd":"ls"}'),
      fnArgsDone(2, '{"cmd":"ls"}', "bash"),
      completed(),
    ]);
    expect(out[0]).toEqual({
      type: "tool_call",
      call: { id: "call_a", name: "bash", input: { cmd: "ls" } },
    });
    expect(out.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use" });
  });

  test("interleaves text then a tool call across distinct output indices", () => {
    const out = run([
      textDelta("thinking", 0),
      fnAdded(1, "call_t", "grep"),
      fnArgsDelta(1, '{"q":"foo"}'),
      fnItemDone(1, "call_t", "grep", '{"q":"foo"}'),
      completed({ inputTokens: 7, outputTokens: 2 }),
    ]);
    expect(out[0]).toEqual({ type: "text.delta", text: "thinking" });
    expect(out[1]).toEqual({
      type: "tool_call",
      call: { id: "call_t", name: "grep", input: { q: "foo" } },
    });
    expect(out[2]).toMatchObject({ type: "done", stopReason: "tool_use" });
  });

  test("empty arguments parse to {}", () => {
    const out = run([
      fnAdded(0, "call_e", "noop"),
      fnItemDone(0, "call_e", "noop", ""),
      completed(),
    ]);
    expect(out[0]).toEqual({
      type: "tool_call",
      call: { id: "call_e", name: "noop", input: {} },
    });
  });

  test("max_output_tokens incomplete reason → done{max_tokens}", () => {
    const out = run([
      textDelta("partial"),
      completed({ inputTokens: 5, outputTokens: 4096, reason: "max_output_tokens" }),
    ]);
    expect(out.at(-1)).toEqual({
      type: "done",
      stopReason: "max_tokens",
      usage: { inputTokens: 5, outputTokens: 4096 },
    });
  });

  test("response.incomplete → done{max_tokens}", () => {
    const incomplete = ev({
      type: "response.incomplete",
      sequence_number: 0,
      response: {
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          total_tokens: 3,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
        incomplete_details: { reason: "max_output_tokens" },
      },
    });
    const out = run([textDelta("x"), incomplete]);
    expect(out.at(-1)).toEqual({
      type: "done",
      stopReason: "max_tokens",
      usage: { inputTokens: 1, outputTokens: 2 },
    });
  });

  test("abort during stream → done{interrupted} with last-known usage", () => {
    const parser = new ResponsesParser();
    const out: ProviderEvent[] = [];
    out.push(...parser.push(textDelta("half")));
    // simulate the stream throwing; the provider calls finish(true)
    out.push(parser.finish(true));
    expect(out).toEqual([
      { type: "text.delta", text: "half" },
      { type: "done", stopReason: "interrupted", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
  });

  test("synthesizes done{end} when stream ends without a completed event", () => {
    const out = run([textDelta("dangling")]);
    expect(out.at(-1)).toEqual({
      type: "done",
      stopReason: "end",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });

  test("ignores unrelated event types (reasoning/created/etc.)", () => {
    const out = run([
      ev({ type: "response.created", sequence_number: 0, response: {} }),
      ev({ type: "response.in_progress", sequence_number: 0, response: {} }),
      textDelta("ok"),
      ev({ type: "response.reasoning_text.delta", sequence_number: 0, delta: "hmm" }),
      completed({ outputTokens: 1 }),
    ]);
    expect(out).toEqual([
      { type: "text.delta", text: "ok" },
      { type: "done", stopReason: "end", usage: { inputTokens: 0, outputTokens: 1 } },
    ]);
  });

  test("throws on malformed tool-argument JSON", () => {
    const parser = new ResponsesParser();
    parser.push(fnAdded(0, "call_bad", "read"));
    parser.push(fnArgsDelta(0, "{not json"));
    expect(() => parser.push(fnItemDone(0, "call_bad", "read", "{not json"))).toThrow(
      /Failed to parse arguments for tool "read"/,
    );
  });

  test("throws on response.failed", () => {
    const parser = new ResponsesParser();
    const failed = ev({
      type: "response.failed",
      sequence_number: 0,
      response: { error: { message: "boom" }, usage: null },
    });
    expect(() => parser.push(failed)).toThrow(/boom/);
  });

  test("two distinct tool calls in one turn both emit", () => {
    const out = run([
      fnAdded(0, "c0", "read", "item_0"),
      fnArgsDelta(0, '{"p":1}', "item_0"),
      fnItemDone(0, "c0", "read", '{"p":1}'),
      fnAdded(1, "c1", "write", "item_1"),
      fnArgsDelta(1, '{"p":2}', "item_1"),
      fnItemDone(1, "c1", "write", '{"p":2}'),
      completed({ inputTokens: 9, outputTokens: 8 }),
    ]);
    const calls = out.filter((e) => e.type === "tool_call");
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => (c as Extract<ProviderEvent, { type: "tool_call" }>).call.id)).toEqual([
      "c0",
      "c1",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OpenAIProvider construction (no network)
// ─────────────────────────────────────────────────────────────────────────────

describe("OpenAIProvider", () => {
  test("constructs with id 'openai' and does not hit the network", async () => {
    const { OpenAIProvider } = await import("./openai.ts");
    const p = new OpenAIProvider("sk-test-not-real");
    expect(p.id).toBe("openai");
    expect(typeof p.stream).toBe("function");
  });
});
