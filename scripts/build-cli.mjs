/**
 * Build script: bundle src/cli/lazy.ts → dist/cli/lazy.js
 *
 * Uses esbuild with:
 *   - platform: node (no browser shims)
 *   - format: esm (ES modules, Node >= 18)
 *   - bundle: true (tree-shake + inline dependencies)
 *   - external: [] (inline everything except node: builtins)
 *   - banner: #!/usr/bin/env node shebang
 */

import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

await mkdir(join(root, 'dist', 'cli'), { recursive: true });

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
  process.stderr.write('[build-cli] package.json is missing a valid "version" field\n');
  process.exit(1);
}

const result = await build({
  entryPoints: [join(root, 'src', 'cli', 'lazy.ts')],
  outfile: join(root, 'dist', 'cli', 'lazy.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // Keep node: builtins external; bundle all npm deps (commander)
  external: [
    'node:fs',
    'node:fs/promises',
    'node:path',
    'node:url',
    'node:child_process',
    'node:process',
  ],
  define: {
    __LAZY_CLI_VERSION__: JSON.stringify(pkg.version),
  },
  logLevel: 'info',
});

if (result.errors.length > 0) {
  process.stderr.write(`[build-cli] ${result.errors.length} error(s)\n`);
  process.exit(1);
}

process.stdout.write(`[build-cli] dist/cli/lazy.cjs built successfully (version ${pkg.version}).\n`);
