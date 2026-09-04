/**
 * Unit tests for scrub.ts — secret redaction at storage boundary.
 */

import { describe, expect, it } from 'vitest';
import { scrubSecrets } from '../../src/engine/scrub.js';

describe('scrubSecrets', () => {
  it('redacts Anthropic API keys', () => {
    const { text, redactionCount } = scrubSecrets(
      'Use key sk-ant-api03-abc123DEFGH567890abcdefghij to call Claude',
    );
    expect(text).not.toContain('sk-ant-');
    expect(text).toContain('[REDACTED]');
    expect(redactionCount).toBe(1);
  });

  it('redacts Stripe live keys', () => {
    // split literal to avoid false-positive secret push-protection; runtime value unchanged
    const { text, redactionCount } = scrubSecrets(
      'STRIPE_KEY=sk_live_' + 'TestAbcDefGhIjKlMnOpQrStU',
    );
    expect(text).not.toContain('sk_live_');
    expect(text).toContain('[REDACTED]');
    expect(redactionCount).toBe(1);
  });

  it('redacts GitHub PATs', () => {
    // split literal to avoid false-positive secret push-protection; runtime value unchanged
    const { text, redactionCount } = scrubSecrets(
      'token: ghp_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789012',
    );
    expect(text).not.toContain('ghp_');
    expect(text).toContain('[REDACTED]');
    expect(redactionCount).toBe(1);
  });

  it('redacts AWS access key IDs', () => {
    const { text, redactionCount } = scrubSecrets('AKIA1234567890ABCDEF');
    expect(text).not.toContain('AKIA');
    expect(text).toContain('[REDACTED]');
    expect(redactionCount).toBe(1);
  });

  it('redacts JWT-style tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abc123def456ghi789';
    const { text, redactionCount } = scrubSecrets(`Bearer ${jwt}`);
    expect(text).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(text).toContain('[REDACTED]');
    expect(redactionCount).toBe(1);
  });

  it('redacts password=value pairs', () => {
    const { text, redactionCount } = scrubSecrets('password=super_secret_value');
    expect(text).not.toContain('super_secret_value');
    expect(text).toContain('[REDACTED]');
    expect(redactionCount).toBe(1);
  });

  it('redacts api_key assignments', () => {
    const { text, redactionCount } = scrubSecrets('api_key: someSecretKey123');
    expect(text).not.toContain('someSecretKey123');
    expect(text).toContain('[REDACTED]');
    expect(redactionCount).toBe(1);
  });

  it('handles clean text with no secrets', () => {
    const clean = 'We decided to use PostgreSQL for our database.';
    const { text, redactionCount } = scrubSecrets(clean);
    expect(text).toBe(clean);
    expect(redactionCount).toBe(0);
  });

  it('redacts multiple secrets in one string', () => {
    // split literal to avoid false-positive secret push-protection; runtime value unchanged
    const dirty = 'key1=sk_live_' + 'ABCDEFGHIJKLMNOPQRSTUV and also AKIA1234567890ABCDEF';
    const { text, redactionCount } = scrubSecrets(dirty);
    expect(text).not.toContain('sk_live_');
    expect(text).not.toContain('AKIA');
    expect(redactionCount).toBe(2);
  });

  it('is idempotent on already-redacted text', () => {
    const { text: first } = scrubSecrets('password=hunter2');
    const { text: second, redactionCount } = scrubSecrets(first);
    expect(second).toBe(first);
    expect(redactionCount).toBe(0);
  });
});
