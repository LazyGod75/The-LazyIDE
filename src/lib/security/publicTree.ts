/**
 * Paths that must never be copied into the public source tree:
 * Lazy Cloud (Supabase/Stripe), official R2 updater/release pipelines, env files.
 */

const PRIVATE_PREFIXES = [
  'supabase/',
  'cloud/',
] as const;

const PRIVATE_FILES = new Set([
  'RELEASING.md',
  'ACTIVATION.md',
  'DEPLOY-NOTES.md',
  '.github/workflows/release.yml',
  '.github/workflows/republish-manifest.yml',
]);

function norm(rel: string): string {
  return rel.split('\\').join('/').replace(/^\.\//, '');
}

function isBlockedEnvFile(n: string): boolean {
  const base = n.split('/').pop() ?? n;
  if (base === '.env') return true;
  if (base.startsWith('.env.') && base !== '.env.example') return true;
  return false;
}

export function isPrivateExportPath(relPath: string): boolean {
  const n = norm(relPath);
  if (PRIVATE_FILES.has(n)) return true;
  if (isBlockedEnvFile(n)) return true;
  return PRIVATE_PREFIXES.some((p) => n === p.slice(0, -1) || n.startsWith(p));
}
