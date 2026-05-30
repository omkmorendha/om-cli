/**
 * Permission gate (spec v0 §8, decisions.html §"No path jail").
 *
 * Before a tool runs, the gate decides: auto-allow, prompt the user, or deny.
 * Decisions can be remembered for the session via an allowlist keyed by the
 * tool's argument signature.
 *
 * Policy (in order):
 *   1. The tool's PermissionClass is in `config.autoAllow` (read is the default)
 *      → allow without prompting.
 *   2. For `exec` (bash) tools, the command matches `config.allowCommands`
 *      → allow without prompting.
 *   3. The argument signature is already in the session allowlist → allow.
 *   4. Otherwise ask `requestApproval`:
 *        - "once"    → { allowed: true }
 *        - "session" → { allowed: true, remember: "session" } and the signature
 *                      is added to the allowlist so identical calls skip the prompt.
 *        - "deny"    → { allowed: false, reason: "denied by user" }
 *
 * A denied call still returns a Decision so the loop can synthesize a tool
 * result and keep the conversation well-formed (spec §5, §8).
 */

import type {
  ApprovalResponse,
  Decision,
  PermissionClass,
  Tool,
  ToolCall,
} from "../core/types.ts";
import type { Logger } from "../util/logger.ts";

export interface PermissionConfig {
  /** Permission classes that auto-allow without prompting. Defaults to ["read"]. */
  autoAllow: PermissionClass[];
  /** Exact command signatures pre-allowed for the exec class (e.g. "npm test"). */
  allowCommands: string[];
}

export interface ApprovalRequest {
  /** Unique id for this approval round-trip. */
  id: string;
  /** Tool name being approved. */
  tool: string;
  /** Human-readable one-liner from the tool's preview(). */
  preview: string;
}

export interface PermissionGateOptions {
  config: PermissionConfig;
  /** Session allowlist of argument signatures. Mutated on "session" responses. */
  allowlist: Set<string>;
  /** Asks the frontend for a decision. Injected so the gate stays UI-agnostic. */
  requestApproval: (req: ApprovalRequest) => Promise<ApprovalResponse>;
  log: Logger;
}

/**
 * Build a stable allowlist signature for a call: tool name plus a normalized
 * argument key. For bash the key is the command; for write/edit it is the path.
 * Tools without a meaningful arg key sign on the name alone.
 */
export function argSignature(call: ToolCall): string {
  const input = call.input;
  const obj =
    input !== null && typeof input === "object"
      ? (input as Record<string, unknown>)
      : undefined;

  if (call.name === "bash") {
    const command = obj?.command;
    if (typeof command === "string") {
      return `bash:${normalizeCommand(command)}`;
    }
    return "bash";
  }

  // write / edit (and any path-keyed tool) sign on their target path.
  const path = obj?.path;
  if (typeof path === "string") {
    return `${call.name}:${path}`;
  }

  return call.name;
}

/** Collapse whitespace so "npm   test" and "npm test\n" share a signature. */
function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

let approvalCounter = 0;

/** Small, collision-resistant id for an approval request (runtime randomness ok). */
function makeApprovalId(): string {
  approvalCounter = (approvalCounter + 1) % Number.MAX_SAFE_INTEGER;
  const rand = Math.random().toString(36).slice(2, 8);
  return `appr_${Date.now().toString(36)}_${approvalCounter.toString(36)}_${rand}`;
}

export class PermissionGate {
  private readonly config: PermissionConfig;
  private readonly allowlist: Set<string>;
  private readonly requestApproval: (req: ApprovalRequest) => Promise<ApprovalResponse>;
  private readonly log: Logger;

  constructor(opts: PermissionGateOptions) {
    this.config = opts.config;
    this.allowlist = opts.allowlist;
    this.requestApproval = opts.requestApproval;
    this.log = opts.log.child("permission");
  }

  /**
   * Decide whether `call` (an invocation of `tool`) may run. May prompt the
   * user via `requestApproval`. Never throws for a denial — returns a Decision.
   */
  async check(call: ToolCall, tool: Tool): Promise<Decision> {
    const cls = tool.permission;
    const signature = argSignature(call);

    // 1. Auto-allow by class.
    if (this.config.autoAllow.includes(cls)) {
      this.log.debug("auto-allow by class", { tool: tool.name, class: cls });
      return { allowed: true };
    }

    // 2. Pre-allowed exec command from config.
    if (cls === "exec") {
      const command = commandOf(call);
      if (command !== undefined && this.matchesAllowCommands(command)) {
        this.log.debug("auto-allow by allowCommands", { tool: tool.name });
        return { allowed: true };
      }
    }

    // 3. Session allowlist hit.
    if (this.allowlist.has(signature)) {
      this.log.debug("allowlist hit", { tool: tool.name, signature });
      return { allowed: true };
    }

    // 4. Prompt the user.
    const id = makeApprovalId();
    let preview: string;
    try {
      preview = tool.preview(call.input as never);
    } catch {
      // A misbehaving preview() must not block the gate.
      preview = tool.name;
    }
    this.log.debug("requesting approval", { tool: tool.name, id });

    const response = await this.requestApproval({ id, tool: tool.name, preview });

    switch (response) {
      case "once":
        this.log.debug("approved once", { tool: tool.name, id });
        return { allowed: true };
      case "session":
        this.allowlist.add(signature);
        this.log.debug("approved for session", { tool: tool.name, id, signature });
        return { allowed: true, remember: "session" };
      case "deny":
      default:
        this.log.debug("denied by user", { tool: tool.name, id });
        return { allowed: false, reason: "denied by user" };
    }
  }

  /** True if `command`'s normalized form equals any configured allowCommand. */
  private matchesAllowCommands(command: string): boolean {
    const normalized = normalizeCommand(command);
    return this.config.allowCommands.some((c) => normalizeCommand(c) === normalized);
  }
}

/** Extract the bash command string from a call's input, if present. */
function commandOf(call: ToolCall): string | undefined {
  const input = call.input;
  if (input !== null && typeof input === "object") {
    const command = (input as Record<string, unknown>).command;
    if (typeof command === "string") return command;
  }
  return undefined;
}
