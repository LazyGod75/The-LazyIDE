---
name: lazybrain-search
description: Search the LazyBrain knowledge graph. Invoke when the user asks "what do we know about X", "have I seen this before", "find notes about X", or when you need to locate a specific file, feature, or past decision by topic keyword.
allowed-tools: [Bash, Read]
disabled-model-invocation: false
---

# LazyBrain Search

Search the user's structured HTML second-brain via the `lazybrain` CLI.

## Routing (automatic)

| Level | Trigger | Mechanism | Latency |
|-------|---------|-----------|---------|
| L1 | Query looks like a CSS selector | Structural (linkedom) | < 5ms |
| L2 | Short query (≤ 5 tokens, no quotes) | SQLite FTS5 BM25 | < 30ms |
| L2/L3 | Fuzzy keyword query | Hybrid BM25 + embeddings | < 180ms |
| L3 | Longer / semantic query (4+ tokens) | ONNX bge-base bi-encoder | ~150ms |
| L4 | `--mode rerank` or topK > 5 | ONNX ms-marco cross-encoder | ~200ms |

## CLI flags

| Flag | Default | Purpose |
|------|---------|---------|
| `--top N` | 5 | Number of results |
| `--strip` | off | Return stripped text (not raw HTML) |
| `--pretty` | off | Human-readable output |
| `--tag TAG` | all | Filter by tag |
| `--type TYPE` | all | Filter by note type (decision, episodic, reference, procedural, semantic) |
| `--mode MODE` | auto | Force routing level: `fts`, `semantic`, `rerank`, `hybrid` |
| `--cwd PATH` | none | Bias results to working directory via PageRank |
| `--diversity N` | 0 | MMR diversification factor |
| `--include-expired` | off | Include notes with `data-cerveau-valid-until` set |
| `--page-rank-weight N` | 0.3 | Weight of PageRank in scoring |
| `--source-prefix PREFIX` | none | Filter by source prefix |

## Scores interpretation

- **L2 BM25**: 1-50 (unbounded, higher = better keyword match)
- **L3 Cosine**: 0-1 (higher = closer semantic match, >0.6 = strong)
- **L4 Reranker**: logit scores — ordering matters more than absolute values

## search vs query

| Intent | Command |
|--------|---------|
| Natural language, fuzzy, "find notes about X" | `lazybrain search "X" --strip` |
| Exact structural filter, "all decisions from May" | `lazybrain query 'article[data-cerveau-type="decision"]'` |
| Combine: structural + keyword | `lazybrain search "X" --tag auth --type decision` |

## Examples

```bash
# Error lookup
lazybrain search "postgres connection timeout" --type episodic --strip --pretty

# Decision history
lazybrain search "database choice" --type decision --strip --pretty

# Recent work scoped
lazybrain search "auth refactor" --tag auth --top 3 --strip

# Anti-pattern recall
lazybrain search "don't retry" --strip --pretty

# High-quality reranked
lazybrain search "why we chose OAuth over JWT" --mode rerank --top 10 --strip
```

## Execution

Uses CLI directly for reliable, up-to-date results. The daemon (used by hooks for auto-injection) can have stale indexes after brain changes.

!`lazybrain search "$ARGUMENTS" --top 5 --strip --pretty 2>/dev/null || echo "[lazybrain: not configured or no results]"`

## Troubleshooting

- Verify `LAZYBRAIN_BRAIN_PATH` env var or `~/Documents/Lazy-Brain-*/brain/` exists
- `lazybrain stats` to check index health
- `lazybrain index-rebuild` if SQLite is out of sync
