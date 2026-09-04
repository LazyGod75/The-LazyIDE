/**
 * Build the headless IDE benchmark harness → dist/cli/idebench.cjs
 *
 * Bundles src/cli/ide/ideAgent.ts (which imports the REAL IDE tool runtime,
 * prompt and registry) for Node, replacing:
 *   - `@tauri-apps/api/core` → src/cli/ide/tauriCore.ts (node:fs/child_process)
 *   - app modules that cannot run headless (platform, brain, journal, bus,
 *     costStore, transforms, permissions, agentsStorage, systemPrompts)
 *     → src/cli/ide/stubs.ts
 */

import { build } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const tauriCore = join(root, 'src', 'cli', 'ide', 'tauriCore.ts');
const stubs = join(root, 'src', 'cli', 'ide', 'stubs.ts');

/** Path prefixes that must be replaced by the headless stubs. */
const STUB_DIRS = [
  '/src/lib/platform',
  '/src/lib/brain',
  '/src/lib/models/costStore',
  '/src/lib/models/systemPrompts',
  '/src/lib/agents/transformTools',
  '/src/lib/agents/transformSandbox',
  '/src/lib/agents/managedToolPermissions',
  '/src/lib/agents/agentsStorage',
  '/src/lib/bus',
  '/src/lib/journal',
];

const ideStubPlugin = {
  name: 'ide-stubs',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.path.startsWith('node:') || args.path.startsWith('\0')) return undefined;
      if (args.path === '@tauri-apps/api/core') {
        return { path: tauriCore, namespace: 'file' };
      }
      if (args.path.startsWith('.')) {
        const candidate = resolve(dirname(args.importer), args.path).replace(/\\/g, '/');
        if (STUB_DIRS.some((d) => candidate.includes(d))) {
          return { path: stubs, namespace: 'file' };
        }
      }
      return undefined;
    });
  },
};

const result = await build({
  entryPoints: [join(root, 'src', 'cli', 'ide', 'ideAgent.ts')],
  outfile: join(root, 'dist', 'cli', 'idebench.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  plugins: [ideStubPlugin],
  logLevel: 'info',
});

if (result.errors.length > 0) {
  process.stderr.write(`[build-idebench] ${result.errors.length} error(s)\n`);
  process.exit(1);
}
process.stdout.write('[build-idebench] dist/cli/idebench.cjs built successfully.\n');
