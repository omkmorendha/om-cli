/**
 * Tool registry (spec tools.html §13).
 *
 * The registry is the single chokepoint between the model and tool execution.
 * It does three jobs:
 *   (1) specs()  — emit model-facing JSON Schemas, one ToolSpec per tool;
 *   (2) run()    — validate a ToolCall's input against the tool's zod schema
 *                  BEFORE executing, then dispatch;
 *   (3) normalize — every outcome becomes a ToolResult. run() never throws:
 *                  a rejecting/throwing tool is caught and turned into an
 *                  ok:false result. This guarantees the agent loop's
 *                  "every call gets a result" invariant (v0 §loop).
 *
 * Conforms to the canonical contract in src/core/types.ts: ToolContext exposes
 * the logger as `ctx.log` (not `ctx.logger`) and ToolSpec carries the schema as
 * `parameters` (not `schema`). Tools run sequentially in v0, so the registry
 * needs no concurrency control beyond the per-turn AbortSignal threaded into ctx.
 */

import { z } from "zod";
import type {
  Tool,
  ToolCall,
  ToolContext,
  ToolResult,
  ToolSpec,
} from "../core/types.ts";
import { ToolResult as TR } from "../core/types.ts";
import { fsTools } from "./fs.ts";
import { bashTool } from "./bash.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Error helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format a zod validation error into a compact, single-line, model-actionable
 * string. Each issue is rendered as `<field path>: <message>`; issues with no
 * path (e.g. a top-level `.refine`) render as just the message. Multiple issues
 * are joined with "; ".
 */
export function formatZodError(error: z.ZodError): string {
  const parts = error.issues.map((issue) => {
    const path = issue.path
      .map((seg) => (typeof seg === "number" ? `[${seg}]` : String(seg)))
      .join(".")
      // Collapse "a.[0]" into "a[0]" for readability.
      .replace(/\.\[/g, "[");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return parts.length > 0 ? parts.join("; ") : "invalid input";
}

/**
 * Map a thrown value into a clean, single-line, model-facing error string.
 * Filesystem errno codes get friendly phrasing; AbortError becomes "aborted";
 * any other Error yields its message (first line only, never a stack trace).
 */
export function normalizeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    const path = (err as { path?: string }).path;
    switch (code) {
      case "ENOENT":
        return path ? `file not found: ${path}` : "file not found";
      case "EACCES":
      case "EPERM":
        return path ? `permission denied: ${path}` : "permission denied";
      case "EISDIR":
        return "path is a directory";
    }
    if (err.name === "AbortError") return "aborted";
    // First line only — strip any multi-line stack/detail.
    return err.message.split("\n")[0] ?? err.name;
  }
  if (err === null || err === undefined) return "unknown error";
  return String(err).split("\n")[0] ?? "unknown error";
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<unknown>>();

  /** Register a tool by name. A later registration with the same name wins. */
  register<I>(tool: Tool<I>): void {
    // The map stores tools type-erased; run() re-validates input via the zod
    // schema before invoking, so the erasure is sound.
    this.tools.set(tool.name, tool as unknown as Tool<unknown>);
  }

  /** Model-facing schemas: one ToolSpec per registered tool. */
  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: z.toJSONSchema(t.schema) as Record<string, unknown>,
    }));
  }

  /** Look up a tool by name. */
  get(name: string): Tool<unknown> | undefined {
    return this.tools.get(name);
  }

  /** All registered tools, in registration order. */
  list(): Tool<unknown>[] {
    return [...this.tools.values()];
  }

  /**
   * Validate then dispatch a single tool call. Returns a ToolResult for every
   * outcome and NEVER throws:
   *   - unknown tool        -> ok:false "unknown tool: <name>"
   *   - input fails schema  -> ok:false "invalid input for <name>: <detail>"
   *                            + meta.validation (the raw zod issues)
   *   - tool run throws      -> ok:false normalizeError(err)
   *   - tool run resolves    -> its ToolResult, returned as-is
   */
  async run(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return TR.error(`unknown tool: ${call.name}`);
    }

    const parsed = tool.schema.safeParse(call.input);
    if (!parsed.success) {
      return TR.error(
        `invalid input for ${call.name}: ${formatZodError(parsed.error)}`,
        { validation: parsed.error.issues },
      );
    }

    try {
      return await tool.run(parsed.data, ctx);
    } catch (err) {
      ctx.log.error("tool threw", { tool: call.name, err: normalizeError(err) });
      return TR.error(normalizeError(err));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Default registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a registry pre-populated with the v0 built-in tools: the filesystem
 * tools (read, ls, glob, grep, write, edit) and bash.
 */
export function defaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of fsTools) {
    registry.register(tool);
  }
  registry.register(bashTool);
  return registry;
}
