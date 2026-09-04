const PLACEHOLDER = /\.\.\.|your[_-]?key|changeme|example|placeholder|insert[_-]?here/i;

function isGhSecretRef(line) {
  return /\$\{\{\s*secrets\./.test(line);
}

function decodeJwtPayload(b64url) {
  try {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function stripeSecret(line) {
  if (PLACEHOLDER.test(line)) return null;
  if (/\bsk_live_[0-9A-Za-z]{16,}/.test(line)) return 'stripe-secret';
  if (/\bsk_test_[0-9A-Za-z]{16,}/.test(line)) return 'stripe-secret';
  return null;
}

function stripeWebhook(line) {
  if (PLACEHOLDER.test(line) || isGhSecretRef(line)) return null;
  if (/\bwhsec_[0-9A-Za-z]{16,}/.test(line)) return 'stripe-webhook';
  return null;
}

function openrouter(line) {
  if (PLACEHOLDER.test(line) || isGhSecretRef(line)) return null;
  if (/\bsk-or-v1-[a-f0-9]{32,}/i.test(line)) return 'openrouter-key';
  return null;
}

function pem(line) {
  if (/BEGIN (RSA |OPENSSH |EC |TAURI )?PRIVATE KEY/.test(line)) return 'private-key-pem';
  if (/untrusted comment: minisign encrypted secret key/.test(line)) return 'private-key-pem';
  return null;
}

function serviceRole(line) {
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

function cloudAssignment(line) {
  if (isGhSecretRef(line) || PLACEHOLDER.test(line)) return null;
  const m = ASSIGN_KEYS.exec(line);
  if (!m) return null;
  const value = m[1].replace(/^['"]|['"]$/g, '');
  if (value.length < 16) return null;
  if (value.startsWith('${{')) return null;
  return 'cloud-secret-assignment';
}

const RULES = [stripeSecret, stripeWebhook, openrouter, pem, serviceRole, cloudAssignment];

export function scanText(content) {
  const hits = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const rule of RULES) {
      const id = rule(lines[i]);
      if (id) hits.push({ rule: id, line: i + 1 });
    }
  }
  return hits;
}
