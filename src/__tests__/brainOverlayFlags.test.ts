import { describe, it, expect } from 'vitest';
import { brainOverlayFlags, type BrainOverlayInput } from '../lib/brain/brainOverlayFlags';

function input(overrides: Partial<BrainOverlayInput> = {}): BrainOverlayInput {
  return {
    seedActive: false,
    nodeCount: 0,
    loading: false,
    sidecarHealthy: false,
    sidecarUnavailable: false,
    ...overrides,
  };
}

describe('brainOverlayFlags', () => {
  it('shows the setup card when health is known even if graph() is still loading', () => {
    const flags = brainOverlayFlags(input({ loading: true, sidecarHealthy: true }));
    expect(flags.showConnectingOverlay).toBe(false);
    expect(flags.showSetupCard).toBe(true);
    expect(flags.showUnavailableOverlay).toBe(false);
  });

  it('shows Connecting only while loading an empty vault with no health yet', () => {
    const flags = brainOverlayFlags(input({ loading: true }));
    expect(flags.showConnectingOverlay).toBe(true);
    expect(flags.showSetupCard).toBe(false);
  });

  it('never shows setup while the sidecar is unavailable', () => {
    const flags = brainOverlayFlags(input({ sidecarUnavailable: true }));
    expect(flags.showSetupCard).toBe(false);
    expect(flags.showUnavailableOverlay).toBe(true);
  });

  it('seed banner wins over connecting and setup on an empty vault', () => {
    const flags = brainOverlayFlags(input({ seedActive: true, loading: true }));
    expect(flags.showSeedBanner).toBe(true);
    expect(flags.showConnectingOverlay).toBe(false);
    expect(flags.showSetupCard).toBe(false);
  });

  it('shows the timeline only on a populated live graph', () => {
    expect(brainOverlayFlags(input({ nodeCount: 4 })).showTimeline).toBe(true);
    expect(brainOverlayFlags(input()).showTimeline).toBe(false);
  });
});
