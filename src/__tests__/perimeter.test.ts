/**
 * perimeter.test.ts — D13 graft (b): derivePerimeterRows pure helper.
 * Verifies the declared/flagged split from contract.scopePaths plus
 * statusReason/pending-question signals, and the honest-empty path when
 * there's no contract.
 */

import { describe, it, expect } from 'vitest';
import { derivePerimeterRows } from '../lib/agents/perimeter';
import type { Mission, MissionContract } from '../lib/agents/types';

function makeContract(scopePaths: string[]): MissionContract {
  return {
    objective: 'test objective',
    scopePaths,
    model: 'sonnet',
    permissionMode: 'acceptEdits',
    budgetCapUsd: 5,
    proofs: [],
    gates: { evaluators: true, humanApprove: true },
    shareToTeam: false,
  };
}

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'm1',
    title: 'Test mission',
    status: 'running',
    model: 'sonnet',
    ...overrides,
  };
}

describe('derivePerimeterRows', () => {
  it('returns [] when the mission has no contract', () => {
    expect(derivePerimeterRows(makeMission())).toEqual([]);
  });

  it('returns [] when the contract has no scopePaths', () => {
    const mission = makeMission({ contract: makeContract([]) });
    expect(derivePerimeterRows(mission)).toEqual([]);
  });

  it('returns one declared row per scope path when there is no denial signal', () => {
    const mission = makeMission({ contract: makeContract(['src/lib', 'src/components']) });
    expect(derivePerimeterRows(mission)).toEqual([
      { path: 'src/lib', state: 'declared' },
      { path: 'src/components', state: 'declared' },
    ]);
  });

  it('flags a path mentioned in statusReason on a failed mission', () => {
    const mission = makeMission({
      status: 'failed',
      statusReason: 'Écriture refusée hors périmètre : src/lib/secret.ts',
      contract: makeContract(['src/lib', 'src/components']),
    });
    const rows = derivePerimeterRows(mission);
    expect(rows).toEqual([
      { path: 'src/lib', state: 'flagged', detail: mission.statusReason },
      { path: 'src/components', state: 'declared' },
    ]);
  });

  it('does not flag from statusReason when the mission is not failed', () => {
    const mission = makeMission({
      status: 'running',
      statusReason: 'mentions src/lib but mission is not failed',
      contract: makeContract(['src/lib']),
    });
    expect(derivePerimeterRows(mission)).toEqual([{ path: 'src/lib', state: 'declared' }]);
  });

  it('flags a path mentioned in a pending ask_user question', () => {
    const mission = makeMission({
      status: 'running',
      contract: makeContract(['server/auth.rs']),
      actionTimeline: [
        { time: '10:00', text: 'Observation: Question for user: write server/auth.rs ?' },
      ],
    });
    const rows = derivePerimeterRows(mission);
    expect(rows).toEqual([
      { path: 'server/auth.rs', state: 'flagged', detail: 'write server/auth.rs ?' },
    ]);
  });

  it('is case-insensitive when matching the flag text against the path', () => {
    const mission = makeMission({
      status: 'failed',
      statusReason: 'Blocked touching SRC/LIB/secret.ts',
      contract: makeContract(['src/lib']),
    });
    expect(derivePerimeterRows(mission)).toEqual([
      { path: 'src/lib', state: 'flagged', detail: mission.statusReason },
    ]);
  });
});
