/**
 * unifiedEntitlement.test.ts
 *
 * Unit coverage for getEntitlements()'s teams-related fields (T4.2 fix):
 * teamsEnabled and the isTeamContext-derived canUseTeamSearch now come
 * from teamsActive() (src/lib/features.ts, the single runtime
 * entitlement) instead of the removed hardcoded TEAMS_ENABLED import from
 * src/lib/brain/scope.ts.
 *
 * features.ts is intentionally NOT mocked here: this file verifies the
 * real integration between unifiedEntitlement.ts and the real
 * active-team snapshot (setActiveTeamSnapshot / teamsActive).
 *
 * Engine-readiness inputs (loadAccessSettings, isCliBackendAvailable,
 * hasAnthropicKey, hasManagedCreditsActive, getProPlanState) are mocked
 * with neutral defaults — this file does not re-test engine readiness
 * itself (see src/lib/models/__tests__/entitlement.test.ts for that),
 * only the teams wiring.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getEntitlements,
  hasFeature,
  setOrgScope,
  setPlanTier,
} from '../lib/entitlements/unifiedEntitlement';
import { setActiveTeamSnapshot, _resetActiveTeamSnapshotForTests } from '../lib/features';

vi.mock('../lib/models/accessSettings', () => ({
  loadAccessSettings: vi.fn().mockReturnValue({}),
}));
vi.mock('../lib/models/cliBackendProvider', () => ({
  isCliBackendAvailable: vi.fn().mockReturnValue(false),
}));
vi.mock('../lib/models/anthropicProvider', () => ({
  hasAnthropicKey: vi.fn().mockReturnValue(false),
}));
vi.mock('../lib/models/index', () => ({
  hasManagedCreditsActive: vi.fn().mockReturnValue(false),
  getProPlanState: vi.fn().mockReturnValue('inactive'),
}));

beforeEach(() => {
  _resetActiveTeamSnapshotForTests();
  setOrgScope('solo');
  setPlanTier('free');
});

describe('getEntitlements() — teams wiring (T4.2)', () => {
  it('teamsEnabled is false when the active-team snapshot is unhydrated (fail-closed default)', () => {
    expect(getEntitlements().teamsEnabled).toBe(false);
  });

  it('teamsEnabled is true once the active-team snapshot reports an active org', () => {
    setActiveTeamSnapshot(true);
    expect(getEntitlements().teamsEnabled).toBe(true);
  });

  it('teamsEnabled returns to false after the snapshot is reset to unhydrated', () => {
    setActiveTeamSnapshot(true);
    expect(getEntitlements().teamsEnabled).toBe(true);
    _resetActiveTeamSnapshotForTests();
    expect(getEntitlements().teamsEnabled).toBe(false);
  });

  it('canUseTeamSearch requires BOTH a non-solo orgScope AND an active team, on a paid tier', () => {
    setActiveTeamSnapshot(true);
    setOrgScope('team');
    setPlanTier('pro');
    expect(getEntitlements().features.canUseTeamSearch).toBe(true);
  });

  it('canUseTeamSearch is false when orgScope is solo, even with an active team', () => {
    setActiveTeamSnapshot(true);
    setOrgScope('solo');
    setPlanTier('pro');
    expect(getEntitlements().features.canUseTeamSearch).toBe(false);
  });

  it('canUseTeamSearch is false when the team is not active, even with a non-solo orgScope', () => {
    setActiveTeamSnapshot(false);
    setOrgScope('team');
    setPlanTier('pro');
    expect(getEntitlements().features.canUseTeamSearch).toBe(false);
  });

  it('hasFeature("canUseTeamSearch") mirrors getEntitlements().features.canUseTeamSearch', () => {
    setActiveTeamSnapshot(true);
    setOrgScope('dept');
    setPlanTier('pro_plus');
    expect(hasFeature('canUseTeamSearch')).toBe(getEntitlements().features.canUseTeamSearch);
    expect(hasFeature('canUseTeamSearch')).toBe(true);
  });
});
