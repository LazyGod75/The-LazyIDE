# Changelog

All notable changes to Lazy are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.19] - 2026-09-03

### Changed
- **Open-source release**: Lazy is now source-available under FSL-1.1-ALv2. The public repo ships with `cloudConfig.ts` hardcoding the public Supabase URL + anon key, so anyone who clones can sign up for a Lazy account and subscribe to LazyPro out of the box — no env setup needed. Server secrets (Stripe, service-role, OpenRouter, R2, signing) stay private.
- **One-command setup**: `npm start` installs deps, builds the LazyBrain engine, and launches the desktop app. `npm run setup` does the same without launching.
- **README rewritten** in English + French with screenshots for each space.
- **Export script cleaned**: no SQL, no `supabase/`, no internal docs, no scratch/bench ad-hoc scripts, no `.env.example`, no `OPENSOURCE.md`. Only the app + engine + tests + public docs ship.

### Removed
- `.env.example` — Cloud is pre-configured in `cloudConfig.ts`, no env setup needed for users.
- `OPENSOURCE.md` — merged into README.

## [0.1.18] - 2026-08-24

### Fixed
- **Cockpit mode toggle could not switch back from Command to Construction**: the toggle broadcast `cockpit:modeChange` from inside React's state updater, and the synchronous bus re-entry (StrictMode invokes updaters twice) silently dropped the state change — the rail icon or the `C` shortcut could enter Command mode but never leave it until reload. The bus event now fires outside the updater, so toggling works in both directions.
- **Cross-project extra readable roots on Windows**: the mission extra-root gate now asserts against the same normalized form the validator returns. On Windows `Path::canonicalize()` always hands back a verbatim `\\?\`-prefixed path, so a registered project root that legitimately passed the containment check was still being compared to its raw verbatim form and failed the assertion. The containment check itself (`ensure_repo_in_project_root`) already strips the prefix on both sides, so this is a validation/test-boundary alignment — the Windows CI test no longer fails.

## [0.1.17] - 2026-08-15

### Added
- **Rename LazyManager conversations**: double-click a tab to rename it; the tab strip's native scrollbar is replaced with VS Code-style scroll chevrons that never let the "+" button scroll out of view
- **See what you're approving**: the persistent approval bar now shows each pending action's type and argument (expandable to the full text) instead of just a bare count
- **Multiple Code-space terminals**: a tab switcher lets several terminal sessions run side by side, and a new session now spawns in the active project's own directory instead of the app's launch directory
- **Brain memory-health details**: a read-only "view details" action lists exactly what orphans, broken links and duplicates each count refers to, without mutating the brain — the destructive repair step is still a follow-up

### Fixed
- **Agent harness reliability**: file edits (`edit_file`/`multi_edit`/`write_file`) now travel through a SEARCH/REPLACE protocol instead of JSON-string-encoded content, removing the root cause of a class of parse failures that could burn real credits and produce no diff; a near-miss edit is now matched through a fallback cascade (indentation-normalized, then blank-line-stripped) instead of being rejected outright; a syntax check now rejects a broken edit before it ever reaches disk; and a new stuck-loop detector aborts a mission that keeps repeating the same failing action instead of exhausting its full retry budget
- **The judge no longer penalizes correct non-code work**: a mission's reviewer/security/judge now grade a deliverable against the mission's own stated objective instead of a code-quality rubric — a correct one-line text file was previously scored 15/100 and blocked
- **A committed deliverable is no longer reported as failed**: a mission whose evaluation step was merely interrupted now stays reviewable with its real, already-committed work intact instead of being discarded as a bare "failed"; every failure signal now shows its actual reason instead of none at all
- **"Stoppe tout" and rail switching now really stop billing**: both now abort the in-flight model request itself, not just the next turn, and a still-queued (not yet running) mission is stopped too
- **Merge blocks explain themselves**: the real reason (worktree missing, no judge verdict, project not open, …) is now shown instead of a bare "Bloquée" chip, duplicate approval retries for the same stuck mission stop piling up, and an already-merged mission no longer keeps re-reporting as blocked
- **Canvas**: a plan's draft/join nodes now stay inside their own project zone instead of overflowing into a neighbor's (the fan-in convergence node was the one most likely to escape); whole-canvas "Fit view" no longer collapses to an unreadable zoom because of a stray Transverse-zone position; plan-preview node boxes are shrunk to match their actual content instead of rendering mostly empty fill
- **Brain**: cluster labels are capped in length and drawn on an opaque backing plaque instead of sprawling illegibly across dense graphs; neuron titles no longer leak raw or mid-tag-truncated HTML carried over from the source prompt; query/inject telemetry is actually recorded now (it was hardcoded off), so Settings > Memory stops showing "Queries 0"; the path-override badge no longer contradicts the scope tabs next to it
- **Code space**: breadcrumbs are project-relative instead of the full absolute path (and no longer render a literal "?" from an unstripped Windows path prefix); that same `\\?\` verbatim-prefix leak is fixed at its source across Settings Health, canvas paths and editor/registry lookups, with a lint rule added to catch the next recurrence
- **i18n**: plural agreement is now correct across Brain, Cockpit and the approval bar instead of a hardcoded English plural; several previously-hardcoded strings are translated; an internal method reference and workstream codename ("platform.health()", "PLATFORM-C") no longer leak into the Settings > Health error message
- **Command palette**: file rows show a project-relative path instead of the full absolute path, navigation rows use the app's own drawn icons instead of a mix of emoji and glyphs, and redundant one-word hints that duplicated the kind badge are removed
- **Decisions badge and panel share one source**: the rail badge count and the popover's list can no longer disagree; other Cockpit rail popovers (Budget, KPIs, Fleet Map, Provisioning, Custom Rules) are capped to the visible viewport instead of rendering past it, and stray currency formatting on credit figures is fixed
- **Custom Rules panel**: raw-JSON authoring now validates live, disables Save while invalid, shows an explicit saved/unsaved indicator, and gained an Import action to match Export
- **Settings > Health**: the Git check now targets the active project's root instead of the app's own working directory, so a healthy repo no longer reports as down
- The manager chat no longer renders a raw `<artifact>` result envelope verbatim when one leaks through
- A missing optional project state file no longer logs a spurious warning on non-English Windows installs, where the OS's own "file not found" message wasn't recognized
- The memory-pressure indicator no longer floats over Brain's cluster filter or the Cockpit footer, and a stuck git-status check now times out instead of leaving a project row stuck on "…" forever

### Changed
- `npm run build` restored after a chunk-splitting regression (elkjs pinned into its own manual chunk)

## [0.1.16] - 2026-08-12

Covers everything since 0.1.14. The `v0.1.15` tag was cut without a version bump or a
changelog entry, so its content is folded in here.

### Added
- **Rules and Skills are now Brain tabs**: both panels are mounted in the Brain space instead of living in a side surface, and their remaining hardcoded French strings are translated
- **Slash commands in the assistant composer**: the command palette is wired into the composer, so a command can be picked without leaving the keyboard
- **Peek Definition (Alt+F12)** in the editor, and a **live cursor position** in the code status bar
- **Fork from a checkpoint**: a mission can be forked from any checkpoint straight from its detail view
- **Scheduled runs announce themselves**: a notification fires when a scheduled agent run starts, instead of the run appearing silently
- **Team cockpit KPIs** surface in the org Lead view; the curated brain promotion pipeline can be triggered by hand
- **Risk badge and "send an agent"** in the diff drawer, so a risky change can be handed to an agent from where you read it

### Fixed
- **Chained missions were silently inert**: the reactive chain runner never resolved routers and never fired join fan-ins, so router and join nodes did nothing at all. Both are restored, along with the cascade-depth guard, pinned context on the fire path, and a unified startup/project-switch reconciliation
- **Colleagues' usage was readable by any org member**: `org-list` returned every member's nominative usage — events, cost, tokens, last activity — to anyone in the org. Members and viewers now get their own row only. *This fix needs the edge function redeployed to take effect in production*
- **The manager leaked its own internals into the chat**: a malformed action envelope was printed to the user as raw JSON with a stray `</lazy_actions>` tag; action chips truncated a path into a different, plausible-looking directory (`…\cerveau\scratchpad\uc-smoke` shown as `…\cerveau`) with no truncation marker
- **The canvas showed the wrong set of projects**: four concurrent registry reads each wrote whatever came back, so the last response to arrive won rather than the newest. Opening a project could leave its zone missing for seconds, and another project could vanish. Reads are now ordered, and stale responses are dropped
- **A freshly opened project was refused by its own security guard**: on Windows, `canonicalize()` returns a `\\?\`-prefixed path while the compared key had the prefix stripped, so the check for a not-yet-created file could never match — reported to the user as "outside every registered project root"
- **The app froze while reading its own journal**: `journal_query_events` ran on the main thread, so a slow read stalled every other call in the app; a "what's new since" query also had no index and scanned the whole table (549 ms on a 22.6k-row journal). The query moved off the main thread and got its index
- **Requests were capped and mis-priced**: SSRF guard applied to `mcp_sse_call`, scheduler and codex prompts delivered over stdin instead of the command line, permission files and LLM reviewer output validated before being trusted, and hardcoded test credentials removed from the QA scripts
- **Stale-response races** in the command palette, the brain controls search and the global feed poller no longer overwrite fresh results
- **Accessibility**: focus is trapped in seven modal dialogs, clickable zones in settings and code are reachable by keyboard, icon-only buttons are labelled, and `prefers-reduced-motion` is respected across the app

### Changed
- `strictNullChecks` is enabled for the app TypeScript project
- Large Rust modules split into focused submodules (agent commands, git commands, brain config and sidecar); dead code, superseded components and orphaned translation keys removed
- **The test suite stopped failing at random**: worker RPC timeouts came from vitest relaying every intercepted `console.*` over the same channel as its module transforms. Console interception is off; the full suite went from a rotating handful of failures to green, and from ~580 s to ~307 s

## [0.1.14] - 2026-08-09

### Fixed
- **The model picker offered models the backend refused**: the in-app catalogue and the ai-proxy allowlist had drifted apart, so choosing one of the newest models returned `400 invalid_model`. Both were rebuilt against the live OpenRouter catalogue and now describe the same 20 verified models — 10 providers, from Qwen3.7 Flash to Claude Opus 5 — with a test that fails the build if they ever diverge again. Eight of the previously listed models did not exist at all and could never have run
- **Wrong prices on three models** inflated the credit reservation taken before a request, which could refuse a launch for "no credits" on a balance that was in fact sufficient. Billing itself was never affected: it has always used the cost reported by the provider
- **Output length was capped at 8k tokens for every model**, regardless of what the model supports. Each model now carries its real ceiling — up to 64k on the top tier — and a request can ask for a longer answer when it needs one
- **Garbled accents in the interface**: nine files had been saved in the wrong encoding, so the Rules panel tabs and the mission timeline displayed text like "GÃ©nÃ©ral" instead of "Général"

### Added
- **Concurrent LazyManager conversations**: Multiple manager conversations can run side by side, each with its own mission flow, tabs and history — open conversations are restored on restart
- **Attention inbox**: The manager exposes an attention-inbox aggregation seam so pending decisions surface in one place
- **Plan steps choose their branch**: A plan step can declare the git branch its worktree starts from; chained steps and sub-agents inherit their dependency's branch instead of restarting from an empty main
- **Retry with a corrected task**: Retrying a mission can carry a corrected task description instead of forcing a full clone
- **Open-project action**: The manager can open a project through a dedicated action, with guards against launching missions in the wrong context
- **Unified plan rendering**: The in-chat plan preview and the canvas graph share the same visual language — real labels, dependency warnings, join-group grouping, no layout jump
- **Comparative benchmarks**: `docs/BENCHMARKS-2026.md` — Lazy harness vs published IDE scores on DeepSeek V4 Flash: +24 pts orchestrated vs solo on SWE-style tasks, 95.1% on the full HumanEval, recall@3 = 100% with 76% token savings
- **Cursor/Windsurf-style approval UX**: while actions await approval, a persistent Accept/Reject bar stays pinned above the chat (one-click accept/reject of everything) — the transcript card keeps the per-action detail; the redundant "requires approval" system message is gone from the thread

### Fixed
- **Auto-merge blocked by "score indisponible"** (real-user test, mission M4): `auto_green` now auto-merges a REAL non-empty deliverable whose evaluation was technically unavailable (`scoreUnavailable`) — an evaluator-rail failure, never a code rejection; an empty deliverable or a conclusive rejection still asks the human
- **Approval-mode vocabulary aligned with the real modes**: the project badge now reads `Merge : manuel / auto / lazy` (`manual` = you validate, `auto` = accepts intelligently incl. the unavailable-verdict floor, `lazy` = accepts everything, safety floor kept)
- **Mission queue no longer starves or loses work**: Queued missions relaunch on boot and self-heal the durable queue file — in every open project, not just the active one
- **Approval honesty**: Legacy missions stuck on `humanApprove:true` are migrated and unblocked; default contracts no longer hardcode it; doomed retry approvals are refused at the source
- **Canvas crashes**: NodeRef collisions made impossible by construction; NaN gap in declutter; infinite render loop when persisting positions; re-home false positives neutralized (opt-in, path-only match); proposed plans get a real lifecycle on the correct project
- **Agent robustness**: Empty-deliverable missions no longer collect judge approvals; missions no longer review incomplete diffs; runaway loop iterations stopped; `baseBranch` changes on retry refused instead of silently ignored; individual launches inherit the base branch
- **Preview hardening**: `start_preview` guarded against the unguarded self-origin path
- **Brain memory bound**: The dream-ingestion memory-bound fix (6 MiB cap per conversation, concurrency throttled by free RAM) is ported into the vendored engine
- **Plan-preview layout**: Moved off the main thread, with watchdog recovery against stuck cache entries and worker crashes
- **CI**: The remaining 9 ESLint errors are resolved

## [0.1.12] - 2026-07-29

### Added
- **Mission charter**: Before building anything, the manager turns a vague request into a written charter — what the mission is, the decisions it needs from you with a recommended answer and the reasoning behind it, what has to be validated before going further, and how to stop it. Every decision accepts a free-text answer instead of the offered options
- **See the plan before it exists**: Any agent graph of three steps or more is drawn in the chat first, with its agents, estimated cost and duration, so you can validate, adjust or reject it before a single agent starts
- **See what you are asked to approve**: Proposed designs and templates now render visually in the chat and on the canvas, in several variants, at a readable scale — with the chosen one frozen as the reference the recurring work then follows
- **Trial, validated, autonomous**: Recurring work starts in trial mode under supervision, and only earns the right to run on its own once you have validated it
- **Web publishing without an API**: Agents can drive a real browser through recorded recipes and stop before any irreversible step, with the evidence filed next to the agents that produced it

### Changed
- **Measure before sizing**: The manager inspects the project and the brain before deciding how many agents a job needs, instead of reaching for a familiar shape
- **The brain first**: Removed an automatic memory lookup that ran on every single turn, cost time and returned noise; the manager now queries its memory when it decides it needs to, and says so

### Fixed
- **The screen no longer claims more than the system did**: Validating a charter, accepting a plan, approving an action or retrying a mission each now wait for the real outcome. A refusal shows the actual reason and stays actionable instead of displaying as a success
- **Pending approvals survive a restart**: They were held in memory only, so every crash silently dropped them and replayed failed actions as successes
- **Cleanup says what it does not cover**: The manager no longer promises to archive missions its action would skip, and announces exact counts
- **The mission queue no longer starves itself**: A slow evaluation used to hold its slot forever and block every queued mission
- **Memory performance**: Fixed a corpus query that took several minutes on large brains, and cached an index that was being re-read from disk on every call

## [0.1.11] - 2026-07-24

### Added
- **Stacked Claude subscription + Pro credits**: The manager now surfaces both rails and routes each mission to the cheapest capable one, cumulating a Claude subscription with Pro credits
- **Live preview on the canvas**: A `start_preview` manager action launches a dev server through the safe pipeline and shows it running, with the preview linked to its agent and closed when the server stops
- **Content & creative agents**: New content/creative agents, with the full agent library made discoverable to the manager
- **Preview lifecycle under pressure**: Non-attended preview iframes unmount under high memory pressure; dead previews get a TTL and cancelled missions auto-archive

### Changed
- **Manager honesty**: Asks before assuming, fully decomposes content pipelines, and never claims unverified success; internal reasoning and harness text no longer leak into the manager chat

### Fixed
- **Layered crash resilience**: Recovery routing, SEH guard, and a safe mode to survive and recover from crashes
- **Memory & thread hygiene**: Bounded and reclaimed child-process thread lifecycles, capped Codeur chat history (live and persisted), freed archived-mission payloads, auto-closed idle terminals, and shed load under high pressure
- **Worktree hygiene**: Periodic and boot-time orphan sweep for crash-orphaned worktrees, plus auto-clean on archive
- **Performance**: Gate hidden-space git-status polling on the active space only

## [0.1.10] - 2026-07-21

### Added
- **Transformation Tools**: Author a pure JS `(input) => output` function as an agent tool — no allowlist on its logic, safe because it always runs isolated (no filesystem, network, or process access, hard timeout, size-capped output)
- **Reasoning Blocks**: Chain-of-draft, e-traces, FSM steering, manager intervention, monitors, prompt caching, and token saving strategies for agent reasoning
- **Codegraph Enhancements**: File hashing, file watcher, language registry with tree-sitter scanners, token savings tracking
- **MCP Client**: Model Context Protocol client and registry for connecting external tools
- **Browser Controller**: Headless browser automation for agent web tasks
- **Compression**: Caveman compression with preservation rules for token-efficient context
- **Local Model Provider**: Ollama/local LLM support with provider fallback chain
- **Canvas Panels**: Browser panel, floating buttons, library popup, MCP popup, swarm panel, tool activity overlay
- **Manager Persistence & Session Resume**: Persist manager state and resume agent sessions across restarts
- **Skill Injection**: Inject skills into agent prompts dynamically
- **Structural Grep Tool**: Tree-sitter-powered structural search for agents
- **Output Styles**: Configurable assistant output formatting

## [0.1.9] - 2026-07-15

### Added
- **Agent Canvas**: The multi-project agent kanban is replaced by a live canvas — every agent is a node grouped into project zones, with a 5-stop pipeline rail (plan/code/test/review/merged) on each card and semantic zoom from fleet-wide dots to full cards
- **Agent Chaining**: Connect agents so one launches automatically when another completes, with the upstream output injected as context — exactly-once firing that survives restarts, honest cross-project deferral, and per-iteration loop triggers
- **Router Node**: N-way branching between agents — route by outcome, output content, or a default branch
- **Pin Output**: Freeze a completed agent's output on a chain and re-fire downstream agents without re-running the source
- **LazyManager Canvas Control**: The manager can build and drive the whole board from chat — create and chain drafts in a single reply, arrange, focus the camera, annotate, open reports
- **Fleet Replay**: Scrub back through the day and watch the canvas replay itself from the journal — statuses, stages, and chain firings, with live editing safely locked
- **Project Report**: Per-project page gathering everything agents produced — completed missions with their proof artifacts (screenshots, test runs, diffs), merge counts, costs, and durations
- **Run History & Data Inspector**: Per-mission stage Gantt timeline, journal event log, and a structured view of prompts, outputs, and verdicts
- **Canvas Editing Suite**: Drag-and-drop agent palette, Ctrl+K command bar, context menus, sticky notes, multi-select, copy/paste, undo/redo, snap guides, auto-layout, lane mode (kanban lanes inside each zone), search and status filters, dry-run simulation, keyboard shortcuts panel
- **Review Gate v2**: Approve or reject-with-feedback directly on the card — rejection feedback is injected into the automatic retry

## [0.1.8] - 2026-07-06

### Changed
- **Web Tools**: HTML preservation for Brain content processed through web tools

## [0.1.7] - 2026-07-06

### Added
- **Kanban Delete**: Delete button on mission cards in the queued, running, and review columns
- **Pro Badge**: Gold "Pro" badge on the assistant header when a Lazy Pro subscription is active but the current engine is CLI/BYOK rather than managed
- **Model Picker**: Claude Fable 5 added to the Anthropic model catalog

## [0.1.6] - 2026-07-05

### Changed
- Republished as 0.1.6 with no functional changes since 0.1.5 (release/version bump only)

## [0.1.5] - 2026-07-04

### Added
- **Wiki Tab**: Browse your brain like Wikipedia — explore all neurons, connections, and knowledge visually
- **LazyManager Docked Panel**: Right-side collapsible panel for managing your brain and workspace
- **Brain Structural Queries**: Assistant and agents can now query the brain structure (CSS selectors, graph neighbors) to ground their answers
- **Conversation Recall**: Persistent session IDs and per-turn deduplication for coherent, context-aware conversations
- **Contradiction Detection**: Brain warns when a new note contradicts existing knowledge
- **Auto-Project Indexing**: Automatically index opened projects into an empty brain on first launch
- **Multilingual Support**: Full parity across 6 languages (1,135 keys) with proper translations
- **Health Diagnostics**: Stats card showing brain health, embeddings status, and recovery options
- **Brain Transparency**: Publish brain to GitHub directly from the app
- **Real-Time Metrics**: Pro plan usage tracking and refund safety nets

### Changed
- **Honest Empty States**: Clear messaging when stats await queries, PRs are disabled, or the brain is empty
- **Performance Overhaul**: Lazy startup reduced from 7s to 1.7s via async initialization and memoized embedder loading
- **Memory System**: Multilingual embeddings (paraphrase-multilingual-mpnet) with noise penalty for recall accuracy
- **Brain Consolidation**: Automatic maintenance and coherent nudging during conversations
- **Cockpit Reliability**: Evaluator now handles real test runs and doesn't reject valid changes
- **Inline Edit Safety**: Uses non-agentic transform mode; character-boundary-safe truncation prevents corruption

### Fixed
- **Auto-Update Repair**: Fixed update metadata so updates actually install and run correctly
- **External URL Opening**: Checkout and OAuth links now properly open in your browser
- **Windows Path Issues**: Verbatim-safe path handling for managed projects on Windows
- **Brain Recall**: Timeout budget matches embedder cold-start; health badge refreshes after rebuild
- **Agent Missions**: Proper cleanup and restart freeze eliminated on desktop
- **Inline Edit Preserves Newlines**: Multi-cursor support and correct Myers diff implementation
- **Mission Retry & Permissions**: Settings properly forwarded to agent runs

## [0.1.4] - 2026-06-27

### Added
- Pro mission engine with real Claude integration
- Agent-driven evaluator and code review system
- Mission Control with pause/intervene capabilities
- Brain transparency and codex manager

### Fixed
- Gate demo mission seeds to development builds only
