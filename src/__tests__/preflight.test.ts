/**
 * preflight.test.ts — T1.6 coverage for mission conflict pre-flight
 * (src/lib/agents/preflight.ts, spec §7.2).
 *
 * journalQuery (src/lib/journal/journal.ts) is mocked directly rather than
 * the underlying Tauri invoke — preflight.ts only ever calls journalQuery,
 * never invoke itself (same convention as estimator.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  predictedScope,
  historicalTouches,
  checkConflicts,
  pathsOverlap,
} from '../lib/agents/preflight';
import { journalQuery } from '../lib/journal/journal';
import type { JournalEventRow } from '../lib/journal/eventTypes';
import type { Mission, MissionContract } from '../lib/agents/types';

vi.mock('../lib/journal/journal', () => ({
  journalQuery: vi.fn(),
}));

const mockJournalQuery = vi.mocked(journalQuery);

beforeEach(() => {
  mockJournalQuery.mockReset();
  mockJournalQuery.mockResolvedValue([]);
});

// ── Fixtures ──────────────────────────────────────────────────────────

function makeContract(overrides: Partial<MissionContract> = {}): MissionContract {
  return {
    objective: 'do the thing',
    model: 'claude-sonnet-5',
    permissionMode: 'acceptEdits',
    budgetCapUsd: 5,
    proofs: [],
    gates: { evaluators: true, humanApprove: true },
    shareToTeam: false,
    ...overrides,
  };
}

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'M1',
    title: 'Test mission',
    status: 'running',
    model: 'claude-sonnet-5',
    ...overrides,
  };
}

function toolCalledRow(missionId: string, files: string[]): JournalEventRow {
  return {
    seq: 0,
    ts_ms: 0,
    project_id: 'proj-1',
    mission_id: missionId,
    agent_id: null,
    run_id: null,
    actor: 'agent',
    type: 'tool.called',
    payload: JSON.stringify({ name: 'edit_file', files }),
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
  };
}

// ── pathsOverlap: segment-prefix matrix ────────────────────────────────

describe('pathsOverlap', () => {
  it('is true for two equal paths', () => {
    expect(pathsOverlap('src/lib', 'src/lib')).toBe(true);
  });

  it('is true when one is a directory-prefix of the other (either direction)', () => {
    expect(pathsOverlap('src/lib', 'src/lib/x.ts')).toBe(true);
    expect(pathsOverlap('src/lib/x.ts', 'src/lib')).toBe(true);
  });

  it('is false for a sibling that merely shares a character prefix, not a path segment', () => {
    // 'src/library' shares the literal characters "src/lib" with 'src/lib'
    // but is a DIFFERENT directory — a naive startsWith would wrongly match.
    expect(pathsOverlap('src/library', 'src/lib')).toBe(false);
    expect(pathsOverlap('src/lib', 'src/library')).toBe(false);
  });

  it('is false for unrelated paths', () => {
    expect(pathsOverlap('docs', 'src/lib')).toBe(false);
  });

  it('normalizes Windows verbatim (\\\\?\\) prefixes and separators, and compares case-insensitively', () => {
    expect(
      pathsOverlap('\\\\?\\C:\\proj\\src\\Lib\\Foo.ts', 'C:/proj/src/lib'),
    ).toBe(true);
  });

  it('treats a trailing slash as equivalent to no trailing slash', () => {
    expect(pathsOverlap('src/lib/', 'src/lib')).toBe(true);
  });
});

// ── predictedScope ──────────────────────────────────────────────────────

describe('predictedScope', () => {
  it('returns contract.scopePaths when present', () => {
    const mission = makeMission({ contract: makeContract({ scopePaths: ['src/lib', 'src/components'] }) });
    expect(predictedScope(mission)).toEqual(['src/lib', 'src/components']);
  });

  it('returns [] when the mission has no contract at all', () => {
    expect(predictedScope(makeMission({ contract: undefined }))).toEqual([]);
  });

  it('returns [] when the contract has no scopePaths (unknown scope)', () => {
    expect(predictedScope(makeMission({ contract: makeContract({ scopePaths: undefined }) }))).toEqual([]);
  });

  it('strips a Windows verbatim prefix from declared scope paths', () => {
    const mission = makeMission({
      contract: makeContract({ scopePaths: ['\\\\?\\C:\\proj\\src\\lib'] }),
    });
    expect(predictedScope(mission)).toEqual(['C:\\proj\\src\\lib']);
  });
});

// ── historicalTouches ───────────────────────────────────────────────────

describe('historicalTouches', () => {
  it('queries the journal for this mission\'s tool.called history', async () => {
    await historicalTouches('M1');
    expect(mockJournalQuery).toHaveBeenCalledWith({
      missionId: 'M1',
      types: ['tool.called'],
      limit: 500,
    });
  });

  it('unions payload.files across every tool.called row, deduplicated', async () => {
    mockJournalQuery.mockResolvedValue([
      toolCalledRow('M1', ['src/lib/a.ts', 'src/lib/b.ts']),
      toolCalledRow('M1', ['src/lib/a.ts', 'src/lib/c.ts']),
    ]);

    const touches = await historicalTouches('M1');

    expect(new Set(touches)).toEqual(new Set(['src/lib/a.ts', 'src/lib/b.ts', 'src/lib/c.ts']));
  });

  it('tolerates rows with no files field', async () => {
    mockJournalQuery.mockResolvedValue([
      { ...toolCalledRow('M1', []), payload: JSON.stringify({ name: 'read_file' }) },
    ]);
    await expect(historicalTouches('M1')).resolves.toEqual([]);
  });

  it('skips a malformed payload row instead of throwing, and still returns the others', async () => {
    mockJournalQuery.mockResolvedValue([
      { ...toolCalledRow('M1', ['src/ok.ts']), payload: '{not json' },
      toolCalledRow('M1', ['src/ok.ts']),
    ]);
    await expect(historicalTouches('M1')).resolves.toEqual(['src/ok.ts']);
  });

  it('resolves to [] (never throws) when the journal query itself rejects', async () => {
    mockJournalQuery.mockRejectedValue(new Error('db unavailable'));
    await expect(historicalTouches('M1')).resolves.toEqual([]);
  });
});

// ── checkConflicts ──────────────────────────────────────────────────────

describe('checkConflicts', () => {
  it('never conflicts when the candidate has an unknown (empty) scope', async () => {
    const candidate = makeMission({ id: 'C', contract: undefined });
    const running = makeMission({ id: 'R', contract: makeContract({ scopePaths: ['src/lib'] }) });

    const result = await checkConflicts(candidate, [running]);

    expect(result).toEqual({ conflictsWith: [], overlaps: {} });
    // Documented behavior: an unknown-scope candidate short-circuits before
    // ever consulting history — false positives here would only teach users
    // to omit scopePaths to dodge the pre-flight.
    expect(mockJournalQuery).not.toHaveBeenCalled();
  });

  it('detects a conflict via the running mission\'s DECLARED scope', async () => {
    const candidate = makeMission({ id: 'C', contract: makeContract({ scopePaths: ['src/lib/foo.ts'] }) });
    const running = makeMission({ id: 'R', contract: makeContract({ scopePaths: ['src/lib'] }) });

    const result = await checkConflicts(candidate, [running]);

    expect(result.conflictsWith).toEqual(['R']);
    expect(result.overlaps.R).toEqual(expect.arrayContaining(['src/lib/foo.ts', 'src/lib']));
  });

  it('detects a conflict via the running mission\'s HISTORICAL touches, even with no declared scope', async () => {
    const candidate = makeMission({ id: 'C', contract: makeContract({ scopePaths: ['src/lib'] }) });
    const running = makeMission({ id: 'R', contract: undefined });
    mockJournalQuery.mockResolvedValue([toolCalledRow('R', ['src/lib/touched.ts'])]);

    const result = await checkConflicts(candidate, [running]);

    expect(result.conflictsWith).toEqual(['R']);
  });

  it('does not conflict on a sibling directory that only shares a character prefix', async () => {
    const candidate = makeMission({ id: 'C', contract: makeContract({ scopePaths: ['src/library'] }) });
    const running = makeMission({ id: 'R', contract: makeContract({ scopePaths: ['src/lib'] }) });

    const result = await checkConflicts(candidate, [running]);

    expect(result).toEqual({ conflictsWith: [], overlaps: {} });
  });

  it('aggregates across multiple running missions, reporting only the ones that actually overlap', async () => {
    const candidate = makeMission({ id: 'C', contract: makeContract({ scopePaths: ['src/lib'] }) });
    const overlapping = makeMission({ id: 'R1', contract: makeContract({ scopePaths: ['src/lib/foo.ts'] }) });
    const disjoint = makeMission({ id: 'R2', contract: makeContract({ scopePaths: ['docs'] }) });

    const result = await checkConflicts(candidate, [overlapping, disjoint]);

    expect(result.conflictsWith).toEqual(['R1']);
    expect(Object.keys(result.overlaps)).toEqual(['R1']);
  });

  it('never checks a mission against itself even if it appears in runningMissions', async () => {
    const candidate = makeMission({ id: 'C', contract: makeContract({ scopePaths: ['src/lib'] }) });

    const result = await checkConflicts(candidate, [candidate]);

    expect(result).toEqual({ conflictsWith: [], overlaps: {} });
  });

  it('stays defensive when a running mission\'s history lookup fails — other missions are still checked', async () => {
    const candidate = makeMission({ id: 'C', contract: makeContract({ scopePaths: ['src/lib'] }) });
    const flaky = makeMission({ id: 'R1', contract: undefined });
    const overlapping = makeMission({ id: 'R2', contract: makeContract({ scopePaths: ['src/lib/foo.ts'] }) });

    mockJournalQuery.mockImplementation(async ({ missionId }: { missionId?: string }) => {
      if (missionId === 'R1') throw new Error('journal down');
      return [];
    });

    const result = await checkConflicts(candidate, [flaky, overlapping]);

    expect(result.conflictsWith).toEqual(['R2']);
  });
});
