/**
 * brain-registry.ts — multi-tenant brain registry (T0.8).
 *
 * Lets one `lazybrain serve` process host N brains instead of one. Each
 * registered brain gets a stable brainId; at most MAX_HOT_BRAINS keep their
 * heavy handles (sqlite connections opened lazily by indexer/db.ts) resident
 * at once — opening one more than that demotes the least-recently-used
 * brain by closing its handles, but its registry entry (and everything
 * persisted to disk) is kept, so the very next request against it just
 * reopens fresh connections and re-promotes it to hot.
 *
 * Routing mechanism: this module does NOT thread a brainId parameter through
 * the dozens of functions that read brain-relative paths (getConfig(),
 * indexer/db.ts, graph/*.ts loaders, store/paths.ts). Instead it switches an
 * AsyncLocalStorage-backed "active brain context" (server/brain-context.ts)
 * for the duration of a request; getConfig() reads that context back
 * transparently. See withBrain()/enterBrain() below.
 *
 * Embeddings note: the ONNX embedding pipeline (indexer/embeddings.ts) is a
 * single shared session/queue for the whole process — EMBED_BATCH_SIZE is a
 * process-wide RAM cap, not per brain. This registry never touches it;
 * every brain's index/search work flows through that same shared pipeline.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { closeDbForPath } from '../indexer/db.js';
import { FTS_DB_FILENAME } from '../store/paths.js';
import { getLogger } from '../util/logger.js';
import { type BrainContext, enterBrainContext, runWithBrainContext } from './brain-context.js';

/** At most this many brains keep their sqlite handles open at once. */
const MAX_HOT_BRAINS = 3;

/**
 * Registry label (spec §5.3/§10 follow-up): what kind of brain this is,
 * independent of hotness/LRU. Drives scope filtering in
 * routes/search.ts's federated search — e.g. `scope=team` only searches
 * `'team'`-labeled brains. Defaults to `'project'` (today's only kind)
 * everywhere a caller doesn't specify one, so existing single-brain and
 * multi-project behavior is unchanged.
 */
export type BrainLabel = 'project' | 'team' | 'trunk';

const VALID_BRAIN_LABELS: ReadonlySet<string> = new Set<BrainLabel>(['project', 'team', 'trunk']);

/** Narrow an untrusted value to a BrainLabel, or undefined if not one of the three. */
export function normalizeBrainLabel(raw: unknown): BrainLabel | undefined {
  return typeof raw === 'string' && VALID_BRAIN_LABELS.has(raw) ? (raw as BrainLabel) : undefined;
}

export interface BrainHandle {
  brainId: string;
  brainPath: string;
  cachePath: string;
  label: BrainLabel;
  hot: boolean;
  lastUsedMs: number;
}

/** Thrown by withBrain()/enterBrain() when brainId does not match a registered brain. */
export class BrainNotFoundError extends Error {
  constructor(brainId: string) {
    super(`Unknown brainId: ${brainId}`);
    this.name = 'BrainNotFoundError';
  }
}

interface BrainEntry {
  brainId: string;
  brainPath: string;
  cachePath: string;
  label: BrainLabel;
  hot: boolean;
  lastUsedMs: number;
}

const brains = new Map<string, BrainEntry>();
/** normalized brainPath -> brainId, so openBrain() on the same path is idempotent. */
const brainIdByPath = new Map<string, string>();

// ---------------------------------------------------------------------------
// Path / id helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a brain root for identity comparison: absolute, `.`/`..`
 * collapsed. Mirrors the canonicalize-then-compare approach used for the
 * ProjectRegistry allowlist on the Rust side (src-tauri's util.rs, spec
 * §5.1) so "the same brain" is judged consistently across the app.
 */
function normalizeBrainPath(brainPath: string): string {
  return resolve(brainPath);
}

function computeBrainId(absPath: string): string {
  return createHash('sha1').update(absPath).digest('hex').slice(0, 16);
}

/** `<brainPath>/_cache` — same "cache lives inside the brain dir" convention as util/config.ts. */
function cachePathFor(absBrainPath: string): string {
  return resolve(absBrainPath, '_cache');
}

function ftsDbPathFor(cachePath: string): string {
  return join(cachePath, FTS_DB_FILENAME);
}

function toContext(entry: BrainEntry): BrainContext {
  return { brainId: entry.brainId, brainPath: entry.brainPath, cachePath: entry.cachePath };
}

function toHandle(entry: BrainEntry): BrainHandle {
  return {
    brainId: entry.brainId,
    brainPath: entry.brainPath,
    cachePath: entry.cachePath,
    label: entry.label,
    hot: entry.hot,
    lastUsedMs: entry.lastUsedMs,
  };
}

// ---------------------------------------------------------------------------
// LRU hotness
// ---------------------------------------------------------------------------

function hotCount(): number {
  let n = 0;
  for (const entry of brains.values()) if (entry.hot) n += 1;
  return n;
}

/**
 * Demote the least-recently-used hot brain (never `except`, the brain
 * currently being promoted) by closing its sqlite handles. The registry
 * entry is kept — see module doc comment for why that makes the next
 * access a transparent lazy reopen instead of a 404.
 */
function demoteLru(except: string): void {
  let victim: BrainEntry | undefined;
  for (const entry of brains.values()) {
    if (!entry.hot || entry.brainId === except) continue;
    if (!victim || entry.lastUsedMs < victim.lastUsedMs) victim = entry;
  }
  if (!victim) return;

  victim.hot = false;
  closeDbForPath(ftsDbPathFor(victim.cachePath));
  getLogger().info(
    { brainId: victim.brainId, brainPath: victim.brainPath },
    'brain-registry: demoted LRU brain (closed heavy handles; entry kept for lazy reopen)',
  );
}

/** Touch lastUsedMs and promote to hot, demoting the LRU hot brain if this pushes past the cap. */
function promote(entry: BrainEntry): void {
  entry.lastUsedMs = Date.now();
  if (entry.hot) return;
  if (hotCount() >= MAX_HOT_BRAINS) demoteLru(entry.brainId);
  entry.hot = true;
}

// ---------------------------------------------------------------------------
// Public registry API
// ---------------------------------------------------------------------------

export interface OpenBrainOptions {
  /** Registry label — defaults to 'project' for a brand-new entry. Re-opening
   *  an EXISTING entry with a label updates it; omitting the label on a
   *  re-open leaves whatever label it already had untouched (opening a brain
   *  again to just refresh its hotness must never silently downgrade an
   *  already-labeled team/trunk brain back to 'project'). */
  label?: BrainLabel;
}

export interface OpenBrainResult {
  brainId: string;
  label: BrainLabel;
}

/**
 * Register (or re-attach to) a brain at `brainPath`. Idempotent: calling
 * this again with the same (normalized) path returns the SAME brainId
 * without creating a duplicate entry.
 *
 * Ensures the brain directory and its cache dir exist (mirrors the
 * "explicit path → create rather than throw" behavior util/config.ts uses
 * for LAZYBRAIN_BRAIN_PATH) and promotes the brain to hot, demoting another
 * brain if this is the 4th hot one.
 */
export async function openBrain(
  brainPath: string,
  opts: OpenBrainOptions = {},
): Promise<OpenBrainResult> {
  const absPath = normalizeBrainPath(brainPath);

  const existingId = brainIdByPath.get(absPath);
  if (existingId) {
    const entry = brains.get(existingId);
    if (entry) {
      if (opts.label) entry.label = opts.label;
      promote(entry);
      return { brainId: existingId, label: entry.label };
    }
  }

  const brainId = computeBrainId(absPath);
  const cachePath = cachePathFor(absPath);
  if (!existsSync(absPath)) mkdirSync(absPath, { recursive: true });
  if (!existsSync(cachePath)) mkdirSync(cachePath, { recursive: true });

  const entry: BrainEntry = {
    brainId,
    brainPath: absPath,
    cachePath,
    label: opts.label ?? 'project',
    hot: false,
    lastUsedMs: 0,
  };
  brains.set(brainId, entry);
  brainIdByPath.set(absPath, brainId);
  promote(entry);

  return { brainId, label: entry.label };
}

/** Look up a registered brain's current handle (hot/cold + paths), or undefined if unknown. */
export function getBrain(brainId: string): BrainHandle | undefined {
  const entry = brains.get(brainId);
  return entry ? toHandle(entry) : undefined;
}

/** List every registered brain, most-recently-used first. */
export function listBrains(): BrainHandle[] {
  return [...brains.values()].map(toHandle).sort((a, b) => b.lastUsedMs - a.lastUsedMs);
}

/** Fully unregister a brain: close its handles and forget it (unlike LRU demotion). */
export function closeBrain(brainId: string): void {
  const entry = brains.get(brainId);
  if (!entry) return;
  closeDbForPath(ftsDbPathFor(entry.cachePath));
  brains.delete(brainId);
  brainIdByPath.delete(entry.brainPath);
}

/**
 * Run `fn` scoped to `brainId`. `brainId` undefined runs `fn` completely
 * unwrapped (no AsyncLocalStorage frame at all) so the default
 * env-configured brain behaves exactly as it did before this registry
 * existed — the single-brain compatibility contract this module must
 * uphold. Throws BrainNotFoundError for an unrecognized brainId.
 */
export function withBrain<T>(brainId: string | undefined, fn: () => T): T {
  if (!brainId) return fn();
  const entry = brains.get(brainId);
  if (!entry) throw new BrainNotFoundError(brainId);
  promote(entry); // re-promotion after a cold access IS the "lazy reopen" contract
  return runWithBrainContext(toContext(entry), fn);
}

/**
 * Resolve and switch the CURRENT async execution to `brainId` for its
 * remainder — see brain-context.ts's enterBrainContext(). Use this at the
 * top of a request handler instead of withBrain() when wrapping the rest of
 * the handler in a callback would mean re-indenting a large, unrelated
 * dispatch chain (see commands/serve.ts). `brainId` undefined is a no-op:
 * the request stays on the default/env brain. Throws BrainNotFoundError for
 * an unrecognized brainId — callers must catch this and respond (404).
 */
export function enterBrain(brainId: string | undefined): void {
  if (!brainId) return;
  const entry = brains.get(brainId);
  if (!entry) throw new BrainNotFoundError(brainId);
  promote(entry);
  enterBrainContext(toContext(entry));
}

/** Test-only: forget every registered brain and close their handles. */
export function resetBrainRegistryForTests(): void {
  for (const brainId of [...brains.keys()]) closeBrain(brainId);
  brains.clear();
  brainIdByPath.clear();
}
