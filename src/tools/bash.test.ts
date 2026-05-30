/**
 * Tests for the bash tool (spec tools.html §08).
 *
 * These run real, short, offline shell commands — no network, no API keys.
 * Timeouts are kept tiny so the suite stays fast and deterministic.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolContext } from "../core/types.ts";
import { nullLogger } from "../util/logger.ts";
import { bashTool, bashSchema } from "./bash.ts";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    log: nullLogger(),
    readSet: new Set<string>(),
    ...overrides,
  };
}

describe("bashSchema", () => {
  test("materializes default timeout_ms", () => {
    const parsed = bashSchema.parse({ command: "echo hi" });
    expect(parsed.timeout_ms).toBe(120_000);
    expect(parsed.cwd).toBeUndefined();
  });

  test("rejects timeout_ms out of range", () => {
    expect(bashSchema.safeParse({ command: "x", timeout_ms: 0 }).success).toBe(false);
    expect(bashSchema.safeParse({ command: "x", timeout_ms: 600_001 }).success).toBe(false);
    expect(bashSchema.safeParse({ command: "x", timeout_ms: 1.5 }).success).toBe(false);
  });

  test("requires command", () => {
    expect(bashSchema.safeParse({}).success).toBe(false);
  });
});

describe("preview", () => {
  test("prefixes bash and collapses whitespace", () => {
    expect(bashTool.preview({ command: "npm  test", timeout_ms: 1000 })).toBe("bash npm test");
  });

  test("collapses newlines to one line", () => {
    expect(
      bashTool.preview({ command: "echo a\necho b", timeout_ms: 1000 }),
    ).toBe("bash echo a echo b");
  });

  test("caps long commands at 80 chars with ellipsis", () => {
    const long = "x".repeat(200);
    const out = bashTool.preview({ command: long, timeout_ms: 1000 });
    expect(out.startsWith("bash ")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    // "bash " (5) + 80 chars + "…"
    expect(out.length).toBe(5 + 80 + 1);
  });
});

describe("metadata", () => {
  test("static fields", () => {
    expect(bashTool.name).toBe("bash");
    expect(bashTool.permission).toBe("exec");
  });
});

describe("run", () => {
  test("echo command -> ok:true, content has output, exitCode 0", async () => {
    const res = await bashTool.run({ command: "echo hello-world", timeout_ms: 5000 }, makeCtx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain("hello-world");
    expect(res.error).toBeUndefined();
    expect(res.meta?.exitCode).toBe(0);
    expect(res.meta?.signal).toBeNull();
    expect(res.meta?.command).toBe("echo hello-world");
    expect(res.meta?.truncated).toBe(false);
    expect(typeof res.meta?.durationMs).toBe("number");
  });

  test("streams output chunks to ctx.emit", async () => {
    const chunks: string[] = [];
    const ctx = makeCtx({ emit: (c) => chunks.push(c) });
    const res = await bashTool.run({ command: "echo streamed", timeout_ms: 5000 }, ctx);
    expect(res.ok).toBe(true);
    expect(chunks.join("")).toContain("streamed");
  });

  test("captures stderr interleaved into content", async () => {
    const res = await bashTool.run(
      { command: "echo to-stderr 1>&2", timeout_ms: 5000 },
      makeCtx(),
    );
    expect(res.ok).toBe(true);
    expect(res.content).toContain("to-stderr");
  });

  test("uses input.cwd over ctx.cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-bash-"));
    const res = await bashTool.run({ command: "pwd", cwd: dir, timeout_ms: 5000 }, makeCtx());
    expect(res.ok).toBe(true);
    // macOS /tmp is symlinked to /private/tmp; match on the unique suffix.
    const leaf = dir.split("/").pop()!;
    expect(res.content).toContain(leaf);
    expect(res.meta?.cwd).toBe(dir);
  });

  test("'exit 3' -> ok:false, error names code, exitCode 3", async () => {
    const res = await bashTool.run({ command: "exit 3", timeout_ms: 5000 }, makeCtx());
    expect(res.ok).toBe(false);
    expect(res.error).toBe("exited with code 3");
    expect(res.meta?.exitCode).toBe(3);
    expect(res.meta?.signal).toBeNull();
  });

  test("non-zero exit preserves output in content", async () => {
    const res = await bashTool.run(
      { command: "echo before-fail; exit 1", timeout_ms: 5000 },
      makeCtx(),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("exited with code 1");
    expect(res.content).toContain("before-fail");
  });

  test("timeout -> ok:false, timed out message, SIGTERM in meta", async () => {
    const res = await bashTool.run({ command: "sleep 5", timeout_ms: 50 }, makeCtx());
    expect(res.ok).toBe(false);
    expect(res.error).toBe("timed out after 50ms");
    expect(res.meta?.signal).toBe("SIGTERM");
    expect(res.meta?.exitCode).toBeNull();
  });

  test("abort mid-run -> ok:false aborted", async () => {
    const ac = new AbortController();
    const ctx = makeCtx({ signal: ac.signal });
    const promise = bashTool.run({ command: "sleep 5", timeout_ms: 5000 }, ctx);
    // Abort shortly after the process is spawned.
    setTimeout(() => ac.abort(), 50);
    const res = await promise;
    expect(res.ok).toBe(false);
    expect(res.error).toBe("aborted");
    expect(res.meta?.signal).toBe("SIGTERM");
  });

  test("already-aborted signal -> ok:false aborted without spawning", async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await bashTool.run({ command: "echo nope", timeout_ms: 5000 }, makeCtx({ signal: ac.signal }));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("aborted");
    expect(res.meta?.durationMs).toBe(0);
  });
});
