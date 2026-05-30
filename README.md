# om-cli

A terminal-native **agentic coding harness** — in the spirit of Claude Code / Codex. An
LLM drives a loop, calls tools to read and modify the local filesystem and run commands,
and a TUI renders the conversation, tool activity, and approvals.

> **Status: work in progress (v0 in active development).** The core (agent loop, providers,
> tools, permissions, sessions) is implemented and tested; the TUI and entry-point wiring are
> next. See [Status](#status) below for the live picture.

**Stack:** [Bun](https://bun.sh) · TypeScript (strict) · [OpenTUI](https://github.com/sst/opentui) ·
[zod](https://zod.dev) 4 · Anthropic Messages API + OpenAI Responses API.

---

## Why

A small, legible harness you can actually read end-to-end. The design bias is:

- **Provider-agnostic core** — the agent loop is written once; Anthropic and OpenAI sit behind
  one `Provider` interface, and the session stores messages in a single canonical format.
- **Tools are the only side-effect surface** — the model never touches disk directly. Every
  effect flows through a registered, zod-validated tool that passes the permission gate.
- **Streaming-first, stop-anywhere** — text and tool events stream to the frontend as they
  arrive; an `AbortSignal` threads through the provider stream and `Bun.spawn` for clean Ctrl-C.

## Specification (source of truth)

The [`spec/`](./spec) folder is the authoritative design wiki — when code and spec disagree,
the spec wins or the spec gets updated. Open [`spec/index.html`](./spec/index.html) in a browser,
or read the pages directly:

| Page | What it covers |
|------|----------------|
| [`spec/v0.html`](./spec/v0.html) | The core spec: architecture, agent loop, providers, tools, permissions, sessions, TUI, milestones, decisions. |
| [`spec/providers.html`](./spec/providers.html) | Anthropic / OpenAI Responses adapters — wire-format mappings, streaming parse, cancellation. |
| [`spec/tools.html`](./spec/tools.html) | Per-tool contracts: zod schemas, result shapes, truncation policy, the exact-string edit algorithm. |
| [`spec/tui.html`](./spec/tui.html) | OpenTUI component tree, event wiring, keybindings. |
| [`spec/roadmap.html`](./spec/roadmap.html) | Post-v0 features (MCP, sub-agents, compaction, diff UI…). |
| [`spec/decisions.html`](./spec/decisions.html) | ADR-style decision log. |

Conventions for the codebase and the spec wiki live in [`CLAUDE.md`](./CLAUDE.md).

## Architecture

One Bun process. A UI-agnostic **core** emits a typed `AgentEvent` async-iterable; a
**frontend** (TUI, or a headless stdout fallback) consumes it and produces user input.

```
┌──────────────────────────────────────────────┐
│  Frontend (OpenTUI / headless stdout)          │
│  input · scrollback · tool cards · approvals   │
└───────────────▲────────────────────┬───────────┘
       input    │            events  │  (text / tool / approval)
┌───────────────┴────────────────────▼───────────┐
│  Core                                            │
│   Agent Loop ─▶ Provider (Anthropic / OpenAI)    │
│        │        Session + JSONL transcript       │
│        ▼                                          │
│   Tool Registry ─▶ Permission Gate ─▶ Effects     │
│   (read/ls/glob/grep/write/edit/bash)             │
└──────────────────────────────────────────────────┘
```

## Getting started

Requires **Bun ≥ 1.3**.

```bash
bun install

# API keys (read from env only — never written to config or transcripts)
cp .env.example .env        # then fill in ANTHROPIC_API_KEY / OPENAI_API_KEY

bun run typecheck           # tsc --noEmit
bun test                    # bun:test suite
bun run om                  # launch the harness  (entry point: in progress)
```

Configuration is merged from built-in defaults → `~/.om/config.json` → `./.om/config.json`
→ env/flags. Example project config:

```jsonc
// .om/config.json
{
  "provider": "anthropic",          // or "openai"
  "model": "claude-opus-4-8",
  "permissions": {
    "autoAllow": ["read"],
    "allowCommands": ["bun test", "git status"]
  }
}
```

## Layout

```
om-cli/
├── CLAUDE.md            # codebase + spec conventions
├── spec/                # source-of-truth design wiki (HTML)
├── src/
│   ├── core/            # types, session, prompt, agent loop, events
│   ├── providers/       # anthropic.ts, openai.ts (canonical ⇄ wire adapters)
│   ├── tools/           # fs (read/ls/glob/grep/write/edit), bash, registry, truncate
│   ├── permission/      # approval gate
│   ├── tui/             # OpenTUI frontend (in progress)
│   ├── util/            # structured JSONL logger
│   └── config.ts        # config resolution
└── test co-located as *.test.ts next to each module
```

## Tooling & debugging

- **Logging** — a structured JSONL logger writes to `.om/logs/<session>.jsonl` (full fidelity,
  always on) with scoped child loggers and secret redaction. Set `OM_LOG_LEVEL=debug` (or use
  `bun run dev`) to also stream logs to stderr. Logs never go to stdout, so they can't corrupt
  the TUI.
- **Transcripts** — every session appends a replayable JSONL transcript to `.om/transcripts/`.
- **Tests** — `bun test`. Provider adapters are tested as pure serialize/parse functions against
  synthetic SDK events (no network, no keys required).

## Status

v0 milestones (see [`spec/v0.html` §12](./spec/v0.html)):

- [x] Scaffold, strict TS, structured logging
- [x] Canonical types + session + JSONL transcript
- [x] Tools: read · ls · glob · grep · write · edit (exact-string) · bash
- [x] Permission gate (auto-allow / prompt / session-allowlist)
- [x] Anthropic (Messages) + OpenAI (Responses) provider adapters
- [x] Agent loop (streaming, sequential tools, abort, turn cap)
- [x] `tsc --noEmit` clean · `bun test` green (216 tests)
- [ ] OpenTUI frontend + `main.ts` wiring  ← *next*

## License

MIT — see [LICENSE](./LICENSE).
