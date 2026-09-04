/**
 * bin/lazybrain.ts — CLI entry point.
 *
 * Thin orchestrator: reads the version, creates the root Command,
 * wires in the three command groups, then parses.
 *
 * Command groups live in src/cli/:
 *   register-core.ts     — search, query, store, link, invalidate, capture,
 *                           compress, neighbours, extract, inject-context,
 *                           stats, profile-update, prune
 *   register-pipeline.ts — index-rebuild, interlink, dream, graph, build-index,
 *                           build-clusters, build-hierarchy, enrich-hierarchy,
 *                           enrich, export-agents-md, synthesize-nodes, publish
 *   register-serve.ts    — serve, daemon (start/status/stop), init, wipe,
 *                           fingerprints (stats/clean)
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { registerCore } from '../src/cli/register-core.js';
import { registerPipeline } from '../src/cli/register-pipeline.js';
import { registerServe } from '../src/cli/register-serve.js';

// Read version from package.json at runtime — works in both tsx dev mode
// (import.meta.url → bin/) and the esbuild bundle (import.meta.url → dist/bin/).
// We try the bundle-relative path first (../../package.json from dist/bin/),
// then fall back to the dev-relative path (../package.json from bin/), then
// the same-directory path (./package.json) used by the app's shipped sidecar
// layout, where lazybrain.js sits next to a minimal generated package.json
// (written by scripts/bundle-lazybrain.mjs at bundle time).
// Guard on `name`: from bin/ (tsx dev mode), '../../package.json' resolves
// past engine/ into the monorepo root's package.json, which also has a
// valid string `version` — without this check that unrelated file would be
// mistaken for our own, so only lazybrain's package.json is accepted.
function _readPkgVersion(): string {
  const base = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../../package.json', '../package.json', './package.json']) {
    try {
      const raw = readFileSync(join(base, rel), 'utf8');
      const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
      if (parsed.name === 'lazybrain' && typeof parsed.version === 'string') {
        return parsed.version;
      }
    } catch {
      // try next candidate
    }
  }
  return 'unknown';
}
const _cliVersion = _readPkgVersion();

const program = new Command();
program
  .name('lazybrain')
  .description('HTML-first persistent memory for LLM agents.')
  .version(_cliVersion)
  .option('--brain <path>', 'override brain path (sets LAZYBRAIN_BRAIN_PATH_CLI)', (p) => {
    process.env.LAZYBRAIN_BRAIN_PATH_CLI = p;
    return p;
  });

registerCore(program);
registerPipeline(program);
registerServe(program);

program.parseAsync(process.argv).catch(handle);

function handle(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`lazybrain: ${msg}\n`);
  if (process.env.LAZYBRAIN_LOG_LEVEL === 'debug' && err instanceof Error) {
    process.stderr.write(`${err.stack}\n`);
  }
  const code = msg.includes('Schema validation') ? 4 : msg.includes('not found') ? 5 : 1;
  process.exit(code);
}
