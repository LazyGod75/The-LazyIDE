/* secretMasking.test.ts — unit tests for secret masking. */

import { describe, it, expect } from 'vitest';
import { maskSecrets, maskObservation, containsSecret } from '../lib/bots/secretMasking';

describe('maskSecrets', () => {
  it('masks Stripe live API keys', () => {
    const input = 'The key is ' + 'sk_live_' + 'PLACEHOLDERKEYVALUE1234567890abcd';
    const result = maskSecrets(input);
    expect(result).toContain('[REDACTED:sk_key]');
    expect(result).not.toContain('sk_live_' + 'PLACE');
  });

  it('masks Stripe test API keys', () => {
    const input = 'Using ' + 'sk_test_' + 'PLACEHOLDERKEYVALUE1234567890abcd' + ' for testing';
    const result = maskSecrets(input);
    expect(result).toContain('[REDACTED:sk_key]');
  });

  it('masks Bearer tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    const result = maskSecrets(input);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('eyJhbGc');
  });

  it('masks passwords in URLs', () => {
    const input = 'Navigate to https://admin:secretpass123@example.com/login';
    const result = maskSecrets(input);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('secretpass123');
  });

  it('masks password= form fields', () => {
    const input = 'Submitted form with password=mysecretpass456';
    const result = maskSecrets(input);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('mysecretpass456');
  });

  it('masks token= query params', () => {
    const input = 'Visited https://api.example.com/callback?token=abc123def456ghi789jkl012mno345pqr';
    const result = maskSecrets(input);
    expect(result).toContain('[REDACTED]');
  });

  it('does NOT mask regular text without secrets', () => {
    const input = 'The bot navigated to https://example.com and clicked the Buy button';
    const result = maskSecrets(input);
    expect(result).toBe(input);
  });
});

describe('maskObservation', () => {
  it('is an alias for maskSecrets', () => {
    const input = 'Token: Bearer abc123def456ghi789jkl012mno345pqr';
    expect(maskObservation(input)).toBe(maskSecrets(input));
  });
});

describe('containsSecret', () => {
  it('returns true when a secret pattern is present', () => {
    expect(containsSecret('sk_live_' + 'PLACEHOLDERKEYVALUE1234567890abcd')).toBe(true);
  });

  it('returns false when no secret pattern is present', () => {
    expect(containsSecret('Just a regular URL: https://example.com')).toBe(false);
  });
});
