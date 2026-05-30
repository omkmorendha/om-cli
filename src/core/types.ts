/**
 * Canonical domain types for om-cli.
 *
 * These types are the contract between every layer of the harness. The session
 * stores messages in *this* internal format — never provider-native shapes (spec
 * §6). Providers serialize to/from their wire formats at the adapter boundary.
 *
 * Spec references: v0.html §4 (AgentEvent), §6 (Provider / Message / ToolCall),
 * §7 (Tool / ToolResult), §8 (Permission / Decision), §9 (Usage).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Canonical conversation model
// ─────────────────────────────────────────────────────────────────────────────

export type Role = "system" | "user" | "assistant" | "tool";

/** A single tool invocation requested by the model. */
export interface ToolCall {
  /** Provider-assigned id, echoed back on the tool result so APIs can pair them. */
  id: string;
  name: string;
  /** Parsed JSON arguments. Unknown until validated against the tool's schema. */
  input: unknown;
}

/** Content blocks that can appear inside a canonical message. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; callId: string; result: ToolResult };

/**
 * A canonical message. `content` is always an array of blocks so a single
 * assistant turn can interleave text and tool calls, and a user turn can carry
 * tool results (both providers require a result for every tool call id — §5).
 */
export interface Message {
  role: Role;
  content: ContentBlock[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool results
// ─────────────────────────────────────────────────────────────────────────────

/** Structured result returned by every tool (§7). */
export interface ToolResult {
  ok: boolean;
  /** Text content shown to the model. Already truncated if oversized. */
  content: string;
  /** Present when ok === false. */
  error?: string;
  /** Tool-specific structured metadata (not necessarily sent to the model). */
  meta?: Record<string, unknown>;
}

export const ToolResult = {
  ok(content: string, meta?: Record<string, unknown>): ToolResult {
    return meta ? { ok: true, content, meta } : { ok: true, content };
  },
  error(error: string, meta?: Record<string, unknown>): ToolResult {
    return meta
      ? { ok: false, content: error, error, meta }
      : { ok: false, content: error, error };
  },
  /** Result synthesized when the permission gate denies a call (§5, §8). */
  denied(call: ToolCall, reason: string): ToolResult {
    return {
      ok: false,
      content: `Tool "${call.name}" was denied by the user: ${reason}`,
      error: reason,
      meta: { denied: true },
    };
  },
  /** Result synthesized when a call is interrupted mid-flight (§5). */
  interrupted(call: ToolCall): ToolResult {
    return {
      ok: false,
      content: `Tool "${call.name}" was interrupted by the user.`,
      error: "interrupted",
      meta: { interrupted: true },
    };
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Usage / stop reasons
// ─────────────────────────────────────────────────────────────────────────────

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export function zeroUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

/** Normalized stop reason across providers (§6). */
export type StopReason = "end" | "tool_use" | "max_tokens" | "interrupted" | "error";

// ─────────────────────────────────────────────────────────────────────────────
// Provider contract (§6)
// ─────────────────────────────────────────────────────────────────────────────

export type ProviderId = "anthropic" | "openai";

/** A tool as the provider needs to see it: name, description, JSON Schema. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema produced from the tool's zod schema via z.toJSONSchema. */
  parameters: Record<string, unknown>;
}

export interface ProviderRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  model: string;
  signal: AbortSignal;
}

/** Low-level events emitted by a provider's stream (§6). */
export type ProviderEvent =
  | { type: "text.delta"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "done"; stopReason: StopReason; usage: Usage };

export interface Provider {
  readonly id: ProviderId;
  stream(req: ProviderRequest): AsyncIterable<ProviderEvent>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent events: Core → Frontend (§4)
// ─────────────────────────────────────────────────────────────────────────────

export type AgentEvent =
  | { type: "text.delta"; text: string }
  | { type: "text.done"; text: string }
  | { type: "tool.start"; id: string; name: string; input: unknown }
  | { type: "tool.result"; id: string; output: ToolResult }
  | { type: "approval.request"; id: string; tool: string; preview: string }
  | { type: "turn.done"; stopReason: StopReason; usage: Usage }
  | { type: "error"; message: string; fatal: boolean };

// ─────────────────────────────────────────────────────────────────────────────
// Permissions (§8)
// ─────────────────────────────────────────────────────────────────────────────

export type PermissionClass = "read" | "write" | "exec";

export type Decision =
  | { allowed: true; remember?: "session" }
  | { allowed: false; reason: string };

/** The user's response to an approval prompt. */
export type ApprovalResponse = "once" | "session" | "deny";

// ─────────────────────────────────────────────────────────────────────────────
// Tool definition (§7)
// ─────────────────────────────────────────────────────────────────────────────

import type { ZodType } from "zod";
import type { Logger } from "../util/logger.ts";

/** Ambient context handed to every tool's run() (spec §7, elaborated in tools.html). */
export interface ToolContext {
  /** Process working directory the harness was launched in. */
  cwd: string;
  /** Abort signal for cancellation (Ctrl-C unwind). */
  signal: AbortSignal;
  /** Scoped logger. */
  log: Logger;
  /**
   * Set of absolute file paths read this session. The `edit` tool requires its
   * target to be present here before it will apply a change (§7).
   */
  readSet: Set<string>;
  /** Streams incremental tool output (e.g. live bash stdout) to the frontend. */
  emit?: (chunk: string) => void;
}

export interface Tool<I = unknown> {
  name: string;
  description: string;
  schema: ZodType<I>;
  permission: PermissionClass;
  /** Human-readable one-liner shown in the approval prompt. */
  preview(input: I): string;
  run(input: I, ctx: ToolContext): Promise<ToolResult>;
}
