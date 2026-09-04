/* declarativeTools.ts — W-PROVE row 3 (canvas scorecard §4.5 "BYO agents",
   narrowing the still-open arbitrary-code-tool row further): two DECLARATIVE
   user tool kinds that are safe BY CONSTRUCTION — neither ever executes a
   user-authored string as code, unlike projectCommandTools.ts's "commande de
   projet" (which still runs an ALLOWLISTED shell command via run_command).
   These two kinds don't run a command at all:

     - `web_read`  — an HTTP GET to a user-picked, exact-match ("lecture
       web") allowlisted host. https only, no request body, no credentials,
       no custom headers beyond a fixed Accept, and a hard response-size cap
       enforced while streaming (never trusts a Content-Length header alone —
       a server can lie about it).
     - `file_read` — reads one file at a project-relative path ("lecture
       fichier projet"), reusing the exact same sandboxed `read_file` Tauri
       command (guarded server-side by fs.rs's `ensure_path_in_any_open_
       project`/`ensure_path_in_project_root` — the SAME authoritative guard
       proofs.ts/projectCommandTools.ts already rely on) PLUS a TS-side
       pre-check (`isPathWithinProjectScope`) that rejects an absolute path
       or a `..`-escaping relative path before ever reaching that command —
       the same defense-in-depth shape worktreeScriptCommands.ts's TS-side
       mirror of shell.rs's allowlist already established for the other
       tool kind (a client-side reject-early guard backed by a server-side
       authoritative one, never the other way around).

   Authored via the SAME AgentWizard Capacités form as projectCommandTools
   (DeclarativeToolsSection, AgentWizard.tsx) — a user names/describes a
   host or a path once, and every agent that attaches it can then discover
   it (compile.ts's buildClaudeCodeAgentMd renders both catalogs the same
   way). Persistence mirrors projectCommandTools.ts's own documented
   pattern exactly: one JSON file under the active project's
   `.lazy/declarativeTools.json` (Tauri), falling back to localStorage then
   an in-memory mock array (web/tests) — same three-tier fallback, same
   reasoning (no dedicated Rust command needed; the existing sandboxed
   read_file/write_file/fs_create_dir commands are reused as-is).

   Scope boundary, stated up front (same discipline as projectCommandTools.
   ts's own header): this module still does NOT let a user author a tool
   that runs arbitrary code — it only reads (an allowlisted URL, or a file
   already inside the project root). A tool that could execute arbitrary,
   non-allowlisted logic remains a real, honestly-scoped, out-of-scope
   product/security decision — see the canvas scorecard's BYO row for the
   precise, updated "what a user can now author" account.
*/

import { isAbsolutePathWin, joinPath } from '../paths.js';
import { getPlatform } from '../platform/index.js';
import { createToolCollectionStore } from './toolCollectionStore.js';

// ── Types ─────────────────────────────────────────────────────────────

export type DeclarativeToolKind = 'web_read' | 'file_read';

interface DeclarativeToolBase {
  id: string;
  name: string;
  description: string;
  createdAt: string;
}

/** « Lecture web » — HTTP GET to a user-picked, EXACT-match allowlisted
 *  host. `allowedHost` is a bare hostname (e.g. `api.example.com`) — never
 *  a full URL, never a wildcard, never a path/port/credential. */
export interface WebReadTool extends DeclarativeToolBase {
  kind: 'web_read';
  allowedHost: string;
}

/** « Lecture fichier projet » — reads one file at a project-relative path. */
export interface FileReadTool extends DeclarativeToolBase {
  kind: 'file_read';
  path: string;
}

export type DeclarativeTool = WebReadTool | FileReadTool;

export interface DeclarativeToolValidation {
  valid: boolean;
  errors: string[];
}

/** Hard cap on a web_read response body — enforced while STREAMING (never
 *  trusts a Content-Length header alone, since a server can lie about it or
 *  omit it entirely). 2 MiB comfortably covers a JSON/text API response
 *  without letting a tool call balloon into a multi-mission-budget download. */
export const WEB_READ_MAX_BYTES = 2 * 1024 * 1024;

/** Wall-clock cap on the request itself — a slow/hanging allowlisted host
 *  must not stall the calling agent turn indefinitely. Mirrors PreviewNode
 *  .tsx's own REACHABILITY_TIMEOUT_MS convention (this module's sibling use
 *  of AbortSignal.timeout for an outbound fetch). */
export const WEB_READ_TIMEOUT_MS = 10_000;

// ── Host / path validation (author-time guards) ────────────────────────

/** A bare hostname only: no scheme, no path, no port, no userinfo, no
 *  whitespace. Rejects `http://`, `https://host/path`, `host:443`,
 *  `user@host`, and anything containing a space — the allowlist entry is
 *  meant to be copy-pasteable from a browser's address bar host segment,
 *  nothing more. `localhost` is accepted explicitly since it never matches
 *  the dotted-label regex below. */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function isValidAllowlistHost(host: string): boolean {
  const trimmed = host.trim();
  if (!trimmed) return false;
  if (/[\s/@:]/.test(trimmed)) return false;
  if (trimmed.toLowerCase() === 'localhost') return true;
  return HOSTNAME_RE.test(trimmed);
}

/**
 * True when `relativePath` stays inside the project root: no absolute path
 * (Windows drive-letter, `\\?\` verbatim, UNC, or POSIX-rooted — reuses
 * paths.ts's own `isAbsolutePathWin`, the same primitive runtime.ts's own
 * path-normalization bugs were fixed with) and no `..` segment anywhere in
 * the path (a leading, trailing, or interior escape attempt — normalizing
 * separators first so `..\\..\\etc` and `../../etc` are caught identically
 * regardless of which separator style was typed). This is the TS-side
 * pre-check; the AUTHORITATIVE guard is still the Rust `read_file` command's
 * own `ensure_path_in_any_open_project` (fs.rs) — see this module's own
 * header for why re-validating an already-saved path is unnecessary
 * (mirrors projectCommandTools.ts's identical "validated on save, trusted
 * on read" convention).
 */
export function isPathWithinProjectScope(relativePath: string): boolean {
  const trimmed = relativePath.trim();
  if (!trimmed) return false;
  if (isAbsolutePathWin(trimmed)) return false;
  const segments = trimmed.split(/[\\/]+/);
  return !segments.some((segment) => segment === '..');
}

export function validateWebReadTool(input: { name: string; description: string; allowedHost: string }): DeclarativeToolValidation {
  const errors: string[] = [];
  if (!input.name.trim()) errors.push('name is required');
  if (!input.description.trim()) errors.push('description is required');
  if (!input.allowedHost.trim()) {
    errors.push('allowed host is required');
  } else if (!isValidAllowlistHost(input.allowedHost)) {
    errors.push('allowed host must be a bare hostname (e.g. api.example.com) — no scheme, path, port, or credentials');
  }
  return { valid: errors.length === 0, errors };
}

export function validateFileReadTool(input: { name: string; description: string; path: string }): DeclarativeToolValidation {
  const errors: string[] = [];
  if (!input.name.trim()) errors.push('name is required');
  if (!input.description.trim()) errors.push('description is required');
  if (!input.path.trim()) {
    errors.push('path is required');
  } else if (!isPathWithinProjectScope(input.path)) {
    errors.push('path must be relative and stay inside the project root — absolute paths and ".." segments are rejected');
  }
  return { valid: errors.length === 0, errors };
}

// ── Runtime shape guards (agentImportExport.ts's untrusted-input path) ──

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isWebReadToolLike(value: unknown): value is WebReadTool {
  return (
    isPlainObject(value) &&
    value.kind === 'web_read' &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    typeof value.allowedHost === 'string' &&
    typeof value.createdAt === 'string'
  );
}

export function isFileReadToolLike(value: unknown): value is FileReadTool {
  return (
    isPlainObject(value) &&
    value.kind === 'file_read' &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    typeof value.path === 'string' &&
    typeof value.createdAt === 'string'
  );
}

export function isDeclarativeToolLike(value: unknown): value is DeclarativeTool {
  return isWebReadToolLike(value) || isFileReadToolLike(value);
}

// ── Execution (the safe-by-construction runtime side) ──────────────────

export interface DeclarativeToolReadResult {
  ok: boolean;
  body?: string;
  status?: number;
  error?: string;
}

/**
 * True only for an https URL whose hostname EXACTLY matches
 * `tool.allowedHost` (case-insensitive) — no subdomain match, no prefix
 * match, no wildcard. `http://` (even to the same host) is rejected
 * outright — this catalog never sends credentials, but plaintext HTTP is
 * still an honest scope exclusion (nothing to gain from allowing it, real
 * risk of a silent downgrade if a host redirects). An unparsable `url`
 * (via the global URL constructor) is treated as a rejection, never a
 * false accept.
 */
export function urlMatchesWebReadAllowlist(url: string, tool: Pick<WebReadTool, 'allowedHost'>): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return parsed.hostname.toLowerCase() === tool.allowedHost.trim().toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Executes a `web_read` tool call. Enforces, in order: https + exact-host
 * allowlist match (`urlMatchesWebReadAllowlist`), then a response-size cap
 * enforced WHILE STREAMING the body (a lying/absent Content-Length header
 * never bypasses this — every chunk is counted as it arrives and the
 * request is aborted the instant the cap is crossed, before the full body
 * is ever buffered). No request body, `credentials: 'omit'`, and no headers
 * beyond a fixed `Accept` — never forwards anything from the calling
 * agent's own context that could leak credentials to an arbitrary host.
 *
 * `fetchImpl` is an injection seam for tests (no live network call needed
 * to prove the allowlist/protocol/size-cap enforcement) — defaults to the
 * ambient `fetch` exactly like every other direct-fetch call site in this
 * codebase (PreviewNode.tsx's own reachability probe, this module's sibling
 * in spirit — see that file's header for why no platform abstraction layer
 * exists for outbound HTTP yet).
 */
export async function executeWebReadTool(
  tool: WebReadTool,
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeclarativeToolReadResult> {
  if (!urlMatchesWebReadAllowlist(url, tool)) {
    return { ok: false, error: `URL is not allowlisted for this tool — expected https://${tool.allowedHost}` };
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'text/plain, application/json, text/html;q=0.9, */*;q=0.1' },
      credentials: 'omit',
      signal: AbortSignal.timeout(WEB_READ_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, error: `request failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const declaredLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > WEB_READ_MAX_BYTES) {
    return { ok: false, error: `response exceeds the ${WEB_READ_MAX_BYTES}-byte cap (Content-Length: ${declaredLength})` };
  }

  if (!response.body) {
    // No streaming body available (e.g. a test double, or a HEAD-shaped
    // response) — fall back to buffering, still enforced against the cap.
    const text = await response.text();
    if (new TextEncoder().encode(text).length > WEB_READ_MAX_BYTES) {
      return { ok: false, error: `response exceeds the ${WEB_READ_MAX_BYTES}-byte cap` };
    }
    return { ok: true, body: text, status: response.status };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > WEB_READ_MAX_BYTES) {
        await reader.cancel().catch(() => { /* best-effort */ });
        return { ok: false, error: `response exceeds the ${WEB_READ_MAX_BYTES}-byte cap while streaming` };
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body: new TextDecoder().decode(merged), status: response.status };
}

/**
 * Executes a `file_read` tool call. Re-validates the guard even though
 * `tool.path` was already checked at save time (defense-in-depth, cheap,
 * and protects a future caller that constructs a FileReadTool without going
 * through `validateFileReadTool` first) before ever joining it onto
 * `projectRoot` and handing it to the SAME sandboxed `read_file` platform
 * call every other project-scoped read in this codebase already uses — the
 * Rust-side `ensure_path_in_any_open_project` is the authoritative
 * enforcement point; this function's own guard is the cheap, fail-fast
 * first line of defense.
 */
export async function executeFileReadTool(tool: FileReadTool, projectRoot: string): Promise<DeclarativeToolReadResult> {
  if (!isPathWithinProjectScope(tool.path)) {
    return { ok: false, error: 'path is outside the project root' };
  }
  try {
    const fullPath = joinPath(projectRoot, tool.path);
    const body = await getPlatform().fs.readFile(fullPath);
    return { ok: true, body };
  } catch (err) {
    return { ok: false, error: `read failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Persistence (mirrors projectCommandTools.ts's documented pattern; the
//    list/persist/save/delete/reset plumbing itself now lives in
//    toolCollectionStore.ts, shared across all three catalogs. This
//    catalog is the one that passes its OWN `joinPath` (paths.ts's
//    separator-preserving joiner, already imported above for
//    `executeFileReadTool`) instead of the shared default — see
//    toolCollectionStore.ts's header for why that stays intentionally
//    un-unified with the other two catalogs' naive joiner) ────────────

const store = createToolCollectionStore<DeclarativeTool>({
  storageFileName: 'declarativeTools.json',
  localStorageKey: 'lazy.agents.declarativeTools',
  isLike: isDeclarativeToolLike,
  joinPath,
});

/** List every declarative tool stored for the active project. */
export async function listDeclarativeTools(): Promise<DeclarativeTool[]> {
  return store.list();
}

function validateForSave(tool: DeclarativeTool): DeclarativeToolValidation {
  return tool.kind === 'web_read'
    ? validateWebReadTool(tool)
    : validateFileReadTool(tool);
}

/**
 * Saves (creates or updates) a tool. THROWS on validation failure — the
 * enforcement point, never bypassed by a caller that skips the separate
 * validate* check (same discipline as projectCommandTools.ts's
 * saveProjectCommandTool).
 */
export async function saveDeclarativeTool(tool: DeclarativeTool): Promise<void> {
  const validation = validateForSave(tool);
  if (!validation.valid) {
    throw new Error(`Invalid declarative tool: ${validation.errors.join('; ')}`);
  }
  await store.save(tool);
}

/** Deletes a tool by id. Never throws if the id is already absent. */
export async function deleteDeclarativeTool(id: string): Promise<void> {
  await store.remove(id);
}

/** Mints a fresh id for a brand-new tool — same shape as
 *  projectCommandTools.ts's generateProjectCommandToolId. */
export function generateDeclarativeToolId(): string {
  return `dtool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Test-only reset. */
export function _resetDeclarativeToolsForTests(): void {
  store.resetForTests();
}
