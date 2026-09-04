import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── useAgentAvailable (DiffDrawer.tsx's "Send an agent" affordance gate,
// ReviewSpace.tsx's "Ask reviewer/tester agent" gate) ───────────────────
// Mirrors the exact routing table planAndAct() uses in runtime.ts:
// isManagedAgentAvailable() checked before isLiveAgentAvailable().

const isManagedAgentAvailable = vi.fn();
const isLiveAgentAvailable = vi.fn();

vi.mock('../lib/agents/runtime', () => ({
  isManagedAgentAvailable: (...args: unknown[]) => isManagedAgentAvailable(...args),
  isLiveAgentAvailable: (...args: unknown[]) => isLiveAgentAvailable(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useAgentAvailable', () => {
  it('is true when the managed (Pro) backend is active', async () => {
    isManagedAgentAvailable.mockReturnValue(true);
    isLiveAgentAvailable.mockReturnValue(false);
    const { useAgentAvailable } = await import('../lib/review/agentAvailability');
    expect(useAgentAvailable()).toBe(true);
  });

  it('is true when a live CLI backend is available', async () => {
    isManagedAgentAvailable.mockReturnValue(false);
    isLiveAgentAvailable.mockReturnValue(true);
    const { useAgentAvailable } = await import('../lib/review/agentAvailability');
    expect(useAgentAvailable()).toBe(true);
  });

  it('is false when neither backend is available', async () => {
    isManagedAgentAvailable.mockReturnValue(false);
    isLiveAgentAvailable.mockReturnValue(false);
    const { useAgentAvailable } = await import('../lib/review/agentAvailability');
    expect(useAgentAvailable()).toBe(false);
  });
});
