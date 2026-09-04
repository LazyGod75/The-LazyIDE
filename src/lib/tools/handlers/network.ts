/* Network-domain tool handlers: web_search/web_fetch/check_url.
   Extracted verbatim from toolRuntime.ts's executeTool switch. */

import { invoke } from '@tauri-apps/api/core';
import { emit as busEmit } from '../../bus.js';
import { emitBuffered } from '../../journal/journal.js';
import type { ToolExecutionContext } from './types.js';

/** Bound for the `check_url` tool case below — long enough for a local dev
 *  server or a small remote page, short enough to never stall the loop. */
const CHECK_URL_TIMEOUT_MS = 8_000;

/** `check_url`'s bodyStart size — a glance for the model, not a full read. */
const CHECK_URL_BODY_START_CHARS = 500;

/** GitHub HTML pages are SPA chrome; agents need the raw file. */
export function rewriteGithubHtmlUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'github.com') return url;
    const parts = parsed.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    if (parts.length === 2) {
      return `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/HEAD/README.md`;
    }
    if (parts.length >= 5 && parts[2] === 'blob') {
      const [owner, repo, , ref, ...fileParts] = parts;
      return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${fileParts.join('/')}`;
    }
    return url;
  } catch {
    return url;
  }
}

export async function webSearch(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const query = String(args.query ?? '');
  if (!query) return 'ERROR: No search query provided';
  const maxResults = args.max_results !== undefined ? Number(args.max_results) : 8;

  // P-SEARCH (founder directive: "on voit la recherche") — a real
  // mission run carries missionId+projectId (see ToolExecutionContext's
  // own doc comment); the assistant/codeur chat and LazyManager have
  // neither, so this whole block is a no-op for them. Emitted BEFORE
  // the Rust call resolves so the canvas SearchNode shows the LIVE
  // query, not just its eventual result.
  const canReportToCanvas = Boolean(ctx.missionId && ctx.projectId);
  if (canReportToCanvas) {
    busEmit('canvas:webSearchResult', {
      missionId: ctx.missionId!,
      agentName: ctx.agentName,
      projectId: ctx.projectId,
      query,
      status: 'searching',
      results: [],
    });
  }

  try {
    const result = await invoke<{
      query: string;
      results: Array<{ title: string; url: string; snippet: string }>;
    }>('web_search', { query, maxResults });

    if (canReportToCanvas) {
      busEmit('canvas:webSearchResult', {
        missionId: ctx.missionId!,
        agentName: ctx.agentName,
        projectId: ctx.projectId,
        query,
        status: 'done',
        results: result.results,
      });
      // journal.rs's events table is opaque-payload history (never
      // re-read to drive the live canvas — the bus event above is what
      // does that) — this is purely the durable "what did this mission
      // search for" audit trail + activity ticker line
      // (activityFeedFormat.ts's humanizeActivityItem).
      emitBuffered({
        tsMs: Date.now(),
        projectId: ctx.projectId!,
        missionId: ctx.missionId,
        actor: 'agent',
        type: 'agent.web_search',
        payload: { query, resultCount: result.results.length },
      });
    }

    if (result.results.length === 0) {
      return `No web results for "${query}"`;
    }

    const formatted = result.results.map((r, i) => {
      const snippet = r.snippet ? `\n   ${r.snippet.slice(0, 150)}` : '';
      return `[${i + 1}] ${r.title}\n   ${r.url}${snippet}`;
    }).join('\n\n');

    return `Web search results for "${query}" (${result.results.length} sources):\n${formatted}`;
  } catch (err) {
    if (canReportToCanvas) {
      busEmit('canvas:webSearchResult', {
        missionId: ctx.missionId!,
        agentName: ctx.agentName,
        projectId: ctx.projectId,
        query,
        status: 'error',
        results: [],
      });
    }
    return `ERROR: web_search failed: ${String(err)}`;
  }
}

export async function webFetch(args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<string> {
  const rawUrl = String(args.url ?? '');
  if (!rawUrl) return 'ERROR: No URL provided';
  const url = rewriteGithubHtmlUrl(rawUrl);
  const maxChars = Number(args.max_chars ?? 6000);
  const timeoutSecs = args.timeout_secs !== undefined ? Number(args.timeout_secs) : undefined;
  try {
    const result = await invoke<{
      url: string;
      content: string;
      contentType: string;
      wasTruncated: boolean;
      statusCode: number;
    }>('web_fetch', { url, timeoutSecs, maxChars });

    if (!result.content.trim()) {
      return `ERROR: No content at ${url} (HTTP ${result.statusCode})`;
    }

    const truncatedNote = result.wasTruncated ? '\n\n[Content was truncated]' : '';
    const content = result.content.slice(0, maxChars);
    return `${content}${truncatedNote}`;
  } catch (err) {
    return `ERROR: web_fetch failed: ${String(err)}`;
  }
}

export async function checkUrl(args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<string> {
  // Self-verification helper — an agent that just produced a static
  // deliverable needs to know "does it respond, and does it contain
  // what I expect" WITHOUT spawning its own throwaway server (a cold
  // `npx http-server`/`python -m http.server` routinely outruns a short
  // timeout or is simply unavailable, burning steps on a false-negative
  // mission failure even though the deliverable itself is fine).
  //
  // Deliberately NOT routed through the 'web_fetch' case above: that one
  // invokes the Rust `web_fetch` command, which carries an SSRF guard
  // that intentionally BLOCKS loopback/private targets (see
  // src-tauri/src/commands/web.rs) — exactly the http://127.0.0.1:<port>
  // targets this tool exists to check. Calling the webview's own
  // fetch() instead mirrors devPreview.ts's defaultProbeReachable/
  // defaultFetchBodyStart probes, which already rely on this same
  // direct-fetch-to-loopback path working.
  //
  // Contract: NEVER throws/returns an "ERROR:" string — every outcome
  // (dead server, timeout, DNS failure, a cross-origin response with no
  // permissive CORS header) collapses to the same honest JSON shape, so
  // the caller always gets a real observation to reason about instead
  // of a failed tool call.
  const url = String(args.url ?? '');
  const contains = args.contains !== undefined ? String(args.contains) : undefined;
  if (!url) {
    return JSON.stringify({ status: 0, bodyStart: '', containsMatch: false, error: 'No URL provided' });
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(CHECK_URL_TIMEOUT_MS) });
    const text = await res.text();
    const bodyStart = text.slice(0, CHECK_URL_BODY_START_CHARS);
    const containsMatch = contains !== undefined ? text.includes(contains) : false;
    return JSON.stringify({ status: res.status, bodyStart, containsMatch });
  } catch (err) {
    return JSON.stringify({ status: 0, bodyStart: '', containsMatch: false, error: String(err) });
  }
}
