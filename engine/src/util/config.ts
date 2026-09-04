import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { getActiveBrainContext } from '../server/brain-context.js';

export interface LazyBrainConfig {
  brainPath: string;
  cachePath: string;
  modelsPath: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  telemetry: boolean;
}

let cached: LazyBrainConfig | null = null;

/**
 * Marker file written at the BRAIN ROOT (never inside cachePath) once the
 * legacy-cache migration decision has been made for that brain. Its
 * presence — not whether brain/_cache currently exists — is what makes the
 * migration truly one-way. See the migration block in getConfig() for why.
 */
const CACHE_MIGRATION_MARKER = '.cache-migrated';

/**
 * Brain path discovery — checked in priority order:
 *
 * 1. --brain <path> CLI flag  → passed via process.env.LAZYBRAIN_BRAIN_PATH_CLI
 *    (set by bin/lazybrain.ts before getConfig() is called) — highest priority
 * 2. LAZYBRAIN_BRAIN_PATH env var
 * 3. Walk up from cwd() looking for a .lazybrain/ directory
 * 4. Scan ~/Documents/ for a Lazy-Brain* folder containing brain/notes/
 *    (logs a one-time warning recommending explicit configuration)
 * 5. Fall back to ~/.lazybrain/brain/ (created if it does not exist)
 */
let _documentsWarningEmitted = false;

function discoverBrainPath(): string {
  // 1. --brain CLI flag forwarded through env (highest priority)
  if (process.env.LAZYBRAIN_BRAIN_PATH_CLI) {
    return process.env.LAZYBRAIN_BRAIN_PATH_CLI;
  }

  // 2. Explicit env var
  if (process.env.LAZYBRAIN_BRAIN_PATH) {
    return process.env.LAZYBRAIN_BRAIN_PATH;
  }

  // 3. Walk up from cwd looking for .lazybrain/
  const lazybrainDir = walkUpForDotDir(process.cwd(), '.lazybrain');
  if (lazybrainDir !== null) {
    return join(lazybrainDir, 'brain');
  }

  // 4. ~/Documents/Lazy-Brain*/ containing brain/notes/
  const docsMatch = findInDocuments();
  if (docsMatch !== null) {
    if (!_documentsWarningEmitted) {
      _documentsWarningEmitted = true;
      // Use stderr directly here — logger is not yet initialised (getConfig() feeds it).
      process.stderr.write(
        `[lazybrain] WARN: brain discovered via legacy ~/Documents scan (${docsMatch}). Set LAZYBRAIN_BRAIN_PATH or place a .lazybrain/ directory in your project root to silence this.\n`,
      );
    }
    return docsMatch;
  }

  // 5. Fallback: ~/.lazybrain/brain/
  return join(homedir(), '.lazybrain', 'brain');
}

/**
 * Walk up from startDir toward filesystem root, looking for a directory
 * named dotDirName. Returns the absolute path of the dotDirName directory
 * if found, or null if the root is reached without a match.
 */
function walkUpForDotDir(startDir: string, dotDirName: string): string | null {
  let current = resolve(startDir);
  while (true) {
    const candidate = join(current, dotDirName);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null; // filesystem root
    current = parent;
  }
}

/**
 * Scan ~/Documents/ for a directory starting with "Lazy-Brain" that
 * contains a brain/notes/ subdirectory. Returns the brain/ path or null.
 */
function findInDocuments(): string | null {
  const docs = join(homedir(), 'Documents');
  if (!existsSync(docs)) return null;
  try {
    const match = readdirSync(docs).find(
      (d) => d.startsWith('Lazy-Brain') && existsSync(join(docs, d, 'brain', 'notes')),
    );
    return match ? join(docs, match, 'brain') : null;
  } catch {
    return null;
  }
}

/**
 * Public config accessor. When a brain-registry request context is active
 * (see server/brain-context.ts), brainPath/cachePath are overridden to that
 * specific brain — modelsPath/logLevel/telemetry stay process-wide (one
 * shared ONNX model dir, one log level; the embedding pipeline is a single
 * shared queue for the whole process, never duplicated per brain — see
 * indexer/embeddings.ts). With no active context (CLI commands, tests,
 * anything that never calls the registry) this is exactly the previous
 * single-brain getConfig(), unchanged.
 */
export function getConfig(): LazyBrainConfig {
  const base = resolveDefaultConfig();
  const active = getActiveBrainContext();
  if (!active) return base;
  return { ...base, brainPath: active.brainPath, cachePath: active.cachePath };
}

/** Original getConfig() body, verbatim — the default/env-configured brain. */
function resolveDefaultConfig(): LazyBrainConfig {
  if (cached) return cached;

  const brainPath = discoverBrainPath();
  const resolvedBrain = resolve(brainPath);

  if (!existsSync(resolvedBrain)) {
    // Fallback path may not exist yet — create it rather than throwing
    const isFallback =
      resolvedBrain === resolve(join(homedir(), '.lazybrain', 'brain')) ||
      process.env.LAZYBRAIN_BRAIN_PATH !== undefined ||
      process.env.LAZYBRAIN_BRAIN_PATH_CLI !== undefined;

    if (!isFallback) {
      throw new Error(`Brain path does not exist: ${resolvedBrain}`);
    }
    mkdirSync(resolvedBrain, { recursive: true });
  }

  // CACHE PATH — default is INSIDE the brain directory so two sibling brains
  // never share one _cache (old default was dirname(brain)/_cache, a footgun).
  // LAZYBRAIN_CACHE_PATH env var still wins unconditionally.
  const cachePath = process.env.LAZYBRAIN_CACHE_PATH
    ? resolve(process.env.LAZYBRAIN_CACHE_PATH)
    : resolve(resolvedBrain, '_cache');

  const modelsPath = process.env.LAZYBRAIN_MODELS_PATH
    ? resolve(process.env.LAZYBRAIN_MODELS_PATH)
    : join(homedir(), '.lazybrain', 'models');

  // One-time migration: when the new in-brain cache does not yet exist but the
  // legacy sibling dirname(brain)/_cache does, copy its contents so the user
  // does not lose their FTS index after upgrading.  We copy (not move) because
  // another sibling brain directory may still reference the legacy path.
  //
  // Guarded by CACHE_MIGRATION_MARKER so this is truly ONE-WAY: once the
  // decision has been made for a brain, deleting brain/_cache (the normal way
  // to force a fresh index/reset) must NEVER re-trigger a copy from the
  // legacy sibling. Without this guard, a "fresh" brain silently gets
  // re-polluted with stale FTS/graph/embeddings data left behind by an older
  // brain that happened to share the same parent directory — notes and index
  // end up mismatched (init-failed). The marker lives at the brain root, NOT
  // inside cachePath, specifically so it survives brain/_cache being deleted.
  if (!process.env.LAZYBRAIN_CACHE_PATH) {
    const markerPath = join(resolvedBrain, CACHE_MIGRATION_MARKER);
    if (!existsSync(markerPath)) {
      if (!existsSync(cachePath)) {
        const legacyCachePath = resolve(dirname(resolvedBrain), '_cache');
        if (existsSync(legacyCachePath)) {
          migrateLegacyCache(legacyCachePath, cachePath);
        }
      }
      writeMigrationMarker(markerPath);
    }
  }

  if (!existsSync(cachePath)) mkdirSync(cachePath, { recursive: true });
  if (!existsSync(modelsPath)) mkdirSync(modelsPath, { recursive: true });

  const logLevel = (process.env.LAZYBRAIN_LOG_LEVEL ?? 'info') as LazyBrainConfig['logLevel'];
  const telemetry = process.env.LAZYBRAIN_TELEMETRY !== '0';

  cached = { brainPath: resolvedBrain, cachePath, modelsPath, logLevel, telemetry };
  return cached;
}

/**
 * Copy every top-level file from legacyDir into newDir.
 * Creates newDir if necessary. Logs one info line on success.
 * Never throws: on any failure it falls back to a fresh empty cache and warns.
 */
function migrateLegacyCache(legacyDir: string, newDir: string): void {
  try {
    mkdirSync(newDir, { recursive: true });
    const files = readdirSync(legacyDir);
    for (const file of files) {
      try {
        copyFileSync(join(legacyDir, file), join(newDir, file));
      } catch {
        // Individual file copy failure: skip silently, the next line handles it.
      }
    }
    process.stderr.write(`[lazybrain] INFO: migrated cache from ${legacyDir} to ${newDir}\n`);
  } catch (err) {
    process.stderr.write(
      `[lazybrain] WARN: cache migration from ${legacyDir} failed (${(err as Error).message}); starting with a fresh cache.\n`,
    );
  }
}

/**
 * Record that the legacy-cache migration decision has been made for this
 * brain, so it never runs again — even if brain/_cache is later deleted to
 * force a fresh index. Best-effort: if the marker cannot be written (e.g.
 * read-only filesystem), migration may be re-attempted next run, which is
 * safe (idempotent copy) if slightly noisy.
 */
function writeMigrationMarker(markerPath: string): void {
  try {
    writeFileSync(markerPath, `${new Date().toISOString()}\n`, 'utf-8');
  } catch {
    // best-effort — see doc comment above
  }
}

export function resetConfigForTests(): void {
  cached = null;
}

/** Reset the Documents-scan warning flag between tests. */
export function resetDocumentsWarningForTests(): void {
  _documentsWarningEmitted = false;
}
