/**
 * The shared Frontend interface and cross-frontend helpers (spec tui.html §09).
 *
 * Both the headless `StdoutFrontend` (tui.html §10) and the eventual OpenTUI
 * `TuiFrontend` implement this one interface so `main.ts` can pick a frontend at
 * boot without the core knowing which is live. The core depends only on this
 * interface and the canonical `AgentEvent` stream — never on OpenTUI.
 *
 * Direction of data (spec §01):
 *   - Core → frontend: a read-only `AsyncIterable<AgentEvent>` (render only).
 *   - Frontend → core: exactly two callbacks — `onSubmit(text, signal)` and
 *     `onApproval(id, decision)`. No third channel, no shared mutable state.
 *
 * NOTE ON THE APPROVAL SEAM (binding code vs. idealized spec):
 *   The committed `PermissionGate` (permission/gate.ts) is UI-agnostic: it is
 *   constructed with a `requestApproval(req) => Promise<ApprovalResponse>`
 *   callback and has NO `gate.resolve(...)` method. `main.ts` owns a
 *   `Map<string, (r: ApprovalResponse) => void>` of pending resolvers. When the
 *   gate calls `requestApproval`, main.ts surfaces an `approval.request`
 *   AgentEvent through the active render stream and parks the resolver in that
 *   map. The frontend renders the prompt, collects a choice, and calls
 *   `frontend.onApproval(id, decision)`; main.ts maps that `Decision` back to an
 *   `ApprovalResponse` via `decisionToResponse` and resolves the parked promise.
 *   This module exports both directions of that mapping so main.ts and every
 *   frontend share one translation.
 */

import type {
  AgentEvent,
  ApprovalResponse,
  Decision,
  ToolResult,
} from "../core/types.ts";

/**
 * The contract every frontend implements. Kept deliberately tiny so v0 can run
 * headless (M1–M4) and swap in the OpenTUI frontend (M5) without touching the
 * core or providers (spec §09).
 */
export interface Frontend {
  /** Prepare the frontend (TUI: await createCliRenderer; stdout: ~no-op). */
  mount(): Promise<void>;

  /** Render one turn's worth of core events to completion. */
  render(events: AsyncIterable<AgentEvent>): Promise<void>;

  /**
   * Core → frontend callback registered by main.ts. The frontend invokes it
   * when the user submits a line, handing over the text plus the `AbortSignal`
   * that scopes the resulting turn (Ctrl-C unwind, spec §08).
   */
  onSubmit?: (text: string, signal: AbortSignal) => void;

  /**
   * Core → frontend callback registered by main.ts. The frontend invokes it
   * with the user's decision for a pending `approval.request` id. A deny still
   * flows back so the core can synthesize a tool result (loop invariant §05).
   */
  onApproval?: (id: string, decision: Decision) => void;

  /** Tear down (TUI: restore terminal; stdout: flush). */
  dispose(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Approval mapping — shared by every frontend and by main.ts (spec §07)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map a user's `ApprovalResponse` ("once" | "session" | "deny") to the
 * canonical `Decision` shape the core consumes (types.ts §8).
 *
 *   once    → { allowed: true }
 *   session → { allowed: true, remember: "session" }
 *   deny    → { allowed: false, reason: "denied by user" }
 */
export function toDecision(resp: ApprovalResponse): Decision {
  switch (resp) {
    case "once":
      return { allowed: true };
    case "session":
      return { allowed: true, remember: "session" };
    case "deny":
      return { allowed: false, reason: "denied by user" };
  }
}

/**
 * Inverse of {@link toDecision}: collapse a `Decision` back to the
 * `ApprovalResponse` the gate's `requestApproval` promise expects.
 *
 * main.ts uses this when `frontend.onApproval(id, decision)` fires: it resolves
 * the parked `requestApproval` promise with `decisionToResponse(decision)` so
 * the gate sees the same "once" | "session" | "deny" vocabulary it asked with.
 */
export function decisionToResponse(decision: Decision): ApprovalResponse {
  if (!decision.allowed) return "deny";
  return decision.remember === "session" ? "session" : "once";
}

// ─────────────────────────────────────────────────────────────────────────────
// Display helpers — shared by the stdout and (future) TUI frontends
// ─────────────────────────────────────────────────────────────────────────────

/** Default cap for a single rendered display line (chars, not bytes). */
export const DISPLAY_LINE_LIMIT = 2000;

/**
 * Collapse a possibly-large / multi-line string to a compact, single-line form
 * suitable for an inline status line. Newlines become spaces so a noisy tool
 * result cannot smear across the scrollback, and the whole thing is hard-capped
 * with an ellipsis. This is a *display* truncation, distinct from the model
 * facing byte-cap in tools/truncate.ts.
 */
export function truncateForDisplay(s: string, limit: number = DISPLAY_LINE_LIMIT): string {
  const oneLine = s.replace(/\s*\n+\s*/g, " ").trim();
  if (oneLine.length <= limit) return oneLine;
  return oneLine.slice(0, Math.max(0, limit - 1)) + "…";
}

/**
 * Render a `tool.result` as a single status line shared by frontends:
 *
 *   "[result] ok: <short content>"        when output.ok
 *   "[result] ERR: <short error|content>" otherwise
 *
 * On failure the explicit `error` is preferred over `content` when present,
 * since `content` may just echo the error anyway (types.ts ToolResult.error).
 */
export function renderToolResultLine(
  output: ToolResult,
  limit: number = DISPLAY_LINE_LIMIT,
): string {
  if (output.ok) {
    return `[result] ok: ${truncateForDisplay(output.content, limit)}`;
  }
  const detail = output.error ?? output.content;
  return `[result] ERR: ${truncateForDisplay(detail, limit)}`;
}
