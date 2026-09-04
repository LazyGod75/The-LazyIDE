import { describe, expect, it } from 'vitest';
import { isCloudConfigured } from '../lib/envCloud';

describe('isCloudConfigured', () => {
  it('is false when url or anon key is missing', () => {
    expect(isCloudConfigured(undefined, undefined)).toBe(false);
    expect(isCloudConfigured('https://x.supabase.co', '')).toBe(false);
    expect(isCloudConfigured('', 'anon')).toBe(false);
  });

  it('is true only when both url and anon key are present', () => {
    expect(isCloudConfigured('https://x.supabase.co', 'sb_publishable_x')).toBe(true);
  });
});
