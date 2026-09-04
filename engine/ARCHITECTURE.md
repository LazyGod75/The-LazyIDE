# LazyBrain — Architecture

## Pillars

### 1. HTML as storage format

A note is an `<article>` (or `<section>`) annotated with `data-cerveau-*` attributes (spec: [spec/cerveau-attributes.md](./spec/cerveau-attributes.md)). The note lives in a flat file on disk; git tracks it as text; any browser can render it.

### 2. CSS as query language

CSS selectors are evaluated in-process by linkedom's spec-compliant selector engine (a browser-compatible DOM in pure JavaScript). We treat it as a free, ultra-fast index for structural queries:

```
article[data-cerveau-type="decision"]
[data-cerveau-tags~="auth"]:not([data-cerveau-valid-until])
a[data-cerveau-link-type="contradicts"]
```

Each cerveau attribute is a sortable/filterable column in zero extra infrastructure.

### 3. Strip-tags for LLM injection

When a result has to land in the LLM's context, we **strip the HTML to `textContent`** with structural hints (paragraph breaks, list dashes, external href URLs preserved as suffix). Cost: the raw HTML compresses down to ~30-40% of its byte size, and the LLM sees clean prose.

### 4. Adaptive retrieval router

Four levels plus one hybrid mode, cheapest first. This is what `src/retrieval/router.ts` implements:

| Level | What | Cost | Latency | Auto-selected when |
|-------|------|-----:|--------:|-------------------|
| L1 | CSS selector over `data-cerveau-*` attributes | $0 | < 5 ms | query is a CSS selector, or NL matches a known type/tag/path |
| L2 | SQLite FTS5 (BM25 + spread activation + structural boost) | $0 | < 30 ms | 5 tokens or fewer, no quoted phrase |
| L2+L3 hybrid | Parallel FTS + bi-encoder, fused via RRF (K=60) | $0 | ~150–300 ms | 6–15 tokens |
| L3 | WASM bi-encoder (bge-base, cached vectors) | $0 | ~150 ms warm | longer/fuzzy query, topK ≤ 5 |
| L4 | WASM cross-encoder (ms-marco) re-ranks top-50 from L3 | $0 | +50 ms | topK > 5 or explicit `--mode l4` |

The router's exported type is `RouterLevel = 'L1' | 'L2' | 'L2_L3_HYBRID' | 'L3' | 'L4' | 'auto'`.

The heuristic in `pickLevel` is intentionally simple. Shortcut paths in `route()` (path prefix detection, negative-memory patterns, error-pattern detection, Q-pattern lookup, NL-to-structural) can resolve a query at L1 before `pickLevel` is consulted.

**Note on L5:** An LLM re-rank level was described in earlier planning documents. It is not implemented. There is no `L5` in the codebase and no `--quality` flag in the router.

### 5. Two-tier memory (working / archival)

`data-cerveau-tier="working"` for fresh notes. After N days, `lazybrain compress` rolls them into a `<memory-batch>` (tier=archival) that keeps pointers to the originals — never destructive, always reversible.

### 6. Temporal facts

`data-cerveau-valid-from` / `data-cerveau-valid-until` / `data-cerveau-invalidated-by` give every fact a lifecycle. Time-travel queries become trivial CSS selectors. Inspired by Graphiti's bi-temporal model, but inline in the HTML — no Neo4j required.

### 7. Local-first, optional public

Default mode: brain stays in a private folder + private git repo, accessed only by the CLI on the local machine. Optional `lazybrain publish` runs a strict scrubber (secret detection, attribute whitelist, no inline JS, CSP locked down) and emits a public copy ready for GitHub Pages.

### 8. Selective strip

HTML notes are stripped intelligently before injection: `data-cerveau-section` markers let you tag content that should stay / be removed for different contexts. The stripper preserves `<ul>`, `<li>`, `<code>`, and external URLs (as suffixes) while discarding structural markup. Result: ~42% token savings vs raw HTML, no semantic loss.

### 9. Topic tree & reasoning chains

Every note records `data-cerveau-topic` (hierarchical, e.g. "auth/oauth/state-validation") and optional `data-cerveau-reasoning` (the justification). The topic tree powers the `dream` command's weekly summaries and helps cluster related decisions.

### 10. Dream command

`lazybrain dream` reads Claude Code session transcripts, auto-extracts facts + decisions, and optionally invokes Haiku (`--enrich`) to generate summaries and connect related insights. Runs in ~0.02-0.05 per session. The output is structured HTML ready to merge into the brain. Weekly maintenance consolidates the working tier and archives old facts.

### 11. Per-turn intent detection

On `UserPromptSubmit`, the hook detects intent heuristically (search vs. code vs. analysis) and tags captured notes accordingly. L1 structural routing becomes more targeted — queries route faster when notes are tagged by intent.

## Data flow

### Write path

```
session transcript → annotator (heuristic ± LLM) → HTML note
       → validator (rejects bad schema, blocks secrets)
       → writer (flat file under brain/notes/YYYY-MM/<slug>.html)
       → indexer (FTS5 row + structural attributes)
       → telemetry event
```

### Read path

```
query → router.pickLevel()  (or shortcut paths: path-prefix, NL-structural, Q-pattern, etc.)
  ├─ L1: structuralQuery() — CSS selector over indexed notes
  ├─ L2: searchFts() / searchFtsSpread() — FTS5 BM25 + structural field boost
  ├─ L2+L3 hybrid: runL2L3Hybrid() — parallel FTS + bi-encoder, RRF fusion
  ├─ L3: embedQueryForRetrieval() → topKCosine over cached corpus vectors
  └─ L4: runL3(top-50) → rerank() cross-encoder → top-K
        → optional entity-graph expansion
        → optional PageRank re-weighting (L3/L4 only)
        → optional MMR diversification
        → optional stripNote() for LLM injection
        → telemetry event
```

### Hooks (Claude Code)

```
SessionStart       → lazybrain inject-context --strip       (silent additionalContext)
UserPromptSubmit   → lazybrain search "<prompt>" --strip    (per-turn RAG)
PostToolUse        → lazybrain capture --async              (queue, non-blocking)
PreCompact         → lazybrain capture --flush-sync         (drain queue)
Stop               → lazybrain capture --flush-sync && lazybrain compress &  (consolidation)
```

Every hook has a hard timeout and swallows errors. Claude never blocks on us.

## Index design (SQLite)

Two tables side-by-side:

```sql
CREATE TABLE notes (
  id PRIMARY KEY, path UNIQUE, title, type, tags, source,
  created, importance, valid_from, valid_until, mtime_ms
);

CREATE VIRTUAL TABLE notes_fts USING fts5(
  id UNINDEXED, title, text, tags,
  tokenize = "porter unicode61"
);
```

Both kept in sync by `indexer/fts.ts`. The structural attribute table is intentionally simple — no triggers, no FKs — because the HTML files are the source of truth. Rebuilding the index from disk is always safe (`lazybrain index-rebuild`).

## Embedding cache

Embeddings live in `<brain>/_cache/embeddings.bin` (inside the brain directory). Format:

```
u32 count
for each:
  u8 keyLen
  utf8(keyBytes)
  f32 × 768  (LE)
```

Keys are FNV-1a 32-bit hashes of the input text. Cache hit rate is logged via `embed` telemetry events.

## Telemetry

JSONL stream at `<brain>/_cache/telemetry.jsonl` (inside the brain directory). Schema in `src/util/telemetry.ts`. Events: `capture`, `query`, `inject`, `store`, `compress`, `error`, `embed`. The `bench/` scripts read this file to build daily reports.

## Security

- **At rest:** the brain folder is plain HTML on the filesystem. Inherit OS permissions.
- **At write:** validator rejects notes containing common secret patterns (PEM keys, GitHub tokens, OpenAI keys, etc.).
- **At publish:** scrubber strips all attributes outside a whitelist, removes forbidden tags (`<script>`, `<iframe>`, `<style>`…), redacts private paths in `data-cerveau-source` / `href` / `src`, and refuses publication outright on any secret hit. Output ships with strict CSP `default-src 'self'; script-src 'none'`.
- **Hooks:** all hook scripts have a 4-30s timeout and swallow errors. They never inject untrusted content directly — the CLI is invoked as a child process and its stdout is wrapped in JSON.

## Performance budget

| Operation | Target |
|---|---:|
| `lazybrain query` (L1) | < 5 ms |
| `lazybrain search` (L2) | < 30 ms |
| `lazybrain search` (L3) cold | < 500 ms (model load) |
| `lazybrain search` (L3) warm | < 150 ms |
| `lazybrain capture --async` | < 50 ms (queue write only) |
| `lazybrain inject-context` 3K tokens | < 30 ms |
| Index rebuild over 1000 notes | < 10 s |
