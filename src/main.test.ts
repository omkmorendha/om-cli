/**
 * Unit tests for main.ts's pure wiring helpers.
 *
 * We test ONLY the exported, side-effect-free pieces: argv parsing, the
 * frontend-selection predicate, the override projection, and the approval seam
 * (ApprovalMux + mergeTurn + decisionToResponse round-trip). We never boot the
 * real app, construct a provider, or touch the network/TTY — `main()` itself
 * is intentionally not exercised here.
 */

import { describe, expect, test } from "bun:test";

import type { AgentEvent } from "./core/types.ts";
import type { ApprovalRequest } from "./permission/gate.ts";
import { decisionToResponse, toDecision } from "./tui/frontend.ts";
import {
  ApprovalMux,
  mergeTurn,
  overridesFromArgs,
  parseArgv,
  useTuiFrontend,
} from "./main.ts";

// ── argv parsing ────────────────────────────────────────────────────────────

describe("parseArgv", () => {
  test("empty argv yields all-default flags", () => {
    const a = parseArgv([]);
    expect(a).toEqual({ headless: false, tui: false, help: false });
  });

  test("--help / -h set help", () => {
    expect(parseArgv(["--help"]).help).toBe(true);
    expect(parseArgv(["-h"]).help).toBe(true);
  });

  test("--headless and --tui are bare booleans", () => {
    const a = parseArgv(["--headless", "--tui"]);
    expect(a.headless).toBe(true);
    expect(a.tui).toBe(true);
  });

  test("--provider value form", () => {
    expect(parseArgv(["--provider", "openai"]).provider).toBe("openai");
    expect(parseArgv(["--provider", "anthropic"]).provider).toBe("anthropic");
  });

  test("--provider=value inline form", () => {
    expect(parseArgv(["--provider=openai"]).provider).toBe("openai");
  });

  test("invalid --provider records an error and leaves provider unset", () => {
    const a = parseArgv(["--provider", "gemini"]);
    expect(a.provider).toBeUndefined();
    expect(a.error).toContain("gemini");
  });

  test("--provider with no value records an error", () => {
    const a = parseArgv(["--provider"]);
    expect(a.provider).toBeUndefined();
    expect(a.error).toContain("--provider");
  });

  test("--provider followed by another flag treats the flag as missing value", () => {
    const a = parseArgv(["--provider", "--headless"]);
    expect(a.provider).toBeUndefined();
    expect(a.error).toBeDefined();
    // The --headless that followed is still consumed as a boolean flag.
    expect(a.headless).toBe(true);
  });

  test("--model value and inline forms", () => {
    expect(parseArgv(["--model", "claude-x"]).model).toBe("claude-x");
    expect(parseArgv(["--model=gpt-9"]).model).toBe("gpt-9");
  });

  test("--model with no value records an error", () => {
    const a = parseArgv(["--model"]);
    expect(a.model).toBeUndefined();
    expect(a.error).toContain("--model");
  });

  test("unknown flag records an error; bare positionals are ignored", () => {
    expect(parseArgv(["--nope"]).error).toContain("--nope");
    expect(parseArgv(["just-some-text"]).error).toBeUndefined();
  });

  test("combined flags parse together", () => {
    const a = parseArgv(["--provider", "openai", "--model", "gpt-9", "--headless"]);
    expect(a).toEqual({
      provider: "openai",
      model: "gpt-9",
      headless: true,
      tui: false,
      help: false,
    });
  });
});

// ── overridesFromArgs ───────────────────────────────────────────────────────

describe("overridesFromArgs", () => {
  test("projects only the set fields", () => {
    expect(overridesFromArgs(parseArgv([]))).toEqual({});
    expect(overridesFromArgs(parseArgv(["--provider", "openai"]))).toEqual({
      provider: "openai",
    });
    expect(overridesFromArgs(parseArgv(["--model", "m"]))).toEqual({ model: "m" });
    expect(
      overridesFromArgs(parseArgv(["--provider", "anthropic", "--model", "m"])),
    ).toEqual({ provider: "anthropic", model: "m" });
  });
});

// ── useTuiFrontend ──────────────────────────────────────────────────────────

describe("useTuiFrontend", () => {
  const base = parseArgv([]);

  test("--headless forces stdout even with a TTY and --tui", () => {
    expect(useTuiFrontend(parseArgv(["--headless", "--tui"]), true)).toBe(false);
  });

  test("no TTY always falls back to stdout", () => {
    expect(useTuiFrontend(parseArgv(["--tui"]), false)).toBe(false);
  });

  test("TUI only when --tui AND a TTY are present", () => {
    expect(useTuiFrontend(parseArgv(["--tui"]), true)).toBe(true);
    expect(useTuiFrontend(base, true)).toBe(false); // no --tui ⇒ headless default
  });
});

// ── decisionToResponse round-trip ───────────────────────────────────────────

describe("decisionToResponse mapping", () => {
  test("maps each Decision back to its ApprovalResponse", () => {
    expect(decisionToResponse({ allowed: true })).toBe("once");
    expect(decisionToResponse({ allowed: true, remember: "session" })).toBe("session");
    expect(decisionToResponse({ allowed: false, reason: "denied by user" })).toBe("deny");
  });

  test("toDecision ∘ decisionToResponse is identity on the three responses", () => {
    for (const r of ["once", "session", "deny"] as const) {
      expect(decisionToResponse(toDecision(r))).toBe(r);
    }
  });
});

// ── ApprovalMux ─────────────────────────────────────────────────────────────

const sampleReq = (id: string): ApprovalRequest => ({
  id,
  tool: "bash",
  preview: `run ${id}`,
});

describe("ApprovalMux", () => {
  test("push before next: next resolves with the buffered approval event", async () => {
    const mux = new ApprovalMux();
    mux.push(sampleReq("a1"));
    const ev = await mux.next();
    expect(ev).toEqual({ type: "approval.request", id: "a1", tool: "bash", preview: "run a1" });
  });

  test("next before push: a parked consumer resolves when push arrives", async () => {
    const mux = new ApprovalMux();
    const pending = mux.next();
    mux.push(sampleReq("a2"));
    const ev = await pending;
    expect(ev?.type).toBe("approval.request");
    if (ev?.type === "approval.request") expect(ev.id).toBe("a2");
  });

  test("close resolves a parked consumer with null", async () => {
    const mux = new ApprovalMux();
    const pending = mux.next();
    mux.close();
    expect(await pending).toBeNull();
  });

  test("next after close (and drained) returns null", async () => {
    const mux = new ApprovalMux();
    mux.close();
    expect(await mux.next()).toBeNull();
  });

  test("buffered events still drain after close", async () => {
    const mux = new ApprovalMux();
    mux.push(sampleReq("a3"));
    mux.close();
    const first = await mux.next();
    expect(first?.type).toBe("approval.request");
    expect(await mux.next()).toBeNull();
  });

  test("push after close is a no-op", async () => {
    const mux = new ApprovalMux();
    mux.close();
    mux.push(sampleReq("late"));
    expect(await mux.next()).toBeNull();
  });
});

// ── mergeTurn ───────────────────────────────────────────────────────────────

/** A scripted loop generator built from a fixed event array. */
async function* scriptedLoop(events: AgentEvent[]): AsyncGenerator<AgentEvent> {
  for (const ev of events) yield ev;
}

/** Drain a merged stream into an array. */
async function drain(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe("mergeTurn", () => {
  test("passes loop events through when no approvals are pushed", async () => {
    const mux = new ApprovalMux();
    const events: AgentEvent[] = [
      { type: "text.delta", text: "hi" },
      { type: "text.done", text: "hi" },
      { type: "turn.done", stopReason: "end", usage: { inputTokens: 1, outputTokens: 2 } },
    ];
    const merged = await drain(mergeTurn(scriptedLoop(events), mux));
    expect(merged).toEqual(events);
  });

  test("a pushed approval.request appears in the merged stream", async () => {
    const mux = new ApprovalMux();

    // A loop that pushes an approval mid-flight, then waits for it to be
    // answered before completing — mimicking gate.check awaiting requestApproval.
    let resolveApproval: (() => void) | undefined;
    const approvalAnswered = new Promise<void>((r) => {
      resolveApproval = r;
    });

    async function* loop(): AsyncGenerator<AgentEvent> {
      yield { type: "tool.start", id: "t1", name: "bash", input: { command: "ls" } };
      mux.push(sampleReq("ap1"));
      await approvalAnswered; // block as the real gate would
      yield {
        type: "tool.result",
        id: "t1",
        output: { ok: true, content: "done" },
      };
      yield {
        type: "turn.done",
        stopReason: "end",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }

    const collected: AgentEvent[] = [];
    const merged = mergeTurn(loop(), mux);
    for await (const ev of merged) {
      collected.push(ev);
      // When the approval surfaces, "answer" it so the loop can proceed.
      if (ev.type === "approval.request") {
        expect(ev.id).toBe("ap1");
        resolveApproval?.();
      }
    }

    const types = collected.map((e) => e.type);
    expect(types).toContain("approval.request");
    expect(types).toContain("tool.result");
    // The approval surfaces before the result it gates.
    expect(types.indexOf("approval.request")).toBeLessThan(types.indexOf("tool.result"));
    expect(types[types.length - 1]).toBe("turn.done");
  });

  test("resolving via onApproval semantics settles the parked gate promise", async () => {
    // This mirrors the main.ts seam end-to-end without a real gate:
    //   requestApproval parks a resolver + pushes onto the mux; the merged
    //   stream surfaces the event; onApproval resolves the parked promise.
    const mux = new ApprovalMux();
    const pending = new Map<string, (r: import("./core/types.ts").ApprovalResponse) => void>();

    const requestApproval = (req: ApprovalRequest) =>
      new Promise<import("./core/types.ts").ApprovalResponse>((resolve) => {
        pending.set(req.id, resolve);
        mux.push(req);
      });

    const onApproval = (id: string, decision: import("./core/types.ts").Decision): void => {
      const resolve = pending.get(id);
      if (resolve) {
        pending.delete(id);
        resolve(decisionToResponse(decision));
      }
    };

    let gateResponse: import("./core/types.ts").ApprovalResponse | undefined;
    async function* loop(): AsyncGenerator<AgentEvent> {
      // gate.check would await requestApproval here.
      gateResponse = await requestApproval(sampleReq("seam1"));
      yield {
        type: "turn.done",
        stopReason: "end",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }

    for await (const ev of mergeTurn(loop(), mux)) {
      if (ev.type === "approval.request") {
        onApproval(ev.id, toDecision("session"));
      }
    }

    expect(gateResponse).toBe("session");
    expect(pending.size).toBe(0);
  });

  test("closing the loop terminates the merged stream even with a parked mux read", async () => {
    const mux = new ApprovalMux();
    // No approvals are ever pushed; the merged stream must still end when the
    // loop ends (the mux read is parked but mergeTurn closes it).
    const merged = await drain(
      mergeTurn(
        scriptedLoop([
          { type: "turn.done", stopReason: "end", usage: { inputTokens: 0, outputTokens: 0 } },
        ]),
        mux,
      ),
    );
    expect(merged.map((e) => e.type)).toEqual(["turn.done"]);
  });
});
