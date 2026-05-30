/**
 * Anthropic Messages API provider adapter.
 *
 * Spec: providers.html §03–§04 (request shaping + streaming parse), v0.html §6.
 *
 * This adapter is a pure translator (providers.html §01): it serializes a
 * canonical {@link ProviderRequest} into an Anthropic Messages request body and
 * parses the vendor's streaming event sequence back into the flat, vendor-neutral
 * {@link ProviderEvent} stream. It runs no tools, decides no permissions, and
 * persists nothing.
 *
 * The serialize/parse helpers are exported as pure functions so they can be
 * tested against synthetic SDK-shaped objects with no network access. Only
 * {@link AnthropicProvider.stream} touches the SDK.
 *
 * Conforms to src/core/types.ts: the canonical {@link Usage} carries
 * `inputTokens`/`outputTokens` plus optional cache token fields, and {@link StopReason} has no
 * `stop_seq`/`aborted` members — Anthropic's `stop_sequence` maps to `"end"`,
 * and a fired AbortSignal surfaces as `done{stopReason:"interrupted"}`.
 */

import Anthropic from "@anthropic-ai/sdk";

import type {
  Message,
  Provider,
  ProviderEvent,
  ProviderRequest,
  StopReason,
  ToolCall,
  ToolResult,
  ToolSpec,
  Usage,
} from "../core/types.ts";
import { zeroUsage } from "../core/types.ts";
import type { Logger } from "../util/logger.ts";
import { nullLogger } from "../util/logger.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Wire-shape aliases (kept local so the rest of the codebase never imports them)
// ─────────────────────────────────────────────────────────────────────────────

/** Anthropic message content block in *param* (request) position. */
type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error: boolean };

/** Anthropic message in request position. */
export interface AnthropicMessageParam {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

/** Anthropic tool descriptor (`input_schema` envelope around the JSON Schema). */
export interface AnthropicToolParam {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * The minimal structural subset of `@anthropic-ai/sdk`'s `RawMessageStreamEvent`
 * the parser actually reads. Declared structurally so {@link parseAnthropicStream}
 * can be exercised with hand-built objects in tests — the real SDK events are
 * structurally compatible supersets of these.
 */
export type AnthropicStreamEventLike =
  | { type: "message_start"; message: { usage?: AnthropicUsageLike | null } }
  | {
      type: "content_block_start";
      index: number;
      content_block:
        | { type: "tool_use"; id: string; name: string }
        | { type: string; [k: string]: unknown };
    }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "input_json_delta"; partial_json: string }
        | { type: string; [k: string]: unknown };
    }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason: string | null };
      usage?: AnthropicUsageLike | null;
    }
  | { type: "message_stop" };

/** Subset of Anthropic's `Usage` / `MessageDeltaUsage` the mapper reads. */
export interface AnthropicUsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialize (canonical → Anthropic)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render a {@link ToolResult} into the plain-string `content` Anthropic expects
 * on a `tool_result` block. The result is already truncated upstream (§7).
 */
function renderToolResult(result: ToolResult): string {
  return result.content;
}

/**
 * Map canonical messages to Anthropic `messages[]` (providers.html §04).
 *
 * Each canonical content block maps 1:1:
 *   - `text`        → `{ type: "text", text }`
 *   - `tool_call`   → `{ type: "tool_use", id, name, input }`
 *   - `tool_result` → `{ type: "tool_result", tool_use_id, content, is_error }`
 *
 * tool_result blocks must ride inside a *user* message (v0 §6 / providers.html
 * §04: "tool_result echo on the next turn"). The canonical store may attach a
 * result block to any message; we normalize by re-homing every emitted
 * tool_result into a user-role message and, where a single canonical message
 * mixes results with other content, splitting it so the role stays valid. We
 * also coalesce consecutive same-role messages so a run of tool_result blocks
 * collapses into one user message, matching Anthropic's preferred grouping.
 */
export function toAnthropicMessages(messages: Message[]): AnthropicMessageParam[] {
  const out: AnthropicMessageParam[] = [];

  const push = (role: "user" | "assistant", block: AnthropicContentBlock): void => {
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.content.push(block);
    } else {
      out.push({ role, content: [block] });
    }
  };

  for (const m of messages) {
    // The canonical Role includes "system" and "tool"; Anthropic has neither at
    // the message level (system is a top-level field; tool results are user
    // messages). Treat "tool" and "system" message roles as "user" carriers.
    const baseRole: "user" | "assistant" = m.role === "assistant" ? "assistant" : "user";

    for (const b of m.content) {
      switch (b.type) {
        case "text":
          push(baseRole, { type: "text", text: b.text });
          break;
        case "tool_call":
          // tool_use is always an assistant block regardless of the carrier role.
          push("assistant", {
            type: "tool_use",
            id: b.call.id,
            name: b.call.name,
            input: b.call.input,
          });
          break;
        case "tool_result":
          // tool_result is always a user block.
          push("user", {
            type: "tool_result",
            tool_use_id: b.callId,
            content: renderToolResult(b.result),
            is_error: !b.result.ok,
          });
          break;
      }
    }
  }

  return out;
}

/**
 * Map canonical {@link ToolSpec}s to Anthropic tool params. The JSON Schema
 * produced once by `z.toJSONSchema` goes straight under `input_schema`
 * (providers.html §04 / §06 — identical schema, different envelope key).
 */
export function toAnthropicTools(tools: ToolSpec[]): AnthropicToolParam[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

/** Default model-facing request knobs. */
const DEFAULT_MAX_TOKENS = 8192;

/** Build the full Anthropic streaming request body from a canonical request. */
export function buildAnthropicRequest(
  req: ProviderRequest,
): {
  model: string;
  max_tokens: number;
  system: string;
  messages: AnthropicMessageParam[];
  tools: AnthropicToolParam[];
} {
  return {
    model: req.model,
    max_tokens: DEFAULT_MAX_TOKENS,
    system: req.system,
    messages: toAnthropicMessages(req.messages),
    tools: toAnthropicTools(req.tools),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse (Anthropic stream → canonical ProviderEvent[])
// ─────────────────────────────────────────────────────────────────────────────

/** Normalize Anthropic usage into the canonical {@link Usage} (cache fields dropped). */
export function mapAnthropicUsage(
  prev: Usage,
  u: AnthropicUsageLike | null | undefined,
): Usage {
  if (!u) return prev;
  const cacheRead = u.cache_read_input_tokens ?? prev.cacheReadTokens;
  const cacheWrite = u.cache_creation_input_tokens ?? prev.cacheWriteTokens;
  return {
    inputTokens: u.input_tokens ?? prev.inputTokens,
    outputTokens: u.output_tokens ?? prev.outputTokens,
    ...(cacheRead != null ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite != null ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

/**
 * Map an Anthropic `stop_reason` to the canonical {@link StopReason}.
 *
 * types.ts has no `stop_seq` member, so `stop_sequence` collapses to `"end"`.
 * `null`/unknown also collapse to `"end"` (a normal turn end).
 */
export function mapAnthropicStop(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
    default:
      return "end";
  }
}

/**
 * Pure streaming parser: consume an async iterable of Anthropic-shaped stream
 * events and yield canonical {@link ProviderEvent}s.
 *
 * State machine (providers.html §04 "tool_use accumulation"):
 *   message_start            → seed usage (input + cache tokens)
 *   content_block_start      → if tool_use, open a pending accumulator at its index
 *   content_block_delta      → text_delta ⇒ emit text.delta; input_json_delta ⇒ buffer
 *   content_block_stop       → if a tool_use was open, JSON.parse the buffer and
 *                              emit exactly one tool_call (never on a partial)
 *   message_delta            → final stop_reason + cumulative output tokens
 *   message_stop             → stream end
 *
 * Exactly one terminal `done` is emitted last, carrying the merged usage and the
 * normalized stop reason (§03 invariant). If the upstream iterable ends without a
 * message_stop we still emit the trailing done — the loop treats a stream that
 * ends without an explicit stop as a normal `"end"`.
 *
 * A malformed tool-argument JSON throws at parse time (providers.html §07 error
 * taxonomy: recoverable — the loop can re-prompt). The caller is responsible for
 * catching aborts; this generator does not own the signal.
 */
export async function* parseAnthropicStream(
  events: AsyncIterable<AnthropicStreamEventLike>,
  onUsage?: (usage: Usage) => void,
): AsyncIterable<ProviderEvent> {
  const pending = new Map<number, { id: string; name: string; json: string }>();
  let usage: Usage = zeroUsage();
  let stopReason: StopReason = "end";

  for await (const ev of events) {
    switch (ev.type) {
      case "message_start": {
        usage = mapAnthropicUsage(usage, ev.message.usage);
        // Surface usage as soon as it arrives (input + cache tokens land on
        // message_start) so a caller that aborts mid-stream can still report
        // the tokens already counted instead of zeros (providers.html §07).
        onUsage?.(usage);
        break;
      }

      case "content_block_start": {
        const cb = ev.content_block;
        if (cb.type === "tool_use") {
          // The narrowed branch carries id + name (per AnthropicStreamEventLike).
          const tu = cb as { id: string; name: string };
          pending.set(ev.index, { id: tu.id, name: tu.name, json: "" });
        }
        break;
      }

      case "content_block_delta": {
        const d = ev.delta;
        if (d.type === "text_delta") {
          yield { type: "text.delta", text: (d as { text: string }).text };
        } else if (d.type === "input_json_delta") {
          const p = pending.get(ev.index);
          if (p) p.json += (d as { partial_json: string }).partial_json;
        }
        break;
      }

      case "content_block_stop": {
        const p = pending.get(ev.index);
        if (p) {
          const input: unknown = p.json ? JSON.parse(p.json) : {};
          const call: ToolCall = { id: p.id, name: p.name, input };
          yield { type: "tool_call", call };
          pending.delete(ev.index);
        }
        break;
      }

      case "message_delta": {
        stopReason = mapAnthropicStop(ev.delta.stop_reason);
        usage = mapAnthropicUsage(usage, ev.usage);
        onUsage?.(usage);
        break;
      }

      case "message_stop":
        break;
    }
  }

  yield { type: "done", stopReason, usage };
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

export interface AnthropicProviderOptions {
  /** Scoped logger; defaults to the no-op logger. Tools/providers log at debug. */
  log?: Logger;
  /** Injectable client, primarily for tests. When omitted one is constructed. */
  client?: Anthropic;
  /** Base URL override (e.g. a proxy); forwarded to the SDK client. */
  baseURL?: string;
}

/**
 * Determine whether a thrown error is an abort (signal fired mid-stream).
 * Covers the SDK's `APIUserAbortError`, the DOM `AbortError`, and the signal's
 * own `aborted` flag — any of which is a clean interrupt, not a failure (§07).
 */
function isAbortError(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (err instanceof Anthropic.APIUserAbortError) return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  return false;
}

export class AnthropicProvider implements Provider {
  readonly id = "anthropic" as const;

  private readonly client: Anthropic;
  private readonly log: Logger;

  constructor(apiKey: string, opts: AnthropicProviderOptions = {}) {
    this.log = (opts.log ?? nullLogger()).child("provider:anthropic");
    this.client =
      opts.client ??
      new Anthropic({
        apiKey,
        ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      });
  }

  /**
   * Stream one provider turn (providers.html §03 lifecycle). Serializes the
   * request, opens the SDK stream with `req.signal` attached, and pipes the SDK
   * events through {@link parseAnthropicStream}.
   *
   * Error policy (§07): an abort is a clean unwind — we emit a terminal
   * `done{stopReason:"interrupted"}` and return. Any other error propagates so
   * the loop can classify fatality (auth vs transient). We never emit an
   * AgentEvent error here; that lives above us.
   */
  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const body = buildAnthropicRequest(req);
    this.log.debug("stream start", {
      model: body.model,
      messages: body.messages.length,
      tools: body.tools.length,
    });

    let usage: Usage = zeroUsage();
    try {
      // The SDK's RawMessageStreamEvent is a structural superset of
      // AnthropicStreamEventLike, so the stream feeds the parser directly.
      const sdkStream = this.client.messages.stream(
        body as unknown as Anthropic.MessageCreateParamsStreaming,
        { signal: req.signal },
      ) as unknown as AsyncIterable<AnthropicStreamEventLike>;

      // Track usage continuously (not just on `done`) so an abort mid-stream
      // still reports the input/cache tokens that already arrived.
      for await (const ev of parseAnthropicStream(sdkStream, (u) => {
        usage = u;
      })) {
        if (ev.type === "done") usage = ev.usage;
        yield ev;
      }
      this.log.debug("stream done", {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
    } catch (err) {
      if (isAbortError(err, req.signal)) {
        this.log.debug("stream interrupted");
        yield { type: "done", stopReason: "interrupted", usage };
        return;
      }
      this.log.error("stream error", { name: (err as Error)?.name });
      throw err;
    }
  }
}
