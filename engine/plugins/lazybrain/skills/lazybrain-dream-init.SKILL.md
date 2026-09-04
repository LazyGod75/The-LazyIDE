---
name: lazybrain-dream-init
description: Initialize the brain from all past Claude Code conversations. Dispatches Haiku agents per project for deep exhaustive extraction using all HTML tags. Run once on first install or after brain reset.
allowed-tools: [Bash, Read, Agent, PowerShell, Write]
disabled-model-invocation: false
---

# LazyBrain Dream Init

Build an EXHAUSTIVE brain from ALL past conversations. Every feature, every decision, every bug, every table, every flow — nothing forgotten.

## Step 1: Resolve paths

```powershell
# Brain path
Get-ChildItem "$env:USERPROFILE\Documents" -Directory -Filter "Lazy-Brain*" -ErrorAction SilentlyContinue | ForEach-Object { if (Test-Path "$($_.FullName)\brain") { "BRAIN: $($_.FullName)\brain" } }
# Engine path
(Get-Command lazybrain -ErrorAction SilentlyContinue).Source
```

If no brain: `mkdir -p ~/Documents/Lazy-Brain/brain/notes`

## Step 2: Discover and plan

```powershell
Get-ChildItem "$env:USERPROFILE\.claude\projects" -Directory | ForEach-Object { $files = Get-ChildItem $_.FullName -File -Filter "*.jsonl" -ErrorAction SilentlyContinue; if ($files.Count -gt 0) { "$($_.Name): $($files.Count) files, $([math]::Round(($files | Measure-Object Length -Sum).Sum / 1KB)) KB" } } | Sort-Object { [int](($_ -split ', ')[1] -replace '[^\d]','') } -Descending
```

By default, the engine's own project (`cerveau`/`LazyBrain`) is skipped to avoid self-referential noise. Set `LAZYBRAIN_DREAM_INCLUDE_SELF=1` to include it (dogfood/demo use case).

For observer-sessions (1000+ files): dispatch 2-3 agents by file rank batches.

## Step 3: Dispatch agents

ONE Haiku agent per directory, all in parallel. The agent prompt MUST use this EXACT template with ALL placeholders filled:

```
You are building an EXHAUSTIVE LazyBrain brain for the PROJECT_NAME project. Your goal: capture EVERYTHING — features, architecture, data, bugs, decisions, tips, anti-patterns, user flows, file paths, configs.

ABSOLUTE RULES:
1. You MUST execute the store command for EACH note — unstored notes are WORTHLESS
2. Focus on PROJECT_NAME: KEYWORD_LIST
3. Create at least MIN_NOTES notes
4. Read ALL conversation files (list by size, read beginning+middle+end ~200 lines each)
5. EVERY note must use the FULL HTML template below with ALL relevant sections

Directory: CONV_DIR
JSONL: {"type":"user","message":{"role":"user","content":"..."}} and {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}]}}

WHAT TO EXTRACT (exhaustive list):
- USER-FACING FEATURES: what does each user type see and do? List every screen, every flow
- ARCHITECTURE: tech stack, file structure, entry points, routing
- DATA MODEL: database tables, columns, relationships, schemas
- DECISIONS & REASONING: choices made AND why (alternatives considered)
- BUGS & INCIDENTS: what broke, root cause, how it was fixed
- ANTI-PATTERNS: things to never do again, gotchas, traps
- BEST PRACTICES: tips, patterns that work, recommendations
- CURRENT STATE: what's done, what's pending, last session summary
- CONFIGS & ENVIRONMENT: env vars, API keys (names not values), ports, URLs
- COMPARISONS: features vs competitors, before/after, option A vs B

NOTE CATEGORIES TO CREATE:
1. "Project Overview" note: what the project IS, who uses it, main features list
2. One note per MAJOR FEATURE (not per code component — per user-facing capability)
3. "Data Model" note: all tables, key columns, relationships
4. "Architecture" note: tech stack, file structure, deployment
5. "Decisions" notes: each major decision with reasoning
6. "Bugs & Lessons" note: bugs encountered, fixes, lessons learned
7. "Current State" note: what's done, what's pending, blockers

FULL HTML TEMPLATE — use ALL sections and elements that apply:

# Encoding fix: PowerShell 5.1 defaults to UTF-16 LE which mangles French accents.
# Set console + output encoding to UTF-8 BEFORE piping HTML to the store command.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$env:LAZYBRAIN_BRAIN_PATH = "BRAIN_PATH"
@'
<article data-cerveau-type="TYPE" data-cerveau-tags="PROJECT TAGS" data-cerveau-importance="0.85" data-cerveau-topic="TOPIC/SUBTOPIC" data-cerveau-status="active">
  <section data-section="tldr">
    <p>One SPECIFIC sentence with real details (names, versions, counts, dates)</p>
  </section>

  <section data-section="summary">
    <h2>Descriptive Title</h2>
    <p>Detailed description. Include <data value="src/path/file.ts">file.ts</data>, component names, <mark>critical details highlighted</mark>.</p>
    <p>Second paragraph with more context, history, current state.</p>
  </section>

  <section data-section="facts">
    <p data-cerveau-fact data-cerveau-confidence="0.95">Specific verifiable fact with real data</p>
    <p data-cerveau-fact data-cerveau-confidence="0.90">Another fact — file paths, numbers, versions</p>
    <p data-cerveau-fact data-cerveau-confidence="0.85">Third fact</p>
  </section>

  <section data-section="reasoning">
    <p>WHY this decision was made. What alternatives were considered. What trade-offs.</p>
    <blockquote>Direct quote from conversation if relevant</blockquote>
  </section>

  <section data-section="errors">
    <p><strong>Bug:</strong> Description of the bug</p>
    <p><strong>Root cause:</strong> What caused it</p>
    <p><strong>Fix:</strong> <code>the fix applied</code></p>
  </section>

  <section data-section="api">
    <dl>
      <dt>GET /api/endpoint</dt><dd>Returns list of items</dd>
      <dt>POST /api/action</dt><dd>Creates new item</dd>
    </dl>
  </section>

  <section data-section="config">
    <dl>
      <dt><var>DATABASE_URL</var></dt><dd>Supabase connection string</dd>
      <dt><var>STRIPE_SECRET_KEY</var></dt><dd>Stripe API key (env only, never hardcode)</dd>
    </dl>
  </section>

  <section data-section="dependencies">
    <ul>
      <li>Library <kbd>npm install package@version</kbd></li>
      <li>Depends on: <a href="#other-note-id" data-cerveau-link-type="follows-from">Other System</a></li>
    </ul>
  </section>

  <table>
    <thead><tr><th>Feature/Item</th><th>Status</th><th>Details</th></tr></thead>
    <tbody>
      <tr><td>Feature name</td><td>done/pending/blocked</td><td>Specifics</td></tr>
    </tbody>
  </table>

  <section data-section="references">
    <data value="src/path/to/file.ts">file.ts</data>,
    <data value="src/other/file.tsx">file.tsx</data>
  </section>

  <aside role="doc-warning">DANGER: thing to NEVER do, anti-pattern, gotcha, trap</aside>
  <aside role="doc-tip">TIP: best practice, recommendation, shortcut, thing to remember</aside>
  <aside role="doc-errata">CORRECTION: something previously believed wrong, now corrected</aside>
</article>
'@ | npx tsx "ENGINE_PATH/bin/lazybrain.ts" store --pretty

TYPES:
- "reference" = architecture, stack, data model, feature catalog, API docs
- "decision" = choice made with reasoning (MUST have reasoning section)
- "episodic" = bug, incident, lesson learned (MUST have errors section)
- "procedural" = workflow, deployment, how-to steps

HTML ELEMENTS CHEAT SHEET (use them ALL where applicable):
- <table> — feature lists, comparisons, status tracking, config values, data schemas
- <aside role="doc-warning"> — anti-patterns, gotchas, dangers, things to NEVER do
- <aside role="doc-tip"> — best practices, shortcuts, things to remember
- <aside role="doc-errata"> — corrections to previous beliefs
- <section data-section="reasoning"> — WHY behind decisions, trade-offs
- <section data-section="errors"> — bugs with root cause and fix
- <section data-section="api"> — endpoints, routes with <dl>/<dt>/<dd>
- <section data-section="config"> — env vars with <dl>/<dt>/<dd> and <var>
- <section data-section="dependencies"> — tech deps with <kbd> for install commands
- <section data-section="references"> — file paths with <data value="path">name</data>
- <data value="full/path">short name</data> — EVERY file path mentioned
- <code> — inline code, function names, command fragments
- <kbd> — CLI commands (npm install, git clone, etc.)
- <var> — environment variables ($DATABASE_URL, etc.)
- <mark> — highlight CRITICAL info within text
- <blockquote> — verbatim quotes from conversations, error messages
- <time datetime="2026-05-20"> — specific dates for events, deadlines
- <dl>/<dt>/<dd> — definition lists for API endpoints, configs, glossaries
- <progress value="0.7" max="1"> — feature/task completion status
- data-cerveau-status="active|deprecated|experimental" — on features
- data-cerveau-priority="critical|high|medium|low" — on bugs/tasks

QUALITY TEST: "3 features of the mobile app for athletes" must be answerable. "What Supabase tables exist?" must be answerable. "What bugs were fixed?" must be answerable. If a user asks ANYTHING about the project, your notes must have the answer.
```

### Minimum notes:
- \> 50 MB → 25+ notes
- 5-50 MB → 15-20 notes
- 1-5 MB → 8-12 notes
- < 1 MB → 5-8 notes

### Keywords by project type:
- App project → "features, screens, user flow, coach, athlete, workout, nutrition, auth, navigation, notifications, payments, subscription, dashboard, analytics, settings"
- Algo-trading → "backtest, signal, Sharpe, spread, risk, model, training, strategy, execution"
- 3D modeling → "blender, mesh, material, render, texture, lighting, scene, MCP, cycles"
- Marketing → "automation, content, Instagram, pipeline, leads, publishing, analytics, templates"
- Website → "Next.js, pages, blog, SEO, components, design, deployment"

## Step 4: After ALL agents complete

```bash
export LAZYBRAIN_BRAIN_PATH="BRAIN_PATH"
lazybrain index-rebuild
lazybrain dream --synthesize --pretty
lazybrain stats --pretty
lazybrain inject-context --mode highlights --pretty
```

The `dream --synthesize` step generates topic overview pages (one per topic, with tldr, notes table, and see-also links) and a brain-index homepage listing all topics. These are displayed in the wiki SPA when running `lazybrain serve`.

## Step 5: Verify quality

Test that the brain can answer real questions:
```bash
lazybrain search "features athlete mobile app" --top 5 --strip --pretty
lazybrain search "database tables schema" --top 5 --strip --pretty
lazybrain search "bugs fixed recently" --top 5 --strip --pretty
lazybrain query 'aside[role="doc-warning"]' --pretty
lazybrain query 'table' --pretty
```

If results are thin, dispatch MORE agents targeting the weak areas.

## Guidelines

- EXHAUSTIVE: every feature, every table, every decision, every bug
- SPECIFIC: file paths, version numbers, table names, component names — never vague
- USER-FACING: describe what users see and do, not just code internals
- ALL TAGS: use tables, warnings, tips, reasoning, errors, references on every note
- QUALITY TEST: "tell me 3 athlete features" must work from the brain alone
