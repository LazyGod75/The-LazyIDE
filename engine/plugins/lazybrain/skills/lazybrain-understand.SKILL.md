---
name: lazybrain-understand
description: Enrich hierarchical knowledge-nodes from conversation content. Run AFTER /lazybrain-graph.
allowed-tools: [Bash, PowerShell]
disabled-model-invocation: false
---

# LazyBrain Understand (Hierarchical Enrichment)

Aggregates conversation content into hierarchical knowledge-nodes via topic-path prefix matching. Higher nodes (project) get broader aggregations. Deeper nodes (features) get specific content.

**Prerequisite:** run `/lazybrain-graph` first (requires brain-graph.json and hierarchy nodes).

## Pipeline

```
enrich-hierarchy  →  index-rebuild
(fill from convs)    (sync FTS5)
~5s                  ~1s
```

## Step 1: Enrich hierarchy

!`lazybrain enrich-hierarchy --force --pretty 2>/dev/null || echo "[lazybrain: enrich-hierarchy failed]"`

Reads conversation notes for each hierarchy node, classifies content (decisions, bugs, ideas, rules, Q&A, facts) with regex patterns, and rebuilds the HTML with real data. Uses topic-path prefix matching so parent nodes aggregate child content.

## Step 2: Rebuild index (to pick up enriched nodes for search)

!`lazybrain index-rebuild --pretty 2>/dev/null || echo "[lazybrain: index-rebuild failed]"`

Picks up new cross-links and enriched content from the hierarchy nodes.

## Step 3: Report

Read the output and report:
- **Nodes enriched**: how many hierarchy levels got content
- **Sections populated**: decisions, bugs, ideas, rules, qa, facts
- **Conversations scanned**: source data volume

**Wiki ready**: run `lazybrain serve` to browse at http://localhost:4242

## Conditional Sections

Sections only appear when they have content:
- **tldr** (always present)
- **decisions** (if conversations contain choices)
- **bugs** (if conversations contain errors/fixes)
- **ideas** (if conversations contain suggestions)
- **rules** (if conventions detected)
- **facts** (key facts from conversations)
- **qa** (questions/answers detected)
- **children**, **graph**, **see-also**

## Cross-editor

| Editor | How |
|--------|-----|
| Claude Code | `/lazybrain-understand` |
| Others | `lazybrain enrich-hierarchy --force && lazybrain index-rebuild && lazybrain serve` |

## Troubleshooting

- **enrich-hierarchy fails**: ensure `/lazybrain-graph` has run and `brain-graph.json` exists.
- **0 sections populated**: conversation notes may have insufficient content or missing `data-cerveau-topic` attributes.
- **Wiki empty**: run `lazybrain build-hierarchy --force` before `enrich-hierarchy`.
