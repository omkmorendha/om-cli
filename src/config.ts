/**
 * Config loading + merge (spec v0 §11).
 *
 * Merge order (later wins):
 *   built-in defaults
 *     → user config (~/.om/config.json)
 *     → project config (<cwd>/.om/config.json)
 *     → env / CLI flag overrides.
 *
 * Files are read with Bun.file and tolerated when missing. Bad JSON or a value
 * that fails schema validation surfaces a clear, sourced error.
 *
 * API keys are NEVER part of Config. They come from the environment only and are
 * resolved separately via resolveApiKey / requireApiKey so config loading itself
 * never needs a key (spec §11).
 */

import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PermissionClass, ProviderId } from "./core/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

const permissionClassSchema: z.ZodType<PermissionClass> = z.enum([
  "read",
  "write",
  "exec",
]);

const providerSchema: z.ZodType<ProviderId> = z.enum(["anthropic", "openai"]);

const permissionsSchema = z.object({
  autoAllow: z.array(permissionClassSchema),
  allowCommands: z.array(z.string()),
});

/** Fully-resolved config schema (after merge + default-fill). */
export const configSchema = z.object({
  provider: providerSchema,
  model: z.string().min(1),
  permissions: permissionsSchema,
});

export type Config = z.infer<typeof configSchema>;

/**
 * Schema for a config *file* on disk: every field optional and partially
 * specified, so a file may override only the keys it cares about. This is what
 * we validate at the file boundary before merging.
 */
const partialPermissionsSchema = z
  .object({
    autoAllow: z.array(permissionClassSchema).optional(),
    allowCommands: z.array(z.string()).optional(),
  })
  .strict();

const fileConfigSchema = z
  .object({
    provider: providerSchema.optional(),
    model: z.string().min(1).optional(),
    permissions: partialPermissionsSchema.optional(),
  })
  .strict();

export type FileConfig = z.infer<typeof fileConfigSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

/** Per-provider default model, used when no model is configured. */
export const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: "claude-opus-4-8",
  openai: "gpt-5",
};

/** Built-in base config (before any file/env override). */
export function defaultConfig(): Config {
  return {
    provider: "anthropic",
    model: DEFAULT_MODELS.anthropic,
    permissions: {
      autoAllow: ["read"],
      allowCommands: [],
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Env / API keys
// ─────────────────────────────────────────────────────────────────────────────

/** Environment variable holding the API key for each provider. */
export const API_KEY_ENV_VAR: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

type Env = Record<string, string | undefined>;

/**
 * Resolve the API key for `provider` from `env`, or return undefined if absent.
 * Keys are read from the environment only and never persisted to Config.
 */
export function resolveApiKey(
  provider: ProviderId,
  env: Env = process.env,
): string | undefined {
  const varName = API_KEY_ENV_VAR[provider];
  const value = env[varName];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Like resolveApiKey but throws a clear error when the needed key is missing.
 * Kept separate from loadConfig so config loading never requires a key (§11).
 */
export function requireApiKey(provider: ProviderId, env: Env = process.env): string {
  const key = resolveApiKey(provider, env);
  if (key === undefined) {
    const varName = API_KEY_ENV_VAR[provider];
    throw new Error(
      `Missing API key for provider "${provider}": set the ${varName} environment variable.`,
    );
  }
  return key;
}

// ─────────────────────────────────────────────────────────────────────────────
// File reading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read and validate a config file. Returns undefined when the file is absent
 * (tolerated). Throws a clear, sourced error on malformed JSON or schema failure.
 */
async function readConfigFile(path: string): Promise<FileConfig | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;

  let raw: string;
  try {
    raw = await file.text();
  } catch (cause) {
    throw new Error(`Failed to read config file at ${path}: ${errMsg(cause)}`, {
      cause,
    });
  }

  // An empty (or whitespace-only) file is treated as no overrides.
  if (raw.trim().length === 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Invalid JSON in config file at ${path}: ${errMsg(cause)}`, {
      cause,
    });
  }

  const result = fileConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid config in ${path}: ${formatZodError(result.error)}`,
    );
  }
  return result.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge
// ─────────────────────────────────────────────────────────────────────────────

/** Overrides sourced from env vars and/or CLI flags (highest precedence). */
export interface ConfigOverrides {
  provider?: ProviderId;
  model?: string;
  autoAllow?: PermissionClass[];
  allowCommands?: string[];
}

/**
 * Apply a single layer of overrides onto an accumulator. Only defined keys
 * override; arrays replace wholesale (later wins), matching §11 semantics.
 */
function applyLayer(
  base: Config,
  layer: FileConfig | ConfigOverrides | undefined,
): Config {
  if (!layer) return base;

  const next: Config = {
    provider: base.provider,
    model: base.model,
    permissions: {
      autoAllow: base.permissions.autoAllow,
      allowCommands: base.permissions.allowCommands,
    },
  };

  if (layer.provider !== undefined) next.provider = layer.provider;
  if (layer.model !== undefined) next.model = layer.model;

  // permissions live under `permissions` for file configs, but flat for overrides.
  const filePerms = (layer as FileConfig).permissions;
  if (filePerms) {
    if (filePerms.autoAllow !== undefined) {
      next.permissions.autoAllow = filePerms.autoAllow;
    }
    if (filePerms.allowCommands !== undefined) {
      next.permissions.allowCommands = filePerms.allowCommands;
    }
  }
  const ov = layer as ConfigOverrides;
  if (ov.autoAllow !== undefined) next.permissions.autoAllow = ov.autoAllow;
  if (ov.allowCommands !== undefined) {
    next.permissions.allowCommands = ov.allowCommands;
  }

  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// loadConfig
// ─────────────────────────────────────────────────────────────────────────────

export interface LoadConfigOptions {
  /** Project root used to locate <cwd>/.om/config.json. Defaults to process.cwd(). */
  cwd?: string;
  /** Environment, injectable for tests. Defaults to process.env. */
  env?: Env;
  /** Explicit user-config path. Defaults to ~/.om/config.json (via env.HOME / homedir). */
  userConfigPath?: string;
  /** Explicit project-config path. Defaults to <cwd>/.om/config.json. */
  projectConfigPath?: string;
  /** Highest-precedence overrides (CLI flags etc.). */
  overrides?: ConfigOverrides;
}

/**
 * Load and merge config from defaults → user file → project file → overrides.
 * Missing files are tolerated; malformed files throw a clear error.
 *
 * The model default depends on the *resolved* provider: if no model is set
 * anywhere and the resolved provider is "openai", we fall back to gpt-5.
 */
export async function loadConfig(opts: LoadConfigOptions = {}): Promise<Config> {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

  const home = env.HOME ?? homedir();
  const userPath = opts.userConfigPath ?? join(home, ".om", "config.json");
  const projectPath = opts.projectConfigPath ?? join(cwd, ".om", "config.json");

  const userFile = await readConfigFile(userPath);
  const projectFile = await readConfigFile(projectPath);

  // Build the merge starting from defaults. We DON'T fill the model default yet,
  // because the resolved provider may shift it to the openai default.
  let merged: Config = applyLayer(defaultConfig(), undefined);
  merged = applyLayer(merged, userFile);
  merged = applyLayer(merged, projectFile);
  merged = applyLayer(merged, envOverrides(env));
  merged = applyLayer(merged, opts.overrides);

  // Provider-dependent model default: if the model was never explicitly set by
  // any layer, use the resolved provider's default model.
  const modelWasSet =
    userFile?.model !== undefined ||
    projectFile?.model !== undefined ||
    envOverrides(env).model !== undefined ||
    opts.overrides?.model !== undefined;

  if (!modelWasSet) {
    merged.model = DEFAULT_MODELS[merged.provider];
  }

  // Final validation guards against any internal inconsistency.
  const result = configSchema.safeParse(merged);
  if (!result.success) {
    throw new Error(`Invalid resolved config: ${formatZodError(result.error)}`);
  }
  return result.data;
}

/**
 * Read overrides from environment variables (e.g. OM_PROVIDER / OM_MODEL).
 * CLI flags should be passed via opts.overrides, which win over these.
 */
function envOverrides(env: Env): ConfigOverrides {
  const out: ConfigOverrides = {};
  const provider = env.OM_PROVIDER?.trim();
  if (provider) {
    const parsed = providerSchema.safeParse(provider);
    if (!parsed.success) {
      throw new Error(
        `Invalid OM_PROVIDER="${provider}": expected "anthropic" or "openai".`,
      );
    }
    out.provider = parsed.data;
  }
  const model = env.OM_MODEL?.trim();
  if (model) out.model = model;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function errMsg(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}
