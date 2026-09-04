/* Platform abstraction — interface for all OS-level capabilities.
   Desktop (Tauri) and Browser (WebPlatform mock) both implement this.
*/

// ── File System ──────────────────────────────────────────────────

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  gitStatus?: 'modified' | 'added' | 'deleted' | 'untracked' | null;
}

export interface FileSystem {
  readDir(path: string): Promise<DirEntry[]>;
  readFile(path: string): Promise<string>;
  /**
   * Reads a file and returns its content base64-encoded — the binary-safe
   * counterpart of `readFile` (which requires valid UTF-8 and fails outright
   * on a real PNG/JPEG screenshot artifact). Optional: the web/Playwright
   * mock has no real filesystem to read binary content from, so callers
   * (artifactImage.ts) must feature-detect and fall back honestly rather
   * than assume this is always present.
   * Tauri: invoke('read_file_base64', { path }).
   */
  readFileBase64?(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  remove(path: string): Promise<void>;
  createFile(path: string): Promise<void>;
  createDir(path: string): Promise<void>;
}

// ── Terminal ─────────────────────────────────────────────────────

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export interface TerminalProcess {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): () => void;
  onExit(cb: (code: number) => void): () => void;
}

export interface Terminal {
  spawn(command: string, args: string[], opts?: SpawnOptions): Promise<TerminalProcess>;
}

// ── Git ──────────────────────────────────────────────────────────

export interface GitFile {
  path: string;
  status: 'M' | 'A' | 'D' | '?';
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  files: GitFile[];
}

export interface GitLogEntry {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

export interface Git {
  status(repoPath: string): Promise<GitStatus>;
  diff(repoPath: string, filePath?: string): Promise<string>;
  commit(repoPath: string, message: string): Promise<void>;
  stage(repoPath: string, paths: string[]): Promise<void>;
  unstage(repoPath: string, paths: string[]): Promise<void>;
  push(repoPath: string): Promise<void>;
  /**
   * Probe whether a `git push` in `repoPath` would have a destination — the
   * honest pre-check the post-merge push path (agentsStore's approveMission ->
   * lib/agents/missionPush.ts) uses before attempting a push, so it can report
   * "pushed" / "skipped: no remote" / "skipped: no upstream" truthfully instead
   * of guessing. Never throws for the two "no destination" outcomes.
   */
  canPush(repoPath: string): Promise<{ hasRemote: boolean; hasUpstream: boolean }>;
  /**
   * Enumerate the app's orphan agent-worktree branches (`agent/*` and the
   * older `M<n>-*-wt` fleet shape), classified by REAL git reachability
   * against the current HEAD: `recoverable` (unmerged work — merge, never
   * delete) vs `empty` (already contained in HEAD — safe to discard). The
   * data backing fleet-hygiene rule (j); resolves to empty lists when there
   * is no real git backend (web/mock).
   */
  orphanWorktrees(repoPath: string): Promise<{
    recoverable: { name: string; headSha: string; containedInTarget: boolean }[];
    empty: { name: string; headSha: string; containedInTarget: boolean }[];
  }>;
  branches(repoPath: string): Promise<string[]>;
  log(repoPath: string, limit?: number): Promise<GitLogEntry[]>;
}

// ── Brain — history import (CONTRACT-G2) ────────────────────────

/**
 * A history source detectable on the current machine.
 * source: canonical key passed to `lazybrain import --source`.
 * available: false when the path does not exist or cannot be read.
 * itemCount: 0 when unavailable or when detection is not yet complete.
 */
export interface HistorySource {
  source: string;
  label: string;
  available: boolean;
  itemCount: number;
  path?: string;
}

/**
 * Cost/time estimate for seeding from a list of sources.
 * Produced by `lazybrain import --dry-run`.
 */
export interface SeedEstimate {
  items: number;
  estTokens: number;
  estMinutes: number;
  /** Human-readable label for the LLM backend that WOULD annotate notes if
   *  useLlm is requested — e.g. "Claude Code CLI", "Anthropic API", or
   *  "heuristic only (no LLM backend detected)". Always present (Rust
   *  resolves it independently of the per-source dry-run calls) — NO SILENT
   *  DEGRADATION: the UI must always be able to say which backend will run. */
  backend?: string;
  /** Whether an LLM backend was actually detected — drives the default
   *  state of the "use LLM" toggle in the seed-from-history UI. */
  llmAvailable?: boolean;
}

/**
 * Progress event emitted by the Tauri 'brain://seed-progress' channel.
 *
 * `phase` values, in the order a successful run emits them:
 *   - 'backend'      — once, only when useLlm was requested (which LLM backend will annotate notes)
 *   - 'import'        — per source, start + done (done/total = sources completed/total sources)
 *   - 'indexing'      — post-import pipeline step 1/5: FTS/semantic index rebuild
 *   - 'synthesizing'  — post-import pipeline step 2/5: wiki brain-index + topic-overview pages
 *   - 'linking'       — post-import pipeline step 3/5: cross-note relationship linking
 *   - 'scoring'       — post-import pipeline step 4/5: brain health score computation
 *   - 'serving'       — post-import pipeline step 5/5: (re)start the brain serve sidecar
 *   - 'done'          — final event; message carries imported/skipped/notesTotal counts
 *   - 'error'         — a source import OR a post-import pipeline step failed (message says which; non-fatal, the run continues)
 *
 * `phase` is kept as a plain `string` (not a literal union) so the backend
 * can evolve phase names without a lockstep type change here.
 */
export interface SeedProgressEvent {
  done: number;
  total: number;
  phase: string;
  message?: string;
}

// ── Brain (LazyBrain sidecar) ────────────────────────────────────

export interface BrainSearchResult {
  id: string;
  title: string;
  snippet: string;
  score: number;
  cluster?: string;
  /** Set when result originates from a specific project brain (multi-scope queries). */
  sourceProject?: string;
}

/**
 * Scope for cross-project brain queries.
 * - 'current': only the active project brain (default behaviour)
 * - 'all': merged results from all configured project brains
 * - { project: string }: only the brain for the given project root path
 */
export type BrainScope = 'current' | 'all' | { project: string };

/**
 * Which retrieval strategy answered a recall — honesty about HOW the
 * injected context was found, not just how much of it there is.
 * See `classifyRecallLevel` (src/lib/brain/context.ts) for how the
 * LazyBrain engine's raw level codes ("L1".."L4", "L2_L3_HYBRID") map to
 * this 3-value classification.
 */
export type RecallLevel = 'semantic' | 'hybrid' | 'keyword';

export interface BrainRecallResult {
  nodes: BrainSearchResult[];
  tokensSaved: number;
  tokensInjected?: number;
  injectedContext: string;
  /**
   * Retrieval strategy for this recall (see `RecallLevel`). Undefined when
   * unknown — e.g. the cold-CLI-subprocess recall fallback has no
   * structured level data, or the web mock brain. Never guessed: a missing
   * value means "we don't know", not "keyword".
   */
  level?: RecallLevel;
  /**
   * True when this recall's zero results are explained by the resolved
   * brain having zero notes (see `BrainInfo.isEmpty` in
   * src/lib/platform/tauri.ts's `get_brain_info`), as opposed to "nothing
   * relevant to this particular query in an otherwise populated brain".
   * Lets the UI show an actionable "configure your brain" message instead
   * of the ambiguous "no relevant neurons found for this scope".
   */
  emptyBrain?: boolean;
}

/** A single node in the 3D graph (mapped from LazyBrain /_api/graph). */
export interface BrainGraphNode {
  id: string;
  title: string;
  type: string;
  /** Visual cluster label (derived from topic or 'unknown'). */
  cluster: string;
  /** Importance 0–1 mapped to visual size (val). */
  importance: number;
  /** Set by brain_fetch_graph_merged: the project root this node originates from. */
  sourceProject?: string;
  /** Space tag from data-cerveau-space: 'topical' | 'code'. */
  space?: 'topical' | 'code';
  /** Topic slug from data-cerveau-topic. */
  topic?: string;
  /**
   * ISO-ish note creation timestamp, when the source graph payload provides
   * one (see engine/src/server/routes/graph.ts's GraphNode.created). Absent
   * on older cached payloads or mock data — brainAdapter falls back to a
   * stable per-id hash bucket in that case (see canvas/dateBucketing.ts).
   */
  created?: string | null;
}

/** A directed edge in the 3D graph. */
export interface BrainGraphEdge {
  source: string;
  target: string;
  type: string;
}

export interface BrainGraphData {
  nodes: BrainGraphNode[];
  edges: BrainGraphEdge[];
}

/** Metadata for a single brain note (from /_api/note-meta/:id). */
export interface BrainNoteMeta {
  id: string;
  title: string;
  type: string;
  topic: string | null;
  tags: string;
  importance: number;
  created: string | null;
  /**
   * Saliency kind from data-cerveau-saliency-kind (e.g. 'contradiction') —
   * the engine's contradiction detector stamps this. Null / absent when the
   * note carries no saliency signal. See engine/src/annotator/saliency.ts.
   */
  saliencyKind?: string | null;
  /**
   * Ids of the notes this note contradicts (data-cerveau-conflict-with,
   * written by engine/src/graph/contradictions.ts). Empty / absent when the
   * note contradicts nothing — powers the wiki view's contradiction warning.
   */
  conflictWith?: string[];
}

// ── Brain wiki (topic hierarchy + synthesized pages) ─────────────

/**
 * A node in the brain's topic hierarchy (from /_api/tree — see
 * engine/src/server/routes/tree.ts's buildTree). One recursive shape covers
 * every depth: projects (type 'project'), modules (type 'aggregate-neuron')
 * and leaf files (their own note type). `noteId` is the brain note backing
 * the node (null only for a synthetic project with no root aggregate);
 * `children` is always present (empty for leaves). Depth is at most 3
 * (project → module → file).
 */
export interface BrainTreeNode {
  id: string;
  label: string;
  noteId: string | null;
  type: string | null;
  children: BrainTreeNode[];
}

/** Top-level shape returned by brain.tree() — GET /_api/tree. */
export interface BrainTree {
  projects: BrainTreeNode[];
}

/**
 * A synthesized topic page linked from the brain-index, parsed from its
 * `<a href="#/{slug}">Title</a>` wiki-section / see-also links.
 */
export interface BrainSynthesisPageRef {
  slug: string;
  title: string;
}

/**
 * The synthesized brain-index page (from /_api/synthesis/index — see
 * engine/src/server/routes/synthesis.ts). `html` is the raw article HTML
 * (rendered sanitized by the Wiki view); `pages` is the list of topic
 * overviews it links to. brain.synthesisIndex() resolves null when no
 * brain-index exists yet (fresh brain, no `dream --synthesize` run) — this
 * drives the Wiki empty state.
 */
export interface BrainSynthesisIndex {
  html: string;
  pages: BrainSynthesisPageRef[];
}

/** Event payload for brain_capture — generic IDE event written as a neuron. */
export interface CaptureEvent {
  kind: 'edit' | 'decision' | 'episodic' | 'agent' | 'commit' | 'learning';
  title: string;
  text: string;
  tags?: string[];
  files?: string[];
  source?: string;
  /**
   * Optional author (display name / email local part of the writing user).
   * Emitted as data-cerveau-author on the article AND on the fact paragraph,
   * so shared (team) neurons know "qui a écrit quoi et quand". Populated
   * automatically by capture.ts's dispatch() from the signed-in Supabase
   * user when absent. Solo captures keep it too — the brain simply records
   * who wrote each fact.
   */
  author?: string;
  authorId?: string;
  orgId?: string;
  /**
   * Optional department scope — emitted as data-cerveau-dept on the article
   * (capture.rs, same pattern as orgId/authorId) so a team brain can be
   * CSS-filtered per department. Stamped by capture.ts's dispatch() and
   * enrichCaptureAuthor() from org_members.dept_id → departments.slug.
   */
  dept?: string;
  itemKind?: 'decision' | 'bug' | 'idea' | 'rule' | 'qa' | 'warning' | 'activity';
  about?: string;
  project?: string;
  /** Optional topic slug — emitted as data-cerveau-topic on the <article>.
   *  When absent, auto-derived from the project root (basename, lowercased). */
  topic?: string;
  /** Optional space classification — emitted as data-cerveau-space on the <article>.
   *  When absent, defaults to "code" for edit/agent kinds. */
  space?: 'topical' | 'code';
  /** Optional working directory — emitted as data-cerveau-cwd on the <article>.
   *  When absent, filled from the open project root (ProjectState). */
  cwd?: string;
  /** Optional structured learning insights — rendered as specialized HTML
   *  elements when kind is "learning". Ignored for other kinds. */
  insights?: InsightPayload[];
  /** When true, and a note with the same id already exists, the engine
   *  upserts instead of conflicting: it replaces the existing note's body
   *  ONLY if this event's text is richer than what's already stored,
   *  preserving the original data-cerveau-created and refreshing
   *  data-cerveau-updated (see engine/src/store/upsert.ts). Used by the
   *  mission-completion capture (learningLoop.ts's captureToBrain) so the
   *  rich completion text is never silently dropped behind the sparse
   *  kickoff note sharing the same title+day id. Absent/false preserves
   *  today's behavior for every other capture kind. */
  upsertIfRicher?: boolean;
  /**
   * Optional deterministic identity for this capture, independent of title
   * and content. When present, capture.rs builds the note's HTML `id`
   * directly from this string (sanitized, no date/random suffix) instead of
   * the title+day+random-suffix scheme every other capture uses. The random
   * suffix exists so ordinary same-day-same-title captures never collide
   * (see capture.rs's own comment on it) — but that same randomness means
   * `upsertIfRicher` can never find "the same note" across two separate
   * capture calls, since the id (and therefore the on-disk path) differs
   * every time. `stableId` is the escape hatch: a caller with a real stable
   * identity — one LazyManager conversation, captured again after being
   * reopened and extended — passes its own id here so re-capturing resolves
   * to the SAME note and `upsertIfRicher` can actually update it instead of
   * creating a duplicate. Absent for every existing capture kind (edit/
   * decision/episodic/agent/commit/learning) — unaffected by this field.
   */
  stableId?: string;
}

/** A single learning insight rendered as a structured HTML element. */
export interface InsightPayload {
  kind: string;
  title: string;
  description: string;
  actionable: boolean;
  suggestion?: string;
}

/** Brain health snapshot returned by brain_fetch_health. */
export interface BrainHealth {
  score: number;
  orphans: number;
  brokenLinks: number;
  stale: number;
  dupes: number;
  /**
   * Denominators for orphans/dupes/stale and brokenLinks respectively —
   * lets the UI render a proportion ("3047 of 53268 links (5.7%)") instead
   * of a bare, uninterpretable integer (Settings > Memory legibility fix).
   * Optional: absent on a brain whose cached `_index.html` predates these
   * fields (health-score.ts, engine) — degrade to the bare count rather
   * than a fabricated/misleading "0 total".
   */
  totalNotes?: number;
  totalLinks?: number;
}

/** One health-metric category `brain_health_detail` can produce a read-only
 *  breakdown for — matches engine's HealthDetailCategory
 *  (health-detail.ts). */
export type HealthDetailCategory = 'orphans' | 'brokenLinks' | 'duplicates';

export interface HealthDetailOrphanItem {
  id: string;
  title: string;
}

export interface HealthDetailBrokenLinkItem {
  fromId: string;
  fromTitle: string;
  /** The dangling target id the link points to — not a real note in the corpus. */
  toId: string;
}

export interface HealthDetailDuplicateGroup {
  title: string;
  noteIds: string[];
}

/**
 * Read-only dry-run breakdown for one health category (TASK 2: Settings >
 * Memory remediation UI). NEVER a mutation — see engine's health-detail.ts
 * doc comment. `total` is the real, uncapped count (matches the
 * corresponding BrainHealth field); the per-category array is capped at
 * HEALTH_DETAIL_LIMIT (engine) items, with `truncated` set when more exist.
 */
export interface HealthDetailResult {
  category: HealthDetailCategory;
  total: number;
  shown: number;
  truncated: boolean;
  orphans?: HealthDetailOrphanItem[];
  brokenLinks?: HealthDetailBrokenLinkItem[];
  duplicates?: HealthDetailDuplicateGroup[];
}

/** Result returned by brain_capture (mirrors LazyBrain store JSON output). */
export interface CaptureResult {
  id: string;
  path: string;
  sizeBytes: number;
  attrsCount: number;
}

export interface Brain {
  search(query: string, limit?: number): Promise<BrainSearchResult[]>;
  /**
   * Turn-mode inject-context. `sessionId` is forwarded to the sidecar's
   * session-dedup (same contract as recallScoped). Omit for no dedup.
   */
  recall(context: string, sessionId?: string): Promise<BrainRecallResult>;
  /**
   * Search across a given scope of project brains.
   * Each result carries sourceProject when scope is 'all' or { project }.
   * Tauri: invoke('brain_fetch_search_scoped', { q, scopeJson, top }).
   * Web: delegates to search() (sidecar when reachable, else empty).
   */
  searchScoped(query: string, scope: BrainScope, limit?: number): Promise<BrainSearchResult[]>;
  /**
   * Recall across a given scope of project brains.
   * Each node in the result carries sourceProject when scope is 'all' or { project }.
   * `sessionId`: stable per-conversation id for the engine's session-dedup
   * (Q3 differential-injection dedup — see search.rs's
   * `brain_fetch_recall_scoped` doc comment). Passing the SAME id across a
   * conversation's turns lets the engine skip notes already shown earlier
   * in that conversation; omit it (or pass undefined) to get the original
   * behavior unchanged (no dedup) — see assistantStore.tsx's
   * `recallSessionIdRef` for where the frontend id comes from.
   * Tauri: invoke('brain_fetch_recall_scoped', { query, scope, sessionId }).
   * Web: delegates to recall() (sidecar when reachable, else empty).
   * sessionId is forwarded on the HTTP recall URL.
   */
  recallScoped(query: string, scope: BrainScope, sessionId?: string): Promise<BrainRecallResult>;
  store(title: string, content: string, tags?: string[]): Promise<string>;
  /** Write a neuron into the brain via the Rust store-CLI path. */
  capture(event: CaptureEvent): Promise<CaptureResult>;
  /** GET /_api/graph → mapped BrainGraphData for 3D graph rendering. */
  graph(): Promise<BrainGraphData>;
  /** GET /_api/note-meta/:id → note metadata for wiki panel. */
  note(id: string): Promise<BrainNoteMeta>;
  /**
   * GET /_api/note/:id → the full HTML content of a note (its <article> /
   * <section> element with all data-cerveau-* attributes, links, and body
   * text). Resolves null when the note doesn't exist or the sidecar is
   * unreachable. Never rejects.
   */
  noteHtml(id: string): Promise<string | null>;
  /**
   * GET /_api/tree → the project→module→topic hierarchy that powers the Wiki
   * sidebar (regenerated by the engine's `graph` step). Resolves
   * { projects: [] } when unavailable — never rejects, so the sidebar
   * degrades to empty instead of crashing.
   */
  tree(): Promise<BrainTree>;
  /**
   * GET /_api/synthesis/index → the synthesized brain-index wiki page plus
   * the topic pages it links to. Resolves null when no synthesis exists yet
   * (drives the Wiki empty state). Never rejects.
   */
  synthesisIndex(): Promise<BrainSynthesisIndex | null>;
  /**
   * GET /_api/synthesis/:topic → a synthesized topic-overview page's raw
   * HTML, or null when that topic has no synthesis. Never rejects.
   */
  synthesisTopic(topic: string): Promise<string | null>;
  /**
   * Trigger a background graph rebuild (lazybrain index-rebuild + graph),
   * then emit brain://updated so live graph listeners can refresh.
   * No-op in web mock.
   */
  rebuildGraph(): Promise<void>;
  /**
   * Trigger code-first ingestion of the open project: runs the engine's
   * `graph --cwd <project_root>` which scans source files with tree-sitter,
   * creates file-neuron + aggregate-neuron notes, and rebuilds the knowledge
   * graph. Emits brain://updated on success. No-op in web mock.
   */
  ingestProject(): Promise<void>;
  /**
   * Return node IDs that link TO the given node (incoming edges).
   * Returns [] if the backend endpoint is not yet available.
   */
  backlinks(nodeId: string): Promise<string[]>;
  /**
   * Return node IDs directly connected to the given node (incoming + outgoing).
   * Returns [] if the backend endpoint is not yet available.
   */
  neighbors(nodeId: string): Promise<string[]>;
  /**
   * STRUCTURAL recall — run a raw CSS selector over the brain's HTML notes
   * (engine `lazybrain query`, deterministic L1, <5ms) and return the engine's
   * pretty text (note #ids + stripped text per hit). Distinct from the
   * semantic `search`/`recall`: this answers precise, deterministic questions
   * over the `data-cerveau-*` attributes — "every decision still active"
   * (`article[data-cerveau-type="decision"]:not([data-cerveau-valid-until])`),
   * "every warning" (`aside[role="doc-warning"]`), "notes touching a path"
   * (`data[value*="src/auth"]`), "contradictions"
   * (`[data-cerveau-saliency-kind="contradiction"]`).
   * Tauri: invoke('brain_query_css', { selector, limit }).
   * Web: resolves to an explanatory "not available in the browser" string.
   */
  queryCss(selector: string, limit?: number): Promise<string>;
  /**
   * STRUCTURAL graph hop — 1-hop neighbours of a note id (supersession chains,
   * triples, shared entities/clusters — engine `lazybrain neighbours`) as
   * pretty text, so the model can FOLLOW a hit's graph ("what replaced this?",
   * "what else touches auth?"). Distinct from `neighbors` above, which returns
   * bare node ids for 3D-graph rendering via the sidecar HTTP endpoint; this
   * returns the LLM-facing pretty edges via the CLI.
   * Tauri: invoke('brain_neighbours', { id }).
   * Web: resolves to an explanatory "not available in the browser" string.
   */
  neighbours(id: string): Promise<string>;
  /**
   * Merged graph across all configured project brains.
   * Tauri: invoke('brain_fetch_graph_merged').
   * Web: returns the same mock graph as graph().
   */
  graphAll(): Promise<BrainGraphData>;
  /**
   * Brain health snapshot.
   * Tauri: invoke('brain_fetch_health').
   * Web: returns null (no daemon in browser).
   */
  health(): Promise<BrainHealth | null>;
  /**
   * Explicitly retry starting the brain sidecar — the "Réessayer" action on
   * the "Sidecar brain indisponible" error state (BrainSpace.tsx). Clears
   * any cached init-failure marker so this attempt is never silently skipped
   * by the backend's failure-caching cooldown, then stops/re-inits/starts
   * the sidecar and waits for it to answer a real request.
   * Resolves `true` iff the sidecar came up healthy — the caller reloads the
   * graph on success and keeps showing "reconnecting" on failure.
   * Tauri: invoke('brain_retry_sidecar').
   * Web: resolves `false` (no daemon to retry in the browser mock).
   */
  retrySidecar(): Promise<boolean>;
  /**
   * List of project root paths registered in brain-projects.json.
   * Tauri: invoke('get_brain_projects').
   * Web: returns [].
   */
  getProjects(): Promise<string[]>;
  /**
   * Persist a new list of project root paths to brain-projects.json.
   * Tauri: invoke('set_brain_projects').
   * Web: no-op.
   */
  setProjects(paths: string[]): Promise<void>;

  // ── History import (CONTRACT-G2) ────────────────────────────────

  /**
   * Detect available conversation-history sources on this machine.
   * Tauri: invoke('detect_history_sources').
   * Web: resolves to [] (no filesystem access in browser).
   */
  detectHistorySources(): Promise<HistorySource[]>;

  /**
   * Estimate the cost/time of seeding from the given source keys.
   * Runs `lazybrain import --dry-run` — no writes, no LLM calls.
   * Tauri: invoke('brain_seed_estimate', { sources }).
   * Web: resolves to { items: 0, estTokens: 0, estMinutes: 0 }.
   */
  seedEstimate(sources: string[]): Promise<SeedEstimate>;

  /**
   * Start a background brain-seed from the given sources.
   * Tauri: invoke('brain_seed', { sources, useLlm, since, projectRoot }).
   *        Emits 'brain://seed-progress' events during the run.
   * Web: rejects with 'not available in the browser'.
   */
  seedBrain(opts: {
    sources: string[];
    useLlm: boolean;
    since?: string;
    projectRoot?: string;
  }): Promise<{ imported: number; skipped: number }>;

  /**
   * Subscribe to seed-progress events from the Tauri backend.
   * Returns an unsubscribe function that stops listening.
   * Tauri: wraps listen('brain://seed-progress').
   * Web: callback is never called; returned function is a no-op.
   */
  onSeedProgress(cb: (p: SeedProgressEvent) => void): () => void;

  /**
   * Fetch startup context for the given project root (highlights mode).
   * Runs `lazybrain inject-context --mode highlights --cwd <cwd> --max-tokens 400`.
   * Returns trimmed stdout, or empty string on any error (never throws).
   * Tauri: invoke('brain_fetch_startup_context', { cwd }).
   * Web: resolves to ''.
   */
  startupContext(cwd: string): Promise<string>;
}

// ── Model Gateway ────────────────────────────────────────────────

export type ModelProvider = 'anthropic' | 'openai' | 'google' | 'local';

export interface ModelInfo {
  id: string;
  displayName: string;
  provider: ModelProvider;
  contextWindow: number;
}

// ── Tests ─────────────────────────────────────────────────────────

export interface TestFailure {
  name: string;
  message: string;
  file?: string;
  line?: number;
}

export interface TestRunResult {
  ok: boolean;
  tool: string;
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  failures: TestFailure[];
  raw: string;
}

export interface Tests {
  run(repoPath: string): Promise<TestRunResult>;
}

// ── LSP (Language Server Protocol) ──────────────────────────────

export interface Lsp {
  /** Returns false if no binary is found for the given language — never throws.
   *  Callers must pass the language so the backend can probe the right binary. */
  available(language: string): Promise<boolean>;
  /** Start a language server for the given repo and language.
   *  Returns false (not throws) if the server is unavailable. */
  start(repoPath: string, language: string): Promise<boolean>;
  /** Send a JSON-RPC request to the running server for (repoPath, language).
   *  The server must have been started first via start(). */
  request(repoPath: string, language: string, method: string, params: unknown): Promise<unknown>;
  /** Send a JSON-RPC notification (fire-and-forget) for (repoPath, language). */
  notify(repoPath: string, language: string, method: string, params: unknown): Promise<void>;
  /** Subscribe to server->client messages (e.g. diagnostics).
   *  Returns an unsubscribe function. */
  onMessage(cb: (msg: { method: string; params: unknown }) => void): () => void;
}

// ── Missions persistence ─────────────────────────────────────────

export interface Missions {
  save(projectRoot: string, data: unknown): Promise<void>;
  load(projectRoot: string): Promise<unknown | null>;
}

// ── Health ───────────────────────────────────────────────────────

export type HealthStatus = 'ok' | 'down' | 'unknown';

export interface HealthReport {
  brain: HealthStatus;
  git: HealthStatus;
  terminal: HealthStatus;
  model: HealthStatus;
  agentRunner: HealthStatus;
  details?: Record<string, string>;
}

// ── CodeGraph (code intelligence) ────────────────────────────────

export interface CodeGraphPlatform {
  /** Run the full indexing pipeline for a project root. */
  index(
    projectRoot: string,
    opts?: { force?: boolean; onProgress?: (p: { phase: string; label: string; progress: number; overall: number }) => void },
  ): Promise<{ nodeCount: number; edgeCount: number; skipped: boolean }>;

  /** Query the code graph for symbols matching a natural-language query. */
  query(
    projectRoot: string,
    query: string,
    limit?: number,
  ): Promise<Array<{ name: string; kind: string; filePath: string; cluster?: string }>>;

  /** Get a 360° context view for a symbol. */
  context(
    projectRoot: string,
    symbolName: string,
  ): Promise<{
    symbol: { name: string; kind: string; filePath: string; cluster?: string };
    incomingCalls: Array<{ name: string; filePath: string }>;
    outgoingCalls: Array<{ name: string; filePath: string }>;
    processes: Array<{ name: string; step: number; total: number }>;
  } | null>;

  /** Analyze the blast radius of changing a symbol. */
  impact(
    projectRoot: string,
    target: string,
    direction?: 'upstream' | 'downstream',
    maxDepth?: number,
  ): Promise<{
    target: string;
    totalAffected: number;
    riskLevel: 'low' | 'medium' | 'high';
    levels: Array<{ depth: number; label: string; symbols: Array<{ name: string; kind: string; filePath: string; confidence: number }> }>;
  }>;

  /** Find the shortest call path between two symbols. */
  trace(
    projectRoot: string,
    from: string,
    to: string,
  ): Promise<{ from: string; to: string; found: boolean; path: Array<{ name: string; kind: string; filePath: string }> }>;

  /** Map uncommitted git changes to affected symbols, processes, and clusters. */
  detectChanges(
    projectRoot: string,
    changedFiles: string[],
  ): Promise<{
    changedSymbols: Array<{ name: string; kind: string; filePath: string }>;
    affectedProcesses: Array<{ name: string; stepCount: number }>;
    affectedClusters: string[];
    riskLevel: 'low' | 'medium' | 'high';
  }>;

  /** Preview a multi-file rename of a symbol. */
  renamePreview(
    projectRoot: string,
    symbolName: string,
    newName: string,
  ): Promise<{
    filesAffected: number;
    totalEdits: number;
    graphEdits: number;
    textSearchEdits: number;
    changes: Array<{ filePath: string; line: number; source: 'graph' | 'text' }>;
  }>;

  /** Check if the code graph index is stale (behind HEAD). */
  staleness(projectRoot: string): Promise<{
    isStale: boolean;
    lastCommit: string | null;
    currentCommit: string | null;
    reason: string;
  }>;

  /** List all registered repos in the global registry. */
  listRepos(): Promise<Array<{ name: string; path: string; indexedAt: number; nodeCount: number; edgeCount: number }>>;

  /** Generate agent skills from detected code communities. */
  generateSkills(projectRoot: string): Promise<Array<{
    name: string;
    description: string;
    keyFiles: string[];
    entryPoints: string[];
    processes: string[];
  }>>;

  /** Start watch mode for incremental updates on file changes. */
  watchStart(
    projectRoot: string,
    onChanges: (result: { changed: string[]; unchanged: string[]; deleted: string[] }) => void,
  ): Promise<{ ok: boolean; message: string }>;

  /** Stop watch mode for a project root. */
  watchStop(projectRoot: string): Promise<void>;

  /** Get incremental indexing stats from the last pipeline run. */
  incrementalInfo(projectRoot: string): Promise<{
    reparsedCount: number;
    skippedCount: number;
    usedTreeSitter: boolean;
    fileHashCount: number;
  } | null>;
}

// ── Platform (top-level) ─────────────────────────────────────────

export interface Platform {
  name: 'web' | 'tauri';
  fs: FileSystem;
  terminal: Terminal;
  git: Git;
  brain: Brain;
  tests: Tests;
  missions: Missions;
  lsp: Lsp;
  codegraph: CodeGraphPlatform;
  health(): Promise<HealthReport>;
}
