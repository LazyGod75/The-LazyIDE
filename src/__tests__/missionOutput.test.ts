/**
 * Tests for missionOutput.ts — shared final-output/sent-task accessors used
 * by DataInspector.tsx's "Sortie finale" row.
 *
 * M12 dogfood fix (MAJEUR #6c): `extractFinalOutput` used to treat an
 * `[eval]` evaluation-pipeline status line (e.g. "[eval] Évaluation
 * terminée — score: 85 — PASSÉ", appended by runtime.ts's evaluator AFTER
 * the agent's own work finishes) as an equally-valid "result marker" —
 * since it is almost always the MOST RECENT match, "Sortie finale" showed
 * the judge's status line instead of the agent's real summary whenever no
 * explicit Résultat:/Result: marker existed. See managerEngine.test.ts's
 * "formatMissionDetail" suite for the mirrored fix on the LazyManager
 * grounding side (extractResultText).
 */

import { describe, it, expect } from 'vitest';
import { extractFinalOutput, extractSentTask } from '../lib/agents/missionOutput';
import type { Mission } from '../lib/agents/types';

function baseMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'M1',
    title: 'Fix the thing',
    status: 'review',
    model: 'claude-sonnet-5',
    ...overrides,
  };
}

describe('extractFinalOutput', () => {
  it('prefers an explicit Résultat: marker', () => {
    const mission = baseMission({
      actionTimeline: [
        { time: '10:00', text: 'Read auth.ts' },
        { time: '10:05', text: 'Résultat: PKCE flow implemented, 0 failing tests' },
      ],
    });
    expect(extractFinalOutput(mission)).toBe('Résultat: PKCE flow implemented, 0 failing tests');
  });

  it('prefers an explicit Result: marker (English)', () => {
    const mission = baseMission({
      actionTimeline: [
        { time: '10:00', text: 'Read auth.ts' },
        { time: '10:05', text: 'Result: done' },
      ],
    });
    expect(extractFinalOutput(mission)).toBe('Result: done');
  });

  it('falls back to the latest timeline entry when there is no explicit marker', () => {
    const mission = baseMission({
      actionTimeline: [
        { time: '10:00', text: 'Read auth.ts' },
        { time: '10:05', text: 'Edited auth.ts +40/-12' },
      ],
    });
    expect(extractFinalOutput(mission)).toBe('Edited auth.ts +40/-12');
  });

  it('BUGFIX: never returns a trailing [eval] line — falls back to the agent\'s latest real entry', () => {
    const mission = baseMission({
      actionTimeline: [
        { time: '10:00', text: 'Read auth.ts' },
        { time: '10:05', text: 'Edited auth.ts +40/-12' },
        { time: '10:06', text: '[eval] Évaluation terminée — score: 85 — PASSÉ' },
      ],
    });
    expect(extractFinalOutput(mission)).toBe('Edited auth.ts +40/-12');
  });

  it('BUGFIX: an explicit Résultat: marker still wins even when a LATER [eval] line exists', () => {
    const mission = baseMission({
      actionTimeline: [
        { time: '10:00', text: 'Read auth.ts' },
        { time: '10:05', text: 'Résultat: PKCE flow implemented, 0 failing tests' },
        { time: '10:06', text: '[eval] Évaluation terminée — score: 85 — PASSÉ' },
      ],
    });
    expect(extractFinalOutput(mission)).toBe('Résultat: PKCE flow implemented, 0 failing tests');
  });

  it('BUGFIX: skips MULTIPLE trailing eval lines to find the real last entry', () => {
    const mission = baseMission({
      actionTimeline: [
        { time: '10:00', text: 'Wrote report.md' },
        { time: '10:05', text: '[eval] Running tester sub-agent…' },
        { time: '10:06', text: '[eval] Running judge sub-agent…' },
        { time: '10:07', text: '[eval] Évaluation terminée — score: 85 — PASSÉ' },
      ],
    });
    expect(extractFinalOutput(mission)).toBe('Wrote report.md');
  });

  it('falls back to liveAction when the entire timeline is eval-only', () => {
    const mission = baseMission({
      actionTimeline: [{ time: '10:06', text: '[eval] Évaluation en cours…' }],
      liveAction: 'En attente de revue',
    });
    expect(extractFinalOutput(mission)).toBe('En attente de revue');
  });

  it('returns null (never a fabricated placeholder) when there is no timeline, result or liveAction', () => {
    const mission = baseMission();
    expect(extractFinalOutput(mission)).toBeNull();
  });

  it('returns null when the timeline is empty and there is no liveAction, even with eval-only history absent entirely', () => {
    const mission = baseMission({ actionTimeline: [] });
    expect(extractFinalOutput(mission)).toBeNull();
  });
});

describe('extractSentTask', () => {
  it('prefers agentTask over the contract objective', () => {
    const mission = baseMission({
      agentTask: 'Full task prompt',
      contract: { objective: 'Objective text' } as Mission['contract'],
    });
    expect(extractSentTask(mission)).toBe('Full task prompt');
  });

  it('falls back to contract.objective when agentTask is absent', () => {
    const mission = baseMission({
      contract: { objective: 'Objective text' } as Mission['contract'],
    });
    expect(extractSentTask(mission)).toBe('Objective text');
  });

  it('never falls back to title — returns null when neither agentTask nor objective exist', () => {
    const mission = baseMission({ title: 'Should never be used as the sent task' });
    expect(extractSentTask(mission)).toBeNull();
  });
});
