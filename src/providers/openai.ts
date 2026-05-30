/**
 * OpenAI Responses API provider adapter.
 *
 * Implements the `Provider` contract (core/types.ts) over the OpenAI SDK's
 * Responses API. This is the single seam where OpenAI wire shapes enter the
 * harness; everything above speaks only the canonical types.
 *
 * Spec: providers.html §04/§05 (OpenAI Responses Adapter), v0.html §6.
 *
 * Design notes that diverge from the spec prose (which predates the committed
 * core/types.ts) to conform to the binding contract:
 *   - StopReason has no "aborted"/"stop_seq"; an AbortSignal maps to "interrupted",
 *     and there is no stop-sequence concept on the Responses side anyway.
 *   - Usage is { inputTokens, outputTokens } plus optional cache token fields
 *     when the Responses usage object reports cached_tokens.
 *
 * The serialize (`toResponsesInput` / `toResponsesTools`) and parse
 * (`parseResponsesEvent` via `ResponsesParser`) halves are pure, exported, and
 * unit-tested against synthetic SDK event objects — no network.
 */

import OpenAI, { type ClientOptions } from "openai";
import type {
  ResponseStreamEvent,
  ResponseInputItem,
  ResponseUsage,
  FunctionTool,
} from "openai/resources/responses/responses";

import type {
  Provider,
  ProviderEvent,
  ProviderId,
  ProviderRequest,
  Message,
  ToolSpec,
  StopReason,
  Usage,
} from "../core/types.ts";
import { zeroUsage } from "../core/types.ts";
import type { Logger } from "../util/logger.ts";
import { nullLogger } from "../util/logger.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Serialize: canonical → Responses wire body
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Flatten canonical messages into the Responses `input[]` array.
 *
 * Unlike Anthropic there is no per-message wrapper: assistant text, user text,
 * function_call, and function_call_output are all sibling top-level input items.
 *
 *   - assistant text       → { role:"assistant", content:[{type:"output_text", text}] }
 *   - user text            → { role:"user",      content:[{type:"input_text",  text}] }
 *   - tool_call            → { type:"function_call", call_id, name, arguments: JSON.stringify(input) }
 *   - tool_result          → { type:"function_call_output", call_id, output: result.content }
 *
 * Tool results round-trip on `call_id` (== canonical ToolCall.id), so no
 * provider-specific id bookkeeping leaks into the loop.
 */
export function toResponsesInput(messages: Message[]): ResponseInputItem[] {
  const items: ResponseInputItem[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      switch (b.type) {
        case "text": {
          if (m.role === "assistant") {
            // Prior assistant prose re-enters as an assistant-role message item.
            // (The Responses input type only accepts assistant text as a string
            // EasyInputMessage — `output_text` is an *output*-only content block.)
            items.push({ role: "assistant", content: b.text });
          } else {
            // user / system / tool text enter as a typed input_text block.
            items.push({
              role: "user",
              content: [{ type: "input_text", text: b.text }],
            });
          }
          break;
        }
        case "tool_call": {
          items.push({
            type: "function_call",
            call_id: b.call.id,
            name: b.call.name,
            arguments: JSON.stringify(b.call.input ?? {}),
          });
          break;
        }
        case "tool_result": {
          items.push({
            type: "function_call_output",
            call_id: b.callId,
            output: b.result.content,
          });
          break;
        }
      }
    }
  }
  return items;
}

/**
 * Translate canonical tool specs into Responses flat function tools.
 * The JSON Schema in `parameters` is the same z.toJSONSchema output Anthropic
 * receives; only the envelope (`type:"function"`, sibling `name`) differs.
 */
export function toResponsesTools(tools: ToolSpec[]): FunctionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    strict: false,
  }));
}

/** Map a Responses usage object onto the canonical Usage shape. */
export function toUsage(u: ResponseUsage | null | undefined): Usage {
  if (!u) return zeroUsage();
  // Treat a zero cached_tokens as "no cache activity" and omit the field, so a
  // cache-free turn yields a clean { inputTokens, outputTokens } Usage.
  const cacheRead = u.input_tokens_details?.cached_tokens;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    ...(cacheRead ? { cacheReadTokens: cacheRead } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse: Responses stream events → canonical ProviderEvent[]
// ─────────────────────────────────────────────────────────────────────────────

interface PendingCall {
  id: string;
  name: string;
  args: string;
  /** Guards against emitting the same call twice (e.g. both done paths fire). */
  emitted: boolean;
}

/**
 * Stateful parser turning a Responses SSE event sequence into canonical
 * ProviderEvents. Pure (no I/O); fed one event at a time. The streaming
 * `OpenAIProvider.stream` drives it; tests drive it directly with synthetic
 * events. Call `finish()` once the source stream ends to obtain the terminal
 * `done` event (synthesized if the provider never sent `response.completed`).
 *
 * State machine, mirroring Anthropic's by design:
 *   output_item.added(function_call)  → open a pending call, keyed by output_index
 *   output_text.delta                 → text.delta
 *   function_call_arguments.delta     → accumulate args on the pending call
 *   output_item.done(function_call)   → emit tool_call (parse buffered args)
 *   function_call_arguments.done      → emit tool_call if not already emitted
 *   response.completed / .incomplete  → capture usage + stop reason
 */
export class ResponsesParser {
  private readonly pending = new Map<number, PendingCall>();
  /** Fallback lookup by item_id for the arguments.done event (no output_index). */
  private readonly byItemId = new Map<string, number>();
  /**
   * call_ids already emitted as a tool_call. Both `arguments.done` and
   * `output_item.done` can fire for the same call; this is the authoritative
   * guard so a re-created pending entry can never trigger a duplicate emit.
   */
  private readonly emittedCallIds = new Set<string>();
  private usage: Usage = zeroUsage();
  private sawToolCall = false;
  private stopReason: StopReason = "end";
  private sawCompleted = false;

  /** Feed one SDK event; returns any ProviderEvents it produced (0 or 1 here). */
  push(ev: ResponseStreamEvent): ProviderEvent[] {
    switch (ev.type) {
      case "response.output_item.added": {
        if (ev.item.type === "function_call") {
          const id = ev.item.call_id;
          this.pending.set(ev.output_index, {
            id,
            name: ev.item.name,
            args: ev.item.arguments ?? "",
            emitted: false,
          });
          if (ev.item.id) this.byItemId.set(ev.item.id, ev.output_index);
        }
        return [];
      }

      case "response.output_text.delta": {
        return [{ type: "text.delta", text: ev.delta }];
      }

      case "response.function_call_arguments.delta": {
        const p = this.pending.get(ev.output_index);
        if (p) {
          p.args += ev.delta;
          if (ev.item_id) this.byItemId.set(ev.item_id, ev.output_index);
        }
        return [];
      }

      case "response.function_call_arguments.done": {
        // Some streams finalize args here before output_item.done. The event
        // lacks call_id, so resolve via output_index / item_id; the buffered
        // arguments are authoritative once this fires.
        const idx = this.pending.has(ev.output_index)
          ? ev.output_index
          : this.byItemId.get(ev.item_id);
        if (idx === undefined) return [];
        const p = this.pending.get(idx);
        if (!p) return [];
        p.args = ev.arguments ?? p.args;
        if (ev.name) p.name = ev.name;
        return this.emitCall(p);
      }

      case "response.output_item.done": {
        if (ev.item.type === "function_call") {
          let p = this.pending.get(ev.output_index);
          if (!p) {
            p = {
              id: ev.item.call_id,
              name: ev.item.name,
              args: ev.item.arguments ?? "",
              emitted: false,
            };
            this.pending.set(ev.output_index, p);
          }
          // The completed item carries the authoritative arguments string, but
          // only override if args.done hasn't already finalized & emitted them.
          if (!p.emitted && ev.item.arguments !== undefined && ev.item.arguments !== "") {
            p.args = ev.item.arguments;
          }
          p.id = ev.item.call_id;
          p.name = ev.item.name;
          return this.emitCall(p);
        }
        return [];
      }

      case "response.completed": {
        this.sawCompleted = true;
        this.usage = toUsage(ev.response.usage);
        if (!this.sawToolCall) {
          this.stopReason =
            ev.response.incomplete_details?.reason === "max_output_tokens"
              ? "max_tokens"
              : "end";
        }
        return [];
      }

      case "response.incomplete": {
        this.sawCompleted = true;
        this.usage = toUsage(ev.response.usage);
        // Mirror the completed path (providers.html §06): only a token-budget
        // cutoff maps to max_tokens. Any other incomplete reason (e.g.
        // content_filter) has no canonical StopReason, so it falls back to
        // "end". A tool call already in flight keeps its tool_use stop reason.
        if (!this.sawToolCall) {
          this.stopReason =
            ev.response.incomplete_details?.reason === "max_output_tokens"
              ? "max_tokens"
              : "end";
        }
        return [];
      }

      case "response.failed": {
        // Surface as an error so the loop can decide fatality; we do not emit
        // an AgentEvent.error ourselves (§7). Capture usage if present first.
        this.sawCompleted = true;
        this.usage = toUsage(ev.response.usage);
        const msg = ev.response.error?.message ?? "OpenAI response failed";
        throw new Error(msg);
      }

      case "error": {
        throw new Error(ev.message ?? "OpenAI stream error");
      }

      default:
        // All other Responses event types (reasoning, audio, web search, mcp,
        // content-part bookkeeping, etc.) are not part of the v0 contract.
        return [];
    }
  }

  private emitCall(p: PendingCall): ProviderEvent[] {
    // Mark emitted *before* parsing so a malformed-args throw is not retried by
    // a later done event for the same item. Dedup by call_id (via emittedCallIds)
    // as well as the entry flag, so a re-created pending entry for the same call
    // — e.g. output_item.done arriving after arguments.done under a different
    // output_index — cannot trigger a duplicate emit.
    if (p.emitted || this.emittedCallIds.has(p.id)) return [];
    p.emitted = true;
    this.emittedCallIds.add(p.id);
    this.sawToolCall = true;
    this.stopReason = "tool_use";
    let input: unknown;
    try {
      input = p.args ? JSON.parse(p.args) : {};
    } catch (err) {
      // Malformed tool-arg JSON: throw so the loop can re-prompt (§7).
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to parse arguments for tool "${p.name}": ${reason}`,
      );
    }
    return [{ type: "tool_call", call: { id: p.id, name: p.name, input } }];
  }

  /**
   * Terminal event. Call exactly once after the source stream ends.
   * If `aborted` is true, reports the interrupt as a clean turn end.
   * If the provider never sent a completed/incomplete event, synthesizes a
   * `done` with the best-known stop reason.
   */
  finish(aborted = false): ProviderEvent {
    if (aborted) {
      return { type: "done", stopReason: "interrupted", usage: this.usage };
    }
    // sawCompleted is informational; we always have a sensible stopReason.
    return { type: "done", stopReason: this.stopReason, usage: this.usage };
  }

  /** Whether a terminal completed/incomplete event was observed (for logging). */
  get completed(): boolean {
    return this.sawCompleted;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Request body
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the Responses streaming request body from a canonical request.
 * `store:false` — the canonical session owns conversation state (§9), so we
 * resend full history each turn and OpenAI persists nothing server-side.
 */
export function buildResponsesRequest(req: ProviderRequest) {
  return {
    model: req.model,
    instructions: req.system,
    input: toResponsesInput(req.messages),
    tools: toResponsesTools(req.tools),
    store: false as const,
    stream: true as const,
  };
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "AbortError") return true;
    if (err instanceof OpenAI.APIUserAbortError) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

export interface OpenAIProviderOptions extends Omit<ClientOptions, "apiKey"> {
  log?: Logger;
}

export class OpenAIProvider implements Provider {
  readonly id: ProviderId = "openai";
  private readonly client: OpenAI;
  private readonly log: Logger;

  constructor(apiKey: string, opts: OpenAIProviderOptions = {}) {
    const { log, ...clientOpts } = opts;
    this.client = new OpenAI({ apiKey, ...clientOpts });
    this.log = (log ?? nullLogger()).child("provider:openai");
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const body = buildResponsesRequest(req);
    this.log.debug("stream open", {
      model: req.model,
      messages: req.messages.length,
      tools: req.tools.length,
    });

    const parser = new ResponsesParser();

    let sdkStream: AsyncIterable<ResponseStreamEvent>;
    try {
      sdkStream = await this.client.responses.create(body, {
        signal: req.signal,
      });
    } catch (err) {
      if (req.signal.aborted || isAbortError(err)) {
        this.log.debug("stream aborted before open");
        yield parser.finish(true);
        return;
      }
      this.log.error("stream open failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    try {
      for await (const ev of sdkStream) {
        for (const out of parser.push(ev)) {
          yield out;
        }
      }
    } catch (err) {
      if (req.signal.aborted || isAbortError(err)) {
        this.log.debug("stream aborted mid-flight");
        yield parser.finish(true);
        return;
      }
      this.log.error("stream parse failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    if (!parser.completed) {
      this.log.warn("stream ended without a completed event; synthesizing done");
    }
    yield parser.finish(false);
  }
}
