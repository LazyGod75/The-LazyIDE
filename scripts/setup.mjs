#!/usr/bin/env node
/**
 * Lazy — one-command setup.
 *
 *   npm run setup       → install deps + build engine + ready to go
 *   npm start            → same, then launch tauri dev
 *
 * What it does:
 *   1. Check Node version (>= 20.12)
 *   2. Check Rust is installed (warn if not, link to install)
 *   3. npm install
 *   4. Build the LazyBrain engine (engine/)
 *   5. If --dev flag: launch tauri dev
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const launchDev = args.includes('--dev');

const MIN_NODE_MAJOR = 20;
const MIN_NODE_MINOR = 12;

function run(cmd, label) {
  console.log(`\n→ ${label}\n  $ ${cmd}\n`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
}

function checkNode() {
  const version = process.versions.node;
  const [major, minor] = version.split('.').map(Number);
  if (major < MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor < MIN_NODE_MINOR)) {
    console.error(`\n[!] Node ${version} detected — Lazy requires Node >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.`);
    console.error('    Install from https://nodejs.org/ and retry.');
    process.exit(1);
  }
  console.log(`Node ${version} OK`);
}

function checkRust() {
  try {
    execSync('rustc --version', { cwd: ROOT, stdio: 'pipe' });
    console.log('Rust OK');
  } catch {
    console.warn('\n[!] Rust not found — desktop build (tauri dev) will not work.');
    console.warn('    Install from https://rustup.rs/ if you want the full desktop app.');
    console.warn('    Web-only preview (npm run dev) still works without Rust.\n');
  }
}

console.log('Lazy — setup\n=============');

checkNode();
checkRust();

run('npm install', 'Installing dependencies');

if (existsSync(path.join(ROOT, 'engine'))) {
  run('cd engine && npm install && npm run build', 'Building LazyBrain engine');
}

console.log('\nSetup complete.');

if (launchDev) {
  console.log('\nLaunching desktop app...\n');
  try {
    execSync('npm run tauri dev', { cwd: ROOT, stdio: 'inherit' });
  } catch {
    console.error('\n[!] tauri dev failed — make sure Rust is installed (https://rustup.rs/).');
    console.error('    You can still run the web preview with: npm run dev');
    process.exit(1);
  }
} else {
  console.log('\nNext steps:');
  console.log('  npm start          Launch the desktop app');
  console.log('  npm run dev        Web-only preview (mock data)');
  console.log('  npm test           Run tests');
  console.log('  npm run tauri build  Build installers\n');
}
