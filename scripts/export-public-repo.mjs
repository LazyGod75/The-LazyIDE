#!/usr/bin/env node
/**
 * Copy the public surface of this repo into a clean directory for the
 * public GitHub remote. Never copies Supabase/Stripe backend, official
 * R2 release pipelines, or env files.
 *
 * Usage:
 *   node scripts/export-public-repo.mjs [--dry-run] [dest]
 * Default dest: ../Lazy-public
 * Alt: ./dist/public-export
 */

import { execSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanText } from './lib/secret-guard.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2).filter((a) => a !== '--');
const DRY = args.includes('--dry-run');
const destArg = args.find((a) => !a.startsWith('--'));
const DEST = path.resolve(destArg || path.join(ROOT, '..', 'Lazy-public'));

/** @type {{ prefixes: string[], files: string[] }} */
let manifest = {
  prefixes: ['supabase/', 'cloud/'],
  files: [
    'RELEASING.md',
    'ACTIVATION.md',
    '.github/workflows/release.yml',
    '.github/workflows/republish-manifest.yml',
  ],
};
const manifestPath = path.join(ROOT, 'cloud', 'PRIVATE_MANIFEST.json');
if (existsSync(manifestPath)) {
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (Array.isArray(raw.prefixes)) manifest.prefixes = raw.prefixes;
    if (Array.isArray(raw.files)) manifest.files = raw.files;
  } catch (e) {
    console.warn('export-public-repo: could not parse PRIVATE_MANIFEST.json, using defaults', e);
  }
}

const PRIVATE_PREFIXES = manifest.prefixes;
const PRIVATE_FILES = new Set(manifest.files);

/** Extra paths never published even if somehow tracked. */
const EXTRA_SKIP = [
  /^\.lazy(\/|$)/,
  /^_qa([/-]|$)/,
  /^scrape(d)?[-.].*/,
  /^node_modules(\/|$)/,
  // Any nested node_modules (e.g. src-tauri/resources/lazybrain/node_modules) —
  // vendored deps must NOT be committed to a public repo.
  /(^|\/)node_modules(\/|$)/,
  /^src-tauri\/target(\/|$)/,
  /^dist(\/|$)/,
  // Accidental path-collapse junk sometimes lands in the index on Windows
  /^UsersDavid/,
  // Ad-hoc QA scratch (scripts, state dumps, debug output)
  /^scratch(\/|$)/,
  // E2E screenshots (test artifacts, not source)
  /^e2e\/screenshots(\/|$)/,
  // Ad-hoc benchmark shell scripts
  /^bench\/_.*\.sh$/,
  // Ad-hoc root scripts
  /^shoot-site\.mjs$/,
  // Dev agent configs
  /^\.claude(\/|$)/,
  // Internal reports and audits
  /^docs\/AUDIT-REMEDIATION.*\.md$/,
  /^docs\/BENCHMARKS.*\.md$/,
  /^docs\/CLAUDE-AB-BENCHMARK\.md$/,
  /^docs\/DEEPSEEK-BENCHMARK\.md$/,
  /^docs\/SESSION-REPORT.*\.md$/,
  /^docs\/benchmark-vs-competitors\.md$/,
  /^docs\/archive(\/|$)/,
  // Internal dev planning docs
  /^docs\/superpowers(\/|$)/,
  // Internal product / engineering spec (personal machine paths + founder notes)
  /^SPEC\.md$/,
  // Internal docs that are not user-facing (founder notes, anti-bot research,
  // team-brain internals). Any of these would leak paths, competitor research,
  // or private invariants.
  /^docs\/BENCH-INTEGRATION\.md$/,
  /^docs\/LAZY-BOTS-SOLARI-NOTES\.md$/,
  /^docs\/TEAM-BRAIN\.md$/,
  // Junk / debug dump that accidentally got tracked
  /^eslint2\.json$/,
  // Dev-only dead code checker
  /^scripts\/check-team-brain-deadcode\.(ps1|sh)$/,
];

/** Public docs that must ship even if not yet git-added. */
const FORCE_INCLUDE = [
  'SECURITY.md',
  'docs/OPEN-SOURCE-CHECKLIST.md',
  'LICENSE.md',
  'CONTRIBUTING.md',
];

function norm(rel) {
  return rel.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isBlockedEnv(n) {
  const base = n.split('/').pop() ?? n;
  if (base === '.env') return true;
  return base.startsWith('.env.') && base !== '.env.example';
}

function isPrivate(rel) {
  const n = norm(rel);
  if (PRIVATE_FILES.has(n)) return true;
  if (isBlockedEnv(n)) return true;
  if (PRIVATE_PREFIXES.some((p) => n === p.slice(0, -1) || n.startsWith(p))) return true;
  if (EXTRA_SKIP.some((re) => re.test(n))) return true;
  return false;
}

// Supabase URL + anon key are PUBLIC by design (see
// cloudConfig.ts). They are NOT redacted so anyone who clones the public
// repo can sign up for a Lazy account and subscribe to LazyPro.
// R2 account id and public host stay redacted (updater endpoints are
// cleared separately, and these are internal infra details).
const REDACTIONS = [
  [/<r2-account-id>/g, '<r2-account-id>'],
  [/<r2-public-host>/g, '<r2-public-host>'],
  // GitHub OAuth client id is public by design — but keep redacting
  [/<github-oauth-client-id>/g, '<github-oauth-client-id>'],
];

function redact(content) {
  let out = content;
  for (const [re, replacement] of REDACTIONS) {
    out = out.replace(re, replacement);
  }
  return out;
}

function sanitizeTauriConf(content) {
  const json = JSON.parse(content);
  if (json.plugins?.updater) {
    json.plugins.updater.endpoints = [];
  }
  return `${JSON.stringify(json, null, 2)}\n`;
}

function listTracked() {
  return execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function writePublicFile(rel, fromAbs, toAbs) {
  mkdirSync(path.dirname(toAbs), { recursive: true });
  if (norm(rel) === 'src-tauri/tauri.conf.json') {
    writeFileSync(toAbs, sanitizeTauriConf(readFileSync(fromAbs, 'utf8')), 'utf8');
    return;
  }
  if (TEXT.test(rel) || rel.endsWith('LICENSE') || rel.endsWith('LICENSE.md')) {
    writeFileSync(toAbs, redact(readFileSync(fromAbs, 'utf8')), 'utf8');
    return;
  }
  cpSync(fromAbs, toAbs);
}

const TEXT = /\.(md|txt|ts|tsx|js|mjs|cjs|json|yml|yaml|toml|css|html|svg|rs)$/i;

const tracked = listTracked();
const trackedSet = new Set(tracked.map(norm));
let copied = 0;
let skipped = 0;
const skipReasons = [];

function forceMissing() {
  return FORCE_INCLUDE.filter((rel) => {
    const n = norm(rel);
    return !trackedSet.has(n) && existsSync(path.join(ROOT, rel));
  });
}

if (DRY) {
  for (const rel of tracked) {
    if (isPrivate(rel)) {
      skipped += 1;
      skipReasons.push(norm(rel));
      continue;
    }
    copied += 1;
  }
  const forced = forceMissing();
  console.log(
    `export-public-repo DRY-RUN: would copy ${copied} tracked + ${forced.length} force-include, skip ${skipped}, dest=${DEST}`,
  );
  if (forced.length) console.log(`  force-include: ${forced.join(', ')}`);
  if (skipReasons.length && process.env.EXPORT_VERBOSE) {
    for (const s of skipReasons.slice(0, 50)) console.log(`  skip ${s}`);
    if (skipReasons.length > 50) console.log(`  ... +${skipReasons.length - 50} more`);
  }
  process.exit(0);
}

if (existsSync(DEST)) {
  // Preserve an existing .git so repeated exports keep the clone's history
  // (the caller rebases/pushes from DEST; wiping it forced a fresh init +
  // fetch every run and silently lost the local branch setup).
  for (const entry of readdirSync(DEST)) {
    if (entry === '.git') continue;
    rmSync(path.join(DEST, entry), { recursive: true, force: true });
  }
}
mkdirSync(DEST, { recursive: true });

for (const rel of tracked) {
  if (isPrivate(rel)) {
    skipped += 1;
    continue;
  }
  const from = path.join(ROOT, rel);
  const to = path.join(DEST, rel);
  if (!existsSync(from)) continue;
  writePublicFile(rel, from, to);
  copied += 1;
}

for (const rel of forceMissing()) {
  writePublicFile(rel, path.join(ROOT, rel), path.join(DEST, rel));
  copied += 1;
  console.log(`export-public-repo: force-included untracked ${rel}`);
}

let secretFails = 0;
// Whitelist the secret-guard scripts themselves — their regex patterns
// (e.g. "BEGIN PRIVATE KEY") are code, not real secrets.
const SECRET_SCAN_SKIP = new Set([
  'scripts/guard-secrets.mjs',
  'scripts/lib/secret-guard.mjs',
  'scripts/export-public-repo.mjs',
  'src/lib/security/secretGuard.ts',
  'src/__tests__/secretGuard.test.ts',
]);
const scanList = [...tracked.filter((r) => !isPrivate(r) && !SECRET_SCAN_SKIP.has(norm(r))), ...FORCE_INCLUDE.filter((r) => !SECRET_SCAN_SKIP.has(norm(r)))];
for (const rel of new Set(scanList.map(norm))) {
  const to = path.join(DEST, rel);
  if (!existsSync(to) || !TEXT.test(rel)) continue;
  const hits = scanText(readFileSync(to, 'utf8'));
  if (hits.length === 0) continue;
  secretFails += 1;
  for (const hit of hits) {
    console.error(`PUBLIC TREE SECRET: ${rel}:${hit.line} [${hit.rule}]`);
  }
}

// Scan for the developer's own home directory embedded in the tree. Even after
// the secret redaction above, a hard-coded absolute path like `C:\Users\Foo\...`
// (or `/Users/foo/...`) is a personal-info leak that must not ship in a public
// repo. We compare against the real `os.homedir()` of whoever runs the export.
function scanPersonalHome(content) {
  const homeBack = os.homedir(); // e.g. C:\Users\user
  const homeFwd = homeBack.replace(/\\/g, '/'); // C:/Users/user
  const lines = content.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(homeBack) || lines[i].includes(homeFwd)) hits.push(i + 1);
  }
  return hits;
}

let pathFails = 0;
for (const rel of new Set(scanList.map(norm))) {
  const to = path.join(DEST, rel);
  if (!existsSync(to) || !TEXT.test(rel) || SECRET_SCAN_SKIP.has(norm(rel))) continue;
  const p = readFileSync(to, 'utf8');
  // Also check the CURRENT source file (not just the copied dest) so a path in a
  // binary or a file past the TEXT filter is still caught on the way in.
  const src = path.join(ROOT, rel);
  const content = existsSync(src) ? readFileSync(src, 'utf8') : p;
  const homeHits = scanPersonalHome(content);
  if (homeHits.length === 0) continue;
  pathFails += 1;
  for (const line of homeHits) {
    console.error(`PUBLIC TREE PERSONAL PATH: ${rel}:${line}`);
  }
}

if (secretFails > 0 || pathFails > 0) {
  console.error('export-public-repo: refusing to emit a tree that still looks like it contains secrets or personal paths');
  process.exit(1);
}

console.log(`export-public-repo: copied ${copied} files, skipped ${skipped} private, dest=${DEST}`);
