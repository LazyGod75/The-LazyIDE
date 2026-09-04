# LazyBrain Feature and Command Status

This page classifies every CLI command and major feature by its current implementation status.
Updated: 2026-06-10.

Status definitions:

| Status | Meaning |
|--------|---------|
| **Implemented** | Ships in the current release, tested, documented. |
| **Experimental** | Exists in code, works in practice, but API/behavior may change. Clearly opt-in (flag or env var). |
| **Planned** | Not in code yet. On the roadmap but no ETA. |
| **Retired** | Was implemented, now removed or no-op. Kept for backwards compatibility where noted. |

---

## CLI Commands

### Implemented

| Command | Notes |
|---------|-------|
| `search <query>` | Adaptive router L1–L4 + hybrid. All flags stable. |
| `query <selector>` | L1 CSS selector. Deterministic. Exits 1 on missing brain. |
| `inject-context` | Session/turn/marker/highlights modes. |
| `neighbours <id>` | 1-hop graph query. |
| `init` | Brain bootstrap. Resolution: --brain flag > LAZYBRAIN_BRAIN_PATH > $CWD/.lazybrain/brain. Prints "Initialized brain at <path>" always. |
| `init --agent vibe` | Vibe integration installer. See Experimental note on hooks. |
| `dream` | Primary ingestion pipeline. Stable core; `--enrich` is experimental. |
| `graph` | Backlinks, clusters, HTML/text views. |
| `enrich` | Code-first neuron enrichment from tool traces. |
| `build-hierarchy` | Hierarchical knowledge-node builder. |
| `enrich-hierarchy` | Hierarchy node enrichment from conversations. |
| `index-rebuild` | FTS5 index rebuild from HTML files. |
| `build-index` | `_index.html` atlas generator. |
| `build-clusters` | Per-cwd cluster pages. |
| `store` | Manual note storage. |
| `link` | Typed note linking. |
| `invalidate <id>` | Temporal invalidation (sets `data-cerveau-valid-until`). |
| `capture` | Transcript ingestion (sync, async, flush-sync). |
| `compress` | Working → archival tier consolidation. |
| `prune` | Noise and backup cleanup. |
| `serve` | Local read-only wiki server. |
| `publish` | Scrubbed public copy exporter; `--site` flag generates static SPA for GitHub Pages. |
| `stats` | Telemetry stats. |
| `profile-update` | User profile note from recent activity. |
| `fingerprints stats` | Fingerprint store stats. |
| `fingerprints clean` | Orphaned fingerprint cleanup. |
| `wipe` | Full brain reset. Requires `--yes`; dry-run summary shown without it. Refuses while daemon is running. |
| `daemon start/status/stop` | Long-running hook server. |
| `export-agents-md` | AGENTS.md section projector for Vibe. |

### Experimental

Commands and features marked experimental work but their interface or behavior may change in a
future release. They require explicit opt-in (a flag or environment variable).

| Feature | Opt-in | Notes |
|---------|--------|-------|
| LLM-enriched dream (`dream --enrich`) | `--enrich` flag | Calls Haiku via Claude API. Requires subscription. Output is non-deterministic. |
| Batch LLM extraction (`extract`) | `LAZYBRAIN_EXTRACTOR=<backend>` env var | LLM-based upgrade of low-quality notes. Supported backends: `vibe`, `devstral`, `anthropic`, `claude-cli`. See docs/CLI-REFERENCE.md and docs/VIBE.md. |
| HyDE query expansion | `LAZYBRAIN_HYDE=1` env var | Hallucinated-document expansion before embedding. Non-deterministic. |
| Hard invalidation | `LAZYBRAIN_HARD_INVALIDATE=1` env var | Drops expired notes from L3 corpus entirely rather than penalizing. |
| Vibe hooks (`init --agent vibe --enable-hooks`) | `--enable-hooks` flag | Requires `enable_experimental_hooks` in Vibe config. Exit-0-safe. |
| Daemon (`daemon start`) | Manual invocation | Auto-spawned by hooks. API is stable; lifecycle management may change. |
| PageRank re-weighting | `--cwd` / `--page-rank-weight` on `search` | Applied to L3/L4 results only. |
| MMR diversification | `--diversity` on `search` | Requires ONNX embedder. |
| `interlink` | Manual invocation | Wikipedia-layer wikilinks. Slow; meant as a sleep-time job. |

### Planned (not yet implemented)

| Feature | Notes |
|---------|-------|
| MCP read-only server | A thin wrapper around `search` / `query` / `inject-context` for MCP clients. Low priority — see [README MCP Positioning](../README.md#mcp-positioning). |
| L5 LLM re-rank | LLM-based cross-encoder on top of L4. Was in early design docs; not in code. No ETA. |
| PDF / image ingestion | Ingest documents beyond conversation transcripts and source code. |
| Web page ingestion | Capture content from URLs into neurons. |
| Evaluated recall on public benchmarks | LoCoMo, LongMemEval, DMR evaluation. See [docs/BENCHMARKS.md](./BENCHMARKS.md). |

---

## Retrieval Levels

| Level | Status | Notes |
|-------|--------|-------|
| L1 — CSS selector | Implemented | Fully deterministic. Used by `query` and shortcut paths in `search`. |
| L2 — FTS5 BM25 | Implemented | Spread activation + structural field boost. Deterministic. |
| L2+L3 hybrid | Implemented | RRF fusion, runs L2 and L3 in parallel. Falls back to L2 if embedder unavailable. |
| L3 — bge-base bi-encoder | Implemented | ONNX WASM, vectors cached in SQLite. Not byte-deterministic across model versions. Models are NOT downloaded automatically — run `npm run download-models` once (~530 MB). |
| L4 — ms-marco cross-encoder | Implemented | Reranks top-50 from L3. ONNX WASM. Same download requirement as L3. |
| L5 — LLM re-rank | Planned | Not in code. Described in early design docs only. |

---

## Neuron Types

| Type | Status | Notes |
|------|--------|-------|
| `file-neuron` | Implemented | One page per source file. Built by `graph`. |
| `aggregate-neuron` | Implemented | One page per directory/project. Built by `graph`. |
| `concept-neuron` | Implemented | Cross-file decisions/ideas. Built by `enrich`. |
| Hierarchy knowledge-nodes | Implemented | Root → project → module → feature. Built by `build-hierarchy`. |

---

## Retired Features

| Feature | Status | What to use instead |
|---------|--------|---------------------|
| `synthesize-nodes` command | [REMOVED] | `lazybrain graph` + `lazybrain build-hierarchy` |
| `knowledge-node` pipeline (synthesize-nodes era) | Retired | Replaced by `build-hierarchy` + `enrich-hierarchy` |
| L1–L5 five-level spec (early planning) | Retired / never fully implemented | Current system is L1–L4 + L2+L3 hybrid; L5 was never shipped |
| Private `spec/cli-commands.md` | Retired (now private) | This document (`docs/CLI-REFERENCE.md`) is the public reference |
