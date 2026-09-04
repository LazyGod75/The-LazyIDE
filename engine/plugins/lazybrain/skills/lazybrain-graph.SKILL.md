---
name: lazybrain-graph
description: Build the brain's hierarchical knowledge graph. Pipeline: dream → index → graph → build-hierarchy. Run FIRST, then /lazybrain-understand.
allowed-tools: [Bash, PowerShell]
disabled-model-invocation: false
---

# LazyBrain Graph (Hierarchical)

Pipeline:
```
dream --enrich  →  index-rebuild  →  graph --format both  →  build-hierarchy
(read convs)       (sync SQLite)     (build graph JSON)      (create hierarchy nodes)
~30s               ~1s               ~2s                     ~1s
```

## Step 1: Populate brain from conversations

!`lazybrain dream --enrich --pretty 2>/dev/null || echo "[lazybrain: dream failed]"`

This reads Claude Code conversation transcripts from `~/.claude/projects/`. By default the engine's own project (`cerveau`/`LazyBrain`) is skipped; set `LAZYBRAIN_DREAM_INCLUDE_SELF=1` to include it (dogfood/demo). Extracts facts, decisions, bugs, and ideas and stores them as HTML notes with proper `data-cerveau-topic` attributes. Large conversations are automatically split into multiple notes so no context is lost.

## Step 2: Rebuild index

!`lazybrain index-rebuild --pretty 2>/dev/null || echo "[lazybrain: index-rebuild failed]"`

Ensures the SQLite FTS5 index matches the files on disk. Required after dream creates new notes.

## Step 3: Build the knowledge graph

!`lazybrain graph --format both --pretty 2>/dev/null || echo "[lazybrain: graph failed]"`

Builds `brain-graph.json` with nodes, edges, clusters, hubs, layers, tour, and topicTree. Also generates `graph.html` (interactive dashboard) and `graph.txt` (adjacency list).

## Step 4: Build hierarchical knowledge-nodes

!`lazybrain build-hierarchy --force --pretty 2>/dev/null || echo "[lazybrain: build-hierarchy failed]"`

Creates the hierarchical node structure: root → projects → modules → features. Each node is an HTML wiki page with `data-cerveau-topic` path attributes that group related conversation notes.

## Step 5: Report

Read the outputs and report:
- **Conversations processed**: from dream output
- **Notes indexed**: from index-rebuild
- **Nodes/edges/clusters**: from graph
- **Hierarchy**: root + projects + modules + features count

**Next step**: run `/lazybrain-understand` to enrich the hierarchical nodes with conversation content.

## When to re-run

- First time using LazyBrain on a project
- After many new conversations (10+)
- After `/lazybrain-understand` enriches nodes (rebuilds graph with new edges)
- Periodically to track brain evolution

## Cross-editor

| Editor | How |
|--------|-----|
| Claude Code | `/lazybrain-graph` |
| Others | `lazybrain dream --enrich && lazybrain index-rebuild && lazybrain graph --format both --pretty && lazybrain build-hierarchy --force --pretty` |

## Troubleshooting

- **0 notes**: no conversation history found. Check `~/.claude/projects/` has JSONL files. The engine's own project (cerveau/lazybrain) is skipped by default — set `LAZYBRAIN_DREAM_INCLUDE_SELF=1` to include it.
- **dream hangs**: large conversation history (500+ MB). Let it complete — it processes incrementally.
- **index-rebuild fails**: delete `_cache/fts.sqlite` and retry.
- **0 edges**: notes have no `<a href>` cross-links. Run `/lazybrain-understand` to create linked knowledge-nodes.
- **build-hierarchy fails**: run `/lazybrain-graph` first (requires brain-graph.json).
