# Changelog

All notable changes to LazyBrain are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

---

## [Unreleased]

### Security / Dev

- Migrated embedding dependency from the deprecated `onnxruntime-node` to `@huggingface/transformers`. `npm audit` now reports **0 vulnerabilities** (full audit including devDependencies — not just `--omit=dev`).
- Toolchain upgraded: vitest 3, esbuild 0.25.

### Changed

- **Remote model downloads are now opt-in.** `LAZYBRAIN_ALLOW_REMOTE_MODELS` unset (new default) = no downloads during queries; L3/L4 degrade to L2 with a one-time stderr hint pointing to `npm run download-models` or `LAZYBRAIN_ALLOW_REMOTE_MODELS=1`. `'1'` = allow on-demand (with a visible consent notice). `'0'` = forbid silently (air-gapped). Run `npm run download-models` for the explicit one-time download (~530 MB).
- **`lazybrain init` resolution order:** `--brain <path>` flag > `LAZYBRAIN_BRAIN_PATH` env var > `$CWD/.lazybrain/brain`. Prints `Initialized brain at <path>` (+ `(from LAZYBRAIN_BRAIN_PATH)` when the env var determined the path).
- **`lazybrain query` and `lazybrain search` exit 1 on a missing brain** with the message `Brain not found at <path>. Run 'lazybrain init' first (or set LAZYBRAIN_BRAIN_PATH).` (exit code 5).
- **`lazybrain serve` prints a human startup line** on stdout: `LazyBrain wiki running at http://<bind>:<port> — Ctrl+C to stop.`
- **Benchmark scripts (`run-benchmark.mjs`, `bench-determinism.mjs`) ignore `LAZYBRAIN_BRAIN_PATH` and `LAZYBRAIN_CACHE_PATH`** entirely; they always default to the bundled `examples/sample-brain`. Only `--brain <path>` can override. Output header confirms: `Benchmarking brain: <path> (bundled sample-brain)`.
- **Cache location is now per-brain** (`<brain>/_cache`) instead of the previous sibling location beside the brain directory. A one-time automatic copy-migration runs on first use after upgrade, so existing caches are not lost. Override with `LAZYBRAIN_CACHE_PATH` as before.
- **`lazybrain wipe` requires `--yes`** to perform the destructive operation. Without the flag, a dry-run summary is printed and the command exits cleanly. The command also refuses to run while a daemon is active — stop it first with `lazybrain daemon stop`.
- **Stats field renamed:** `structural_recall_rate_pct` is now `l1_routing_rate_pct` in `telemetry.jsonl` to better reflect what the metric measures.
- **`search` falls back to OR matching** when an AND query returns no results, with a clear no-result message before the fallback is applied.
- **Invalid CSS selectors** passed to `lazybrain query` now produce an explicit error instead of silently returning empty results.

### Fixed

- Graph navigation anchor hubs now resolve correctly for multi-level hierarchies.
- Autolink fan-in cap prevents pathological link counts on high-frequency terms.
- Anti-pattern quality gate blocks low-signal notes from entering the brain.
- Demo fixture and build-output files are excluded from dream ingestion noise filters.
- Profile cwd normalization handles Windows path separators correctly.
- Mistral Vibe v2.13 and v2.14 session schema compatibility.
- Vibe demo documentation corrected to reflect actual working demo behavior.

### Changed (hooks)

- **Stop hook now calls `index-update` (incremental) instead of `index-rebuild` (full scan).** On a 1000-note brain, `index-update` typically touches fewer than 10 files and completes in seconds rather than minutes. The hook remains fully detached and never blocks the session.

### Fixed

- `compress` and `profile-update` composed notes now carry `data-cerveau-version` equal to the current package version instead of the stale literal `"0.1.0"`.

### Docs

- Claims corrections throughout: retired "94%" token savings metric; corrected Raw JSONL average to ~7,500; aligned extractor values across all references; removed stale `LAZYBRAIN_EXTRACTOR_BACKEND` alias (use `LAZYBRAIN_EXTRACTOR` only); updated `wipe` command documentation; updated cache-path references.
- 60-Second Tour updated with real verbatim CLI output from bundled sample-brain.
- README Key Properties strengthened: "zero outbound network calls by default" now fully true; download is explicit via `download-models`.
- Skills table updated: added `lazybrain-validate` (9th skill installed by `npm run install:lazybrain`).
- `docs/CLI-REFERENCE.md`: init resolution order, query brain guard, LAZYBRAIN_ALLOW_REMOTE_MODELS three-state semantics, benchmark script isolation documented.
- `docs/GETTING-STARTED.md`: 229 → 254 tokens, download-models step, init resolution, PowerShell env-var variants.
- README Contributing section links to `CONTRIBUTING.md`; Documentation table includes `CHANGELOG.md`.
- `settings.example.json` now includes a `_instructions` key explaining the `<LAZYBRAIN_REPO>` placeholder and the `npm run install:lazybrain` alternative.

---

## [0.2.0] - 2026-06-07

### Added

- **Mistral Vibe backend** — first-class support for Vibe as a conversation source alongside
  Claude Code. One brain, both agents: decisions recorded in Claude Code are recalled inside
  Vibe and vice versa.
- **Vibe live capture** — debounced `post_agent_turn` hook that appends to the brain after
  every Vibe agent turn; always exits 0 so it never breaks an active session.
- **Batch Vibe ingestion** (`lazybrain dream --agent vibe`) — ingests Vibe sessions,
  subagent logs, plans, and prompt history including compaction-lineage recovery.
- **`lazybrain init --agent vibe`** — one command sets up hooks, skills, and extractor
  config for a Vibe workspace.
- **`export-agents-md`** — idempotent, sectioned brain projection written to `AGENTS.md`
  and auto-refreshed on every live capture so Vibe always has an up-to-date system-prompt
  summary of the brain.
- **OpenAI-compatible extraction client** — supports local devstral ($0, fully offline),
  Mistral cloud, and any OpenAI-compatible endpoint. Gated behind
  `LAZYBRAIN_EXTRACTOR=openai|vibe`; default remains offline.
- **`LazybrainRead` spatial recall tool** — drop-in replacement for Vibe's `read` tool;
  surfaces relevant memory when the model opens a known file, zero schema tokens overhead.
- **Provenance attributes** — `data-cerveau-agent`, `data-cerveau-source-kind`,
  `data-cerveau-session-parent`, and `data-cerveau-git` on every note, enabling
  per-agent filtering and audit.
- **`VibeSource`** — dedicated conversation source covering Vibe sessions, subagents,
  plans, history, and compaction lineage.
- **Agent-neutral skills** and a provenance query vocabulary usable from both Claude Code
  and Vibe.
- **`brain-aware explore` subagent override** for Vibe — replaces the default explore tool
  with one that checks the brain first.
- **Multi-agent positioning** documented in README and `docs/`.
- **`AGENTS.md` auto-refresh** after every live Vibe capture.

### Fixed

- Guard against out-of-order `AGENTS.md` section markers that caused silent data loss on
  re-export.
- Endpoint symmetry and test hygiene in the Vibe capture daemon.

### Changed

- `ConversationSource` is now an interface; Claude Code source extracted behind it as
  `ClaudeCodeSource`. Third-party sources implement the same interface.
- Agent-meta noise filters extracted into `sources/noise` for reuse across source types.
- Example project and username neutralized in fixtures and docs — LazyBrain is generic,
  not tied to any specific user's setup.

---

## [0.1.0] - 2026-05-25

Initial public release. Apache 2.0.

### Added

- **HTML-first neuron model** — one HTML file per source file, enriched with
  `data-cerveau-*` attributes for typed, temporal, deterministic retrieval.
- **Three neuron types:** file-neuron (one per source file), aggregate-neuron (directory
  and project navigation), concept-neuron (cross-file decisions and ideas).
- **`lazybrain dream`** — ingests Claude Code conversation transcripts via tool-trace
  tagging; no LLM required, deterministic, $0.
- **`lazybrain graph`** — scans source code via tree-sitter WASM (14 languages), builds
  file/module/project neurons and import edges.
- **`lazybrain enrich`** — merges conversation knowledge onto file-neurons and creates
  concept-neurons for cross-file insights.
- **`lazybrain index-rebuild`** — builds and rebuilds the SQLite FTS5 index with BM25 +
  structural-field boost.
- **Three retrieval levels:** L1 CSS selector (~2–8 ms, $0), L2 FTS5 (~50–200 ms, $0),
  L3 local ONNX embeddings cached in SQLite ($0).
- **`lazybrain search --strip`** — surgical strip returning only the matched sections of
  matched neurons (~254 tokens average, 1.7x fewer than Markdown whole-note at equal recall).
- **`lazybrain query`** — deterministic CSS selector query, byte-identical across runs.
- **`lazybrain serve`** — local wiki at `127.0.0.1:4242`, project → module → file
  hierarchy with backlinks.
- **`lazybrain time-travel`** — reconstructs brain state at any past date using
  `data-cerveau-valid-until` timestamps.
- **Incremental processing** — SHA-256 + mtime fingerprints; only changed files are
  reprocessed on subsequent runs.
- **Noise filtering** — repetitive agent-log notes auto-purged to keep search clean.
- **Claude Code skill pack** — `/lazybrain-dream-init`, `/lazybrain-graph`,
  `/lazybrain-understand`, `/lazybrain-search`, `/lazybrain-query`, `/lazybrain-recall`,
  `/lazybrain-summary`, `/lazybrain-time-travel`.
- **Code-first navigable wiki**, deterministic HTML-vs-Markdown benchmark, and
  incremental read-only index.
- **`examples/sample-brain`** — 53-neuron bundled sample brain for benchmark
  reproduction (`node scripts/run-benchmark.mjs`).
- **`docs/`** — Getting Started guide, WHY-HTML deep dive, benchmark methodology,
  and comparison against Obsidian, mem0, Zep, cognee, Letta, and khoj.

---

[Unreleased]: https://github.com/LazyGod75/LazyBrain/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/LazyGod75/LazyBrain/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/LazyGod75/LazyBrain/releases/tag/v0.1.0
