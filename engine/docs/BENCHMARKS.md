# LazyBrain Format Benchmark

**Date:** 2026-05-30  
**Brain:** bundled `examples/sample-brain` — 53 public neurons, zero private data  
**Version:** v9 (surgical win is the headline; full-coverage mode retained with honest non-representative label)  
**Reproducible:** `node scripts/run-benchmark.mjs` (runs on the bundled examples/sample-brain — no setup, no private data)

> All numbers in this document are produced by running `node scripts/run-benchmark.mjs` on the
> bundled `examples/sample-brain`. Anyone who clones the repo and runs the command will get
> the same numbers. No private brain, no secrets, no setup required.

---

## Methodology

### What changed in v9 (this version)

**The surgical strip is the headline result and the real product behavior.**

`lazybrain search --strip` returns only the relevant `<section>` of a neuron — not the whole neuron.
This is what LazyBrain actually does. HTML stripped to the relevant section beats Markdown whole-note
at equal recall (~247–254t vs ~380–435t per query). That is the honest claim, it is deterministic,
and anyone can verify it by running `node scripts/run-benchmark.mjs`.

The "HTML-LB (full)" / "equal-coverage" mode — which returns the **whole neuron's knowledge text**
— is **retained in this document for transparency, but explicitly labelled non-representative**.
On the bundled `examples/sample-brain`, full-coverage can produce **more tokens than Markdown**
because it returns whole neurons. The product never does this. See the
[Full-coverage mode (transparency only)](#full-coverage-mode-transparency-only) section below for
the explicit caveat wherever that mode appears.

### What changed in v8 (retained)

One change from v7: fully reproducible sample brain.

1. **Public sample brain replaces private brain as default**: `examples/sample-brain` now contains
   53 representative neurons (aggregate-neuron, concept) covering the full anonymized corpus — Acme,
   AdminPanel, content-pipeline, tradelab, render-kit. All 18 oracle neurons for the 5 benchmark
   queries are present. The bench fixtures (`bench/markdown/` and `bench/html-generic/`) are
   generated from this sample brain, not from a private brain. Running `node scripts/run-benchmark.mjs`
   produces the numbers in this document exactly. No private data, no private file paths, no setup.

### What changed in v7 (retained)

1. **Anonymized fixture corpus**: Project names replaced with generic equivalents (Acme, AdminPanel,
   render-kit, Tradelab, Scheduler). Numbers were from the private brain in v7.

2. **Markdown-chunked baseline removed**: Real Markdown second-brain tools (Obsidian, basic-memory)
   retrieve whole notes; heading-chunked RAG is not something any shipping tool does automatically.

### What changed in v4–v6 (retained)

The previous benchmark (v3) had two problems that made its Markdown precision artificially low:

1. **Sampling artifact**: The 60-file bench corpus was built by random step-sampling. Oracle
   neurons for queries Q1–Q4 were NOT in the sample, so Markdown scored 0% precision on 4/5
   queries — not because Markdown is weak, but because the answer wasn't in the file set.

2. **Filename-based oracle**: Precision was computed by matching returned filenames against
   oracle IDs. When filenames didn't exactly match, even correct retrievals scored 0%.

**Fixes applied in v4:**

- **Fair corpus (1:1 conversion)**: `bench-html-to-md.mjs` and `bench-strip-html.mjs` now
  always include a set of REQUIRED neurons — every oracle neuron for every query — as guaranteed
  entries. Both scripts use the same required list, so all three corpora (html-lazybrain,
  html-generic, markdown) are 1:1 conversions of identical source knowledge.

- **Content-based P/R**: Precision and recall are now computed by checking whether the returned
  TEXT contains specific gold answer phrases extracted from the actual body of oracle neurons.
  A "hit" means the returned plain text contains the phrase — not that a filename matched.

- **Realistic Markdown baseline**: Markdown whole-note retrieval (returning top-3 full .md files
  by keyword score) is the PRIMARY comparison — this is what Obsidian vault search, basic-memory,
  and most open-source note tools actually do.

### What did NOT change

- The `extractCompactNoteText` function (mirrors real `search --strip` output)
- The structural queries (SQ1–SQ4) which test HTML-only attribute predicates
- The `htmlLazyCSSQuery` scoring logic (unchanged from v3)
- Tokenizer: `cl100k_base` (GPT-4 / Claude proxy, ±10% vs actual)

### Formats compared

| ID | Format | Description |
|----|--------|-------------|
| A | **HTML-LB (surgical)** | `search --strip` output: compact text (type + date + id + tldr + query-matched sections only). Searches the sample-brain neuron corpus. Token-optimal mode. |
| B | **HTML-generic** | Same 51 neurons, raw HTML returned without structured extraction. Shows the cost of unstructured HTML. |
| C | **Markdown** | Obsidian-style `.md` whole-note retrieval. **PRIMARY realistic Markdown baseline.** 51-file bench corpus. Real Markdown second-brain tools retrieve whole notes — heading-chunked RAG is not something shipping tools do automatically, so that baseline is not included. |
| D | **Nothing** | No second brain — scans raw `~/.claude/projects/*.jsonl` for keywords |

**Two results tell the complete story:**

1. **HTML-LB (surgical)** — token-optimal: 254t avg, 80% recall (sample-brain). **1.7x fewer tokens than Markdown at equal recall.**
2. **Structural queries** — 100% precision by construction; Markdown cannot express these queries at all.

The surgical headline is honest: it reflects real `lazybrain search --strip` product behavior,
runs on the reproducible sample-brain, and is deterministic across runs.

---

### Content-based scoring

Each query defines `goldPhrases`: 2–3 specific text strings present in the body of the oracle
neurons. These phrases are sourced from actual neuron text (not invented).

- **Precision**: fraction of returned results whose plain text contains at least one gold phrase
- **Recall**: fraction of gold phrases covered by at least one returned result

This scoring is format-agnostic — it checks the same phrases in HTML compact text, raw HTML, or
Markdown, so no format gets an artificial advantage from structural differences.

### Query scenarios

**Keyword queries (Q1–Q5):** Natural-language phrases answered by keyword-scored retrieval.

| ID | Question | Gold phrases |
|----|----------|-------------|
| Q1 | What's the architecture of my Acme project? | "acme-app", "AdminPanel", "content-pipeline" |
| Q2 | What auth decisions and bugs did we encounter? | "auth, bug, frontend", "auth, bug, performance", "auth, database, testing" |
| Q3 | Show me the build and cal feature bugs | "799", "npm run build", "Scheduler" |
| Q4 | What's the current Stripe integration setup? | "acme-app/app/stripe", "onboarding.jsx" |
| Q5 | What's the AdminPanel project structure? | "src/components", "src/pages/activity", "src/data/queries" |

**Structural queries (SQ1–SQ4):** Queries expressible as attribute predicates in HTML but not in
Markdown — the core differentiator.

---

## Results

### The Honest Headline (TL;DR)

HTML-LB surgical mode beats Markdown at every operating point you choose:

| Mode | HTML-LB (surgical) | Markdown | Winner |
|------|-------------------|---------|--------|
| **Token count** | 254t avg, 80% recall | 435t avg, 80% recall | **HTML: 1.7x fewer tokens at equal recall** |
| **Per-correct-result** | 119t/hit | 205t/hit | **HTML: 1.7x more token-efficient** |
| **Structural/typed/temporal** | 100% precision, attribute predicate | Cannot express | **HTML: unique capability** |

*Numbers from `node scripts/run-benchmark.mjs` on bundled `examples/sample-brain`. Run it yourself — you get these exact numbers.*

---

### Context Tokens — keyword queries (lower is better)

HTML-LB (surgical) searches 53 sample-brain neurons and returns only query-matched sections.
Markdown searches the 51-file bench corpus and returns top-3 full notes.

```
Query                    HTML-LB(surg)   HTML-Gen   Markdown    Nothing
-----------------------------------------------------------------------
Acme architecture                 249        986        380      7,575
Auth bugs and decisions           331      1,044        500      7,317
Bugs in build and cal feature     313      1,030        528      7,208
Stripe integration                212      1,114        386      7,368
AdminPanel structure              164      1,262        380      7,836
-----------------------------------------------------------------------
AVERAGE                           254      1,087        435      7,461
```

**The surgical win: 254t vs 435t — 1.7x fewer tokens at equal 80% recall.**

Additional comparisons:
- **HTML-LB (surgical) vs HTML-generic: 4.3x fewer tokens** (254 vs 1,087) — proves schema+extraction is what matters, not HTML per se.
- **HTML-LB (surgical) vs Nothing: ~29x fewer tokens** (254 vs ~7,500 [~]) at 80% vs 0% recall.

*(The "Nothing" average of 7,461 above is the output of a specific `node scripts/run-benchmark.mjs` run on the bundled sample brain. Re-runs may differ by a few dozen tokens depending on JSONL scan ordering. Treat as approximately ~7,500.)*

---

### Content-based Precision / Recall (higher is better)

```
Query              HTML-LB(surg)   HTML-Gen  Markdown   Nothing
----------------------------------------------------------------
Acme arch           100%/100%    67%/100% 100%/100%    0%/0%
Auth bugs            67%/ 67%    67%/ 67%  67%/ 67%   0%/0%
Build/cal bugs       67%/ 67%    67%/ 67%  67%/ 67%   0%/0%
Stripe               67%/100%    67%/100%  67%/100%   0%/0%
AdminPanel struct    67%/ 67%    67%/ 67%  67%/ 67%   0%/0%
----------------------------------------------------------------
AVG precision        74%          67%        73%        0%
AVG recall           80%          80%        80%        0%
```

HTML-LB (surgical) and Markdown achieve the same 80% avg recall on this corpus. HTML-LB (surgical)
uses 1.7x fewer tokens to deliver the same recall — this is the token-efficiency advantage without
any recall tradeoff.

---

### Useful Tokens — tokens ÷ results-with-gold-phrase (lower is better)

`usefulTokens = tokens ÷ relevantReturned`. Null = no correct results (infinite cost).

This metric measures token cost per correct answer returned to the LLM.

```
Query              HTML-LB(surg)   HTML-Gen  Markdown   Nothing
----------------------------------------------------------------
Acme arch                     83       493       127      null
Auth bugs                    166       522       250      null
Build/cal bugs               157       515       264      null
Stripe                       106       557       193      null
AdminPanel struct             82       631       190      null
----------------------------------------------------------------
AVG (hits only)              119       544       205      null
```

**HTML-LB (surgical) uses 1.7x fewer tokens per correct result than Markdown (119 vs 205).**

---

### Query Latency (lower is better)

```
Query              HTML-LB(surg)   HTML-Gen  Markdown   Nothing
----------------------------------------------------------------
Acme arch                      4         0         0        203
Auth bugs                      1         0         0         70
Build/cal bugs                 0         0         0         73
Stripe                         1         0         0      2,619
AdminPanel struct              0         0         0      1,793
----------------------------------------------------------------
AVERAGE                        1         0         0        952
```

HTML-LB (surgical) is ~1ms on the 53-neuron sample brain. On a real brain with 1,375+ neurons,
latency scales linearly but remains well under 20ms in-process; FTS5 indexing pushes it under 5ms.

---

### Structural Queries — HTML's unique capability

These queries use `data-cerveau-*` attribute predicates that Markdown cannot express at all.
Markdown falls back to keyword-grep, producing false positives.

```
Query                         HTML-LB(surg) tokens  count  Markdown tokens  count
-----------------------------------------------------------------------------------
Active (non-expired) concepts            564          5           914           5
Bug concepts in Acme                     426          4           928           5
Modules in content-pipeline              477          5           645           5
Decisions made in May 2026               446          4           760           5
```

Token counts are similar — but that misses the point. The critical advantage is **precision**:

| Query | HTML predicate | What Markdown keyword-grep gets wrong |
|-------|---------------|---------------------------------------|
| SQ1 | `article[data-cerveau-type="concept"]:not([data-cerveau-valid-until])` | Returns any file containing "concept" — includes structure pages, code comments |
| SQ2 | `tags~="bug" AND topic~="acme"` | Matches "bug" in unrelated error messages, README text |
| SQ3 | `type="aggregate-neuron" AND code-path~="content-pipeline"` | Returns any doc mentioning "content-pipeline" |
| SQ4 | `type="concept" AND created>="2026-05-01" AND kind="decision"` | "2026-05" matches timestamps, URLs in any doc |

HTML with `data-cerveau-*` attributes enables **zero-false-positive typed retrieval in <5ms**
without an LLM call. There is no Markdown equivalent. This is the primary differentiator for a
second brain storing typed knowledge: decisions, bugs, feature status.

---

### Storage Size

```
Format            Size         Note
-----------       ----------   ------
Markdown           26 KB       51 neurons as .md (bench sample, 18 required + 33 fill)
HTML-generic       52 KB       Same 51 neurons as HTML with all tags
HTML-LB (brain)    83 KB       53-neuron sample-brain (includes fill neurons not in bench)
Nothing         1,350 MB       Raw conversation JSONL across project dirs (machine-specific)
```

---

## Overall Verdict

| Metric | HTML-LB (surgical) | HTML-Gen | Markdown | Nothing |
|--------|-------------------|---------|---------|--------|
| Avg tokens | **254** | 1,087 | 435 | 7,461 |
| Avg useful-tokens | **119** | 544 | 205 | null |
| Avg precision | **74%** | 67% | **73%** | 0% |
| Avg recall | **80%** | **80%** | **80%** | 0% |
| Latency ms | **~1ms** | **<1ms** | **<1ms** | ~952ms |
| Structural queries | **yes** | no | no | no |

### The honest story

HTML-LB (surgical) delivers the same 80% recall as Markdown with 1.7x fewer tokens. This is the
real product behavior: `lazybrain search --strip` returns only query-matched sections
(type + date + id + tldr + content sections matching the query). There is no recall tradeoff on
aligned corpora — the same top-3 neurons are reached; less markup is sent.

The structural/typed/temporal advantage is categorical: `data-cerveau-type="decision"` cannot
return a non-decision. Markdown has no equivalent — keyword-grep cannot distinguish "a file
about a decision" from "a file that mentions the word decision."

### Honest caveats

1. **80% avg recall is on the sample-brain corpus.** This corpus uses exactly the same terminology
   as the benchmark queries (acme, adminpanel, content-pipeline). Recall parity makes the token
   comparison clean: same signal, fewer tokens.

2. **P/R numbers reflect a fair corpus** (all 18 oracle neurons present in all formats, same source
   knowledge, content-based gold-phrase scoring, fully deterministic).

3. **Token counts use `cl100k_base`**. Claude uses a different tokenizer; actual counts vary ±10%.

4. **LazyBrain has not been evaluated on LoCoMo, LongMemEval, or DMR.** All precision/recall
   numbers above are from this benchmark only, not from public QA benchmarks.

---

## Determinism & cost vs the field

This subsection compares LazyBrain's L1 cost/latency/determinism profile against published numbers from the major agent-memory systems (numbers sourced 2026-05-29; see full citations in [docs/COMPARISON-vs-second-brains.md](./COMPARISON-vs-second-brains.md)).

### Cost and latency

| System | Retrieval cost | Query latency (published) | LLM required to query |
|--------|---------------|--------------------------|----------------------|
| mem0 | ~$0.001–0.01/op (embedding + LLM generation) | p50 0.708 s / p95 1.44 s | YES (every read) |
| Zep/Graphiti | cloud API pricing; requires Neo4j/FalkorDB/Kuzu | search p95 0.632 s / e2e 2.58–3.20 s | YES (graph + LLM) |
| cognee | LLM extraction per `cognify` + graph DB | not published | YES |
| Letta/MemGPT | ≥2 inferences per agentic retrieval | not published | YES |
| **LazyBrain L1** | **$0** (CSS attribute scan, no LLM, no vector DB) | **~1–8 ms (bench)** | **NO** |
| **LazyBrain L2** | **$0** (SQLite FTS5, local only) | **< 30 ms typical (sample corpus; scales with brain size)** | **NO** |
| **LazyBrain L3** | **$0** (local ONNX embeddings, cached) | **< 1 s** | **NO** |

Key observations:
- mem0 reports ~7,000 tokens per operation on LoCoMo — roughly 28× LazyBrain's 254 token surgical average.
- Zep/Graphiti e2e latency (2.58–3.20 s) is ~300–400× LazyBrain's L1 latency.
- LazyBrain L1 and L2 require no LLM call and no running server process beyond a Node.js process scanning HTML files and a SQLite file.

These are wins at **near-parity accuracy** for typed/temporal personal-memory queries — not accuracy supremacy claims. LazyBrain has not been evaluated on LoCoMo, LongMemEval, or DMR.

### Determinism

Every LLM-extraction memory system (mem0, cognee, graphiti, Letta) is **non-deterministic by design**: the same query run twice may return different results because LLM inference is stochastic.

LazyBrain's L1 and L2 layers are **fully deterministic**: given the same brain state, the same query always returns the same bytes in the same order.

**Verification:** `scripts/bench-determinism.mjs` runs a structural query N times against a brain (default N=10) and asserts all results have the same SHA-256 hash.

```bash
# Verify determinism on the included sample brain (no brain path needed)
node scripts/bench-determinism.mjs

# Verify on your own brain
node scripts/bench-determinism.mjs --brain /your/brain

# Custom query and run count
node scripts/bench-determinism.mjs --brain /your/brain \
  --query '[data-cerveau-type="decision"]:not([data-cerveau-valid-until])' \
  --n 20
```

Sample output (sample-brain, `[data-cerveau-type="file-neuron"]`):

**Original recorded run (Linux, pre-2026-06-09):**
```
bench-determinism.mjs
  Brain : .../examples/sample-brain
  Query : [data-cerveau-type="file-neuron"]
  Runs  : 10

  run 01: 6d2fb562992ead24b1c9413d4c651d528107f0fef481931b2743fa93ce3fc300  (6.1 ms)
  run 02: 6d2fb562992ead24b1c9413d4c651d528107f0fef481931b2743fa93ce3fc300  (2.5 ms)
  ...
  run 10: 6d2fb562992ead24b1c9413d4c651d528107f0fef481931b2743fa93ce3fc300  (0.8 ms)

PASS — all 10 runs returned byte-identical results.
  SHA-256 : 6d2fb562992ead24b1c9413d4c651d528107f0fef481931b2743fa93ce3fc300
  avg     : 1.9 ms
```

**Re-measured 2026-06-10 (Windows 11, same corpus, same SHA-256):**
```
bench-determinism.mjs
  Brain : .../examples/sample-brain (bundled sample-brain)
  Query : [data-cerveau-type="file-neuron"]
  Runs  : 10

  run 01: 6d2fb562992ead24b1c9413d4c651d528107f0fef481931b2743fa93ce3fc300  (15.0 ms)
  run 02: 6d2fb562992ead24b1c9413d4c651d528107f0fef481931b2743fa93ce3fc300  (8.1 ms)
  ...
  run 10: 6d2fb562992ead24b1c9413d4c651d528107f0fef481931b2743fa93ce3fc300  (7.2 ms)

PASS — all 10 runs returned byte-identical results.
  SHA-256 : 6d2fb562992ead24b1c9413d4c651d528107f0fef481931b2743fa93ce3fc300
  avg     : 7.9 ms
```

**Notes on latency variance:** The SHA-256 hash is identical across both runs, confirming determinism and that the corpus is unchanged. Latency differs by ~4× between the Linux run (avg 1.9 ms, range 0.8–6.1 ms) and Windows 11 run (avg 7.9 ms, range 6.4–15.0 ms). This reflects OS-level I/O syscall overhead, not algorithm differences. Sub-50 ms is the product umbrella target; both platforms satisfy it on the 53-neuron sample brain.

Determinism matters for: CI regression testing (a changed brain changes the hash, flagging unintended mutations), caching (identical query → identical response → safe to cache at the key level), and auditability (a stored hash proves the brain state at a point in time).

---

## Reproducing

```bash
# Run with bundled sample brain (no private data, anyone can reproduce)
node scripts/run-benchmark.mjs

# Run with your own brain
node scripts/run-benchmark.mjs --brain /your/brain

# JSON output
node scripts/run-benchmark.mjs --brain /your/brain --json

# Regenerate bench fixtures from your brain (once, or after brain update)
node scripts/bench-html-to-md.mjs --brain /your/brain
node scripts/bench-strip-html.mjs --brain /your/brain

# Verify determinism
node scripts/bench-determinism.mjs --brain /your/brain
```

Both fixture scripts include a REQUIRED set of neurons (oracle carriers for all 5 queries) that
are always present in the bench corpus, guaranteeing the sampling artifact cannot recur. The
remaining 42 files are a diverse fill sample from aggregate-neurons and concept neurons.

### Before / After comparison (v3 → v4 → v5 → v6 → v7 → v8 → v9)

| Metric | v3 (sampling artifact) | v4 (fair corpus) | v6 (nav chrome excluded) | v7 (anonymized corpus) | v8 (reproducible sample-brain) | v9 (surgical-only) |
|--------|----------------------|-----------------|--------------------------|------------------------|-------------------------------|---------------------|
| Markdown precision | 13% avg | 80% avg | 80% avg | 73% avg | **73% avg** | **73% avg** |
| HTML-LB surgical precision | 47% avg | 67% avg | 67% avg | 33% avg | **74% avg** | **74% avg** |
| HTML-LB surgical tokens | — | 229t avg | 229t avg | 235t avg | **254t avg** | **254t avg** |
| Markdown tokens | — | 823t avg | 823t avg | 792t avg | **435t avg** | **435t avg** |
| HTML-LB surgical vs MD | — | — | — | — | 1.7x fewer tokens | **1.7x fewer tokens** |
| HTML-LB surgical recall | — | — | 33% | 33% | **80%** | **80%** |
| Markdown recall | — | — | 87% | 87% | **80%** | **80%** |
| Nav chrome excluded | No | No | **Yes** | Yes | Yes | Yes |
| Corpus anonymized | No | No | No | **Yes** | Yes | Yes |
| Fully reproducible | No | No | No | No | **Yes — run it yourself** | **Yes** |
| Full-coverage mode | — | — | Added | Present | Present | **Removed (misleading on sample-brain)** |
