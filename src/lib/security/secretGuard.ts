/**
 * Detects credentials that must never be committed: Stripe, Supabase
 * service-role, OpenRouter, PEM/Tauri signing material, R2/AWS secrets.
 * Placeholders (`sk_live_...`) and GitHub `${{ secrets.* }}` refs are allowed.
 */

export interface SecretHit {
  rule: string;
  line: number;
}

const PLACEHOLDER = /\.\.\.|your[_-]?key|changeme|example|placeholder|insert[_-]?here/i;

function lineHits(content: string, test: (line: string) => string | null): SecretHit[] {
  const hits: SecretHit[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rule = test(lines[i]);
    if (rule) hits.push({ rule, line: i + 1 });
  }
  return hits;
}

function isGhSecretRef(line: string): boolean {
  return /\$\{\{\s*secrets\./.test(line);
}

function decodeJwtPayload(b64url: string): { role?: string } | null {
  try {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = typeof atob === 'function'
      ? atob(padded)
      : Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(json) as { role?: string };
  } catch {
    return null;
  }
}

function stripeSecret(line: string): string | null {
  if (PLACEHOLDER.test(line)) return null;
  if (/\bsk_live_[0-9A-Za-z]{16,}/.test(line)) return 'stripe-secret';
  if (/\bsk_test_[0-9A-Za-z]{16,}/.test(line)) return 'stripe-secret';
  return null;
}

function stripeWebhook(line: string): string | null {
  if (PLACEHOLDER.test(line) || isGhSecretRef(line)) return null;
  if (/\bwhsec_[0-9A-Za-z]{16,}/.test(line)) return 'stripe-webhook';
  return null;
}

function openrouter(line: string): string | null {
  if (PLACEHOLDER.test(line) || isGhSecretRef(line)) return null;
  if (/\bsk-or-v1-[a-f0-9]{32,}/i.test(line)) return 'openrouter-key';
  return null;
}

function pem(line: string): string | null {
  if (/BEGIN (RSA |OPENSSH |EC |TAURI )?PRIVATE KEY/.test(line)) return 'private-key-pem';
  if (/untrusted comment: minisign encrypted secret key/.test(line)) return 'private-key-pem';
  return null;
}

function serviceRole(line: string): string | null {
  if (isGhSecretRef(line) || PLACEHOLDER.test(line)) return null;
  const jwtRe = /eyJ[A-Za-z0-9_-]+\.(eyJ[A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g;
  for (const m of line.matchAll(jwtRe)) {
    const payload = decodeJwtPayload(m[1]);
    if (payload?.role === 'service_role') return 'supabase-service-role';
  }
  return null;
}

const ASSIGN_KEYS =
  /(?:R2_SECRET_ACCESS_KEY|AWS_SECRET_ACCESS_KEY|TAURI_SIGNING_PRIVATE_KEY|TAURI_SIGNING_PRIVATE_KEY_PASSWORD|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|SUPABASE_SERVICE_ROLE_KEY|LAZY_OPENROUTER_KEY)\s*[:=]\s*(\S+)/i;

function cloudAssignment(line: string): string | null {
  if (isGhSecretRef(line) || PLACEHOLDER.test(line)) return null;
  const m = ASSIGN_KEYS.exec(line);
  if (!m) return null;
  const value = m[1].replace(/^['"]|['"]$/g, '');
  if (value.length < 16) return null;
  if (value.startsWith('${{')) return null;
  return 'cloud-secret-assignment';
}

export function scanText(content: string, _filePath = ''): SecretHit[] {
  const rules = [stripeSecret, stripeWebhook, openrouter, pem, serviceRole, cloudAssignment];
  const hits: SecretHit[] = [];
  for (const rule of rules) {
    hits.push(...lineHits(content, rule));
  }
  return hits;
}
