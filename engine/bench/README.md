# LazyBrain bench

Four suites, each independent:

| File | What it measures |
|---|---|
| `html-vs-md.ts` | **HTML vs Markdown comparison** — expressiveness, strip ratio, latency, token efficiency |
| `locomo.ts` | LOCOMO-10 retrieval accuracy + latency + tokens/query (vs mem0 92.5%) |
| `tokens-per-session.ts` | End-to-end session token cost (SessionStart + per-turn) |
| `latency.ts` | Daemon endpoint p50/p95 |
| `structural-recall.ts` | HTML attribute coverage (triples, causes, entities) per note |

## Run HTML vs Markdown Benchmark

```bash
# Compares LazyBrain (HTML format) vs equivalent Markdown systems
# across 4 key dimensions for LLM agent memory.

npx tsx bench/html-vs-md.ts

# Measures:
# 1. Query expressiveness: CSS selectors vs YAML parsing + regex (10 scenarios)
# 2. Strip ratio: HTML size vs stripped text (20 samples)
# 3. Latency: CSS query vs YAML parsing simulation (5 queries)
# 4. Token efficiency: injected context size comparison

# Results: bench/results/html-vs-md-YYYY-MM-DD.json
```

### Key Findings

HTML format wins across these dimensions:

| Dimension | HTML | MD | Winner |
|---|---|---|---|
| **Expressiveness** | 8.5/10 | 0.8/10 | HTML (+1133%) |
| **Strip ratio** | 0.58 | 1.00 | HTML (-42% tokens) |
| **L1 latency** | ~1.7ms p50 | ~26ms p50 | HTML (15x faster) |
| **Tokens** | 193k | 193k | Tie (content-dominated) |

**Why HTML wins:**
- CSS attribute selectors solve 85% of query use cases natively
- MD requires YAML parsing + regex for even basic queries
- Typed links, per-fact metadata, temporal validity → impossible in MD
- Deterministic, <5ms structural queries vs ~25ms YAML parsing
- Strip function produces 35-65% of original HTML size efficiently

## Run LOCOMO-10

```bash
# 1. Fetch dataset (gitignored)
mkdir -p bench/data
curl -L -o bench/data/locomo10.json \
  https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json

# 2. Start daemon pointed at a fresh brain dir
mkdir -p /tmp/locomo-brain
export LAZYBRAIN_BRAIN_PATH=/tmp/locomo-brain
lazybrain daemon start --foreground --port 37788 &

# 3. Run bench
node --import tsx bench/locomo.ts --top 50 --judge exact

# Or with LLM-as-judge (matches mem0 methodology):
ANTHROPIC_API_KEY=... node --import tsx bench/locomo.ts --judge haiku
```

## Expected baselines (published or independently computed)

| System | Accuracy @ top-200 | Latency p50 | Tokens/query | $ / 300 Q |
|---|---:|---:|---:|---:|
| mem0 | 92.5% | 880 ms | 7000 | ~$0.45 |
| graphiti | win/loss vs baseline | 200-400 ms | n/a | ~$0.20 |
| LazyBrain (heuristic) | **TBD** (target 75-85%) | <30 ms | 30-150 | $0 |
| LazyBrain (+ entities + Haiku) | **TBD** (target 85-92%) | <30 ms | 30-150 | ~$0.001 |

Results land in `bench/results/locomo-<timestamp>.json`.
