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

// Documented fixture values — keyboard runs and canonical example tokens
// used by scrubber/security tests. A real credential containing one of
// these runs is astronomically unlikely.
const FIXTURE_VALUE =
  /(?:FAKE|EXAMPLE|DUMMY|abcdef|ABCDEF|1234567890|0123456789|abc123|qwerty|xxxxx|SomeSignature|dQw4w9WgXcQ)/i;

function providerKeys(line) {
  if (PLACEHOLDER.test(line) || FIXTURE_VALUE.test(line) || isGhSecretRef(line)) return null;
  if (/\bapikey_[A-Za-z0-9]{20,}/.test(line)) return 'typesafe-key';
  if (/\bsk-ant-[A-Za-z0-9_-]{20,}/.test(line)) return 'anthropic-key';
  if (/\bsk-proj-[A-Za-z0-9_-]{20,}/.test(line)) return 'openai-key';
  if (/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/.test(line)) return 'github-token';
  if (/\bgithub_pat_[A-Za-z0-9_]{20,}/.test(line)) return 'github-token';
  if (/\bxox[baprs]-[A-Za-z0-9-]{10,}/.test(line)) return 'slack-token';
  if (/\bAKIA[0-9A-Z]{16}\b/.test(line)) return 'aws-access-key';
  return null;
}

function personalJwt(line) {
  if (isGhSecretRef(line) || PLACEHOLDER.test(line) || FIXTURE_VALUE.test(line)) return null;
  const jwtRe = /eyJ[A-Za-z0-9_-]+\.(eyJ[A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g;
  for (const m of line.matchAll(jwtRe)) {
    const payload = decodeJwtPayload(m[1]);
    if (!payload) continue;
    // Supabase anon keys are public by design; any other role, or a JWT
    // carrying a real user identity, is a credential. Generic fixture
    // subs (user/test/1234567890) are exempt.
    if (payload.role && payload.role !== 'anon') return 'jwt-non-anon-role';
    if (payload.email && !/example\.|@test|@localhost|@invalid/i.test(payload.email)) return 'jwt-personal';
    if (payload.sub && !/^(user\d*|test|admin|1234567890|0+)$/i.test(String(payload.sub))) return 'jwt-personal';
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

const RULES = [stripeSecret, stripeWebhook, openrouter, pem, serviceRole, providerKeys, personalJwt, cloudAssignment];

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
