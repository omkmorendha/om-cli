/**
 * Unit tests for the pure, framework-free render helpers in frontend.ts.
 *
 * These shape a tool call's raw input/result into the compact strings the TUI's
 * tool cards display. They import no OpenTUI, so they are fully testable here —
 * which is exactly why this shaping lives in frontend.ts and not tui.ts. The
 * approval-mapping helpers (toDecision/decisionToResponse) are exercised by
 * stdout.test.ts; this file covers the new rich-card helpers.
 */

import { describe, expect, test } from "bun:test";
import { ToolResult } from "../core/types.ts";
import {
  diffLines,
  formatBytes,
  formatDuration,
  formatTokens,
  shortenPath,
  summarizeToolInput,
  summarizeToolResult,
} from "./frontend.ts";

const CWD = "/Users/me/projects/app";

describe("shortenPath", () => {
  test("strips a leading cwd to show in-project paths relative", () => {
    expect(shortenPath("/Users/me/projects/app/src/parser.ts", CWD)).toBe("src/parser.ts");
  });

  test("renders cwd itself as '.'", () => {
    expect(shortenPath("/Users/me/projects/app", CWD)).toBe(".");
  });

  test("leaves out-of-project absolute paths intact when short", () => {
    expect(shortenPath("/etc/hosts", CWD)).toBe("/etc/hosts");
  });

  test("elides the middle of very long paths, keeping first + tail", () => {
    const long = "/Users/me/projects/app/" + "a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p".replace(/\//g, "/deep-") + "/final.ts";
    const out = shortenPath(long, CWD, 30);
    expect(out.length).toBeLessThanOrEqual(31); // max + the leading ellipsis char
    expect(out).toContain("…");
    expect(out.endsWith("final.ts")).toBe(true);
  });

  test("does not shorten when already within max", () => {
    expect(shortenPath("src/x.ts", CWD, 48)).toBe("src/x.ts");
  });
});

describe("summarizeToolInput", () => {
  test("read with offset+limit shows a line range", () => {
    const out = summarizeToolInput("read", { path: `${CWD}/src/a.ts`, offset: 10, limit: 31 }, CWD);
    expect(out).toBe("src/a.ts · lines 10–40");
  });

  test("read without a range is just the path", () => {
    expect(summarizeToolInput("read", { path: `${CWD}/src/a.ts` }, CWD)).toBe("src/a.ts");
  });

  test("ls shows the directory (relative)", () => {
    expect(summarizeToolInput("ls", { path: `${CWD}/src` }, CWD)).toBe("src");
  });

  test("glob shows the pattern, with the scan dir when present", () => {
    expect(summarizeToolInput("glob", { pattern: "**/*.ts" }, CWD)).toBe("**/*.ts");
    expect(summarizeToolInput("glob", { pattern: "*.md", cwd: `${CWD}/docs` }, CWD)).toBe(
      "*.md · in docs",
    );
  });

  test("grep wraps the pattern in slashes and notes the path", () => {
    expect(summarizeToolInput("grep", { pattern: "TODO", path: `${CWD}/src` }, CWD)).toBe(
      "/TODO/ · in src",
    );
  });

  test("write shows the path and the encoded byte size", () => {
    const out = summarizeToolInput("write", { path: `${CWD}/new.ts`, content: "hello" }, CWD);
    expect(out).toBe("new.ts · 5 B");
  });

  test("edit shows just the path", () => {
    expect(
      summarizeToolInput("edit", { path: `${CWD}/src/a.ts`, old_string: "a", new_string: "b" }, CWD),
    ).toBe("src/a.ts");
  });

  test("bash shows the command, with the cwd when overridden", () => {
    expect(summarizeToolInput("bash", { command: "bun test" }, CWD)).toBe("bun test");
    expect(summarizeToolInput("bash", { command: "ls", cwd: `${CWD}/sub` }, CWD)).toBe(
      "ls  (in sub)",
    );
  });

  test("multi-line bash commands collapse to one line", () => {
    const out = summarizeToolInput("bash", { command: "echo a\necho b" }, CWD);
    expect(out).not.toContain("\n");
    expect(out).toContain("echo a");
  });

  test("unknown tools fall back to compact JSON", () => {
    expect(summarizeToolInput("mystery", { foo: 1, bar: "x" }, CWD)).toBe('{"foo":1,"bar":"x"}');
  });

  test("tolerates non-object / missing input", () => {
    expect(() => summarizeToolInput("read", undefined, CWD)).not.toThrow();
    expect(summarizeToolInput("read", undefined, CWD)).toBe("");
  });
});

describe("formatBytes", () => {
  test("formats across unit boundaries", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(812)).toBe("812 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  test("guards against negative / non-finite", () => {
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(NaN)).toBe("0 B");
  });
});

describe("formatDuration", () => {
  test("sub-10s keeps a decimal", () => {
    expect(formatDuration(400)).toBe("0.4s");
    expect(formatDuration(9400)).toBe("9.4s");
  });
  test("10–60s rounds to whole seconds", () => {
    expect(formatDuration(12000)).toBe("12s");
  });
  test("over a minute uses m+padded s", () => {
    expect(formatDuration(64000)).toBe("1m04s");
    expect(formatDuration(125000)).toBe("2m05s");
  });
});

describe("formatTokens", () => {
  test("raw under 1000, k-suffixed above", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(512)).toBe("512");
    expect(formatTokens(12345)).toBe("12.3k");
  });
});

describe("summarizeToolResult", () => {
  test("prefers structured meta over content", () => {
    const r = ToolResult.ok("…big file…", { lines: 42, totalLines: 200, bytes: 1024 });
    expect(summarizeToolResult(r)).toBe("42/200 lines");
  });

  test("counts entries / matches with singular/plural", () => {
    expect(summarizeToolResult(ToolResult.ok("x", { count: 1 }))).toBe("1 entry");
    expect(summarizeToolResult(ToolResult.ok("x", { count: 3 }))).toBe("3 entries");
    expect(summarizeToolResult(ToolResult.ok("x", { matches: 1 }))).toBe("1 match");
    expect(summarizeToolResult(ToolResult.ok("x", { matches: 7 }))).toBe("7 matches");
  });

  test("edit-style removed/added bytes with the line number", () => {
    const r = ToolResult.ok("ok", { removed: 12, added: 30, line: 88 });
    expect(summarizeToolResult(r)).toBe("-12/+30 bytes at line 88");
  });

  test("bash-style exit code and duration", () => {
    const r = ToolResult.ok("output", { exitCode: 0, durationMs: 1500 });
    expect(summarizeToolResult(r)).toBe("exit 0 · 1.5s");
  });

  test("notes truncation", () => {
    const r = ToolResult.ok("x", { count: 500, truncated: true });
    expect(summarizeToolResult(r)).toBe("500 entries · truncated");
  });

  test("falls back to the first non-empty content line when no meta", () => {
    const r = ToolResult.ok("\n\n  first real line\nsecond\n");
    expect(summarizeToolResult(r)).toBe("first real line");
  });

  test("surfaces the error on failure", () => {
    const r = ToolResult.error("file not found");
    expect(summarizeToolResult(r)).toBe("file not found");
  });
});

describe("diffLines", () => {
  test("a single-line substitution yields one remove + one add", () => {
    const segs = diffLines(`if (c === '"')`, `if (c === '"' || c === "'")`, 0);
    expect(segs).toEqual([
      { kind: "remove", text: `if (c === '"')` },
      { kind: "add", text: `if (c === '"' || c === "'")` },
    ]);
  });

  test("strips the common prefix/suffix and keeps the changed middle", () => {
    const oldStr = "line1\nOLD\nline3";
    const newStr = "line1\nNEW\nline3";
    const segs = diffLines(oldStr, newStr, 0);
    expect(segs).toEqual([
      { kind: "remove", text: "OLD" },
      { kind: "add", text: "NEW" },
    ]);
  });

  test("keeps up to `context` framing lines on each side", () => {
    const oldStr = "a\nb\nc\nOLD\nd\ne\nf";
    const newStr = "a\nb\nc\nNEW\nd\ne\nf";
    const segs = diffLines(oldStr, newStr, 1);
    expect(segs).toEqual([
      { kind: "context", text: "c" },
      { kind: "remove", text: "OLD" },
      { kind: "add", text: "NEW" },
      { kind: "context", text: "d" },
    ]);
  });

  test("pure insertion has no remove segments", () => {
    const segs = diffLines("a\nb", "a\nINSERT\nb", 0);
    expect(segs.filter((s) => s.kind === "remove")).toHaveLength(0);
    expect(segs).toContainEqual({ kind: "add", text: "INSERT" });
  });

  test("identical strings produce no change segments", () => {
    const segs = diffLines("same\ntext", "same\ntext", 0);
    expect(segs.filter((s) => s.kind !== "context")).toHaveLength(0);
  });
});
