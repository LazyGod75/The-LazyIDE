#!/usr/bin/env node
/**
 * seed-dev-brain.mjs — Seed ~27 neurons for the Lazy IDE dev brain.
 * Clusters: editor, agents, brain, tauri, models
 * Run: node scripts/seed-dev-brain.mjs
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BRAIN = path.join(ROOT, '.lazybrain', 'brain');
const CLI = process.env.LAZYBRAIN_CLI || path.resolve(__dirname, '../../LazyBrain/dist/bin/lazybrain.js');

function store(html) {
  // Inject data-cerveau-source if absent (required by LazyBrain schema)
  const withSource = html.includes('data-cerveau-source')
    ? html
    : html.replace('<article ', '<article data-cerveau-source="session:lazy-ide-seed#001" ');
  execSync(`node "${CLI}" --brain "${BRAIN}" store --from-stdin`, {
    input: withSource,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}

function link(fromId, toId, type = 'relates-to') {
  try {
    execSync(`node "${CLI}" --brain "${BRAIN}" link "${fromId}" "${toId}" --type "${type}"`, {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  } catch {
    // link may fail if id not found — non-fatal
  }
}

// ── CLUSTER: editor ───────────────────────────────────────────────

store(`<article id="lazy-editor-codemirror6"
  data-cerveau-version="0.1.0"
  data-cerveau-created="2026-06-10T09:00:00Z"
  data-cerveau-type="decision"
  data-cerveau-source="session:lazy-ide-seed#editor"
  data-cerveau-topic="editor"
  data-cerveau-tier="working"
  data-cerveau-importance="0.95"
  data-cerveau-tags="editor codemirror6 typescript react"
  data-cerveau-valid-from="2026-06-10">
  <h2>Editor engine: CodeMirror 6</h2>
  <p data-cerveau-fact="" data-cerveau-confidence="1.0" data-cerveau-extracted-by="human" data-cerveau-kind="decision">
    Decision: use CodeMirror 6 (not Monaco) as the editor engine. CM6 is modular, ESM-native, and ships smaller bundles. Monaco is too heavy for Tauri desktop.
  </p>
  <p data-cerveau-fact="" data-cerveau-confidence="0.9" data-cerveau-extracted-by="human" data-cerveau-kind="rationale">
    Bundled via @uiw/react-codemirror wrapper. Languages: JS/TS, Python, Rust, HTML, CSS, JSON, Markdown.
  </p>
</article>`);

store(`<article id="lazy-editor-vim-mode"
  data-cerveau-version="0.1.0"
  data-cerveau-created="2026-06-11T09:00:00Z"
  data-cerveau-type="decision"
  data-cerveau-topic="editor"
  data-cerveau-tier="working"
  data-cerveau-importance="0.75"
  data-cerveau-tags="editor vim keybindings codemirror"
  data-cerveau-valid-from="2026-06-11">
  <h2>Vim keybindings via @codemirror/vim</h2>
  <p data-cerveau-fact="" data-cerveau-confidence="0.9" data-cerveau-extracted-by="human" data-cerveau-kind="decision">
    Vim mode is opt-in via settings toggle. Uses @codemirror/vim extension — full normal/insert/visual mode support.
  </p>
</article>`);

store(`<article id="lazy-editor-lsp"
  data-cerveau-version="0.1.0"
  data-cerveau-created="2026-06-12T09:00:00Z"
  data-cerveau-type="concept"
  data-cerveau-topic="editor"
  data-cerveau-tier="working"
  data-cerveau-importance="0.80"
  data-cerveau-tags="editor lsp typescript diagnostics"
  data-cerveau-valid-from="2026-06-12">
  <h2>LSP integration — TypeScript language server</h2>
  <p data-cerveau-fact="" data-cerveau-confidence="0.85" data-cerveau-extracted-by="human" data-cerveau-kind="concept">
    Plan: embed tsserver via Web Workers (not native) for diagnostics + completion in the first milestone. Native LSP via Rust sidecar deferred to P12.
  </p>
</article>`);

store(`<article id="lazy-editor-tabs"
  data-cerveau-version="0.1.0"
  data-cerveau-created="2026-06-13T09:00:00Z"
  data-cerveau-type="decision"
  data-cerveau-topic="editor"
  data-cerveau-tier="working"
  data-cerveau-importance="0.70"
  data-cerveau-tags="editor tabs editorstore zustand"
  data-cerveau-valid-from="2026-06-13">
  <h2>Multi-tab editor via editorStore (Zustand)</h2>
  <p data-cerveau-fact="" data-cerveau-confidence="0.95" data-cerveau-extracted-by="human" data-cerveau-kind="decision">
    editorStore manages open tabs (path, filename, content, isModified). No external dependency — plain Zustand slice. Max 12 pinned tabs before overflow.
  </p>
</article>`);

store(`<article id="lazy-editor-syntax-highlight"
  data-cerveau-version="0.1.0"
  data-cerveau-created="2026-06-14T09:00:00Z"
  data-cerveau-type="concept"
  data-cerveau-topic="editor"
  data-cerveau-tier="working"
  data-cerveau-importance="0.65"
  data-cerveau-tags="editor syntax highlight themes violet"
  data-cerveau-valid-from="2026-06-14">
  <h2>Syntax highlighting — Violet Dark theme</h2>
  <p data-cerveau-fact="" data-cerveau-confidence="0.9" data-cerveau-extracted-by="human" data-cerveau-kind="concept">
    Custom CM6 theme: violet (#7C5CFF) accent, dark (#04040A) background, soft contrast. Overrides OneDark base palette.
  </p>
</article>`);

// ── CLUSTER: agents ───────────────────────────────────────────────

store(`<article id="lazy-agents-architecture"
  data-cerveau-version="0.1.0"
  data-cerveau-created="2026-06-10T10:00:00Z"
  data-cerveau-type="concept"
  data-cerveau-topic="agents"
  data-cerveau-tier="working"
  data-cerveau-importance="0.90"
  data-cerveau-tags="agents orchestration missions parallel tauri"
  data-cerveau-valid-from="2026-06-10">
  <h2>Agent orchestration architecture</h2>
  <p data-cerveau-fact="" data-cerveau-confidence="0.95" data-cerveau-extracted-by="human" data-cerveau-kind="concept">
    Agents are spawned as PTY subprocesses via Rust. Each mission = one agent process. AgentsSpace shows real-time output with mission panels and step timelines.
  </p>
</article>`);

store(`<article id="lazy-agents-missions"
  data-cerveau-version="0.1.0"
  data-cerveau-created="2026-06-11T10:00:00Z"
  data-cerveau-type="concept"
  data-cerveau-topic="agents"
  data-cerveau-tier="working"
  data-cerveau-importance="0.85"
  data-cerveau-tags="agents missions tasks steps parallel"
  data-cerveau-valid-from="2026-06-11">
  <h2>Agent missions and step model</h2>
  <p data-cerveau-fact="" data-cerveau-confidence="0.9" data-cerveau-extracted-by="human" data-cerveau-kind="concept">
    A mission has: title, status (idle/running/done/error), steps[]. Each step has a type (plan/tool/code/result) and ANSI output stream. Steps are immutable once added.
  </p>
</article>`);

store(`<article id="lazy-agents-bug-pty-windows"
  data-cerveau-version="0.1.0"
  data-cerveau-created="2026-06-12T10:00:00Z"
  data-cerveau-type="bug"
  data-cerveau-topic="agents"
  data-cerveau-tier="working"
  data-cerveau-importance="0.80"
  data-cerveau-tags="agents pty windows rust portable-pty"
  data-cerveau-valid-from="2026-06-12">
  <h2>Bug: PTY resize on Windows hangs agent output</h2>
  <p data-cerveau-fact="" data-cerveau-confidence="0.9" data-cerveau-extracted-by="human" data-cerveau-kind="bug">
    portable-pty resize on Windows blocks the Rust thread when the ConPTY pipe buffer is full. Workaround: debounce resize calls to 200ms + non-blocking write.
  </p>
</article>`);

store(`<article id="lazy-agents-tool-calls"
  data-cerveau-version="0.1.0"
  data-cerveau-created="2026-06-13T10:00:00Z"
  data-cerveau-type="concept"
  data-cerveau-topic="agents"
  data-cerveau-tier="working"
  data-cerveau-importance="0.85"
  data-cerveau-tags="agents tool-use claude anthropic streaming"
  data-cerveau-valid-from="2026-06-13">
  <h2>Agent tool call rendering</h2>
  <p data-cerveau-fact="" data-cerveau-confidence="0.9" data-cerveau-extracted-by="human" data-cerveau-kind="concept">
    Tool calls (read_file, write_file, bash, search) appear as collapsible step pills in AgentsSpace. Tool input/output shown on expand. Streaming rendered token by token.
  </p>
</article>`);

store(`<article id="lazy-agents-context-injection"
  data-cerveau-version="0.1.0"
  data-cerveau-created="2026-06-14T10:00:00Z"
  data-cerveau-type="decision"
  data-cerveau-topic="agents"
  data-cerveau-tier="working"
  data-cerveau-importance="0.80"
  data-cerveau-tags="agents brain context injection recall"
  data-cerveau-valid-from="2026-06-14">
  <h2>Brain context injection into agent system prompt</h2>
  <p data-cerveau-fact="" data-cerveau-confidence="0.9" data-cerveau-extracted-by="human" data-cerveau-kind="decision">
    Before spawning each agent, call brain.recall(missionTitle) to inject top-10 relevant neurons into the system prompt. Saves ~3-5k tokens per call.
  </p>
</article>`);

// ── CLUSTER: brain ────────────────────────────────────────────────

store(`<article id="lazy-brain-sidecar-design"
  data-cerveau-version="0.1.0"
  data-cerveau-created="2026-06-10T11:00:00Z"
  data-cerveau-type="decision"
  data-cerveau-topic="brain"
  data-cerveau-tier="working"
  data-cerveau-importance="0.95"
  data-cerveau-tags="brain lazybrain sidecar node tauri rust"
  data-cerveau-valid-from="2026-06-10">
  <h2>LazyBrain as Tauri sidecar (Node.js subprocess)</h2>
  <p data-cerveau-fact="" data-cerveau-confidence="1.0" data-cerveau-extracted-by="human" data-cerveau-kind="decision">
    LazyBrain runs as a Node.js sidecar supervised by Rust (tauri-plugin-shell). Port 37990 fixed. HTTP client in tauri.ts calls /_api/* endpoints. Brain path: .lazybrain/brain.
  </p>
</article>`);

store(`<article id="lazy-brain-graph3d"
  data-cerveau-version="0.1.0"
  data-cerveau-created="2026-06-11T11:00:00Z"
  data-cerveau-type="concept"
  data-cerveau-topic="brain"
  data-cerveau-tier="working"
  data-cerveau-importance="0.85"
  data-cerveau-tags="brain 3d-graph threejs bloom particles tauri"
  data-cerveau-valid-from="2026-06-11">
  <h2>BrainGraph3D — Three.js neural graph</h2>
  <p data-cerveau-fact="" data-cerveau-confidence="0.95" data-cerveau-extracted-by="human" data-cerveau-kind="concept">
    BrainGraph3D uses Three.js + UnrealBloomPass (strength 0.6, threshold 0.25). Cluster-colored nodes, halo sprites, Bezier particle edges. No HUD rings. Auto-orbit + click-to-fly.
  </p>
</article>`);

store(`<article id="lazy-brain-wiki-panel"
  data-cerveau-version="0.1.0"
  data-cerveau-created="2026-06-12T11:00:00Z"
  data-cerveau-type="concept"
  data-cerveau-topic="brain"
  data-cerveau-tier="working"
  data-cerveau-importance="0.80"
  data-cerveau-tags="brain wiki panel node-detail links"
  data-cerveau-valid-from="2026-06-12">
  <h2>BrainWiki — node detail panel</h2>
  <p data-cerveau-fact="" data-cerveau-confidence="0.9" data-cerveau-extracted-by="human" data-cerveau-kind="concept">
    Right panel shows: type pill, status badge, title, meta, tags, body, links, files, temporal validity, cluster box, action buttons. Data comes from note-meta endpoint.
  </p>
</article>`);

store(`<article id="lazy-brain-recall-api"
  data-cerveau-version="0.1.0"
  data-cerveau-created="2026-06-13T11:00:00Z"
  data-cerveau-type="concept"
  data-cerveau-topic="brain"
  data-cerveau-tier="working"
  data-cerveau-importance="0.90"
  data-cerveau-tags="brain recall search api http"
  data-cerveau-valid-from="2026-06-13">
  <h2>Brain HTTP API — search and recall</h2>
  <p data-cerveau-fact="" data-cerveau-confidence="0.95" data-cerveau-extracted-by="human" data-cerveau-kind="concept">
    /_api/search?q=&amp;top= returns { results: [{id, score, snippet}] }. /_api/graph returns { nodes, edges }. /_api/note-meta/:id returns note metadata JSON.
  </p>
</article>`);

store(`<article id="lazy-brain-cluster-palette"
  data-cerveau-version="0.1.0"
  data-cerveau-created="2026-06-14T11:00:00Z"
  data-cerveau-type="decision"
  data-cerveau-topic="brain"
  data-cerveau-tier="working"
  data-cerveau-importance="0.70"
  data-cerveau-tags="brain clusters colors palette threejs"
  data-cerveau-valid-from="2026-06-14">
  <h2>Cluster color palette for 3D graph</h2>
  <p data-cerveau-fact="" data-cerveau-confidence="0.9" data-cerveau-extracted-by="human" data-cerveau-kind="decision">
    Palette: editor=#9B7CFF, agents=#4FC3F7, brain=#66E27A, tauri=#FFC76B, models=#FF7BB0, _default=#888888. Real cluster names from LazyBrain topic field.
  </p>
</article>`);

// ── CLUSTER: tauri ────────────────────────────────────────────────

store(`<article id="lazy-tauri-architecture"
  data-cerveau-version="0.1.0"
  data-cerveau-created="2026-06-10T12:00:00Z"
  data-cerveau-type="concept"
  data-cerveau-topic="tauri"
  data-cerveau-tier="working"
  data-cerveau-importance="0.95"
  data-cerveau-tags="tauri rust frontend react vite architecture"
  data-cerveau-valid-from="2026-06-10">
  <h2>Tauri v2 architecture — Rust + React</h2>
  <p data-cerveau-fact="" data-cerveau-confidence="1.0" data-cerveau-extracted-by="human" data-cerveau-kind="concept">
    Frontend: React 19 + Vite 6 + TypeScript (browser). Backend: Rust (Tauri v2). IPC via invoke(). Platform abstraction: TauriPlatform (desktop) vs WebPlatform (browser dev).
  </p>
</article>`);

store(`<article id="lazy-tauri-invoke-bridge"
  data-cerveau-version="0.1.0"
  data-cerveau-created="2026-06-11T12:00:00Z"
  data-cerveau-type="concept"
  data-cerveau-topic="tauri"
  data-cerveau-tier="working"
  data-cerveau-importance="0.85"
  data-cerveau-tags="tauri invoke ipc commands rust"
  data-cerveau-valid-from="2026-06-11">
  <h2>Tauri invoke bridge — Rust commands</h2>
  <p data-cerveau-fact="" data-cerveau-confidence="0.95" data-cerveau-extracted-by="human" data-cerveau-kind="concept">
    Commands: read_dir, read_file, write_file, terminal_spawn/write/resize/kill, git_status/diff, get_brain_port, get_project_root. All async, return serde-JSON.
  </p>
</article>`);

store(`<article id="lazy-tauri-bug-csp"
  data-cerveau-version="0.1.0"
  data-cerveau-created="2026-06-12T12:00:00Z"
  data-cerveau-type="bug"
  data-cerveau-topic="tauri"
  data-cerveau-tier="working"
  data-cerveau-importance="0.78"
  data-cerveau-tags="tauri csp webview security brain-fetch"
  data-cerveau-valid-from="2026-06-12">
  <h2>Bug: Tauri CSP blocks brain fetch to 127.0.0.1</h2>
  <p data-cerveau-fact="" data-cerveau-confidence="0.9" data-cerveau-extracted-by="human" data-cerveau-kind="bug">
    Tauri CSP must include connect-src http://127.0.0.1:37990 or the brain HTTP client fetch() is blocked. Fixed in tauri.conf.json CSP header.
  </p>
</article>`);

store(`<article id="lazy-tauri-permissions"
  data-cerveau-version="0.1.0"
  data-cerveau-created="2026-06-13T12:00:00Z"
  data-cerveau-type="concept"
  data-cerveau-topic="tauri"
  data-cerveau-tier="working"
  data-cerveau-importance="0.80"
  data-cerveau-tags="tauri permissions capabilities shell fs"
  data-cerveau-valid-from="2026-06-13">
  <h2>Tauri v2 capabilities and permissions</h2>
  <p data-cerveau-fact="" data-cerveau-confidence="0.9" data-cerveau-extracted-by="human" data-cerveau-kind="concept">
    Capabilities declared in src-tauri/capabilities/default.json: shell:allow-execute (for sidecar), fs:read-all, fs:write-all, core:default. No wildcard permissions.
  </p>
</article>`);

store(`<article id="lazy-tauri-sidecar-lifecycle"
  data-cerveau-version="0.1.0"
  data-cerveau-created="2026-06-14T12:00:00Z"
  data-cerveau-type="concept"
  data-cerveau-topic="tauri"
  data-cerveau-tier="working"
  data-cerveau-importance="0.85"
  data-cerveau-tags="tauri sidecar brain lifecycle startup shutdown"
  data-cerveau-valid-from="2026-06-14">
  <h2>Brain sidecar lifecycle management</h2>
  <p data-cerveau-fact="" data-cerveau-confidence="0.95" data-cerveau-extracted-by="human" data-cerveau-kind="concept">
    Sidecar spawned in setup() hook. Port 37990 polled until ready (max 10s, 200ms intervals). On app exit, Rust sends SIGTERM and awaits exit. PID stored for cleanup.
  </p>
</article>`);

store(`<article id="lazy-tauri-git-gitoxide"
  data-cerveau-version="0.1.0"
  data-cerveau-created="2026-06-15T12:00:00Z"
  data-cerveau-type="decision"
  data-cerveau-topic="tauri"
  data-cerveau-tier="working"
  data-cerveau-importance="0.75"
  data-cerveau-tags="tauri git gitoxide rust status diff"
  data-cerveau-valid-from="2026-06-15">
  <h2>Git integration via gitoxide (Rust)</h2>
  <p data-cerveau-fact="" data-cerveau-confidence="0.85" data-cerveau-extracted-by="human" data-cerveau-kind="decision">
    git_status uses gitoxide for performance. git_diff falls back to CLI (git diff). Commit not yet implemented — deferred to P10.
  </p>
</article>`);

// ── CLUSTER: models ───────────────────────────────────────────────

store(`<article id="lazy-models-anthropic"
  data-cerveau-version="0.1.0"
  data-cerveau-created="2026-06-10T13:00:00Z"
  data-cerveau-type="decision"
  data-cerveau-topic="models"
  data-cerveau-tier="working"
  data-cerveau-importance="0.90"
  data-cerveau-tags="models anthropic claude sonnet haiku opus streaming"
  data-cerveau-valid-from="2026-06-10">
  <h2>Model provider: Anthropic Claude (primary)</h2>
  <p data-cerveau-fact="" data-cerveau-confidence="1.0" data-cerveau-extracted-by="human" data-cerveau-kind="decision">
    Primary provider: Anthropic. Models: claude-sonnet-4-6 (coding), claude-haiku-4-5 (agents/fast), claude-opus-4-8 (reasoning). ANTHROPIC_API_KEY in env only — never hardcoded.
  </p>
</article>`);

store(`<article id="lazy-models-streaming"
  data-cerveau-version="0.1.0"
  data-cerveau-created="2026-06-11T13:00:00Z"
  data-cerveau-type="concept"
  data-cerveau-topic="models"
  data-cerveau-tier="working"
  data-cerveau-importance="0.85"
  data-cerveau-tags="models streaming sse chunks assistant"
  data-cerveau-valid-from="2026-06-11">
  <h2>SSE streaming — token-by-token assistant output</h2>
  <p data-cerveau-fact="" data-cerveau-confidence="0.9" data-cerveau-extracted-by="human" data-cerveau-kind="concept">
    Assistant responses stream via @anthropic-ai/sdk stream(). Each token calls onChunk({text, done}). AssistantStore accumulates chunks, updates UI immutably per frame.
  </p>
</article>`);

store(`<article id="lazy-models-gateway"
  data-cerveau-version="0.1.0"
  data-cerveau-created="2026-06-12T13:00:00Z"
  data-cerveau-type="concept"
  data-cerveau-topic="models"
  data-cerveau-tier="working"
  data-cerveau-importance="0.80"
  data-cerveau-tags="models gateway abstraction multi-provider"
  data-cerveau-valid-from="2026-06-12">
  <h2>ModelGateway abstraction layer</h2>
  <p data-cerveau-fact="" data-cerveau-confidence="0.9" data-cerveau-extracted-by="human" data-cerveau-kind="concept">
    ModelGateway interface: listModels() + stream(). TauriPlatform.models will wire Anthropic SDK (P6). WebPlatform.models returns mock responses for browser dev mode.
  </p>
</article>`);

store(`<article id="lazy-models-context-management"
  data-cerveau-version="0.1.0"
  data-cerveau-created="2026-06-13T13:00:00Z"
  data-cerveau-type="decision"
  data-cerveau-topic="models"
  data-cerveau-tier="working"
  data-cerveau-importance="0.80"
  data-cerveau-tags="models context-window brain tokens economy"
  data-cerveau-valid-from="2026-06-13">
  <h2>Context window management strategy</h2>
  <p data-cerveau-fact="" data-cerveau-confidence="0.9" data-cerveau-extracted-by="human" data-cerveau-kind="decision">
    Brain recall injects compressed context (top-10 neurons, ~2k tokens) before each message. Conversation history trimmed to last 8 messages to stay under 80k tokens.
  </p>
</article>`);

store(`<article id="lazy-models-mode-ask-agent-edit"
  data-cerveau-version="0.1.0"
  data-cerveau-created="2026-06-14T13:00:00Z"
  data-cerveau-type="concept"
  data-cerveau-topic="models"
  data-cerveau-tier="working"
  data-cerveau-importance="0.75"
  data-cerveau-tags="models modes ask agent edit assistant"
  data-cerveau-valid-from="2026-06-14">
  <h2>Chat modes: ask / agent / edit</h2>
  <p data-cerveau-fact="" data-cerveau-confidence="0.85" data-cerveau-extracted-by="human" data-cerveau-kind="concept">
    Three chat modes: ask (Q&A, no tools), agent (full tool-use, autonomous), edit (file edits only, constrained). Mode shown in AssistantHeader toggle buttons.
  </p>
</article>`);

// ── TYPED LINKS between key nodes ─────────────────────────────────

link('lazy-brain-sidecar-design', 'lazy-tauri-sidecar-lifecycle', 'refines');
link('lazy-brain-sidecar-design', 'lazy-tauri-architecture', 'cites');
link('lazy-brain-graph3d', 'lazy-brain-recall-api', 'cites');
link('lazy-brain-wiki-panel', 'lazy-brain-recall-api', 'cites');
link('lazy-brain-cluster-palette', 'lazy-brain-graph3d', 'refines');
link('lazy-tauri-bug-csp', 'lazy-brain-sidecar-design', 'follows-from');
link('lazy-tauri-invoke-bridge', 'lazy-tauri-architecture', 'refines');
link('lazy-tauri-permissions', 'lazy-tauri-architecture', 'refines');
link('lazy-agents-context-injection', 'lazy-brain-recall-api', 'cites');
link('lazy-agents-context-injection', 'lazy-models-context-management', 'cites');
link('lazy-models-streaming', 'lazy-models-anthropic', 'refines');
link('lazy-models-gateway', 'lazy-models-streaming', 'generalizes');
link('lazy-editor-vim-mode', 'lazy-editor-codemirror6', 'refines');
link('lazy-editor-lsp', 'lazy-editor-codemirror6', 'refines');
link('lazy-agents-missions', 'lazy-agents-architecture', 'refines');
link('lazy-agents-tool-calls', 'lazy-agents-missions', 'refines');
link('lazy-agents-bug-pty-windows', 'lazy-agents-architecture', 'follows-from');
link('lazy-brain-recall-api', 'lazy-brain-sidecar-design', 'refines');

console.log('Seed complete. Run graph rebuild next.');
