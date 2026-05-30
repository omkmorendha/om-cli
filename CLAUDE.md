# om-cli

A terminal-native agentic coding harness (in the spirit of Claude Code / Codex).
**Stack:** Bun + TypeScript (strict) + OpenTUI, with a provider abstraction over
Anthropic (Messages API) and OpenAI (Responses API).

## Source of truth

The `spec/` folder is the **authoritative specification** for this project. It is a
wiki of self-contained HTML files. Before implementing or changing behavior, consult
the spec; if reality and spec disagree, either change the code to match the spec or
update the spec deliberately — **never let code and spec silently diverge.**

- **Entry point:** `spec/index.html` — the hub. Lists every spec page with a status
  badge (Current / Draft / Planned) and links it.
- **Core spec:** `spec/v0.html` — the current, buildable v0 spec (architecture, agent
  loop, provider layer, tools, permissions, sessions, TUI, milestones, decisions).

## Spec wiki conventions

- **One topic per file.** Each page is a standalone HTML file, lowercase-kebab named
  (e.g. `providers.html`, `tools.html`, `diff-ui.html`).
- **Versioned core spec.** The core spec is versioned (`v0.html`, later `v1.html`, …).
  Old versions are **kept, never overwritten** — they are the historical record.
- **Index is the hub.** When you add a page, register it in `spec/index.html` with a
  status badge and a one-line description.
- **Shared styling.** Reuse the existing inline dark theme and layout (sidebar nav for
  long pages, page grid for the index) so the wiki reads as one cohesive document.
- **Back-link.** Every page links back to `index.html` (the "↑ Spec Index" link).
- **Self-contained.** No external assets or CDNs — all CSS is inline so any page opens
  offline directly from disk.

## Build conventions (per v0 spec)

- **Provider-agnostic core.** The agent loop is written once; providers sit behind a
  single `Provider` interface. Store messages in our canonical internal format, never
  provider-native shapes.
- **Tools are the only side-effect surface.** Every effect goes through a registered,
  zod-schema-validated tool and the permission gate. The model never touches disk
  directly.
- **Schema lib:** `zod` (use `z.toJSONSchema` for the model-facing tool schemas).
- **Edit strategy:** exact-string replacement (`old_string` → `new_string`, must match
  uniquely, file must have been read this session) plus a full-file `write`. Unified-diff
  is deferred to land with the diff review UI. Line-range editing is rejected.
- **Permissions:** coarse classes — `read` (auto-allow), `write` / `exec` (prompt). No
  project-root path jail in v0; the approval prompt is the boundary.
- **Streaming-first, stop-anywhere.** Stream text/tool events to the TUI; thread an
  `AbortSignal` through the provider stream and `Bun.spawn` for clean Ctrl-C unwind.
- **Bun-native bias.** Prefer `Bun.spawn` / `Bun.file` / `Bun.Glob` over npm equivalents.

## Layout

```
om-cli/
├── CLAUDE.md          # this file — conventions
├── spec/              # source of truth (HTML wiki)
│   ├── index.html     # hub
│   └── v0.html        # current core spec
└── src/               # implementation (see v0 spec §11 for planned tree)
```

Secrets (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) come from env only — never written to
config, transcript, or committed files. Local runtime state lives in `.om/` (gitignored).
