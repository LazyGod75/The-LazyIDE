/* WebPlatform — browser Platform when Tauri IPC is unavailable.
   Filesystem/git/terminal are in-memory stubs (no OS access in the
   browser). Brain talks to the real sidecar over HTTP when reachable
   and otherwise returns empty / rejects — never a canned demo vault.
*/

import type {
  Platform,
  FileSystem,
  DirEntry,
  Terminal,
  TerminalProcess,
  SpawnOptions,
  Git,
  GitStatus,
  GitLogEntry,
  Brain,
  BrainSearchResult,
  BrainRecallResult,
  BrainGraphData,
  BrainGraphNode,
  BrainHealth,
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
  Missions,
  HealthReport,
  Lsp,
  CodeGraphPlatform,
} from './types.js';
import { normalizeRecall, classifyRecallLevel } from '../brain/context.js';
import { parseSynthesisPages, parseTree } from '../brain/wikiData.js';
import { enrichCaptureAuthor } from '../brain/captureAuthor.js';
import {
  readBrainReachableCache,
  type BrainReachableEntry,
} from './brainReachableCache.js';
import { BRAIN_RECALL_MAX_TOKENS } from '../brain/recallBudget.js';
import { dirEntriesFromSession } from './webSessionFs.js';

// ── Session FileSystem (empty until the user writes a file this session) ──

const FILE_CONTENTS: Map<string, string> = new Map();

function webWriteReject(method: string): Promise<never> {
  return Promise.reject(new Error(`[WebPlatform] fs.${method} not available in the browser`));
}

const webFs: FileSystem = {
  async readDir(path: string): Promise<DirEntry[]> {
    return dirEntriesFromSession(FILE_CONTENTS.keys(), path);
  },
  async readFile(path: string): Promise<string> {
    return FILE_CONTENTS.get(path) ?? '';
  },
  async writeFile(path: string, content: string): Promise<void> {
    FILE_CONTENTS.set(path, content);
  },
  rename(_oldPath: string, _newPath: string): Promise<void> {
    return webWriteReject('rename');
  },
  remove(_path: string): Promise<void> {
    return webWriteReject('remove');
  },
  createFile(_path: string): Promise<void> {
    return webWriteReject('createFile');
  },
  createDir(_path: string): Promise<void> {
    return webWriteReject('createDir');
  },
};

// ── Browser terminal (honest: no OS PTY) ─────────────────────────

const ANSI_RESET  = '\x1b[0m';
const ANSI_BOLD   = '\x1b[1m';
const ANSI_DIM    = '\x1b[2m';
const ANSI_GREEN  = '\x1b[32m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_CYAN   = '\x1b[36m';
const ANSI_VIOLET = '\x1b[35m';

const BROWSER_HINT = 'No project filesystem in the browser. Open the desktop app for a real terminal.';
const PROMPT = `${ANSI_GREEN}lazy${ANSI_RESET} ${ANSI_DIM}browser${ANSI_RESET} ${ANSI_VIOLET}$${ANSI_RESET} `;

function handleCommand(cmd: string, emit: (text: string) => void): void {
  const trimmed = cmd.trim();
  const [name, ...rest] = trimmed.split(/\s+/);

  switch (name) {
    case '':
      break;
    case 'help':
      emit(`${ANSI_BOLD}Lazy${ANSI_RESET} — ${BROWSER_HINT}\r\n`);
      emit(`  ${ANSI_CYAN}help${ANSI_RESET}  this message\r\n`);
      emit(`  ${ANSI_CYAN}echo${ANSI_RESET}  print text\r\n`);
      emit(`  ${ANSI_CYAN}clear${ANSI_RESET} clear the screen\r\n`);
      break;
    case 'ls':
    case 'pwd':
      emit(`${ANSI_YELLOW}${BROWSER_HINT}${ANSI_RESET}\r\n`);
      break;
    case 'echo':
      emit(rest.join(' ') + '\r\n');
      break;
    case 'clear':
      emit('\x1b[2J\x1b[H');
      break;
    default:
      if (name) emit(`${ANSI_YELLOW}${name}${ANSI_RESET}: not available in the browser\r\n`);
  }
}

function makeBrowserShell(): TerminalProcess {
  const dataCallbacks: Array<(data: string) => void> = [];
  const exitCallbacks: Array<(code: number) => void> = [];
  let inputBuffer = '';
  let dead = false;

  function emit(text: string): void {
    dataCallbacks.forEach(cb => cb(text));
  }

  setTimeout(() => {
    emit(
      `${ANSI_VIOLET}${ANSI_BOLD}Lazy${ANSI_RESET} — ${ANSI_DIM}${BROWSER_HINT}${ANSI_RESET}\r\n\r\n`
    );
    emit(PROMPT);
  }, 80);

  return {
    pid: 1000 + Math.floor(Math.random() * 9000),

    write(data: string): void {
      if (dead) return;

      for (const char of data) {
        const code = char.charCodeAt(0);

        if (char === '\r' || char === '\n') {
          emit('\r\n');
          const line = inputBuffer;
          inputBuffer = '';
          handleCommand(line, emit);
          emit(PROMPT);
        } else if (code === 127 || code === 8) {
          if (inputBuffer.length > 0) {
            inputBuffer = inputBuffer.slice(0, -1);
            emit('\b \b');
          }
        } else if (code >= 32) {
          inputBuffer += char;
          emit(char);
        }
      }
    },

    resize(_cols: number, _rows: number): void {
      /* no PTY in the browser */
    },

    kill(): void {
      dead = true;
      exitCallbacks.forEach(cb => cb(0));
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
}

const webTerminal: Terminal = {
  async spawn(_command: string, _args: string[], _opts?: SpawnOptions): Promise<TerminalProcess> {
    return makeBrowserShell();
  },
};

function webGitReject(method: string): Promise<never> {
  return Promise.reject(new Error(`[WebPlatform] git.${method} not available in the browser`));
}

const webGit: Git = {
  async status(_repoPath: string): Promise<GitStatus> {
    return { branch: '', ahead: 0, behind: 0, files: [] };
  },
  async diff(_repoPath: string, _filePath?: string): Promise<string> {
    return '';
  },
  commit(_repoPath: string, _message: string): Promise<void> {
    return webGitReject('commit');
  },
  stage(_repoPath: string, _paths: string[]): Promise<void> {
    return webGitReject('stage');
  },
  unstage(_repoPath: string, _paths: string[]): Promise<void> {
    return webGitReject('unstage');
  },
  push(_repoPath: string): Promise<void> {
    return webGitReject('push');
  },
  canPush(_repoPath: string): Promise<{ hasRemote: boolean; hasUpstream: boolean }> {
    return Promise.resolve({ hasRemote: false, hasUpstream: false });
  },
  orphanWorktrees(_repoPath: string): Promise<{
    recoverable: { name: string; headSha: string; containedInTarget: boolean }[];
    empty: { name: string; headSha: string; containedInTarget: boolean }[];
  }> {
    return Promise.resolve({ recoverable: [], empty: [] });
  },
  branches(_repoPath: string): Promise<string[]> {
    return webGitReject('branches');
  },
  log(_repoPath: string, _limit?: number): Promise<GitLogEntry[]> {
    return webGitReject('log');
  },
};

// ── Web mock capture store ────────────────────────────────────────
// Captures are stored in memory so Playwright tests can read them via
// page.evaluate(() => window.__lazyCaptures).

export interface StoredCapture {
  event: CaptureEvent;
  id: string;
  ts: number;
}

const _captureStore: StoredCapture[] = [];

/** Read captured events (used by tests / page.evaluate). */
export function getWebCaptures(): StoredCapture[] {
  return _captureStore;
}

// Expose on window for Playwright access
if (typeof window !== 'undefined') {
  window.__lazyCaptures = _captureStore;
}

// ── Brain proxy (connects to real LazyBrain serve if available) ───────────

const BRAIN_PORT = 7700;
const BRAIN_BASE = typeof window !== 'undefined'
  && (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost')
  && window.location.port !== String(BRAIN_PORT)
  ? ''  // Use relative URLs — Vite proxy handles CORS
  : `http://127.0.0.1:${BRAIN_PORT}`;

let brainReachableEntry: BrainReachableEntry | null = null;

async function checkBrainReachable(force = false): Promise<boolean> {
  const cached = readBrainReachableCache(brainReachableEntry, Date.now(), force);
  if (cached !== null) return cached;
  try {
    const resp = await fetch(`${BRAIN_BASE}/_api/search?q=test&top=1`, { method: 'GET', signal: AbortSignal.timeout(1500) });
    brainReachableEntry = { value: resp.ok, atMs: Date.now() };
    return resp.ok;
  } catch {
    brainReachableEntry = { value: false, atMs: Date.now() };
    return false;
  }
}

interface LbSearchHit {
  id: string;
  path: string;
  score: number;
  level: string;
  snippet: string;
  title?: string;
}

interface LbSearchResponse {
  query: string;
  topK: number;
  results: LbSearchHit[];
  totalMs: number;
}

async function brainRecall(query: string, sessionId?: string): Promise<BrainRecallResult> {
  const session = sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : '';
  const resp = await fetch(
    `${BRAIN_BASE}/_api/recall?q=${encodeURIComponent(query)}&maxTokens=${BRAIN_RECALL_MAX_TOKENS}&nudge=tool${session}`,
    { method: 'GET', signal: AbortSignal.timeout(15_000) },
  );
  if (!resp.ok) throw new Error(`brain recall HTTP ${resp.status}`);
  const data = JSON.parse(await resp.text()) as { text?: string; level?: string | null };
  const text = data.text ?? '';
  return normalizeRecall({
    nodes: text
      ? [{ id: 'recall-context', title: 'Recalled context', snippet: text.slice(0, 300), score: 1 }]
      : [],
    tokensSaved: 0,
    injectedContext: text,
    level: classifyRecallLevel(data.level),
  });
}

async function brainSearch(query: string, limit?: number): Promise<BrainSearchResult[]> {
  const top = limit ?? 5;
  const resp = await fetch(`${BRAIN_BASE}/_api/search?q=${encodeURIComponent(query)}&top=${top}`, {
    method: 'GET',
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) throw new Error(`brain search HTTP ${resp.status}`);
  const data = JSON.parse(await resp.text()) as LbSearchResponse;
  return data.results.map(r => ({
    id: r.id,
    title: r.title ?? r.id,
    snippet: r.snippet ?? '',
    score: r.score,
    cluster: r.path,
  }));
}

// ── Brain-path transparency (BRAIN-PATH TRANSPARENCY) ─────────────
//
// Mirrors src/lib/platform/tauri.ts's `BrainInfo` (which matches Rust's
// `get_brain_info` command). `info()` is intentionally NOT added to the
// shared `Brain` interface in ./types — out of scope for this change — so
// it is attached directly to `webBrain` below via a widened local type,
// same as the native implementation.

export interface BrainInfo {
  path: string;
  source: 'env_override' | 'ui_config' | 'project' | 'home_fallback';
}

// ── UI-persisted brain choice (no env var required) ───────────────
//
// Mirrors src/lib/platform/tauri.ts's BrainSetConfigOptions/
// BrainImportFromGithubOptions (which match Rust's `set_brain_config` /
// `import_brain_from_github` commands). Same convention as BrainInfo above:
// not part of the shared `Brain` interface, attached to `webBrain` via a
// widened local type. Both require real filesystem/git/process access that
// doesn't exist in a browser, so the web implementations are honest
// rejections — same convention as `publishGithub`/`seedBrain` below.

export interface BrainSetConfigOptions {
  mode: 'project' | 'global' | 'custom';
  path?: string;
}

export interface BrainImportFromGithubOptions {
  url: string;
  dest: string;
}

// ── Brain publish to GitHub ────────────────────────────────────────
//
// Mirrors src/lib/platform/tauri.ts's BrainPublishOptions/BrainPublishResult
// (which match Rust's `brain_publish_github` command). Same convention as
// BrainInfo above: not part of the shared `Brain` interface, attached to
// `webBrain` via a widened local type.

export interface BrainPublishOptions {
  remoteUrl?: string;
  // No visibility flag — see src/lib/platform/tauri.ts's BrainPublishOptions
  // doc comment: the brain must never be publishable to a public repo.
}

export interface BrainPublishResult {
  ok: boolean;
  url?: string;
  message: string;
}

const EMPTY_GRAPH: BrainGraphData = { nodes: [], edges: [] };
const EMPTY_TREE: BrainTree = { projects: [] };

interface SidecarGraphNode {
  id: string;
  title: string;
  type?: string | null;
  topic?: string | null;
  cluster?: string;
  importance?: number;
  created?: string | null;
}

interface SidecarGraphEdge {
  from?: string;
  to?: string;
  source?: string;
  target?: string;
  type: string;
}

function mapSidecarGraph(raw: { nodes?: SidecarGraphNode[]; edges?: SidecarGraphEdge[] }): BrainGraphData {
  const nodes: BrainGraphNode[] = (raw.nodes ?? []).map((n) => ({
    id: n.id,
    title: n.title,
    type: n.type ?? 'concept',
    cluster: n.cluster ?? (n.topic ? n.topic.split('/')[0].toLowerCase() : 'unknown'),
    importance: n.importance ?? 0.5,
    created: n.created ?? null,
  }));
  const ids = new Set(nodes.map((n) => n.id));
  const edges = (raw.edges ?? [])
    .map((e) => ({
      source: e.from ?? e.source ?? '',
      target: e.to ?? e.target ?? '',
      type: e.type,
    }))
    .filter((e) => ids.has(e.source) && ids.has(e.target));
  return { nodes, edges };
}

async function fetchJson<T>(path: string): Promise<T> {
  const resp = await fetch(`${BRAIN_BASE}${path}`, {
    method: 'GET',
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`brain ${path} HTTP ${resp.status}`);
  return await resp.json() as T;
}

async function fetchText(path: string): Promise<string | null> {
  const resp = await fetch(`${BRAIN_BASE}${path}`, {
    method: 'GET',
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) return null;
  return await resp.text();
}

async function brainGraph(): Promise<BrainGraphData> {
  const raw = await fetchJson<{ nodes?: SidecarGraphNode[]; edges?: SidecarGraphEdge[] }>('/_api/graph');
  return mapSidecarGraph(raw);
}

// ── Brain (sidecar when reachable, otherwise empty — never a canned vault) ──

const webBrain: Brain & {
  info(): Promise<BrainInfo>;
  publishGithub(opts?: BrainPublishOptions): Promise<BrainPublishResult>;
  setConfig(opts: BrainSetConfigOptions): Promise<BrainInfo>;
  importFromGithub(opts: BrainImportFromGithubOptions): Promise<BrainInfo>;
} = {
  async search(query: string, limit?: number): Promise<BrainSearchResult[]> {
    if (await checkBrainReachable()) {
      return brainSearch(query, limit);
    }
    return [];
  },
  async recall(context: string, sessionId?: string): Promise<BrainRecallResult> {
    if (await checkBrainReachable()) {
      try {
        return await brainRecall(context, sessionId);
      } catch {
        const nodes = await brainSearch(context, 10);
        return normalizeRecall({ nodes, tokensSaved: 0, injectedContext: '' });
      }
    }
    return normalizeRecall({
      nodes: [],
      tokensSaved: 0,
      injectedContext: '',
    });
  },
  async store(_title: string, _content: string, _tags?: string[]): Promise<string> {
    throw new Error('brain.store requires a reachable sidecar');
  },

  async capture(event: CaptureEvent): Promise<CaptureResult> {
    // Every capture path gets author attribution (same as tauri.ts).
    const stamped = await enrichCaptureAuthor(event);
    // Web mock: record into in-memory store + console.debug for testability.
    const id = `mock-capture-${event.kind}-${Date.now()}`;
    const stored: StoredCapture = { event: stamped, id, ts: Date.now() };
    _captureStore.push(stored);
    console.debug('[WebPlatform] brain.capture recorded:', stamped);
    return { id, path: `/mock/${id}.html`, sizeBytes: 0, attrsCount: 0 };
  },
  async graph(): Promise<BrainGraphData> {
    if (!(await checkBrainReachable())) return EMPTY_GRAPH;
    try {
      return await brainGraph();
    } catch {
      return EMPTY_GRAPH;
    }
  },
  async rebuildGraph(): Promise<void> {
    // Web mock: no-op (no daemon to rebuild).
    console.debug('[WebPlatform] brain.rebuildGraph (no-op in browser)');
  },

  async ingestProject(): Promise<void> {
    // No-op: the browser has no project filesystem to code-scan.
    console.debug('[WebPlatform] brain.ingestProject (no-op in browser)');
  },

  async note(id: string): Promise<BrainNoteMeta> {
    const json = await fetchJson<BrainNoteMeta>(`/_api/note-meta/${encodeURIComponent(id)}`);
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
      return await fetchText(`/_api/note/${encodeURIComponent(id)}`);
    } catch {
      return null;
    }
  },

  async tree(): Promise<BrainTree> {
    if (!(await checkBrainReachable())) return EMPTY_TREE;
    try {
      return parseTree(await fetchJson<unknown>('/_api/tree'));
    } catch {
      return EMPTY_TREE;
    }
  },

  async synthesisIndex(): Promise<BrainSynthesisIndex | null> {
    if (!(await checkBrainReachable())) return null;
    try {
      const html = await fetchText('/_api/synthesis/index');
      if (!html) return null;
      return { html, pages: parseSynthesisPages(html) };
    } catch {
      return null;
    }
  },

  async synthesisTopic(topic: string): Promise<string | null> {
    if (!(await checkBrainReachable())) return null;
    try {
      return await fetchText(`/_api/synthesis/${encodeURIComponent(topic)}`);
    } catch {
      return null;
    }
  },

  async backlinks(_nodeId: string): Promise<string[]> {
    // Provenance queries need the desktop sidecar.
    return [];
  },

  async neighbors(_nodeId: string): Promise<string[]> {
    return [];
  },

  async queryCss(_selector: string, _limit?: number): Promise<string> {
    return 'Structural brain query is not available in the browser.';
  },

  async neighbours(_id: string): Promise<string> {
    return 'Structural brain neighbours is not available in the browser.';
  },

  async searchScoped(query: string, _scope: BrainScope, limit?: number): Promise<BrainSearchResult[]> {
    return webBrain.search(query, limit);
  },

  async recallScoped(query: string, _scope: BrainScope, sessionId?: string): Promise<BrainRecallResult> {
    return webBrain.recall(query, sessionId);
  },

  async graphAll(): Promise<BrainGraphData> {
    return webBrain.graph();
  },

  async health(): Promise<BrainHealth | null> {
    // Health lives in the sidecar's _index.html meta tag (Tauri path).
    // There is no honest HTTP equivalent here — never invent a 100 score.
    return null;
  },

  async retrySidecar(): Promise<boolean> {
    // Web: no process to respawn. Force a fresh probe so a sidecar that
    // started after the first failed check is actually seen (TTL cache
    // would otherwise keep a stale miss).
    return checkBrainReachable(true);
  },

  async getProjects(): Promise<string[]> {
    // Web mock: no config file — empty list.
    return [];
  },

  async setProjects(_paths: string[]): Promise<void> {
    // Web mock: no-op.
  },

  // ── History import (CONTRACT-G2) ──────────────────────────────

  async detectHistorySources(): Promise<HistorySource[]> {
    // Web mock: no filesystem access in browser — honest empty list.
    return [];
  },

  async seedEstimate(_sources: string[]): Promise<SeedEstimate> {
    // Web mock: no CLI access — honest zero estimate, no backend available.
    return { items: 0, estTokens: 0, estMinutes: 0, backend: undefined, llmAvailable: false };
  },

  seedBrain(
    _opts: { sources: string[]; useLlm: boolean; since?: string; projectRoot?: string }
  ): Promise<{ imported: number; skipped: number }> {
    // Web mock: honest rejection — seeding requires the Tauri native sidecar.
    return Promise.reject(new Error('not available in the browser'));
  },

  onSeedProgress(_cb: (p: SeedProgressEvent) => void): () => void {
    // Web mock: no events — return a no-op unsubscribe function.
    return () => { /* no-op */ };
  },

  async startupContext(_cwd: string): Promise<string> {
    // Web: no sidecar available — return empty string.
    return '';
  },

  async info(): Promise<BrainInfo> {
    // Honest: report the sidecar URL the browser actually talks to, or
    // an explicit unreachable marker. Never a canned demo path.
    const reachable = await checkBrainReachable();
    return {
      path: reachable
        ? (BRAIN_BASE || `http://127.0.0.1:${BRAIN_PORT}`)
        : '(no brain server reachable)',
      source: 'project',
    };
  },

  publishGithub(_opts?: BrainPublishOptions): Promise<BrainPublishResult> {
    // Web mock: no filesystem/git access in the browser — honest rejection,
    // same convention as seedBrain() for native-only operations.
    return Promise.reject(
      new Error('brain.publishGithub not available in the browser — requires the Tauri desktop app'),
    );
  },

  setConfig(_opts: BrainSetConfigOptions): Promise<BrainInfo> {
    // Web mock: no filesystem/process access in the browser to persist a
    // brain-config.json or restart a sidecar — honest rejection.
    return Promise.reject(
      new Error('brain.setConfig not available in the browser — requires the Tauri desktop app'),
    );
  },

  importFromGithub(_opts: BrainImportFromGithubOptions): Promise<BrainInfo> {
    // Web mock: no git/filesystem access in the browser — honest rejection.
    return Promise.reject(
      new Error('brain.importFromGithub not available in the browser — requires the Tauri desktop app'),
    );
  },
};

// ── Web Tests (not available in browser) ─────────────────────────

const webTests: Tests = {
  run(_repoPath: string): Promise<never> {
    return Promise.reject(
      new Error('[WebPlatform] tests.run not available in the browser — requires Tauri native runner')
    );
  },
};

// ── Web Missions persistence (localStorage) ───────────────────────

const MISSIONS_LS_KEY = 'lazy:missions';

const webMissions: Missions = {
  async save(_projectRoot: string, data: unknown): Promise<void> {
    try {
      localStorage.setItem(MISSIONS_LS_KEY, JSON.stringify(data));
    } catch (err) {
      throw new Error(`[WebPlatform] missions.save failed: ${String(err)}`, { cause: err });
    }
  },

  async load(_projectRoot: string): Promise<unknown | null> {
    try {
      const raw = localStorage.getItem(MISSIONS_LS_KEY);
      if (raw === null) return null;
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  },
};

// ── Web Health (honest about browser limits) ──────────────────────

async function webHealth(): Promise<HealthReport> {
  return {
    brain: 'unknown',
    git: 'unknown',
    terminal: 'unknown',
    model: 'unknown',
    agentRunner: 'down',
    details: {
      note: 'Running in the browser — native filesystem, git, and terminal are unavailable',
    },
  };
}

// ── Web LSP (not available in browser — honest stub) ─────────────

const webLsp: Lsp = {
  available(_language: string): Promise<boolean> {
    return Promise.resolve(false);
  },
  start(_repoPath: string, _language: string): Promise<boolean> {
    return Promise.resolve(false);
  },
  request(_repoPath: string, _language: string, _method: string, _params: unknown): Promise<unknown> {
    return Promise.reject(new Error('[WebPlatform] LSP not available in the browser'));
  },
  notify(_repoPath: string, _language: string, _method: string, _params: unknown): Promise<void> {
    return Promise.resolve();
  },
  onMessage(_cb: (msg: { method: string; params: unknown }) => void): () => void {
    return () => { /* no-op */ };
  },
};

// ── WebPlatform export ────────────────────────────────────────────

// ── CodeGraph (web mock — honest empty results) ───────────────────

const webCodeGraph: CodeGraphPlatform = {
  async index() {
    return { nodeCount: 0, edgeCount: 0, skipped: true };
  },
  async query() {
    return [];
  },
  async context() {
    return null;
  },
  async impact() {
    return { target: '', totalAffected: 0, riskLevel: 'low', levels: [] };
  },
  async trace() {
    return { from: '', to: '', found: false, path: [] };
  },
  async detectChanges() {
    return { changedSymbols: [], affectedProcesses: [], affectedClusters: [], riskLevel: 'low' };
  },
  async renamePreview() {
    return { filesAffected: 0, totalEdits: 0, graphEdits: 0, textSearchEdits: 0, changes: [] };
  },
  async staleness() {
    return { isStale: false, lastCommit: null, currentCommit: null, reason: 'No code graph in browser' };
  },
  async listRepos() {
    return [];
  },
  async generateSkills() {
    return [];
  },
  async watchStart() {
    return { ok: false, message: 'No file watching in browser' };
  },
  async watchStop() {},
  async incrementalInfo() {
    return null;
  },
};

export const WebPlatform: Platform = {
  name: 'web',
  fs: webFs,
  terminal: webTerminal,
  git: webGit,
  brain: webBrain,
  tests: webTests,
  missions: webMissions,
  lsp: webLsp,
  codegraph: webCodeGraph,
  health: webHealth,
};
