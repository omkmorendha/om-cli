/**
 * Smoke test for the OpenTUI `TuiFrontend`.
 *
 * The TUI needs a real TTY to mount (createCliRenderer attaches to stdin/stdout
 * and the native terminal), so it cannot be exercised end-to-end in CI. This
 * test deliberately stays *below* mount(): it imports the module, constructs the
 * class, and asserts the `Frontend` contract shape. Every renderer touch in
 * tui.ts is guarded behind mount(), so construction alone must be inert and
 * side-effect-free — that invariant is what this test pins.
 *
 * The full event→render behavior is covered by the headless StdoutFrontend
 * (stdout.test.ts), which shares the same AgentEvent mapping and approval seam.
 */

import { describe, expect, test } from "bun:test";
import { TuiFrontend } from "./tui.ts";
import type { Frontend } from "./frontend.ts";
import { nullLogger } from "../util/logger.ts";

describe("TuiFrontend (construction smoke)", () => {
  test("constructs without a TTY and never touches the renderer", () => {
    // Must not throw: construction is inert; no createCliRenderer, no stdin/out.
    const tui = new TuiFrontend({
      cwd: "/tmp/project",
      providerLabel: "anthropic · sonnet",
      log: nullLogger(),
    });
    expect(tui).toBeInstanceOf(TuiFrontend);
  });

  test("constructs with no options (all defaults)", () => {
    const tui = new TuiFrontend();
    expect(tui).toBeInstanceOf(TuiFrontend);
  });

  test("exposes the Frontend interface shape", () => {
    const tui = new TuiFrontend({ log: nullLogger() });
    // Structural conformance: the four methods/callbacks main.ts depends on.
    expect(typeof tui.mount).toBe("function");
    expect(typeof tui.render).toBe("function");
    expect(typeof tui.dispose).toBe("function");
    // onSubmit / onApproval are assignable callbacks (registered by main.ts).
    expect(tui.onSubmit).toBeUndefined();
    expect(tui.onApproval).toBeUndefined();

    // Assigning the callbacks type-checks against the Frontend interface.
    const asFrontend: Frontend = tui;
    asFrontend.onSubmit = (_text, _signal) => {};
    asFrontend.onApproval = (_id, _decision) => {};
    expect(typeof asFrontend.onSubmit).toBe("function");
    expect(typeof asFrontend.onApproval).toBe("function");
  });

  test("dispose() before mount() is a safe no-op", async () => {
    const tui = new TuiFrontend({ log: nullLogger() });
    // No renderer was ever created, so dispose must resolve without throwing.
    await expect(tui.dispose()).resolves.toBeUndefined();
    // Idempotent: a second dispose is also fine.
    await expect(tui.dispose()).resolves.toBeUndefined();
  });

  test("render() before mount() drains the stream without UI side effects", async () => {
    const tui = new TuiFrontend({ log: nullLogger() });
    let onApprovalCalls = 0;
    tui.onApproval = () => {
      onApprovalCalls++;
    };

    async function* events() {
      yield { type: "text.delta", text: "hello" } as const;
      yield { type: "text.done", text: "hello" } as const;
      yield {
        type: "tool.start",
        id: "t1",
        name: "read",
        input: { path: "/x" },
      } as const;
      yield {
        type: "tool.result",
        id: "t1",
        output: { ok: true, content: "done" },
      } as const;
      yield {
        type: "turn.done",
        stopReason: "end",
        usage: { inputTokens: 10, outputTokens: 5 },
      } as const;
    }

    // Pre-mount, UI mutations no-op but the stream is fully consumed and
    // resolves — so the main.ts driver loop never deadlocks.
    await expect(tui.render(events())).resolves.toBeUndefined();
    // No approval.request in the stream, so onApproval was never invoked.
    expect(onApprovalCalls).toBe(0);
  });
});
