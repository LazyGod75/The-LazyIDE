/* TauriPlatform — native Platform implementation backed by Rust commands.
   FS operations are wired to the Tauri invoke bridge.
   Terminal / Git / Brain / Models are stubbed — implemented in later phases.
*/

import { invoke } from '@tauri-apps/api/core';
import { normalizeRecall, classifyRecallLevel } from '../brain/context.js';
import { parseTree, parseSynthesisPages } from '../brain/wikiData.js';
import { enrichCaptureAuthor } from '../brain/captureAuthor.js';
import { joinPath, stripVerbatimPrefixesInText } from '../paths.js';
import type { CodeGraph } from '../codegraph/index.js';
import { createFileHashStore, type FileHashStore } from '../codegraph/fileHash.js';
import { createFileWatcher, type FileWatcher } from '../codegraph/fileWatcher.js';
import type {
  Platform,
  FileSystem,
  DirEntry,
  Terminal,
  TerminalProcess,
  SpawnOptions,
  Git,
  GitStatus,
  GitFile,
  GitLogEntry,
  Brain,
  BrainSearchResult,
  BrainRecallResult,
  BrainGraphData,
  BrainGraphNode,
  BrainGraphEdge,
  BrainHealth,
  HealthDetailCategory,
  HealthDetailResult,
  BrainNoteMeta,
  BrainTree,
  BrainSynthesisIndex,
  BrainScope,
  CaptureEvent,
  CaptureResult,
  HistorySource,
  SeedEstimate,
  SeedProgressEvent,
  Tests,
  TestRunResult,
  Missions,
  Lsp,
  HealthReport,
  CodeGraphPlatform,
} from './types.js';

// ── Rust DirEntry shape (matches src-tauri/src/lib.rs) ───────────

interface RustDirEntry {
  name: string;
  path: string;
  kind: 'file' | 'dir';
}

// ── Native FileSystem ─────────────────────────────────────────────

const nativeFs: FileSystem = {
  async readDir(path: string): Promise<DirEntry[]> {
    const entries = await invoke<RustDirEntry[]>('read_dir', { path });
    return entries.map((e) => ({
      name: e.name,
      path: e.path,
      isDir: e.kind === 'dir',
    }));
  },

  async readFile(path: string): Promise<string> {
    return invoke<string>('read_file', { path });
  },

  async readFileBase64(path: string): Promise<string> {
    return invoke<string>('read_file_base64', { path });
  },

  async writeFile(path: string, content: string): Promise<void> {
    await invoke<void>('write_file', { path, content });
  },

  async rename(oldPath: string, newPath: string): Promise<void> {
    await invoke<void>('fs_rename', { oldPath, newPath });
  },

  async remove(path: string): Promise<void> {
    await invoke<void>('fs_remove', { path });
  },

  async createFile(path: string): Promise<void> {
    await invoke<void>('fs_create_file', { path });
  },

  async createDir(path: string): Promise<void> {
    await invoke<void>('fs_create_dir', { path });
  },
};

// ── Native Terminal (portable-pty via Rust) ───────────────────────

const nativeTerminal: Terminal = {
  async spawn(
    _command: string,
    _args: string[],
    _opts?: SpawnOptions
  ): Promise<TerminalProcess> {
    // Lazy-import the event API to avoid issues in non-Tauri contexts
    const { listen } = await import('@tauri-apps/api/event');

    const id = await invoke<string>('terminal_spawn', {
      cols: 80,
      rows: 24,
      cwd: _opts?.cwd,
    });

    const dataCallbacks: Array<(data: string) => void> = [];
    const exitCallbacks: Array<(code: number) => void> = [];

    // Subscribe to PTY output events from Rust BEFORE signalling attach —
    // the shell's first banner can be emitted while this listen() is still
    // resolving; Rust buffers those bytes until terminal_attach flushes
    // them, so the first prompt is never dropped (blank-pane bug).
    const unlisten = await listen<string>(`terminal://output/${id}`, (event) => {
      dataCallbacks.forEach((cb) => cb(event.payload));
    });
    invoke('terminal_attach', { id }).catch(() => {});

    return {
      // TerminalProcess does not expose a real pid from the PTY; use 0 as
      // sentinel — consumers should not rely on this value under Tauri.
      pid: 0,

      write(data: string): void {
        invoke('terminal_write', { id, data }).catch(() => {
          // PTY may have closed; ignore write errors silently
        });
      },

      resize(cols: number, rows: number): void {
        invoke('terminal_resize', { id, cols, rows }).catch(() => {});
      },

      kill(): void {
        unlisten();
        invoke('terminal_kill', { id }).catch(() => {});
        exitCallbacks.forEach((cb) => cb(0));
      },

      onData(cb: (data: string) => void): () => void {
        dataCallbacks.push(cb);
        return () => {
          const idx = dataCallbacks.indexOf(cb);
          if (idx !== -1) dataCallbacks.splice(idx, 1);
        };
      },

      onExit(cb: (code: number) => void): () => void {
        exitCallbacks.push(cb);
        return () => {
          const idx = exitCallbacks.indexOf(cb);
          if (idx !== -1) exitCallbacks.splice(idx, 1);
        };
      },
    };
  },
};

// ── Rust GitFileStatus shape (matches src-tauri/src/lib.rs) ──────

interface RustGitFileStatus {
  path: string;
  status: string; // "modified" | "added" | "deleted" | "untracked" | "renamed"
}

function rustStatusToGitFile(r: RustGitFileStatus): GitFile {
  const statusMap: Record<string, GitFile['status']> = {
    modified: 'M',
    added: 'A',
    deleted: 'D',
    untracked: '?',
    renamed: 'M', // treat renamed as modified for UI purposes
  };
  return {
    path: r.path,
    status: statusMap[r.status] ?? 'M',
  };
}

// ── Native Git (gitoxide + git CLI via Rust) ──────────────────────

const nativeGit: Git = {
  async status(repoPath: string): Promise<GitStatus> {
    const [rustFiles, branch] = await Promise.all([
      invoke<RustGitFileStatus[]>('git_status', { repoPath }),
      invoke<string>('git_current_branch', { repoPath }).catch(() => 'main'),
    ]);
    return {
      branch,
      ahead: 0,
      behind: 0,
      files: rustFiles.map(rustStatusToGitFile),
    };
  },

  async diff(repoPath: string, filePath?: string): Promise<string> {
    return invoke<string>('git_diff', {
      repoPath,
      filePath: filePath ?? '',
    });
  },

  async commit(repoPath: string, message: string): Promise<void> {
    await invoke<void>('git_commit', { repoPath, message });
  },

  async stage(repoPath: string, paths: string[]): Promise<void> {
    await invoke<void>('git_stage', { repoPath, paths });
  },

  async unstage(repoPath: string, paths: string[]): Promise<void> {
    await invoke<void>('git_unstage', { repoPath, paths });
  },

  async push(repoPath: string): Promise<void> {
    await invoke<void>('git_push', { repoPath });
  },

  async canPush(repoPath: string): Promise<{ hasRemote: boolean; hasUpstream: boolean }> {
    const r = await invoke<{ has_remote: boolean; has_upstream: boolean }>('git_can_push', { repoPath });
    return { hasRemote: r.has_remote, hasUpstream: r.has_upstream };
  },

  async orphanWorktrees(repoPath: string): Promise<{
    recoverable: { name: string; headSha: string; containedInTarget: boolean }[];
    empty: { name: string; headSha: string; containedInTarget: boolean }[];
  }> {
    const r = await invoke<{
      recoverable: { name: string; head_sha: string; contained_in_target: boolean }[];
      empty: { name: string; head_sha: string; contained_in_target: boolean }[];
    }>('git_orphan_worktrees', { repoPath });
    const map = (b: { name: string; head_sha: string; contained_in_target: boolean }) => ({
      name: b.name,
      headSha: b.head_sha,
      containedInTarget: b.contained_in_target,
    });
    return { recoverable: r.recoverable.map(map), empty: r.empty.map(map) };
  },

  async branches(repoPath: string): Promise<string[]> {
    return invoke<string[]>('git_branches', { repoPath });
  },

  async log(repoPath: string, limit?: number): Promise<GitLogEntry[]> {
    return invoke<GitLogEntry[]>('git_log', { repoPath, limit: limit ?? 20 });
  },
};

// ── Git: revert a merged mission (T1.7, spec §8) ──────────────────
//
// Additive standalone wrapper (same convention as getProjectRoot/
// registerProject below) — NOT added to the `Git` interface in ./types,
// mirroring how mergeWorktree/discardWorktree themselves live in
// lib/agents/runtime.ts (their own invoke calls), not here or on `Git`.

/**
 * Reverts a merge commit produced by approving a mission (agent_merge_worktree
 * — see git.rs's `agent_merge_worktree`, which now returns the merge commit
 * sha on success). Rejects with a clear message when the working tree is
 * dirty or `mergeSha` does not resolve to a merge commit — see git.rs's
 * `git_revert_merge` doc comment for the exact semantics (mainline parent 1,
 * dirty-tree refusal, conflict auto-abort). Returns the revert commit's own
 * sha on success.
 */
export async function gitRevertMerge(repoPath: string, mergeSha: string): Promise<string> {
  return invoke<string>('git_revert_merge', { repoPath, mergeSha });
}

// ── Brain HTTP client (LazyBrain sidecar via Tauri) ───────────────
//
// The Rust sidecar spawns `node lazybrain.js daemon start --foreground --port <PORT>`.
// get_brain_port() returns the port so this client can build the base URL.
// All API calls go to http://127.0.0.1:<port>/_api/...
//
// LazyBrain /_api/search response shape:
//   { query, topK, results: [{id, path, score, level, snippet}], totalMs }
//
// LazyBrain /_api/graph response shape:
//   { nodes: [{id, title, type, topic, importance, ...}], edges: [{from, to, type, auto}] }

interface LbSearchResult {
  id: string;
  path: string;
  score: number;
  level: string;
  snippet: string;
  /** Present in LazyBrain >= v0.2 search responses. */
  title?: string;
}

interface LbSearchResponse {
  query: string;
  topK: number;
  results: LbSearchResult[];
  totalMs: number;
}

// ── LazyBrain /_api/graph response shapes ─────────────────────────

interface LbGraphNode {
  id: string;
  title: string;
  type: string | null;
  topic: string | null;
  importance: number;
  x?: number;
  y?: number;
  degree?: number;
  cluster?: string;
  /** Note creation timestamp — see engine/src/server/routes/graph.ts's GraphNode.created. */
  created?: string | null;
}

interface LbGraphEdge {
  from: string;
  to: string;
  type: string;
  auto: boolean;
}

interface LbGraphResponse {
  nodes: LbGraphNode[];
  edges: LbGraphEdge[];
}

// ── LazyBrain /_api/note-meta/:id response shape ──────────────────

interface LbNoteMeta {
  id: string;
  path: string;
  type: string;
  title: string;
  topic: string | null;
  tags: string;
  importance: number;
  created: string | null;
  // Contradiction-detection signal (LazyBrain >= v0.2 /_api/note-meta).
  saliencyKind?: string | null;
  conflictWith?: string[];
}

// ── Cluster derivation from topic ─────────────────────────────────
// Uses the topic field (first path segment) as the visual cluster.
// Falls back to 'unknown' for nodes without a topic.

function deriveCluster(node: LbGraphNode): string {
  if (node.topic && node.topic !== 'unknown') {
    return node.topic.split('/')[0].toLowerCase();
  }
  // For old notes without topic, try to derive from id prefix
  const id = node.id;
  for (const prefix of ['editor', 'agents', 'brain', 'tauri', 'models']) {
    if (id.includes(prefix) || id.includes(`-${prefix}-`)) return prefix;
  }
  return 'unknown';
}

// ── Brain-path transparency (BRAIN-PATH TRANSPARENCY) ─────────────
//
// Matches src-tauri/src/lib.rs `BrainInfo` (returned by the `get_brain_info`
// command). `info()` is intentionally NOT added to the shared `Brain`
// interface in ./types — that file is out of scope for this change, so the
// method is attached directly to `nativeBrain`/`webBrain` below via a
// widened local type instead. Consumers (MemoryPanel, BrainSpace) import
// this type and narrow `platform.brain` locally to call it.

export interface BrainInfo {
  path: string;
  source: 'env_override' | 'ui_config' | 'project' | 'home_fallback';
  /**
   * Number of `.html` notes found under `<path>/notes/**` at resolution
   * time (BRAIN DISCOVERABILITY) — a fast, filesystem-only count (see
   * Rust's `count_brain_notes`), computed the same way regardless of
   * whether the sidecar is up. Lets the UI distinguish "resolved a brain
   * but it has 0 notes" from "sidecar down" instead of both collapsing
   * into the same silent, indistinguishable empty recall.
   */
  noteCount: number;
  /** Convenience for `noteCount === 0`. */
  isEmpty: boolean;
}

// ── Sidecar auth (direct-fetch fallback) ──────────────────────────
//
// Mirrors src-tauri/src/lib.rs's `BrainConnection` (returned by the
// `get_brain_connection` command). The sidecar's checkAuth now requires
// `Authorization: Bearer <token>` on every request — this is ONLY needed by
// the small number of frontend code paths that fetch the sidecar directly
// over HTTP instead of going through a `brain_fetch_*` invoke command (which
// attaches the header on the Rust side already). Currently: BrainSpace's
// graph/note-meta direct-fetch fallback (used when the primary invoke-based
// path times out).

export interface BrainConnection {
  port: number;
  token: string;
  /** Honest boot-time reason the sidecar binary was never found (see Rust's
   *  `BrainSidecar.bin_missing`) — `None`/absent in the normal case. */
  binMissingReason?: string | null;
  /** Honest reason `ensure_brain_init` genuinely failed after exhausting
   *  every retry (see Rust's `BrainSidecar.init_failed_reason`) — `None`/
   *  absent when the brain is fine (including the legacy-layout-accepted
   *  case) or still starting up. */
  initFailedReason?: string | null;
}

/** Fetch `{ port, token }` for direct-from-webview HTTP calls to the brain
    sidecar. See BrainConnection doc comment above for when this is needed —
    most callers should go through `platform.brain.*` (invoke-based) instead,
    which already carries auth server-side. */
export async function getBrainConnection(): Promise<BrainConnection> {
  return invoke<BrainConnection>('get_brain_connection');
}

// ── UI-persisted brain choice (no env var required) ───────────────
//
// Mirrors src-tauri/src/lib.rs's `set_brain_config` / `import_brain_from_github`
// commands. Lets a user pick/persist a brain from Settings without ever
// touching LAZYBRAIN_BRAIN_PATH — see `BrainInfo.source` above, which now
// reports 'ui_config' when one of these has set the active brain. Same
// convention as `info()`/`publishGithub()`: intentionally NOT added to the
// shared `Brain` interface — attached via a widened local type instead,
// narrowed by callers (MemoryPanel, BrainSpace).

export interface BrainSetConfigOptions {
  /** "project": clear the override (fall back to per-project). "global"/"custom" require `path`. */
  mode: 'project' | 'global' | 'custom';
  /** Required for "global" (a directory to house `<path>/.lazybrain/brain`) and "custom" (the brain itself). */
  path?: string;
}

export interface BrainImportFromGithubOptions {
  /** GitHub (or any git-hosted) repo URL to clone. */
  url: string;
  /** Destination folder for the clone — must not already exist with content. */
  dest: string;
}

// ── Brain publish to GitHub ────────────────────────────────────────
//
// Mirrors src-tauri/src/lib.rs's `brain_publish_github` command. Publishes
// the ROOT brain directory (parent of the `brain/` leaf returned by
// info()/get_brain_info, so `.lazybrain-config.json` travels with it) as a
// git repo: `git init` if needed -> merge a .gitignore excluding
// regenerable caches -> commit -> push to `origin` if it already exists,
// else to `remoteUrl` if provided, else auto-create via `gh` or a
// GITHUB_TOKEN/GH_TOKEN env var when available, else an honest "no remote
// configured" status. Same convention as `info()` above: intentionally NOT
// added to the shared `Brain` interface — attached via a widened local
// type instead, narrowed by callers (MemoryPanel, BrainSpace).
//
// `brain_publish_github` never rejects for expected outcomes (git errors,
// no remote, push rejected, etc.) — callers should branch on `result.ok`
// rather than relying on try/catch for the common cases.

export interface BrainPublishOptions {
  /** Existing (ideally empty) GitHub repo URL to push to — the primary path while `gh` is not installed. */
  remoteUrl?: string;
  // No visibility flag here on purpose: the brain is personal data (memory
  // and notes) and must never be published to a public repository. Repos
  // Lazy creates itself (gh/token auto-create) are always private; pushing
  // to an already-existing remote is refused unless its visibility can be
  // confirmed private — see src-tauri/src/commands/brain/publish.rs.
}

export interface BrainPublishResult {
  ok: boolean;
  /** Clickable https://github.com/... URL — present only when ok is true. */
  url?: string;
  /** Always present: success confirmation, or the exact next step / error on failure. */
  message: string;
}

const nativeBrain: Brain & {
  info(): Promise<BrainInfo>;
  publishGithub(opts?: BrainPublishOptions): Promise<BrainPublishResult>;
  setConfig(opts: BrainSetConfigOptions): Promise<BrainInfo>;
  importFromGithub(opts: BrainImportFromGithubOptions): Promise<BrainInfo>;
  /**
   * TASK 2 (Settings > Memory remediation): read-only dry-run breakdown for
   * one health category — see brain_health_detail (Rust) / health-detail.ts
   * (engine). Never mutates the brain. Same narrow-cast convention as
   * info()/publishGithub() above (not part of the shared Brain interface).
   */
  healthDetail(category: HealthDetailCategory): Promise<HealthDetailResult>;
} = {
  async search(query: string, limit?: number): Promise<BrainSearchResult[]> {
    const top = limit ?? 5;
    // Use Rust proxy command to bypass WebView2 loopback isolation.
    const raw = await invoke<string>('brain_fetch_search', { q: query, top });
    const data = JSON.parse(raw) as LbSearchResponse;
    return data.results.map((r) => ({
      id: r.id,
      title: r.title ?? r.id,
      snippet: r.snippet ?? '',
      score: r.score,
      cluster: r.path,
    }));
  },

  async recall(context: string, sessionId?: string): Promise<BrainRecallResult> {
    // Prefer turn-mode inject-context (same path as recallScoped / chat)
    // so missions and tools get ranked, recency-aware context instead of
    // raw top-K search. Fall back to search if the warm sidecar recall
    // route is unreachable so callers never lose the previous behavior.
    try {
      const scoped = await nativeBrain.recallScoped(context, 'current', sessionId);
      if (scoped.injectedContext || scoped.nodes.length > 0) return scoped;
    } catch {
      // fall through to search
    }
    const top = 10;
    const raw = await invoke<string>('brain_fetch_search', { q: context, top });
    const data = JSON.parse(raw) as LbSearchResponse;
    const nodes: BrainSearchResult[] = data.results.map((r) => ({
      id: r.id,
      title: r.title ?? r.id,
      snippet: r.snippet ?? '',
      score: r.score,
      cluster: r.path,
    }));
    // Every hit shares the same `level` (the engine picks one retrieval
    // strategy per query) — read it off the first hit, same convention as
    // search.rs's recall_from_warm_sidecar.
    const level = classifyRecallLevel(data.results[0]?.level);
    return normalizeRecall({
      nodes,
      tokensSaved: 0,
      injectedContext: '',
      level,
    });
  },

  async store(title: string, content: string, tags?: string[]): Promise<string> {
    // Legacy stub — prefer capture() for new writes.
    const result = await invoke<string>('brain_capture', {
      payload: { kind: 'episodic', title, text: content, tags },
    });
    const parsed = JSON.parse(result) as CaptureResult;
    return parsed.id;
  },

  async capture(event: CaptureEvent): Promise<CaptureResult> {
    // Every capture path gets author attribution ("qui a écrit quoi") before
    // reaching Rust — no agent/manager/IDE capture can bypass it.
    const stamped = await enrichCaptureAuthor(event);
    // Rust spawns `node lazybrain.js store` with the neuron HTML on stdin.
    const raw = await invoke<string>('brain_capture', { payload: stamped });
    return JSON.parse(raw) as CaptureResult;
  },

  async graph(): Promise<BrainGraphData> {
    // Use Rust proxy command to bypass WebView2 loopback isolation.
    const raw = await invoke<string>('brain_fetch_graph');
    const json = JSON.parse(raw) as LbGraphResponse;

    const nodes: BrainGraphNode[] = json.nodes.map((n) => ({
      id: n.id,
      title: n.title,
      type: n.type ?? 'concept',
      cluster: deriveCluster(n),
      importance: n.importance ?? 0.5,
      created: n.created ?? null,
    }));

    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges: BrainGraphEdge[] = json.edges
      .filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to))
      .map((e) => ({
        source: e.from,
        target: e.to,
        type: e.type,
      }));

    return { nodes, edges };
  },

  async rebuildGraph(): Promise<void> {
    // Invoke the Rust command that runs lazybrain index-rebuild + graph,
    // then emits brain://updated so BrainSpace can refresh.
    await invoke<void>('brain_rebuild_graph');
  },

  async ingestProject(): Promise<void> {
    // Same as rebuildGraph — brain_rebuild_graph now passes --cwd <project_root>
    // to the graph command, which triggers the engine's tree-sitter code scanner
    // to create file-neuron + aggregate-neuron notes for the open project.
    await invoke<void>('brain_rebuild_graph');
  },

  async note(id: string): Promise<BrainNoteMeta> {
    const raw = await invoke<string>('brain_fetch_note_meta', { id });
    const json = JSON.parse(raw) as LbNoteMeta;
    return {
      id: json.id,
      title: json.title,
      type: json.type,
      topic: json.topic,
      tags: json.tags ?? '',
      importance: json.importance ?? 0.5,
      created: json.created,
      saliencyKind: json.saliencyKind ?? null,
      conflictWith: json.conflictWith ?? [],
    };
  },

  async noteHtml(id: string): Promise<string | null> {
    try {
      const { port, token } = await getBrainConnection();
      const res = await fetch(
        `http://127.0.0.1:${port}/_api/note/${encodeURIComponent(id)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  },

  // ── Brain wiki (topic hierarchy + synthesized pages) ────────────
  //
  // These sidecar routes have no dedicated Rust `brain_fetch_*` proxy command
  // (unlike graph/note-meta above), so — as the /_api/graph direct-fetch
  // fallback already does elsewhere — they resolve the sidecar's port + Bearer
  // token via get_brain_connection and fetch it straight from the WebView.
  // All three never reject: an unreachable sidecar / missing synthesis simply
  // yields an empty tree or null, which the Wiki view renders as its empty
  // state instead of crashing.

  async tree(): Promise<BrainTree> {
    try {
      const { port, token } = await getBrainConnection();
      const res = await fetch(`http://127.0.0.1:${port}/_api/tree`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return { projects: [] };
      return parseTree(await res.json());
    } catch {
      return { projects: [] };
    }
  },

  async synthesisIndex(): Promise<BrainSynthesisIndex | null> {
    try {
      const { port, token } = await getBrainConnection();
      const res = await fetch(`http://127.0.0.1:${port}/_api/synthesis/index`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      // 404 = no brain-index yet (fresh brain, no `dream --synthesize` run).
      if (!res.ok) return null;
      const html = await res.text();
      return { html, pages: parseSynthesisPages(html) };
    } catch {
      return null;
    }
  },

  async synthesisTopic(topic: string): Promise<string | null> {
    try {
      const { port, token } = await getBrainConnection();
      const res = await fetch(
        `http://127.0.0.1:${port}/_api/synthesis/${encodeURIComponent(topic)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  },

  async backlinks(nodeId: string): Promise<string[]> {
    // TODO: implement /_api/backlinks/:id endpoint in LazyBrain sidecar
    try {
      const raw = await invoke<string>('brain_fetch_backlinks', { id: nodeId });
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  },

  async neighbors(nodeId: string): Promise<string[]> {
    // TODO: implement /_api/neighbors/:id endpoint in LazyBrain sidecar
    try {
      const raw = await invoke<string>('brain_fetch_neighbors', { id: nodeId });
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  },

  async queryCss(selector: string, limit?: number): Promise<string> {
    // Rust spawns `lazybrain query '<selector>' --pretty` with the project
    // brain path pinned (commands/brain/config.rs::brain_query_css) and returns
    // the engine's pretty text verbatim (note #ids + stripped text per hit).
    return invoke<string>('brain_query_css', { selector, limit });
  },

  async neighbours(id: string): Promise<string> {
    // Rust spawns `lazybrain neighbours <id> --pretty` with the brain pinned
    // (commands/brain/config.rs::brain_neighbours); returns the pretty edges.
    return invoke<string>('brain_neighbours', { id });
  },

  async searchScoped(
    query: string,
    scope: BrainScope,
    limit?: number
  ): Promise<BrainSearchResult[]> {
    const top = limit ?? 5;
    // Rust expects: query: String, scope: serde_json::Value, limit: Option<u32>
    // The scope object is serialized by Tauri's invoke layer — pass it directly.
    const result = await invoke<{ hits: Array<LbSearchResult & { sourceProject?: string }>; total_ms: number }>(
      'brain_fetch_search_scoped',
      { query, scope, limit: top }
    );
    return result.hits.map((r) => ({
      id: r.id,
      title: r.title ?? r.id,
      snippet: r.snippet ?? '',
      score: r.score,
      cluster: r.path,
      sourceProject: r.sourceProject,
    }));
  },

  async recallScoped(query: string, scope: BrainScope, sessionId?: string): Promise<BrainRecallResult> {
    // Rust expects: query: String, scope: serde_json::Value, session_id: Option<String>
    // (search.rs:691 — `pub(crate) fn brain_fetch_recall_scoped(query: String,
    // scope: serde_json::Value, session_id: Option<String>, ...)`).
    // `sessionId` here (camelCase) is Tauri's default arg-name conversion for
    // Rust's `session_id` — confirmed against this same file's brain_seed
    // call below, which passes `useLlm` for Rust's `use_llm: bool` param.
    // Undefined/omitted serializes to Rust's None (no dedup — identical to
    // this call's behavior before `session_id` existed); a real id enables
    // the engine's session-dedup — see search.rs's doc comment and
    // assistantStore.tsx's `recallSessionIdRef`.
    // Returns: { text: String, sourceProjects: [String], error?: String, level?: string | null }
    // An `error` field means the brain is missing or the CLI failed — throw so
    // assistantStore's catch block surfaces it via `brainError` (BrainContextBanner).
    // `level` is the RAW LazyBrain retrieval code (see search.rs's
    // recall_from_warm_sidecar / RecallText) — only present for the "current"
    // scope's warm-sidecar path; absent (undefined/null) for the cold-CLI
    // fallback and the "all"/{project} scopes, which have no structured
    // level data. classifyRecallLevel turns it into the 3-value
    // semantic/hybrid/keyword the UI shows, or undefined if unknown.
    const result = await invoke<{
      text: string;
      sourceProjects: string[];
      error?: string;
      level?: string | null;
    }>(
      'brain_fetch_recall_scoped',
      { query, scope, sessionId }
    );
    if (result.error) {
      throw new Error(result.error);
    }
    // Build a synthetic node list from the injected text so callers get a consistent shape.
    const nodes: BrainSearchResult[] = result.text
      ? [
          {
            id: 'recall-context',
            title: 'Recalled context',
            snippet: result.text.slice(0, 300),
            score: 1,
            cluster: undefined,
            sourceProject: result.sourceProjects[0],
          },
        ]
      : [];
    return normalizeRecall({
      nodes,
      tokensSaved: 0,
      injectedContext: result.text,
      level: classifyRecallLevel(result.level),
    });
  },

  async graphAll(): Promise<BrainGraphData> {
    // Rust merges graphs from all configured project brains and returns
    // the same BrainGraphData shape with nodes tagged by sourceProject.
    const raw = await invoke<string>('brain_fetch_graph_merged');
    const json = JSON.parse(raw) as LbGraphResponse;

    const nodes: BrainGraphNode[] = json.nodes.map((n) => ({
      id: n.id,
      title: n.title,
      type: n.type ?? 'concept',
      cluster: deriveCluster(n),
      importance: n.importance ?? 0.5,
      created: n.created ?? null,
    }));

    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = json.edges
      .filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to))
      .map((e) => ({
        source: e.from,
        target: e.to,
        type: e.type,
      }));

    return { nodes, edges };
  },

  async health(): Promise<BrainHealth | null> {
    // brain_fetch_health (Rust) returns serde_json::Value directly — NOT a
    // pre-stringified String like the sidecar HTTP-proxy commands above
    // (graph/search/capture/...), which hand back raw response text that
    // still needs a manual JSON.parse. Tauri's IPC layer already
    // deserializes a Value return into a plain object, so invoke() must be
    // typed with the real shape here (same contract as brain_fetch_search_
    // scoped/brain_fetch_recall_scoped below, which return the identical
    // serde_json::Value kind and are invoked the same direct-typed way) —
    // wrapping this in JSON.parse(raw) would throw on every call, since raw
    // is already an object, not JSON text.
    return invoke<BrainHealth>('brain_fetch_health');
  },

  async healthDetail(category: HealthDetailCategory): Promise<HealthDetailResult> {
    // brain_health_detail (Rust) returns serde_json::Value directly, same
    // contract as health() above — already deserialized, never a String to
    // JSON.parse.
    return invoke<HealthDetailResult>('brain_health_detail', { category });
  },

  async retrySidecar(): Promise<boolean> {
    // brain_retry_sidecar (Rust) clears any cached init-failure marker and
    // re-runs the same stop/ensure_brain_init/start sequence as a project
    // switch, returning whether the sidecar came up healthy. Never throws on
    // a still-down sidecar — that is a legitimate `false`, not an error —
    // but invoke() itself can still reject (e.g. a poisoned Rust mutex), so
    // callers that only care about "did it recover" should treat a rejection
    // the same as `false`.
    return invoke<boolean>('brain_retry_sidecar');
  },

  async getProjects(): Promise<string[]> {
    return invoke<string[]>('get_brain_projects');
  },

  async setProjects(paths: string[]): Promise<void> {
    await invoke<void>('set_brain_projects', { paths });
  },

  // ── History import (CONTRACT-G2) ──────────────────────────────

  async detectHistorySources(): Promise<HistorySource[]> {
    return invoke<HistorySource[]>('detect_history_sources');
  },

  async seedEstimate(sources: string[]): Promise<SeedEstimate> {
    return invoke<SeedEstimate>('brain_seed_estimate', { sources });
  },

  async seedBrain(opts: {
    sources: string[];
    useLlm: boolean;
    since?: string;
    projectRoot?: string;
  }): Promise<{ imported: number; skipped: number }> {
    return invoke<{ imported: number; skipped: number }>('brain_seed', {
      sources: opts.sources,
      useLlm: opts.useLlm,
      since: opts.since ?? null,
      projectRoot: opts.projectRoot ?? null,
    });
  },

  onSeedProgress(cb: (p: SeedProgressEvent) => void): () => void {
    let unlistenFn: (() => void) | null = null;

    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<SeedProgressEvent>('brain://seed-progress', (event) => {
          cb(event.payload);
        })
      )
      .then((unlisten) => {
        unlistenFn = unlisten;
      })
      .catch(() => {
        // Tauri event API unavailable — silently degrade.
      });

    return () => {
      unlistenFn?.();
    };
  },

  async startupContext(cwd: string): Promise<string> {
    try {
      return await invoke<string>('brain_fetch_startup_context', { cwd });
    } catch {
      return '';
    }
  },

  async info(): Promise<BrainInfo> {
    return invoke<BrainInfo>('get_brain_info');
  },

  async publishGithub(opts: BrainPublishOptions = {}): Promise<BrainPublishResult> {
    return invoke<BrainPublishResult>('brain_publish_github', {
      remoteUrl: opts.remoteUrl,
    });
  },

  async setConfig(opts: BrainSetConfigOptions): Promise<BrainInfo> {
    return invoke<BrainInfo>('set_brain_config', { mode: opts.mode, path: opts.path });
  },

  async importFromGithub(opts: BrainImportFromGithubOptions): Promise<BrainInfo> {
    return invoke<BrainInfo>('import_brain_from_github', { url: opts.url, dest: opts.dest });
  },
};

// ── Native LSP ───────────────────────────────────────────────────
// Bridges the Platform Lsp interface to the Tauri commands implemented
// by RUST-D (lsp_start, lsp_request, lsp_notify, lsp_stop, lsp_available).
// Server->client notifications arrive as Tauri event 'lsp://message'.
//
// Server registry: maps (repoPath, language) -> serverId returned by lsp_start.
// Servers are started lazily and cached — subsequent calls reuse the same id.
//
// Graceful degradation: if any Tauri command is missing (invoke rejects),
// available() returns false and start() returns false instead of throwing.

/** Stable cache key for a (repoPath, language) pair. */
function serverKey(repoPath: string, language: string): string {
  return `${language}::${repoPath}`;
}

/** Registry: serverKey -> serverId (string returned by lsp_start). */
const serverRegistry = new Map<string, string>();

/** Start a server lazily and cache the returned serverId. Returns null on failure. */
async function resolveServerId(repoPath: string, language: string): Promise<string | null> {
  const key = serverKey(repoPath, language);
  const cached = serverRegistry.get(key);
  if (cached !== undefined) return cached;

  try {
    const serverId = await invoke<string>('lsp_start', { repoPath, language });
    // Rust returns the UNAVAILABLE_MARKER constant when no binary is found.
    if (!serverId || serverId === 'unavailable') return null;
    serverRegistry.set(key, serverId);
    return serverId;
  } catch {
    return null;
  }
}

const nativeLsp: Lsp = {
  async available(language: string): Promise<boolean> {
    try {
      return await invoke<boolean>('lsp_available', { language });
    } catch {
      return false;
    }
  },

  async start(repoPath: string, language: string): Promise<boolean> {
    const serverId = await resolveServerId(repoPath, language);
    return serverId !== null;
  },

  async request(repoPath: string, language: string, method: string, params: unknown): Promise<unknown> {
    const serverId = await resolveServerId(repoPath, language);
    if (!serverId) throw new Error(`LSP server unavailable for language '${language}'`);
    const paramsJson = JSON.stringify(params);
    const resultJson = await invoke<string>('lsp_request', { serverId, method, paramsJson });
    return JSON.parse(resultJson) as unknown;
  },

  async notify(repoPath: string, language: string, method: string, params: unknown): Promise<void> {
    const serverId = await resolveServerId(repoPath, language);
    if (!serverId) return; // server unavailable — fire-and-forget, silently degrade
    const paramsJson = JSON.stringify(params);
    await invoke<void>('lsp_notify', { serverId, method, paramsJson });
  },

  onMessage(cb: (msg: { method: string; params: unknown }) => void): () => void {
    // Lazy-import the event API; fall back to no-op if unavailable.
    // Track disposal intent before the async chain resolves so we never
    // leak a permanent Tauri event listener on fast dispose (#25).
    let disposed = false;
    let unlistenFn: (() => void) | null = null;

    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<{ method: string; params: unknown }>('lsp://message', (event) => {
          cb(event.payload);
        })
      )
      .then((unlisten) => {
        if (disposed) {
          // Dispose was called before the import resolved — unlisten immediately.
          unlisten();
        } else {
          unlistenFn = unlisten;
        }
      })
      .catch(() => {
        // Tauri event API unavailable — silently degrade.
      });

    return () => {
      disposed = true;
      unlistenFn?.();
    };
  },
};

// ── Native Tests ──────────────────────────────────────────────────

const nativeTests: Tests = {
  async run(repoPath: string): Promise<TestRunResult> {
    return invoke<TestRunResult>('run_tests', { repoPath });
  },
};

// ── Native Missions persistence ───────────────────────────────────
// Data stored at <projectRoot>/.lazy/missions.json
//
// CRITICAL (this is the 5th instance of the "\\?\" verbatim-path bug class —
// see src/lib/paths.ts's header comment for the first four): projectRoot is
// typically get_project_root's canonicalized result, which on Windows is
// \\?\-prefixed (verbatim). The previous implementation joined with a
// hardcoded '/' (`${projectRoot}/.lazy/missions.json`), producing a
// mixed-separator string the Rust fs commands (fs_create_dir/write_file/
// read_file, whose ensure_*_path_in_project helpers canonicalize the path)
// cannot resolve even though the directory exists on disk — save() then
// failed silently (its caller in agentsStore.tsx's debounce effect swallows
// the rejection as "persistence failure must not affect UI"), so
// missions.json was never actually written and mission history vanished on
// every navigation/restart. Fixed by using joinPath (../paths), which reuses
// whichever separator projectRoot already contains — same fix pattern as
// resolveDiscardWorktreePath/resolveWorktreePath elsewhere in this codebase.

const nativeMissions: Missions = {
  async save(projectRoot: string, data: unknown): Promise<void> {
    const lazyDir = joinPath(projectRoot, '.lazy');
    const filePath = joinPath(lazyDir, 'missions.json');
    await invoke<void>('fs_create_dir', { path: lazyDir });
    await invoke<void>('write_file', { path: filePath, content: JSON.stringify(data) });
  },

  async load(projectRoot: string): Promise<unknown | null> {
    const filePath = joinPath(projectRoot, '.lazy', 'missions.json');
    try {
      const raw = await invoke<string>('read_file', { path: filePath });
      return JSON.parse(raw) as unknown;
    } catch {
      // File does not exist yet — treat as null
      return null;
    }
  },
};

// ── Native Health ─────────────────────────────────────────────────

async function nativeHealth(): Promise<HealthReport> {
  const details: Record<string, string> = {};

  // brain: try the existing brain proxy
  const brain: HealthReport['brain'] = await invoke<string>('brain_fetch_search', { q: '__health__', top: 1 })
    .then((): HealthReport['brain'] => 'ok')
    .catch((err: unknown): HealthReport['brain'] => {
      // 9th instance of the "\\?\" verbatim-prefix bug class (see
      // src/lib/paths.ts's header for the first eight): a rejected
      // invoke()'s error text can embed a canonicalize()-sourced,
      // verbatim-prefixed path mid-sentence (e.g. the path-jail guard's
      // "access denied: '<path>' is outside every registered project
      // root" — see the git check below). This is a free-text error
      // message the Settings Health panel renders verbatim, not a path
      // value on its own, so stripVerbatimPrefix's whole-string check
      // doesn't apply — use stripVerbatimPrefixesInText instead.
      details['brain'] = stripVerbatimPrefixesInText(String(err));
      return 'down';
    });

  // git: git_current_branch needs a REAL registered project root. Passing
  // repoPath: '.' (the old code) resolves against the app PROCESS's cwd —
  // the workspace parent directory, e.g. "...\Documents\cerveau" — which is
  // never itself a registered project root. The Rust path-jail guard
  // (commands/util.rs's ensure_repo_in_any_open_project) then rejected it
  // every single time with "access denied: '.' is outside every registered
  // project root", even though git itself was perfectly healthy — a false
  // "down" that sent users chasing a phantom. Use the active project's
  // root instead (get_project_root / ProjectState — state.rs's doc comment
  // confirms project_set_active keeps it in sync with the registry's
  // active entry on every register/switch, the same source ReviewSpace.tsx
  // already reads for git operations). Report 'unknown' (not 'down') when
  // no project is open: there is nothing to check yet, not a broken
  // subsystem.
  const activeProjectRoot = await getProjectRoot().catch((): string => '');
  const git: HealthReport['git'] = !activeProjectRoot
    ? 'unknown'
    : await invoke<string>('git_current_branch', { repoPath: activeProjectRoot })
        .then((): HealthReport['git'] => 'ok')
        .catch((err: unknown): HealthReport['git'] => {
          // See the brain check above: same free-text-error-embeds-a-raw-
          // path issue, and the concrete report this was found from
          // (raw "\\?\C:\Users\user\Documents\cerveau" in the panel) was
          // this exact git-check failure text.
          details['git'] = stripVerbatimPrefixesInText(String(err));
          return 'down';
        });

  // terminal: always ok in Tauri (native PTY is available)
  const terminal: HealthReport['terminal'] = 'ok';

  // model: check if claude is available via a dedicated Tauri command
  const model: HealthReport['model'] = await invoke<boolean>('claude_available')
    .then((available): HealthReport['model'] => (available ? 'ok' : 'down'))
    .catch((): HealthReport['model'] => 'unknown');

  // agentRunner: always ok in Tauri (Rust side can run agents)
  const agentRunner: HealthReport['agentRunner'] = 'ok';

  return { brain, git, terminal, model, agentRunner, details };
}

// ── Project root ──────────────────────────────────────────────────

/** Returns the current project root from the Rust ProjectState. */
export async function getProjectRoot(): Promise<string> {
  return invoke<string>('get_project_root');
}

/**
 * Open a native folder-picker dialog and return the chosen path,
 * or null if the user cancelled.
 * No-op (returns null) in browser/web mode.
 */
export async function openFolder(): Promise<string | null> {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({ directory: true, multiple: false, title: 'Ouvrir un dossier' });
    if (!selected || Array.isArray(selected)) return null;
    return selected;
  } catch {
    return null;
  }
}

/**
 * Switch the IDE to a new project root via the Rust set_project command.
 * Triggers brain re-init + sidecar restart on the Rust side.
 */
export async function setProject(path: string): Promise<void> {
  await invoke<void>('set_project', { path });
}

// ── Multi-project registry (T0.9) ───────────────────────────────────
//
// Additive wrappers around the T0.7 registry commands (commands/brain/
// config.rs) — `setProject` above stays untouched for any existing/future
// caller; these four give the frontend direct access to the underlying
// register/activate/close/list primitives `setProject` is now a thin
// wrapper over.

/** Wire shape returned by `project_register` / `project_list` (Rust's
 *  `ProjectEntryOut`). `brainId` is `null` until the multi-tenant brain
 *  sidecar has resolved this project's brain at least once. `gitInitNote` is
 *  `null` for every entry except `createProject`'s own return value for a
 *  directory it just created — see `createProject`'s doc comment below for
 *  what it reports and why it is never a boolean. */
export interface ProjectEntryOut {
  id: string;
  root: string;
  brainId: string | null;
  active: boolean;
  gitInitNote: string | null;
}

/**
 * Registers `path` as an open project — idempotent (re-registering an
 * already-open root returns the SAME entry, never a duplicate). Does NOT
 * change which project is active; call `setActiveProject` to switch focus.
 */
export async function registerProject(path: string): Promise<ProjectEntryOut> {
  return invoke<ProjectEntryOut>('project_register', { path });
}

/**
 * Creates `path` as a brand-new directory (exactly one level — the PARENT
 * must already exist) and registers it as an open project in the same call —
 * the `project_create` Rust command, which delegates into the exact same
 * registration body `project_register` uses once the directory exists. Also
 * idempotent: a `path` that already exists AS A DIRECTORY is not an error,
 * it is just registered, same as `registerProject`. Does NOT change which
 * project is active; call `setActiveProject` to switch focus.
 *
 * Also makes the new directory a usable git repository (`git init` + one
 * initial empty commit under a neutral bot identity) — without this, a
 * mission could never start here at all (`agent_create_worktree_inner`,
 * git/worktree/mod.rs, requires a real git repo and refuses to fall back to
 * the main repo). The outcome is reported honestly in the returned entry's
 * `gitInitNote`, never silently: `null` only for the re-registering-an-
 * existing-directory case (git init was never attempted); otherwise always
 * a plain-English sentence — success, "skipped: parent is already a repo",
 * or a failure reason plus "mission worktrees cannot be created here yet".
 * Callers that want to surface this to the user/manager should read it, not
 * assume success from the call not throwing.
 */
export async function createProject(path: string): Promise<ProjectEntryOut> {
  return invoke<ProjectEntryOut>('project_create', { path });
}

/**
 * Switches the active project to `id`. Emits the same `project://changed`
 * event `setProject` always has, so existing listeners keep working
 * unchanged.
 */
export async function setActiveProject(id: string): Promise<void> {
  await invoke<void>('project_set_active', { id });
}

/**
 * Closes project `id`. Rejects if `id` is the active project while other
 * projects remain open — the caller must switch away first.
 */
export async function closeProject(id: string): Promise<void> {
  await invoke<void>('project_close', { id });
}

/** Lists every currently open project, each flagged with whether it is the
 *  active one. */
export async function listProjects(): Promise<ProjectEntryOut[]> {
  return invoke<ProjectEntryOut[]>('project_list');
}

// ── Native CodeGraph ─────────────────────────────────────────────

const graphCache = new Map<string, CodeGraph>();
const hashStores = new Map<string, FileHashStore>();
const watchers = new Map<string, FileWatcher>();
const lastPipelineStats = new Map<string, { reparsedCount: number; skippedCount: number; usedTreeSitter: boolean }>();

const nativeCodeGraph: CodeGraphPlatform = {
  async index(projectRoot, opts) {
    const force = opts?.force ?? false;
    const cached = graphCache.get(projectRoot);

    // Get current commit via git
    let currentCommit: string | null = null;
    try {
      const status = await nativeGit.status(projectRoot);
      currentCommit = status.branch; // Best-effort — would need rev-parse for hash
    } catch {
      // Git not available
    }

    const { runPipeline, registerRepo } = await import('../codegraph/index.js');
    const result = await runPipeline({
      projectRoot,
      currentCommit,
      lastCommit: cached?.lastCommit ?? null,
      force,
      onProgress: opts?.onProgress,
      previousGraph: cached ?? null,
      readDir: async (path) => {
        const entries = await nativeFs.readDir(path);
        return entries.map(e => ({ name: e.name, path: e.path, isDir: e.isDir }));
      },
      readFile: (path) => nativeFs.readFile(path),
    });

    if (!result.skipped) {
      graphCache.set(projectRoot, result.graph);
      registerRepo(result.graph);
      lastPipelineStats.set(projectRoot, {
        reparsedCount: result.reparsedCount,
        skippedCount: result.skippedCount,
        usedTreeSitter: result.usedTreeSitter,
      });
    }

    return {
      nodeCount: result.graph.nodes.length,
      edgeCount: result.graph.edges.length,
      skipped: result.skipped,
    };
  },

  async query(projectRoot, query, limit) {
    const graph = graphCache.get(projectRoot);
    if (!graph) return [];
    const max = limit ?? 10;
    const lower = query.toLowerCase();
    const hits: Array<{ name: string; kind: string; filePath: string; cluster?: string }> = [];
    for (const node of graph.nodes) {
      if (node.kind === 'file' || node.kind === 'folder') continue;
      if (node.name.toLowerCase().includes(lower)) {
        hits.push({ name: node.name, kind: node.kind, filePath: node.filePath, cluster: node.cluster });
        if (hits.length >= max) break;
      }
    }
    return hits;
  },

  async context(projectRoot, symbolName) {
    const graph = graphCache.get(projectRoot);
    if (!graph) return null;
    const { buildContext } = await import('../codegraph/index.js');
    const ctx = buildContext(graph, symbolName);
    if (!ctx) return null;
    return {
      symbol: { name: ctx.symbol.name, kind: ctx.symbol.kind, filePath: ctx.symbol.filePath, cluster: ctx.cluster },
      incomingCalls: ctx.incoming.calls.map(c => ({ name: c.name, filePath: c.filePath })),
      outgoingCalls: ctx.outgoing.calls.map(c => ({ name: c.name, filePath: c.filePath })),
      processes: ctx.processes,
    };
  },

  async impact(projectRoot, target, direction, maxDepth) {
    const graph = graphCache.get(projectRoot);
    if (!graph) return { target, totalAffected: 0, riskLevel: 'low', levels: [] };
    const { analyzeImpact } = await import('../codegraph/index.js');
    const result = analyzeImpact(graph, target, direction ?? 'upstream', { maxDepth });
    return {
      target: result.target.name,
      totalAffected: result.totalAffected,
      riskLevel: result.riskLevel,
      levels: result.levels.map(l => ({
        depth: l.depth,
        label: l.label,
        symbols: l.symbols.map(s => ({ name: s.node.name, kind: s.node.kind, filePath: s.node.filePath, confidence: s.confidence })),
      })),
    };
  },

  async trace(projectRoot, from, to) {
    const graph = graphCache.get(projectRoot);
    if (!graph) return { from, to, found: false, path: [] };
    const { findTrace } = await import('../codegraph/index.js');
    const result = findTrace(graph, from, to);
    return {
      from: result.from.name,
      to: result.to.name,
      found: result.found,
      path: result.path.map(h => ({ name: h.node.name, kind: h.node.kind, filePath: h.node.filePath })),
    };
  },

  async detectChanges(projectRoot, changedFiles) {
    const graph = graphCache.get(projectRoot);
    if (!graph) return { changedSymbols: [], affectedProcesses: [], affectedClusters: [], riskLevel: 'low' };
    const { analyzeDiffImpact } = await import('../codegraph/index.js');
    const result = analyzeDiffImpact(graph, changedFiles);
    return {
      changedSymbols: result.changedSymbols.map(s => ({ name: s.name, kind: s.kind, filePath: s.filePath })),
      affectedProcesses: result.affectedProcesses.map(p => ({ name: p.name, stepCount: p.steps.length })),
      affectedClusters: result.affectedClusters,
      riskLevel: result.riskLevel,
    };
  },

  async renamePreview(projectRoot, symbolName, newName) {
    const graph = graphCache.get(projectRoot);
    if (!graph) return { filesAffected: 0, totalEdits: 0, graphEdits: 0, textSearchEdits: 0, changes: [] };
    // Would need fileContents map — for now return graph-based only
    const fileContents = new Map<string, string>();
    for (const [filePath] of graph.fileIndex) {
      try {
        const content = await nativeFs.readFile(filePath);
        fileContents.set(filePath, content);
      } catch {
        // Skip unreadable
      }
    }
    const { previewRename } = await import('../codegraph/index.js');
    const result = previewRename(graph, symbolName, newName, fileContents);
    if (!result) return { filesAffected: 0, totalEdits: 0, graphEdits: 0, textSearchEdits: 0, changes: [] };
    return {
      filesAffected: result.filesAffected,
      totalEdits: result.totalEdits,
      graphEdits: result.graphEdits,
      textSearchEdits: result.textSearchEdits,
      changes: result.changes.map(c => ({ filePath: c.filePath, line: c.line, source: c.source })),
    };
  },

  async staleness(projectRoot) {
    const graph = graphCache.get(projectRoot);
    let currentCommit: string | null = null;
    try {
      const status = await nativeGit.status(projectRoot);
      currentCommit = status.branch;
    } catch {
      // Git not available
    }
    const { checkStaleness } = await import('../codegraph/index.js');
    const report = checkStaleness(graph?.lastCommit ?? null, currentCommit, []);
    return report;
  },

  async listRepos() {
    const { listRepos } = await import('../codegraph/index.js');
    return listRepos().map(r => ({ name: r.name, path: r.path, indexedAt: r.indexedAt, nodeCount: r.nodeCount, edgeCount: r.edgeCount }));
  },

  async generateSkills(projectRoot) {
    const graph = graphCache.get(projectRoot);
    if (!graph) return [];
    const { generateSkills } = await import('../codegraph/index.js');
    const skills = generateSkills(graph);
    return skills.map(s => ({
      name: s.name,
      description: s.description,
      keyFiles: s.keyFiles,
      entryPoints: s.entryPoints,
      processes: s.processes,
    }));
  },

  async watchStart(projectRoot, onChanges) {
    try {
      const graph = graphCache.get(projectRoot);
      let hashStore = hashStores.get(projectRoot);
      if (!hashStore) {
        hashStore = createFileHashStore();
        if (graph?.fileHashes) {
          hashStore.hashes = new Map(graph.fileHashes);
        }
        hashStores.set(projectRoot, hashStore);
      }

      const watcher = await createFileWatcher({
        projectRoot,
        onChanges: (diff) => {
          onChanges({ changed: diff.changed, unchanged: diff.unchanged, deleted: diff.deleted });
        },
        readDir: async (path) => {
          const entries = await nativeFs.readDir(path);
          return entries.map(e => ({ name: e.name, path: e.path, isDir: e.isDir }));
        },
        readFile: (path) => nativeFs.readFile(path),
        hashStore,
      });
      watcher.start();
      watchers.set(projectRoot, watcher);
      return { ok: true, message: 'Watch mode started' };
    } catch (err) {
      return { ok: false, message: String(err) };
    }
  },

  async watchStop(projectRoot) {
    const watcher = watchers.get(projectRoot);
    if (watcher) {
      watcher.stop();
      watchers.delete(projectRoot);
    }
  },

  async incrementalInfo(projectRoot) {
    const stats = lastPipelineStats.get(projectRoot);
    const graph = graphCache.get(projectRoot);
    if (!stats && !graph) return null;
    return {
      reparsedCount: stats?.reparsedCount ?? 0,
      skippedCount: stats?.skippedCount ?? 0,
      usedTreeSitter: stats?.usedTreeSitter ?? graph?.useTreeSitter ?? false,
      fileHashCount: graph?.fileHashes?.size ?? 0,
    };
  },
};

// ── TauriPlatform export ──────────────────────────────────────────

export const TauriPlatform: Platform = {
  name: 'tauri',
  fs: nativeFs,
  terminal: nativeTerminal,
  git: nativeGit,
  brain: nativeBrain,
  tests: nativeTests,
  missions: nativeMissions,
  lsp: nativeLsp,
  codegraph: nativeCodeGraph,
  health: nativeHealth,
};
