#!/usr/bin/env node
/**
 * Scan tracked or staged files for Stripe / Supabase / R2 / signing secrets.
 * Usage:
 *   node scripts/guard-secrets.mjs           # git ls-files
 *   node scripts/guard-secrets.mjs --staged  # git index (pre-commit)
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanText } from './lib/secret-guard.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function listFiles(staged) {
  const cmd = staged
    ? 'git diff --cached --name-only --diff-filter=ACM'
    : 'git ls-files';
  const out = execSync(cmd, { cwd: ROOT, encoding: 'utf8' });
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function isProbablyBinary(filePath) {
  return /\.(png|jpg|jpeg|gif|webp|exe|dll|node|wasm|zip|gz|7z|woff2?|pdf)$/i.test(filePath);
}

const staged = process.argv.includes('--staged');
const files = listFiles(staged);
let failed = false;

for (const rel of files) {
  const abs = path.join(ROOT, rel);
  if (rel.includes('node_modules/') || rel.endsWith('package-lock.json') || rel.endsWith('pnpm-lock.yaml')) continue;
  // Whitelist the secret-guard scripts themselves — their regex patterns
  // (e.g. "BEGIN PRIVATE KEY") are code, not real secrets.
  if (rel === 'scripts/lib/secret-guard.mjs' || rel === 'src/lib/security/secretGuard.ts' || rel === 'scripts/guard-secrets.mjs' || rel === 'scripts/export-public-repo.mjs' || rel === 'src/__tests__/secretGuard.test.ts') continue;
  if (!existsSync(abs) || isProbablyBinary(rel)) continue;
  let content;
  try {
    content = readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  const hits = scanText(content);
  if (hits.length === 0) continue;
  failed = true;
  for (const hit of hits) {
    console.error(`SECRET: ${rel}:${hit.line} [${hit.rule}]`);
  }
}

if (failed) {
  console.error('\nRefusing to proceed: secret-looking values found.');
  console.error('Use placeholders (sk_live_...) or GitHub ${{ secrets.* }} — never commit real Stripe, Supabase service-role, R2, or signing keys.');
  process.exit(1);
}

console.log(staged ? 'secret-guard: staged files clean' : 'secret-guard: tracked files clean');
