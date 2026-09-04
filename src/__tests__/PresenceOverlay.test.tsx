/**
 * PresenceOverlay.test.tsx
 *
 * lib/collab/PresenceOverlay.tsx — the single self-contained mount
 * point W-MV drops into CanvasView (spec 2c). useFleetPresence is
 * mocked here (it has its own dedicated test) so this suite only
 * verifies rendering: null when inactive (the honest solo/no-org
 * degrade path — the whole point of this component being safe to
 * mount unconditionally), avatar chips + halo when active.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PresenceOverlay } from '../lib/collab/PresenceOverlay';

vi.mock('../i18n', () => ({
  useI18n: () => ({ t: (key: string, params?: Record<string, string>) => (params ? `${key}:${JSON.stringify(params)}` : key) }),
  // Spinner (components/ui/Skeleton.tsx) uses useI18nOptional, not useI18n.
  useI18nOptional: () => ({ t: (key: string, params?: Record<string, string>) => (params ? `${key}:${JSON.stringify(params)}` : key) }),
}));

let mockResult: {
  active: boolean;
  remoteUsers: Array<{ userId: string; name: string; color: string; focusedRef?: string }>;
} = { active: false, remoteUsers: [] };

vi.mock('../lib/collab/CollabContext', () => ({
  useCollab: () => mockResult,
}));

describe('PresenceOverlay', () => {
  it('renders nothing when presence is inactive (solo/no-org degrade path)', () => {
    mockResult = { active: false, remoteUsers: [] };
    const { container } = render(<PresenceOverlay />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when active but no remote teammates are present', () => {
    mockResult = { active: true, remoteUsers: [] };
    const { container } = render(<PresenceOverlay />);
    expect(container.firstChild).toBeNull();
  });

  it('renders one avatar chip per remote teammate', () => {
    mockResult = {
      active: true,
      remoteUsers: [
        { userId: 'u1', name: 'Alice', color: '#111' },
        { userId: 'u2', name: 'Bob', color: '#222', focusedRef: 'mission-9' },
      ],
    };
    render(<PresenceOverlay />);
    expect(screen.getByTestId('presence-chip-u1')).toBeInTheDocument();
    expect(screen.getByTestId('presence-chip-u2')).toBeInTheDocument();
    expect(screen.getByTestId('presence-overlay-chips')).toBeInTheDocument();
  });

  it('renders a halo for a teammate focused on a mission node present in the DOM', () => {
    document.body.innerHTML = '<div data-testid="mission-node-mission-9" style="position:absolute;"></div>';
    mockResult = {
      active: true,
      remoteUsers: [{ userId: 'u2', name: 'Bob', color: '#222', focusedRef: 'mission-9' }],
    };
    render(<PresenceOverlay />);
    expect(screen.getByTestId('presence-halo-u2')).toBeInTheDocument();
  });

  it('renders no halo when the focused node is not present in the DOM', () => {
    document.body.innerHTML = '';
    mockResult = {
      active: true,
      remoteUsers: [{ userId: 'u2', name: 'Bob', color: '#222', focusedRef: 'mission-missing' }],
    };
    render(<PresenceOverlay />);
    expect(screen.queryByTestId('presence-halo-u2')).not.toBeInTheDocument();
  });
});
