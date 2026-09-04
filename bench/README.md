# LazyBrain Benchmark Harness

Reproducible, self-contained benchmark that measures the value of LazyBrain memory
and agent runs. Pure Node ESM, no external dependencies. Deterministic by default.

**Does NOT affect the app build or test suite.**

---

## Quick Start

```
node bench/run.mjs
```

Runs in fixture/dry mode (no network, no paid API calls).
Results are written to `bench/results/latest.json`.

---

## Environment Flags

| Variable | Default | Effect |
|---|---|---|
| `BENCH_LIVE=1` | off | Use real `lazybrain search` CLI for recall bench |
| `BENCH_AGENT_LIVE=1` | off | Call `claude` CLI to generate agent output (requires `ANTHROPIC_API_KEY`) |
| `BENCH_TOP_K=N` | `3` | Number of results to retrieve per query (precision/recall@k) |

---

## Bench 1 — Memory Recall

**What it measures:** How well LazyBrain retrieves the right knowledge nodes
given a natural-language query, compared to injecting the entire corpus.

**Fixture:** `bench/fixtures/memory-recall.json` — 10 synthetic nodes + 10 queries
with expected node ids. Fully self-contained; no private brain data.

**Algorithm (fixture mode):** BM25-lite (term-frequency scoring over title, tags, body).
In live mode the real `lazybrain search --json` CLI is called and its ranked output
is used instead.

**Metrics:**

| Metric | Description |
|---|---|
| `precision@k` | Fraction of the top-k returned nodes that are relevant |
| `recall@k` | Fraction of relevant nodes that appear in the top-k |
| `latencyMs` | Wall-clock time for the search call |
| `savedTokens` | Tokens saved vs injecting the full corpus (chars/4 heuristic) |
| `savingsPercent` | Percentage reduction in injected tokens |

**Token saving model:**
- Baseline: inject all N nodes into context (full-corpus cost).
- Actual: inject only the top-k retrieved nodes.
- Savings = baseline tokens - injected tokens.
- A 90%+ savings means only 10% of the corpus is injected for a typical query.

---

## Bench 2 — Agent Task (Dry Harness)

**What it measures:** Whether an agent (claude CLI) produces correct, spec-compliant
output for small golden tasks (pure utility functions with tests).

**Tasks:** defined in `bench/fixtures/agent-tasks.json`:
- `task-pure-fn-clamp`: implement clamp() with tests
- `task-pure-fn-groupby`: implement groupBy() with tests
- `task-pure-fn-debounce`: implement debounce() with tests

**Default behavior (dry mode):**
- Looks for pre-existing output at the paths defined in each task.
- If found, scores them against the checker spec.
- If not found, reports `not-run` without failing.

**To run a real agent:**
1. Set `BENCH_AGENT_LIVE=1` and `ANTHROPIC_API_KEY=sk-...`
2. Run `node bench/run.mjs`
3. The `claude --print` CLI is called for each task; output files are written
   to `bench/agent-output/`.
4. Scorer runs over the written files.

**Pre-seeding (manual test):**
You can manually write agent output to `bench/agent-output/clamp.mjs` etc.
and run the bench without BENCH_AGENT_LIVE to score it offline.

**Scoring:** Each task has a list of checks (pattern, patternAbsent, testPattern,
testMinOccurrences). Score = passed checks / total checks.

---

## Output Files

| Path | Description |
|---|---|
| `bench/results/latest.json` | Full structured results (version, timestamp, recall, agent) |
| `bench/agent-output/` | Agent-generated files (gitignored, created on live runs) |

---

## Result Schema (latest.json)

```json
{
  "version": 1,
  "timestamp": "2026-06-20T...",
  "durationMs": 42,
  "recall": {
    "bench": "memory-recall",
    "mode": "fixture",
    "topK": 3,
    "queryCount": 10,
    "avgPrecisionAtK": 0.9,
    "avgRecallAtK": 0.85,
    "avgLatencyMs": 0.3,
    "totalSavedTokens": 1234,
    "avgSavingsPercent": 88,
    "queries": [ ... ]
  },
  "agent": {
    "bench": "agent-tasks",
    "mode": "dry",
    "taskCount": 3,
    "gradedCount": 0,
    "avgScore": null,
    "tasks": [ ... ]
  }
}
```

---

## Adding Fixtures

To add more recall queries, append entries to `bench/fixtures/memory-recall.json`:
- `index`: add a node with id, title, topic, tags, body
- `queries`: add a query with expectedIds pointing to index node ids

To add more agent tasks, append to `bench/fixtures/agent-tasks.json` with a scorer
defining pattern-based checks.

---

## No-side-effect guarantee

This harness:
- Does NOT import any app source (no Vite, no Tauri, no React).
- Does NOT modify package.json scripts.
- Does NOT affect `npm test` or `npm run build`.
- Results directory is safe to gitignore.
