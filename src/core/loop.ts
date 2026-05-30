/**
 * The agent loop (spec v0 §5) — the integrative module that ties together the
 * session, provider, tool registry, and permission gate.
 *
 * `runTurn` drives one user turn to completion: send the conversation to the
 * provider, stream its reply (forwarding text deltas to the frontend),
 * accumulate the assistant message, then execute any requested tool calls
 * (sequentially in v0) through the permission gate and registry, appending a
 * result for every call. It repeats until the model stops without requesting
 * tools, the turn is cancelled, an error occurs, or the iteration cap is hit.
 *
 * Loop invariants (spec §5):
 *   - Tools execute sequentially.
 *   - Every tool call gets a result message (denied / errored / interrupted
 *     calls still append a result so provider history stays valid — both APIs
 *     require a result for every tool call id).
 *   - Cancellation unwinds cleanly: on abort we synthesize an "interrupted"
 *     result, append it, and return with stopReason "interrupted".
 *   - A turn cap guards against runaway loops; hitting it emits a recoverable
 *     (non-fatal) error then a turn.done.
 *
 * The loop calls `gate.check` and trusts its Decision. The gate (not the loop)
 * is responsible for surfacing the approval prompt to the frontend. See the
 * "Permission seam" note at the bottom of this file.
 */

import type {
  AgentEvent,
  ContentBlock,
  Provider,
  ProviderRequest,
  StopReason,
  Tool,
  ToolCall,
  ToolContext,
  ToolResult,
  ToolSpec,
  Usage,
} from "./types.ts";
import { ToolResult as ToolResultHelpers, zeroUsage } from "./types.ts";
import type { Session } from "./session.ts";
import type { PermissionGate } from "../permission/gate.ts";

/**
 * The subset of the tool registry the loop depends on. The concrete
 * `ToolRegistry` (its own Wave A module) satisfies this structurally:
 *   - `specs()` emits the model-facing JSON Schemas;
 *   - `get(name)` looks up the `Tool` so the gate can preview/classify it;
 *   - `run(call, ctx)` validates + dispatches and *never throws* — it always
 *     resolves to a `ToolResult` (spec tools.html §13), upholding the loop's
 *     "every call gets a result" invariant.
 */
export interface ToolRegistry {
  specs(): ToolSpec[];
  get(name: string): Tool | undefined;
  run(call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
}

export interface RunTurnOptions {
  session: Session;
  provider: Provider;
  registry: ToolRegistry;
  gate: PermissionGate;
  model: string;
  signal: AbortSignal;
  ctx: ToolContext;
  /** Max provider round-trips before the runaway guard fires. Default 25. */
  maxIterations?: number;
}

const DEFAULT_MAX_ITERATIONS = 25;

/**
 * Run a single turn to completion, yielding `AgentEvent`s as it goes.
 *
 * The generator mutates `opts.session` in place (appending the assistant
 * message and a tool result per call), so the session is the durable record
 * once the generator is fully drained.
 */
export async function* runTurn(opts: RunTurnOptions): AsyncGenerator<AgentEvent> {
  const { session, provider, registry, gate, model, signal, ctx } = opts;
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const log = ctx.log.child("loop");

  for (let iteration = 0; ; iteration++) {
    // Runaway guard: if we have already done `maxIterations` provider
    // round-trips, refuse to start another. Emit a recoverable error then end.
    if (iteration >= maxIterations) {
      log.warn("turn cap reached", { maxIterations });
      yield {
        type: "error",
        message: `turn exceeded ${maxIterations} iterations; stopping`,
        fatal: false,
      };
      yield { type: "turn.done", stopReason: "error", usage: session.usage };
      return;
    }

    // Honor cancellation before each provider round-trip.
    if (signal.aborted) {
      yield { type: "turn.done", stopReason: "interrupted", usage: session.usage };
      return;
    }

    const request: ProviderRequest = {
      system: session.systemPrompt,
      messages: session.messages,
      tools: registry.specs(),
      model,
      signal,
    };

    // ── Stream the provider reply ──────────────────────────────────────────
    let assistantText = "";
    const toolCalls: ToolCall[] = [];
    let stopReason: StopReason = "end";
    let turnUsage: Usage = zeroUsage();

    try {
      for await (const ev of provider.stream(request)) {
        switch (ev.type) {
          case "text.delta":
            assistantText += ev.text;
            yield { type: "text.delta", text: ev.text };
            break;
          case "tool_call":
            toolCalls.push(ev.call);
            break;
          case "done":
            stopReason = ev.stopReason;
            turnUsage = ev.usage;
            break;
        }
      }
    } catch (err) {
      // A provider failure is fatal for this turn. We surface it and stop;
      // because no assistant message has been appended for this incomplete
      // round-trip, the session history stays well-formed.
      const message = err instanceof Error ? err.message : String(err);
      log.error("provider stream failed", { error: message });
      yield { type: "error", message, fatal: true };
      yield { type: "turn.done", stopReason: "error", usage: session.usage };
      return;
    }

    // Account for this round-trip's usage on the session.
    session.addUsage(turnUsage);

    // Emit text.done if the assistant produced any text this round-trip.
    if (assistantText.length > 0) {
      yield { type: "text.done", text: assistantText };
    }

    // Append the assistant message (text + tool_call blocks) to the session,
    // in order: any text first, then each tool call. Skip wholly-empty turns.
    const assistantBlocks: ContentBlock[] = [];
    if (assistantText.length > 0) {
      assistantBlocks.push({ type: "text", text: assistantText });
    }
    for (const call of toolCalls) {
      assistantBlocks.push({ type: "tool_call", call });
    }
    if (assistantBlocks.length > 0) {
      session.append({ role: "assistant", content: assistantBlocks });
    }

    // ── No tool calls: the model is done talking. ──────────────────────────
    if (toolCalls.length === 0) {
      yield { type: "turn.done", stopReason, usage: session.usage };
      return;
    }

    // ── Execute each requested tool call, sequentially (v0). ───────────────
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i]!;
      yield { type: "tool.start", id: call.id, name: call.name, input: call.input };

      // If we were aborted before/while reaching this call, synthesize an
      // interrupted result for it AND for every remaining call, then unwind.
      // The assistant message already declared all of these tool_calls; both
      // provider APIs require a result for every tool-call id, so we must not
      // leave the trailing calls unanswered (that corrupts the next round-trip
      // after a resume). tool.start for this call was already emitted above.
      if (signal.aborted) {
        const result = ToolResultHelpers.interrupted(call);
        yield { type: "tool.result", id: call.id, output: result };
        session.appendToolResult(call, result);
        yield* interruptRemaining(toolCalls, i + 1, session);
        yield { type: "turn.done", stopReason: "interrupted", usage: session.usage };
        return;
      }

      const tool = registry.get(call.name);

      let result: ToolResult;
      if (!tool) {
        // Unknown tool: still produce a result so history stays valid. The
        // registry would also catch this in run(), but checking here lets us
        // skip the gate for a call we cannot classify.
        result = ToolResultHelpers.error(`unknown tool: ${call.name}`);
      } else {
        const decision = await gate.check(call, tool);
        if (decision.allowed) {
          // The registry never throws: it returns a normalized ToolResult.
          result = await registry.run(call, ctx);
        } else {
          result = ToolResultHelpers.denied(call, decision.reason);
        }
      }

      yield { type: "tool.result", id: call.id, output: result };
      session.appendToolResult(call, result);

      // If the tool run itself was interrupted (e.g. Ctrl-C during a bash
      // spawn flipped the signal), finalize the remaining calls with
      // interrupted results and unwind rather than starting the next call or
      // another provider round-trip.
      if (signal.aborted) {
        yield* interruptRemaining(toolCalls, i + 1, session);
        yield { type: "turn.done", stopReason: "interrupted", usage: session.usage };
        return;
      }
    }

    // Loop continues: the tool results are now in the session and become
    // context for the next provider round-trip.
  }
}

/**
 * Synthesize interrupted results for `calls[from..]`, emitting a tool.start +
 * tool.result pair for each (none of them were started yet) and appending the
 * result to the session. Used to finalize the trailing tool calls of an
 * assistant message when a turn is aborted partway through, so every declared
 * tool-call id gets a matching result and provider history stays well-formed.
 */
function* interruptRemaining(
  calls: ToolCall[],
  from: number,
  session: Session,
): Generator<AgentEvent> {
  for (let j = from; j < calls.length; j++) {
    const call = calls[j]!;
    const result = ToolResultHelpers.interrupted(call);
    yield { type: "tool.start", id: call.id, name: call.name, input: call.input };
    yield { type: "tool.result", id: call.id, output: result };
    session.appendToolResult(call, result);
  }
}

/*
 * Permission seam (spec §5, §8)
 * ─────────────────────────────
 * The loop deliberately does NOT emit `approval.request` AgentEvents. The
 * permission gate owns the approval round-trip: its `requestApproval` callback
 * is injected by the frontend (gate.ts), so the gate can surface the prompt and
 * await the user's decision without the loop mediating it. The loop just calls
 * `gate.check(call, tool)` and trusts the returned `Decision`.
 *
 * `approval.request` remains in the AgentEvent union (types.ts §4) for a future
 * design where the gate drives approvals back through the same event stream the
 * loop yields. If that seam is adopted, `runTurn` would need to multiplex the
 * gate's approval requests into its own output and accept responses back — a
 * larger refactor tracked as a followup, not entangled here.
 */
