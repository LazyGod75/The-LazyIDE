# Detached Mission Runtime — spec

Founder mandate: "l'app ne doit jamais crash" → a UI crash/close must never
kill a running mission. Today it does, every time, by explicit design (not a
bug — see §1.3). This spec defines `lazy-runnerd`, a sidecar that owns
mission execution independently of the UI process, and a 3-increment path to
get there without a rewrite freeze.

## 1. Current topology (file:line evidence)

### 1.1 Native missions (claude/codex CLI) — the only kind with a real child process
`src/lib/agents/runtime.ts:runMission` → `planAndActLive` (native branch) →
`invoke('agent_run', ...)` (runtime.ts:829) → Tauri command
`agent_run` (`src-tauri/src/commands/agent.rs:284`) → `tokio::task::spawn_blocking`
(agent.rs:324) → `cmd.spawn()` (agent.rs:427), a **direct child process of the
Tauri app itself** (`lazy-ide.exe`), stdout/stderr piped and parsed as
stream-json in the same spawned-blocking task (agent.rs:476-636).

Step/done/error events are pushed back to the renderer via Tauri's
`app.emit()` on `agent://step|done|error/{id}` (agent.rs:516, 545, 570, 612,
625, 677, 691, 700) — a webview-scoped IPC channel that only exists while
that one window is alive. `runtime.ts` (615-762) registers `listen()`
handlers for exactly these three event names **before** firing `agent_run`,
and it is *this renderer-side handler* — not any Rust code — that turns a
step into a durable journal row (`emitBuffered({type:'mission.step',...})`,
runtime.ts:643-703; `spend.tokens` at 729-742). **Consequence: today, mission
progress is only journaled while a renderer is alive to relay it.** If the
window closes, nothing durable is written for whatever was in flight.

Kill is symmetric: `agent_run_kill` (agent.rs:709) tree-kills
(`taskkill /PID <pid> /T /F`, agent.rs:718-723) the tracked pid.

### 1.2 Managed missions (Pro / OpenRouter) — no child process at all
`runMission` routes model-classified managed missions to
`planAndActManaged` (`src/lib/agents/managedAgent.ts:604`), a ReAct loop
(~1660 lines) that runs **entirely as renderer JavaScript**: each turn is an
HTTP `fetch(getAiProxyUrl())` call (`src/lib/models/managedProvider.ts:311,
575`) to a Supabase Edge Function, and each tool call
(read_file/write_file/run_command/...) is a Tauri `invoke()` back into the
same running app (fs.rs/shell.rs commands). There is no separate OS process
to "detach" here — the mission *is* the renderer's call stack. Closing the
window doesn't need to kill anything; the loop simply stops existing.
**This is the harder half of the problem** (see §3, increment b).

### 1.3 What kills what, exactly, and why it's deliberate
`src-tauri/src/lib.rs:run_exit_cleanup` (291-305) is called from both
`WindowEvent::Destroyed` (669-729) and `RunEvent::Exit` (851-867 — added
specifically because `AppHandle::request_restart()` used to skip cleanup
entirely, see 262-290's own doc comment). It calls
`kill_tracked_agent_pids` (agent.rs:745-769), which tree-kills **every**
pid in `AgentPidState` — populated by both `agent_run` (agent.rs:437) *and*
the local cron scheduler `spawn_scheduler` (agent.rs:993, tracks at 1116) —
so a scheduled/unattended mission dies on UI exit exactly like a manually
launched one. The comment at agent.rs:672-676 states the rationale
explicitly: "the OS does not kill child processes just because this process
exits... they survive as orphans... unless killed explicitly here." This is
a real orphan-prevention fix (P42), not negligence — it just means "no
orphans" and "missions survive" have been in tension and orphan-prevention
won. The runner must resolve that tension by *owning* the processes instead
of the UI owning-then-killing them.

### 1.4 An existing, working sidecar pattern to copy: `BrainSidecar`
`src-tauri/src/commands/brain/sidecar.rs` already solves "long-lived daemon,
survives project switches, single-instance, spawned on demand":
- Cross-process single-instance guard: an RAII lock file
  (`SidecarSpawnLock`, sidecar.rs:248-256) plus a pid+port state file per
  profile under `<app_local_data_dir>/lazybrain-sidecars/` (90-120), read by
  the next spawn attempt to tree-kill a stale orphan first
  (`reclaim_stale_sidecar`, 190-206).
- Spawn: `spawn_at` (767-792), plain `Command::spawn`, non-blocking.
- Health check + port-fallback retry, done *outside* the state mutex so it
  never freezes the rest of the app (`start_or_restart_brain_sidecar`,
  919-1014 and its own doc comment 885-918 explaining the earlier freeze bug).
- Stop: tree-kill via `taskkill /T /F` (813-832), matching §1.3's pattern.
- Talks to the UI over local HTTP with a bearer token
  (`brain_port_and_token`, `wait_ready_at`, `brain_fetch_*` proxy commands) —
  the UI never touches the child process directly, only HTTP.

`lazy-runnerd` reuses this pattern wholesale (new profile dir, new port),
not a from-scratch design.

### 1.5 An existing, working catch-up primitive: the journal
`src/lib/journal/journal.ts` + `src-tauri/src/commands/journal.rs`: one
append-only SQLite table (WAL mode, 5s busy_timeout — journal.rs:983-986),
queryable by `sinceSeq`/`sinceMs` (`journalQuery`, journal.ts:226-249;
`JournalQueryFilter`, eventTypes.ts:766-773). This is *already* the
re-attach catch-up mechanism a boot sequence needs — nothing new has to be
invented for "what did I miss", only a writer that doesn't depend on a live
renderer (see §1.1's consequence, and §2's design).

## 2. Target design

**Process**: `lazy-runnerd`, a new Rust binary in the *same Cargo package*
as the Tauri app (`src-tauri/Cargo.toml`'s lib target is already
`crate-type = ["staticlib", "cdylib", "rlib"]` — an `rlib` can be linked by a
second `[[bin]]` target in the same package with zero new crate/workspace
plumbing). Reuses, unmodified where possible:
- `commands::util` (already Tauri-free: `quiet_command`, `resolve_cli_program`,
  `tree_kill_args`, `spawn_stderr_tail`).
- `commands::journal`'s schema (`init_journal_schema`) and insert logic,
  called directly against its own `rusqlite::Connection` to the *same*
  `<app_local_data_dir>/journal.db` file. WAL + busy_timeout(5000) already
  makes two writers safe (journal.rs:983-986) — no protocol needed, just
  open a second connection.
- `sidecar.rs`'s single-instance lock/state-file guard, generalized (it's
  already brain-path-parametrized; add a second profile kind) or duplicated
  once and reconciled later — either is fine for increment (a).

**What moves into it**: the `cmd.spawn()` + stream-json parse loop
(agent.rs:337-636), extracted into a Tauri-free function — today it takes
`tauri::AppHandle`/`tauri::State` only to call `app.emit(...)` and read
`AgentPidState`/`ProjectState`; both become plain parameters (an
`FnMut(RunnerEvent)` callback and an `Arc<Mutex<HashMap<String,u32>>>`,
which is all `AgentPidState` already is). `agent_run`'s Tauri command
becomes a thin wrapper around that same function — behavior for any caller
not yet opted into the runner is byte-identical.

**Interface**: local HTTP, 127.0.0.1-only, bearer token — same shape as
brain's `brain_fetch_*` proxies, not a new pattern:
- `POST /missions` — launch (same fields as `AgentRunRequest`, agent.rs:25-57)
- `POST /missions/:id/kill`
- `POST /missions/:id/intervene` (managed-loop only, increment b)
- `GET /missions` — ids currently owned + each one's last emitted journal `seq`
- `GET /health` — pid, port, uptime (mirrors brain's `get_brain_connection`)

Suggested crate: `tiny_http` (blocking, no async-runtime entanglement) —
matches this codebase's stated "keep deps minimal" convention
(sidecar.rs:241's comment on avoiding a third-party lock crate for the same
reason).

**Re-attach handshake** (built almost entirely on §1.5, not new machinery):
1. UI boot calls a new `runner_status` Tauri command → HTTP `GET /health`.
   If up: `GET /missions` → list of `{id, lastSeq}` still live.
2. For each id also present in the UI's own persisted mission list
   (`missions_current` projection, `src/lib/journal/missionsProjection.ts`),
   call the **existing** `journalQuery({missionId, sinceSeq: lastKnownSeq})`
   to backfill whatever happened while no UI was attached.
3. Re-subscribe: since Tauri's `listen()` event bus cannot cross a process
   boundary, live updates after re-attach come from polling
   `GET /missions` (cheap, low-frequency) or a long-poll/SSE endpoint on the
   runner — either works; SSE avoids poll latency but is not required for a
   correct increment (a)/(b), only for UI snappiness, and can be added
   opportunistically.
4. A mission id the runner reports that the UI's persisted list does NOT
   know about (UI stopped fully, then relaunched with no local state — e.g.
   after `.lazy` state loss) is surfaced as-is from the journal snapshot —
   the journal is the source of truth for "what happened", the UI's own
   Mission list is a cache of it, matching `missionsProjection.ts`'s
   existing "boot the mission list FROM THE JOURNAL" design
   (eventTypes.ts:56-58's own comment on `MissionCreatedPayload.mission`).

**Key correction this design makes vs. today**: journal writes for
mission.*/tool.*/spend.* move from the renderer's `listen()` handler
(runtime.ts:643-703, see §1.1) to the runner itself, writing directly to
journal.db. This is required, not optional — otherwise re-attach has
nothing to catch up on for whatever ran while the UI was down.

## 3. Migration path — 3 increments, each independently shippable

### (a) Runner skeleton + ONE mission type, behind a flag
- **Scope**: native `"claude"` tool only (not codex, not managed). Flag
  (e.g. `LAZY_RUNNER=1` env or a settings toggle) picked up by
  `planAndActLive`; default OFF changes nothing for any existing user.
- **New files**: `src-tauri/src/bin/lazy_runnerd.rs` (entrypoint);
  `src-tauri/src/runner/{mod,server,singleinstance}.rs`.
- **Modified**: `agent.rs` (extract the Tauri-free core, ~380 lines moved/
  refactored, existing unit tests at agent.rs:1723-2075 must still pass
  unchanged against the thin wrapper — that's the regression guard);
  `lib.rs` (register `runner_ensure_started`/`runner_port` commands; teach
  `run_exit_cleanup` to skip pids the runner now owns — a small allowlist
  check, not a structural change yet since only one mission type is routed);
  `runtime.ts` (new branch in `planAndActLive`: HTTP POST instead of
  `invoke('agent_run')`, poll/SSE instead of `listen()`, when the flag is on).
- **Blast radius**: ~4 new Rust files (~400-600 LOC), ~3 modified files,
  ~80-150 LOC in runtime.ts. **Risk: low** — flag-gated, and the unflagged
  path is provably unchanged (same function, same call site, extra
  indirection only).

### (b) All mission types + re-attach
- **Adds codex**: near-free — the extracted core already branches on `tool`
  (agent.rs:337 vs 407); just route the codex branch through the same path.
- **Adds managed missions — the expensive part.** Two options, name both
  honestly rather than picking silently:
  - **b1, full port**: rewrite `managedAgent.ts`'s ReAct loop (~1660 lines:
    prompt composition, tool dispatch, pause/intervene polling, PRM/
    Reflexion instrumentation, dedup) in Rust inside the runner. Highest
    fidelity, highest risk — this is a genuine rewrite of tuned agent logic,
    not an extraction. Needs golden-transcript tests (fixed fixture
    missions, compare old-TS-loop output to new-Rust-loop output turn by
    turn) before it can be trusted, and should probably be its own sub-wave.
  - **b2, relocate-not-rewrite (recommended default)**: the runner spawns a
    headless Node process per managed mission and treats it as just another
    child (same track/kill mechanics as native), and `managedAgent.ts` runs
    inside *that* process almost unchanged — only its I/O boundary swaps
    (Tauri `invoke()` for file/shell ops → direct Node `fs`/`child_process`
    calls; `fetch()` to ai-proxy is unchanged, it already works from any
    Node/browser context). Far less regression risk than b1; evaluate b2
    first and only fall back to b1 if the Node-host boundary proves
    unworkable (e.g. a tool needs something only reachable through Tauri).
- **Re-attach**: implement §2's handshake — runner becomes the journal
  writer for anything it owns; UI boot gains a reconciliation pass (extend
  wherever `missionsProjection.ts`'s boot hydration currently runs).
- **Blast radius**: `runner/*.rs` grows substantially (managed-loop plumbing
  either way); `agentsStore.tsx` boot sequence gains the reconciliation
  step; `runtime.ts`'s managed dispatch (the `planAndActManaged` call site)
  gets the same HTTP-instead-of-invoke treatment increment (a) gave native.
  **Risk: high for b1 (rewrite parity), medium for b2 (new process-boundary
  bugs — same class as the stdin/argv CVE-2024-24576 issue agent.rs already
  hit once, agent.rs:328-330, will recur in a new form for a Node host).**
  This is the increment where "missions survive UI death" becomes true for
  100% of mission types, not just native ones — treat it as the real
  milestone, not (a).

### (c) Remove the in-process path
- `agent_run`/`agent_run_kill` (agent.rs) stop spawning locally and become
  permanent thin proxies to the runner's HTTP endpoints (no need to delete
  the Tauri command *names* — `runtime.ts` still calls them by name; only
  their body changes). Delete the now-dead ~380-line in-process spawn body.
- `kill_tracked_agent_pids`'s agent-pid branch (agent.rs:745-769) is
  deleted/narrowed to non-mission pids only (maintenance, teams sidecar) —
  the runner is never killed by UI exit, that's the entire point.
- `managedAgent.ts` either deletes its renderer copy (b1 shipped) or the
  file *moves* to run inside the Node host (b2 shipped) — either way zero
  mission-loop code remains in the renderer bundle.
- Delete the `agent://step|done|error/*` Tauri event names — grep the
  frontend for `agent://` before deleting (today: exactly `runtime.ts`'s
  `stepEventName`/`doneEventName`/`errorEventName` construction, agent.rs's
  own event names on the Rust side — re-check at execution time since (a)
  and (b) will have touched this file further).
- **Blast radius**: mostly deletion once (a)+(b) are proven in production
  for a full release cycle. **Risk: medium** — the only real hazard is a
  caller nobody remembered still expecting the old event names or the old
  synchronous-spawn semantics of `agent_run`.

## 4. What does NOT move, and why

| Stays UI-side | Why |
|---|---|
| Manager chat turns (`chat.rs::claude_chat_stream`, `managerEngine.ts`) | Interactive, one request/response tied to a live human reading the answer *right now* — there is no headless value in a chat turn nobody is present to read. |
| Canvas rendering, mission cards, kanban layout | Pure presentation; reads FROM journal projections, never owns execution state — nothing to detach. |
| Interactive terminal (`terminal.rs`'s PTY spawn/kill) | A live, bidirectional, human-typed session — closing the UI *should* kill it, same as closing a real terminal window. Also explicitly out of scope: a concurrent fixer owns terminal spawn error paths right now. |
| Brain sidecar itself | Already detached-shaped but *deliberately* still tree-killed on UI exit (`stop_brain_sidecar_for_exit`) — a memory index has no "mission" to keep running for. No change proposed. |
| Scheduler pool bookkeeping / fleet hygiene (`scheduler.ts`, `fleetHygiene.ts`) | Cheap-to-recompute launch-admission policy ("should I start a NEW mission"), never owns an in-flight one. Can stay UI-side even after (b) — the runner independently accepts/rejects launches. Headless-launch (cron missions launching with no UI open at all) is a natural follow-up once the runner exists, but is out of this spec's scope. |

**Explicitly excluded from any proposed edit** (per current task boundary):
`fleetHygiene.ts`, `devPreview.ts`, `AppContext.tsx`, and terminal spawn
error paths — owned by a concurrent fixer.
