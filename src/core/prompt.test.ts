import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildSystemPrompt,
  gitStatus,
  readProjectDoc,
  summarizeGitStatus,
  TOOL_NAMES,
  type BuildSystemPromptOpts,
} from "./prompt.ts";

const FIXED_NOW = new Date("2026-05-30T12:00:00.000Z");
const CWD = "/home/dev/proj";

function baseOpts(overrides: Partial<BuildSystemPromptOpts> = {}): BuildSystemPromptOpts {
  return { cwd: CWD, now: FIXED_NOW, gitStatus: "branch main, clean", ...overrides };
}

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "om-prompt-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildSystemPrompt", () => {
  test("includes the cwd in the environment block", () => {
    const prompt = buildSystemPrompt(baseOpts());
    expect(prompt).toContain(`Working directory: ${CWD}`);
  });

  test("includes the date (ISO of the injected now)", () => {
    const prompt = buildSystemPrompt(baseOpts());
    expect(prompt).toContain(FIXED_NOW.toISOString());
  });

  test("includes every tool name", () => {
    const prompt = buildSystemPrompt(baseOpts());
    for (const name of TOOL_NAMES) {
      expect(prompt).toContain(name);
    }
  });

  test("describes the exact-string edit contract", () => {
    const prompt = buildSystemPrompt(baseOpts()).toLowerCase();
    expect(prompt).toContain("read");
    expect(prompt).toContain("old_string");
    expect(prompt).toContain("unique");
  });

  test("renders the supplied git status", () => {
    const prompt = buildSystemPrompt(baseOpts({ gitStatus: "branch feature/x, 3 changed" }));
    expect(prompt).toContain("branch feature/x, 3 changed");
  });

  test("notes a non-repo when git status is absent", () => {
    const prompt = buildSystemPrompt(baseOpts({ gitStatus: undefined }));
    expect(prompt).toContain("not a git repository");
  });

  test("appends project doc when provided, inside a project-doc block", () => {
    const doc = "# My Project\nUse 2-space indent. Run `bun test`.";
    const prompt = buildSystemPrompt(baseOpts({ projectDoc: doc }));
    expect(prompt).toContain("Use 2-space indent");
    expect(prompt).toContain("OM.md");
  });

  test("omits the project-doc block when no doc is provided", () => {
    const prompt = buildSystemPrompt(baseOpts());
    expect(prompt).not.toContain("project-doc");
  });

  test("omits the project-doc block for an empty/whitespace doc", () => {
    const prompt = buildSystemPrompt(baseOpts({ projectDoc: "   \n  " }));
    expect(prompt).not.toContain("project-doc");
  });

  test("orders sections: base -> environment -> project doc -> tool usage", () => {
    const doc = "PROJECT_DOC_MARKER";
    const prompt = buildSystemPrompt(baseOpts({ projectDoc: doc }));
    const iEnv = prompt.indexOf("<environment>");
    const iDoc = prompt.indexOf(doc);
    const iTools = prompt.indexOf("<tool-usage>");
    const iBase = prompt.indexOf("You are om-cli");
    expect(iBase).toBeGreaterThanOrEqual(0);
    expect(iEnv).toBeGreaterThan(iBase);
    expect(iDoc).toBeGreaterThan(iEnv);
    expect(iTools).toBeGreaterThan(iDoc);
  });

  test("is deterministic given fixed inputs", () => {
    const a = buildSystemPrompt(baseOpts({ projectDoc: "doc" }));
    const b = buildSystemPrompt(baseOpts({ projectDoc: "doc" }));
    expect(a).toBe(b);
  });

  test("mentions concision", () => {
    const prompt = buildSystemPrompt(baseOpts()).toLowerCase();
    expect(prompt).toContain("concise");
  });
});

describe("summarizeGitStatus", () => {
  test("reports the branch and clean state", () => {
    const out = summarizeGitStatus("## main...origin/main\n");
    expect(out).toBe("branch main...origin/main, clean");
  });

  test("counts changed and untracked entries", () => {
    const porcelain = ["## main", " M src/a.ts", "A  src/b.ts", "?? scratch.txt"].join("\n");
    const out = summarizeGitStatus(porcelain);
    expect(out).toBe("branch main, 2 changed, 1 untracked");
  });

  test("handles missing branch line", () => {
    const out = summarizeGitStatus(" M only.ts\n");
    expect(out).toBe("no branch, 1 changed");
  });

  test("empty input is a clean no-branch summary", () => {
    expect(summarizeGitStatus("")).toBe("no branch, clean");
  });
});

describe("readProjectDoc", () => {
  test("returns trimmed-nonempty contents when OM.md exists", async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "OM.md"), "# Conventions\nbe nice");
    const doc = await readProjectDoc(dir);
    expect(doc).toBe("# Conventions\nbe nice");
  });

  test("returns null when OM.md is absent", async () => {
    const dir = makeTmpDir();
    expect(await readProjectDoc(dir)).toBeNull();
  });

  test("returns null when OM.md is empty/whitespace", async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "OM.md"), "   \n\t\n");
    expect(await readProjectDoc(dir)).toBeNull();
  });
});

describe("gitStatus", () => {
  test("returns null for a non-git directory (never throws)", async () => {
    const dir = makeTmpDir();
    const result = await gitStatus(dir);
    expect(result).toBeNull();
  });

  test("returns a summary string for a real git repo", async () => {
    const dir = makeTmpDir();
    const init = Bun.spawnSync(["git", "init"], { cwd: dir });
    if (!init.success) {
      // git not available in this environment; defensive contract still holds.
      expect(await gitStatus(dir)).toBeNull();
      return;
    }
    Bun.spawnSync(["git", "config", "user.email", "t@t.t"], { cwd: dir });
    Bun.spawnSync(["git", "config", "user.name", "t"], { cwd: dir });
    writeFileSync(join(dir, "untracked.txt"), "hi");
    const result = await gitStatus(dir);
    expect(result).not.toBeNull();
    expect(result).toContain("untracked");
  });
});
