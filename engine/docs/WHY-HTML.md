# Why HTML is the right format for an LLM second brain

> **Also available as a self-contained, shareable blog post:**
> [docs/why-html-for-ai-memory.html](./why-html-for-ai-memory.html) — same arguments, designed for sharing,
> with an interactive live CSS query demo embedded in the page itself.

This document makes a technical case for a specific, counterintuitive claim: plain HTML files —
the same format that has powered the web since 1993 — are a better storage medium for an
AI agent's second brain than Markdown, vector databases, graph databases, or LLM-managed memory
layers.

The case rests on four structural properties that no other single format provides simultaneously:

1. **Deterministic, $0, no-LLM retrieval** via CSS attribute selectors evaluated in-process by
   linkedom's spec-compliant CSS selector engine (a browser-compatible DOM in pure JavaScript).
   Same brain + same query = same bytes, every run, zero inference cost.
2. **Typed and bi-temporal queries** via `data-cerveau-*` attributes: type, tags, valid-from,
   valid-until. A question like "all still-valid decisions in the auth module" is a single CSS
   predicate. Markdown cannot express it; vector stores have no native lifecycle model.
3. **Human-readable, git-diffable, auditable** — no opaque binary index, no vendor toolchain
   required to read, diff, or audit the brain. Every retrieval is traceable to a plain file.
4. **One format: store, query target, and static website** — the file the agent queries is the
   page a human browses in `lazybrain serve`, and the artifact `lazybrain publish` deploys
   to a static host with no build step.

Token efficiency is real and measurable — 1.7x fewer tokens than Markdown whole-note at equal
recall on the sample corpus — but it is a **secondary consequence** of the typed schema enabling
surgical section-level retrieval, not an independent property of HTML as a format. Token numbers
are corpus-dependent and have not been measured on LoCoMo, LongMemEval, or DMR. The four pillars
above hold regardless of corpus size or terminology alignment.

The document is organized around these four pillars. Sections 3 and 4 are the strongest technical
claims; section 2 (token efficiency) is supporting evidence. The final section is an honest
accounting of what HTML does NOT solve.

All benchmark numbers are from [docs/BENCHMARKS.md](./BENCHMARKS.md) (v8, reproducible sample-brain,
content-based scoring, 2026-05-30). Numbers prefixed `[~]` are approximate.
Reproduce: `node scripts/run-benchmark.mjs` — runs on the bundled examples/sample-brain — no setup, no private data.

---

## 1. The core idea: markup as index, not payload

Every fact in LazyBrain is an HTML element. Not a Markdown bullet, not a JSON record, not a graph
node — an HTML element, annotated with `data-cerveau-*` attributes that declare what the element
IS, when it was true, who it came from, and how confident we are.

```html
<article id="oauth-migration-decision"
         data-cerveau-type="decision"
         data-cerveau-created="2026-05-20T10:15:00Z"
         data-cerveau-valid-from="2026-05-20"
         data-cerveau-tags="auth oauth security"
         data-cerveau-importance="0.9"
         data-cerveau-confidence="1.0">

  <h2>Migrate to OAuth2 PKCE</h2>

  <p data-cerveau-fact data-cerveau-extracted-by="human">
    Decision: drop custom JWT in favour of OAuth2 PKCE.
  </p>

  <p data-cerveau-fact data-cerveau-confidence="0.8"
     data-cerveau-extracted-by="llm:claude-opus-4-7">
    Primary driver: Q2 security audit flagged manual secret rotation.
  </p>
</article>
```

When the LLM needs this fact, the system does not send the HTML. It runs a CSS selector —
`article[data-cerveau-type="decision"][data-cerveau-tags~="auth"]` — and extracts only the
`textContent` of the matched element:

```
[decision | 2026-05-20 | oauth-migration-decision]
Migrate to OAuth2 PKCE
Decision: drop custom JWT in favour of OAuth2 PKCE.
Primary driver: Q2 security audit flagged manual secret rotation.
```

The markup is the **index**. The inner text is the **payload**. Every `data-cerveau-*`
attribute is a zero-cost, instantly-queryable column that costs nothing extra to store and
nothing extra to query.

This pattern — attributes as typed metadata, textContent as prose — is the foundation of every
advantage described below.

---

## 2. Token efficiency: a real but secondary benefit

> **Context for this section:** token savings are a consequence of the typed schema (sections 3
> and 4 below), not a standalone property of HTML markup. The numbers are reproducible and honest.
> They do not generalize to all corpora — a reader who finds this unconvincing should focus on
> sections 3–4, which hold by construction regardless of corpus characteristics.

Token cost is a real operational concern. Every token in the context window costs money; every
unnecessary token dilutes signal-to-noise for the model. LazyBrain's surgical strip mode
exploits the typed schema to return only the relevant `<section>` — not the whole file — which
is why the advantage is real on aligned corpora.

### Surgical retrieval — this is how LazyBrain works (token-optimal)

LazyBrain's actual retrieval mode is the **surgical strip**: a keyword query finds the
top-matching neurons, then only the `textContent` of the relevant `<section>` elements is
returned — not the whole neuron. This is `lazybrain search --strip`, the default product behavior.

Consider "What is the AdminPanel project structure?"

**Markdown whole-note** returns the top-3 matching `.md` files in full: every heading, subheading,
inline comment, YAML frontmatter. Measured cost: **380 tokens** (bench Q5, Markdown baseline).

**LazyBrain surgical** runs a keyword query over 53 sample-brain neurons, finds the top-3 matches,
extracts only the `textContent` of query-matched sections with a compact type/date/id prefix.
Measured cost: **164 tokens** (bench Q5, HTML-LB surgical).

2.3x fewer tokens on a single query, at identical recall. Across all five benchmark queries:

| Query | HTML-LB surgical *(product behavior)* | Markdown whole-note |
|-------|----------------------------------------|---------------------|
| Acme architecture | 249 | 380 |
| Auth bugs and decisions | 331 | 500 |
| Bugs in build/cal feature | 313 | 528 |
| Stripe integration | 212 | 386 |
| AdminPanel structure | 164 | 380 |
| **Average** | **254** | **435** |

**1.7x fewer tokens on average** (254 vs 435) at identical 80% recall. Useful-tokens (per correct
result): 119 vs 205 — a 1.7x gap. At scale, 1.7x fewer tokens is a real budget difference.
Both surgical and Markdown achieve 80% avg recall on the sample-brain corpus — this is a pure
token-efficiency advantage with no recall tradeoff.

Why? Markdown retrieval returns whole files — there is no structural way to target only the
relevant section. HTML's `data-cerveau-*` attributes let the stripper find the exact `<section>`
that is relevant and return only its text. The 4.3x gap between HTML-LB surgical (254t) and
HTML-generic (1,087t) confirms the advantage comes from the **typed schema and inner-text
stripping**, not from HTML markup being inherently smaller — raw HTML without structure is 4.3x
worse, not better.

Note: an idealized Markdown+RAG pipeline (heading-split chunking) would achieve lower token counts
than LazyBrain surgical — no shipping tool provides this automatically; Obsidian vault search and
basic-memory both return whole notes. LazyBrain's 254t surgical average is compared against the
primary realistic Markdown baseline (whole-note retrieval).

### Full-coverage mode — honest equal-coverage comparison (non-representative)

> **This section exists for transparency only. HTML-LB(full) is NOT how LazyBrain retrieves.**
> It is an equal-coverage baseline that returns the complete knowledge text of every matched
> neuron — the same content depth as Markdown whole-note. On the small bundled sample-brain,
> full-coverage can use MORE tokens than Markdown because it returns entire neurons rather than
> targeted sections. The product always uses the surgical strip above, which wins on token cost.
> The comparison is included here so readers can see the full picture honestly.

If you deliberately disable surgical stripping and return each matched neuron's full knowledge
text (`HTML-LB(full)`), the token cost rises substantially — and on the small sample-brain corpus
it can exceed the Markdown baseline, because each neuron bundles all sections of a topic into one
file. This is not a regression in the product; it is what happens when you remove the primary
optimization (section-level stripping) and compare on equal coverage terms. The surgical strip
mode, which is the default, avoids this by targeting only the relevant `<section>` inside each
neuron.

---

## 3. Typed and bi-temporal structural queries — the primary differentiator

> **This is the strongest technical claim in this document.** The following properties hold by
> logical construction, not by empirical measurement on a sample corpus. They apply regardless
> of brain size, query terminology, or corpus alignment.

Some queries are not fuzzy. They have exact, unambiguous answers:

- "Show me all decisions that are still active (not superseded)."
- "What was the state of the auth module as of 2026-03-01?"
- "Find every bug in the Acme project."

**Markdown cannot answer these questions with precision.** Keyword-grep on "decision" returns
every file that mentions the word — comments, changelog entries, meeting notes where decisions
are discussed but not made. There is no structural distinction between "a file about a decision"
and "a file that mentions the word decision". Even a heading-split RAG pipeline cannot
distinguish a fact-bearing `[decision]` record from an incidental mention in prose.

**Vector stores cannot answer them at all.** A vector index has no native type schema, no
lifecycle model, and no temporal attributes. Staleness is a free-text concern surfaced by
approximate nearest-neighbor search — the same mechanism that surfaces the stale fact also
surfaces the current one, with no reliable way to discriminate. Implementing bi-temporal
filtering on a vector store requires wrapping it in a bespoke metadata layer and a separate
filtering pass — i.e., building the `data-cerveau-*` schema from scratch on top of a system
that was not designed for it.

HTML with `data-cerveau-*` attributes can answer them with zero false positives:

```css
/* All still-valid decisions */
article[data-cerveau-type="decision"]:not([data-cerveau-valid-until])

/* All bugs in the Acme project */
article[data-cerveau-tags~="bug"][data-cerveau-tags~="acme"]

/* Everything created before 2026-03-01 — time-travel */
article[data-cerveau-created <= "2026-03-01"]

/* Auth-related facts that became valid in 2026 and are not yet expired */
article[data-cerveau-tags~="auth"]
       [data-cerveau-valid-from >= "2026-01-01"]
       :not([data-cerveau-valid-until])
```

These selectors are evaluated by a CSS engine (or a DOM query library like `cheerio`/`happy-dom`).
The engine cannot return a non-matching element. **Precision is 100% by construction** for these
structural/typed queries — not as an empirical claim, but as a logical property of set membership.

The BENCHMARKS.md structural query section (SQ1–SQ4) demonstrates this on real data:

| Query | HTML predicate | What Markdown keyword-grep gets wrong |
|-------|---------------|---------------------------------------|
| Active concepts | `:not([data-cerveau-valid-until])` | Returns any file containing "concept" — includes structure pages, code comments |
| Bugs in Acme | `tags~="bug" AND topic~="acme"` | Matches "bug" in unrelated error messages, README text |
| Decisions since May | `type="concept" AND created >= "2026-05-01"` | "2026-05" appears in timestamps, URLs, file paths of any document |

Time-travel is a first-class CSS selector:

```css
/* Reconstruct brain state as of 2026-03-01 */
article[data-cerveau-valid-from <= "2026-03-01"]:not([data-cerveau-valid-until]),
article[data-cerveau-valid-from <= "2026-03-01"]
       [data-cerveau-valid-until >= "2026-03-01"]
```

There is no equivalent in Markdown, vector stores, or LLM-extraction memory layers (where
temporal reasoning must be inferred from text and contributes to error: mem0's LoCoMo temporal
sub-score is 55.51%; Letta/MemGPT temporal F1 is 25.52 — both systems' weakest dimensions).

**Important scope**: the 100% precision claim applies strictly to STRUCTURAL and TYPED queries —
queries that can be expressed as attribute predicates. Free-text questions like "when did we
decide to change the caching strategy and why?" still require keyword (L2), semantic (L3), or
LLM (L5) retrieval, where precision is not guaranteed. LazyBrain has not been evaluated on
public benchmarks (LoCoMo, LongMemEval, DMR); no claims about free-text accuracy relative to
competitors are made here. That evaluation is on the roadmap.

---

## 4. Determinism and zero query cost

> **This is the second strongest claim.** The determinism property is verified by
> `scripts/bench-determinism.mjs`, not assumed. The $0 cost is a direct consequence of
> eliminating LLM calls from the retrieval path — not a pricing choice.

When you send the same query to a mem0, cognee, graphiti, or Letta memory layer twice, you may
get different results. LLM inference is stochastic; extraction and re-ranking introduce variance.
This is not a criticism — it is a design property of systems that use LLMs as query processors.
It has a practical consequence: those systems cannot be regression-tested with a hash check,
cannot be safely cached as pure functions, and cannot produce an auditable provenance chain from
query to result.

LazyBrain's L1 (CSS selector) and L2 (SQLite FTS5) layers are **deterministic by construction**.
The same brain state + the same query = the same bytes in the same order, every time.
`scripts/bench-determinism.mjs` verifies this by running a structural query 10 times and asserting
all outputs share the same SHA-256 hash:

```
run 01: 6d2fb562992ead24b1c9413d4c651d528107f0fef481931b2743fa93ce3fc300  (6.1 ms)
run 02: 6d2fb562992ead24b1c9413d4c651d528107f0fef481931b2743fa93ce3fc300  (2.5 ms)
...
run 10: 6d2fb562992ead24b1c9413d4c651d528107f0fef481931b2743fa93ce3fc300  (0.8 ms)

PASS — all 10 runs returned byte-identical results.
```

Determinism matters in three practical ways:

1. **CI regression testing**: a changed brain changes the hash. A CI job can detect unintended
   mutations to the knowledge base without re-running an LLM judge.

2. **Safe caching**: `query(brain_hash, selector) -> result_hash` is a pure function. Any caching
   layer can store the mapping forever without staleness risk. This is impossible for systems
   where retrieval involves LLM calls.

3. **Auditability**: a stored hash proves the brain state at a point in time. If a decision was
   made using brain state X, you can reconstruct X later and verify the context that informed
   the decision.

Cost and determinism profile:

| System | Cost per query | Latency | LLM required | Deterministic |
|--------|---------------|---------|-------------|---------------|
| mem0 | ~$0.001–0.01/op (embedding + LLM) | p50 0.708 s | YES | NO |
| graphiti/Zep | cloud API pricing + graph DB | e2e 2.58–3.20 s | YES | NO |
| cognee | LLM extraction per cognify call | not published | YES | NO |
| Letta/MemGPT | ≥2 inferences per retrieval | not published | YES | NO |
| **LazyBrain L1** | **$0** (CSS attribute scan) | **~2–15 ms (bench, platform-dependent; see BENCHMARKS.md)** | **NO** | **YES — SHA-256 verified** |
| **LazyBrain L2** | **$0** (SQLite FTS5) | **< 30 ms typical (sample corpus; scales with brain size)** | **NO** | **YES — ORDER BY semantics** |

L1 is a DOM query over in-memory parsed HTML. No network, no embedding inference, no LLM.
The only runtime dependency is a Node.js process and a folder of `.html` files.

The combination of $0 cost and byte-identical output is not achievable in a system that uses LLM
inference in the retrieval path. It is a structural property of using a deterministic query
engine (CSS/DOM or SQLite FTS5) over a plain-file store.

---

## 5. A navigable brain

HTML is not just machine-readable — it is human-readable in the most literal sense: any browser
can render it.

`lazybrain serve` starts a local HTTP server that exposes the brain as a navigable wiki. Every
neuron becomes a page. Every `data-cerveau-tags` value becomes a filter facet. Backlinks
(`data-cerveau-link-type="refines"`, `"contradicts"`, `"cites"`) appear as a sidebar.
`data-cerveau-topic` attributes build breadcrumbs: project > module > feature > decision.

The same `.html` file that gets queried by `lazybrain search --strip` is the page you browse
in the wiki. No separate "human interface" — the storage format IS the interface.

This is a property no competing system shares:

- **Vector DBs** (Qdrant, Pinecone, Weaviate): opaque binary indexes. You cannot open them
  in a browser.
- **Graph DBs** (Neo4j, FalkorDB): require running servers and specialized query clients.
- **LLM memory layers** (mem0, cognee, Letta): memory blocks are not human-readable or
  browsable without the app.
- **Markdown tools** (Obsidian, Logseq): human-readable, but not LLM-efficient without a
  separate pipeline.

LazyBrain is the only system where "human reading the brain" and "LLM querying the brain" are
the same operation on the same file.

---

## 6. A shareable brain

LazyBrain brains are plain files on disk. There is no database to export, no proprietary format
to decode, no app to install to read the output.

```
brain/
  auth/
    oauth-migration-decision.html
    jwt-removal-procedure.html
  acme/
    architecture-overview.html
    stripe-integration.html
  ...
```

To share a brain with a teammate:

```bash
zip -r my-brain.zip brain/
```

To push it to a repository:

```bash
git add brain/ && git commit -m "chore: update brain" && git push
```

The recipient can read any `.html` file in a browser, run `lazybrain search` against it, or
diff specific neurons in `git log`. No installation beyond Node.js is required.

This portability is not trivial. mem0 stores facts in a vector database that requires a running
Qdrant or Redis instance to access. graphiti requires Neo4j, FalkorDB, or KuzuDB. Cognee requires
a graph DB + vector store combination. LazyBrain brains can be emailed, put on a USB stick, or
reviewed in a pull request with standard `git diff`.

Plain files also mean no vendor lock-in. If LazyBrain is discontinued, every neuron is still
a valid HTML file readable by any browser or text editor in 2026, 2030, or 2040.

---

## 7. A hostable brain

Static HTML is directly publishable to any static hosting platform. `lazybrain publish`
runs a scrubber (secret detection, attribute whitelist, inline JS removal, CSP header injection)
and emits a clean copy of the brain ready for deployment.

```bash
lazybrain publish --output ./public

# Deploy anywhere that serves static files
netlify deploy --dir ./public
# or: GitHub Pages, Cloudflare Pages, Vercel, S3 + CloudFront
```

The result is a searchable, browsable, fully public knowledge site — with no server process, no
database, no authentication layer, and no hosting cost beyond static file storage.

This is qualitatively different from every competing system:

- Vector DBs require a server process to answer queries.
- Graph DBs require a server process.
- LLM memory layers require a cloud API.

A hosted LazyBrain brain is a fully static artefact: the CSS selector queries run in-browser
using the browser's own DOM engine. No network requests after the initial page load.

One concrete idea: LazyBrain can host its own brain online as a living demo. Every neuron that
documents a design decision in the LazyBrain codebase becomes a publicly browsable page at
`lazybrain.dev/brain/decision/...`. The documentation IS the brain.

---

## 8. Future-proof and inspectable

The web's two most durable formats are HTML and CSS. They are:

- **Standardized** by the W3C with a 30-year backwards-compatibility track record.
- **Universally parseable**: every operating system ships a browser; every programming language
  has an HTML parser.
- **Human-readable** without tooling: a `.html` file opened in a text editor is legible.
- **Diffable**: `git diff brain/auth/oauth-decision.html` shows exactly what changed and when.
- **Grep-able**: `grep -r 'data-cerveau-type="decision"' brain/` works with standard POSIX tools.

Compare this to the alternatives:

| Format | Readable in 20 years? | Parseable without vendor tooling? | Diffable in git? |
|--------|-----------------------|-----------------------------------|------------------|
| HTML | YES | YES (any browser/parser) | YES (text) |
| Markdown | YES | YES | YES |
| Qdrant vector index | UNKNOWN | NO (binary format) | NO |
| Neo4j graph dump | PARTIAL | REQUIRES Neo4j | PARTIAL |
| SQLite (without schema) | PARTIAL | YES (sqlite3 CLI) | NO (binary) |
| JSONL conversation logs | YES | YES | PARTIAL (noisy) |

Vector database export formats change between versions. Graph database schemas require the
original application to interpret. A LazyBrain brain from 2026 will be fully readable by a
browser in 2046. The `data-cerveau-*` attributes are standard HTML5 `data-*` attributes —
any HTML parser that exists will preserve them.

The inspection argument is not hypothetical. When a second brain produces a wrong answer in a
production system, "open the source HTML file and read the fact that was retrieved" is a
debugging path that does not exist for vector stores or graph DBs. Every LazyBrain query is
auditable by looking at the files.

---

## The unified argument

The four structural properties reinforce each other:

- Because facts are stored as typed HTML elements with `data-cerveau-*` attributes (pillar 2),
  they can be retrieved by a deterministic CSS engine (pillar 1) with zero false positives.
- Because the retrieval is deterministic (pillar 1), it is cacheable as a pure function,
  testable in CI with a hash check, and auditable without replaying LLM inference.
- Because the store is plain files (pillar 3), there is no opaque binary index to maintain,
  no vendor server to run, and no proprietary format to decode. The full state of the brain
  at any point in time is visible in `git log`.
- Because the format is HTML (pillar 4), the same file that the agent queries is the page
  a human reads in a browser, the artifact published to a static host, and the diff reviewed
  in a pull request.

No other single format — not Markdown, not JSONL, not a vector index, not a graph DB — provides
all four simultaneously. That is the argument. The token efficiency numbers are real, but they
are downstream of pillar 2, not an independent reason to choose HTML.

---

## Prior art and adjacent work

One adjacent work informed and reinforces this thesis:

- **HtmlRAG** (arXiv 2411.02959, WWW 2025): demonstrates that HTML preserves document structure better than plain text for retrieval-augmented generation. LazyBrain goes further: `data-cerveau-*` attributes are a typed schema; CSS selectors are the query language. No RAG paper or agent output framework applies HTML in this way.

Neither work describes a memory store with CSS-selectable typed/temporal attributes. That is the contribution here.

---

## What HTML does NOT magically solve

This document would be dishonest without stating clearly what HTML and CSS selectors cannot do:

**1. Fuzzy semantic synthesis.** The question "summarize everything I've learned about auth
across all projects" cannot be answered by a CSS selector. It requires either keyword search
(L2) or embedding-based semantic search (L3), followed by an LLM synthesis pass. HTML's
structured attributes help retrieve the right facts, but the synthesis is still an LLM operation.

**2. Untagged content.** The `data-cerveau-*` advantages only apply to content that has been
processed by the `dream` and `enrich` pipelines. Raw notes that have not been tagged with
`data-cerveau-type`, `data-cerveau-tags`, or `data-cerveau-topic` fall back to keyword search
only. The format is only as good as the tagging discipline.

**3. Free-text temporal reasoning.** "When did the team decide to stop using JWT?" — if the
decision is stored as a tagged fact with `data-cerveau-valid-until`, a CSS selector answers
it exactly. If the decision is buried in prose without attributes, the same limitations as any
other full-text search apply. LLM-based memory systems that extract facts from prose may
surface this; LazyBrain's structural layer will not.

**4. Standard benchmark accuracy.** LazyBrain has not been evaluated on LoCoMo, LongMemEval,
or DMR. All competitor accuracy numbers in this document belong to the competitors. A LoCoMo
evaluation is planned (see BENCHMARKS.md section 8) but not yet done. No claims about
LazyBrain's free-text QA accuracy relative to competitors are made.

**5. Precision/recall on keyword queries (surgical mode).** HTML-LB surgical achieves 80%
recall on the sample-brain corpus — identical to Markdown whole-note. Surgical mode returns only
query-matched sections, which is more token-efficient (254t vs 435t) without sacrificing recall
on a corpus where terminology is aligned. This is the real product behavior (`search --strip`),
not a cherry-picked measurement.

The claim is not "HTML solves everything". The claim is: for the specific capabilities it
provides — typed queries, temporal predicates, determinism, surgical token efficiency (the
product's default operating point), portability, browsability, and durability — HTML is the right
choice, and no alternative format provides all of them simultaneously.

---

*Benchmark source: [docs/BENCHMARKS.md](./BENCHMARKS.md) — v8, reproducible sample-brain corpus,
content-based scoring, 53-neuron public brain, `cl100k_base` tokenizer, 2026-05-30.
Reproduce: `node scripts/run-benchmark.mjs` — runs on bundled examples/sample-brain — no setup, no private data.
HTML-LB(surgical) is the product's actual retrieval mode (`search --strip`); it is the headline result.
HTML-LB(full) is a non-representative equal-coverage comparison retained for transparency — it returns
whole neurons rather than targeted sections, and can exceed Markdown token cost on small corpora;
it excludes nav/toc/infobox chrome (not knowledge payload; product does not retrieve it).*
