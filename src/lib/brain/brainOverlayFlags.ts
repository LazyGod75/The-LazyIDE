/* brainOverlayFlags — which Brain stage overlays to show.
   Extracted from BrainSpace so the empty-vault / connecting / seed
   precedence is unit-testable without mounting the page (measured 2026-08-28:
   Health 74% + hanging graph hid both Connecting and the setup card). */

export interface BrainOverlayInput {
  seedActive: boolean;
  nodeCount: number;
  loading: boolean;
  sidecarHealthy: boolean;
  sidecarUnavailable: boolean;
}

export interface BrainOverlayFlags {
  showSeedBanner: boolean;
  showConnectingOverlay: boolean;
  showSetupCard: boolean;
  showUnavailableOverlay: boolean;
  showTimeline: boolean;
}

export function showSeedBanner(input: BrainOverlayInput): boolean {
  return input.seedActive && input.nodeCount === 0;
}

export function showConnectingOverlay(input: BrainOverlayInput): boolean {
  if (showSeedBanner(input)) return false;
  return input.loading && input.nodeCount === 0 && !input.sidecarHealthy;
}

export function showSetupCard(input: BrainOverlayInput): boolean {
  if (showSeedBanner(input) || input.sidecarUnavailable || input.nodeCount !== 0) return false;
  return input.sidecarHealthy || !input.loading;
}

export function showUnavailableOverlay(input: BrainOverlayInput): boolean {
  if (showSeedBanner(input) || input.loading) return false;
  return input.sidecarUnavailable;
}

export function showTimeline(input: BrainOverlayInput): boolean {
  return !input.loading && !input.sidecarUnavailable && input.nodeCount > 0;
}

export function brainOverlayFlags(input: BrainOverlayInput): BrainOverlayFlags {
  return {
    showSeedBanner: showSeedBanner(input),
    showConnectingOverlay: showConnectingOverlay(input),
    showSetupCard: showSetupCard(input),
    showUnavailableOverlay: showUnavailableOverlay(input),
    showTimeline: showTimeline(input),
  };
}
