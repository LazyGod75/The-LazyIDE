# Getting Started with LazyBrain

Turn every Claude Code conversation into a navigable, searchable knowledge base — in about 5 minutes.

---

## Prerequisites

- **Node.js >= 20** (`node --version`)
- **Git**

**Platform note.** The CLI and engine run on native Node.js on Windows, macOS, and Linux. If you want the Claude Code hooks to fire automatically (PostToolUse, PreCompact, SessionStart), those hooks need a POSIX shell:

- macOS / Linux — works out of the box.
- Windows — use Git Bash or WSL2, or configure the node dispatcher (see `plugins/`).

---

## Install

```bash
git clone https://github.com/LazyGod75/LazyBrain.git
cd LazyBrain
npm install
npm run build
npm link          # adds `lazybrain` to your PATH globally
```

If you prefer not to link globally, prefix every command below with `npx lazybrain` instead.

Verify the install:

```bash
lazybrain --version   # should print 0.2.0
```

---

## 5-Minute First Brain

Run these commands once, in order, from the directory where you want the brain to live (your home folder or a dedicated workspace both work).

### Step 1 — Initialize

```bash
lazybrain init --pretty
```

Creates a `.lazybrain/` folder with the directory structure the brain needs: `brain/notes/`, `brain/_cache/`, etc. Takes less than a second.

**Brain path resolution order** (highest priority first):
1. `--brain <path>` flag passed to `init`
2. `LAZYBRAIN_BRAIN_PATH` environment variable — when this decides the path, the output reads `Initialized brain at <path> (from LAZYBRAIN_BRAIN_PATH)`
3. `$CWD/.lazybrain/brain` — local project default

```bash
# Examples:
lazybrain init --brain /my/project/brain   # explicit path
# PowerShell: $env:LAZYBRAIN_BRAIN_PATH = "C:\my\project\brain"; lazybrain init
# Bash/sh:    export LAZYBRAIN_BRAIN_PATH=/my/project/brain && lazybrain init
```

### Step 2 — dream (conversations -> notes)

```bash
lazybrain dream --pretty
```

Reads every Claude Code conversation on your machine, extracts decisions, facts, and context, and writes them as HTML notes into `brain/notes/`. This is deterministic and costs $0 — no LLM calls unless you add `--enrich`.

Typical runtimes:

| Conversations | Time |
|---------------|------|
| < 50 | under 10 seconds |
| ~500 | 5–10 minutes |
| ~3000+ | 10–20 minutes |

Subsequent runs are incremental (SHA-256 fingerprints skip unchanged files).

### Step 3 — Build the FTS index

```bash
lazybrain index-rebuild --pretty
```

Scans every HTML file in `brain/notes/` and rebuilds the full-text SQLite index. Required after `dream` so that `search` and `serve` can find your notes. Takes a few seconds.

### Step 4 — graph (code -> file/module neurons)

```bash
lazybrain graph --format both --pretty
```

Scans the codebase, creates file-neurons and aggregate-neurons (one per module), auto-links mentions, computes PageRank and clusters, and writes a `brain-graph.json`. Both HTML and text views are generated.

### Step 5 — enrich (code + conversation fusion)

```bash
lazybrain enrich --pretty
```

This is the project's headline differentiator. For every file-neuron produced by `graph`, `enrich` scans all dream conversation notes and attaches relevant decisions, bugs discovered, and ideas discussed directly onto the file's wiki page. The result: each file page shows not just its code structure, but the full history of what Claude decided, fixed, and explored in that file across every session.

Skip this step and you get a plain code wiki. Run it and each file becomes a living record of code + conversation.

### Step 6 — build-hierarchy (create hierarchical knowledge-node structure)

```bash
lazybrain build-hierarchy --force --pretty
```

Builds the hierarchical knowledge-node tree (root → projects → modules → features) from your codebase structure. This replaces the retired `synthesize-nodes` pipeline and creates the wiki structure you navigate in the brain.

### Step 7 — enrich-hierarchy (populate hierarchy with conversation insights)

```bash
lazybrain enrich-hierarchy --force --pretty
```

Scans conversations and aggregates insights into hierarchy nodes. Each project, module, and feature page now contains what Claude learned about it across all sessions.

### Step 8 — rebuild the index after enrichment

```bash
lazybrain index-rebuild --pretty
```

The `enrich` and `enrich-hierarchy` steps write new content into existing notes. Re-run the index so that `search` and `serve` pick up all enriched content.

### Step 9 — serve and browse

```bash
lazybrain serve
```

Starts a read-only HTTP server on `http://127.0.0.1:4242`. Open that URL in your browser.

You get:

- A sidebar folder tree (projects -> modules -> files)
- A graph view at `http://127.0.0.1:4242/graph.html`
- Full-text search in the UI
- Every conversation note linked to the code it touched

To use a different port: `lazybrain serve --port 8080`

---

## Try a Query

**Keyword / semantic search from the CLI:**

```bash
lazybrain search "authentication middleware" --top 5 --pretty
lazybrain search "database migration" --top 3 --strip
```

`--top` sets the number of results (default: 5). `--strip` outputs plain text suitable for piping into an LLM prompt.

**CSS structural query (L1, deterministic, sub-50 ms in-process):**

```bash
lazybrain query '[data-cerveau-type="decision"]' --pretty
lazybrain query '[data-cerveau-tags~="auth"]' --limit 10 --pretty
lazybrain query '[data-cerveau-type="file-neuron"][data-cerveau-topic^="acme"]' --pretty
```

The `data-cerveau-*` attributes are HTML attributes written onto every note:

| Attribute | Meaning |
|-----------|---------|
| `data-cerveau-type` | `decision`, `fact`, `file-neuron`, `aggregate-neuron`, … |
| `data-cerveau-tags` | space-separated tag list |
| `data-cerveau-topic` | topic path, e.g. `acme/auth` |
| `data-cerveau-importance` | float 0–1 |
| `data-cerveau-valid-from` | ISO date (for time-travel queries) |

---

## No Conversations Yet?

LazyBrain works on just code. Run `graph` then `serve` — you get a navigable wiki of every file and module in the project. The brain grows automatically as you use Claude Code, because each conversation adds new notes on the next `dream` run.

---

## Optional: Semantic Search (Embeddings)

By default, search uses L1 (CSS) and L2 (FTS5 full-text). Remote model downloads are **opt-in**: nothing is downloaded during queries unless you explicitly request it.

To enable L3 semantic search:

```bash
npm run download-models   # ~530 MB, one-time explicit download
```

Everything works without this. If the models are absent, the engine gracefully falls back to L2 FTS with a one-time stderr hint. You will never see a query error — just slightly less fuzzy matching on paraphrased queries.

**LAZYBRAIN_ALLOW_REMOTE_MODELS three-state control:**

| Value | Behavior |
|-------|----------|
| unset (default) | No downloads during queries. If model cached, it is used; if absent, L2 fallback + one-time hint. |
| `1` | Allow on-demand download (with a visible consent notice on first download). |
| `0` | Forbid downloads silently. Air-gapped mode. L2 FTS only. |

```bash
# PowerShell: $env:LAZYBRAIN_ALLOW_REMOTE_MODELS = "0"
# Bash/sh:    export LAZYBRAIN_ALLOW_REMOTE_MODELS=0
```

---

## Troubleshooting

**Brain is empty after `serve`**
Run `dream` (for conversation notes) and/or `graph` (for code neurons), then `index-rebuild`. The serve command only reads what is already indexed.

**Windows: hooks do not fire**
The Claude Code hook system requires a POSIX shell. Use Git Bash or WSL2 as your terminal, or set up the node dispatcher in `plugins/`. The CLI itself (all commands above) runs fine in PowerShell or CMD.

**L3 semantic search not working**
Models are not downloaded. Run `npm run download-models`. Until then, L2 FTS is used automatically — no action needed beyond awareness.

**`lazybrain init` says already initialized**
Use `--force` to reinitialize: `lazybrain init --force --pretty`

**dream is slow on first run**
Expected — it processes every conversation file once. Subsequent runs only process changed files (fingerprint cache). Add `--enrich` only if you want Haiku-generated summaries (requires a Claude subscription and takes longer).

---

## What You Get

- A navigable wiki at `http://127.0.0.1:4242` — one page per file, module, and project.
- CSS-queryable HTML notes — `lazybrain query` runs in < 5 ms with no LLM.
- Efficient retrieval — approximately 254 tokens per query result injected into context (LazyBrain surgical strip average on the sample corpus; see docs/BENCHMARKS.md).
- Deterministic processing — `dream` and `graph` produce the same output for the same input; no nondeterminism, no surprise API bills.
- Local-first — everything lives in `.lazybrain/brain/` on your machine.
