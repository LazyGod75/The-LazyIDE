/**
 * Tests for fleetMissions.ts's mergeLiveMissions — the pure merge of the
 * active project's live (streaming) agentsStore missions over its journal
 * snapshot (D3). Regression coverage for two real defects found in the live
 * app (post-e2e fix wave):
 *
 *  - F11: a mission vanished from the grid entirely on a running -> review
 *    transition, because the active project's branch used to REPLACE the
 *    journal snapshot outright instead of merging.
 *  - F4: a live mission that actually belongs to ANOTHER project (agentsStore
 *    carries no project id) was duplicated into the active project's group.
 */

import { describe, it, expect } from 'vitest';
import { mergeLiveMissions } from '../lib/agents/fleetMissions';
import type { FleetMission } from '../lib/agents/fleetMissions';
import type { Mission } from '../lib/agents/types';

const ACTIVE = 'c:/projects/demo-shop';
const OTHER = 'c:/projects/lazysite-internet';

function journalMission(overrides: Partial<FleetMission> & { id: string; title: string }): FleetMission {
  return {
    status: 'running',
    stage: 'code',
    model: 'sonnet',
    updatedMs: 1000,
    urgent: false,
    ...overrides,
  };
}

function liveMission(overrides: Partial<Mission> & { id: string; title: string }): Mission {
  return {
    status: 'running',
    model: 'sonnet',
    ...overrides,
  } as Mission;
}

describe('mergeLiveMissions', () => {
  it('keeps a journal-only mission that has transitioned out of the live store (F11: running -> review)', () => {
    // M9 ran visibly (was in the live store), then reached "review" — the
    // journal (source of truth) reflects this, but the live store no longer
    // tracks it (evicted once it left active streaming).
    const journalMissions: FleetMission[] = [
      journalMission({ id: 'M9', title: 'QA pricing — tests unitaires', status: 'review', stage: 'review', urgent: true }),
    ];
    const liveMissions: Mission[] = []; // agentsStore no longer carries M9
    const missionOwner = new Map([['M9', ACTIVE]]);

    const merged = mergeLiveMissions(journalMissions, liveMissions, ACTIVE, missionOwner);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: 'M9', status: 'review' });
  });

  it('overlays the live (streaming) version over the journal row for the same id, when both are present', () => {
    const journalMissions: FleetMission[] = [
      journalMission({ id: 'M9', title: 'QA pricing — tests unitaires', status: 'running', progress: 40 }),
    ];
    const liveMissions: Mission[] = [
      liveMission({ id: 'M9', title: 'QA pricing — tests unitaires', status: 'running', progress: 72, liveAction: 'Bash: node --test' }),
    ];
    const missionOwner = new Map([['M9', ACTIVE]]);

    const merged = mergeLiveMissions(journalMissions, liveMissions, ACTIVE, missionOwner);

    expect(merged).toHaveLength(1);
    // The fresher, live-streamed progress/liveAction wins.
    expect(merged[0].progress).toBe(72);
    expect(merged[0].liveAction).toBe('Bash: node --test');
  });

  it('does not duplicate a live mission into the active group when the journal attributes it to ANOTHER project (F4)', () => {
    // M8 is running (live, in agentsStore) but its journal row's project_id
    // says it actually belongs to the OTHER project.
    const journalMissions: FleetMission[] = []; // active project (demo-shop) has no M8 row
    const liveMissions: Mission[] = [
      liveMission({ id: 'M8', title: 'QA pricing — tests unitaires', status: 'running' }),
    ];
    const missionOwner = new Map([['M8', OTHER]]);

    const merged = mergeLiveMissions(journalMissions, liveMissions, ACTIVE, missionOwner);

    expect(merged).toHaveLength(0);
  });

  it('keeps a [DEMO] dev-seed live mission with no journal row anywhere in the active group', () => {
    const journalMissions: FleetMission[] = [];
    const liveMissions: Mission[] = [
      liveMission({ id: 'M-demo-1', title: '[DEMO] Implémenter l’endpoint', status: 'running' }),
    ];
    const missionOwner = new Map<string, string>(); // no journal row at all for this id

    const merged = mergeLiveMissions(journalMissions, liveMissions, ACTIVE, missionOwner);

    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('M-demo-1');
  });

  it('never conflates two missions that share the exact same title — always keyed by id', () => {
    // M8 (stopped, belongs to OTHER) and M9 (review, belongs to ACTIVE)
    // share the literal title "QA pricing — tests unitaires".
    const journalMissions: FleetMission[] = [
      journalMission({ id: 'M9', title: 'QA pricing — tests unitaires', status: 'review', stage: 'review', urgent: true }),
    ];
    const liveMissions: Mission[] = [
      liveMission({ id: 'M8', title: 'QA pricing — tests unitaires', status: 'cancelled' }),
    ];
    const missionOwner = new Map([
      ['M9', ACTIVE],
      ['M8', OTHER],
    ]);

    const merged = mergeLiveMissions(journalMissions, liveMissions, ACTIVE, missionOwner);

    // Only M9 belongs in the active group; M8 (same title, different id,
    // owned by OTHER) must not sneak in.
    expect(merged.map((m) => m.id)).toEqual(['M9']);
  });

  it('carries Mission.originConversationId through to the FleetMission read-model (canvas attribution wave 1)', () => {
    // Canvas attention-hierarchy wave 1: a manager-launched mission stamps
    // originConversationId onto the real Mission (agentsStore.tsx); the
    // Agent Canvas only ever sees FleetMission rows, so toFleetMission must
    // mirror it verbatim or the canvas has no way to attribute a mission
    // card to the conversation that launched it (conversationColor.ts's own
    // accent color was ready but had no consumer until this field existed
    // on FleetMission).
    const journalMissions: FleetMission[] = [];
    const liveMissions: Mission[] = [
      liveMission({ id: 'M42', title: 'Refactor billing', status: 'running', originConversationId: 'conv-abc' }),
    ];
    const missionOwner = new Map<string, string>(); // no journal row yet — brand new

    const merged = mergeLiveMissions(journalMissions, liveMissions, ACTIVE, missionOwner);

    expect(merged).toHaveLength(1);
    expect(merged[0].originConversationId).toBe('conv-abc');
  });

  it('leaves originConversationId absent for a mission launched outside the manager', () => {
    const journalMissions: FleetMission[] = [];
    const liveMissions: Mission[] = [
      liveMission({ id: 'M43', title: 'Canvas-launched mission', status: 'running' }),
    ];
    const missionOwner = new Map<string, string>();

    const merged = mergeLiveMissions(journalMissions, liveMissions, ACTIVE, missionOwner);

    expect(merged[0].originConversationId).toBeUndefined();
  });

  it('appends a brand-new live mission the journal has not flushed yet, without dropping existing journal rows', () => {
    const journalMissions: FleetMission[] = [
      journalMission({ id: 'M1', title: 'Existing mission' }),
    ];
    const liveMissions: Mission[] = [
      liveMission({ id: 'M1', title: 'Existing mission' }),
      liveMission({ id: 'M2', title: 'Brand new mission', status: 'queued' }),
    ];
    const missionOwner = new Map([['M1', ACTIVE]]); // M2 has no journal row yet

    const merged = mergeLiveMissions(journalMissions, liveMissions, ACTIVE, missionOwner);

    expect(merged.map((m) => m.id).sort()).toEqual(['M1', 'M2']);
  });

  it('returns the journal snapshot unchanged when there are no live missions at all', () => {
    const journalMissions: FleetMission[] = [
      journalMission({ id: 'M1', title: 'A' }),
      journalMission({ id: 'M2', title: 'B' }),
    ];

    const merged = mergeLiveMissions(journalMissions, [], ACTIVE, new Map());

    expect(merged).toEqual(journalMissions);
  });

  // QA B15: the cockpit's urgent card decides whether to offer "Promouvoir
  // en sonnet" on a 'review' mission via approveGate.ts's isJudgeRejected,
  // which reads judgeVerdict — toFleetMission (exercised here via the live
  // overlay path) must actually carry it onto FleetMission, or that check
  // can never see a real verdict.
  it('carries a live mission judgeVerdict onto the FleetMission row (QA B15)', () => {
    const journalMissions: FleetMission[] = [
      journalMission({ id: 'M9', title: 'Judged mission', status: 'review', stage: 'review' }),
    ];
    const liveMissions: Mission[] = [
      liveMission({
        id: 'M9',
        title: 'Judged mission',
        status: 'review',
        judgeVerdict: { score: 12, passed: false, risk: 'high', reviewers: [], createdAt: '2026-07-01T00:00:00.000Z' },
      }),
    ];
    const missionOwner = new Map([['M9', ACTIVE]]);

    const merged = mergeLiveMissions(journalMissions, liveMissions, ACTIVE, missionOwner);

    expect(merged).toHaveLength(1);
    expect(merged[0].judgeVerdict).toMatchObject({ score: 12, passed: false });
  });

  // Agent Canvas (W1c) — toFleetMission (exercised here via the live overlay
  // path, same as the judgeVerdict test above) must carry the new loop/
  // hierarchy/cost fields onto FleetMission verbatim, or the canvas
  // reconciler's loop aggregation / hierarchy edges / cost chip have nothing
  // real to read.
  it('carries loopConfig/loopParentId/loopIteration/parentMissionId/cost onto the FleetMission row (W1c)', () => {
    const journalMissions: FleetMission[] = [
      journalMission({ id: 'M10', title: 'Loop parent' }),
    ];
    const liveMissions: Mission[] = [
      liveMission({
        id: 'M10',
        title: 'Loop parent',
        loopConfig: { cadence: '5m', stopCondition: { kind: 'manual' }, enabled: true, iterationCount: 2, iterationMissionIds: ['M11'] },
        loopParentId: 'M-parent-loop',
        loopIteration: 3,
        parentMissionId: 'M-orchestrator',
        cost: '$0.42',
      }),
    ];
    const missionOwner = new Map([['M10', ACTIVE]]);

    const merged = mergeLiveMissions(journalMissions, liveMissions, ACTIVE, missionOwner);

    expect(merged).toHaveLength(1);
    expect(merged[0].loopConfig).toMatchObject({ cadence: '5m', iterationCount: 2 });
    expect(merged[0].loopParentId).toBe('M-parent-loop');
    expect(merged[0].loopIteration).toBe(3);
    expect(merged[0].parentMissionId).toBe('M-orchestrator');
    expect(merged[0].cost).toBe('$0.42');
  });

  // Brain-integration wave — toFleetMission must carry the brain-recall
  // visibility fields (brainAdapted/brainCitations count/tokensSaved) onto
  // FleetMission verbatim, or the Cockpit/Code grid has no real signal that
  // a mission was actually grounded by the pre-run brain-recall enrichment
  // (runtime.ts's 'brain-recall' launch phase).
  it('carries brainAdapted/brainCitationsCount/tokensSaved onto the FleetMission row', () => {
    const journalMissions: FleetMission[] = [
      journalMission({ id: 'M11', title: 'Grounded mission' }),
    ];
    const liveMissions: Mission[] = [
      liveMission({
        id: 'M11',
        title: 'Grounded mission',
        brainAdapted: true,
        brainCitations: [{ id: 'n1', label: 'Auth decision' }, { id: 'n2', label: 'Rate limit note' }],
        tokensSaved: '~1.2k tokens économisés',
      }),
    ];
    const missionOwner = new Map([['M11', ACTIVE]]);

    const merged = mergeLiveMissions(journalMissions, liveMissions, ACTIVE, missionOwner);

    expect(merged).toHaveLength(1);
    expect(merged[0].brainAdapted).toBe(true);
    expect(merged[0].brainCitationsCount).toBe(2);
    expect(merged[0].tokensSaved).toBe('~1.2k tokens économisés');
  });

  it('leaves brainAdapted/brainCitationsCount/tokensSaved absent (not fabricated) when the mission carries none', () => {
    const journalMissions: FleetMission[] = [
      journalMission({ id: 'M12', title: 'Ungrounded mission' }),
    ];
    const liveMissions: Mission[] = [
      liveMission({ id: 'M12', title: 'Ungrounded mission' }),
    ];
    const missionOwner = new Map([['M12', ACTIVE]]);

    const merged = mergeLiveMissions(journalMissions, liveMissions, ACTIVE, missionOwner);

    expect(merged[0].brainAdapted).toBeUndefined();
    expect(merged[0].brainCitationsCount).toBeUndefined();
    expect(merged[0].tokensSaved).toBeUndefined();
  });
});
