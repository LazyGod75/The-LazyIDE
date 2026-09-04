/**
 * Resolve canonical paths used by the CLI:
 * - lazybrainScript: path to lazybrain.js
 * - brainPath: <cwd>/.lazybrain/brain (or LAZYBRAIN_BRAIN_PATH env override)
 *
 * Mirrors the priority order in src-tauri/src/lib.rs resolve_lazybrain_bin_static
 * and resolve_brain_path_static.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

// __dirname is available in CJS (esbuild cjs bundle).
// In ESM it would require fileURLToPath(import.meta.url).
// Since we bundle with esbuild --format=cjs, __dirname works at runtime.
declare const __dirname: string;
const _here = __dirname;

/** Resolve the lazybrain.js script path. */
export function resolveLazybrainScript(): string {
  // 1. Explicit env var — highest priority, works on any machine
  const envScript = process.env['LAZYBRAIN_SCRIPT'];
  if (envScript && existsSync(envScript)) {
    return envScript;
  }

  // 2. Dev path: sibling LazyBrain repo
  // __here is src/cli/lib — go up 4 levels: lib -> cli -> src -> Lazy -> cerveau
  const devScript = join(_here, '..', '..', '..', '..', 'LazyBrain', 'dist', 'bin', 'lazybrain.js');
  if (existsSync(devScript)) {
    return devScript;
  }

  // 3. Bundled sidecar path (Tauri bundles the binary alongside the CLI)
  const sidecar = join(_here, '..', '..', '..', 'bin', 'lazybrain.js');
  if (existsSync(sidecar)) {
    return sidecar;
  }

  throw new Error(
    'lazybrain.js not found. Set LAZYBRAIN_SCRIPT env var or ensure LazyBrain is built at ../LazyBrain/dist/bin/lazybrain.js',
  );
}

/** Resolve the brain path for a given project root. */
export function resolveBrainPath(projectRoot: string): string {
  // Env var override
  const envPath = process.env['LAZYBRAIN_BRAIN_PATH'];
  if (envPath) return envPath;

  return join(projectRoot, '.lazybrain', 'brain');
}
