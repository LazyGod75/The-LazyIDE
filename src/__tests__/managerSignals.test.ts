import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  deriveManagerSignals,
  useAcknowledgedSignals,
  visibleManagerSignals,
} from '../components/agents/cockpit/managerSignals';
import type { FleetMission, FleetProject } from '../lib/agents/fleetMissions';

function mission(overrides: Partial<FleetMission> = {}): FleetMission {
  return {
    id: 'm1',
    title: 'Test mission',
    status: 'running',
    stage: 'code',
    model: 'sonnet',
    updatedMs: 0,
    urgent: false,
    ...overrides,
  };
}

function project(missions: FleetMission[], overrides: Partial<FleetProject> = {}): FleetProject {
  return {
    projectId: 'p1',
    root: '/p1',
    name: 'demo-shop',
    missions,
    ...overrides,
  };
}

describe('deriveManagerSignals', () => {
  it('emits a question signal for a running mission with a real pending question', () => {
    const signals = deriveManagerSignals([
      project([mission({ id: 'm12', status: 'running', pendingQuestion: 'Overwrite auth.rs?' })]),
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      id: 'question:m12',
      kind: 'question',
      question: 'Overwrite auth.rs?',
      projectId: 'p1',
      projectName: 'demo-shop',
    });
    // No canned button set for a question — it gets the inline answer form
    // instead (rendered by ManagerSignalBubble), not Merger/Diff/Réessayer.
    expect(signals[0].buttons).toEqual([]);
  });

  it('emits a review signal with real merge/diff action buttons', () => {
    const signals = deriveManagerSignals([project([mission({ id: 'm7', status: 'review' })])]);
    expect(signals).toHaveLength(1);
    expect(signals[0].kind).toBe('review');
    expect(signals[0].buttons.map((b) => b.key)).toEqual(['merge', 'diff']);
    expect(signals[0].buttons[0].variant).toBe('primary');
  });

  it('emits a failed signal with real retry/diff action buttons', () => {
    const signals = deriveManagerSignals([project([mission({ id: 'm9', status: 'failed' })])]);
    expect(signals).toHaveLength(1);
    expect(signals[0].kind).toBe('failed');
    expect(signals[0].buttons.map((b) => b.key)).toEqual(['retry', 'diff']);
  });

  it('never fabricates a question for a mission with no real pendingQuestion', () => {
    const signals = deriveManagerSignals([project([mission({ id: 'm1', status: 'running' })])]);
    expect(signals).toHaveLength(0);
  });

  it('produces a stable id per (kind, missionId) so the SAME open event never duplicates across polls', () => {
    const projects = [project([mission({ id: 'm12', status: 'running', pendingQuestion: 'Same question?' })])];
    const first = deriveManagerSignals(projects);
    const second = deriveManagerSignals(projects);
    expect(first[0].id).toBe(second[0].id);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it('drops the signal once the mission is no longer urgent (resolved/merged/retried) — no stale entries', () => {
    const before = deriveManagerSignals([project([mission({ id: 'm9', status: 'failed' })])]);
    expect(before).toHaveLength(1);
    const after = deriveManagerSignals([project([mission({ id: 'm9', status: 'done' })])]);
    expect(after).toHaveLength(0);
  });

  // Real user report fix: an old failed/review mission the user archived
  // (R13 lifecycle, Mission.archived) kept re-emitting the exact same
  // signal forever since classifyUrgent has no archived check — a
  // resurfaced-notification defect, not a "mission is still urgent" one.
  it('never emits a signal for an archived mission, even if its status would otherwise be urgent', () => {
    const signals = deriveManagerSignals([
      project([mission({ id: 'm20', status: 'failed', archived: true })]),
    ]);
    expect(signals).toHaveLength(0);
  });

  it('still emits the signal for the SAME mission once un-archived (archived is a live filter, not a mute)', () => {
    const archived = deriveManagerSignals([project([mission({ id: 'm21', status: 'failed', archived: true })])]);
    expect(archived).toHaveLength(0);
    const unarchived = deriveManagerSignals([project([mission({ id: 'm21', status: 'failed', archived: false })])]);
    expect(unarchived).toHaveLength(1);
  });

  it('is ordered fleet-wide the same way as the AGENTS zone urgent cards (permission > failed > review)', () => {
    const signals = deriveManagerSignals([
      project([
        mission({ id: 'rev', status: 'review', updatedMs: 1 }),
        mission({ id: 'fail', status: 'failed', updatedMs: 2 }),
        mission({ id: 'q', status: 'running', pendingQuestion: 'Q?', updatedMs: 3 }),
      ]),
    ]);
    expect(signals.map((s) => s.kind)).toEqual(['question', 'failed', 'review']);
  });

  // Real-user QA: screenshots showed missions labeled with the OTHER open
  // project's name ("M39 (lazy-backoffice)" for a Lazy-repo mission, "M52
  // (Lazy)" for the backoffice one) — a mission must always be attributed to
  // ITS OWN project, never the other one that happens to also be open, and
  // never the currently-active project as a fallback.
  it('attributes each mission to its OWN project, never a crossed/active-project name, across two open projects', () => {
    const signals = deriveManagerSignals([
      project([mission({ id: 'm39', status: 'review' })], { projectId: 'lazy', root: 'C:\\Lazy', name: 'Lazy' }),
      project([mission({ id: 'm52', status: 'failed' })], {
        projectId: 'backoffice',
        root: 'C:\\lazy-backoffice',
        name: 'lazy-backoffice',
      }),
    ]);

    const m39 = signals.find((s) => s.mission.id === 'm39')!;
    const m52 = signals.find((s) => s.mission.id === 'm52')!;
    expect(m39.projectName).toBe('Lazy');
    expect(m39.projectId).toBe('lazy');
    expect(m52.projectName).toBe('lazy-backoffice');
    expect(m52.projectId).toBe('backoffice');
  });

  // BUG A fix: a mission whose last "Merger" click ended in a real git
  // conflict must render as an honest 'conflict' signal (Diff only) instead
  // of silently re-offering the exact "Merger" button that just conflicted.
  describe('conflict state (merge-signal honesty fix)', () => {
    it('overrides a review mission to kind "conflict" with a Diff-only button when its id is in conflictedMissionIds', () => {
      const signals = deriveManagerSignals(
        [project([mission({ id: 'm41', status: 'review' })])],
        new Set(['m41']),
      );
      expect(signals).toHaveLength(1);
      expect(signals[0].kind).toBe('conflict');
      expect(signals[0].buttons.map((b) => b.key)).toEqual(['diff']);
    });

    it('leaves an unrelated review mission untouched when conflictedMissionIds only names a different mission', () => {
      const signals = deriveManagerSignals(
        [project([mission({ id: 'm7', status: 'review' })])],
        new Set(['some-other-mission']),
      );
      expect(signals[0].kind).toBe('review');
      expect(signals[0].buttons.map((b) => b.key)).toEqual(['merge', 'diff']);
    });

    it('never overrides a failed/question mission to conflict — conflict only ever applies to a review outcome', () => {
      const signals = deriveManagerSignals(
        [project([mission({ id: 'm9', status: 'failed' })])],
        new Set(['m9']),
      );
      expect(signals[0].kind).toBe('failed');
    });
  });
});

// Real user report fix: "j'ai des trucs échoués que je ne peux jamais
// supprimer donc ça pollue" — 29 stacked signals, some for missions that
// never resolve, with no way to dismiss them. useAcknowledgedSignals adds a
// persisted (localStorage), per-signal-id dismissal on top of the still-pure
// deriveManagerSignals above.
describe('useAcknowledgedSignals — persisted per-signal dismissal', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('starts with nothing acknowledged', () => {
    const { result } = renderHook(() => useAcknowledgedSignals());
    expect(result.current.isAcknowledged('failed:m9')).toBe(false);
  });

  it('acknowledge(id) marks exactly that id as acknowledged, nothing else', () => {
    const { result } = renderHook(() => useAcknowledgedSignals());
    act(() => result.current.acknowledge('failed:m9'));
    expect(result.current.isAcknowledged('failed:m9')).toBe(true);
    expect(result.current.isAcknowledged('review:m7')).toBe(false);
  });

  it('acknowledgeAll(ids) marks every id in the batch at once ("tout effacer")', () => {
    const { result } = renderHook(() => useAcknowledgedSignals());
    act(() => result.current.acknowledgeAll(['failed:m9', 'review:m7', 'question:m12']));
    expect(result.current.isAcknowledged('failed:m9')).toBe(true);
    expect(result.current.isAcknowledged('review:m7')).toBe(true);
    expect(result.current.isAcknowledged('question:m12')).toBe(true);
  });

  it('persists across a remount (localStorage-backed, not just in-memory)', () => {
    const first = renderHook(() => useAcknowledgedSignals());
    act(() => first.result.current.acknowledge('failed:m9'));
    first.unmount();

    const second = renderHook(() => useAcknowledgedSignals());
    expect(second.result.current.isAcknowledged('failed:m9')).toBe(true);
  });

  it('a corrupt localStorage value degrades to "nothing acknowledged" instead of throwing', () => {
    localStorage.setItem('lazy.managerSignals.acknowledged', 'not valid json{{{');
    expect(() => renderHook(() => useAcknowledgedSignals())).not.toThrow();
    const { result } = renderHook(() => useAcknowledgedSignals());
    expect(result.current.isAcknowledged('failed:m9')).toBe(false);
  });

  it('acknowledging a (kind, missionId) pair does not suppress a DIFFERENT state for the same mission (dismissal is per-event, not per-mission)', () => {
    const { result } = renderHook(() => useAcknowledgedSignals());
    act(() => result.current.acknowledge('failed:m9'));
    // The mission later moves to 'review' — a different id — must still show.
    expect(result.current.isAcknowledged('review:m9')).toBe(false);
  });
});

describe('visibleManagerSignals — filters a derived list down to non-acknowledged signals', () => {
  it('drops exactly the acknowledged ids and keeps the rest, pure and order-preserving', () => {
    const signals = deriveManagerSignals([
      project([
        mission({ id: 'rev', status: 'review', updatedMs: 1 }),
        mission({ id: 'fail', status: 'failed', updatedMs: 2 }),
      ]),
    ]);
    const visible = visibleManagerSignals(signals, new Set(['failed:fail']));
    expect(visible.map((s) => s.id)).toEqual(['review:rev']);
  });

  it('returns every signal unchanged when nothing is acknowledged', () => {
    const signals = deriveManagerSignals([project([mission({ id: 'm9', status: 'failed' })])]);
    expect(visibleManagerSignals(signals, new Set())).toEqual(signals);
  });
});
