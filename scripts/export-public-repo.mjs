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

/** @type {{ prefixes: string[], files: string[], forbiddenTerms: string[], allowedTerms: string[] }} */
let manifest = {
  prefixes: ['supabase/', 'cloud/'],
  files: [
    'RELEASING.md',
    'ACTIVATION.md',
    '.github/workflows/release.yml',
    '.github/workflows/republish-manifest.yml',
  ],
  forbiddenTerms: [],
  allowedTerms: [],
};
const manifestPath = path.join(ROOT, 'cloud', 'PRIVATE_MANIFEST.json');
if (existsSync(manifestPath)) {
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (Array.isArray(raw.prefixes)) manifest.prefixes = raw.prefixes;
    if (Array.isArray(raw.files)) manifest.files = raw.files;
    if (Array.isArray(raw.forbiddenTerms)) manifest.forbiddenTerms = raw.forbiddenTerms;
    if (Array.isArray(raw.allowedTerms)) manifest.allowedTerms = raw.allowedTerms;
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
  /^Users.*Documents/,
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

// ── Leak scanners ────────────────────────────────────────────────────
// A file only ships if it passes EVERY scan: secret patterns, the
// operator's home dir (in every mangled form), machine identity (OS
// username, hostname, git name/email), and the manifest's private
// vocabulary (forbiddenTerms). Any hit refuses the export — the public
// tree must never carry a byte the operator did not explicitly clear.

const squash = (s) => s.toLowerCase().replace(/[:\\\/_\-. ]/g, '');

// Usernames/hostnames too generic to distinguish from normal vocabulary —
// scanning them would flag every fixture in the repo.
const GENERIC_IDENTS = new Set([
  'user', 'users', 'admin', 'administrator', 'test', 'dev', 'owner', 'ubuntu',
  'runner', 'node', 'git', 'github', 'default', 'public', 'home', 'pc',
  'windows', 'vscode', 'system', 'local', 'sandbox', 'docker', 'container',
]);

// Zero-config identity needles: whoever runs the export gets their own
// machine identity checked out of the tree.
function collectIdentityNeedles() {
  const needles = [];
  try {
    const u = os.userInfo().username;
    if (u && u.length >= 4 && !GENERIC_IDENTS.has(u.toLowerCase())) {
      needles.push(['os-username', u.toLowerCase()]);
    }
  } catch { /* platform without account info */ }
  const host = os.hostname();
  if (host && host.length >= 6 && !GENERIC_IDENTS.has(host.toLowerCase())) {
    needles.push(['hostname', host.toLowerCase()]);
  }
  try {
    const email = execSync('git config user.email', { cwd: ROOT, encoding: 'utf8' }).trim();
    if (email && email.includes('@') && !/noreply/i.test(email)) {
      needles.push(['git-email', email.toLowerCase()]);
      const [local, domain] = email.split('@');
      if (local && local.length >= 4 && !GENERIC_IDENTS.has(local.toLowerCase())) {
        needles.push(['git-email-local', local.toLowerCase()]);
      }
      if (domain && !/(gmail|outlook|hotmail|yahoo|proton|icloud|users\.noreply\.github)\./i.test(domain)) {
        needles.push(['git-email-domain', domain.toLowerCase()]);
      }
    }
  } catch { /* no git identity configured */ }
  try {
    const name = execSync('git config user.name', { cwd: ROOT, encoding: 'utf8' }).trim();
    // Handles ("LazyGod75") ship on every commit — only flag names that
    // look like a real "First Last", which no public file should contain.
    if (name && name.includes(' ')) needles.push(['git-name', name.toLowerCase()]);
  } catch { /* no git identity configured */ }
  return needles;
}

const homeNeedles = (() => {
  const home = os.homedir();
  return [squash(home), squash(home.replace(/^[A-Za-z]:/, ''))].filter((v) => v.length > 4);
})();
const identityNeedles = collectIdentityNeedles();
const forbiddenNeedles = manifest.forbiddenTerms.map((t, i) => [`forbidden-term#${i + 1}`, t.toLowerCase()]);
const allowedNeedles = manifest.allowedTerms.map((t) => t.toLowerCase());

// Personal-info hits on one text line (or on a file's own path). Secret
// scanning stays separate — an allowedTerms exemption never clears a
// real credential. Needle VALUES are never printed: the terms
// themselves are private.
function personalHits(line) {
  const low = line.toLowerCase();
  if (allowedNeedles.some((a) => low.includes(a))) return [];
  const hits = [];
  if (homeNeedles.some((n) => squash(line).includes(n))) hits.push('personal-home-path');
  for (const [kind, needle] of [...identityNeedles, ...forbiddenNeedles]) {
    if (low.includes(needle)) hits.push(kind);
  }
  return hits;
}

// Secret-guard scripts are exempt from the SECRET scan only — their
// regex patterns are code, not credentials. The personal/terms scan
// still runs on them: a guard script can absolutely embed a real path.
const SECRET_SCAN_SKIP = new Set([
  'scripts/guard-secrets.mjs',
  'scripts/lib/secret-guard.mjs',
  'scripts/export-public-repo.mjs',
  'src/lib/security/secretGuard.ts',
  'src/__tests__/secretGuard.test.ts',
]);

const scanList = [
  ...new Set([...tracked.filter((r) => !isPrivate(r)), ...FORCE_INCLUDE].map(norm)),
];

function publicContent(rel) {
  // The exact text that would be written to DEST for this file —
  // redactions and the tauri.conf sanitizer applied — or null for files
  // copied as-is (binary or non-text).
  const src = path.join(ROOT, rel);
  if (!existsSync(src)) return null;
  if (norm(rel) === 'src-tauri/tauri.conf.json') {
    return sanitizeTauriConf(readFileSync(src, 'utf8'));
  }
  if (TEXT.test(rel) || rel.endsWith('LICENSE') || rel.endsWith('LICENSE.md')) {
    return redact(readFileSync(src, 'utf8'));
  }
  return null;
}

function scanContent(rel, content) {
  const violations = [];
  if (!SECRET_SCAN_SKIP.has(norm(rel))) {
    for (const hit of scanText(content)) {
      violations.push(`${rel}:${hit.line} secret:${hit.rule}`);
    }
  }
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const rule of personalHits(lines[i])) {
      violations.push(`${rel}:${i + 1} ${rule}`);
    }
  }
  return violations;
}

function walkDest(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (rel === '.git' || rel.startsWith('.git/')) continue;
    if (entry.isDirectory()) out.push(...walkDest(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

function reportAndRefuse(violations) {
  for (const v of violations.slice(0, 60)) console.error(`PUBLIC TREE LEAK: ${v}`);
  if (violations.length > 60) console.error(`... +${violations.length - 60} more`);
  console.error('export-public-repo: refusing to emit a tree that still looks like it leaks');
  process.exit(1);
}

// Dry-run: full pre-flight over the transformed source (same redactions
// and scans as a real export) without touching DEST.
if (DRY) {
  const violations = [];
  for (const rel of tracked) {
    if (isPrivate(rel)) {
      skipped += 1;
      skipReasons.push(norm(rel));
      continue;
    }
    copied += 1;
  }
  for (const rel of scanList) {
    for (const rule of personalHits(rel)) violations.push(`${rel}: filename ${rule}`);
    const content = publicContent(rel);
    if (content != null) violations.push(...scanContent(rel, content));
  }
  if (violations.length) reportAndRefuse(violations);
  const forced = forceMissing();
  console.log(
    `export-public-repo DRY-RUN: would copy ${copied} tracked + ${forced.length} force-include, skip ${skipped}, leak scan clean, dest=${DEST}`,
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

const violations = [];
// 1) Dest-side audit: nothing private or leak-shaped may exist in the
// emitted tree — catches copy-logic bugs the per-file scans would miss.
for (const rel of walkDest(DEST)) {
  if (isPrivate(rel) || isBlockedEnv(rel)) {
    violations.push(`${rel}: private-path-survived-export`);
  }
  for (const rule of personalHits(rel)) violations.push(`${rel}: filename ${rule}`);
}
// 2) Content scans over everything that was emitted.
for (const rel of scanList) {
  const to = path.join(DEST, rel);
  if (!existsSync(to)) continue;
  const content = publicContent(rel);
  if (content != null) violations.push(...scanContent(rel, content));
}
if (violations.length) reportAndRefuse(violations);

console.log(`export-public-repo: copied ${copied} files, skipped ${skipped} private, dest=${DEST}`);
