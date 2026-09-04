/**
 * features.test.ts
 *
 * Unit tests for the single runtime teams entitlement (T4.2 fix): the
 * active-team snapshot cache + teamsActive() + the dev-only
 * VITE_TEAMS_ENABLED override in src/lib/features.ts.
 *
 * Two describe blocks:
 *   - 'teamsActive() / snapshot' uses the module's normal (no env override)
 *     import — covers the snapshot lifecycle and the fail-closed contract.
 *   - 'dev override' uses vi.resetModules() + a fresh dynamic import after
 *     stubbing VITE_TEAMS_ENABLED, since DEV_OVERRIDE is computed once at
 *     module-evaluation time (same pattern as managedProvider.test.ts's
 *     streamChatImpl ReAct shim describe block).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  teamsActive,
  setActiveTeamSnapshot,
  _resetActiveTeamSnapshotForTests,
  TEAMS_ENABLED,
} from '../lib/features';

beforeEach(() => {
  _resetActiveTeamSnapshotForTests();
});

// ── teamsActive() / snapshot ────────────────────────────────────────

describe('teamsActive() / snapshot', () => {
  it('fail-closed: an unhydrated snapshot (never set) reads as false', () => {
    expect(teamsActive()).toBe(false);
  });

  it('setActiveTeamSnapshot(true) makes teamsActive() true', () => {
    setActiveTeamSnapshot(true);
    expect(teamsActive()).toBe(true);
  });

  it('setActiveTeamSnapshot(false) makes teamsActive() false', () => {
    setActiveTeamSnapshot(true);
    setActiveTeamSnapshot(false);
    expect(teamsActive()).toBe(false);
  });

  it('_resetActiveTeamSnapshotForTests() returns to the unhydrated (false) state', () => {
    setActiveTeamSnapshot(true);
    expect(teamsActive()).toBe(true);
    _resetActiveTeamSnapshotForTests();
    expect(teamsActive()).toBe(false);
  });

  it('a live value passed to teamsActive() is used directly, ignoring the cached snapshot', () => {
    setActiveTeamSnapshot(false);
    expect(teamsActive(true)).toBe(true);

    setActiveTeamSnapshot(true);
    expect(teamsActive(false)).toBe(false);
  });

  it('teamsActive() with no argument falls back to the cached snapshot', () => {
    setActiveTeamSnapshot(true);
    expect(teamsActive()).toBe(true);
    expect(teamsActive(undefined)).toBe(true);
  });
});

// ── Legacy TEAMS_ENABLED export ──────────────────────────────────────

describe('legacy TEAMS_ENABLED export', () => {
  it('is a boolean, kept only for backward compatibility with existing importers', () => {
    expect(typeof TEAMS_ENABLED).toBe('boolean');
  });

  it('is false by default (no dev override configured in this test run)', () => {
    expect(TEAMS_ENABLED).toBe(false);
  });
});

// ── Dev override ──────────────────────────────────────────────────────
//
// DEV_OVERRIDE is computed once at module-evaluation time from
// import.meta.env.DEV (true by default under vitest) and
// import.meta.env.VITE_TEAMS_ENABLED. A fresh module instance is required
// to observe a different value.

describe('dev override (VITE_TEAMS_ENABLED)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('forces teamsActive() true even with no active org, when VITE_TEAMS_ENABLED=true', async () => {
    vi.stubEnv('VITE_TEAMS_ENABLED', 'true');
    vi.resetModules();
    const fresh = await import('../lib/features');

    fresh._resetActiveTeamSnapshotForTests();
    expect(fresh.teamsActive()).toBe(true);
    expect(fresh.teamsActive(false)).toBe(true);
  });

  it('the legacy TEAMS_ENABLED export also reflects the dev override', async () => {
    vi.stubEnv('VITE_TEAMS_ENABLED', 'true');
    vi.resetModules();
    const fresh = await import('../lib/features');

    expect(fresh.TEAMS_ENABLED).toBe(true);
  });

  it('does NOT force teamsActive() when VITE_TEAMS_ENABLED is left unset', async () => {
    vi.resetModules();
    const fresh = await import('../lib/features');

    fresh._resetActiveTeamSnapshotForTests();
    expect(fresh.teamsActive()).toBe(false);
  });

  it('never overrides a real active org OFF: an active snapshot stays true regardless of the override', async () => {
    vi.resetModules();
    const fresh = await import('../lib/features');

    fresh.setActiveTeamSnapshot(true);
    expect(fresh.teamsActive()).toBe(true);
  });
});
