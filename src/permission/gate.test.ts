import { describe, expect, test } from "bun:test";
import { z } from "zod";

import type {
  ApprovalResponse,
  Decision,
  PermissionClass,
  Tool,
  ToolCall,
} from "../core/types.ts";
import { ToolResult } from "../core/types.ts";
import { nullLogger } from "../util/logger.ts";
import { argSignature, PermissionGate } from "./gate.ts";

// ── Test fixtures ────────────────────────────────────────────────────────────

/** A minimal Tool stub. run() is never invoked by the gate. */
function makeTool(name: string, permission: PermissionClass): Tool {
  return {
    name,
    description: `${name} tool`,
    schema: z.object({}).passthrough() as unknown as Tool["schema"],
    permission,
    preview: (input) => `${name} ${JSON.stringify(input)}`,
    async run(): Promise<ToolResult> {
      return ToolResult.ok("ran");
    },
  };
}

function makeCall(name: string, input: unknown): ToolCall {
  return { id: `call_${name}_${Math.random().toString(36).slice(2)}`, name, input };
}

/**
 * A scripted requestApproval: returns the next queued response and records how
 * many times it was invoked. Throws if asked when the queue is empty (so an
 * unexpected prompt fails the test loudly).
 */
function scriptedApproval(...responses: ApprovalResponse[]) {
  const queue = [...responses];
  const calls: string[] = [];
  const fn = async (req: { id: string; tool: string; preview: string }) => {
    calls.push(req.tool);
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`unexpected approval prompt for ${req.tool}`);
    }
    return next;
  };
  return { fn, calls };
}

const baseConfig = { autoAllow: ["read"] as PermissionClass[], allowCommands: [] as string[] };

function makeGate(opts: {
  config?: { autoAllow: PermissionClass[]; allowCommands: string[] };
  allowlist?: Set<string>;
  approval: ReturnType<typeof scriptedApproval>;
}) {
  const allowlist = opts.allowlist ?? new Set<string>();
  const gate = new PermissionGate({
    config: opts.config ?? baseConfig,
    allowlist,
    requestApproval: opts.approval.fn,
    log: nullLogger(),
  });
  return { gate, allowlist };
}

// ── argSignature ─────────────────────────────────────────────────────────────

describe("argSignature", () => {
  test("bash signs on the command", () => {
    expect(argSignature(makeCall("bash", { command: "npm test" }))).toBe("bash:npm test");
  });

  test("bash normalizes whitespace", () => {
    expect(argSignature(makeCall("bash", { command: "  npm   test\n" }))).toBe("bash:npm test");
  });

  test("write/edit sign on the path", () => {
    expect(argSignature(makeCall("write", { path: "/a/b.ts", content: "x" }))).toBe(
      "write:/a/b.ts",
    );
    expect(argSignature(makeCall("edit", { path: "/a/b.ts" }))).toBe("edit:/a/b.ts");
  });

  test("falls back to the tool name when no arg key is present", () => {
    expect(argSignature(makeCall("bash", {}))).toBe("bash");
    expect(argSignature(makeCall("mystery", null))).toBe("mystery");
  });
});

// ── check() ──────────────────────────────────────────────────────────────────

describe("PermissionGate.check", () => {
  test("read auto-allows without prompting", async () => {
    const approval = scriptedApproval(); // empty: any prompt throws
    const { gate } = makeGate({ approval });

    const decision = await gate.check(makeCall("read", { path: "/x.ts" }), makeTool("read", "read"));

    expect(decision).toEqual({ allowed: true });
    expect(approval.calls).toEqual([]);
  });

  test("write prompts the user", async () => {
    const approval = scriptedApproval("once");
    const { gate } = makeGate({ approval });

    const decision = await gate.check(
      makeCall("write", { path: "/x.ts", content: "y" }),
      makeTool("write", "write"),
    );

    expect(decision).toEqual({ allowed: true });
    expect(approval.calls).toEqual(["write"]);
  });

  test("'once' does NOT remember; the second identical call prompts again", async () => {
    const approval = scriptedApproval("once", "once");
    const { gate, allowlist } = makeGate({ approval });
    const tool = makeTool("write", "write");
    const call = makeCall("write", { path: "/x.ts", content: "y" });

    await gate.check(call, tool);
    await gate.check(call, tool);

    expect(approval.calls).toEqual(["write", "write"]);
    expect(allowlist.size).toBe(0);
  });

  test("'session' remembers so the second identical call does not prompt", async () => {
    const approval = scriptedApproval("session"); // only ONE response queued
    const { gate, allowlist } = makeGate({ approval });
    const tool = makeTool("write", "write");
    const call = makeCall("write", { path: "/x.ts", content: "y" });

    const first: Decision = await gate.check(call, tool);
    expect(first).toEqual({ allowed: true, remember: "session" });
    expect(allowlist.has("write:/x.ts")).toBe(true);

    // Second identical call: no prompt available, must come back from allowlist.
    const second = await gate.check(makeCall("write", { path: "/x.ts", content: "z" }), tool);
    expect(second).toEqual({ allowed: true });
    expect(approval.calls).toEqual(["write"]); // prompted only once
  });

  test("'session' for a different path still prompts", async () => {
    const approval = scriptedApproval("session", "deny");
    const { gate } = makeGate({ approval });
    const tool = makeTool("write", "write");

    await gate.check(makeCall("write", { path: "/a.ts", content: "x" }), tool);
    const second = await gate.check(makeCall("write", { path: "/b.ts", content: "x" }), tool);

    expect(second).toEqual({ allowed: false, reason: "denied by user" });
    expect(approval.calls).toEqual(["write", "write"]);
  });

  test("deny returns allowed:false with a reason", async () => {
    const approval = scriptedApproval("deny");
    const { gate } = makeGate({ approval });

    const decision = await gate.check(
      makeCall("bash", { command: "rm -rf /" }),
      makeTool("bash", "exec"),
    );

    expect(decision).toEqual({ allowed: false, reason: "denied by user" });
    expect(approval.calls).toEqual(["bash"]);
  });

  test("bash command in config.allowCommands auto-allows without prompting", async () => {
    const approval = scriptedApproval(); // empty: any prompt throws
    const { gate } = makeGate({
      config: { autoAllow: ["read"], allowCommands: ["npm test", "git status"] },
      approval,
    });

    const decision = await gate.check(
      makeCall("bash", { command: "npm test" }),
      makeTool("bash", "exec"),
    );

    expect(decision).toEqual({ allowed: true });
    expect(approval.calls).toEqual([]);
  });

  test("allowCommands matches after whitespace normalization", async () => {
    const approval = scriptedApproval();
    const { gate } = makeGate({
      config: { autoAllow: ["read"], allowCommands: ["npm test"] },
      approval,
    });

    const decision = await gate.check(
      makeCall("bash", { command: "npm    test  " }),
      makeTool("bash", "exec"),
    );
    expect(decision).toEqual({ allowed: true });
    expect(approval.calls).toEqual([]);
  });

  test("bash command NOT in allowCommands prompts", async () => {
    const approval = scriptedApproval("once");
    const { gate } = makeGate({
      config: { autoAllow: ["read"], allowCommands: ["npm test"] },
      approval,
    });

    const decision = await gate.check(
      makeCall("bash", { command: "rm -rf node_modules" }),
      makeTool("bash", "exec"),
    );
    expect(decision).toEqual({ allowed: true });
    expect(approval.calls).toEqual(["bash"]);
  });

  test("autoAllow can include exec to silence all bash prompts", async () => {
    const approval = scriptedApproval();
    const { gate } = makeGate({
      config: { autoAllow: ["read", "exec"], allowCommands: [] },
      approval,
    });

    const decision = await gate.check(
      makeCall("bash", { command: "anything" }),
      makeTool("bash", "exec"),
    );
    expect(decision).toEqual({ allowed: true });
    expect(approval.calls).toEqual([]);
  });

  test("a throwing preview() does not block the gate", async () => {
    const approval = scriptedApproval("once");
    const { gate } = makeGate({ approval });
    const tool = makeTool("write", "write");
    tool.preview = () => {
      throw new Error("boom");
    };

    const decision = await gate.check(makeCall("write", { path: "/x.ts" }), tool);
    expect(decision).toEqual({ allowed: true });
    expect(approval.calls).toEqual(["write"]);
  });

  test("pre-seeded allowlist hit skips the prompt", async () => {
    const approval = scriptedApproval();
    const allowlist = new Set<string>(["write:/x.ts"]);
    const { gate } = makeGate({ approval, allowlist });

    const decision = await gate.check(
      makeCall("write", { path: "/x.ts", content: "q" }),
      makeTool("write", "write"),
    );
    expect(decision).toEqual({ allowed: true });
    expect(approval.calls).toEqual([]);
  });
});
