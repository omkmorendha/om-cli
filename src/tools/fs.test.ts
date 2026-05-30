import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ToolContext } from "../core/types.ts";
import { nullLogger } from "../util/logger.ts";
import {
  readTool,
  lsTool,
  globTool,
  grepTool,
  writeTool,
  editTool,
  fsTools,
  rel,
  _resetRipgrepCache,
  _setRipgrepAvailable,
} from "./fs.ts";
import { truncate, sliceBytes, human, MAX_TOOL_BYTES } from "./truncate.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Test harness
// ─────────────────────────────────────────────────────────────────────────────

let dir: string;
let readSet: Set<string>;

function ctx(): ToolContext {
  return {
    cwd: dir,
    signal: new AbortController().signal,
    log: nullLogger(),
    readSet,
  };
}

/** A context whose signal is already aborted, for testing prompt unwind. */
function abortedCtx(): ToolContext {
  const ac = new AbortController();
  ac.abort();
  return { cwd: dir, signal: ac.signal, log: nullLogger(), readSet };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "om-fs-"));
  readSet = new Set<string>();
  _setRipgrepAvailable(null);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  _resetRipgrepCache();
});

function write(rel: string, content: string): string {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  return full;
}

// ─────────────────────────────────────────────────────────────────────────────
// read
// ─────────────────────────────────────────────────────────────────────────────

describe("read", () => {
  test("line numbering cat -n style", async () => {
    const p = write("a.txt", "alpha\nbeta\ngamma\n");
    const r = await readTool.run({ path: p }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toBe("1\talpha\n2\tbeta\n3\tgamma");
    expect(r.meta?.lines).toBe(3);
    expect(r.meta?.totalLines).toBe(3);
    expect(r.meta?.path).toBe(p);
  });

  test("returns promptly with an interrupted error when the signal is already aborted", async () => {
    const p = write("a.txt", "x\n");
    const r = await readTool.run({ path: p }, abortedCtx());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("aborted");
    // The read was not recorded in the read-set since it never completed.
    expect(readSet.has(p)).toBe(false);
  });

  test("records resolved path in readSet on success", async () => {
    const p = write("a.txt", "x\n");
    await readTool.run({ path: p }, ctx());
    expect(readSet.has(p)).toBe(true);
  });

  test("offset and limit select a range", async () => {
    const p = write("a.txt", "l1\nl2\nl3\nl4\nl5\n");
    const r = await readTool.run({ path: p, offset: 2, limit: 2 }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toBe("2\tl2\n3\tl3");
    expect(r.meta?.lines).toBe(2);
    expect(r.meta?.truncated).toBe(true); // there are more lines beyond the limit
  });

  test("limit reaching EOF is not flagged truncated", async () => {
    const p = write("a.txt", "l1\nl2\nl3\n");
    const r = await readTool.run({ path: p, offset: 1, limit: 3 }, ctx());
    expect(r.meta?.truncated).toBe(false);
  });

  test("offset past EOF -> empty content, ok:true, no error", async () => {
    const p = write("a.txt", "l1\nl2\n");
    const r = await readTool.run({ path: p, offset: 99 }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toBe("");
    expect(r.meta?.lines).toBe(0);
    expect(r.meta?.totalLines).toBe(2);
    expect(r.error).toBeUndefined();
  });

  test("empty file -> ok:true, empty content, lines:0, still records readSet", async () => {
    const p = write("empty.txt", "");
    const r = await readTool.run({ path: p }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toBe("");
    expect(r.meta?.lines).toBe(0);
    expect(readSet.has(p)).toBe(true);
  });

  test("binary file -> ok:false with bytes meta, not streamed", async () => {
    const p = join(dir, "bin");
    writeFileSync(p, Buffer.from([0x41, 0x00, 0x42, 0x43]));
    const r = await readTool.run({ path: p }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("binary file, not shown");
    expect(r.meta?.bytes).toBe(4);
  });

  test("missing file -> ok:false file not found", async () => {
    const p = join(dir, "nope.txt");
    const r = await readTool.run({ path: p }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toBe(`file not found: ${p}`);
  });

  test("directory -> ok:false use ls", async () => {
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const r = await readTool.run({ path: sub }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("path is a directory, use ls");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ls
// ─────────────────────────────────────────────────────────────────────────────

describe("ls", () => {
  test("dirs-first then lexicographic, dir suffix /", async () => {
    write("b.txt", "x");
    write("a.txt", "x");
    mkdirSync(join(dir, "zdir"));
    mkdirSync(join(dir, "adir"));
    const r = await lsTool.run({ path: dir, all: false }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toBe("adir/\nzdir/\na.txt\nb.txt");
    expect(r.meta?.count).toBe(4);
  });

  test("hides dotfiles unless all=true", async () => {
    write(".hidden", "x");
    write("visible.txt", "x");
    const hidden = await lsTool.run({ path: dir, all: false }, ctx());
    expect(hidden.content).toBe("visible.txt");
    const all = await lsTool.run({ path: dir, all: true }, ctx());
    expect(all.content.split("\n").sort()).toEqual([".hidden", "visible.txt"]);
  });

  test("entry cap at 1000 truncates with notice", async () => {
    for (let i = 0; i < 1005; i++) write(`f${String(i).padStart(4, "0")}.txt`, "x");
    const r = await lsTool.run({ path: dir, all: false }, ctx());
    expect(r.ok).toBe(true);
    expect(r.meta?.truncated).toBe(true);
    expect(r.meta?.count).toBe(1005);
    expect((r.meta?.entries as unknown[]).length).toBe(1000);
    expect(r.content).toContain("… +5 more entries (use glob for large trees)");
  });

  test("empty directory -> (empty), count:0", async () => {
    const sub = join(dir, "empty");
    mkdirSync(sub);
    const r = await lsTool.run({ path: sub, all: false }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toBe("(empty)");
    expect(r.meta?.count).toBe(0);
  });

  test("missing directory -> ok:false", async () => {
    const p = join(dir, "nope");
    const r = await lsTool.run({ path: p, all: false }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toBe(`directory not found: ${p}`);
  });

  test("path is a file -> ok:false use read", async () => {
    const p = write("f.txt", "x");
    const r = await lsTool.run({ path: p, all: false }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("path is a file, use read");
  });

  test("broken symlink -> type symlink, no size", async () => {
    symlinkSync(join(dir, "missing-target"), join(dir, "link"));
    const r = await lsTool.run({ path: dir, all: false }, ctx());
    expect(r.ok).toBe(true);
    const entries = r.meta?.entries as { name: string; type: string; size?: number }[];
    const link = entries.find((e) => e.name === "link");
    expect(link?.type).toBe("symlink");
    expect(link?.size).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// glob
// ─────────────────────────────────────────────────────────────────────────────

describe("glob", () => {
  test("matches by pattern, returns absolute paths", async () => {
    write("src/a.ts", "x");
    write("src/b.ts", "x");
    write("src/c.js", "x");
    const r = await globTool.run({ pattern: "src/**/*.ts" }, ctx());
    expect(r.ok).toBe(true);
    const matches = r.meta?.matches as string[];
    expect(matches.sort()).toEqual([resolve(dir, "src/a.ts"), resolve(dir, "src/b.ts")]);
    expect(r.meta?.count).toBe(2);
  });

  test("no matches -> ok:true (no matches)", async () => {
    const r = await globTool.run({ pattern: "**/*.zzz" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toBe("(no matches)");
    expect(r.meta?.count).toBe(0);
  });

  test("missing scan root -> ok:false", async () => {
    const bad = join(dir, "nope");
    const r = await globTool.run({ pattern: "*", cwd: bad }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toBe(`scan root not found: ${bad}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// grep — fallback backend (deterministic, no rg dependency)
// ─────────────────────────────────────────────────────────────────────────────

describe("grep (fallback)", () => {
  beforeEach(() => _setRipgrepAvailable(false));

  test("finds matches rendered path:line:text", async () => {
    const p = write("a.txt", "first TODO line\nsecond\nthird TODO\n");
    const r = await grepTool.run({ pattern: "TODO", ignoreCase: false, context: 0 }, ctx());
    expect(r.ok).toBe(true);
    expect(r.meta?.backend).toBe("fallback");
    expect(r.meta?.matches).toBe(2);
    expect(r.meta?.files).toBe(1);
    expect(r.content).toContain(`${p}:1:first TODO line`);
    expect(r.content).toContain(`${p}:3:third TODO`);
  });

  test("no match -> ok:true (no matches), matches:0", async () => {
    write("a.txt", "nothing here\n");
    const r = await grepTool.run({ pattern: "TODO", ignoreCase: false, context: 0 }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toBe("(no matches)");
    expect(r.meta?.matches).toBe(0);
  });

  test("an already-aborted signal unwinds before scanning any file", async () => {
    write("a.txt", "first TODO line\nthird TODO\n");
    const r = await grepTool.run(
      { pattern: "TODO", ignoreCase: false, context: 0 },
      abortedCtx(),
    );
    // Returns promptly with no matches; the fallback breaks at the first file.
    expect(r.meta?.matches).toBe(0);
  });

  test("ignoreCase matches case-insensitively", async () => {
    write("a.txt", "Hello WORLD\n");
    const r = await grepTool.run({ pattern: "world", ignoreCase: true, context: 0 }, ctx());
    expect(r.meta?.matches).toBe(1);
  });

  test("context lines rendered with dash separator", async () => {
    const p = write("a.txt", "before\nMATCH\nafter\n");
    const r = await grepTool.run({ pattern: "MATCH", ignoreCase: false, context: 1 }, ctx());
    expect(r.content).toContain(`${p}:1-before`);
    expect(r.content).toContain(`${p}:2:MATCH`);
    expect(r.content).toContain(`${p}:3-after`);
  });

  test("glob restricts the scanned files", async () => {
    write("keep.ts", "TARGET\n");
    write("skip.md", "TARGET\n");
    const r = await grepTool.run(
      { pattern: "TARGET", glob: "*.ts", ignoreCase: false, context: 0 },
      ctx(),
    );
    expect(r.meta?.files).toBe(1);
    expect(r.content).toContain("keep.ts");
    expect(r.content).not.toContain("skip.md");
  });

  test("skips binary files", async () => {
    writeFileSync(join(dir, "bin"), Buffer.from([0x54, 0x00, 0x4f, 0x44, 0x4f]));
    write("a.txt", "TODO\n");
    const r = await grepTool.run({ pattern: "TODO", ignoreCase: false, context: 0 }, ctx());
    expect(r.meta?.matches).toBe(1);
    expect(r.meta?.files).toBe(1);
  });

  test("invalid regex -> ok:false", async () => {
    write("a.txt", "x\n");
    const r = await grepTool.run({ pattern: "(", ignoreCase: false, context: 0 }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  test("missing search path -> ok:false", async () => {
    const bad = join(dir, "nope");
    const r = await grepTool.run(
      { pattern: "x", path: bad, ignoreCase: false, context: 0 },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe(`search path not found: ${bad}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// grep — ripgrep backend (only when rg present; same shape contract)
// ─────────────────────────────────────────────────────────────────────────────

describe("grep (ripgrep, if available)", () => {
  test("ripgrep backend produces identical shape to fallback", async () => {
    const hasRg = Bun.which("rg") !== null;
    if (!hasRg) return; // skip on machines without ripgrep

    write("a.txt", "first TODO line\nsecond\nthird TODO\n");
    _setRipgrepAvailable(true);
    const r = await grepTool.run({ pattern: "TODO", ignoreCase: false, context: 0 }, ctx());
    expect(r.ok).toBe(true);
    expect(r.meta?.backend).toBe("ripgrep");
    expect(r.meta?.matches).toBe(2);
    expect(r.meta?.files).toBe(1);
    expect(r.content).toContain(":1:first TODO line");
    expect(r.content).toContain(":3:third TODO");
  });

  test("ripgrep no-match normalized to ok:true empty", async () => {
    const hasRg = Bun.which("rg") !== null;
    if (!hasRg) return;

    write("a.txt", "nothing\n");
    _setRipgrepAvailable(true);
    const r = await grepTool.run({ pattern: "ZZZ", ignoreCase: false, context: 0 }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toBe("(no matches)");
    expect(r.meta?.matches).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// write
// ─────────────────────────────────────────────────────────────────────────────

describe("write", () => {
  test("creates a new file and parent dirs", async () => {
    const p = join(dir, "nested/deep/file.txt");
    const r = await writeTool.run({ path: p, content: "hello" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.meta?.created).toBe(true);
    expect(r.meta?.bytes).toBe(5);
    expect(await Bun.file(p).text()).toBe("hello");
    expect(r.content).toContain("created");
  });

  test("overwrites an existing file (created:false)", async () => {
    const p = write("f.txt", "old");
    const r = await writeTool.run({ path: p, content: "new content" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.meta?.created).toBe(false);
    expect(await Bun.file(p).text()).toBe("new content");
    expect(r.content).toContain("overwritten");
  });

  test("target is a directory -> ok:false", async () => {
    const sub = join(dir, "adir");
    mkdirSync(sub);
    const r = await writeTool.run({ path: sub, content: "x" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toBe("path is a directory");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// edit
// ─────────────────────────────────────────────────────────────────────────────

describe("edit", () => {
  test("happy path replaces the unique match and reports line", async () => {
    const p = write("a.txt", "line1\nfoo bar\nline3\n");
    readSet.add(p);
    const r = await editTool.run(
      { path: p, old_string: "foo bar", new_string: "baz qux" },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.meta?.line).toBe(2);
    expect(r.meta?.removed).toBe(7);
    expect(r.meta?.added).toBe(7);
    expect(await Bun.file(p).text()).toBe("line1\nbaz qux\nline3\n");
    expect(r.content).toContain("at line 2");
  });

  test("read-prerequisite miss -> ok:false must read first", async () => {
    const p = write("a.txt", "foo\n");
    // readSet intentionally empty
    const r = await editTool.run({ path: p, old_string: "foo", new_string: "bar" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toBe(`must read ${p} before editing it`);
    // file untouched
    expect(await Bun.file(p).text()).toBe("foo\n");
  });

  test("missing file (but in readSet) -> ok:false file not found", async () => {
    const p = join(dir, "ghost.txt");
    readSet.add(p);
    const r = await editTool.run({ path: p, old_string: "a", new_string: "b" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toBe(`file not found: ${p}`);
  });

  test("zero matches -> ok:false not found exactly", async () => {
    const p = write("a.txt", "hello world\n");
    readSet.add(p);
    const r = await editTool.run(
      { path: p, old_string: "missing", new_string: "x" },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe(
      `old_string not found in ${p} — it must match the file exactly, including whitespace`,
    );
  });

  test("multiple matches -> ok:false matched N times", async () => {
    const p = write("a.txt", "dup\ndup\ndup\n");
    readSet.add(p);
    const r = await editTool.run({ path: p, old_string: "dup", new_string: "x" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toBe(
      `old_string matched 3 times in ${p} — add surrounding context so it is unique`,
    );
    // file untouched
    expect(await Bun.file(p).text()).toBe("dup\ndup\ndup\n");
  });

  test("no-op edit rejected by schema refine (old===new)", () => {
    const parsed = editTool.schema.safeParse({
      path: "/x",
      old_string: "same",
      new_string: "same",
    });
    expect(parsed.success).toBe(false);
  });

  test("line is computed for a match deep in the file", async () => {
    const p = write("a.txt", "a\nb\nc\nUNIQUE\ne\n");
    readSet.add(p);
    const r = await editTool.run(
      { path: p, old_string: "UNIQUE", new_string: "DONE" },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.meta?.line).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fsTools export
// ─────────────────────────────────────────────────────────────────────────────

describe("fsTools registry export", () => {
  test("exports all six tools with unique names", () => {
    const names = fsTools.map((t) => t.name);
    expect(names.sort()).toEqual(["edit", "glob", "grep", "ls", "read", "write"]);
    expect(new Set(names).size).toBe(6);
  });

  test("each tool has correct permission class", () => {
    expect(readTool.permission).toBe("read");
    expect(lsTool.permission).toBe("read");
    expect(globTool.permission).toBe("read");
    expect(grepTool.permission).toBe("read");
    expect(writeTool.permission).toBe("write");
    expect(editTool.permission).toBe("write");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rel preview helper
// ─────────────────────────────────────────────────────────────────────────────

describe("rel", () => {
  test("renders relative when inside cwd", () => {
    expect(rel("/a/b/c/file.ts", "/a/b/c")).toBe("file.ts");
    expect(rel("/a/b/c/sub/file.ts", "/a/b/c")).toBe("sub/file.ts");
  });

  test("renders absolute when outside cwd", () => {
    expect(rel("/x/y/z.ts", "/a/b/c")).toBe("/x/y/z.ts");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// truncate
// ─────────────────────────────────────────────────────────────────────────────

describe("truncate", () => {
  test("under the cap passes through unchanged", () => {
    const s = "small output";
    const r = truncate(s);
    expect(r.truncated).toBe(false);
    expect(r.content).toBe(s);
  });

  test("over the cap keeps head + tail with a notice", () => {
    const big = "A".repeat(MAX_TOOL_BYTES + 5000);
    const r = truncate(big);
    expect(r.truncated).toBe(true);
    expect(r.content).toContain("… [truncated");
    expect(r.content.startsWith("A")).toBe(true);
    expect(r.content.endsWith("A")).toBe(true);
    // Smaller than the original.
    expect(Buffer.byteLength(r.content, "utf8")).toBeLessThan(MAX_TOOL_BYTES + 5000);
  });

  test("multibyte safety: never splits a codepoint", () => {
    // Each "é" is 2 bytes; build a string well over the cap of multibyte chars.
    const big = "é".repeat(MAX_TOOL_BYTES); // 2 * MAX bytes
    const r = truncate(big);
    expect(r.truncated).toBe(true);
    // No U+FFFD replacement char from a split codepoint.
    expect(r.content).not.toContain("�");
  });

  test("sliceBytes snaps to codepoint boundaries", () => {
    const s = "aébc"; // bytes: a(1) é(2) b(1) c(1)
    // Request a slice that would cut the middle of é (byte offset 2 = start of é).
    const out = sliceBytes(s, 0, 2); // [a, é-start] -> snaps end down to before é
    expect(out).toBe("a");
    expect(out).not.toContain("�");
  });

  test("human formats bytes", () => {
    expect(human(512)).toBe("512 B");
    expect(human(1536)).toBe("1.5 KB");
  });
});
