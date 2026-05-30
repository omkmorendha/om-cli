/**
 * Tests for the tool registry (spec tools.html §13).
 *
 * Hermetic: no network, no API keys. Filesystem-touching built-ins (read/write)
 * are exercised against a temp dir; the dispatch/validation/throw semantics use
 * tiny fake tools so they never touch disk or spawn processes.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type { Tool, ToolContext, ToolResult } from "../core/types.ts";
import { ToolResult as TR } from "../core/types.ts";
import { nullLogger } from "../util/logger.ts";
import {
  ToolRegistry,
  defaultRegistry,
  formatZodError,
  normalizeError,
} from "./registry.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: overrides.cwd ?? process.cwd(),
    signal: overrides.signal ?? new AbortController().signal,
    log: overrides.log ?? nullLogger(),
    readSet: overrides.readSet ?? new Set<string>(),
    emit: overrides.emit,
  };
}

/** A fake tool whose run() echoes its validated input — for dispatch tests. */
const echoSchema = z.object({
  value: z.string().describe("the value to echo"),
  times: z.number().int().min(1).default(1),
});
const echoTool: Tool<z.infer<typeof echoSchema>> = {
  name: "echo",
  description: "Echo the input value.",
  schema: echoSchema,
  permission: "read",
  preview: (i) => `echo ${i.value}`,
  async run(input): Promise<ToolResult> {
    return TR.ok(input.value.repeat(input.times), { times: input.times });
  },
};

/** A fake tool that always throws a plain Error — for the catch path. */
const boomTool: Tool<{ x: number }> = {
  name: "boom",
  description: "Always throws.",
  schema: z.object({ x: z.number() }),
  permission: "read",
  preview: () => "boom",
  async run(): Promise<ToolResult> {
    throw new Error("kaboom\nsecond line that must not leak");
  },
};

/** A fake tool that throws an object with an errno-style code. */
const enoentTool: Tool<{ p: string }> = {
  name: "enoent",
  description: "Throws an ENOENT.",
  schema: z.object({ p: z.string() }),
  permission: "read",
  preview: () => "enoent",
  async run(): Promise<ToolResult> {
    const err = Object.assign(new Error("ENOENT: no such file"), {
      code: "ENOENT",
      path: "/nope.txt",
    });
    throw err;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// specs()
// ─────────────────────────────────────────────────────────────────────────────

describe("specs()", () => {
  test("returns one JSON-schema'd ToolSpec per registered tool", () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);
    reg.register(boomTool);

    const specs = reg.specs();
    expect(specs).toHaveLength(2);

    const echo = specs.find((s) => s.name === "echo");
    expect(echo).toBeDefined();
    expect(echo!.description).toBe("Echo the input value.");
    // parameters is the JSON Schema produced from the zod schema.
    expect(echo!.parameters.type).toBe("object");
    const props = echo!.parameters.properties as Record<string, any>;
    expect(props.value.type).toBe("string");
    expect(props.value.description).toBe("the value to echo");
    expect(props.times.type).toBe("integer");
    // zod 4's toJSONSchema emits a default-bearing field as `required` but also
    // surfaces the `default` value, so the registry materializes it at parse time.
    expect(props.times.default).toBe(1);
    expect(echo!.parameters.required).toEqual(["value", "times"]);
  });

  test("defaultRegistry exposes the built-in tools with valid schemas", () => {
    const reg = defaultRegistry();
    const names = reg.specs().map((s) => s.name).sort();
    expect(names).toEqual(["bash", "edit", "glob", "grep", "ls", "read", "write"]);

    for (const spec of reg.specs()) {
      expect(typeof spec.name).toBe("string");
      expect(typeof spec.description).toBe("string");
      expect(spec.parameters.type).toBe("object");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// get() / list() / register()
// ─────────────────────────────────────────────────────────────────────────────

describe("get/list/register", () => {
  test("get returns the registered tool, undefined otherwise", () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);
    expect(reg.get("echo")).toBe(echoTool as unknown as Tool<unknown>);
    expect(reg.get("missing")).toBeUndefined();
  });

  test("list returns all tools in registration order", () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);
    reg.register(boomTool);
    expect(reg.list().map((t) => t.name)).toEqual(["echo", "boom"]);
  });

  test("re-registering the same name overwrites", () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);
    const replacement: Tool<{ value: string; times: number }> = {
      ...echoTool,
      description: "replaced",
    };
    reg.register(replacement);
    expect(reg.list()).toHaveLength(1);
    expect(reg.get("echo")!.description).toBe("replaced");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// run() — dispatch + validation + catch
// ─────────────────────────────────────────────────────────────────────────────

describe("run()", () => {
  test("dispatches to the tool with validated, default-materialized input", async () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);

    const res = await reg.run({ id: "1", name: "echo", input: { value: "ab", times: 3 } }, makeCtx());
    expect(res.ok).toBe(true);
    expect(res.content).toBe("ababab");
    expect(res.meta?.times).toBe(3);
  });

  test("materializes schema defaults before run()", async () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);

    // No `times` supplied -> default of 1 is materialized by the registry.
    const res = await reg.run({ id: "1", name: "echo", input: { value: "x" } }, makeCtx());
    expect(res.ok).toBe(true);
    expect(res.content).toBe("x");
    expect(res.meta?.times).toBe(1);
  });

  test("unknown tool -> ok:false naming the tool, never throws", async () => {
    const reg = new ToolRegistry();
    const res = await reg.run({ id: "1", name: "nope", input: {} }, makeCtx());
    expect(res.ok).toBe(false);
    expect(res.error).toBe("unknown tool: nope");
  });

  test("invalid input -> ok:false naming the offending field + meta.validation", async () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);

    // `value` should be a string; pass a number.
    const res = await reg.run({ id: "1", name: "echo", input: { value: 42 } }, makeCtx());
    expect(res.ok).toBe(false);
    expect(res.error).toContain("invalid input for echo:");
    expect(res.error).toContain("value");
    // meta.validation carries the raw zod issues for programmatic use.
    expect(Array.isArray(res.meta?.validation)).toBe(true);
    expect((res.meta!.validation as any[]).length).toBeGreaterThan(0);
  });

  test("a throwing tool is caught -> ok:false, no stack/multiline leak", async () => {
    const reg = new ToolRegistry();
    reg.register(boomTool);

    const res = await reg.run({ id: "1", name: "boom", input: { x: 1 } }, makeCtx());
    expect(res.ok).toBe(false);
    // Only the first line of the message surfaces to the model.
    expect(res.error).toBe("kaboom");
    expect(res.content).not.toContain("second line");
  });

  test("an errno-coded throw is normalized to a friendly message", async () => {
    const reg = new ToolRegistry();
    reg.register(enoentTool);

    const res = await reg.run({ id: "1", name: "enoent", input: { p: "x" } }, makeCtx());
    expect(res.ok).toBe(false);
    expect(res.error).toBe("file not found: /nope.txt");
  });

  test("validation runs before run() — a throwing tool with bad input never executes", async () => {
    const reg = new ToolRegistry();
    reg.register(boomTool);

    // boom.schema requires { x: number }; pass a string so we short-circuit at
    // validation rather than reaching the throwing run().
    const res = await reg.run({ id: "1", name: "boom", input: { x: "nope" } }, makeCtx());
    expect(res.ok).toBe(false);
    expect(res.error).toContain("invalid input for boom:");
    expect(res.error).toContain("x");
    expect(res.error).not.toBe("kaboom");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// run() against real built-in tools (hermetic, temp dir)
// ─────────────────────────────────────────────────────────────────────────────

describe("run() with built-in tools", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "om-registry-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("write then read round-trips through the registry", async () => {
    const reg = defaultRegistry();
    const ctx = makeCtx({ cwd: dir });
    const path = join(dir, "hello.txt");

    const w = await reg.run({ id: "1", name: "write", input: { path, content: "hi there" } }, ctx);
    expect(w.ok).toBe(true);

    const r = await reg.run({ id: "2", name: "read", input: { path } }, ctx);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("hi there");
    // read records the path in the readSet (edit prerequisite).
    expect(ctx.readSet.has(path)).toBe(true);
  });

  test("a real tool's expected failure surfaces as ok:false (not a throw)", async () => {
    const reg = defaultRegistry();
    const ctx = makeCtx({ cwd: dir });
    const missing = join(dir, "does-not-exist.txt");

    const r = await reg.run({ id: "1", name: "read", input: { path: missing } }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("file not found");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// helper units
// ─────────────────────────────────────────────────────────────────────────────

describe("formatZodError", () => {
  test("names a top-level field path", () => {
    const r = z.object({ a: z.string() }).safeParse({ a: 1 });
    expect(r.success).toBe(false);
    if (!r.success) expect(formatZodError(r.error)).toContain("a:");
  });

  test("renders nested + array paths legibly", () => {
    const schema = z.object({ items: z.array(z.object({ n: z.number() })) });
    const r = schema.safeParse({ items: [{ n: "bad" }] });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = formatZodError(r.error);
      expect(msg).toContain("items[0].n");
    }
  });

  test("a path-less refine issue renders as just the message", () => {
    const schema = z.string().refine(() => false, { message: "must be valid" });
    const r = schema.safeParse("x");
    expect(r.success).toBe(false);
    if (!r.success) expect(formatZodError(r.error)).toBe("must be valid");
  });
});

describe("normalizeError", () => {
  test("maps errno codes", () => {
    expect(normalizeError(Object.assign(new Error("x"), { code: "ENOENT", path: "/a" }))).toBe(
      "file not found: /a",
    );
    expect(normalizeError(Object.assign(new Error("x"), { code: "EACCES", path: "/a" }))).toBe(
      "permission denied: /a",
    );
    expect(normalizeError(Object.assign(new Error("x"), { code: "EISDIR" }))).toBe(
      "path is a directory",
    );
  });

  test("maps AbortError to 'aborted'", () => {
    const e = new Error("the op was aborted");
    e.name = "AbortError";
    expect(normalizeError(e)).toBe("aborted");
  });

  test("a plain Error yields its first line only", () => {
    expect(normalizeError(new Error("boom\nstack frame\nmore"))).toBe("boom");
  });

  test("a non-Error throw is stringified, first line only", () => {
    expect(normalizeError("plain string\nignored")).toBe("plain string");
    expect(normalizeError(null)).toBe("unknown error");
  });
});
