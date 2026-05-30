/**
 * System prompt assembly (spec v0 §9 "System prompt assembly").
 *
 * The system prompt is built once per session, in this exact order:
 *   1. base harness instructions
 *   2. environment block (cwd, OS, date, git status)
 *   3. project OM.md content, if present
 *   4. tool usage notes
 *
 * `buildSystemPrompt` is a pure function of its inputs — given a fixed `now`
 * and `gitStatus`, it is deterministic (no clock or git access). The helpers
 * `readProjectDoc` and `gitStatus` perform the real I/O and are defensive:
 * they never throw, returning null on any failure.
 */

/** The canonical v0 tool names, in registry order (spec tools.html §1). */
export const TOOL_NAMES = ["read", "ls", "glob", "grep", "write", "edit", "bash"] as const;

export interface BuildSystemPromptOpts {
  /** Working directory the harness was launched in (absolute path). */
  cwd: string;
  /** Current time. Injected so the prompt is deterministic in tests. */
  now: Date;
  /** Short `git status` summary, or omitted/undefined when not a git repo. */
  gitStatus?: string;
  /** Contents of the project's OM.md, or omitted/undefined when absent. */
  projectDoc?: string;
}

/** Map process.platform to a human-readable OS name for the environment block. */
function osName(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return platform;
  }
}

function baseInstructions(): string {
  return [
    "You are om-cli, a terminal-native agentic coding assistant. You help the",
    "user with software engineering tasks in their project by reading, searching,",
    "and editing files and running shell commands — all through tools.",
    "",
    "You operate through tools only; you never touch the disk or run processes",
    "directly. The available tools are:",
    `  ${TOOL_NAMES.join(", ")}.`,
    "  - read, ls, glob, grep: inspect the project (auto-allowed).",
    "  - write: create or overwrite a whole file.",
    "  - edit: exact-string replacement of one unique substring in a file.",
    "  - bash: run a shell command.",
    "write, edit, and bash require user approval before they run.",
    "",
    "Editing contract: you MUST read a file (with the read tool) before you can",
    "edit it. The edit tool replaces an exact substring — old_string must match the",
    "file verbatim (including whitespace) and must occur exactly once. If it is not",
    "unique, add surrounding context until it is. Prefer edit for surgical changes;",
    "use write only when creating a new file or rewriting one wholesale.",
    "",
    "Be concise. Keep responses short and to the point — no preamble, no filler,",
    "no restating the task. Take action with tools rather than describing what you",
    "would do.",
  ].join("\n");
}

function environmentBlock(opts: BuildSystemPromptOpts): string {
  const lines = [
    "<environment>",
    `Working directory: ${opts.cwd}`,
    `Operating system: ${osName(process.platform)}`,
    `Date: ${opts.now.toISOString()}`,
  ];
  const status = opts.gitStatus?.trim();
  lines.push(status ? `Git status:\n${status}` : "Git status: not a git repository");
  lines.push("</environment>");
  return lines.join("\n");
}

function toolUsageNotes(): string {
  return [
    "<tool-usage>",
    "- Paths at the tool boundary are absolute; relative paths resolve against the",
    "  working directory above.",
    "- Use grep/glob to locate code before reading whole files; prefer narrow reads.",
    "- Always read a file before editing it (the edit tool enforces this).",
    "- When an edit fails because old_string is not unique or not found, widen the",
    "  context and retry — do not guess.",
    "- Run one logical step at a time and check results before continuing.",
    "</tool-usage>",
  ].join("\n");
}

/**
 * Assemble the full system prompt from the four sections in spec order. Pure:
 * no I/O, deterministic given `now` and `gitStatus`.
 */
export function buildSystemPrompt(opts: BuildSystemPromptOpts): string {
  const sections: string[] = [baseInstructions(), environmentBlock(opts)];

  const doc = opts.projectDoc?.trim();
  if (doc) {
    sections.push(["<project-doc source=\"OM.md\">", doc, "</project-doc>"].join("\n"));
  }

  sections.push(toolUsageNotes());

  return sections.join("\n\n");
}

/**
 * Read `<cwd>/OM.md` if it exists. Returns its text, or null when the file is
 * absent or unreadable. Never throws.
 */
export async function readProjectDoc(cwd: string): Promise<string | null> {
  try {
    const file = Bun.file(`${cwd}/OM.md`);
    if (!(await file.exists())) return null;
    const text = await file.text();
    return text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Run `git status --porcelain -b` in `cwd` and return a short summary string,
 * or null when `cwd` is not a git repository or git is unavailable. Defensive:
 * never throws, honors the abort signal if provided.
 */
export async function gitStatus(cwd: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "status", "--porcelain", "-b"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      signal,
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) return null;
    return summarizeGitStatus(stdout);
  } catch {
    return null;
  }
}

/**
 * Condense `git status --porcelain -b` output into a one-or-two line summary:
 * the branch line plus a count of changed/untracked entries. Exported for
 * deterministic testing without spawning git.
 */
export function summarizeGitStatus(porcelain: string): string {
  const lines = porcelain.split("\n").filter((l) => l.length > 0);
  let branch = "";
  let changed = 0;
  let untracked = 0;
  for (const line of lines) {
    if (line.startsWith("##")) {
      branch = line.slice(2).trim();
      continue;
    }
    if (line.startsWith("??")) {
      untracked++;
    } else {
      changed++;
    }
  }
  const parts: string[] = [];
  parts.push(branch ? `branch ${branch}` : "no branch");
  if (changed === 0 && untracked === 0) {
    parts.push("clean");
  } else {
    const counts: string[] = [];
    if (changed > 0) counts.push(`${changed} changed`);
    if (untracked > 0) counts.push(`${untracked} untracked`);
    parts.push(counts.join(", "));
  }
  return parts.join(", ");
}
