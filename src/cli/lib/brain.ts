/**
 * Brain helpers: init, search, recall (inject-context), store.
 * Spawns the lazybrain CLI directly — no daemon needed.
 */

import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveLazybrainScript } from './paths.js';

const NODE = 'node';

function lb(brainPath: string): [string, string[]] {
  const script = resolveLazybrainScript();
  return [NODE, [script, '--brain', brainPath]];
}

/** Init the brain if it doesn't exist yet. */
export function ensureBrainInit(brainPath: string): void {
  const configFile = join(brainPath, '.lazybrain-config.json');
  if (existsSync(configFile)) return;

  const [exe, base] = lb(brainPath);
  const result = spawnSync(exe, [...base, 'init'], {
    env: { ...process.env, LAZYBRAIN_BRAIN_PATH: brainPath, LAZYBRAIN_LOG_LEVEL: 'warn', LAZYBRAIN_TELEMETRY: '0' },
    stdio: 'pipe',
    encoding: 'utf-8',
  });

  if (result.error) {
    throw new Error(`lazybrain init failed: ${result.error.message}`);
  }
}

/** Run lazybrain search, return stripped text. */
export function brainSearch(brainPath: string, query: string, top = 5): string {
  const [exe, base] = lb(brainPath);
  const result = spawnSync(
    exe,
    [...base, 'search', query, '--strip', '--top', String(top)],
    {
      env: { ...process.env, LAZYBRAIN_BRAIN_PATH: brainPath, LAZYBRAIN_LOG_LEVEL: 'warn', LAZYBRAIN_TELEMETRY: '0' },
      stdio: 'pipe',
      encoding: 'utf-8',
    },
  );

  if (result.error) {
    throw new Error(`lazybrain search failed: ${result.error.message}`);
  }
  return (result.stdout ?? '').trim();
}

/** Run lazybrain inject-context (turn mode) to recall context for a query. */
export function brainRecall(brainPath: string, query: string): string {
  const [exe, base] = lb(brainPath);
  const result = spawnSync(
    exe,
    [
      ...base,
      'inject-context',
      '--mode', 'turn',
      '--query', query,
      '--max-tokens', '2000',
      '--format', 'compact',
    ],
    {
      env: { ...process.env, LAZYBRAIN_BRAIN_PATH: brainPath, LAZYBRAIN_LOG_LEVEL: 'warn', LAZYBRAIN_TELEMETRY: '0' },
      stdio: 'pipe',
      encoding: 'utf-8',
    },
  );

  if (result.error) {
    throw new Error(`lazybrain inject-context failed: ${result.error.message}`);
  }
  return (result.stdout ?? '').trim();
}

/** Store a neuron HTML into the brain via lazybrain store (stdin). */
export function brainStoreHtml(brainPath: string, html: string): string {
  const [exe, base] = lb(brainPath);
  try {
    const out = execFileSync(exe, [...base, 'store'], {
      input: html,
      env: { ...process.env, LAZYBRAIN_BRAIN_PATH: brainPath, LAZYBRAIN_LOG_LEVEL: 'warn', LAZYBRAIN_TELEMETRY: '0' },
      encoding: 'utf-8',
    });
    return (out ?? '').trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`lazybrain store failed: ${msg}`, { cause: err });
  }
}
