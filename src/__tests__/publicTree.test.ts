import { describe, expect, it } from 'vitest';
import { isPrivateExportPath } from '../lib/security/publicTree';

describe('isPrivateExportPath — never copy backend/billing into the public tree', () => {
  it('blocks the supabase backend folder', () => {
    expect(isPrivateExportPath('supabase/functions/ai-proxy/index.ts')).toBe(true);
    expect(isPrivateExportPath('supabase/functions/stripe-webhook/index.ts')).toBe(true);
    expect(isPrivateExportPath('supabase/config.toml')).toBe(true);
  });

  it('blocks cloud/ secrets and env files', () => {
    expect(isPrivateExportPath('cloud/.env')).toBe(true);
    expect(isPrivateExportPath('.env.local')).toBe(true);
    expect(isPrivateExportPath('.env')).toBe(true);
  });

  it('blocks official release/updater pipelines (R2 bucket, signing, republish)', () => {
    expect(isPrivateExportPath('.github/workflows/release.yml')).toBe(true);
    expect(isPrivateExportPath('.github/workflows/republish-manifest.yml')).toBe(true);
    expect(isPrivateExportPath('RELEASING.md')).toBe(true);
    expect(isPrivateExportPath('ACTIVATION.md')).toBe(true);
    expect(isPrivateExportPath('DEPLOY-NOTES.md')).toBe(true);
  });

  it('allows the public app, license, and client code', () => {
    expect(isPrivateExportPath('src/App.tsx')).toBe(false);
    expect(isPrivateExportPath('LICENSE.md')).toBe(false);
    expect(isPrivateExportPath('src/lib/billing/credits.ts')).toBe(false);
    expect(isPrivateExportPath('.env.example')).toBe(false);
    expect(isPrivateExportPath('.github/workflows/ci.yml')).toBe(false);
  });
});
