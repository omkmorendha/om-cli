/**
 * Filesystem tools: read, ls, glob, grep, write, edit (spec tools.html §02–§07, §10).
 *
 * Every path argument is an absolute path at the tool boundary; relative paths
 * are resolved against ctx.cwd as a convenience and normalized. v0 has no
 * project-root jail — out-of-root paths flow through normal approval.
 *
 * Tools are pure functions of (input, ctx). They never throw for expected
 * failure modes: they return ok:false ToolResults with model-actionable error
 * strings. The registry catches anything that does throw (tools.html §13).
 */

import { z } from "zod";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import { stat, readdir, mkdir, lstat } from "node:fs/promises";
import type { Tool, ToolResult as ToolResultType } from "../core/types.ts";
import { ToolResult } from "../core/types.ts";
import { truncate, human } from "./truncate.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve a (possibly relative) path against cwd into a normalized absolute path. */
function abs(path: string, cwd: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

/**
 * Render `path` relative to `cwd` when it is inside cwd, otherwise the absolute
 * path — used in previews for legibility (tools.html §02).
 */
export function rel(path: string, cwd: string): string {
  const a = abs(path, cwd);
  const r = relative(cwd, a);
  // Inside cwd iff the relative path does not escape upward and is not absolute.
  if (r === "") return ".";
  if (!r.startsWith("..") && !isAbsolute(r)) return r;
  return a;
}

/** NUL byte in the first 8 KB ⇒ treat as binary (tools.html §02, §05). */
const BINARY_SNIFF_BYTES = 8 * 1024;
function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

const LS_CAP = 1000;
const GLOB_CAP = 1000;
const GREP_MATCH_CAP = 200;

// ─────────────────────────────────────────────────────────────────────────────
// read (tools.html §02)
// ─────────────────────────────────────────────────────────────────────────────

const readSchema = z.object({
  path: z.string().describe("Absolute path to the file to read."),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based line to start at. Default: first line."),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Max lines to return. Default: whole file (truncation still applies)."),
});
type ReadInput = z.infer<typeof readSchema>;

/** Format selected lines cat -n style: right-aligned 1-based number + tab. */
function numberLines(lines: string[], startLine: number): string {
  const lastNo = startLine + lines.length - 1;
  const width = String(lastNo).length;
  return lines
    .map((line, i) => `${String(startLine + i).padStart(width)}\t${line}`)
    .join("\n");
}

export const readTool: Tool<ReadInput> = {
  name: "read",
  description:
    "Read a UTF-8 text file from disk, optionally a line range. Reading a file is the prerequisite for editing it.",
  schema: readSchema,
  permission: "read",
  preview(input) {
    const range =
      input.offset || input.limit
        ? `:${input.offset ?? 1}${input.limit ? `+${input.limit}` : ""}`
        : "";
    return `read ${rel(input.path, "")}${range}`;
  },
  async run(input, ctx): Promise<ToolResultType> {
    const log = ctx.log.child("read");
    const p = abs(input.path, ctx.cwd);

    let st;
    try {
      st = await stat(p);
    } catch {
      return ToolResult.error(`file not found: ${p}`);
    }
    if (st.isDirectory()) {
      return ToolResult.error("path is a directory, use ls");
    }

    const file = Bun.file(p);
    const bytesRaw = new Uint8Array(await file.arrayBuffer());
    if (looksBinary(bytesRaw)) {
      return ToolResult.error("binary file, not shown", { bytes: bytesRaw.byteLength });
    }

    const text = new TextDecoder().decode(bytesRaw);
    // Split into lines. An empty file is 0 lines (not one empty line).
    const allLines = text === "" ? [] : text.split("\n");
    // A trailing newline produces a final empty element; drop it so line counts
    // match a typical editor / cat -n view.
    if (allLines.length > 0 && allLines[allLines.length - 1] === "" && text.endsWith("\n")) {
      allLines.pop();
    }
    const totalLines = allLines.length;

    const offset = input.offset ?? 1; // 1-based
    const startIdx = offset - 1;
    const selected =
      input.limit !== undefined
        ? allLines.slice(startIdx, startIdx + input.limit)
        : allLines.slice(startIdx);

    // offset past EOF -> empty content, ok:true, no error.
    let content = selected.length > 0 ? numberLines(selected, offset) : "";
    const lineCapped = input.limit !== undefined && startIdx + input.limit < totalLines;

    const t = truncate(content);
    content = t.content;
    const truncated = t.truncated || lineCapped;

    // Record the resolved path in the read-set on success (edit prerequisite).
    ctx.readSet.add(p);
    log.debug("read", { path: p, lines: selected.length, totalLines, truncated });

    return ToolResult.ok(content, {
      path: p,
      lines: selected.length,
      totalLines,
      bytes: Buffer.byteLength(content, "utf8"),
      truncated,
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// ls (tools.html §03)
// ─────────────────────────────────────────────────────────────────────────────

const lsSchema = z.object({
  path: z.string().describe("Absolute path to the directory to list."),
  all: z
    .boolean()
    .default(false)
    .describe("Include dotfiles (entries starting with '.')."),
});
type LsInput = z.infer<typeof lsSchema>;

type LsEntry = { name: string; type: "file" | "dir" | "symlink"; size?: number };

export const lsTool: Tool<LsInput> = {
  name: "ls",
  description: "List the immediate entries of a directory (non-recursive).",
  schema: lsSchema,
  permission: "read",
  preview(input) {
    return `ls ${rel(input.path, "")}`;
  },
  async run(input, ctx): Promise<ToolResultType> {
    const log = ctx.log.child("ls");
    const p = abs(input.path, ctx.cwd);

    let st;
    try {
      st = await stat(p);
    } catch {
      return ToolResult.error(`directory not found: ${p}`);
    }
    if (!st.isDirectory()) {
      return ToolResult.error("path is a file, use read");
    }

    const names = await readdir(p);
    const filtered = input.all ? names : names.filter((n) => !n.startsWith("."));

    const entries: LsEntry[] = [];
    for (const name of filtered) {
      const full = resolve(p, name);
      let ls;
      try {
        ls = await lstat(full);
      } catch {
        continue; // vanished between readdir and lstat — skip.
      }
      if (ls.isSymbolicLink()) {
        // Broken symlinks are listed with type "symlink", no size, never followed.
        entries.push({ name, type: "symlink" });
      } else if (ls.isDirectory()) {
        entries.push({ name, type: "dir" });
      } else {
        entries.push({ name, type: "file", size: ls.size });
      }
    }

    // Dirs-first, then lexicographically.
    entries.sort((a, b) => {
      const ad = a.type === "dir" ? 0 : 1;
      const bd = b.type === "dir" ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });

    const count = entries.length;
    if (count === 0) {
      return ToolResult.ok("(empty)", { path: p, entries: [], count: 0, truncated: false });
    }

    let shown = entries;
    let truncated = false;
    if (entries.length > LS_CAP) {
      shown = entries.slice(0, LS_CAP);
      truncated = true;
    }

    const lines = shown.map((e) => (e.type === "dir" ? `${e.name}/` : e.name));
    let content = lines.join("\n");
    if (truncated) {
      const more = count - LS_CAP;
      content += `\n… +${more} more entries (use glob for large trees)`;
    }

    log.debug("ls", { path: p, count, truncated });
    return ToolResult.ok(content, { path: p, entries: shown, count, truncated });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// glob (tools.html §04)
// ─────────────────────────────────────────────────────────────────────────────

const globSchema = z.object({
  pattern: z
    .string()
    .describe("Glob pattern, e.g. 'src/**/*.ts'. Matched with Bun.Glob."),
  cwd: z
    .string()
    .optional()
    .describe("Directory to scan from. Default: ctx.cwd."),
});
type GlobInput = z.infer<typeof globSchema>;

export const globTool: Tool<GlobInput> = {
  name: "glob",
  description: "Find files by glob pattern using Bun.Glob.",
  schema: globSchema,
  permission: "read",
  preview(input) {
    return `glob ${input.pattern}`;
  },
  async run(input, ctx): Promise<ToolResultType> {
    const log = ctx.log.child("glob");
    const scanRoot = input.cwd ? abs(input.cwd, ctx.cwd) : ctx.cwd;

    let st;
    try {
      st = await stat(scanRoot);
    } catch {
      return ToolResult.error(`scan root not found: ${scanRoot}`);
    }
    if (!st.isDirectory()) {
      return ToolResult.error(`scan root not found: ${scanRoot}`);
    }

    let absMatches: { path: string; mtimeMs: number }[];
    try {
      const glob = new Bun.Glob(input.pattern);
      const results: { path: string; mtimeMs: number }[] = [];
      for await (const m of glob.scan({ cwd: scanRoot, onlyFiles: true, followSymlinks: false })) {
        const full = resolve(scanRoot, m);
        let mtimeMs = 0;
        try {
          mtimeMs = (await stat(full)).mtimeMs;
        } catch {
          continue; // disappeared mid-scan.
        }
        results.push({ path: full, mtimeMs });
      }
      absMatches = results;
    } catch (err) {
      return ToolResult.error(err instanceof Error ? err.message : String(err));
    }

    if (absMatches.length === 0) {
      return ToolResult.ok("(no matches)", {
        pattern: input.pattern,
        cwd: scanRoot,
        matches: [],
        count: 0,
        truncated: false,
      });
    }

    // Sort most-recently-modified first.
    absMatches.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const count = absMatches.length;

    let shown = absMatches;
    let truncated = false;
    if (absMatches.length > GLOB_CAP) {
      shown = absMatches.slice(0, GLOB_CAP);
      truncated = true;
    }

    const paths = shown.map((m) => m.path);
    let content = paths.join("\n");
    if (truncated) {
      content += `\n… +${count - GLOB_CAP} more matches`;
    }

    log.debug("glob", { pattern: input.pattern, count, truncated });
    return ToolResult.ok(content, {
      pattern: input.pattern,
      cwd: scanRoot,
      matches: paths,
      count,
      truncated,
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// grep (tools.html §05, §12)
// ─────────────────────────────────────────────────────────────────────────────

const grepSchema = z.object({
  pattern: z.string().describe("Regular expression to search for."),
  path: z
    .string()
    .optional()
    .describe("File or directory to search. Default: ctx.cwd."),
  glob: z
    .string()
    .optional()
    .describe("Restrict to files matching this glob, e.g. '*.ts'."),
  ignoreCase: z.boolean().default(false),
  context: z
    .number()
    .int()
    .min(0)
    .max(10)
    .default(0)
    .describe("Lines of context around each match (rg -C)."),
});
type GrepInput = z.infer<typeof grepSchema>;

/** Session-cached ripgrep availability (tools.html §12). */
let rgAvailable: boolean | null = null;

/** Reset the cached ripgrep probe — for tests that exercise both backends. */
export function _resetRipgrepCache(): void {
  rgAvailable = null;
}

/** Override the cached ripgrep probe — for tests that force a backend. */
export function _setRipgrepAvailable(v: boolean | null): void {
  rgAvailable = v;
}

async function hasRipgrep(): Promise<boolean> {
  if (rgAvailable !== null) return rgAvailable;
  try {
    const p = Bun.spawn(["rg", "--version"], { stdout: "ignore", stderr: "ignore" });
    rgAvailable = (await p.exited) === 0;
  } catch {
    rgAvailable = false; // ENOENT -> not on PATH.
  }
  return rgAvailable;
}

interface GrepHit {
  /** path:line:text for a match, path:line-text for a context line. */
  line: string;
  isMatch: boolean;
  file: string;
}

interface GrepBackendResult {
  hits: GrepHit[];
  truncated: boolean;
}

/** Build the model-facing content + meta shared by both backends. */
function renderGrep(
  input: GrepInput,
  backend: "ripgrep" | "fallback",
  r: GrepBackendResult,
): ToolResultType {
  const matchLines = r.hits.filter((h) => h.isMatch);
  const files = new Set(matchLines.map((h) => h.file));
  const matches = matchLines.length;

  if (matches === 0) {
    return ToolResult.ok("(no matches)", {
      pattern: input.pattern,
      backend,
      files: 0,
      matches: 0,
      truncated: r.truncated,
    });
  }

  let content = r.hits.map((h) => h.line).join("\n");
  if (r.truncated) {
    content += `\n… +more matches (narrow with glob/path)`;
  }
  const t = truncate(content);
  return ToolResult.ok(t.content, {
    pattern: input.pattern,
    backend,
    files: files.size,
    matches,
    truncated: r.truncated || t.truncated,
  });
}

/** Parse ripgrep --json stream into the shared hit shape. */
function parseRgJson(stdout: string, root: string): GrepBackendResult {
  const hits: GrepHit[] = [];
  let matchCount = 0;
  let truncated = false;
  for (const raw of stdout.split("\n")) {
    if (raw === "") continue;
    let evt: any;
    try {
      evt = JSON.parse(raw);
    } catch {
      continue;
    }
    if (evt.type !== "match" && evt.type !== "context") continue;
    const data = evt.data;
    const file = pathFromRg(data.path, root);
    const lineNo: number = data.line_number ?? 0;
    const text: string = (data.lines?.text ?? "").replace(/\n$/, "");
    const isMatch = evt.type === "match";
    if (isMatch) {
      if (matchCount >= GREP_MATCH_CAP) {
        truncated = true;
        continue;
      }
      matchCount++;
    }
    const sep = isMatch ? ":" : "-";
    hits.push({ line: `${file}:${lineNo}${sep}${text}`, isMatch, file });
  }
  return { hits, truncated };
}

function pathFromRg(p: { text?: string; bytes?: string } | string, root: string): string {
  let raw: string;
  if (typeof p === "string") raw = p;
  else raw = p.text ?? "";
  if (raw === "") return root;
  return isAbsolute(raw) ? raw : resolve(root, raw);
}

async function grepRipgrep(input: GrepInput, searchPath: string): Promise<GrepBackendResult> {
  const args = ["rg", "--json"];
  if (input.ignoreCase) args.push("-i");
  if (input.context > 0) args.push("-C", String(input.context));
  if (input.glob) args.push("-g", input.glob);
  args.push("--", input.pattern, searchPath);

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // rg exits 1 on no-match (not an error), 2 on real error (e.g. bad regex).
  if (exitCode === 2) {
    const msg = stderr.trim().split("\n").pop() ?? "ripgrep error";
    throw new Error(msg);
  }
  return parseRgJson(stdout, searchPath);
}

async function grepFallback(input: GrepInput, searchPath: string): Promise<GrepBackendResult> {
  // Compile up front so an invalid regex surfaces as ok:false before scanning.
  const re = new RegExp(input.pattern, input.ignoreCase ? "i" : "");

  // Determine the set of files to scan.
  let files: string[];
  const st = await stat(searchPath);
  if (st.isFile()) {
    files = [searchPath];
  } else {
    const pattern = input.glob ?? "**/*";
    const glob = new Bun.Glob(pattern);
    files = [];
    for await (const m of glob.scan({ cwd: searchPath, onlyFiles: true, followSymlinks: false })) {
      files.push(resolve(searchPath, m));
    }
    files.sort();
  }

  const hits: GrepHit[] = [];
  let matchCount = 0;
  let truncated = false;
  const ctxN = input.context;

  outer: for (const file of files) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
    } catch {
      continue;
    }
    if (looksBinary(bytes)) continue; // skip binaries like ripgrep does.
    const text = new TextDecoder().decode(bytes);
    const lines = text.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i] ?? "";
      if (!re.test(lineText)) continue;
      if (matchCount >= GREP_MATCH_CAP) {
        truncated = true;
        break outer;
      }
      matchCount++;
      // Emit leading context.
      for (let c = Math.max(0, i - ctxN); c < i; c++) {
        hits.push({ line: `${file}:${c + 1}-${lines[c] ?? ""}`, isMatch: false, file });
      }
      hits.push({ line: `${file}:${i + 1}:${lineText}`, isMatch: true, file });
      // Emit trailing context.
      for (let c = i + 1; c <= Math.min(lines.length - 1, i + ctxN); c++) {
        hits.push({ line: `${file}:${c + 1}-${lines[c] ?? ""}`, isMatch: false, file });
      }
    }
  }

  return { hits, truncated };
}

export const grepTool: Tool<GrepInput> = {
  name: "grep",
  description:
    "Search file contents by regex. Uses ripgrep when available, falls back to a pure-Bun scanner.",
  schema: grepSchema,
  permission: "read",
  preview(input) {
    return (
      `grep /${input.pattern}/` +
      (input.path ? ` in ${rel(input.path, "")}` : "") +
      (input.glob ? ` (${input.glob})` : "")
    );
  },
  async run(input, ctx): Promise<ToolResultType> {
    const log = ctx.log.child("grep");
    const searchPath = input.path ? abs(input.path, ctx.cwd) : ctx.cwd;

    try {
      await stat(searchPath);
    } catch {
      return ToolResult.error(`search path not found: ${searchPath}`);
    }

    // Validate regex up front (both backends) for a clean error.
    try {
      new RegExp(input.pattern);
    } catch (err) {
      return ToolResult.error(err instanceof Error ? err.message : String(err));
    }

    const useRg = await hasRipgrep();
    try {
      if (useRg) {
        const r = await grepRipgrep(input, searchPath);
        log.debug("grep", { backend: "ripgrep", matches: r.hits.filter((h) => h.isMatch).length });
        return renderGrep(input, "ripgrep", r);
      }
      const r = await grepFallback(input, searchPath);
      log.debug("grep", { backend: "fallback", matches: r.hits.filter((h) => h.isMatch).length });
      return renderGrep(input, "fallback", r);
    } catch (err) {
      return ToolResult.error(err instanceof Error ? err.message : String(err));
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// write (tools.html §06)
// ─────────────────────────────────────────────────────────────────────────────

const writeSchema = z.object({
  path: z.string().describe("Absolute path to write. Parent dirs are created."),
  content: z.string().describe("Full file content (overwrites any existing file)."),
});
type WriteInput = z.infer<typeof writeSchema>;

export const writeTool: Tool<WriteInput> = {
  name: "write",
  description: "Create a new file or fully overwrite an existing one.",
  schema: writeSchema,
  permission: "write",
  preview(input) {
    return `write ${rel(input.path, "")} (${human(input.content.length)})`;
  },
  async run(input, ctx): Promise<ToolResultType> {
    const log = ctx.log.child("write");
    const p = abs(input.path, ctx.cwd);

    // Reject writing onto a directory.
    let existed = false;
    try {
      const st = await stat(p);
      if (st.isDirectory()) {
        return ToolResult.error("path is a directory");
      }
      existed = true;
    } catch {
      existed = false;
    }

    try {
      await mkdir(dirname(p), { recursive: true });
      const bytes = await Bun.write(p, input.content);
      const verb = existed ? "overwritten" : "created";
      log.debug("write", { path: p, bytes, created: !existed });
      return ToolResult.ok(`wrote ${human(bytes)} to ${rel(p, ctx.cwd)} (${verb})`, {
        path: p,
        bytes,
        created: !existed,
      });
    } catch (err) {
      return ToolResult.error(normalizeFsError(err, p));
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// edit (tools.html §07, §10)
// ─────────────────────────────────────────────────────────────────────────────

const editSchema = z
  .object({
    path: z.string().describe("Absolute path to the file to edit."),
    old_string: z
      .string()
      .describe("Exact text to replace. Must occur exactly once in the file."),
    new_string: z
      .string()
      .describe("Replacement text. Must differ from old_string."),
  })
  .refine((v) => v.old_string !== v.new_string, {
    message: "old_string and new_string must differ",
    path: ["new_string"],
  });
type EditInput = z.infer<typeof editSchema>;

/** Count literal (non-regex) occurrences of `needle` in `hay`. */
function countOccurrences(hay: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i === -1) break;
    count++;
    from = i + needle.length;
  }
  return count;
}

export const editTool: Tool<EditInput> = {
  name: "edit",
  description:
    "Replace one exact, uniquely-matching substring in a previously-read file.",
  schema: editSchema,
  permission: "write",
  preview(input) {
    return `edit ${rel(input.path, "")}`;
  },
  async run(input, ctx): Promise<ToolResultType> {
    const log = ctx.log.child("edit");
    const p = abs(input.path, ctx.cwd);

    // 1. Read-prerequisite check. No disk access beyond resolution.
    if (!ctx.readSet.has(p)) {
      return ToolResult.error(`must read ${p} before editing it`);
    }

    // 2. Load the current file bytes as UTF-8.
    const file = Bun.file(p);
    let src: string;
    try {
      src = await file.text();
    } catch {
      return ToolResult.error(`file not found: ${p}`);
    }

    // 3. Count literal matches.
    const n = countOccurrences(src, input.old_string);
    if (n === 0) {
      return ToolResult.error(
        `old_string not found in ${p} — it must match the file exactly, including whitespace`,
      );
    }
    if (n > 1) {
      return ToolResult.error(
        `old_string matched ${n} times in ${p} — add surrounding context so it is unique`,
      );
    }

    // 4. Replace the single occurrence.
    const i = src.indexOf(input.old_string);
    const out = src.slice(0, i) + input.new_string + src.slice(i + input.old_string.length);

    // 5. Write back (file already exists; no parent-dir creation).
    try {
      await Bun.write(p, out);
    } catch (err) {
      return ToolResult.error(normalizeFsError(err, p));
    }

    // 6. Report. line is the 1-based line of index i.
    const line = src.slice(0, i).split("\n").length;
    const removed = Buffer.byteLength(input.old_string, "utf8");
    const added = Buffer.byteLength(input.new_string, "utf8");

    log.debug("edit", { path: p, line, removed, added });
    return ToolResult.ok(`edited ${rel(p, ctx.cwd)} at line ${line}`, {
      path: p,
      line,
      removed,
      added,
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Error normalization (subset of tools.html §13, for the fs tools' own catches)
// ─────────────────────────────────────────────────────────────────────────────

function normalizeFsError(err: unknown, path: string): string {
  const code = (err as { code?: string } | null)?.code;
  switch (code) {
    case "ENOENT":
      return `file not found: ${path}`;
    case "EACCES":
    case "EPERM":
      return `permission denied: ${path}`;
    case "EISDIR":
      return "path is a directory";
    default:
      return err instanceof Error ? err.message : String(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry export
// ─────────────────────────────────────────────────────────────────────────────

export const fsTools: Tool<any>[] = [
  readTool,
  lsTool,
  globTool,
  grepTool,
  writeTool,
  editTool,
];
