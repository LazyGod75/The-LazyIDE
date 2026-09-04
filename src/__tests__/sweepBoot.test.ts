/* sweepBoot.test.ts — unit tests for the orphan sweep at boot. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bootSweepOrphans, resetSweepBoot } from '../lib/bots/sweepBoot';

vi.mock('../lib/solari/solariSessions', () => ({
  sweepOrphans: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  resetSweepBoot();
  vi.clearAllMocks();
});

describe('bootSweepOrphans', () => {
  it('calls sweepOrphans once', async () => {
    const { sweepOrphans } = await import('../lib/solari/solariSessions');
    await bootSweepOrphans();
    expect(sweepOrphans).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — subsequent calls do not sweep again', async () => {
    const { sweepOrphans } = await import('../lib/solari/solariSessions');
    await bootSweepOrphans();
    await bootSweepOrphans();
    expect(sweepOrphans).toHaveBeenCalledTimes(1);
  });

  it('does not throw when sweepOrphans fails', async () => {
    const { sweepOrphans } = await import('../lib/solari/solariSessions');
    vi.mocked(sweepOrphans).mockRejectedValueOnce(new Error('network'));
    await expect(bootSweepOrphans()).resolves.toBeUndefined();
  });
});
