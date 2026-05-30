import { describe, expect, test } from "bun:test";

import type { AgentEvent, Decision } from "../core/types.ts";
import { ToolResult } from "../core/types.ts";
import { decisionToResponse, toDecision } from "./frontend.ts";
import { keyToResponse, StdoutFrontend } from "./stdout.ts";

// ── Test harness ──────────────────────────────────────────────────────────────

/** A scripted AsyncIterable<AgentEvent> built from a plain array. */
async function* scripted(events: AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const ev of events) yield ev;
}

/** A capture sink: records every write and exposes the joined output. */
function captureSink(): { write: (s: string) => void; text: () => string; lines: () => string[] } {
  const chunks: string[] = [];
  return {
    write: (s) => void chunks.push(s),
    text: () => chunks.join(""),
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((l) => l.length > 0),
  };
}

/** Drive a fresh StdoutFrontend with captured out/err and an optional readKey. */
function harness(opts?: { readKey?: (prompt: string) => Promise<string> }) {
  const out = captureSink();
  const err = captureSink();
  const fe = new StdoutFrontend({
    out: out.write,
    err: err.write,
    ...(opts?.readKey ? { readKey: opts.readKey } : {}),
  });
  return { fe, out, err };
}

// ── render(): text streaming ───────────────────────────────────────────────────

describe("render — text", () => {
  test("text.delta writes raw text; text.done appends a newline", async () => {
    const { fe, out } = harness();
    await fe.render(
      scripted([
        { type: "text.delta", text: "Hello" },
        { type: "text.delta", text: ", world" },
        { type: "text.done", text: "Hello, world" },
      ]),
    );
    expect(out.text()).toBe("Hello, world\n");
  });
});

// ── render(): tool lifecycle ────────────────────────────────────────────────────

describe("render — tools", () => {
  test("tool.start and tool.result both render lines", async () => {
    const { fe, out } = harness();
    await fe.render(
      scripted([
        { type: "tool.start", id: "t1", name: "read", input: { path: "src/x.ts" } },
        { type: "tool.result", id: "t1", output: ToolResult.ok("142 lines") },
      ]),
    );
    const text = out.text();
    expect(text).toContain("[tool] read");
    expect(text).toContain('"path":"src/x.ts"');
    expect(text).toContain("[result] ok: 142 lines");
  });

  test("failed tool.result renders ERR with the error detail", async () => {
    const { fe, out } = harness();
    await fe.render(
      scripted([
        { type: "tool.result", id: "t2", output: ToolResult.error("file not found") },
      ]),
    );
    expect(out.text()).toContain("[result] ERR: file not found");
  });
});

// ── render(): approval flow ─────────────────────────────────────────────────────

describe("render — approval", () => {
  test("fake readKey 'a' resolves onApproval with a session Decision", async () => {
    const prompts: string[] = [];
    const { fe, out } = harness({
      readKey: async (prompt) => {
        prompts.push(prompt);
        return "a";
      },
    });

    const captured: Array<{ id: string; decision: Decision }> = [];
    fe.onApproval = (id, decision) => void captured.push({ id, decision });

    await fe.render(
      scripted([
        { type: "approval.request", id: "appr_1", tool: "edit", preview: "edit src/x.ts" },
      ]),
    );

    // onApproval fired once with the request id and a "session" decision.
    expect(captured).toHaveLength(1);
    expect(captured[0]!.id).toBe("appr_1");
    expect(captured[0]!.decision).toEqual({ allowed: true, remember: "session" });
    expect(decisionToResponse(captured[0]!.decision)).toBe("session");

    // The prompt carried the tool name + preview; nothing leaked to err.
    expect(prompts[0]).toContain("edit");
    expect(prompts[0]).toContain("src/x.ts");
    // render() itself wrote nothing to stdout for a bare approval (the injected
    // readKey owns the prompt), so out stays empty here.
    expect(out.text()).toBe("");
  });

  test("readKey 'y' → once, 'n' → deny", async () => {
    for (const [key, expected] of [
      ["y", { allowed: true }],
      ["n", { allowed: false, reason: "denied by user" }],
    ] as const) {
      const { fe } = harness({ readKey: async () => key });
      const captured: Decision[] = [];
      fe.onApproval = (_id, decision) => void captured.push(decision);
      await fe.render(
        scripted([{ type: "approval.request", id: "x", tool: "bash", preview: "ls" }]),
      );
      expect(captured[0]).toEqual(expected);
    }
  });

  test("approval with no onApproval registered does not throw", async () => {
    const { fe } = harness({ readKey: async () => "y" });
    // onApproval intentionally left undefined.
    await expect(
      fe.render(
        scripted([{ type: "approval.request", id: "x", tool: "bash", preview: "ls" }]),
      ),
    ).resolves.toBeUndefined();
  });
});

// ── render(): turn.done ─────────────────────────────────────────────────────────

describe("render — turn.done", () => {
  test("renders stopReason and inputTokens/outputTokens", async () => {
    const { fe, out } = harness();
    await fe.render(
      scripted([
        {
          type: "turn.done",
          stopReason: "end",
          usage: { inputTokens: 1200, outputTokens: 340 },
        },
      ]),
    );
    const text = out.text();
    expect(text).toContain("[done] end");
    expect(text).toContain("1200/340 tok");
  });
});

// ── render(): error ─────────────────────────────────────────────────────────────

describe("render — error", () => {
  test("error event is handled without throwing and goes to err, not out", async () => {
    const { fe, out, err } = harness();
    await expect(
      fe.render(
        scripted([{ type: "error", message: "boom", fatal: true }]),
      ),
    ).resolves.toBeUndefined();
    expect(err.text()).toContain("[error] boom");
    expect(err.text()).toContain("(fatal)");
    // The error must never corrupt the rendered stdout stream.
    expect(out.text()).toBe("");
  });
});

// ── A full interleaved turn (smoke) ─────────────────────────────────────────────

describe("render — full turn", () => {
  test("text + tool + approval + done render in order", async () => {
    const { fe, out } = harness({ readKey: async () => "a" });
    const captured: Array<{ id: string; decision: Decision }> = [];
    fe.onApproval = (id, decision) => void captured.push({ id, decision });

    await fe.render(
      scripted([
        { type: "text.delta", text: "Reading the parser" },
        { type: "text.done", text: "Reading the parser" },
        { type: "tool.start", id: "r1", name: "read", input: { path: "p.ts" } },
        { type: "tool.result", id: "r1", output: ToolResult.ok("ok") },
        { type: "approval.request", id: "a1", tool: "edit", preview: "edit p.ts" },
        { type: "tool.start", id: "e1", name: "edit", input: { path: "p.ts" } },
        { type: "tool.result", id: "e1", output: ToolResult.ok("applied") },
        {
          type: "turn.done",
          stopReason: "end",
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      ]),
    );

    const lines = out.lines();
    expect(lines).toEqual([
      "Reading the parser",
      '[tool] read {"path":"p.ts"}',
      "[result] ok: ok",
      '[tool] edit {"path":"p.ts"}',
      "[result] ok: applied",
      "[done] end 10/5 tok",
    ]);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.decision).toEqual({ allowed: true, remember: "session" });
  });
});

// ── mount / dispose ─────────────────────────────────────────────────────────────

describe("mount / dispose", () => {
  test("mount prints a banner via the out sink and dispose resolves", async () => {
    const { fe, out } = harness();
    await fe.mount();
    expect(out.text()).toContain("om-cli");
    await expect(fe.dispose()).resolves.toBeUndefined();
  });
});

// ── helper unit tests ───────────────────────────────────────────────────────────

describe("helpers", () => {
  test("keyToResponse maps keys case-insensitively, default deny", () => {
    expect(keyToResponse("y")).toBe("once");
    expect(keyToResponse("Y")).toBe("once");
    expect(keyToResponse("a")).toBe("session");
    expect(keyToResponse("A")).toBe("session");
    expect(keyToResponse("n")).toBe("deny");
    expect(keyToResponse("q")).toBe("deny");
    expect(keyToResponse("")).toBe("deny");
  });

  test("toDecision / decisionToResponse round-trip", () => {
    for (const r of ["once", "session", "deny"] as const) {
      expect(decisionToResponse(toDecision(r))).toBe(r);
    }
  });
});
