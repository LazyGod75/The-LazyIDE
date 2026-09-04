# LazyBrain + Mistral Vibe

LazyBrain ingests Mistral Vibe sessions and turns them into the same queryable HTML brain it builds from Claude Code conversations. After a one-time `lazybrain init --agent vibe`, every Vibe session is captured incrementally: decisions, file edits, plans, and compaction lineage all flow into the brain and become available via the same CSS selectors and skills you already use.

## What you get

| Capability | Mechanism |
|---|---|
| Batch ingest (`lazybrain dream --agent vibe`) | Reads `$VIBE_HOME/logs/session/*/messages.jsonl`, nested subagent logs, `plans/*.md`, and `vibehistory`. Incremental via SHA-256 fingerprints. |
| Live capture (hook) | `post_agent_turn` hook calls `vibe-hook.mjs`, which POSTs to the LazyBrain daemon `/capture-vibe` with an incremental cursor. Zero extra turns or UI noise. |
| Compaction lineage | A session containing a Vibe compaction summary yields an additional `compaction-summary` note linked to the parent session via `data-cerveau-session-parent`. The brain keeps what Vibe's compaction destroys. |
| AGENTS.md projection | `lazybrain export-agents-md --target user|project` writes settled decisions and warnings between idempotent markers. Vibe loads AGENTS.md into its system prompt at session start. |
| Skills / slash commands | Five recall skills (`/lazybrain-recall`, `/lazybrain-search`, `/lazybrain-query`, `/lazybrain-summary`, `/lazybrain-time-travel`) installed to `~/.agents/skills/` — the cross-agent directory Vibe scans natively. |
| Spatial recall (`--tools`) | `lazybrain_read.py` replaces Vibe's builtin `read` tool. When the model reads a file the brain knows about, settled facts about that file are appended to the tool result via `get_result_extra` — zero schema tokens, recall surfaced at the moment of navigation. |
| Brain-aware explore (`--explore`) | Overrides Vibe's builtin `explore` subagent with a profile that calls `lazybrain search` and `lazybrain query` before scanning files. |

---

## Prerequisites

1. **mistral-vibe** installed and authenticated:
   ```bash
   pip install mistral-vibe   # or: uv add mistral-vibe
   vibe --version              # must print a version string
   ```

2. **MISTRAL_API_KEY** exported:
   ```bash
   export MISTRAL_API_KEY=sk-...
   vibe "hello"                # auth smoke test
   ```

---

## Quickstart

### 1. Install LazyBrain

```bash
git clone https://github.com/LazyGod75/LazyBrain.git
cd LazyBrain
npm install && npm run build && npm link
lazybrain init   # initialise the brain directory
```

### 2. Connect to Vibe

```bash
lazybrain init --agent vibe --enable-hooks --tools --explore
```

What each flag does:

| Flag | Effect |
|---|---|
| `--agent vibe` | Required. Installs the hook shim, skills, and configures Vibe integration. |
| `--enable-hooks` | Explicit consent required. Sets `enable_experimental_hooks = true` in `~/.vibe/config.toml`. Vibe hooks are an experimental feature with a single event type (`post_agent_turn`). Without this flag the hook entry is installed but stays dormant. |
| `--tools` | Installs `lazybrain_read.py` into `~/.vibe/tools/`. Effective only in the Vibe TUI (see Limitations). |
| `--explore` | Installs `~/.vibe/agents/explore.toml` and `~/.vibe/prompts/explore.md` — a brain-aware override of Vibe's builtin explore subagent. |

The command requires an existing Vibe installation (`~/.vibe/` must exist). Set `VIBE_HOME` to override the location.

### 3. Start the daemon (recommended before first session)

```bash
lazybrain daemon start
```

The hook shim auto-spawns the daemon on the first hook call, but the first
Vibe turn then waits ~6 s for it to come up. Starting it explicitly avoids
that latency.

### 4. Run the first batch ingest

```bash
lazybrain dream --agent vibe --pretty
lazybrain index-rebuild
```

First run processes every Vibe session. Subsequent runs skip unchanged files (incremental). After that, the live hook keeps the brain up to date automatically on each Vibe turn.

---

## How each surface works

### Hook / write path

The hook entry added to `~/.vibe/hooks.toml` is merge-safe: `lazybrain init` parses the existing TOML, replaces only the `lazybrain-capture` entry (keyed by name), and never touches other hooks. The hook shim is copied to `~/.lazybrain/hooks/vibe-hook.mjs` at init time — a stable location that survives npm reinstalls. `hooks.toml` references this stable path; re-running `init` refreshes the copy so upgrades take effect.

Known limitation: smol-toml rewrites `hooks.toml` without preserving TOML comments. This is a constraint of the smol-toml library, not a LazyBrain bug.

The shim reads Vibe's `HookInvocation` JSON from stdin, POSTs to the LazyBrain daemon on port 37788 (configurable via `LAZYBRAIN_PORT`), and always exits 0. It never writes to stdout — Vibe would re-inject stdout as a user message (exit code 2 + stdout is the retry-inject footgun).

The daemon endpoint `/capture-vibe` maintains a per-transcript cursor (stored in `<cache>/vibe-cursors.json`) so only new messages since the last hook call are processed.

Each stored note is immediately indexed into FTS so queries reflect live captures without any manual rebuild step. After a successful note store, the project-level `AGENTS.md` is also regenerated automatically — at most once every `LAZYBRAIN_VIBE_REFRESH_SECONDS` (default 300 s). This debounce only fires on **live captures** (hook calls); after a batch `lazybrain dream --agent vibe` ingest, run `lazybrain export-agents-md` manually to propagate bulk changes.

### AGENTS.md projection

`lazybrain export-agents-md --target project [--cwd .]` writes a block between:

```
<!-- lazybrain:begin generated:do-not-edit -->
<!-- lazybrain:end -->
```

LazyBrain owns only what is between the markers. Human prose outside the markers is never touched. Unbalanced or duplicated markers cause an abort (no partial write). The block is deterministic: same brain state produces byte-identical output.

Two scopes:
- **user target** (`~/.vibe/AGENTS.md`) — recall instructions only; no per-project facts.
- **project target** (`./AGENTS.md`) — active decisions and warnings scoped to the current working directory.

Run this after `dream` and re-run periodically to keep it fresh. Token budget defaults to 1200 tokens; override with `--max-tokens N`.

### Skills / slash commands

`lazybrain init --agent vibe` copies five skills to `~/.agents/skills/<name>/SKILL.md`. Vibe scans `~/.agents/skills/` natively, making them available as `/lazybrain-*` slash commands in any Vibe session without further configuration.

| Slash command | Purpose |
|---|---|
| `/lazybrain-recall` | Pull specific sections of prior work from the brain |
| `/lazybrain-search` | Full-text and semantic search |
| `/lazybrain-query` | Deterministic CSS selector query (<5 ms, $0) |
| `/lazybrain-summary` | Brain stats and distribution overview |
| `/lazybrain-time-travel` | Reconstruct brain state at a past date |

### Lazy spatial recall

**TUI-only.** `~/.vibe/tools/lazybrain_read.py` (installed with `--tools`) registers as `read` in Vibe's tool registry. Because user tools are loaded after builtins, the class name `Read` overrides the builtin transparently. Only `get_result_extra` is overridden — the underlying file read is unchanged.

This mechanism does not work in Vibe's ACP/editor loop because that loop does not call `get_result_extra`. Spatial recall is inert outside the TUI.

When the model reads a file, the tool runs one `lazybrain query` subprocess (hard-capped at 0.8 s) against the CSS selector:

```css
article[data-cerveau-files-modified*="<last-two-path-segments>"]:not([data-cerveau-valid-until])
```

If the brain holds settled facts about that file, they are appended as a `<lazybrain-memory>` block in the tool result. The selector is deduplicated per session so each unique directory is queried at most once.

Any failure (brain unavailable, `lazybrain` not on PATH, timeout) falls back to plain builtin behavior silently.

### Brain-aware explore

`~/.vibe/agents/explore.toml` overrides Vibe's builtin `explore` subagent with a profile that adds `bash` to the allowed tools. The matching prompt (`~/.vibe/prompts/explore.md`) instructs the subagent to call `lazybrain search` and `lazybrain query` before scanning files, then synthesize memory findings and fresh file findings together. If LazyBrain is unavailable, the subagent proceeds with normal file exploration.

---

## Extraction profiles

LLM enrichment (optional, used by `lazybrain enrich` and `lazybrain dream --enrich`) can be routed through several backends.

### Vibe subscription (default-friendly)

```bash
export LAZYBRAIN_EXTRACTOR=vibe
lazybrain dream --agent vibe --enrich
```

Extraction runs through your existing Vibe install and its configured Mistral account. No extra API key needed. LazyBrain spawns `vibe -p "<prompt>" --output text --max-turns 1 --trust` and reads the assistant's response from stdout. The `--max-turns 1` flag limits the agent to a single completion turn, preventing multi-step tool chains during fact extraction.

Requires Vibe to be installed and authenticated (`vibe --version` must succeed). Override the binary path with `LAZYBRAIN_VIBE_BIN=/path/to/vibe` if needed.

### Local — llama.cpp serving devstral

```bash
export LAZYBRAIN_EXTRACTOR=devstral
# Requires a local OpenAI-compatible server running at http://127.0.0.1:8080/v1
# (the default endpoint — override with LAZYBRAIN_OPENAI_BASE_URL if needed)
lazybrain dream --agent vibe --enrich
```

`LAZYBRAIN_EXTRACTOR=devstral` requires a local OpenAI-compatible server (e.g.
llama.cpp, ollama) already running at the default endpoint
`http://127.0.0.1:8080/v1`. LazyBrain does not start the server. The request
fails silently (falls back to heuristic extraction) if the server is unreachable.

### Cloud — Mistral API

```bash
export LAZYBRAIN_EXTRACTOR=devstral
export LAZYBRAIN_OPENAI_BASE_URL=https://api.mistral.ai/v1
export LAZYBRAIN_OPENAI_MODEL=devstral-small-latest
export MISTRAL_API_KEY=your-key-here
lazybrain dream --agent vibe --enrich
```

### Sovereign mode — no remote calls

Remote model downloads are **off by default** (env unset). The explicit `=0` value enforces silent air-gapped mode:

```bash
export LAZYBRAIN_ALLOW_REMOTE_MODELS=0   # forbid silently (air-gapped)
# PowerShell: $env:LAZYBRAIN_ALLOW_REMOTE_MODELS = "0"
lazybrain dream --agent vibe
```

When `LAZYBRAIN_ALLOW_REMOTE_MODELS=0`, no embeddings model or LLM is contacted over the network. Retrieval degrades to FTS5 (L2) only — no L3 semantic search. Batch ingest without `--enrich` never calls an LLM regardless of this flag.

To enable on-demand download with a visible consent notice: `LAZYBRAIN_ALLOW_REMOTE_MODELS=1`. For a one-time explicit install: `npm run download-models` (the recommended approach).

---

## Query cookbook

All examples use `lazybrain query '<selector>'`. Add `--strip` for plain-text output suitable for piping into a prompt.

```bash
# Active decisions from Vibe sessions only
lazybrain query 'article[data-cerveau-agent="vibe"][data-cerveau-type="decision"]:not([data-cerveau-valid-until])'

# All notes about a specific file (any agent)
lazybrain query 'article[data-cerveau-files-modified*="src/auth/middleware"]:not([data-cerveau-valid-until])'

# Subagent transcripts only — useful to find what explore or other subagents found
lazybrain query 'article[data-cerveau-source-kind="subagent"]:not([data-cerveau-valid-until])'

# Notes generated from plans (decision-grade, high signal)
lazybrain query 'article[data-cerveau-source-kind="plan"]' --strip

# Compaction-lineage recovery: what was in the session before this one was compacted
lazybrain query 'article[data-cerveau-source-kind="compaction-summary"][data-cerveau-session-parent="<parent-session-id>"]'

# Git-anchored time-travel: what did the brain know on a specific branch
lazybrain query 'article[data-cerveau-git-branch="feat/payments"]:not([data-cerveau-valid-until])'

# Notes created on or after a specific commit
lazybrain query 'article[data-cerveau-git-commit="abc1234"]:not([data-cerveau-valid-until])'

# High-importance Vibe facts not yet invalidated (importance >= 0.8 stored as attribute)
lazybrain query 'article[data-cerveau-agent="vibe"][data-cerveau-importance>="0.8"]:not([data-cerveau-valid-until])' --strip
```

---

## Extractor backend precedence

When `LAZYBRAIN_EXTRACTOR` is set, the following precedence applies (first match wins):

| `LAZYBRAIN_EXTRACTOR` value | Resolved backend | Notes |
|---|---|---|
| `vibe` | vibe | Requires Vibe installed and authenticated |
| `devstral` | openai | Requires local server at `LAZYBRAIN_OPENAI_BASE_URL` (default `http://127.0.0.1:8080/v1`) |
| `anthropic` | anthropic | Requires `ANTHROPIC_API_KEY` |
| `haiku` | anthropic | Legacy alias |
| `claude` | anthropic | Legacy alias |
| `claude-cli` | claude-cli | Requires active Claude Code session; never auto-selected |
| _(unset)_ + `ANTHROPIC_API_KEY` set | anthropic | Auto-selected |
| _(unset)_ + no key | openai | Sovereign local default (fails silently if server unreachable) |

---

## Limitations

- **Hooks are experimental.** Vibe's hook system is experimental as of this writing. It exposes a single event type (`post_agent_turn`). `--enable-hooks` sets the required flag in `config.toml` only with explicit consent.
- **Spatial recall is TUI-only.** `lazybrain_read.py` works by overriding `get_result_extra`. Vibe's ACP/editor loop does not call `get_result_extra`, so spatial recall is inert outside the TUI.
- **AGENTS.md auto-refresh is live-only.** The debounced auto-refresh (default 300 s) only fires on live hook captures. After `lazybrain dream --agent vibe`, run `lazybrain export-agents-md` manually.
- **`/clear` ends the lineage chain (v2.9.4+).** Since Vibe v2.9.4, `/clear` no longer chains `parent_session_id` to the previous session. A lineage chain may simply end at a `/clear` — no `data-cerveau-session-parent` attribute is written for those sessions.
- **hooks.toml comments are lost on re-init.** smol-toml rewrites the file without preserving TOML comments. This is a smol-toml library constraint.
- **Session schema may drift.** Vibe is pre-1.0. Its `messages.jsonl` format is not a stable contract. The parser is tolerant (per-line try/catch, unknown fields ignored) but a major schema change could reduce extraction quality without an error.
- **Bash skills may prompt for tool permissions.** The `/lazybrain-*` skills run `lazybrain` via bash. Depending on your Vibe tool configuration, the first invocation may trigger a tool-permission prompt. Allow `lazybrain` commands once and the prompt will not recur.
- **`dream --agent vibe` skips LazyBrain's own sessions.** Any session whose working directory matches `cerveau|lazybrain` (case-insensitive) is excluded to prevent self-ingest loops.
- **Plan ingest is best-effort.** `~/.vibe/plans/*.md` files are truncated at 4000 characters. Very long plans lose their tail.

---

## Uninstall

```bash
# 1. Remove the hook entry from ~/.vibe/hooks.toml
#    Open the file and delete the [[hooks]] block where name = "lazybrain-capture".

# 2. Remove the skills
rm -rf ~/.agents/skills/lazybrain-recall
rm -rf ~/.agents/skills/lazybrain-search
rm -rf ~/.agents/skills/lazybrain-query
rm -rf ~/.agents/skills/lazybrain-summary
rm -rf ~/.agents/skills/lazybrain-time-travel

# 3. Remove the spatial recall tool (if installed with --tools)
rm ~/.vibe/tools/lazybrain_read.py

# 4. Remove the explore override (if installed with --explore)
rm ~/.vibe/agents/explore.toml
rm ~/.vibe/prompts/explore.md

# 5. Optionally revert enable_experimental_hooks in ~/.vibe/config.toml
#    Set enable_experimental_hooks = false or remove the line.
```

The brain itself (HTML notes, SQLite index) is unaffected — it continues to work for Claude Code or any other agent source.
