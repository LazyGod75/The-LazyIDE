# LazyBrain CLI Reference

All commands are derived from `bin/lazybrain.ts`. Run `lazybrain --help` or
`lazybrain <command> --help` for the authoritative option list for your installed version.

Global option (applies to all commands):

```
--brain <path>   Override brain path (sets LAZYBRAIN_BRAIN_PATH_CLI).
                 Precedence: --brain flag > LAZYBRAIN_BRAIN_PATH env var
                 > walk-up to .lazybrain/ marker > ~/.lazybrain/brain fallback.
```

---

## Environment Variables

Configuration is set via environment variables. All are optional unless noted.

| Variable | Default | Purpose | Example |
|----------|---------|---------|---------|
| `LAZYBRAIN_BRAIN_PATH` | `~/.lazybrain/brain` | Location of the brain directory. Overridden by `--brain` CLI flag. | `/home/user/.lazybrain/brain` |
| `LAZYBRAIN_BRAIN_PATH_CLI` | _(none)_ | Set internally by `--brain` flag before `getConfig()` is called. Do not set directly. | — |
| `LAZYBRAIN_CACHE_PATH` | `<brain>/_cache` (inside the brain directory) | Cache directory for embeddings, telemetry, and hook cursors. On first run after upgrading from a version that stored the cache beside the brain, a one-time automatic copy-migration moves the old sibling `_cache` into the brain. | `/mnt/fast/cache` |
| `LAZYBRAIN_MODELS_PATH` | `~/.lazybrain/models` | Download location for ONNX embedding model (bge-base-en-v1.5). | `~/.local/share/models` |
| `LAZYBRAIN_LOG_LEVEL` | `info` | Logging verbosity. Valid: `debug`, `info`, `warn`, `error`. | `debug` |
| `LAZYBRAIN_TELEMETRY` | `1` | Emit anonymous telemetry to `_cache/telemetry.jsonl`. Set to `0` to disable. | `0` |
| `LAZYBRAIN_ALLOW_REMOTE_MODELS` | _(unset)_ | Three-state download gate: unset (default) = no downloads during queries — if model cached it is used, if absent L3/L4 degrade to L2 with a one-time stderr hint; `'1'` = allow on-demand download (visible consent notice); `'0'` = forbid downloads silently (air-gapped). Use `npm run download-models` for the explicit one-time install. | `0` |
| **LLM Extraction** (optional enrichment) | — | — | — |
| `LAZYBRAIN_EXTRACTOR` | _(none; auto-detects)_ | Extraction backend. Accepted values: `vibe` (Mistral Vibe CLI), `devstral` (local llama.cpp or Mistral API), `anthropic` (direct Anthropic API), `claude-cli` (Claude Code CLI — never auto-selected; requires an active session). When unset: uses `anthropic` if `ANTHROPIC_API_KEY` is set, otherwise falls back to `devstral` / local OpenAI-compatible endpoint (fails silently if unreachable). See docs/VIBE.md for full precedence table and setup. | `vibe` |
| **OpenAI-Compatible API** (for `devstral` or Mistral Cloud) | — | — | — |
| `LAZYBRAIN_OPENAI_BASE_URL` | `http://127.0.0.1:8080/v1` | Base URL for OpenAI-compatible endpoints. Default targets local llama.cpp Vibe backend. | `https://api.mistral.ai/v1` |
| `LAZYBRAIN_OPENAI_MODEL` | `devstral` | Model name for completions. Defaults to Vibe's local model. | `devstral-small-latest` |
| `LAZYBRAIN_OPENAI_API_KEY_ENV` | `MISTRAL_API_KEY` | Name of env var holding the API key (for cloud profiles). Leave unset or empty for local (no auth). | `MISTRAL_API_KEY` |
| **Anthropic / Claude API** (optional) | — | — | — |
| `ANTHROPIC_API_KEY` | _(none)_ | API key for direct Claude API calls (legacy, supports custom quota). If set, takes precedence over Claude Code CLI. See `src/annotator/llm.ts`. | _(secret)_ |
| **Mistral Vibe Enrichment** | — | — | — |
| `LAZYBRAIN_VIBE_BIN` | `vibe` | Path to Mistral Vibe CLI binary. Override if `vibe` is not on `$PATH`. | `/home/user/.vibe/bin/vibe` |
| `LAZYBRAIN_VIBE_REFRESH_SECONDS` | `300` | Debounce interval for auto-regenerating `AGENTS.md` after live hook captures. | `600` |
| **Hook / Daemon** (internal) | — | — | — |
| `LAZYBRAIN_PORT` | `37788` | Port for the LazyBrain daemon (spawned by hooks, optional for CLI). | `9000` |

**Notes:**
- **Brain path discovery** (in order, highest priority first):
  1. `--brain <path>` CLI flag
  2. `LAZYBRAIN_BRAIN_PATH` env var
  3. Walk up from cwd looking for a `.lazybrain/` directory
  4. Scan `~/Documents/Lazy-Brain*/` for a folder containing `brain/notes/` (legacy fallback — present for users who set up before v0.2)
  5. `~/.lazybrain/brain/` default (created on first use if missing)
- **ONNX embeddings** must be downloaded explicitly via `npm run download-models` (~530 MB). Remote downloads are opt-in: `LAZYBRAIN_ALLOW_REMOTE_MODELS` unset (default) = no downloads during queries; `'1'` = allow on-demand; `'0'` = forbid silently. If models are absent with the default, retrieval falls back to FTS5/L2 with a one-time stderr hint.
- **Extraction backends** (see docs/VIBE.md for full precedence table and setup):
  - `vibe`: Mistral Vibe subscription (uses `vibe` CLI, no extra key).
  - `devstral`: Local llama.cpp (default `http://127.0.0.1:8080/v1`) or Mistral API (`https://api.mistral.ai/v1` + `MISTRAL_API_KEY`).
  - `anthropic`: Direct Anthropic API (`ANTHROPIC_API_KEY`). Legacy aliases `haiku` and `claude` resolve to this backend.
  - `claude-cli`: Requires an active Claude Code session; never auto-selected.

---

## Brain Setup

### `init`

Bootstrap a new LazyBrain brain, or install an agent integration.

**Brain path resolution order** (highest priority first):
1. `--brain <path>` flag
2. `LAZYBRAIN_BRAIN_PATH` env var
3. `$CWD/.lazybrain/brain` (local project default)

Always prints `Initialized brain at <path>` on stdout (+ `(from LAZYBRAIN_BRAIN_PATH)` when the env var determined the path).

```
lazybrain init
lazybrain init --brain /path/to/my/brain
lazybrain init --agent vibe --enable-hooks --tools --explore
```

```bash
# PowerShell — set env first, then init:
$env:LAZYBRAIN_BRAIN_PATH = "C:\my\project\brain"
lazybrain init

# Bash/sh:
export LAZYBRAIN_BRAIN_PATH=/my/project/brain
lazybrain init
```

| Option | Description |
|--------|-------------|
| `--brain <path>` | Explicit brain directory path (overrides env var and cwd default). |
| `--agent <name>` | Install integration for an agent. Currently `vibe` only. |
| `--enable-hooks` | (vibe) Set `enable_experimental_hooks=true` in config.toml. |
| `--tools` | (vibe) Install the LazybrainRead spatial-recall tool. |
| `--explore` | (vibe) Install the brain-aware explore subagent override. |
| `--force` | Overwrite if already initialized. |
| `--pretty` | Human-readable output. |

### `wipe`

Delete all brain notes and cache for a clean slate. Irreversible without a git backup.

Without `--yes`, prints a dry-run summary of what would be deleted and exits. Refuses to run while a daemon is active — stop the daemon first (`lazybrain daemon stop`).

```
lazybrain wipe --yes --pretty
```

| Option | Description |
|--------|-------------|
| `--yes` | Required. Confirms the destructive operation; without it, only a dry-run summary is shown. |
| `--pretty` | Human-readable output. |

---

## Retrieval

### `search <query>`

Adaptive retrieval using the L1–L4 router (auto mode by default). See
[Retrieval Levels](../README.md#retrieval-levels) for routing logic.

```
lazybrain search "auth bugs"
lazybrain search "why did we choose Stripe" --top 10 --strip
lazybrain search "react hooks" --mode l3 --diversity 0.5
```

| Option | Description |
|--------|-------------|
| `-t, --top <n>` | Top K results (default 5). |
| `-m, --mode <mode>` | Force level: `l1` `l2` `l3` `l4` `auto` (default `auto`). |
| `--strip` | Output stripped plain text for LLM injection. |
| `--pretty` | Human-readable output. |
| `--diversity <lambda>` | MMR lambda [0..1] for result diversification. Requires ONNX embedder. |
| `--include-expired` | Include notes marked with `data-cerveau-valid-until`. |
| `--type <type>` | Filter by `data-cerveau-type` (e.g. `decision`, `episodic`). |
| `--tag <tag>` | Filter by tag. |
| `--cwd <path>` | Bias PageRank toward notes captured in this working directory. |
| `--page-rank-weight <w>` | PageRank blend factor [0..1] (default 0.25 when graph present). |

### `query <selector>`

Direct CSS selector query (L1 only). Deterministic, sub-50 ms in-process, no LLM.

Exits 1 with `Brain not found at <path>. Run 'lazybrain init' first…` if the brain directory does not exist.

```
lazybrain query 'article[data-cerveau-type="decision"]:not([data-cerveau-valid-until])'
lazybrain query '[data-cerveau-tags~="auth"]' --strip --limit 20
```

| Option | Description |
|--------|-------------|
| `-a, --attribute <name>` | Extract a specific attribute value from each match. |
| `-l, --limit <n>` | Limit results (default 50). |
| `--strip` | Output stripped plain text. |
| `--pretty` | Human-readable output. |

### `inject-context`

Generate stripped context for SessionStart / UserPromptSubmit hook injection.
Outputs a token-budgeted block of the most relevant notes.

```
lazybrain inject-context --mode session --max-tokens 3000 --strip
lazybrain inject-context --mode turn --query "auth token refresh" --cwd /path/to/project
```

| Option | Description |
|--------|-------------|
| `--max-tokens <n>` | Token budget (default 3000). |
| `--prefer-recent` | Bias toward recently created notes. |
| `--prefer-important` | Bias toward high-importance notes. |
| `--mode <mode>` | `session` `turn` `marker` `highlights` (default `session`). |
| `--format <fmt>` | `full` or `compact` (headline + index) (default `full`). |
| `--query <q>` | Query string (required when `--mode=turn`). |
| `--min-score <n>` | Relevance threshold for turn mode. |
| `--cwd <path>` | Working directory hint for context relevance. |
| `--pretty` | Human-readable output. |

### `neighbours <id>`

Show 1-hop graph neighbours for a note (supersession links, triples, shared entities).

```
lazybrain neighbours abc123
lazybrain neighbours "#abc123" --pretty
```

| Option | Description |
|--------|-------------|
| `--pretty` | Human-readable output. |

---

## Brain Building

These commands build and maintain the brain from source conversations and code.

### `dream`

Offline brain maintenance: reads Claude Code and Vibe conversation transcripts,
extracts facts and decisions, optionally enriches with Haiku, detects contradictions.
This is the primary ingestion command.

```
lazybrain dream --pretty
lazybrain dream --enrich --max-notes 200
lazybrain dream --agent vibe
lazybrain dream --force
```

| Option | Description |
|--------|-------------|
| `--dry-run` | Preview without writing. |
| `--enrich` | Use Haiku to generate TLDRs and topics (requires Claude API access). |
| `--max-notes <n>` | Max notes per enrichment phase (default 200). |
| `--pretty` | Human-readable output with progress. |
| `--synthesize` | Only run the synthesize phase (wiki overview pages). |
| `--topic <name>` | Synthesize only this topic. |
| `--force` | Ignore fingerprints and reprocess all conversations. |
| `--agent <name>` | Restrict ingestion to one source: `claude-code` or `vibe`. |

### `graph`

Build the brain graph: auto-link mentions, build the backlinks index, compute
clusters, generate HTML and text views.

```
lazybrain graph --pretty
lazybrain graph --format html --skip-clusters
```

| Option | Description |
|--------|-------------|
| `--skip-autolink` | Skip mention auto-linking. |
| `--skip-clusters` | Skip cluster generation. |
| `--skip-view` | Skip HTML/text view generation. |
| `--format <fmt>` | `html` `text` `both` (default `both`). |
| `--topic <name>` | Filter sub-graph generation to this topic. |
| `--pretty` | Human-readable output. |

### `enrich`

Enrich canonical code-first neurons (file-neuron, concept-neuron) with conversation
tool-trace data. Run after `graph`.

```
lazybrain enrich --pretty
lazybrain enrich --force
```

| Option | Description |
|--------|-------------|
| `--force` | Re-enrich already populated neurons. |
| `--pretty` | Pretty output. |

### `build-hierarchy`

Build hierarchical knowledge-nodes (root → projects → modules → features).
Run after `graph` + `enrich`.

```
lazybrain build-hierarchy --pretty
```

| Option | Description |
|--------|-------------|
| `--force` | Overwrite existing nodes. |
| `--pretty` | Pretty output. |

### `enrich-hierarchy`

Aggregate conversation content into hierarchy knowledge-nodes.
Run after `build-hierarchy`.

```
lazybrain enrich-hierarchy --pretty
lazybrain enrich-hierarchy --topic myproject
```

| Option | Description |
|--------|-------------|
| `--force` | Re-enrich all nodes. |
| `--topic <name>` | Only enrich nodes under this topic. |
| `--pretty` | Pretty output. |

### `index-rebuild`

Rebuild the SQLite FTS5 index from the HTML files on disk.
Safe to run at any time; the HTML files are always the source of truth.

```
lazybrain index-rebuild --pretty
```

### `build-index`

Regenerate `brain/_index.html` (atlas, metadata, JSON-LD global graph).

```
lazybrain build-index --pretty
```

### `build-clusters`

Generate `brain/clusters/<slug>/_cluster.html` for each cwd cluster.

```
lazybrain build-clusters --pretty
```

### `interlink`

Wikipedia-layer: inject wikilinks and see-also entries into notes (sleep-time job).

```
lazybrain interlink --limit 200 --pretty
lazybrain interlink --dry-run
```

| Option | Description |
|--------|-------------|
| `--dry-run` | Preview without writing. |
| `--limit <n>` | Max notes to process per run (default 200). |
| `--pretty` | Human-readable output. |

---

## Note Management

### `store`

Store a new HTML note. Reads from stdin or `--from-file`.

```
cat note.html | lazybrain store --from-stdin
lazybrain store --from-file note.html --overwrite
```

| Option | Description |
|--------|-------------|
| `--from-file <path>` | Read HTML from a file. |
| `--from-stdin` | Read HTML from stdin (default). |
| `--overwrite` | Overwrite an existing note with the same id. |
| `--pretty` | Human-readable output. |

### `link <fromId> <toId>`

Create a typed link between two notes.

```
lazybrain link abc123 def456 --type refines
lazybrain link abc123 def456 --type contradicts --strength 0.9
```

| Option | Description |
|--------|-------------|
| `-t, --type <type>` | `refines` `contradicts` `generalizes` `cites` `replaces` `follows-from` |
| `-s, --strength <value>` | Link strength [0..1]. |
| `--pretty` | Human-readable output. |

### `invalidate <id>`

Mark a note as invalidated by setting `data-cerveau-valid-until`.

```
lazybrain invalidate abc123 --reason "replaced by new decision" --replaced-by def456
```

| Option | Description |
|--------|-------------|
| `--replaced-by <id>` | ID of the note that supersedes this one. |
| `--reason <text>` | Human-readable reason for invalidation. |
| `--pretty` | Human-readable output. |

### `capture`

Capture a session transcript into the brain. Used by hooks and manually.

```
lazybrain capture --from-file session.jsonl --session abc --cwd /path/to/project
lazybrain capture --from-stdin --async
lazybrain capture --flush-sync
```

| Option | Description |
|--------|-------------|
| `--from-file <path>` | Read transcript from a file. |
| `--from-stdin` | Read transcript from stdin. |
| `--session <id>` | Session identifier. |
| `--cwd <path>` | Working directory context. |
| `--async` | Queue without processing (for PostToolUse hooks — non-blocking). |
| `--flush-sync` | Flush queued captures synchronously (for PreCompact hooks). |
| `--use-llm` | Use LLM augmentation when heuristic confidence is low. |
| `--pretty` | Human-readable output. |

### `compress`

Consolidate working-tier notes into a `<memory-batch>` (archival tier).

```
lazybrain compress --older-than-days 14 --pretty
lazybrain compress --purge-noise --dry-run
lazybrain compress --purge-source "bench:locomo"
```

| Option | Description |
|--------|-------------|
| `--session <id>` | Compress notes from a specific session. |
| `--older-than-days <n>` | Compress notes older than N days (default 7). |
| `--dry-run` | Preview without writing. |
| `--purge-noise` | Retroactively invalidate notes that fail the capture validator. |
| `--purge-source <prefix>` | Hard-delete notes whose `data-cerveau-source` starts with prefix. |
| `--pretty` | Human-readable output. |

### `prune`

Remove noise notes and backup directories. Dry-run by default; use `--apply` to delete.

```
lazybrain prune --pretty
lazybrain prune --apply --policy claude-mem-observer,empty-tldr
```

| Option | Description |
|--------|-------------|
| `--policy <policies>` | Comma-separated policies: `claude-mem-observer` `session-dream` `empty-tldr` `backup-dirs` (default: all). |
| `--dry-run` | Preview candidates without deleting (default). |
| `--apply` | Actually delete matched files and directories. |
| `--pretty` | Human-readable output. |

---

## Serving and Publishing

### `serve`

Start a local read-only HTTP wiki server at `http://127.0.0.1:4242`.

```
lazybrain serve
lazybrain serve --port 8080 --bind 127.0.0.1
lazybrain serve --stop
```

| Option | Description |
|--------|-------------|
| `-p, --port <n>` | Port (default 4242). |
| `--bind <host>` | Bind address (default `127.0.0.1`). |
| `--token <token>` | Require Bearer auth on all requests. |
| `--stop` | Stop a running `lazybrain serve` instance. |

### `publish`

Publish a scrubbed copy of the brain (dry-run by default). The scrubber strips secrets,
non-whitelisted attributes, forbidden tags, and private paths before writing.

```
lazybrain publish --dry-run --pretty
lazybrain publish --confirm --out-dir ./public
```

| Option | Description |
|--------|-------------|
| `--out-dir <path>` | Output directory for the public copy. |
| `--dry-run` | Preview without writing (default). |
| `--confirm` | Actually write the public folder. |
| `--exclude-tier <tier>` | Exclude `archival` or `working` tier notes. |
| `--pretty` | Human-readable output. |

### `export-agents-md`

Project the brain into an AGENTS.md section (Mistral Vibe auto-loads it).

```
lazybrain export-agents-md --target project --cwd /path/to/project --pretty
lazybrain export-agents-md --target user --max-tokens 1200
```

| Option | Description |
|--------|-------------|
| `--target <t>` | `user` or `project` (default `project`). |
| `--cwd <path>` | Project root (for `project` target). |
| `--out-file <path>` | Override output file. |
| `--max-tokens <n>` | Token budget for the generated block (default 1200). |
| `--pretty` | Human-readable output. |

---

## Maintenance and Profiling

### `stats`

Show live telemetry stats from `_cache/telemetry.jsonl`.

```
lazybrain stats --window-hours 48 --pretty
```

| Option | Description |
|--------|-------------|
| `--window-hours <n>` | Window size in hours (default 24). |
| `--pretty` | Human-readable output. |

### `profile-update`

Rebuild the auto-generated user profile note from recent activity.

```
lazybrain profile-update --pretty
lazybrain profile-update --force --min-occurrences 5
```

| Option | Description |
|--------|-------------|
| `--min-occurrences <n>` | Min note count for a tag to be considered stable (default 3). |
| `--force` | Rebuild even if profile is recent. |
| `--pretty` | Human-readable output. |

### `extract`

Batch LLM extraction for low-quality notes. Opt-in: requires `LAZYBRAIN_EXTRACTOR=<backend>`.

Supported backends (choose one):

| Backend | Env Var | Setup | Cost | Notes |
|---------|---------|-------|------|-------|
| **vibe** | `LAZYBRAIN_EXTRACTOR=vibe` | Requires `vibe` CLI installed + Mistral account authenticated. | Uses account | Runs in active Vibe session; no extra API key. See docs/VIBE.md. |
| **devstral** (local) | `LAZYBRAIN_EXTRACTOR=devstral` | Run llama.cpp server at `http://127.0.0.1:8080/v1`. See docs/VIBE.md. | $0 offline | Sovereign mode; no network calls. |
| **devstral** (cloud) | `LAZYBRAIN_EXTRACTOR=devstral` + `LAZYBRAIN_OPENAI_BASE_URL=https://api.mistral.ai/v1` + `LAZYBRAIN_OPENAI_MODEL=devstral-small-latest` + `MISTRAL_API_KEY=...` | Set Mistral API credentials. See docs/VIBE.md. | ~$0.01/call | Cloud inference via Mistral. |
| **anthropic** | `LAZYBRAIN_EXTRACTOR=anthropic` | Set `ANTHROPIC_API_KEY=...` | ~$0.01/call | Direct Anthropic API. Legacy aliases: `haiku`, `claude` (both resolve to this backend). |
| **claude-cli** | `LAZYBRAIN_EXTRACTOR=claude-cli` | Requires active Claude Code session (no API key). | $0 | Never auto-selected; requires explicit opt-in. Falls back silently if unavailable. |

```
# Mistral Vibe CLI
LAZYBRAIN_EXTRACTOR=vibe lazybrain extract --pretty

# Local llama.cpp (sovereign mode)
LAZYBRAIN_EXTRACTOR=devstral lazybrain extract --batch-size 20 --pretty

# Cloud Mistral API
export LAZYBRAIN_EXTRACTOR=devstral
export LAZYBRAIN_OPENAI_BASE_URL=https://api.mistral.ai/v1
export LAZYBRAIN_OPENAI_MODEL=devstral-small-latest
export MISTRAL_API_KEY=your-key
lazybrain extract --batch-size 20 --pretty

# Anthropic API
LAZYBRAIN_EXTRACTOR=anthropic ANTHROPIC_API_KEY=sk-ant-... lazybrain extract --batch-size 20 --pretty

# Claude Code CLI (active session -- never auto-selected)
LAZYBRAIN_EXTRACTOR=claude-cli lazybrain extract --pretty
```

| Option | Description |
|--------|-------------|
| `--batch-size <n>` | Max notes per call (default 10). |
| `--dry-run` | Preview without writing. |
| `--pretty` | Human-readable output. |

**See also:** [Environment Variables](#environment-variables) above, [docs/VIBE.md](./VIBE.md) for backend setup.

### `fingerprints stats`

Show statistics for the fingerprint store used for incremental `dream` processing.

```
lazybrain fingerprints stats --pretty
```

### `fingerprints clean`

Remove orphaned fingerprints (for files that no longer exist on disk).

```
lazybrain fingerprints clean --dry-run --pretty
lazybrain fingerprints clean --pretty
```

| Option | Description |
|--------|-------------|
| `--dry-run` | Show what would be removed without writing. |
| `--pretty` | Human-readable output. |

---

## Daemon

The daemon is a long-running HTTP server that handles hook calls with lower latency
than spawning a new process per call. It is auto-spawned by hooks and is optional.

### `daemon start`

Start the daemon (foreground by default).

```
lazybrain daemon start --foreground --port 37788
```

| Option | Description |
|--------|-------------|
| `--foreground` | Block until shutdown. |
| `-p, --port <n>` | Port (default 37788). |
| `--idle-timeout-ms <ms>` | Auto-shutdown after this many ms idle (default 30 min). |

### `daemon status`

Show daemon status (pid, port, alive).

```
lazybrain daemon status --pretty
```

### `daemon stop`

Stop the running daemon.

```
lazybrain daemon stop --pretty
```

---

## Benchmark Scripts

These are standalone Node.js scripts (no CLI registration) used for benchmarking and verification.

### `node scripts/run-benchmark.mjs`

Runs the comparative benchmark (HTML-LB surgical vs Markdown vs HTML-generic vs Nothing).

**Brain path resolution:**
1. `--brain <path>` explicit flag
2. Bundled `examples/sample-brain` (default)

`LAZYBRAIN_BRAIN_PATH` and `LAZYBRAIN_CACHE_PATH` are **intentionally ignored** — benchmarks always measure the bundled sample-brain so results are reproducible and never accidentally benchmark a user's private data.

Prints header: `Benchmarking brain: <path> (bundled sample-brain)`

```bash
node scripts/run-benchmark.mjs               # bundled sample-brain
node scripts/run-benchmark.mjs --brain /your/brain
```

### `node scripts/bench-determinism.mjs`

Verifies byte-identical output across N runs of a structural query.

Same brain path resolution as `run-benchmark.mjs`: `--brain` flag only, env vars ignored.

```bash
node scripts/bench-determinism.mjs                                    # bundled sample-brain
node scripts/bench-determinism.mjs --brain /your/brain
node scripts/bench-determinism.mjs --brain /your/brain --n 20 \
  --query '[data-cerveau-type="decision"]:not([data-cerveau-valid-until])'
```

---

## Retired Commands

### `synthesize-nodes` [REMOVED]

This command has been removed. It no longer exists as a functional pipeline.

**Use instead:** `lazybrain graph` + `lazybrain build-hierarchy`

See [docs/STATUS.md](./STATUS.md) for the full list of retired and planned features.
