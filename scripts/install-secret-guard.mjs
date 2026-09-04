#!/usr/bin/env node
/** Copy .githooks/pre-commit into .git/hooks. Does not change git config. */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const gitHooks = path.join(ROOT, '.git', 'hooks');
const src = path.join(ROOT, '.githooks', 'pre-commit');
if (!existsSync(path.join(ROOT, '.git'))) {
  console.log('install-secret-guard: no .git directory, skip');
  process.exit(0);
}
if (!existsSync(src)) {
  console.error('missing .githooks/pre-commit');
  process.exit(1);
}
mkdirSync(gitHooks, { recursive: true });
copyFileSync(src, path.join(gitHooks, 'pre-commit'));
console.log('install-secret-guard: wrote .git/hooks/pre-commit');
