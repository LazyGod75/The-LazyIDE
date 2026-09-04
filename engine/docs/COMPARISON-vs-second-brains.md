# LazyBrain vs Second-Brain / Agent-Memory Ecosystem — Competitive Comparison

**Analysis date:** 2026-05-29
**Method:** Direct repository inspection + web research (star counts and benchmark numbers fetched 2026-05-29).
**Flag convention:** Numbers marked `[~]` are approximate or rounded from secondary sources; numbers marked `[?]` could not be verified from primary sources.
**Honesty notice:** LazyBrain has not been evaluated on LoCoMo, LongMemEval, or DMR. Accuracy comparisons against those numbers are not made here. See section 8 for the roadmap to head-to-head evaluation.

---

## 1. Projects Covered

| Project | Repo URL | Stars (2026-05-29) | Category |
|---------|----------|--------------------|----------|
| **Obsidian** | proprietary (not OSS) — ecosystem: [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases) | 18.2k (releases repo); ~1M+ users | PKM desktop app |
| **Logseq** | [logseq/logseq](https://github.com/logseq/logseq) | 43.1k | PKM / outliner |
| **Foam** | [foambubble/foam](https://github.com/foambubble/foam) | 17.2k | VS Code PKM |
| **Athens Research** | [athensresearch/athens](https://github.com/athensresearch/athens) | 6.3k | **Discontinued (archived)** |
| **mem0** | [mem0ai/mem0](https://github.com/mem0ai/mem0) | 57.1k | Agent memory layer |
| **basic-memory** | [basicmachines-co/basic-memory](https://github.com/basicmachines-co/basic-memory) | 3.1k | Markdown + KG memory |
| **Letta / MemGPT** | [letta-ai/letta](https://github.com/letta-ai/letta) | 23k | Stateful agents platform |
| **cognee** | [topoteretes/cognee](https://github.com/topoteretes/cognee) | 17.6k | Knowledge-graph memory |
| **graphiti (Zep)** | [getzep/graphiti](https://github.com/getzep/graphiti) | 26.7k | Temporal KG for agents |
| **khoj** | [khoj-ai/khoj](https://github.com/khoj-ai/khoj) | 34.8k | Self-hosted AI second brain |
| **agentmemory** | [rohitg00/agentmemory](https://github.com/rohitg00/agentmemory) | 19.6k | Coding-agent memory |
| **engram** | (see ossinsight.io Q1-2026 report) | ~2.4k [~] | Zero-dep SQLite memory |
| **LazyBrain** | [LazyGod75/LazyBrain](https://github.com/LazyGod75/LazyBrain) | new / pre-launch | Code+conversation brain |

---

## 2. Capability Matrix

Legend:
- YES — native, documented capability
- PARTIAL — possible but limited or requires extra setup
- PLUGIN — available only via third-party plugin
- NO — not present
- N/A — not applicable to this tool's scope

| Capability | Obsidian | Logseq | Foam | mem0 | basic-memory | Letta | cognee | graphiti | khoj | agentmemory | **LazyBrain** |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Input: free-form text / notes** | YES | YES | YES | YES | YES | YES | YES | YES | YES | PARTIAL | YES |
| **Input: source code (AST-parsed)** | PLUGIN [^1] | NO | NO | NO | NO | NO | PARTIAL | NO | NO | YES | **YES (14 langs)** |
| **Input: AI conversation history** | NO | NO | NO | PARTIAL [^2] | NO | YES | NO | YES | NO | YES | **YES (tool-trace)** |
| **Input: PDFs / documents** | YES | YES | NO | YES | NO | NO | YES | YES | YES | NO | NO |
| **Input: web / URLs** | PLUGIN | NO | NO | NO | NO | NO | YES | NO | YES | NO | NO |
| **Storage: plain text on disk** | YES (Markdown) | YES (Markdown/Org) | YES (Markdown) | NO (vector DB) | YES (Markdown) | NO (DB) | NO (graph DB) | NO (graph DB) | PARTIAL | NO (SQLite) | **YES (HTML)** |
| **Storage: queryable without LLM** | PARTIAL [^3] | PARTIAL [^3] | NO | NO | NO | NO | NO | NO | NO | NO | **YES (<5 ms CSS)** |
| **Storage: typed structural attributes** | PLUGIN (Dataview) | YES (DB version) | NO | NO | NO | NO | NO | PARTIAL | NO | NO | **YES (data-cerveau-*)** |
| **Temporal validity on facts** | NO | NO | NO | PARTIAL [^4] | NO | NO | NO | **YES** | NO | PARTIAL | **YES (bi-temporal)** |
| **Conversation + code fusion** | NO | NO | NO | NO | NO | NO | NO | NO | NO | PARTIAL | **YES (unique)** |
| **Token cost to query (LLM-free)** | HIGH (dump file) | HIGH | HIGH | MEDIUM [^5] | MEDIUM | HIGH | MEDIUM | MEDIUM | MEDIUM | LOW | **VERY LOW (~256 tok avg)** |
| **Structural/typed queries (no LLM)** | PLUGIN only | DB version only | NO | NO | NO | NO | NO | NO | NO | NO | **YES (CSS selector L1)** |
| **Hybrid retrieval (BM25 + vector + graph)** | PLUGIN | NO | NO | YES | PARTIAL | NO | YES | YES | PARTIAL | YES | **YES (L1-L4 router)** |
| **Ebbinghaus decay / memory aging** | NO | NO | NO | NO | NO | NO | NO | NO | NO | YES | **YES** |
| **Local-first (zero outbound network)** | YES | YES | YES | PARTIAL [^6] | YES | PARTIAL | YES | PARTIAL | YES | YES | **YES** |
| **Time-travel / past-state reconstruction** | NO | NO | NO | NO | NO | NO | NO | PARTIAL | NO | NO | **YES** |
| **Ecosystem / plugins** | **VERY LARGE** (1000+ plugins) | LARGE | SMALL | SDK only | MCP only | SDK only | SDK only | SDK only | small | NO | small (skills only) |
| **Stars / traction** | ~1M users | 43.1k | 17.2k | 57.1k | 3.1k | 23k | 17.6k | 26.7k | 34.8k | 19.6k | pre-launch |
| **Multimodal (images, audio)** | PLUGIN | NO | NO | PARTIAL | NO | NO | YES | NO | YES | NO | NO |
| **Open source** | NO (proprietary) | YES (AGPL) | YES (MIT) | YES (Apache 2) | YES (AGPL) | YES (Apache 2) | YES (Apache 2) | YES (Apache 2) | YES (AGPL) | YES | YES (Apache 2) |

[^1]: Obsidian plugin ecosystem includes code-outliner plugins but no AST parsing.
[^2]: mem0 can ingest chat messages as memory facts but does not parse conversation tool-traces.
[^3]: Obsidian/Logseq Dataview plugin enables SQL-like queries over frontmatter; requires plugin install and does not use CSS selectors.
[^4]: mem0 has temporal reasoning in retrieval but not explicit `valid_from`/`valid_until` on stored facts.
[^5]: mem0's April 2026 algorithm reports 6.8K tokens per operation on LoCoMo benchmark — significantly higher than LazyBrain's ~256 avg per query.
[^6]: mem0 self-hosted via Docker is possible; default SDK targets the managed cloud API.

---

## 3. Per-Project Profiles

### Obsidian
**Approach:** Proprietary desktop app (Windows/macOS/Linux) + mobile. Markdown vault stored locally. Knowledge graph built from `[[wikilinks]]`. Plugin ecosystem of 1,000+ community plugins extends every dimension.
**Killer feature:** Plugin ecosystem density. Dataview gives SQL-like queries over frontmatter; Smart Connections (~4.7k stars) adds AI embeddings; Obsidian Sync provides E2E-encrypted cloud sync.
**Storage:** Plain Markdown files (you own them). No structured query layer unless Dataview is installed.
**Retrieval:** Default = keyword search. With plugins: BM25 + vector (Smart Connections). No CSS/typed attribute layer.
**Token cost to query:** Whole-file dumps unless manually chunked; no native strip-to-prompt pipeline.
**Local-first:** YES.
**Gap vs LazyBrain:** No AST code parsing, no conversation fusion, no temporal validity, no sub-millisecond structural queries.

---

### Logseq
**Approach:** Open-source outliner with graph view. Markdown and Org-mode. Recent "DB version" introduces a proper database backend with richer queries.
**Killer feature:** Outliner-native daily notes + bidirectional links. DB version adds structured attribute queries (closer to Dataview).
**Storage:** Markdown/Org files (classic) or internal DB (new).
**Retrieval:** Full-text search + graph traversal. No vector/hybrid search built in.
**Local-first:** YES (self-hosted sync available).
**Gap vs LazyBrain:** No code parsing, no AI conversation memory, no retrieval pipeline for LLM feeding.

---

### Foam (VS Code extension)
**Approach:** VS Code plugin that turns a Markdown folder into a networked PKM. Wikilinks, backlinks, graph view.
**Killer feature:** Zero-friction setup for developers already in VS Code. Git-native vault.
**Storage:** Markdown.
**Retrieval:** Graph visualization + backlinks panel. No semantic/vector search.
**Local-first:** YES.
**Gap vs LazyBrain:** Effectively a lightweight Obsidian alternative. No semantic search, no AI integration, no code AST.

---

### Athens Research
**Status:** DISCONTINUED. No longer maintained. Users advised to export to Markdown/Logseq.
**Historical note:** Open-source Roam Research clone (graph-based outliner), YC W21. Peaked at ~6.3k stars.
**Why it failed:** Could not compete with Obsidian's plugin ecosystem and Logseq's feature velocity.

---

### mem0
**Approach:** SDK/API layer that extracts structured memory facts from LLM conversations using an LLM pass, then stores them in a vector + keyword index. Supports multiple backends (Qdrant, Redis, Neo4j).
**Killer feature:** Single-call memory add/search API with multi-signal hybrid retrieval (semantic + BM25 + entity). $24M funding, SOC 2 + HIPAA, AWS Agent SDK integration.
**Published benchmark numbers (sources: ECAI-2025 paper + weavai.app 2026-05 review):**
- LoCoMo LLM-Judge J: 66.88% (ECAI-2025 paper); 91.6–92.5% (2026 rewrite, no per-category table published).
- Temporal sub-score (LoCoMo): **55.51%** — mem0's weakest category and the lowest temporal score of all compared systems.
- Full-context oracle on LoCoMo: 72.9% J — **higher than mem0's original paper score**; no system beats full-context on raw accuracy.
- LongMemEval: 91.6–92.5% (2026 rewrite, gpt-4o backbone).
- Tokens per operation: ~7,000 (LoCoMo benchmark).
- Latency: p50 0.708 s / p95 1.44 s (published).
- Every read = ≥1 embedding + ≥1 LLM generation. Every write = ≥1 LLM extraction.
**Storage:** Vector DB (Qdrant default) + keyword index. No plain-text files.
**Retrieval:** Hybrid: semantic + BM25 + entity matching + temporal reasoning.
**Local-first:** Docker self-host available; default is managed API (~41k stars, 2026-05-29 [~]).
**Gap vs LazyBrain:** No code AST parsing, no conversation-tool-trace fusion, no CSS structural queries, no `valid_from`/`valid_until` on stored facts. Every query requires an LLM call and/or vector inference. Not byte-reproducible (LLM extraction is non-deterministic). Temporal accuracy is mem0's published weakest dimension.

---

### basic-memory
**Approach:** Stores AI knowledge as plain Markdown files with YAML frontmatter and wiki-style `[[relations]]`, indexed via SQLite + FastEmbed for hybrid search. MCP integration with Claude, Cursor, Codex.
**Killer feature:** Human-readable + AI-readable Markdown that both you and your agent can edit. Fully local, AGPL.
**Storage:** Markdown + SQLite index.
**Retrieval:** Full-text + vector hybrid (FastEmbed on SQLite/Postgres).
**Local-first:** YES (free tier; paid cloud sync available).
**Gap vs LazyBrain:** No code AST, no temporal validity, no CSS structural queries, no conversation-tool-trace linking, no token-budget injection pipeline.

---

### Letta / MemGPT
**Approach:** Full agent platform (formerly MemGPT, UC Berkeley). Stateful agents with persistent memory that can self-edit their own memory blocks. Core innovation: agents page in/out memory dynamically like an OS, avoiding context window overflow.
**Killer feature:** Agents that learn and adapt across sessions. Memory blocks (core, archival, recall) with LLM-driven self-editing. Letta Code brings this to terminal coding agents.
**Published benchmark numbers (source: MemGPT paper, 2024):**
- DMR (Deep Memory Retrieval): 93.4%.
- Temporal reasoning F1: **25.52** — weakest temporal score across all compared systems.
- Multi-hop reasoning: 9.15 — also the weakest multi-hop score across all compared systems.
- Every agentic retrieval requires ≥2 LLM inferences.
- ~23k stars (2026-05-29).
**Storage:** Postgres + internal memory blocks. Not human-readable files.
**Retrieval:** LLM-driven memory search + retrieval tools. No zero-LLM retrieval path.
**Local-first:** CLI runs locally; server component needed for full platform.
**Gap vs LazyBrain:** Every retrieval requires an LLM call. No code AST. No CSS structural queries. Not a PKM/second-brain for humans — designed for agent autonomy. Published temporal and multi-hop scores are the lowest across all systems compared here.

---

### cognee
**Approach:** "Memory control plane" — ingests any data (docs, code, chat) via a 6-stage `cognify` pipeline (classify → chunk → extract entities → summarize → embed → graph). Stores in graph DB (KuzuDB / Neo4j) + vector store. `remember / recall / forget / improve` API.
**Killer feature:** Automatic entity extraction and knowledge graph construction from unstructured data. Self-improving `improve` operation that prunes stale nodes and reweights edges.
**Published benchmark numbers (source: cognee GitHub / docs 2026-05-29):**
- HotpotQA: EM 0.583 / F1 0.819 — measured on a **24-train + 12-test** set (tiny; not generalizable).
- Publishes **no** token/query, latency, or cost numbers.
- Docs explicitly acknowledge non-deterministic LLM extraction.
- ~18k stars (2026-05-29 [~]).
**Storage:** Graph DB + vector store. Not plain files.
**Retrieval:** Auto-routing across vector, graph traversal, session memory.
**Local-first:** YES (Modal/Fly.io/Render/local CLI).
**Gap vs LazyBrain:** No code AST (only treats code as text), no conversation-tool-trace fusion, no CSS attribute queries, no `valid_from`/`valid_until` temporal validity, no token-budget injection. Requires a running graph DB server. Non-deterministic by design (LLM extraction). No published token or latency numbers to compare against.

---

### graphiti (Zep)
**Approach:** Temporal knowledge graph for agents. Stores facts as graph edges with validity windows (`valid_at`, `invalid_at`). Every fact has a provenance window — "Kendra loves Adidas shoes (as of March 2026)". Built on Neo4j/FalkorDB/Kuzu/Neptune.
**Killer feature:** Temporal fact storage with full history. Hybrid retrieval: semantic + BM25 + graph traversal. Backed by arXiv:2501.13956. Outperforms MemGPT on DMR benchmark.
**Published benchmark numbers (source: arXiv:2501.13956 + Zep docs):**
- LongMemEval: 71.2% (gpt-4o backbone).
- DMR (Deep Memory Retrieval): 94.8%.
- Context per answer: ~1,600 tokens.
- Search latency: p95 0.632 s; e2e latency 2.58–3.20 s.
- Requires Neo4j, FalkorDB, Kuzu, or Amazon Neptune — no plain-file or embedded-DB option (~27k stars, 2026-05-29).
**Storage:** Graph DB (Neo4j, FalkorDB, Kuzu, Neptune). No plain files.
**Retrieval:** Semantic + BM25 + graph traversal hybrid. Bi-temporal edges.
**Local-first:** Local graph DB possible (KuzuDB, FalkorDB); still requires a running DB server process.
**Gap vs LazyBrain:** No code AST, no conversation-tool-trace fusion, no CSS attribute queries, mandatory graph DB infrastructure. Temporal model is fact-level only (not full-note validity with decay scoring). Not a developer wiki — designed for agent conversation memory. Every retrieval involves LLM calls; not byte-reproducible.

---

### khoj
**Approach:** Open-source self-hostable AI assistant that indexes your documents (Markdown, PDF, Notion, Word, org-mode, GitHub repos) and answers questions with web search augmentation. Supports local LLMs (llama, qwen, mistral) and cloud models.
**Killer feature:** Broadest document-type coverage + web search fusion + custom agent scheduling. Runs from Obsidian/Emacs/desktop/mobile/WhatsApp.
**Published benchmark numbers (source: khoj GitHub / blog 2026-05-29):**
- FRAMES: 63.5% (web-grounded; different task category from personal memory recall).
- SimpleQA: 86.0% (also web-grounded; rich connectors to PDF/Notion/Word are the differentiator).
- No published token cost, latency, or temporal accuracy numbers for personal memory recall.
- ~35k stars (2026-05-29).
**Storage:** Indexed in Postgres + vector store. Source files untouched.
**Retrieval:** Semantic RAG over personal knowledge base + optional web search.
**Local-first:** YES (full self-host).
**Gap vs LazyBrain:** No code AST, no temporal validity, no CSS structural queries, no conversation-tool-trace memory. A Q&A assistant over documents, not a structured code+conversation knowledge graph. Published scores are web-grounded (different task lane).

---

### agentmemory
**Approach:** Coding-agent-specific memory layer benchmarked on retrieval accuracy. Four memory tiers (working / episodic / semantic / procedural) with automatic consolidation, contradiction detection, and Ebbinghaus-inspired decay. Triple-stream hybrid search (BM25 + vector + graph traversal) fused with RRF.
**Killer feature:** First system to publish real-world benchmarks for coding-agent memory. SQLite-only (no external DB). 19.6k stars as of 2026-05-29.
**Storage:** SQLite (no external dependencies).
**Retrieval:** Triple-stream hybrid: BM25 + dense vector + graph traversal, RRF fusion.
**Local-first:** YES.
**Gap vs LazyBrain:** No code AST (captures agent observations but not AST-extracted file structure), no conversation-tool-trace fusion, no CSS structural queries, no temporal validity windows on notes. Memory is agent-opaque (not a human-browsable wiki).

---

## 4. Honest Verdict

### Claims we do NOT make

The following claims are **not made** in this document or in any LazyBrain marketing material. Any version of this document that makes these claims should be considered inaccurate:

- **"LazyBrain beats mem0 at 92.5% LoCoMo accuracy."** LazyBrain has never been evaluated on LoCoMo. Juxtaposing CSMB (LazyBrain's self-authored internal metric) against LoCoMo J scores would be comparing incomparable benchmarks.
- **"LazyBrain beats Zep/Graphiti on recall."** LazyBrain has never been evaluated on LongMemEval or DMR. No recall comparison is valid.
- **"LazyBrain beats cognee on HotpotQA."** No such evaluation exists.
- **"LazyBrain's CSMB 100% recall proves superiority over competitors."** CSMB is a self-authored metric on LazyBrain's own brain with LazyBrain's own queries. It cannot be compared against competitor public benchmark numbers.
- **"LazyBrain achieves higher accuracy than full-context retrieval."** The full-context oracle on LoCoMo scores 72.9% J, higher than mem0's original paper score. No retrieval system surpasses full-context on accuracy — the honest tradeoff is cost and latency, not accuracy supremacy.

The defensible claims are: lower token cost, lower latency, $0 per L1 query, byte-reproducible determinism, and exact precision on typed/temporal structural queries. These advantages are measured and reproducible (see [BENCHMARKS.md](./BENCHMARKS.md) and `scripts/bench-determinism.mjs`).

---

### Where LazyBrain Genuinely Leads

1. **Code + conversation fusion — unique in the field.**
   LazyBrain is the only system that links AI-agent conversations to the exact source files they touched (via `Edit`/`Write` tool-call traces). Every other system treats code and conversation as separate inputs or ignores one entirely. This makes LazyBrain the only knowledge graph where "the decision to add auth was made in conversation X and its effects are visible in files A, B, C" is a single queryable fact.

2. **CSS-selector structural queries — $0, <5 ms, zero LLM.**
   HTML `data-cerveau-*` attributes turn every stored fact into a queryable dimension. Queries like `[data-cerveau-type="decision"]:not([data-cerveau-valid-until])` return zero false positives in <5 ms with no vector inference and no LLM. No competitor offers this. Obsidian's Dataview plugin is the closest analogy but requires a plugin, is Markdown-only, and cannot express temporal predicates.

3. **Byte-reproducible determinism — verifiable.**
   Run `node scripts/bench-determinism.mjs` against any brain: the same structural query returns the identical SHA-256 hash across N runs. This is impossible for systems that route queries through LLM inference (mem0, cognee, graphiti, Letta). Determinism matters for auditability, caching, and CI-level regression testing.

4. **Bi-temporal fact validity + time-travel — only shared with graphiti, but without graph DB.**
   graphiti pioneered bi-temporal fact storage in the agent-memory space and deserves credit. LazyBrain implements the same model (`data-cerveau-valid-from` / `data-cerveau-valid-until`) but stores it as inline HTML attributes — no Neo4j, no FalkorDB, no server process. Time-travel is a CSS selector over static files.

5. **Token-efficient retrieval pipeline (~254 avg tokens per query).**
   LazyBrain's `search --strip` extracts compact text from HTML (type + date + id + tldr + relevant sections). The reproducible benchmark average is 254 tokens per query on the bundled 53-neuron sample brain, vs 435 tokens for whole-file Markdown (1.7x fewer tokens at equal 80% recall). mem0 reports ~7,000 tokens per memory operation on LoCoMo (a different metric, but illustrating that pipeline-level token economy is a real LazyBrain differentiator). See [BENCHMARKS.md](./BENCHMARKS.md) for full methodology.

6. **Temporal accuracy advantage — on structural predicates.**
   mem0's weakest category is temporal reasoning (LoCoMo temporal sub-score 55.51%). Letta/MemGPT temporal F1 is 25.52 — the lowest of all systems compared. These are LLM-extraction-based systems where temporal facts must be re-extracted from text. LazyBrain's temporal predicates (`data-cerveau-valid-from`, `data-cerveau-valid-until`, `data-cerveau-created`) are structured HTML attributes evaluated by CSS selector — 100% precision by construction. This is a **different kind** of temporal capability: LazyBrain cannot do free-text temporal reasoning like "when did Kendra stop liking Adidas?"; it can do exact typed range queries like "all active decisions created after 2026-05-01" with zero false positives. Both capabilities matter; LazyBrain covers the structural side.

7. **Ebbinghaus decay on notes — shared only with agentmemory.**
   Both LazyBrain and agentmemory implement memory decay modeled on Ebbinghaus retention curves. LazyBrain's decay scoring is transparent in the HTML (access count + last accessed tracked per note), and decay affects retrieval ranking without destroying data.

8. **Human-browsable wiki + LLM retrieval in the same format.**
   The HTML brain is both a `lazybrain serve` wiki you browse in a browser and the data source for `lazybrain search --strip`. Every other agent-memory system is opaque to humans (vector DB, graph DB, or LLM-managed memory blocks). PKM tools (Obsidian, Logseq) are human-readable but not LLM-efficient.

### Where LazyBrain Lags

1. **No published accuracy numbers on standard benchmarks.**
   LazyBrain has never been evaluated on LoCoMo, LongMemEval, or DMR. All accuracy numbers above belong to competitors. This is the single most important gap to close for credibility (see section 8 roadmap).

2. **Multi-hop synthesis.**
   LazyBrain retrieves compact context; the LLM consuming that context performs multi-hop reasoning. If the relevant facts are not tagged/structured, fuzzy keyword retrieval may miss them. Systems like graphiti with explicit entity graphs can traverse multi-hop edges directly.

3. **Fuzzy recall on untagged content.**
   `data-cerveau-*` attributes are populated by `dream` and `enrich` pipelines. Content that was never run through those pipelines, or that lacks explicit type/tag/topic attributes, falls back to keyword search only. Competitors with LLM extraction can surface fuzzy facts from unstructured text.

4. **Stars and adoption: zero vs 18k–41k.**
   As of 2026-05-29 LazyBrain is pre-launch. mem0 ~41k, khoj ~35k, graphiti ~27k, Logseq 43k, agentmemory 19.6k. This is the most critical visibility gap.

5. **Plugin / integration ecosystem: none vs 1,000+ (Obsidian).**
   Obsidian has ~1,000 community plugins, 120M plugin downloads. LazyBrain has only its own Claude Code skills.

6. **Document types: limited vs broad.**
   LazyBrain ingests source code (14 languages via tree-sitter) and Claude Code conversation JSONL files. It does not ingest PDFs, Word docs, web URLs, Notion, org-mode, or images. khoj, Obsidian, and cognee cover far more input types.

7. **Requires Claude Code conversations.**
   The conversation ingestion pipeline is tied to Claude Code's `~/.claude/projects/*.jsonl` format. Users of Cursor, Copilot, Codex, or Amp get no conversation memory — only the code graph.

8. **No cloud/managed option.**
   All competitors offer a hosted tier. LazyBrain is local-only, which is a privacy feature but a barrier to enterprise and non-technical users.

---

## 5. Top 5 Gaps Worth Closing

These are the gaps where closing would make LazyBrain unambiguously the best on capability for its target user (developer + AI coding agent):

### GAP-A: Conversation source portability (CRITICAL)
Currently LazyBrain only reads Claude Code JSONL. Adding adapters for Cursor (`.cursor/` logs), Copilot chat history, Amp, and generic OpenAI-compatible tool-call logs would remove the single biggest adoption blocker. The code-graph half already works universally; only the conversation half is Claude-locked.

### GAP-B: Stars / launch / README discoverability (CRITICAL)
No technical change — purely distribution. A Product Hunt launch, a Hacker News "Show HN", and a 2-minute demo GIF would let the existing technical differentiation speak for itself. agentmemory went from 0 to 19.6k stars with benchmark-driven marketing; the same angle applies here.

### GAP-C: Basic document ingestion (HIGH)
Accept Markdown files, PDFs, and plain text as first-class inputs (not just code + JSONL). basic-memory (3.1k stars) is a simpler system that does this. Adding it would make LazyBrain usable as a PKM replacement, not just a coding-agent memory layer.

### GAP-D: Obsidian vault bridge plugin (HIGH)
A lightweight Obsidian community plugin that reads a LazyBrain brain and surfaces `[data-cerveau-*]` attributes in Obsidian's search panel would instantly expose LazyBrain to Obsidian's 1M+ users. Obsidian + LazyBrain = PKM + code brain, a combination no single tool offers today.

### GAP-E: MCP server (MEDIUM)
graphiti, cognee, basic-memory, and agentmemory all expose an MCP server. A `lazybrain serve --mcp` mode would let any MCP-compatible client (Claude.ai, Cursor, VS Code Copilot) query the brain without the Claude Code skills dependency.

---

## 6. Summary Table

| Dimension | Best-in-class today | LazyBrain position |
|---|---|---|
| Stars / traction | mem0 (~41k) | Pre-launch — not yet competing |
| PKM / human note-taking | Obsidian (1M+ users) | Not a general PKM (code+conv focus) |
| LoCoMo accuracy (temporal) | mem0 55.51% [weakest] / Letta 25.52 F1 | **Not yet measured — roadmap** |
| LongMemEval accuracy | Zep/Graphiti 71.2% | **Not yet measured — roadmap** |
| Agent conversation memory | mem0, graphiti | Competitive on structure; accuracy unmeasured |
| Code AST memory | agentmemory, LazyBrain | **Shared lead** |
| Code + conversation fusion | LazyBrain only | **Unique** |
| Temporal validity (bi-temporal) | graphiti, LazyBrain | **Shared lead** (LazyBrain: no graph DB needed) |
| Typed/temporal structural queries | LazyBrain only | **Unique** (100% precision, <5 ms, $0) |
| Determinism / byte-reproducibility | LazyBrain only | **Unique** |
| Token efficiency per query | LazyBrain (~254 tok avg, sample brain) | **Lead** (vs 435 Markdown, ~7k mem0/op) |
| Query latency | LazyBrain L1 (~2–8 ms) | **Lead** (vs mem0 p50 0.708 s, Zep e2e 2.6–3.2 s) |
| Cost per query | LazyBrain ($0 L1) | **Lead** |
| Ecosystem / integrations | Obsidian | Significant lag |
| Multimodal | cognee, khoj | Significant lag |
| Document types | khoj | Significant lag |

---

## 7. Sources

- [mem0ai/mem0](https://github.com/mem0ai/mem0) — ~41k stars [~], fetched 2026-05-29
- [basicmachines-co/basic-memory](https://github.com/basicmachines-co/basic-memory) — 3.1k stars, fetched 2026-05-29
- [topoteretes/cognee](https://github.com/topoteretes/cognee) — ~18k stars [~], fetched 2026-05-29
- [getzep/graphiti](https://github.com/getzep/graphiti) — ~27k stars [~], fetched 2026-05-29
- [khoj-ai/khoj](https://github.com/khoj-ai/khoj) — ~35k stars [~], fetched 2026-05-29
- [letta-ai/letta](https://github.com/letta-ai/letta) — ~23k stars [~], fetched 2026-05-29
- [logseq/logseq](https://github.com/logseq/logseq) — 43.1k stars, fetched 2026-05-29
- [foambubble/foam](https://github.com/foambubble/foam) — 17.2k stars, fetched 2026-05-29
- [athensresearch/athens](https://github.com/athensresearch/athens) — 6.3k stars, DISCONTINUED, fetched 2026-05-29
- [rohitg00/agentmemory](https://github.com/rohitg00/agentmemory) — 19.6k stars, fetched 2026-05-29
- engram — ~2.4k stars [~] from OSS Insight Q1 2026 Agent Memory Race report; repo URL not independently verified
- Obsidian: proprietary, not OSS; obsidianmd/obsidian-releases 18.2k stars; ~1M+ users per Fast Company estimate; 120M+ plugin downloads
- mem0 ECAI-2025 paper benchmark (LoCoMo J 66.88%, temporal 55.51%) and 2026 rewrite (91.6–92.5%): [Mem0 Review 2026](https://weavai.app/blog/en/2026/05/09/mem0-review-2026-ai-agent-memory-king-26-accuracy/); ~7k tokens/op, latency p50 0.708 s / p95 1.44 s
- graphiti temporal KG paper (LongMemEval 71.2%, DMR 94.8%, search p95 0.632 s, e2e 2.58–3.20 s): [arXiv:2501.13956](https://arxiv.org/abs/2501.13956)
- cognee HotpotQA (EM 0.583 / F1 0.819, 24-train/12-test): cognee GitHub README, 2026-05-29
- Letta/MemGPT temporal F1 25.52 / multi-hop 9.15 / DMR 93.4%: MemGPT paper (arXiv:2310.08560)
- khoj FRAMES 63.5% / SimpleQA 86.0%: khoj GitHub blog, 2026-05-29
- OSS Insight Agent Memory Race Q1 2026: [ossinsight.io](https://ossinsight.io/blog/agent-memory-race-2026)
- LazyBrain token benchmark (254 avg tokens/query on bundled 53-neuron sample brain, reproducible): [docs/BENCHMARKS.md](./BENCHMARKS.md)
- LazyBrain determinism verification: `node scripts/bench-determinism.mjs` (see section 8)

---

## 8. Roadmap to Head-to-Head Benchmarks

This section describes the concrete work needed to produce a fair, comparable accuracy evaluation of LazyBrain against published competitor numbers. Until this work is done, no accuracy-comparison claims are made.

### Why head-to-head matters

The published temporal sub-scores above show a real pattern: systems that store memory as LLM-extracted text (mem0 temporal J 55.51%, Letta temporal F1 25.52) perform weakest on temporal queries — the same query type that LazyBrain's `data-cerveau-valid-from/until` CSS predicates handle with 100% structural precision. A fair benchmark would quantify whether structured HTML attributes outperform LLM-extraction on temporal accuracy, while honestly measuring LazyBrain's performance on free-text multi-hop questions where it may lag.

### Step 1 — Fork mem0ai/memory-benchmarks

Clone [mem0ai/memory-benchmarks](https://github.com/mem0ai/memory-benchmarks) (or the equivalent LoCoMo eval harness). This repo contains the LLM-Judge pipeline and LoCoMo test set used to produce the published numbers.

### Step 2 — Ingest LoCoMo as data-cerveau-* HTML

Write an ingestion adapter that converts each LoCoMo conversation turn into a LazyBrain `concept-neuron` HTML file with appropriate `data-cerveau-*` attributes:
- `data-cerveau-type="concept"`
- `data-cerveau-created=<timestamp of the original turn>`
- `data-cerveau-valid-from=<date>`
- `data-cerveau-valid-until=<date>` where facts have explicit expiry
- `data-cerveau-tags=<extracted entities>`

This is the mechanism LazyBrain uses in production; the ingestion adapter makes it reproducible for a public benchmark.

### Step 3 — Run the same GPT-4o-mini LLM-as-Judge

Use the same judge model and prompts as mem0ai/memory-benchmarks to score LazyBrain on:
- **Overall LoCoMo J** — direct comparison against mem0's 66.88% (paper) / 91.6% (2026 rewrite)
- **Temporal sub-score** — the category where competitors score 55.51% and 25.52 F1; expect LazyBrain's CSS-predicate approach to show a structural advantage here
- **Multi-hop sub-score** — the category where LazyBrain's simple keyword retrieval may lag

### Step 4 — Per-category token and cost ledger

Alongside the accuracy scores, report per-query:
- Tokens sent to the LLM judge (context window cost)
- Wall-clock latency (retrieval + inference)
- Estimated dollar cost (gpt-4o-mini pricing)

This produces an honest hybrid-pipeline comparison: accuracy × cost × latency, not accuracy alone.

### Step 5 — Publish transparently

Commit the eval scripts, the LazyBrain ingestion adapter, and the full result table to this repo under `bench/locomo/`. All numbers — including losses — go in. The goal is credibility, not marketing.

**Roadmap status as of 2026-05-29:** not started. Contributions welcome.
