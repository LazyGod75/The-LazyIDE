#!/usr/bin/env node
/**
 * Prepares the LazyBrain sidecar bundle for Tauri packaging.
 *
 * Self-contained: the engine now lives inside this repo at engine/ (vendored
 * source-only snapshot of LazyBrain@3900272 v0.2.0, via `git archive`; see
 * .gitignore for engine/node_modules and engine/dist — build artifacts,
 * not committed). Before running this script, build the engine first:
 *   cd engine && npm run build   (esbuild bin/lazybrain.ts -> engine/dist/bin/lazybrain.js)
 * This script then copies from engine/dist and engine/node_modules — it no
 * longer reaches into a sibling ../LazyBrain checkout.
 *
 * Copies into src-tauri/resources/lazybrain/:
 *   - dist/bin/lazybrain.js          (the bundled CLI)
 *   - package.json                   (generated here: name/version from engine/package.json
 *                                     + "type": "module" — REQUIRED: the bundle is ESM, and
 *                                     without a package.json in the shipped tree Node treats
 *                                     lazybrain.js as CommonJS and the sidecar dies on its
 *                                     first `import` statement; it also lets the CLI report
 *                                     its real version instead of 'unknown')
 *   - node_modules/better-sqlite3/   (native addon - win32-x64)
 *   - node_modules/bindings/         (needed by better-sqlite3)
 *   - node_modules/file-uri-to-path/ (needed by bindings)
 *   - node_modules/linkedom/
 *   - node_modules/commander/
 *   - node_modules/pino/             (+ pino's deps: on-exit-leak-free, pino-std-serializers, etc.)
 *   - node_modules/smol-toml/
 *   - node_modules/web-tree-sitter/
 *   - node_modules/tree-sitter-wasms/
 *   - node_modules/@huggingface/transformers/  (real package, ~352 MB including onnxruntime-node)
 *
 * @huggingface/transformers IS bundled (with its nested node_modules containing onnxruntime-node).
 * Model weights are NOT bundled — they are downloaded on first use via LAZYBRAIN_EMBEDDINGS=1
 * and cached under ~/.lazybrain/models. This keeps the installer reasonable while enabling
 * semantic L3/L4 search out of the box.
 *
 * node.exe is NOT copied by this script — it must be placed manually or via CI:
 *   src-tauri/resources/node.exe  (download from https://nodejs.org/dist/v20.x.x/node-v20.x.x-win-x64.zip)
 * See BUNDLING.md or the git-ignored .bundle-sources/ directory.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC_TAURI = join(ROOT, 'src-tauri');
const LAZYBRAIN_SRC = resolve(ROOT, 'engine');
const DEST = join(SRC_TAURI, 'resources', 'lazybrain');
const DEST_NM = join(DEST, 'node_modules');

// Runtime-required npm packages (including @huggingface/transformers for semantic L3/L4)
const RUNTIME_PACKAGES = [
  'better-sqlite3',
  'bindings',
  'file-uri-to-path',
  'linkedom',
  'commander',
  'smol-toml',
  'web-tree-sitter',
  'tree-sitter-wasms',
  'pino',
  // pino runtime deps
  'on-exit-leak-free',
  'pino-std-serializers',
  'quick-format-unescaped',
  'real-require',
  'safe-stable-stringify',
  'sonic-boom',
  'thread-stream',
  'atomic-sleep',
  // chokidar is used by the serve watcher
  'chokidar',
  'readdirp',
  // linkedom runtime deps (htmlparser2 + full transitive closure)
  'htmlparser2',
  'domhandler',
  'domutils',
  'dom-serializer',
  'entities',
  'css-select',
  'css-what',
  'domelementtype',
  'boolbase',
  'nth-check',
  'cssom',
  'html-escaper',
  'uhyphen',
  // pino + better-sqlite3 transitive deps
  '@pinojs/redact',
  'pino-abstract-transport',
  'process-warning',
  'split2',
  'readable-stream',
  'string_decoder',
  'util-deprecate',
  'safe-buffer',
  'inherits',
  'base64-js',
  'bl',
  'buffer',
  'ieee754',
  'end-of-stream',
  'once',
  'wrappy',
  'pump',
  'napi-build-utils',
  'node-abi',
  'semver',
  'prebuild-install',
  'detect-libc',
  'rc',
  'ini',
  'minimist',
  'strip-json-comments',
  'mkdirp-classic',
  'decompress-response',
  'mimic-response',
  'simple-get',
  'simple-concat',
  'tar-fs',
  'tar-stream',
  'chownr',
  'fs-constants',
  'tunnel-agent',
  'deep-extend',
  'expand-template',
  'github-from-package',
  // Semantic embeddings (L3/L4) — real package with nested onnxruntime-node
  // Model weights are NOT bundled: downloaded on first use via LAZYBRAIN_EMBEDDINGS=1
  // and cached under ~/.lazybrain/models. Package size ~352 MB (onnxruntime binaries included).
  '@huggingface/transformers',
  // sharp is a static import inside transformers.node.mjs (image pre-processing).
  // Its native win32-x64 binary lives in @img/sharp-win32-x64 (resolved from top-level nm).
  '@img/sharp-win32-x64',
  '@img/colour',
];

function sizeOf(p) {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

function fmtBytes(b) {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

function copyDir(src, dest, label) {
  if (!existsSync(src)) {
    console.warn(`  SKIP (not found): ${label} — ${src}`);
    return;
  }
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log(`  OK: ${label}`);
}

console.log('=== bundle-lazybrain: preparing sidecar resources ===');
console.log(`  Source : ${LAZYBRAIN_SRC}`);
console.log(`  Dest   : ${DEST}`);
console.log('');

// Clean old resources
if (existsSync(DEST)) {
  rmSync(DEST, { recursive: true, force: true });
  console.log('  Cleaned old resources/lazybrain/');
}
mkdirSync(DEST_NM, { recursive: true });

// 1. Copy lazybrain.js bundle
const srcJs = join(LAZYBRAIN_SRC, 'dist', 'bin', 'lazybrain.js');
if (!existsSync(srcJs)) {
  console.error(`ERROR: lazybrain.js not found at ${srcJs}`);
  console.error('Run: cd engine && npm run build');
  process.exit(1);
}
const destJs = join(DEST, 'lazybrain.js');
cpSync(srcJs, destJs);
console.log(`  OK: lazybrain.js (${fmtBytes(sizeOf(destJs))})`);

// 1b. Write a minimal package.json next to lazybrain.js. Two jobs:
//     - "type": "module" — the esbuild bundle is ESM; without a package.json
//       anywhere above it in the installed tree, Node treats the .js file as
//       CommonJS and the sidecar crashes on its first `import` statement
//       (proven on a real 0.1.4 install; dev machines were masked because
//       Node's upward walk found this repo's own package.json).
//     - name/version — read from engine/package.json at bundle time (never
//       hardcoded) so the CLI's _readPkgVersion() reports the real engine
//       version in the shipped layout instead of 'unknown'.
const enginePkg = JSON.parse(readFileSync(join(LAZYBRAIN_SRC, 'package.json'), 'utf8'));
if (enginePkg.name !== 'lazybrain' || typeof enginePkg.version !== 'string') {
  console.error(
    `ERROR: unexpected engine package.json (name=${enginePkg.name}, version=${enginePkg.version})`,
  );
  process.exit(1);
}
const sidecarPkg = { name: enginePkg.name, version: enginePkg.version, type: 'module' };
writeFileSync(join(DEST, 'package.json'), `${JSON.stringify(sidecarPkg, null, 2)}\n`, 'utf8');
console.log(`  OK: package.json (${sidecarPkg.name}@${sidecarPkg.version}, type=module)`);

// 2. Copy runtime node_modules
const srcNM = join(LAZYBRAIN_SRC, 'node_modules');
for (const pkg of RUNTIME_PACKAGES) {
  const src = join(srcNM, pkg);
  const dest = join(DEST_NM, pkg);
  copyDir(src, dest, pkg);
}

// 3. Report node.exe status
const nodeExeDest = join(SRC_TAURI, 'resources', 'node.exe');
if (existsSync(nodeExeDest)) {
  console.log(`\n  node.exe already present (${fmtBytes(sizeOf(nodeExeDest))})`);
} else {
  console.log('\n  NOTE: node.exe NOT found at src-tauri/resources/node.exe');
  console.log('        Run: node scripts/fetch-node-exe.mjs  (downloads ~66 MB)');
  console.log('        Or copy manually from C:\\Program Files\\nodejs\\node.exe');
}

console.log('\n=== bundle-lazybrain: done ===');
