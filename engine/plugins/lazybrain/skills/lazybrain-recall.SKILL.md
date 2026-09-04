---
name: lazybrain-recall
description: Invoke BEFORE answering any question about prior work, past decisions, or how something is built — including "how is X built", "comment est fait X", "what did we decide about X", "did we already do X", or any question about the user's own projects or past sessions. Consults the persistent HTML brain so you never re-litigate settled choices.
allowed-tools: [Bash, Read]
disabled-model-invocation: false
---

# LazyBrain — HTML-native memory recall

The user's brain is a folder of HTML files annotated with `data-cerveau-*` attributes, indexed by SQLite FTS5. Unlike markdown memory systems, our HTML structure encodes **typed relationships, file paths, decisions, contradictions and provenance** as queryable structure. You have **two ways** to consult it.

## 1. The CLI (free, < 30 ms, $0)

```bash
# Free-text search — auto routes L1 (CSS) / L2 (BM25) / L3 (embedding) / L4 (rerank)
lazybrain search "<topic>" --top 5 --strip --pretty

# Direct lookup by short id (returned in SessionStart highlights)
lazybrain query "#<short-id>" --pretty

# Tag-scoped search
lazybrain search "<terms>" --tag auth --top 3

# Time-travel: what did we know on a date?
lazybrain search "<terms>" --as-of 2026-04-15
```

Output is already stripped to dense plain text. Quote facts verbatim with `[#id]` reference.

## 2. CSS structural queries (deterministic L1, < 5 ms)

This is the **superpower** that markdown memory doesn't have. The brain is HTML, so you can target by structure with `lazybrain query '<selector>'`.

### Vocabulary cheat-sheet

| HTML element / attribute | Encodes | CSS to query it |
|---|---|---|
| `<article data-cerveau-type="decision">` | A decision note | `article[data-cerveau-type="decision"]` |
| `<article data-cerveau-valid-until>` | Invalidated/superseded note | `article[data-cerveau-valid-until]` |
| `<article data-cerveau-valid-until=""]` or absent | **Active** (still true) | `article:not([data-cerveau-valid-until])` |
| `<data value="src/auth/login.ts">login.ts</data>` | File path referenced | `data[value*="src/auth"]` |
| `<aside class="infobox">` | Note metadata table | `article aside.infobox dl` |
| `<dl><dt>term</dt><dd>def</dd></dl>` | Glossary entry | `dl dt` |
| `<dfn id="postgres-prod">` | Canonical entity definition | `dfn[id="postgres-prod"]` |
| `<a href="#note-id" rel="canonical\|prev\|next\|related">` | Typed cross-link | `a[rel="related"]` |
| `<time datetime="2026-05-22">` | Timestamp | `time[datetime^="2026-05"]` |
| `<aside role="doc-warning">` | Warning / anti-pattern (DON'T DO) | `aside[role="doc-warning"]` |
| `<aside role="doc-tip">` | Best practice / tip | `aside[role="doc-tip"]` |
| `<aside role="doc-errata">` | Correction of previous belief | `aside[role="doc-errata"]` |
| `<details open><summary>fact</summary>` | Primary fact (expand-by-default) | `details[open] summary` |
| `<mark>` | LLM-highlighted attention | `mark` |
| `<meter value="0.85">` | Confidence quantified | `meter[value]` |
| `<section data-section="reasoning">` | Why-section of a note | `section[data-section="reasoning"]` |
| `<nav class="see-also">` | Related notes list | `nav.see-also a` |
| `<nav class="categories">` | Footer taxonomy | `nav.categories a` |
| `data-cerveau-saliency-kind="contradiction"` | Note about a contradiction encountered | `[data-cerveau-saliency-kind="contradiction"]` |
| `data-cerveau-saliency-kind="painful-bug"` | Note about a costly bug | `[data-cerveau-saliency-kind="painful-bug"]` |
| `data-cerveau-saliency-kind="breakthrough"` | Note about a key win | `[data-cerveau-saliency-kind="breakthrough"]` |

### Graph & Provenance

| Attribute | Encodes | CSS query |
|---|---|---|
| `data-cerveau-replaces="id1,id2"` | Notes this one supersedes | `article[data-cerveau-replaces]` |
| `data-cerveau-replaced-by="id"` | Note that replaced this one | `article[data-cerveau-replaced-by]` |
| `data-cerveau-causes="reason1\|reason2"` | Causal reasons | `article[data-cerveau-causes]` |
| `data-cerveau-triples="subj\|pred\|obj"` | Semantic triples | `article[data-cerveau-triples*="postgres"]` |
| `data-cerveau-entities="db:postgres,lib:react"` | Named entities | `article[data-cerveau-entities*="db:postgres"]` |
| `data-cerveau-link-strength="0.85"` | Link confidence on `<a>` | `a[data-cerveau-link-strength]` |
| `aria-current="page"` | Most recent replacement | `article[aria-current="page"]` |

### Tool & Context

| Attribute | Encodes | CSS query |
|---|---|---|
| `data-cerveau-cwd="/path/to/project"` | Working directory | `article[data-cerveau-cwd*="acme"]` |
| `data-cerveau-tool="Bash"` | Which tool generated note | `article[data-cerveau-tool="Edit"]` |
| `data-cerveau-files-modified="f1,f2"` | Modified files | `article[data-cerveau-files-modified*="auth"]` |
| `data-cerveau-files-read="f1,f2"` | Read files | `article[data-cerveau-files-read*="config"]` |
| `data-cerveau-agent="vibe"` | Which coding agent produced the note | `article[data-cerveau-agent="vibe"]` |
| `data-cerveau-source-kind="plan"` | transcript/subagent/plan/history/compaction-summary | `article[data-cerveau-source-kind="compaction-summary"]` |
| `data-cerveau-git-commit="<hash>"` | Commit at session start (git-anchored time travel) | `article[data-cerveau-git-commit^="deadbeef"]` |
| `data-cerveau-git-branch="main"` | Branch at session start | `article[data-cerveau-git-branch="main"]` |
| `data-cerveau-session-parent="<id>"` | Pre-compaction parent session (Vibe lineage) | `article[data-cerveau-session-parent]` |
| `class="type-decision"` | CSS class by type | `article.type-decision` |

### Quality & Extraction

| Attribute | Encodes | CSS query |
|---|---|---|
| `data-cerveau-tier="working\|archival"` | Note lifecycle stage | `article[data-cerveau-tier="working"]` |
| `data-cerveau-version="0.2.0"` | Schema version | `article[data-cerveau-version="0.2.0"]` |
| `data-cerveau-extracted-by="heuristic"` | How fact was extracted | `[data-cerveau-extracted-by="human"]` |
| `data-cerveau-kind="error"` (on facts) | Fact classification | `[data-cerveau-kind="error"]` |
| `data-cerveau-confidence="0.85"` (article) | Mean confidence | `article[data-cerveau-confidence]` |
| `data-cerveau-topic="project/auth/oauth"` | Topic hierarchy | `article[data-cerveau-topic^="acme/"]` |

### Semantic HTML sections

| Element | Content | CSS query |
|---|---|---|
| `<section data-section="tldr">` | 1-sentence summary | `section[data-section="tldr"]` |
| `<section data-section="qa">` | Extracted Q&A pairs | `section[data-section="qa"]` |
| `<section data-section="errors">` | Error patterns | `section[data-section="errors"]` |
| `<section data-section="tool_trace">` | Command/tool output | `section[data-section="tool_trace"]` |
| `<details data-error="signature">` | Error signature match | `details[data-error]` |
| `<kbd>cmd</kbd>` | CLI command | `kbd` |
| `<samp>output</samp>` | Tool output | `samp` |
| `<abbr title="expansion">ACR</abbr>` | Acronym definition | `abbr[title]` |
| `<var>$ENV_VAR</var>` | Environment variable | `var` |

### Advanced CSS queries

```bash
# All errors in the Acme project
lazybrain query 'article[data-cerveau-cwd*="acme"] section[data-section="errors"]'

# Decisions about postgres, still active
lazybrain query 'article[data-cerveau-entities*="db:postgres"][data-cerveau-type="decision"]:not([data-cerveau-valid-until])'

# Human-written facts (not heuristic)
lazybrain query '[data-cerveau-extracted-by="human"]'

# Contradictions found in the brain
lazybrain query 'article[data-cerveau-saliency-kind="contradiction"]'

# All anti-pattern warnings
lazybrain query 'aside[role="doc-warning"]'

# Working-tier notes for a specific topic
lazybrain query 'article[data-cerveau-tier="working"][data-cerveau-topic^="acme/"]'
```

### When to use CSS query (L1) vs free-text search (L2/L3)

| Intent | Use this |
|---|---|
| "Find all warnings about React Server Actions" | `lazybrain query 'aside[role="doc-warning"][data-cerveau-tags~="rsc"]'` |
| "What's the current ORM decision?" | `lazybrain query 'article[data-cerveau-type="decision"][data-cerveau-tags~="orm"]:not([data-cerveau-valid-until])'` |
| "Notes touching src/auth/" | `lazybrain query 'data[value*="src/auth"]'` |
| "When did we add Zod?" | `lazybrain query 'article[data-cerveau-tags~="zod"] time[datetime]'` |
| "Why did we make X async?" | `lazybrain search "why X async" --pretty` (semantic, L3) |
| "Has this bug happened before?" | `lazybrain query '[data-cerveau-saliency-kind="painful-bug"]'` |
| "What's settled vs still being discussed?" | `lazybrain query 'article[data-cerveau-type="decision"]:not([data-cerveau-valid-until])'` |

### Spread-activation pattern

Once you have a hit, follow its links instead of new searches:

```bash
# First get the note
lazybrain query "#my-note-id" --pretty
# Then explore its neighbours (1-hop graph)
lazybrain neighbours my-note-id
# Or follow a specific rel
lazybrain query "#my-note-id a[rel='related']"
```

## When to use this skill

Invoke BEFORE answering when the user message contains any of:
- "did we already…", "have we…", "what did we…", "as we discussed", "comme on a vu", "déjà vu"
- A reference to a past commit, decision, branch, library choice
- A repo path / file you have no prior context for in this session
- A recurring problem (auth, deploy, migration) — check if there's a prior decision OR warning

Also invoke **proactively** at the start of a non-trivial task in a familiar repo.

## How to store (write path)

The hook auto-captures Edit/Write/Bash. But **abstract decisions** lived only in conversation should be explicitly stored:

```bash
echo "Decision: switched from Postgres to SQLite for local cache. Reason: zero-ops, faster, single-user. Tradeoff: no multi-process writes." \
  | lazybrain store --type decision --tags database,refactor --pretty
```

`--type` ∈ {decision, episodic, reference, procedural, semantic}.

## Anti-patterns

- Don't recall on trivial prompts ("ok", "thanks", "yes"). The hook short-circuits these.
- Don't `search` the user's exact words — extract the *topic* ("switched from Postgres" → search "postgres sqlite migration" or `query 'data[value*="postgres"]'`).
- Don't dump full search output — quote the relevant fact with `[#id]`.
- Don't ignore `<aside role="doc-warning">` notes — they encode "don't redo this".
- Don't trust a note with `data-cerveau-valid-until` set — it's been superseded.
- Check `data-cerveau-confidence` before trusting a fact — below 0.5 is unreliable.
- Check `data-cerveau-extracted-by` — "human" facts are more reliable than "heuristic".
- Use `data-cerveau-topic` to scope queries to the current project, not the whole brain.
- Prefer `data-cerveau-tier="working"` notes over "archival" for current state.

## Failure modes

If the CLI fails (no daemon, no brain path), proceed without recall — never block the user.

```bash
lazybrain stats 2>/dev/null || echo "brain unavailable"
```

## Graph Navigation

The brain has a knowledge graph (`brain-graph.json`) that maps how notes relate. Use it to navigate efficiently.

### Quick graph commands

| Command | Purpose |
|---------|---------|
| `lazybrain graph --pretty` | Rebuild graph (backlinks, clusters, PageRank, brain-graph.json) |
| `lazybrain graph --format text --pretty` | Adjacency list for quick LLM parsing |

### Using the graph in recall

When looking for related notes, check the graph first:
- **Hub nodes** have many connections — they're good entry points
- **Cluster labels** match topic segments — filter by cluster to narrow scope
- **Cross-project edges** reveal unexpected relationships between topics

### Wiki pages with embedded graphs

Synthesized wiki pages include `<section data-section="graph">` with:
- Cluster map table
- Hub node list
- Adjacency list in `<pre data-graph-format="adjacency">`

Query these via CSS:
```
lazybrain query 'section[data-section="graph"] pre[data-graph-format="adjacency"]'
lazybrain query 'section[data-section="graph-hubs"] li'
```
