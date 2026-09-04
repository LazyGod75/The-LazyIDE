#!/usr/bin/env node
/**
 * brain-search-server.mjs — minimal stdio MCP server exposing three tools over
 * the same LazyBrain brain the rest of the Lazy IDE already queries:
 *   - `brain_search`      SEMANTIC recall (warm HTTP sidecar first, cold CLI
 *                         subprocess as fallback).
 *   - `brain_query_css`   STRUCTURAL recall — a deterministic CSS selector over
 *                         the notes' data-cerveau-* attributes (`lazybrain query`).
 *   - `brain_neighbours`  1-hop graph hop from a note id (`lazybrain neighbours`).
 * The two structural tools are cold-CLI only (no warm endpoint exists for them)
 * and mirror the frontend brain_query_css / brain_neighbours tools + Rust commands.
 *
 * Why hand-rolled instead of @modelcontextprotocol/sdk: this server only ever
 * needs to answer initialize / tools/list / tools/call over stdio
 * (newline-delimited JSON-RPC 2.0). Pulling in the full SDK for three request
 * handlers would add a new npm dependency and a bundling concern for a script
 * this small — many small, cohesive files with no unnecessary weight.
 *
 * Spawned by `claude -p --mcp-config <generated-file>` from agent_run
 * (src-tauri/src/lib.rs, build_brain_mcp_config). All configuration arrives via
 * environment variables set in that generated config's "env" block — nothing
 * here parses argv:
 *
 *   LAZYBRAIN_BRAIN_PATH   Absolute path to the mission's project brain
 *                          (<project_root>/.lazybrain/brain). Required for any
 *                          real answer — the server still starts without it,
 *                          every search just returns an explanatory message.
 *   LAZYBRAIN_NODE         Node executable for the cold-path CLI fallback
 *                          (dev: "node"; prod: bundled resources/node.exe).
 *   LAZYBRAIN_SCRIPT       Absolute path to lazybrain.js (cold-path fallback).
 *   BRAIN_MCP_HTTP_PORT    Port of the already-running LazyBrain warm sidecar
 *                          HTTP API (default 37990, matches BRAIN_PORT in
 *                          lib.rs). Tried first: ~10ms once the ML model is
 *                          warm, vs. several seconds for the cold CLI restart.
 *   BRAIN_MCP_HTTP_TOKEN   Bearer token the warm sidecar's checkAuth requires
 *                          (see src/server/auth.ts in the vendored CLI —
 *                          spawn_at now always passes --token). Sent as
 *                          "Authorization: Bearer <token>" on every warm-path
 *                          request. When unset/empty, no header is sent —
 *                          the sidecar's checkAuth treats a missing token
 *                          the same way (open), so this degrades safely if
 *                          the Rust side is ever run against an older
 *                          lib.rs that doesn't set this env var.
 *
 * Fails open at every layer: a missing brain, an unreachable sidecar, or a
 * failed CLI fallback all resolve to a tool result explaining why (never a
 * thrown error, never a hang) so a mission never stalls on memory access.
 */

import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import http from 'node:http';

const BRAIN_PATH = process.env.LAZYBRAIN_BRAIN_PATH ?? '';
const LAZYBRAIN_NODE = process.env.LAZYBRAIN_NODE || 'node';
const LAZYBRAIN_SCRIPT = process.env.LAZYBRAIN_SCRIPT ?? '';
const HTTP_PORT = Number(process.env.BRAIN_MCP_HTTP_PORT) || 37990;
const HTTP_TOKEN = process.env.BRAIN_MCP_HTTP_TOKEN || '';

const SERVER_NAME = 'brain';
const SERVER_VERSION = '0.1.0';
const TOOL_NAME = 'brain_search';
// Structural recall tools (deterministic CSS selector + 1-hop graph hop) —
// mirror the brain_query_css / brain_neighbours frontend tools + Rust commands,
// calling the SAME bundled `lazybrain query` / `lazybrain neighbours` CLI.
const QUERY_TOOL_NAME = 'brain_query_css';
const NEIGHBOURS_TOOL_NAME = 'brain_neighbours';
const DEFAULT_TOP = 6;
const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 200;
const HTTP_TIMEOUT_MS = 4000;
const CLI_TIMEOUT_MS = 25000;

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function logErr(...args) {
  // MCP stdio uses stdout exclusively for JSON-RPC; diagnostics go to stderr.
  console.error('[brain-mcp]', ...args);
}

/** GET the warm sidecar's /_api/search endpoint. Resolves null on any failure. */
function searchWarmSidecar(query, top) {
  return new Promise((resolve) => {
    const url = `http://127.0.0.1:${HTTP_PORT}/_api/search?q=${encodeURIComponent(query)}&top=${top}`;
    const headers = HTTP_TOKEN ? { Authorization: `Bearer ${HTTP_TOKEN}` } : {};
    const req = http.get(url, { timeout: HTTP_TIMEOUT_MS, headers }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(Array.isArray(json.results) ? json.results : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/** Cold fallback: `node lazybrain.js search --strip --top <n> <query>`. Resolves null on failure. */
function searchColdCli(query, top) {
  return new Promise((resolve) => {
    if (!LAZYBRAIN_SCRIPT || !BRAIN_PATH) {
      resolve(null);
      return;
    }
    let child;
    try {
      child = spawn(
        LAZYBRAIN_NODE,
        [LAZYBRAIN_SCRIPT, 'search', '--strip', '--top', String(top), query],
        {
          env: {
            ...process.env,
            LAZYBRAIN_BRAIN_PATH: BRAIN_PATH,
            LAZYBRAIN_LOG_LEVEL: 'warn',
            LAZYBRAIN_TELEMETRY: '0',
            LAZYBRAIN_EMBEDDINGS: '1',
          },
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
    } catch {
      resolve(null);
      return;
    }

    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve(null);
    }, CLI_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0 ? stdout.trim() : null);
    });
  });
}

/**
 * Run a bundled `lazybrain` subcommand (cold CLI) with the brain pinned and
 * resolve { code, stdout, stderr }, or null when the script/brain is missing or
 * the spawn fails/times out. Used by the structural tools below (query /
 * neighbours) — there is no warm-sidecar HTTP endpoint for a CSS query, so
 * these are cold-CLI only; the engine query itself is deterministic and fast
 * (<5ms), the only cost is node startup. stderr is captured so an invalid
 * selector's "Invalid CSS selector: …" reason can reach the agent.
 */
function runLazybrainCli(args, timeoutMs = CLI_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!LAZYBRAIN_SCRIPT || !BRAIN_PATH) {
      resolve(null);
      return;
    }
    let child;
    try {
      child = spawn(LAZYBRAIN_NODE, [LAZYBRAIN_SCRIPT, ...args], {
        env: {
          ...process.env,
          LAZYBRAIN_BRAIN_PATH: BRAIN_PATH,
          LAZYBRAIN_LOG_LEVEL: 'warn',
          LAZYBRAIN_TELEMETRY: '0',
          LAZYBRAIN_EMBEDDINGS: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve(null);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve(null);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

/** Deterministic CSS-selector structural query (`lazybrain query <selector> --pretty`). */
async function runBrainQueryCss(selector, limit) {
  if (!selector || !selector.trim()) {
    return 'brain_query_css: empty selector — provide a CSS selector.';
  }
  if (!BRAIN_PATH) {
    return 'Brain unavailable: no brain configured for this project (LAZYBRAIN_BRAIN_PATH not set).';
  }
  const res = await runLazybrainCli(['query', selector, '--pretty', '--limit', String(limit)]);
  if (!res) {
    return 'Brain unavailable: could not run the structural query (script/brain missing or timed out).';
  }
  if (res.code === 0) return res.stdout || '0 matches';
  return `brain_query_css failed: ${res.stderr || `exit ${res.code}`}`;
}

/** 1-hop graph neighbours (`lazybrain neighbours <id> --pretty`). */
async function runBrainNeighbours(id) {
  if (!id || !id.trim()) {
    return 'brain_neighbours: empty id — provide a note id.';
  }
  if (!BRAIN_PATH) {
    return 'Brain unavailable: no brain configured for this project (LAZYBRAIN_BRAIN_PATH not set).';
  }
  const res = await runLazybrainCli(['neighbours', id, '--pretty']);
  if (!res) {
    return 'Brain unavailable: could not run neighbours (script/brain missing or timed out).';
  }
  if (res.code === 0) return res.stdout || `(no neighbours for ${id})`;
  return `brain_neighbours failed: ${res.stderr || `exit ${res.code}`}`;
}

/** Format warm-sidecar JSON hits into a bullet-list (mirrors the Rust-side formatting). */
function formatHits(results) {
  return results
    .map((r) => (typeof r?.snippet === 'string' ? r.snippet.trim() : ''))
    .filter((s) => s.length > 2)
    .map((s) => `- ${s}`)
    .join('\n');
}

async function runBrainSearch(query, top) {
  if (!query || !query.trim()) {
    return 'brain_search: empty query — nothing to search.';
  }
  if (!BRAIN_PATH) {
    return 'Brain unavailable: no brain configured for this project (LAZYBRAIN_BRAIN_PATH not set).';
  }

  const warmResults = await searchWarmSidecar(query, top);
  if (warmResults) {
    return formatHits(warmResults) || 'No relevant memory found for this query.';
  }

  logErr('warm sidecar unreachable, falling back to cold CLI search');
  const coldText = await searchColdCli(query, top);
  if (coldText) return coldText;
  if (coldText === '') return 'No relevant memory found for this query.';

  return 'Brain unavailable: the memory search backend did not respond (sidecar unreachable and cold search failed).';
}

const rl = createInterface({ input: process.stdin, terminal: false });

// If the parent (claude) closes our stdin — normal shutdown, or an OS-level
// pipe teardown after the mission is cancelled/killed — exit immediately
// instead of lingering as an orphaned process (agent_run_kill only signals the
// claude PID on Windows, not its descendants).
rl.on('close', () => process.exit(0));
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // Not a JSON-RPC message — ignore rather than crash the server.
  }

  const { id, method, params } = msg;

  switch (method) {
    case 'initialize': {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      });
      return;
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return; // Notifications never get a response.

    case 'ping': {
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    }

    case 'tools/list': {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: TOOL_NAME,
              description:
                "Search this project's persistent brain memory (past mission notes, decisions, " +
                'and captured context) for anything relevant to the current step. Startup context ' +
                'was already injected once at mission start — call this mid-mission when you need ' +
                'MORE memory than that initial snapshot (a new sub-task, an unfamiliar file, a past ' +
                'decision you are not sure about). Returns a snippet list, or says when nothing was found.',
              inputSchema: {
                type: 'object',
                properties: {
                  query: { type: 'string', description: 'Natural-language search query.' },
                  top: { type: 'number', description: `Max results to return (default ${DEFAULT_TOP}).` },
                },
                required: ['query'],
              },
            },
            {
              name: QUERY_TOOL_NAME,
              description:
                'Run a CSS selector over the project brain notes for a DETERMINISTIC, exact structural answer ' +
                '(use this, not brain_search, when the question is a precise set: "all active decisions", "all warnings", ' +
                '"notes touching a file path", "contradictions"). Each note is an <article> carrying data-cerveau-* attributes. ' +
                'Vocabulary: data-cerveau-type (decision|rule|episodic|...); data-cerveau-valid-until (PRESENT means stale/superseded — ' +
                'exclude with :not([data-cerveau-valid-until]) for still-active notes); data-cerveau-saliency-kind (e.g. "contradiction"); ' +
                'data-cerveau-tier (working|archival); data-cerveau-confidence. Warnings/anti-patterns are <aside role="doc-warning">. ' +
                'File paths and code refs are <data value="src/..."> (use data[value*="src/auth"]). ' +
                'Example: article[data-cerveau-type="decision"]:not([data-cerveau-valid-until]) → every decision still in force. ' +
                'Returns note #ids + text per hit; follow a hit with brain_neighbours.',
              inputSchema: {
                type: 'object',
                properties: {
                  selector: {
                    type: 'string',
                    description:
                      'A CSS selector applied per-note over the data-cerveau-* HTML, e.g. ' +
                      'aside[role="doc-warning"] or [data-cerveau-saliency-kind="contradiction"].',
                  },
                  limit: { type: 'number', description: `Max hits (default ${DEFAULT_QUERY_LIMIT}, capped at ${MAX_QUERY_LIMIT}).` },
                },
                required: ['selector'],
              },
            },
            {
              name: NEIGHBOURS_TOOL_NAME,
              description:
                "Follow a note's graph: return the 1-hop neighbours of a note #id — supersession chains " +
                '(replaces / replaced-by / supersedes), triples, and shared entities/clusters — so you can chain from a hit ' +
                '("what replaced this decision?", "what else touches auth?"). Pass an id from a brain_query_css or brain_search ' +
                'hit (a leading # is optional). Example: id "decision-oauth-pkce-2026-06-01".',
              inputSchema: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'The note id to expand (with or without a leading #).' },
                },
                required: ['id'],
              },
            },
          ],
        },
      });
      return;
    }

    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};

      let resultPromise;
      if (name === TOOL_NAME) {
        const query = typeof args.query === 'string' ? args.query : '';
        const rawTop = args.top;
        const top = Number.isFinite(rawTop) ? Math.max(1, Math.min(20, rawTop)) : DEFAULT_TOP;
        resultPromise = runBrainSearch(query, top);
      } else if (name === QUERY_TOOL_NAME) {
        const selector = typeof args.selector === 'string' ? args.selector : '';
        const rawLimit = args.limit;
        const limit = Number.isFinite(rawLimit)
          ? Math.max(1, Math.min(MAX_QUERY_LIMIT, rawLimit))
          : DEFAULT_QUERY_LIMIT;
        resultPromise = runBrainQueryCss(selector, limit);
      } else if (name === NEIGHBOURS_TOOL_NAME) {
        const id = typeof args.id === 'string' ? args.id : '';
        resultPromise = runBrainNeighbours(id);
      } else {
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true },
        });
        return;
      }

      resultPromise
        .then((text) => {
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
        })
        .catch((err) => {
          send({
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: `${name} failed: ${String(err)}` }], isError: true },
          });
        });
      return;
    }

    default: {
      if (id !== undefined) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    }
  }
});
