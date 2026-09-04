/**
 * Tests for fleetHygiene.ts (P58 — automatic fleet hygiene).
 *
 * Every rule is exercised as a pure function on plain fixtures — no store,
 * no journal, no canvas. The "do-not-touch" describe block at the bottom
 * specifically proves the hard safety floor: running/queued/review missions
 * are NEVER archived by any rule, however old, however duplicated, however
 * configured. 'cancelled' graduated out of that untouchable set (worktree-
 * leak follow-up, Fix 3) — its own describe block below covers it.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeMissionTitle,
  compareMissionOrder,
  planMissionArchival,
  purgeStaleSignals,
  dedupePreviewSurfaces,
  planTransientSurfaceTtl,
  planIdleTerminalClosure,
  isTestCanvasArtifact,
  findTestCanvasArtifacts,
  findTestScratchProjects,
  planTestScratchProjectClosure,
  planFleetHygiene,
  planOrphanWorktreeCleanup,
  planLoopSupervision,
  DEFAULT_HYGIENE_CONFIG,
  type HygieneMission,
  type HygieneSignal,
  type HygienePreviewSurface,
  type HygieneCanvasArtifact,
  type HygieneProject,
  type HygieneLoop,
} from '../lib/agents/fleetHygiene';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 21, 12, 0, 0);

function mission(overrides: Partial<HygieneMission> & { id: string; title: string; status: HygieneMission['status'] }): HygieneMission {
  return { merged: undefined, archived: undefined, createdAt: undefined, terminalAtMs: undefined, ...overrides };
}

// ── normalizeMissionTitle ────────────────────────────────────────────────

describe('normalizeMissionTitle', () => {
  it('lowercases, trims, and collapses internal whitespace', () => {
    expect(normalizeMissionTitle('  Fix   the   Bug  ')).toBe('fix the bug');
  });

  it('treats case/whitespace variants of the same title as equal', () => {
    expect(normalizeMissionTitle('R5 retry')).toBe(normalizeMissionTitle(' r5   RETRY '));
  });
});

// ── compareMissionOrder ──────────────────────────────────────────────────

describe('compareMissionOrder', () => {
  it('orders by createdAt when both missions have one', () => {
    const a = mission({ id: 'M1', title: 'x', status: 'done', createdAt: 100 });
    const b = mission({ id: 'M2', title: 'x', status: 'done', createdAt: 200 });
    expect(compareMissionOrder(a, b)).toBeLessThan(0);
    expect(compareMissionOrder(b, a)).toBeGreaterThan(0);
  });

  it('falls back to the trailing id sequence number when neither has createdAt', () => {
    const a = mission({ id: 'M5', title: 'x', status: 'done' });
    const b = mission({ id: 'M12', title: 'x', status: 'done' });
    expect(compareMissionOrder(a, b)).toBeLessThan(0);
  });

  it('returns undefined (never a guess) when order cannot be determined either way', () => {
    const a = mission({ id: 'draft-abc', title: 'x', status: 'done' });
    const b = mission({ id: 'draft-def', title: 'x', status: 'done' });
    expect(compareMissionOrder(a, b)).toBeUndefined();
  });
});

// ── planMissionArchival — rule (a): grace-period done/merged ─────────────

describe('planMissionArchival — rule (a) grace period', () => {
  it('archives a done mission whose terminalAtMs is past the grace period', () => {
    const m = mission({ id: 'M1', title: 'Ship feature', status: 'done', terminalAtMs: NOW - DAY_MS - 1000 });
    const plans = planMissionArchival([m], NOW, DEFAULT_HYGIENE_CONFIG);
    expect(plans).toEqual([{ id: 'M1', reason: 'grace_period' }]);
  });

  it('does NOT archive a done mission still within the grace period', () => {
    const m = mission({ id: 'M1', title: 'Ship feature', status: 'done', terminalAtMs: NOW - 1000 });
    expect(planMissionArchival([m], NOW, DEFAULT_HYGIENE_CONFIG)).toEqual([]);
  });

  it('does NOT archive a done mission with no known terminalAtMs (fails closed, never guesses)', () => {
    const m = mission({ id: 'M1', title: 'Ship feature', status: 'done' });
    expect(planMissionArchival([m], NOW, DEFAULT_HYGIENE_CONFIG)).toEqual([]);
  });

  it('honors a custom configured grace period', () => {
    const m = mission({ id: 'M1', title: 'Ship feature', status: 'done', terminalAtMs: NOW - 2 * 60 * 60 * 1000 });
    const config = { ...DEFAULT_HYGIENE_CONFIG, gracePeriodMs: 60 * 60 * 1000 };
    expect(planMissionArchival([m], NOW, config)).toEqual([{ id: 'M1', reason: 'grace_period' }]);
  });

  it('never re-archives a mission already archived', () => {
    const m = mission({ id: 'M1', title: 'Ship feature', status: 'done', archived: true, terminalAtMs: NOW - 10 * DAY_MS });
    expect(planMissionArchival([m], NOW, DEFAULT_HYGIENE_CONFIG)).toEqual([]);
  });
});

// ── planMissionArchival — rule (a2): cancelled grace period (Fix 3) ──────

describe('planMissionArchival — rule (a2) cancelled grace period', () => {
  it('archives a cancelled mission whose terminalAtMs is past the grace period', () => {
    const m = mission({ id: 'M1', title: 'Rejected mission', status: 'cancelled', terminalAtMs: NOW - DAY_MS - 1000 });
    const plans = planMissionArchival([m], NOW, DEFAULT_HYGIENE_CONFIG);
    expect(plans).toEqual([{ id: 'M1', reason: 'cancelled_grace_period' }]);
  });

  it('does NOT archive a cancelled mission still within the grace period', () => {
    const m = mission({ id: 'M1', title: 'Rejected mission', status: 'cancelled', terminalAtMs: NOW - 1000 });
    expect(planMissionArchival([m], NOW, DEFAULT_HYGIENE_CONFIG)).toEqual([]);
  });

  it('does NOT archive a cancelled mission with no known terminalAtMs (fails closed, never guesses)', () => {
    const m = mission({ id: 'M1', title: 'Rejected mission', status: 'cancelled' });
    expect(planMissionArchival([m], NOW, DEFAULT_HYGIENE_CONFIG)).toEqual([]);
  });

  it('honors a custom configured cancelledGracePeriodMs independently of gracePeriodMs', () => {
    const m = mission({ id: 'M1', title: 'Rejected mission', status: 'cancelled', terminalAtMs: NOW - 2 * 60 * 60 * 1000 });
    const config = { ...DEFAULT_HYGIENE_CONFIG, cancelledGracePeriodMs: 60 * 60 * 1000 };
    expect(planMissionArchival([m], NOW, config)).toEqual([{ id: 'M1', reason: 'cancelled_grace_period' }]);
  });

  it('never re-archives a cancelled mission already archived', () => {
    const m = mission({ id: 'M1', title: 'Rejected mission', status: 'cancelled', archived: true, terminalAtMs: NOW - 10 * DAY_MS });
    expect(planMissionArchival([m], NOW, DEFAULT_HYGIENE_CONFIG)).toEqual([]);
  });

  it('a lower cancelledGracePeriodMs never affects a done mission\'s own gracePeriodMs (independent knobs)', () => {
    const doneRecent = mission({ id: 'M1', title: 'Done recently', status: 'done', terminalAtMs: NOW - 2 * 60 * 60 * 1000 });
    const config = { ...DEFAULT_HYGIENE_CONFIG, cancelledGracePeriodMs: 60 * 60 * 1000 };
    // Still within the (unchanged) 24h done grace period, despite the
    // shorter cancelled-specific override above.
    expect(planMissionArchival([doneRecent], NOW, config)).toEqual([]);
  });
});

// ── planMissionArchival — rule (b): superseded ───────────────────────────

describe('planMissionArchival — rule (b) superseded by a newer retry', () => {
  it('archives a failed mission superseded by a newer mission with the same normalized title (the "4 duplicate R5 attempts" case)', () => {
    const original = mission({ id: 'M5', title: 'R5', status: 'failed', createdAt: 1000 });
    const retry = mission({ id: 'M9', title: 'R5', status: 'failed', createdAt: 2000 });
    const plans = planMissionArchival([original, retry], NOW, DEFAULT_HYGIENE_CONFIG);
    expect(plans).toContainEqual({ id: 'M5', reason: 'superseded' });
  });

  it('archives immediately even when the failed mission is very recent (no age requirement for supersession)', () => {
    const original = mission({ id: 'M5', title: 'R5', status: 'failed', createdAt: NOW - 1000 });
    const retry = mission({ id: 'M9', title: 'R5', status: 'failed', createdAt: NOW });
    expect(planMissionArchival([original, retry], NOW, DEFAULT_HYGIENE_CONFIG)).toContainEqual({ id: 'M5', reason: 'superseded' });
  });

  it('does NOT archive the newest attempt itself', () => {
    const original = mission({ id: 'M5', title: 'R5', status: 'failed', createdAt: 1000 });
    const retry = mission({ id: 'M9', title: 'R5', status: 'failed', createdAt: 2000 });
    const plans = planMissionArchival([original, retry], NOW, DEFAULT_HYGIENE_CONFIG);
    expect(plans.find((p) => p.id === 'M9')).toBeUndefined();
  });

  it('does NOT archive a failed mission whose same-title sibling is OLDER (not a retry)', () => {
    const newer = mission({ id: 'M9', title: 'R5', status: 'failed', createdAt: 2000 });
    const older = mission({ id: 'M5', title: 'R5', status: 'done', createdAt: 1000 });
    expect(planMissionArchival([older, newer], NOW, DEFAULT_HYGIENE_CONFIG).find((p) => p.id === 'M9')).toBeUndefined();
  });

  it('matches titles case/whitespace-insensitively', () => {
    const original = mission({ id: 'M5', title: '  R5   retry ', status: 'failed', createdAt: 1000 });
    const retry = mission({ id: 'M9', title: 'r5 RETRY', status: 'failed', createdAt: 2000 });
    expect(planMissionArchival([original, retry], NOW, DEFAULT_HYGIENE_CONFIG)).toContainEqual({ id: 'M5', reason: 'superseded' });
  });

  it('never conflates two genuinely different missions that merely share some words', () => {
    const a = mission({ id: 'M5', title: 'Fix the login bug', status: 'failed', createdAt: 1000 });
    const b = mission({ id: 'M9', title: 'Fix the signup bug', status: 'failed', createdAt: 2000 });
    expect(planMissionArchival([a, b], NOW, DEFAULT_HYGIENE_CONFIG)).toEqual([]);
  });
});

// ── planMissionArchival — rule (c): stale, no retry ──────────────────────

describe('planMissionArchival — rule (c) stale failed, no retry', () => {
  it('archives a failed mission older than the stale threshold with no same-title sibling at all ("June\'s dead missions")', () => {
    const m = mission({ id: 'M1', title: 'Old June task', status: 'failed', terminalAtMs: NOW - 8 * DAY_MS });
    expect(planMissionArchival([m], NOW, DEFAULT_HYGIENE_CONFIG)).toEqual([{ id: 'M1', reason: 'stale' }]);
  });

  it('does NOT archive a failed mission that is old but still within the stale threshold', () => {
    const m = mission({ id: 'M1', title: 'Recent task', status: 'failed', terminalAtMs: NOW - 2 * DAY_MS });
    expect(planMissionArchival([m], NOW, DEFAULT_HYGIENE_CONFIG)).toEqual([]);
  });

  it('does NOT archive a failed mission with no known terminalAtMs (fails closed)', () => {
    const m = mission({ id: 'M1', title: 'Old June task', status: 'failed' });
    expect(planMissionArchival([m], NOW, DEFAULT_HYGIENE_CONFIG)).toEqual([]);
  });

  it('prefers the more informative "superseded" reason over "stale" when a mission is both old AND superseded', () => {
    const original = mission({ id: 'M1', title: 'R5', status: 'failed', createdAt: 1000, terminalAtMs: NOW - 10 * DAY_MS });
    const retry = mission({ id: 'M2', title: 'R5', status: 'failed', createdAt: 2000, terminalAtMs: NOW - 1000 });
    const plans = planMissionArchival([original, retry], NOW, DEFAULT_HYGIENE_CONFIG);
    expect(plans).toEqual([{ id: 'M1', reason: 'superseded' }]);
  });
});

// ── planMissionArchival — hard safety floor ──────────────────────────────

describe('planMissionArchival — do-not-touch guarantee', () => {
  const ancientTerminalAt = NOW - 365 * DAY_MS;

  // 'cancelled' deliberately excluded from this list (worktree-leak
  // follow-up, Fix 3) — it graduated to its own timed rule (a2), covered by
  // the "rule (a2) cancelled grace period" describe block above. This
  // remains the hard floor for the three statuses that are NEVER inspected
  // by ANY archive rule, at ANY age.
  it.each(['running', 'queued', 'review'] as const)(
    'never archives a %s mission, however old, however duplicated',
    (status) => {
      const stale = mission({ id: 'M1', title: 'Same title', status, terminalAtMs: ancientTerminalAt });
      const duplicate = mission({ id: 'M2', title: 'Same title', status, createdAt: 1, terminalAtMs: ancientTerminalAt });
      const newer = mission({ id: 'M3', title: 'Same title', status, createdAt: 2 });
      expect(planMissionArchival([stale, duplicate, newer], NOW, DEFAULT_HYGIENE_CONFIG)).toEqual([]);
    },
  );

  it('never archives a running mission even when a same-titled mission was already archived (mixed fleet)', () => {
    const running = mission({ id: 'M1', title: 'R5', status: 'running', createdAt: 1 });
    const failed = mission({ id: 'M2', title: 'R5', status: 'failed', createdAt: 0, terminalAtMs: NOW - 10 * DAY_MS });
    const plans = planMissionArchival([running, failed], NOW, DEFAULT_HYGIENE_CONFIG);
    expect(plans.map((p) => p.id)).not.toContain('M1');
  });
});

// ── purgeStaleSignals — rule (d) ──────────────────────────────────────────

describe('purgeStaleSignals', () => {
  it('keeps a signal whose missionId is in the live set', () => {
    const signals: HygieneSignal[] = [{ id: 's1', missionId: 'M1' }];
    const { kept, purged } = purgeStaleSignals(signals, new Set(['M1']));
    expect(kept).toEqual(signals);
    expect(purged).toEqual([]);
  });

  it('purges a signal whose missionId references an archived/deleted mission', () => {
    const signals: HygieneSignal[] = [{ id: 's1', missionId: 'M1' }, { id: 's2', missionId: 'M2' }];
    const { kept, purged } = purgeStaleSignals(signals, new Set(['M2']));
    expect(kept).toEqual([{ id: 's2', missionId: 'M2' }]);
    expect(purged).toEqual([{ id: 's1', missionId: 'M1' }]);
  });

  it('never mutates the input array', () => {
    const signals: HygieneSignal[] = [{ id: 's1', missionId: 'M1' }];
    const frozen = Object.freeze([...signals]);
    expect(() => purgeStaleSignals(frozen, new Set())).not.toThrow();
  });
});

// ── dedupePreviewSurfaces — rule (e) ──────────────────────────────────────

describe('dedupePreviewSurfaces', () => {
  it('keeps a single configured surface for a project untouched', () => {
    const surfaces: HygienePreviewSurface[] = [{ id: 's1', projectId: 'p1', kind: 'preview', url: 'http://localhost:3000' }];
    const { keep, remove } = dedupePreviewSurfaces(surfaces);
    expect(keep).toEqual(surfaces);
    expect(remove).toEqual([]);
  });

  it('drops a "no address" placeholder when a configured surface exists for the same project', () => {
    const configured: HygienePreviewSurface = { id: 's1', projectId: 'p1', kind: 'preview', url: 'http://localhost:3000', configuredAtMs: 1 };
    const placeholder: HygienePreviewSurface = { id: 's2', projectId: 'p1', kind: 'preview', configuredAtMs: 2 };
    const { keep, remove } = dedupePreviewSurfaces([configured, placeholder]);
    expect(keep).toEqual([configured]);
    expect(remove).toEqual([placeholder]);
  });

  it('keeps only the MOST RECENTLY configured surface when several are configured for the same project', () => {
    const older: HygienePreviewSurface = { id: 's1', projectId: 'p1', kind: 'preview', url: 'http://localhost:3000', configuredAtMs: 1 };
    const newer: HygienePreviewSurface = { id: 's2', projectId: 'p1', kind: 'preview', url: 'http://localhost:4000', configuredAtMs: 2 };
    const { keep, remove } = dedupePreviewSurfaces([older, newer]);
    expect(keep).toEqual([newer]);
    expect(remove).toEqual([older]);
  });

  it('caps at one even when EVERY surface in a project is a placeholder', () => {
    const a: HygienePreviewSurface = { id: 's1', projectId: 'p1', kind: 'preview', configuredAtMs: 1 };
    const b: HygienePreviewSurface = { id: 's2', projectId: 'p1', kind: 'preview', configuredAtMs: 2 };
    const { keep, remove } = dedupePreviewSurfaces([a, b]);
    expect(keep).toEqual([b]);
    expect(remove).toEqual([a]);
  });

  it('never touches surfaces across DIFFERENT projects', () => {
    const a: HygienePreviewSurface = { id: 's1', projectId: 'p1', kind: 'preview', url: 'http://localhost:3000' };
    const b: HygienePreviewSurface = { id: 's2', projectId: 'p2', kind: 'preview', url: 'http://localhost:4000' };
    const { keep, remove } = dedupePreviewSurfaces([a, b]);
    expect(keep).toEqual(expect.arrayContaining([a, b]));
    expect(remove).toEqual([]);
  });

  it('never touches a Transverse-zone surface (no projectId)', () => {
    const a: HygienePreviewSurface = { id: 's1', kind: 'preview', url: 'http://localhost:3000' };
    const b: HygienePreviewSurface = { id: 's2', kind: 'preview', url: 'http://localhost:4000' };
    const { keep, remove } = dedupePreviewSurfaces([a, b]);
    expect(keep).toEqual(expect.arrayContaining([a, b]));
    expect(remove).toEqual([]);
  });

  it('treats an empty-string url as "no address", same as absent', () => {
    const configured: HygienePreviewSurface = { id: 's1', projectId: 'p1', kind: 'preview', url: 'http://localhost:3000', configuredAtMs: 1 };
    const blank: HygienePreviewSurface = { id: 's2', projectId: 'p1', kind: 'preview', url: '   ', configuredAtMs: 2 };
    const { keep, remove } = dedupePreviewSurfaces([configured, blank]);
    expect(keep).toEqual([configured]);
    expect(remove).toEqual([blank]);
  });

  // ── Bugfix regression: terminal surfaces must never be caught by preview
  // dedup (worktree-leak follow-up, Fix 2) ──────────────────────────────

  it('never removes a live TERMINAL surface that shares a project with a preview (the exact bug this fix targets)', () => {
    const preview: HygienePreviewSurface = { id: 'p-1', projectId: 'p1', kind: 'preview', url: 'http://localhost:3000', configuredAtMs: 1 };
    const terminal: HygienePreviewSurface = { id: 't-1', projectId: 'p1', kind: 'terminal', configuredAtMs: 2 };
    const { keep, remove } = dedupePreviewSurfaces([preview, terminal]);
    expect(keep).toEqual(expect.arrayContaining([preview, terminal]));
    expect(remove).toEqual([]);
  });

  it('never removes ONE of two terminal surfaces sharing a project, even with no preview involved at all', () => {
    const t1: HygienePreviewSurface = { id: 't-1', projectId: 'p1', kind: 'terminal', configuredAtMs: 1 };
    const t2: HygienePreviewSurface = { id: 't-2', projectId: 'p1', kind: 'terminal', configuredAtMs: 2 };
    const { keep, remove } = dedupePreviewSurfaces([t1, t2]);
    expect(keep).toEqual(expect.arrayContaining([t1, t2]));
    expect(remove).toEqual([]);
  });

  it('never touches a surface with an unknown/absent kind — the safe default for a rule this destructive', () => {
    const a: HygienePreviewSurface = { id: 's1', projectId: 'p1', configuredAtMs: 1 };
    const b: HygienePreviewSurface = { id: 's2', projectId: 'p1', configuredAtMs: 2 };
    const { keep, remove } = dedupePreviewSurfaces([a, b]);
    expect(keep).toEqual(expect.arrayContaining([a, b]));
    expect(remove).toEqual([]);
  });

  it('still dedupes multiple PREVIEWS down to one even when a terminal shares the same project', () => {
    const olderPreview: HygienePreviewSurface = { id: 'p-1', projectId: 'p1', kind: 'preview', url: 'http://localhost:3000', configuredAtMs: 1 };
    const newerPreview: HygienePreviewSurface = { id: 'p-2', projectId: 'p1', kind: 'preview', url: 'http://localhost:4000', configuredAtMs: 2 };
    const terminal: HygienePreviewSurface = { id: 't-1', projectId: 'p1', kind: 'terminal', configuredAtMs: 3 };
    const { keep, remove } = dedupePreviewSurfaces([olderPreview, newerPreview, terminal]);
    expect(keep).toEqual(expect.arrayContaining([newerPreview, terminal]));
    expect(remove).toEqual([olderPreview]);
  });
});

// ── planIdleTerminalClosure — rule (h) (Fix 2) ───────────────────────────

describe('planIdleTerminalClosure', () => {
  it('closes a terminal with no output and no focus for at least the configured TTL', () => {
    const s: HygienePreviewSurface = {
      id: 't1',
      projectId: 'p1',
      kind: 'terminal',
      lastOutputAtMs: NOW - 7 * 60 * 60 * 1000,
    };
    expect(planIdleTerminalClosure([s], NOW, DEFAULT_HYGIENE_CONFIG)).toEqual([s]);
  });

  it('does NOT close a terminal whose output is still within the TTL', () => {
    const s: HygienePreviewSurface = {
      id: 't1',
      projectId: 'p1',
      kind: 'terminal',
      lastOutputAtMs: NOW - 60 * 1000,
    };
    expect(planIdleTerminalClosure([s], NOW, DEFAULT_HYGIENE_CONFIG)).toEqual([]);
  });

  it('does NOT close a terminal with no known lastOutputAtMs (fails closed, never guesses)', () => {
    const s: HygienePreviewSurface = { id: 't1', projectId: 'p1', kind: 'terminal' };
    expect(planIdleTerminalClosure([s], NOW, DEFAULT_HYGIENE_CONFIG)).toEqual([]);
  });

  it('does NOT close a terminal focused within the TTL, however old its last output', () => {
    const s: HygienePreviewSurface = {
      id: 't1',
      projectId: 'p1',
      kind: 'terminal',
      lastOutputAtMs: NOW - 100 * DAY_MS,
      lastFocusedAtMs: NOW - 60 * 1000,
    };
    expect(planIdleTerminalClosure([s], NOW, DEFAULT_HYGIENE_CONFIG)).toEqual([]);
  });

  it('closes a terminal whose focus is also outside the TTL', () => {
    const s: HygienePreviewSurface = {
      id: 't1',
      projectId: 'p1',
      kind: 'terminal',
      lastOutputAtMs: NOW - 7 * 60 * 60 * 1000,
      lastFocusedAtMs: NOW - 7 * 60 * 60 * 1000,
    };
    expect(planIdleTerminalClosure([s], NOW, DEFAULT_HYGIENE_CONFIG)).toEqual([s]);
  });

  it('never touches a preview surface, however idle-looking its fields', () => {
    const s: HygienePreviewSurface = {
      id: 'p1',
      projectId: 'proj1',
      kind: 'preview',
      lastOutputAtMs: NOW - 100 * DAY_MS,
    };
    expect(planIdleTerminalClosure([s], NOW, DEFAULT_HYGIENE_CONFIG)).toEqual([]);
  });

  it('never touches a surface with an unknown/absent kind', () => {
    const s: HygienePreviewSurface = { id: 's1', projectId: 'p1', lastOutputAtMs: NOW - 100 * DAY_MS };
    expect(planIdleTerminalClosure([s], NOW, DEFAULT_HYGIENE_CONFIG)).toEqual([]);
  });

  it('honors a custom configured idleTerminalTtlMs', () => {
    const s: HygienePreviewSurface = { id: 't1', projectId: 'p1', kind: 'terminal', lastOutputAtMs: NOW - 2 * 60 * 60 * 1000 };
    const config = { ...DEFAULT_HYGIENE_CONFIG, idleTerminalTtlMs: 60 * 60 * 1000 };
    expect(planIdleTerminalClosure([s], NOW, config)).toEqual([s]);
  });

  it('never touches a Transverse-zone idle terminal (no projectId) — still eligible on activity alone', () => {
    const s: HygienePreviewSurface = { id: 't1', kind: 'terminal', lastOutputAtMs: NOW - 7 * 60 * 60 * 1000 };
    expect(planIdleTerminalClosure([s], NOW, DEFAULT_HYGIENE_CONFIG)).toEqual([s]);
  });
});

// ── planTransientSurfaceTtl — rule (g) (Fix 4) ───────────────────────────

describe('planTransientSurfaceTtl', () => {
  it('removes a never-configured preview placeholder past its TTL', () => {
    const s: HygienePreviewSurface = { id: 's1', projectId: 'p1', kind: 'preview', placeholderSinceMs: NOW - DAY_MS - 1000 };
    expect(planTransientSurfaceTtl([s], NOW, DEFAULT_HYGIENE_CONFIG)).toEqual([s]);
  });

  it('does NOT remove a placeholder still within the TTL', () => {
    const s: HygienePreviewSurface = { id: 's1', projectId: 'p1', kind: 'preview', placeholderSinceMs: NOW - 1000 };
    expect(planTransientSurfaceTtl([s], NOW, DEFAULT_HYGIENE_CONFIG)).toEqual([]);
  });

  it('does NOT remove a placeholder with no known placeholderSinceMs (fails closed, never guesses)', () => {
    const s: HygienePreviewSurface = { id: 's1', projectId: 'p1', kind: 'preview' };
    expect(planTransientSurfaceTtl([s], NOW, DEFAULT_HYGIENE_CONFIG)).toEqual([]);
  });

  it('never removes a CONFIGURED preview surface regardless of age — only a live reachability signal could justify that, which this pure module never has', () => {
    const s: HygienePreviewSurface = {
      id: 's1',
      projectId: 'p1',
      kind: 'preview',
      url: 'http://localhost:3000',
      placeholderSinceMs: NOW - 100 * DAY_MS,
    };
    expect(planTransientSurfaceTtl([s], NOW, DEFAULT_HYGIENE_CONFIG)).toEqual([]);
  });

  it('never removes a terminal surface, however old — terminals have no address concept and must never look "dead" under this rule', () => {
    const s: HygienePreviewSurface = { id: 's1', projectId: 'p1', kind: 'terminal', placeholderSinceMs: NOW - 100 * DAY_MS };
    expect(planTransientSurfaceTtl([s], NOW, DEFAULT_HYGIENE_CONFIG)).toEqual([]);
  });

  it('never removes a surface with an unknown/absent kind — the safe default for a rule this destructive', () => {
    const s: HygienePreviewSurface = { id: 's1', projectId: 'p1', placeholderSinceMs: NOW - 100 * DAY_MS };
    expect(planTransientSurfaceTtl([s], NOW, DEFAULT_HYGIENE_CONFIG)).toEqual([]);
  });

  it('honors a custom configured transientSurfaceTtlMs', () => {
    const s: HygienePreviewSurface = { id: 's1', projectId: 'p1', kind: 'preview', placeholderSinceMs: NOW - 2 * 60 * 60 * 1000 };
    const config = { ...DEFAULT_HYGIENE_CONFIG, transientSurfaceTtlMs: 60 * 60 * 1000 };
    expect(planTransientSurfaceTtl([s], NOW, config)).toEqual([s]);
  });

  it('never touches a Transverse-zone placeholder (no projectId) — still eligible on age alone, same as any other preview placeholder', () => {
    const s: HygienePreviewSurface = { id: 's1', kind: 'preview', placeholderSinceMs: NOW - DAY_MS - 1000 };
    expect(planTransientSurfaceTtl([s], NOW, DEFAULT_HYGIENE_CONFIG)).toEqual([s]);
  });
});

// ── isTestCanvasArtifact / findTestCanvasArtifacts — rule (f) ────────────

describe('isTestCanvasArtifact', () => {
  it('matches an id starting with "lazy-e2e-"', () => {
    expect(isTestCanvasArtifact({ id: 'lazy-e2e-abc123' })).toBe(true);
  });

  it('matches an id containing "-soak-scratch-"', () => {
    expect(isTestCanvasArtifact({ id: 'draft-soak-scratch-42' })).toBe(true);
  });

  it('matches a label (title/text) even when the id itself does not match', () => {
    expect(isTestCanvasArtifact({ id: 'draft-abc123', label: 'lazy-e2e-smoke run' })).toBe(true);
  });

  it('does not match an unrelated id/label', () => {
    expect(isTestCanvasArtifact({ id: 'draft-abc123', label: 'Write the changelog' })).toBe(false);
  });

  it('does not false-positive on a title that merely contains "soak" or "e2e" without the full pattern', () => {
    expect(isTestCanvasArtifact({ id: 'draft-1', label: 'Run the e2e test suite' })).toBe(false);
    expect(isTestCanvasArtifact({ id: 'draft-2', label: 'soak test the API' })).toBe(false);
  });
});

describe('findTestCanvasArtifacts', () => {
  it('filters a mixed list down to only the test-scratch artifacts', () => {
    const artifacts: HygieneCanvasArtifact[] = [
      { id: 'lazy-e2e-1', label: 'smoke' },
      { id: 'draft-real-work', label: 'Ship the checkout flow' },
      { id: 'draft-soak-scratch-9', label: 'soak run' },
    ];
    expect(findTestCanvasArtifacts(artifacts).map((a) => a.id)).toEqual(['lazy-e2e-1', 'draft-soak-scratch-9']);
  });
});

// ── findTestScratchProjects / planTestScratchProjectClosure — rule (f, extended) ──

function project(overrides: Partial<HygieneProject> & { id: string; root: string }): HygieneProject {
  return { active: false, ...overrides };
}

describe('findTestScratchProjects', () => {
  it('matches a project whose root contains the e2e-soak-scratch naming convention', () => {
    const scratch = project({ id: 'p1', root: 'C:\\Users\\user\\AppData\\Local\\Temp\\lazy-e2e-soak-scratch-1784236548334' });
    const real = project({ id: 'p2', root: 'C:\\Users\\user\\Documents\\GameOn\\GameOn_' });
    expect(findTestScratchProjects([scratch, real]).map((p) => p.id)).toEqual(['p1']);
  });

  it('does not false-positive on an unrelated project root', () => {
    const real = project({ id: 'p1', root: 'C:\\Users\\user\\Documents\\Lazy' });
    expect(findTestScratchProjects([real])).toEqual([]);
  });
});

describe('planTestScratchProjectClosure', () => {
  it('returns an empty plan when no project is scratch', () => {
    const projects = [project({ id: 'p1', root: 'C:\\real\\project', active: true })];
    expect(planTestScratchProjectClosure(projects)).toEqual({ idsToClose: [] });
  });

  it('closes a non-active scratch project directly, with no switch step', () => {
    const active = project({ id: 'p1', root: 'C:\\real\\project', active: true });
    const scratch = project({ id: 'p2', root: 'C:\\tmp\\lazy-e2e-soak-scratch-1' });
    expect(planTestScratchProjectClosure([active, scratch])).toEqual({ idsToClose: ['p2'] });
  });

  it('switches to the first non-scratch project THEN closes the active scratch one (ordered last)', () => {
    const real = project({ id: 'p1', root: 'C:\\real\\project' });
    const activeScratch = project({ id: 'p2', root: 'C:\\tmp\\lazy-e2e-soak-scratch-1', active: true });
    const otherScratch = project({ id: 'p3', root: 'C:\\tmp\\lazy-e2e-soak-scratch-2' });

    const plan = planTestScratchProjectClosure([real, activeScratch, otherScratch]);

    expect(plan.switchActiveTo).toBe('p1');
    // Active project ordered LAST — never closed before switching away.
    expect(plan.idsToClose).toEqual(['p3', 'p2']);
  });

  it('closes the active scratch project last (no switch step) when EVERY open project is scratch', () => {
    const activeScratch = project({ id: 'p1', root: 'C:\\tmp\\lazy-e2e-soak-scratch-1', active: true });
    const otherScratch = project({ id: 'p2', root: 'C:\\tmp\\lazy-e2e-soak-scratch-2' });

    const plan = planTestScratchProjectClosure([activeScratch, otherScratch]);

    expect(plan.switchActiveTo).toBeUndefined();
    expect(plan.idsToClose).toEqual(['p2', 'p1']);
  });

  it('closes every scratch project directly when none of them is active', () => {
    const real = project({ id: 'p1', root: 'C:\\real\\project', active: true });
    const scratchA = project({ id: 'p2', root: 'C:\\tmp\\lazy-e2e-soak-scratch-a' });
    const scratchB = project({ id: 'p3', root: 'C:\\tmp\\lazy-e2e-soak-scratch-b' });

    const plan = planTestScratchProjectClosure([real, scratchA, scratchB]);

    expect(plan.switchActiveTo).toBeUndefined();
    expect(plan.idsToClose.sort()).toEqual(['p2', 'p3']);
  });
});

// ── planFleetHygiene — composition ───────────────────────────────────────

describe('planFleetHygiene', () => {
  it('composes every rule into one plan with correct summary counts', () => {
    const doneOld = mission({ id: 'M1', title: 'Ship feature', status: 'done', terminalAtMs: NOW - 2 * DAY_MS });
    const failedOriginal = mission({ id: 'M2', title: 'R5', status: 'failed', createdAt: 1000 });
    const failedRetry = mission({ id: 'M3', title: 'R5', status: 'failed', createdAt: 2000 });
    const running = mission({ id: 'M4', title: 'In progress', status: 'running' });

    const signals: HygieneSignal[] = [
      { id: 'sig-1', missionId: 'M1' }, // will be archived this sweep -> stale
      { id: 'sig-2', missionId: 'M4' }, // still live -> kept
    ];
    const previewSurfaces: HygienePreviewSurface[] = [
      { id: 'surf-1', projectId: 'p1', kind: 'preview', configuredAtMs: 1 },
      { id: 'surf-2', projectId: 'p1', kind: 'preview', url: 'http://localhost:3000', configuredAtMs: 2 },
      // A live, recently-active terminal sharing project p1 with the two
      // preview surfaces above — proves rule (e)'s dedup (now kind-scoped)
      // leaves it alone, and rule (h) leaves it alone too (recent output).
      { id: 'term-live', projectId: 'p1', kind: 'terminal', lastOutputAtMs: NOW - 60 * 1000 },
      // A genuinely idle terminal in a different project — eligible for
      // rule (h)'s auto-close in this same composed sweep.
      { id: 'term-idle', projectId: 'p2', kind: 'terminal', lastOutputAtMs: NOW - 7 * 60 * 60 * 1000 },
    ];
    const canvasArtifacts: HygieneCanvasArtifact[] = [
      { id: 'lazy-e2e-scratch', label: 'e2e run' },
      { id: 'draft-real', label: 'Real work' },
    ];
    const openProjects: HygieneProject[] = [
      project({ id: 'proj-real', root: 'C:\\real\\project', active: true }),
      project({ id: 'proj-scratch', root: 'C:\\tmp\\lazy-e2e-soak-scratch-1' }),
    ];

    const result = planFleetHygiene(
      { missions: [doneOld, failedOriginal, failedRetry, running], signals, previewSurfaces, canvasArtifacts, openProjects },
      NOW,
      DEFAULT_HYGIENE_CONFIG,
    );

    expect(result.missionsToArchive.map((p) => p.id).sort()).toEqual(['M1', 'M2']);
    expect(result.signalsToPurge.map((s) => s.id)).toEqual(['sig-1']);
    expect(result.previewSurfacesToRemove.map((s) => s.id)).toEqual(['surf-1']);
    expect(result.canvasArtifactsToDelete.map((a) => a.id)).toEqual(['lazy-e2e-scratch']);
    expect(result.projectClosure).toEqual({ idsToClose: ['proj-scratch'] });
    expect(result.transientSurfacesToRemove).toEqual([]);
    expect(result.terminalSurfacesToClose.map((s) => s.id)).toEqual(['term-idle']);

    expect(result.summary).toEqual({ archived: 2, purged: 3, deduped: 1, projectsClosed: 1, loopsFlagged: 0, orphanWorktreesRecoverable: 0 });
  });

  it('returns an all-zero summary and empty plans for a clean fleet', () => {
    const running = mission({ id: 'M1', title: 'Working', status: 'running' });
    const result = planFleetHygiene({ missions: [running] }, NOW, DEFAULT_HYGIENE_CONFIG);
    expect(result.summary).toEqual({ archived: 0, purged: 0, deduped: 0, projectsClosed: 0, loopsFlagged: 0, orphanWorktreesRecoverable: 0 });
    expect(result.missionsToArchive).toEqual([]);
    expect(result.signalsToPurge).toEqual([]);
    expect(result.previewSurfacesToRemove).toEqual([]);
    expect(result.transientSurfacesToRemove).toEqual([]);
    expect(result.canvasArtifactsToDelete).toEqual([]);
    expect(result.projectClosure).toEqual({ idsToClose: [] });
  });

  it('never touches a running/review/queued mission across the whole composed sweep', () => {
    const review = mission({ id: 'M1', title: 'R5', status: 'review', createdAt: 1 });
    const retry = mission({ id: 'M2', title: 'R5', status: 'failed', createdAt: 2 });
    const result = planFleetHygiene({ missions: [review, retry] }, NOW, DEFAULT_HYGIENE_CONFIG);
    expect(result.missionsToArchive.map((p) => p.id)).not.toContain('M1');
  });

  it('archives a cancelled mission past its grace period (Fix 3) as part of the composed sweep', () => {
    const cancelled = mission({ id: 'M1', title: 'Rejected work', status: 'cancelled', terminalAtMs: NOW - 2 * DAY_MS });
    const result = planFleetHygiene({ missions: [cancelled] }, NOW, DEFAULT_HYGIENE_CONFIG);
    expect(result.missionsToArchive).toEqual([{ id: 'M1', reason: 'cancelled_grace_period' }]);
    expect(result.summary.archived).toBe(1);
  });

  it('folds rule (g)\'s TTL-expired transient surfaces into the composed plan and purged summary (Fix 4)', () => {
    const running = mission({ id: 'M1', title: 'Working', status: 'running' });
    const deadPlaceholder: HygienePreviewSurface = {
      id: 'surf-dead',
      projectId: 'p1',
      kind: 'preview',
      placeholderSinceMs: NOW - 2 * DAY_MS,
    };

// ── Rule (j): orphan worktree recovery/cleanup ──────────────────────────

describe('planOrphanWorktreeCleanup — rule (j)', () => {
  it('classifies a branch with real unmerged work as recoverable', () => {
    const plan = planOrphanWorktreeCleanup([
      { name: 'agent/M6-scaffold', headSha: 'abc123', containedInTarget: false },
    ]);
    expect(plan.recoverable).toEqual([{ name: 'agent/M6-scaffold', headSha: 'abc123', containedInTarget: false }]);
    expect(plan.empty).toEqual([]);
  });

  it('classifies a branch already contained in the target as empty (nothing to lose)', () => {
    const plan = planOrphanWorktreeCleanup([
      { name: 'agent/M12-empty', headSha: 'seed', containedInTarget: true },
    ]);
    expect(plan.empty).toEqual([{ name: 'agent/M12-empty', headSha: 'seed', containedInTarget: true }]);
    expect(plan.recoverable).toEqual([]);
  });

  it('treats a branch with an unresolvable head sha as empty (merging is meaningless, deleting is safe)', () => {
    const plan = planOrphanWorktreeCleanup([
      { name: 'agent/M13-broken', headSha: '', containedInTarget: false },
    ]);
    expect(plan.empty).toHaveLength(1);
    expect(plan.recoverable).toEqual([]);
  });

  it('mixed fleet: recoverable work is NEVER mixed with empty debris', () => {
    const branches = [
      { name: 'agent/M1-real', headSha: 'aaa', containedInTarget: false },
      { name: 'agent/M2-real', headSha: 'bbb', containedInTarget: false },
      { name: 'agent/M3-empty', headSha: 'seed', containedInTarget: true },
      { name: 'agent/M4-empty', headSha: 'seed', containedInTarget: true },
      { name: 'M6-implémenteur-wt', headSha: 'seed', containedInTarget: true },
    ];
    const plan = planOrphanWorktreeCleanup(branches);
    expect(plan.recoverable.map((b) => b.name)).toEqual(['agent/M1-real', 'agent/M2-real']);
    expect(plan.empty.map((b) => b.name).sort()).toEqual(['M6-implémenteur-wt', 'agent/M3-empty', 'agent/M4-empty']);
  });

  it('empty input yields empty plan (honest: nothing to classify, not an error)', () => {
    const plan = planOrphanWorktreeCleanup([]);
    expect(plan.recoverable).toEqual([]);
    expect(plan.empty).toEqual([]);
  });

  it('planFleetHygiene integrates rule (j): recoverable count lands in the summary', () => {
    const result = planFleetHygiene(
      {
        missions: [],
        orphanWorktreeBranches: [
          { name: 'agent/M6-scaffold', headSha: 'abc123', containedInTarget: false },
          { name: 'agent/M12-empty', headSha: 'seed', containedInTarget: true },
        ],
      },
      Date.now(),
      DEFAULT_HYGIENE_CONFIG,
    );
    expect(result.orphanWorktreePlan.recoverable).toHaveLength(1);
    expect(result.orphanWorktreePlan.empty).toHaveLength(1);
    expect(result.summary.orphanWorktreesRecoverable).toBe(1);
  });
});

    const result = planFleetHygiene({ missions: [running], previewSurfaces: [deadPlaceholder] }, NOW, DEFAULT_HYGIENE_CONFIG);

    expect(result.transientSurfacesToRemove.map((s) => s.id)).toEqual(['surf-dead']);
    expect(result.previewSurfacesToRemove).toEqual([]);
    expect(result.summary).toEqual({ archived: 0, purged: 1, deduped: 0, projectsClosed: 0, loopsFlagged: 0, orphanWorktreesRecoverable: 0 });
  });

  it('never double-removes/double-counts a surface rule (e) already claimed this sweep, even if it would independently match rule (g)\'s TTL', () => {
    const running = mission({ id: 'M1', title: 'Working', status: 'running' });
    // Two placeholders in the same project, both old enough for rule (g);
    // rule (e) dedupes them down to one FIRST (keeping 's2', the most
    // recently configured by insertion-order proxy).
    const older: HygienePreviewSurface = { id: 's1', projectId: 'p1', kind: 'preview', configuredAtMs: 1, placeholderSinceMs: NOW - 2 * DAY_MS };
    const newer: HygienePreviewSurface = { id: 's2', projectId: 'p1', kind: 'preview', configuredAtMs: 2, placeholderSinceMs: NOW - 2 * DAY_MS };
    const result = planFleetHygiene({ missions: [running], previewSurfaces: [older, newer] }, NOW, DEFAULT_HYGIENE_CONFIG);

    expect(result.previewSurfacesToRemove.map((s) => s.id)).toEqual(['s1']);
    // 's2' (the dedup survivor) IS independently TTL-expired too, but is
    // excluded here since it is not yet removed by rule (e) — it is the
    // KEPT one. 's1' is excluded from transientSurfacesToRemove because
    // rule (e) already claims it — never counted/removed twice.
    expect(result.transientSurfacesToRemove.map((s) => s.id)).toEqual(['s2']);
    expect(result.summary.purged).toBe(1);
    expect(result.summary.deduped).toBe(1);
  });

  it('rule (g) removes a stale dead preview surface but leaves a loop mission, a recent draft, and a review mission completely untouched in the SAME composed sweep', () => {
    // A loop's PARENT mission never leaves 'running' from fleetHygiene.ts's
    // own point of view while it keeps firing iterations — represented here
    // the same way any other never-archived live mission is: status
    // 'running'. A "macro" has no HygieneMission/HygienePreviewSurface/
    // HygieneCanvasArtifact shape at all (it is never passed into
    // planFleetHygiene — see FleetHygieneInputs), so it is untouchable by
    // construction; not separately fixture-able here.
    const loopParent = mission({ id: 'M-loop', title: 'Nightly loop', status: 'running' });
    const reviewMission = mission({ id: 'M-review', title: 'Awaiting review', status: 'review' });
    const recentDraft: HygieneCanvasArtifact = { id: 'draft-recent', label: 'Still being prepared' };
    const deadPreview: HygienePreviewSurface = {
      id: 'surf-dead',
      projectId: 'p1',
      kind: 'preview',
      placeholderSinceMs: NOW - 2 * DAY_MS,
    };

    const result = planFleetHygiene(
      { missions: [loopParent, reviewMission], previewSurfaces: [deadPreview], canvasArtifacts: [recentDraft] },
      NOW,
      DEFAULT_HYGIENE_CONFIG,
    );

    expect(result.transientSurfacesToRemove.map((s) => s.id)).toEqual(['surf-dead']);
    expect(result.missionsToArchive).toEqual([]);
    expect(result.canvasArtifactsToDelete).toEqual([]);
    expect(result.summary).toEqual({ archived: 0, purged: 1, deduped: 0, projectsClosed: 0, loopsFlagged: 0, orphanWorktreesRecoverable: 0 });
  });
});

// ── planLoopSupervision — rule (i), spec §4.4 "Supervision continue" ────

function loop(overrides: Partial<HygieneLoop> & { missionId: string; title: string }): HygieneLoop {
  return { enabled: true, cadenceMs: 60 * 60 * 1000, consecutiveFailures: 0, ...overrides };
}

describe('planLoopSupervision', () => {
  it('flags a loop with 3+ consecutive failures as repeated_failure', () => {
    const l = loop({ missionId: 'M1', title: 'Nightly loop', consecutiveFailures: 3 });
    const alerts = planLoopSupervision([l], NOW);
    expect(alerts).toEqual([{ missionId: 'M1', title: 'Nightly loop', reason: 'repeated_failure', detail: '3 echecs consecutifs' }]);
  });

  it('does not flag a loop with fewer than 3 consecutive failures', () => {
    const l = loop({ missionId: 'M1', title: 'Nightly loop', consecutiveFailures: 2 });
    expect(planLoopSupervision([l], NOW)).toEqual([]);
  });

  it('flags a loop whose learned metric declined', () => {
    const l = loop({ missionId: 'M1', title: 'Nightly loop', metricDeclined: true });
    const alerts = planLoopSupervision([l], NOW);
    expect(alerts).toEqual([{ missionId: 'M1', title: 'Nightly loop', reason: 'metric_decline', detail: 'mesure apprise en baisse' }]);
  });

  it('flags a loop overdue by 3x its own cadence as stalled', () => {
    const cadenceMs = 60 * 60 * 1000;
    const l = loop({ missionId: 'M1', title: 'Nightly loop', cadenceMs, nextRunAtMs: NOW - cadenceMs * 3 });
    const alerts = planLoopSupervision([l], NOW);
    expect(alerts).toEqual([{ missionId: 'M1', title: 'Nightly loop', reason: 'stalled', detail: 'en retard de 3x sa cadence' }]);
  });

  it('does not flag a loop only slightly overdue (never a false positive)', () => {
    const cadenceMs = 60 * 60 * 1000;
    const l = loop({ missionId: 'M1', title: 'Nightly loop', cadenceMs, nextRunAtMs: NOW - cadenceMs });
    expect(planLoopSupervision([l], NOW)).toEqual([]);
  });

  it('never inspects a disabled loop', () => {
    const l = loop({ missionId: 'M1', title: 'Paused loop', enabled: false, consecutiveFailures: 10, metricDeclined: true });
    expect(planLoopSupervision([l], NOW)).toEqual([]);
  });

  it('reports repeated_failure before stalled/metric_decline when several conditions match (most actionable first)', () => {
    const cadenceMs = 60 * 60 * 1000;
    const l = loop({
      missionId: 'M1',
      title: 'Everything wrong',
      cadenceMs,
      nextRunAtMs: NOW - cadenceMs * 5,
      consecutiveFailures: 4,
      metricDeclined: true,
    });
    const alerts = planLoopSupervision([l], NOW);
    expect(alerts).toEqual([{ missionId: 'M1', title: 'Everything wrong', reason: 'repeated_failure', detail: '4 echecs consecutifs' }]);
  });

  it('at most one alert per loop across a fleet of several loops', () => {
    const loops = [
      loop({ missionId: 'M1', title: 'Healthy', consecutiveFailures: 0 }),
      loop({ missionId: 'M2', title: 'Failing', consecutiveFailures: 5 }),
      loop({ missionId: 'M3', title: 'Declining', metricDeclined: true }),
    ];
    const alerts = planLoopSupervision(loops, NOW);
    expect(alerts.map((a) => a.missionId).sort()).toEqual(['M2', 'M3']);
  });
});
