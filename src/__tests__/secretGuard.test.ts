import { describe, expect, it } from 'vitest';
import { scanText } from '../lib/security/secretGuard';

describe('scanText — must never let real cloud secrets through', () => {
  it('flags a live Stripe secret key', () => {
    const key = 'sk_live_' + '51AbcdefGhijklMNOPQRSTUVwxyz0123';
    const hits = scanText('STRIPE_SECRET_KEY=' + key);
    expect(hits.some((h) => h.rule === 'stripe-secret')).toBe(true);
  });

  it('flags a Stripe webhook signing secret', () => {
    const secret = 'whsec_' + 'abcdefghijklmnopqrstuvwxyz012345';
    const hits = scanText('STRIPE_WEBHOOK_SECRET=' + secret);
    expect(hits.some((h) => h.rule === 'stripe-webhook')).toBe(true);
  });

  it('flags a Supabase service-role JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaWF0IjoxNjc1MjMwMDAwfQ.' +
      'signaturepaddingvaluexx';
    const hits = scanText(`SUPABASE_SERVICE_ROLE_KEY=${jwt}`);
    expect(hits.some((h) => h.rule === 'supabase-service-role')).toBe(true);
  });

  it('flags an OpenRouter live key', () => {
    const hits = scanText('LAZY_OPENROUTER_KEY=sk-or-v1-' + 'a'.repeat(64));
    expect(hits.some((h) => h.rule === 'openrouter-key')).toBe(true);
  });

  it('flags a PEM private key block', () => {
    const block = '-----BEGIN ' + 'PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQ==\n-----END ' + 'PRIVATE KEY-----';
    const hits = scanText(block);
    expect(hits.some((h) => h.rule === 'private-key-pem')).toBe(true);
  });

  it('allows .env.example placeholders with ellipsis', () => {
    const hits = scanText('STRIPE_SECRET_KEY=sk_live_...\nSTRIPE_PRICE_PRO=price_...\nSTRIPE_WEBHOOK_SECRET=whsec_...');
    expect(hits).toEqual([]);
  });

  it('allows the public Supabase anon/publishable key style', () => {
    const hits = scanText('VITE_SUPABASE_ANON_KEY=sb_publishable_5fcQFK8vEQzled0QZ2aR4g_PfA8VvBI');
    expect(hits).toEqual([]);
  });

  it('allows concatenated fake keys used in unit tests', () => {
    const hits = scanText("const FAKE = 'sk_live_' + 'TestAbcDefGhIjKlMnOpQrStU';");
    expect(hits).toEqual([]);
  });

  it('flags a raw R2/AWS secret access key assignment', () => {
    const value = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYAbCdEfGh0123';
    const hits = scanText('R2_SECRET_ACCESS_KEY=' + value);
    expect(hits.some((h) => h.rule === 'cloud-secret-assignment')).toBe(true);
  });

  it('allows GitHub Actions secret references for R2 and Tauri signing', () => {
    const hits = scanText(
      'AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}\n' +
      'TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}',
    );
    expect(hits).toEqual([]);
  });
});
