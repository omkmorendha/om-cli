import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadConfig,
  defaultConfig,
  configSchema,
  resolveApiKey,
  requireApiKey,
  DEFAULT_MODELS,
  API_KEY_ENV_VAR,
} from "./config.ts";

// ─────────────────────────────────────────────────────────────────────────────
// temp-dir scaffolding so tests never touch the real home dir
// ─────────────────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "om-config-"));
  tmpDirs.push(dir);
  return dir;
}

/** Write a .om/config.json under `root` and return its path. */
function writeConfig(root: string, contents: string): string {
  const dir = join(root, ".om");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.json");
  writeFileSync(path, contents);
  return path;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

/** An env with no API keys and no overrides — points HOME at a tmp dir. */
function cleanEnv(home: string): Record<string, string | undefined> {
  return { HOME: home };
}

// ─────────────────────────────────────────────────────────────────────────────
// defaults
// ─────────────────────────────────────────────────────────────────────────────

describe("defaults", () => {
  test("defaultConfig matches the spec base", () => {
    expect(defaultConfig()).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-8",
      permissions: { autoAllow: ["read"], allowCommands: [] },
    });
  });

  test("loadConfig with no files returns built-in defaults", async () => {
    const home = makeTmp();
    const cwd = makeTmp();
    const cfg = await loadConfig({ cwd, env: cleanEnv(home) });
    expect(cfg).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-8",
      permissions: { autoAllow: ["read"], allowCommands: [] },
    });
  });

  test("openai provider with no model set falls back to gpt-5", async () => {
    const home = makeTmp();
    const cwd = makeTmp();
    writeConfig(cwd, JSON.stringify({ provider: "openai" }));
    const cfg = await loadConfig({ cwd, env: cleanEnv(home) });
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe(DEFAULT_MODELS.openai);
    expect(cfg.model).toBe("gpt-5");
  });

  test("openai provider keeps an explicit model", async () => {
    const home = makeTmp();
    const cwd = makeTmp();
    writeConfig(cwd, JSON.stringify({ provider: "openai", model: "gpt-5-mini" }));
    const cfg = await loadConfig({ cwd, env: cleanEnv(home) });
    expect(cfg.model).toBe("gpt-5-mini");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// merge precedence
// ─────────────────────────────────────────────────────────────────────────────

describe("merge precedence", () => {
  test("project overrides user overrides defaults", async () => {
    const home = makeTmp();
    const cwd = makeTmp();
    // user config: switch model + allow a command
    writeConfig(home, JSON.stringify({
      model: "claude-user-model",
      permissions: { allowCommands: ["npm test"] },
    }));
    // project config: override model again + autoAllow
    writeConfig(cwd, JSON.stringify({
      model: "claude-project-model",
      permissions: { autoAllow: ["read", "write"] },
    }));

    const cfg = await loadConfig({
      cwd,
      env: cleanEnv(home),
      userConfigPath: join(home, ".om", "config.json"),
      projectConfigPath: join(cwd, ".om", "config.json"),
    });

    expect(cfg.provider).toBe("anthropic"); // untouched default
    expect(cfg.model).toBe("claude-project-model"); // project wins over user
    // arrays replace wholesale per layer; project set autoAllow, user set allowCommands
    expect(cfg.permissions.autoAllow).toEqual(["read", "write"]);
    expect(cfg.permissions.allowCommands).toEqual(["npm test"]);
  });

  test("env OM_PROVIDER / OM_MODEL override files", async () => {
    const home = makeTmp();
    const cwd = makeTmp();
    writeConfig(cwd, JSON.stringify({ provider: "anthropic", model: "claude-x" }));
    const cfg = await loadConfig({
      cwd,
      env: { HOME: home, OM_PROVIDER: "openai", OM_MODEL: "gpt-custom" },
    });
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-custom");
  });

  test("explicit overrides win over env and files", async () => {
    const home = makeTmp();
    const cwd = makeTmp();
    writeConfig(cwd, JSON.stringify({ model: "from-file" }));
    const cfg = await loadConfig({
      cwd,
      env: { HOME: home, OM_MODEL: "from-env" },
      overrides: { model: "from-flag", allowCommands: ["git status"] },
    });
    expect(cfg.model).toBe("from-flag");
    expect(cfg.permissions.allowCommands).toEqual(["git status"]);
  });

  test("OM_PROVIDER=openai with no model anywhere resolves gpt-5 default", async () => {
    const home = makeTmp();
    const cwd = makeTmp();
    const cfg = await loadConfig({ cwd, env: { HOME: home, OM_PROVIDER: "openai" } });
    expect(cfg.model).toBe("gpt-5");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// missing files tolerated
// ─────────────────────────────────────────────────────────────────────────────

describe("missing files", () => {
  test("absent user and project files are tolerated", async () => {
    const home = makeTmp();
    const cwd = makeTmp();
    // no .om/config.json written anywhere
    const cfg = await loadConfig({ cwd, env: cleanEnv(home) });
    expect(cfg).toEqual(defaultConfig());
  });

  test("empty config file is treated as no overrides", async () => {
    const home = makeTmp();
    const cwd = makeTmp();
    writeConfig(cwd, "   \n  ");
    const cfg = await loadConfig({ cwd, env: cleanEnv(home) });
    expect(cfg).toEqual(defaultConfig());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// bad input surfaces clear errors
// ─────────────────────────────────────────────────────────────────────────────

describe("bad input", () => {
  test("malformed JSON throws a sourced error", async () => {
    const home = makeTmp();
    const cwd = makeTmp();
    const path = writeConfig(cwd, "{ not valid json ]");
    await expect(loadConfig({ cwd, env: cleanEnv(home) })).rejects.toThrow(
      /Invalid JSON in config file/,
    );
    // error references the offending path
    await expect(loadConfig({ cwd, env: cleanEnv(home) })).rejects.toThrow(path);
  });

  test("schema violation (bad provider) throws a clear error", async () => {
    const home = makeTmp();
    const cwd = makeTmp();
    writeConfig(cwd, JSON.stringify({ provider: "gemini" }));
    await expect(loadConfig({ cwd, env: cleanEnv(home) })).rejects.toThrow(
      /Invalid config in/,
    );
  });

  test("unknown key in config file is rejected", async () => {
    const home = makeTmp();
    const cwd = makeTmp();
    writeConfig(cwd, JSON.stringify({ providr: "anthropic" }));
    await expect(loadConfig({ cwd, env: cleanEnv(home) })).rejects.toThrow(
      /Invalid config in/,
    );
  });

  test("bad permission class is rejected", async () => {
    const home = makeTmp();
    const cwd = makeTmp();
    writeConfig(cwd, JSON.stringify({ permissions: { autoAllow: ["delete"] } }));
    await expect(loadConfig({ cwd, env: cleanEnv(home) })).rejects.toThrow(
      /Invalid config in/,
    );
  });

  test("invalid OM_PROVIDER env throws a clear error", async () => {
    const home = makeTmp();
    const cwd = makeTmp();
    await expect(
      loadConfig({ cwd, env: { HOME: home, OM_PROVIDER: "gemini" } }),
    ).rejects.toThrow(/Invalid OM_PROVIDER/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// API keys (never in Config)
// ─────────────────────────────────────────────────────────────────────────────

describe("api keys", () => {
  test("resolveApiKey picks the right env var per provider", () => {
    const env = { ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai" };
    expect(resolveApiKey("anthropic", env)).toBe("sk-ant");
    expect(resolveApiKey("openai", env)).toBe("sk-oai");
    expect(API_KEY_ENV_VAR.anthropic).toBe("ANTHROPIC_API_KEY");
    expect(API_KEY_ENV_VAR.openai).toBe("OPENAI_API_KEY");
  });

  test("resolveApiKey returns undefined when missing or blank", () => {
    expect(resolveApiKey("anthropic", {})).toBeUndefined();
    expect(resolveApiKey("openai", { OPENAI_API_KEY: "   " })).toBeUndefined();
  });

  test("requireApiKey throws a clear, named error when missing", () => {
    expect(() => requireApiKey("anthropic", {})).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => requireApiKey("openai", {})).toThrow(/OPENAI_API_KEY/);
  });

  test("requireApiKey returns the trimmed key when present", () => {
    expect(requireApiKey("openai", { OPENAI_API_KEY: "  sk-oai  " })).toBe("sk-oai");
  });

  test("loadConfig never requires a key and never embeds one", async () => {
    const home = makeTmp();
    const cwd = makeTmp();
    const cfg = await loadConfig({
      cwd,
      env: { HOME: home, ANTHROPIC_API_KEY: "sk-secret" },
    });
    expect(JSON.stringify(cfg)).not.toContain("sk-secret");
    expect(Object.keys(cfg)).toEqual(["provider", "model", "permissions"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// schema export
// ─────────────────────────────────────────────────────────────────────────────

describe("configSchema", () => {
  test("accepts a fully-formed config", () => {
    const r = configSchema.safeParse(defaultConfig());
    expect(r.success).toBe(true);
  });

  test("rejects a config missing required fields", () => {
    const r = configSchema.safeParse({ provider: "anthropic" });
    expect(r.success).toBe(false);
  });
});
