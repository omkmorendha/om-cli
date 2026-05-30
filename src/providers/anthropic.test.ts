/**
 * Tests for the Anthropic provider adapter.
 *
 * These exercise the PURE serialize/parse functions against synthetic SDK-shaped
 * objects — no network, no API key. The class's stream() is covered via an
 * injected fake client that yields a hand-built event sequence.
 */

import { describe, expect, test } from "bun:test";

import type { Message, ProviderEvent, ProviderRequest, ToolSpec } from "../core/types.ts";
import { ToolResult } from "../core/types.ts";
import { nullLogger } from "../util/logger.ts";
import {
  AnthropicProvider,
  type AnthropicProviderOptions,
  type AnthropicStreamEventLike,
  buildAnthropicRequest,
  mapAnthropicStop,
  mapAnthropicUsage,
  parseAnthropicStream,
  toAnthropicMessages,
  toAnthropicTools,
} from "./anthropic.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const it of items) yield it;
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// toAnthropicMessages
// ─────────────────────────────────────────────────────────────────────────────

describe("toAnthropicMessages", () => {
  test("maps text blocks preserving role", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    expect(toAnthropicMessages(messages)).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]);
  });

  test("maps tool_call to a tool_use block under the assistant role", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me read" },
          { type: "tool_call", call: { id: "call_1", name: "read", input: { path: "/a" } } },
        ],
      },
    ];
    expect(toAnthropicMessages(messages)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me read" },
          { type: "tool_use", id: "call_1", name: "read", input: { path: "/a" } },
        ],
      },
    ]);
  });

  test("maps tool_result with is_error reflecting result.ok", () => {
    const messages: Message[] = [
      {
        role: "tool",
        content: [
          { type: "tool_result", callId: "call_1", result: ToolResult.ok("file contents") },
          { type: "tool_result", callId: "call_2", result: ToolResult.error("nope") },
        ],
      },
    ];
    expect(toAnthropicMessages(messages)).toEqual([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "file contents", is_error: false },
          { type: "tool_result", tool_use_id: "call_2", content: "nope", is_error: true },
        ],
      },
    ]);
  });

  test("groups tool_results into a single user message even across messages", () => {
    const messages: Message[] = [
      {
        role: "tool",
        content: [{ type: "tool_result", callId: "c1", result: ToolResult.ok("one") }],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", callId: "c2", result: ToolResult.ok("two") }],
      },
    ];
    const out = toAnthropicMessages(messages);
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe("user");
    expect(out[0]!.content).toHaveLength(2);
  });

  test("splits a mixed assistant/tool_result message so roles stay valid", () => {
    // A single canonical assistant message carrying a trailing tool_result must
    // not produce an assistant message with a tool_result block.
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_call", call: { id: "c1", name: "ls", input: {} } },
          { type: "tool_result", callId: "c1", result: ToolResult.ok("a\nb") },
        ],
      },
    ];
    const out = toAnthropicMessages(messages);
    expect(out).toEqual([
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "ls", input: {} }] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "c1", content: "a\nb", is_error: false }],
      },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toAnthropicTools
// ─────────────────────────────────────────────────────────────────────────────

describe("toAnthropicTools", () => {
  test("places parameters under input_schema", () => {
    const tools: ToolSpec[] = [
      {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    ];
    expect(toAnthropicTools(tools)).toEqual([
      {
        name: "read",
        description: "Read a file",
        input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    ]);
  });

  test("maps an empty list to an empty list", () => {
    expect(toAnthropicTools([])).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildAnthropicRequest
// ─────────────────────────────────────────────────────────────────────────────

describe("buildAnthropicRequest", () => {
  test("assembles model, system, max_tokens, messages and tools", () => {
    const req: ProviderRequest = {
      system: "you are helpful",
      model: "claude-x",
      messages: [{ role: "user", content: [{ type: "text", text: "hey" }] }],
      tools: [{ name: "t", description: "d", parameters: { type: "object" } }],
      signal: new AbortController().signal,
    };
    const body = buildAnthropicRequest(req);
    expect(body.model).toBe("claude-x");
    expect(body.system).toBe("you are helpful");
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hey" }] }]);
    expect(body.tools).toEqual([{ name: "t", description: "d", input_schema: { type: "object" } }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mapAnthropicStop / mapAnthropicUsage
// ─────────────────────────────────────────────────────────────────────────────

describe("mapAnthropicStop", () => {
  test("maps known reasons", () => {
    expect(mapAnthropicStop("tool_use")).toBe("tool_use");
    expect(mapAnthropicStop("max_tokens")).toBe("max_tokens");
    expect(mapAnthropicStop("end_turn")).toBe("end");
  });

  test("collapses stop_sequence/null/unknown to end (no stop_seq in canonical type)", () => {
    expect(mapAnthropicStop("stop_sequence")).toBe("end");
    expect(mapAnthropicStop(null)).toBe("end");
    expect(mapAnthropicStop("something_new")).toBe("end");
  });
});

describe("mapAnthropicUsage", () => {
  test("merges present fields and preserves prior values when absent", () => {
    const seeded = mapAnthropicUsage({ inputTokens: 0, outputTokens: 0 }, { input_tokens: 100 });
    expect(seeded).toEqual({ inputTokens: 100, outputTokens: 0 });

    // A later message_delta carries only output tokens; input must be preserved.
    const merged = mapAnthropicUsage(seeded, { output_tokens: 42 });
    expect(merged).toEqual({ inputTokens: 100, outputTokens: 42 });
  });

  test("null/undefined usage leaves prior unchanged", () => {
    const prev = { inputTokens: 7, outputTokens: 3 };
    expect(mapAnthropicUsage(prev, null)).toEqual(prev);
    expect(mapAnthropicUsage(prev, undefined)).toEqual(prev);
  });

  test("surfaces cache read/creation tokens when reported", () => {
    const out = mapAnthropicUsage(
      { inputTokens: 0, outputTokens: 0 },
      {
        input_tokens: 50,
        output_tokens: 10,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 64,
      },
    );
    expect(out).toEqual({
      inputTokens: 50,
      outputTokens: 10,
      cacheReadTokens: 200,
      cacheWriteTokens: 64,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseAnthropicStream
// ─────────────────────────────────────────────────────────────────────────────

describe("parseAnthropicStream", () => {
  test("accumulates text deltas and emits one done with mapped stop + usage", async () => {
    const events: AnthropicStreamEventLike[] = [
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ];
    const out = await collect(parseAnthropicStream(fromArray(events)));
    expect(out).toEqual([
      { type: "text.delta", text: "Hel" },
      { type: "text.delta", text: "lo" },
      { type: "done", stopReason: "end", usage: { inputTokens: 10, outputTokens: 5 } },
    ]);
  });

  test("emits exactly one tool_call after a chunked input_json stream", async () => {
    const events: AnthropicStreamEventLike[] = [
      { type: "message_start", message: { usage: { input_tokens: 20, output_tokens: 0 } } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "read" },
      },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"pa' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'th":"' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '/x.ts"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } },
      { type: "message_stop" },
    ];
    const out = await collect(parseAnthropicStream(fromArray(events)));

    const toolCalls = out.filter((e) => e.type === "tool_call");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toEqual({
      type: "tool_call",
      call: { id: "toolu_1", name: "read", input: { path: "/x.ts" } },
    });

    const done = out[out.length - 1];
    expect(done).toEqual({
      type: "done",
      stopReason: "tool_use",
      usage: { inputTokens: 20, outputTokens: 12 },
    });
  });

  test("interleaves text and a tool_use across distinct block indices", async () => {
    const events: AnthropicStreamEventLike[] = [
      { type: "message_start", message: { usage: { input_tokens: 5 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok " } },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "t2", name: "ls" },
      },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
      { type: "message_stop" },
    ];
    const out = await collect(parseAnthropicStream(fromArray(events)));
    expect(out).toEqual([
      { type: "text.delta", text: "ok " },
      { type: "tool_call", call: { id: "t2", name: "ls", input: {} } },
      { type: "done", stopReason: "tool_use", usage: { inputTokens: 5, outputTokens: 9 } },
    ]);
  });

  test("an empty-argument tool_use parses to {}", async () => {
    const events: AnthropicStreamEventLike[] = [
      { type: "message_start", message: { usage: { input_tokens: 1 } } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "t", name: "now" },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ];
    const out = await collect(parseAnthropicStream(fromArray(events)));
    expect(out[0]).toEqual({ type: "tool_call", call: { id: "t", name: "now", input: {} } });
  });

  test("emits a trailing done even when the stream ends without message_stop", async () => {
    const events: AnthropicStreamEventLike[] = [
      { type: "message_start", message: { usage: { input_tokens: 3 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    ];
    const out = await collect(parseAnthropicStream(fromArray(events)));
    expect(out).toEqual([
      { type: "text.delta", text: "hi" },
      { type: "done", stopReason: "end", usage: { inputTokens: 3, outputTokens: 0 } },
    ]);
  });

  test("throws on malformed tool-argument JSON (recoverable per §07)", async () => {
    const events: AnthropicStreamEventLike[] = [
      { type: "message_start", message: { usage: {} } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "t", name: "x" },
      },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{not json" } },
      { type: "content_block_stop", index: 0 },
    ];
    await expect(collect(parseAnthropicStream(fromArray(events)))).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AnthropicProvider.stream (with an injected fake client — no network)
// ─────────────────────────────────────────────────────────────────────────────

describe("AnthropicProvider.stream", () => {
  function fakeClient(events: AnthropicStreamEventLike[] | (() => AsyncIterable<unknown>)) {
    return {
      messages: {
        stream() {
          return typeof events === "function" ? events() : fromArray(events);
        },
      },
    } as unknown as NonNullable<AnthropicProviderOptions["client"]>;
  }

  function makeReq(): ProviderRequest {
    return {
      system: "sys",
      model: "claude-test",
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      tools: [],
      signal: new AbortController().signal,
    };
  }

  test("pipes SDK events through the parser to canonical events", async () => {
    const events: AnthropicStreamEventLike[] = [
      { type: "message_start", message: { usage: { input_tokens: 4 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "yo" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    const provider = new AnthropicProvider("test-key", {
      log: nullLogger(),
      client: fakeClient(events),
    });
    expect(provider.id).toBe("anthropic");
    const out = await collect(provider.stream(makeReq()));
    expect(out).toEqual([
      { type: "text.delta", text: "yo" },
      { type: "done", stopReason: "end", usage: { inputTokens: 4, outputTokens: 1 } },
    ]);
  });

  test("treats an abort as a clean interrupted done, not a thrown error", async () => {
    const ac = new AbortController();
    // A generator that aborts then throws an AbortError mid-stream.
    async function* aborting(): AsyncIterable<AnthropicStreamEventLike> {
      yield { type: "message_start", message: { usage: { input_tokens: 2 } } };
      ac.abort();
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    const provider = new AnthropicProvider("test-key", {
      log: nullLogger(),
      client: fakeClient(aborting),
    });
    const req: ProviderRequest = { ...makeReq(), signal: ac.signal };
    const out = await collect(provider.stream(req));
    const done = out[out.length - 1];
    expect(done?.type).toBe("done");
    expect((done as { stopReason: string }).stopReason).toBe("interrupted");
  });

  test("rethrows non-abort errors for the loop to classify", async () => {
    async function* boom(): AsyncIterable<AnthropicStreamEventLike> {
      yield { type: "message_start", message: { usage: {} } };
      throw new Error("401 unauthorized");
    }
    const provider = new AnthropicProvider("test-key", {
      log: nullLogger(),
      client: fakeClient(boom),
    });
    await expect(collect(provider.stream(makeReq()))).rejects.toThrow("401 unauthorized");
  });
});
