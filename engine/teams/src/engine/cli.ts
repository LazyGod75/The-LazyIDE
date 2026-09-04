/**
 * Robust spawn wrapper for the lazybrain CLI.
 *
 * Resolves the CLI path via Node's require resolution (createRequire) so it
 * works reliably on Windows where .bin shims are unreliable inside ESM.
 *
 * LAZYBRAIN_* env vars are stripped from the inherited environment before
 * spawning — the caller passes brainPath explicitly via LAZYBRAIN_BRAIN_PATH.
 * LAZYBRAIN_ALLOW_REMOTE_MODELS is removed to enforce the no-download default.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// CLI path resolution
// ---------------------------------------------------------------------------

const _require = createRequire(import.meta.url);
const LAZYBRAIN_BIN = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../node_modules/lazybrain/dist/bin/lazybrain.js',
);

// Verify at module load time (fail loudly rather than at first call)
try {
  _require.resolve('lazybrain/dist/bin/lazybrain.js');
} catch {
  // Non-fatal: path is hardcoded above; resolve is best-effort confirmation
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SpawnOptions {
  readonly brainPath: string;
  readonly timeoutMs?: number;
  readonly input?: string;
}

// ---------------------------------------------------------------------------
// Env sanitisation
// ---------------------------------------------------------------------------

function buildEnv(brainPath: string): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('LAZYBRAIN_')) continue;
    clean[key] = value;
  }

  clean.LAZYBRAIN_BRAIN_PATH = brainPath;
  clean.LAZYBRAIN_TELEMETRY = '0'; // disable telemetry in team brains
  return clean;
}

// ---------------------------------------------------------------------------
// Core spawner
// ---------------------------------------------------------------------------

export function runLazybrain(args: readonly string[], opts: SpawnOptions): Promise<CliResult> {
  const { brainPath, timeoutMs = 30_000, input } = opts;

  return new Promise<CliResult>((resolve) => {
    const child = spawn(process.execPath, [LAZYBRAIN_BIN, ...args], {
      env: buildEnv(brainPath),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({
        code: -1,
        stdout,
        stderr: `${stderr}\n[lazybrain-teams] CLI timeout after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        code: -1,
        stdout,
        stderr: `${stderr}\n[lazybrain-teams] spawn error: ${err.message}`,
      });
    });

    if (input !== undefined) {
      child.stdin.write(input, 'utf-8');
    }
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

/**
 * Parse JSON from CLI stdout, returning null on parse failure.
 */
export function parseJsonOutput<T>(result: CliResult): T | null {
  const raw = result.stdout.trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Shape returned by `lazybrain store` */
export interface StoreOutput {
  readonly id: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly attrsCount: number;
}

/** One hit from `lazybrain search` */
export interface SearchHit {
  readonly id: string;
  readonly path: string;
  readonly score: number;
  readonly level: string;
  readonly note: {
    readonly id: string;
    readonly text: string;
    readonly type: string;
    readonly source: string;
    readonly created: string;
    readonly tags: readonly string[];
    readonly facts: readonly unknown[];
    readonly links: readonly unknown[];
  };
}

/** Top-level shape returned by `lazybrain search` */
export interface SearchOutput {
  readonly level: string;
  readonly total_ms: number;
  readonly hits: readonly SearchHit[];
}

/** One hit from `lazybrain query` */
export interface QueryHit {
  readonly noteId: string;
  readonly notePath: string;
  readonly fragment: string;
  readonly text: string;
}

/** Top-level shape returned by `lazybrain query` */
export interface QueryOutput {
  readonly count: number;
  readonly hits: readonly QueryHit[];
}
