/**
 * init: zero-config bootstrap for a new LazyBrain user.
 *
 * Brain target resolution order (highest priority first):
 *   1. --brain <path> CLI flag  (passed as opts.path)
 *   2. LAZYBRAIN_BRAIN_PATH env var (explicit environment configuration)
 *   3. $CWD/.lazybrain/brain   (local project default)
 *
 * Prints exactly where the brain was created, including the source of the
 * path when it came from the env var.
 *
 * Config file placement:
 *   Canonical location (v1.1+): <brain>/.lazybrain-config.json (INSIDE the brain dir).
 *   Legacy location (pre-v1.1):  <parent-of-brain>/.lazybrain-config.json.
 *   Back-compat: when only the legacy file exists, the brain is treated as
 *   already-initialized and a one-line hint is logged.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getLogger } from '../util/logger.js';

export interface InitOptions {
  path?: string; // explicit path from --brain flag
  force?: boolean; // overwrite if exists
  pretty?: boolean;
}

export interface InitReport {
  brainPath: string;
  created: boolean;
  notes: string;
  cache: string;
  knowledgeNodes: string;
  configWritten: boolean;
  /** Which source determined the brain location. */
  resolvedFrom: 'flag' | 'env' | 'cwd';
}

const CONFIG_FILENAME = '.lazybrain-config.json';

/**
 * Create a directory if it does not exist. Throws if mkdir fails.
 */
function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Resolve the canonical config path (INSIDE the brain dir) and the legacy
 * config path (in the PARENT of the brain dir).
 *
 * Two sibling brains at /tmp/a and /tmp/b previously shared one config at
 * /tmp/.lazybrain-config.json.  The canonical path places the config inside
 * each brain dir so they can never collide.
 */
function resolveConfigPaths(brainPath: string): {
  canonical: string;
  legacy: string;
} {
  return {
    canonical: resolve(join(brainPath, CONFIG_FILENAME)),
    legacy: resolve(join(brainPath, '..', CONFIG_FILENAME)),
  };
}

/**
 * Check whether a brain is already initialized.
 *
 * Returns:
 *  - 'canonical'  — canonical config (inside brain dir) exists.
 *  - 'legacy'     — only the legacy parent-dir config exists (back-compat).
 *  - null         — not initialized.
 */
function detectExistingInit(canonical: string, legacy: string): 'canonical' | 'legacy' | null {
  if (existsSync(canonical)) return 'canonical';
  if (existsSync(legacy)) return 'legacy';
  return null;
}

/**
 * Determine the brain base directory and resolution source.
 *
 * Resolution order:
 *   1. opts.path (--brain CLI flag passed directly as argument)
 *   2. LAZYBRAIN_BRAIN_PATH_CLI (set by the global --brain Commander option
 *      via the preAction coercion in bin/lazybrain.ts) — same "flag" tier
 *   3. LAZYBRAIN_BRAIN_PATH env var
 *   4. $CWD/.lazybrain/brain
 */
function resolveBrainTarget(opts: InitOptions): {
  brainPath: string;
  resolvedFrom: InitReport['resolvedFrom'];
} {
  if (opts.path !== undefined && opts.path !== '') {
    return {
      brainPath: resolve(opts.path),
      resolvedFrom: 'flag',
    };
  }

  // The global --brain Commander option cannot be received by subcommand opts
  // because Commander 12 does not forward parent options into child action opts.
  // It is forwarded via process.env.LAZYBRAIN_BRAIN_PATH_CLI instead (set by
  // the coercion function in bin/lazybrain.ts). Treat this as the "flag" tier.
  if (process.env.LAZYBRAIN_BRAIN_PATH_CLI) {
    return {
      brainPath: resolve(process.env.LAZYBRAIN_BRAIN_PATH_CLI),
      resolvedFrom: 'flag',
    };
  }

  if (process.env.LAZYBRAIN_BRAIN_PATH) {
    return {
      brainPath: resolve(process.env.LAZYBRAIN_BRAIN_PATH),
      resolvedFrom: 'env',
    };
  }

  return {
    brainPath: resolve(process.cwd(), '.lazybrain', 'brain'),
    resolvedFrom: 'cwd',
  };
}

export async function runInit(opts: InitOptions): Promise<InitReport> {
  const log = getLogger();

  const { brainPath, resolvedFrom } = resolveBrainTarget(opts);

  const notesPath = join(brainPath, 'notes');
  const knowledgeNodesPath = join(brainPath, 'knowledge-nodes');
  const cachePath = join(brainPath, '_cache');
  const metaPath = join(brainPath, 'meta');

  // Canonical config lives INSIDE the brain directory (prevents sibling-brain
  // collisions that occurred when the file was placed in the parent dir).
  const { canonical: canonicalConfigPath, legacy: legacyConfigPath } =
    resolveConfigPaths(brainPath);

  // Guard: refuse to overwrite an existing init unless --force.
  // Back-compat: also recognise the legacy parent-dir config as "already initialized".
  const existingKind = detectExistingInit(canonicalConfigPath, legacyConfigPath);
  if (existingKind !== null && !opts.force) {
    if (existingKind === 'legacy') {
      log.info(
        { brainPath, legacyConfigPath },
        'lazybrain init: legacy config found in parent dir — brain is initialized. Re-run with --force or move to canonical location.',
      );
    }
    throw new Error(`LazyBrain already initialized at ${brainPath}. Use --force to overwrite.`);
  }

  // Create directory structure (brain dir must exist before writing config into it)
  ensureDir(brainPath);
  ensureDir(notesPath);
  ensureDir(knowledgeNodesPath);
  ensureDir(cachePath);
  ensureDir(metaPath);

  // Write config INSIDE the brain dir (canonical location).
  const config = {
    version: '1.0.0',
    createdAt: new Date().toISOString(),
  };
  writeFileSync(canonicalConfigPath, JSON.stringify(config, null, 2), 'utf8');

  const fromLabel =
    resolvedFrom === 'flag'
      ? ' (from --brain)'
      : resolvedFrom === 'env'
        ? ' (from LAZYBRAIN_BRAIN_PATH)'
        : '';
  log.info(
    { brainPath, resolvedFrom, force: !!opts.force },
    `lazybrain init complete — brain at ${brainPath}${fromLabel}`,
  );

  // Human-readable line to stdout (always, regardless of --pretty flag,
  // so even plain JSON callers know where the brain landed).
  process.stdout.write(`Initialized brain at ${brainPath}${fromLabel}\n`);

  return {
    brainPath,
    created: existingKind === null,
    notes: notesPath,
    cache: cachePath,
    knowledgeNodes: knowledgeNodesPath,
    configWritten: true,
    resolvedFrom,
  };
}
