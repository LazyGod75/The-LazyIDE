/* OrchestratorTree.tsx — Hierarchical plan steps (Pillar E3).

   Chantier 3 (plan-first canvas) fix: steps used to render as one flat
   ordered `<ol>`, which threw away `dependsOn`'s parallelism information —
   two steps that both depend on the same upstream step (meant to run in
   parallel) looked identical to a strictly sequential plan. Steps are now
   grouped into "waves" (a step's wave = 1 + the max wave of its
   dependencies, 0 for a step with none) and rendered as stacked ROWS of
   steps, so same-wave (parallel) steps sit side by side instead of one
   under the other — same visual language the canvas's own DAG preview and
   GraphProposalCard's mini-graph already use for "these run together".
   Every per-step testid/prop/click behavior is unchanged (verified against
   CockpitLeftRail.tsx, this component's only consumer) — only the grouping
   changed, never the contract. */

import type { OrchestratorState, OrchestratorPlanStep } from '../../../lib/agents/types';
import { useI18n } from '../../../i18n';
import { formatCredits } from '../../../lib/billing';

/** Groups steps into dependency "waves" — a step's wave is one past the
 *  latest wave among its `dependsOn` (0 when it has none). Steps sharing a
 *  wave have no path between them through `dependsOn` and can legitimately
 *  run in parallel — this is a display-only grouping (never touches
 *  `orchestrator.steps`'s own order, which callers may still rely on
 *  elsewhere), pure and independently testable. An unresolvable `dependsOn`
 *  reference (a stale/hand-edited id) degrades to "no dependency" for that
 *  one edge rather than throwing. */
export function groupStepsIntoWaves(steps: readonly OrchestratorPlanStep[]): OrchestratorPlanStep[][] {
  const waveById = new Map<string, number>();
  const stepById = new Map(steps.map((s) => [s.id, s] as const));

  function waveOf(id: string, seen: ReadonlySet<string>): number {
    const cached = waveById.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0; // defensive: a cyclic dependsOn never happens in practice
    const step = stepById.get(id);
    if (!step || step.dependsOn.length === 0) {
      waveById.set(id, 0);
      return 0;
    }
    const nextSeen = new Set(seen).add(id);
    const maxDepWave = Math.max(
      ...step.dependsOn
        .filter((depId) => stepById.has(depId))
        .map((depId) => waveOf(depId, nextSeen)),
      -1,
    );
    const wave = maxDepWave + 1;
    waveById.set(id, wave);
    return wave;
  }

  const waves: OrchestratorPlanStep[][] = [];
  for (const step of steps) {
    const wave = waveOf(step.id, new Set());
    waves[wave] = waves[wave] ? [...waves[wave], step] : [step];
  }
  return waves.filter((w): w is OrchestratorPlanStep[] => w !== undefined);
}

export interface OrchestratorTreeProps {
  orchestrator: OrchestratorState;
  onStepClick?: (step: OrchestratorPlanStep) => void;
}

const STEP_COLOR: Record<OrchestratorPlanStep['status'], string> = {
  pending: 'rgba(148,163,184,0.85)',
  in_progress: 'rgba(251,191,36,0.95)',
  done: 'rgba(52,211,153,0.95)',
  failed: 'rgba(248,113,113,0.95)',
  skipped: 'rgba(148,163,184,0.55)',
};

export function OrchestratorTree({ orchestrator, onStepClick }: OrchestratorTreeProps) {
  const { t } = useI18n();
  const done = orchestrator.steps.filter((s) => s.status === 'done').length;
  const total = orchestrator.steps.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div
      data-testid={`orchestrator-tree-${orchestrator.id}`}
      style={{
        padding: 12,
        borderRadius: 12,
        background: 'rgba(15,15,22,0.85)',
        border: '1px solid rgba(255,255,255,0.08)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 650, color: 'rgba(255,255,255,0.9)' }}>{orchestrator.name}</div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginTop: 2, lineHeight: 1.35 }}>
            {orchestrator.objective}
          </div>
        </div>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color:
              orchestrator.status === 'done'
                ? STEP_COLOR.done
                : orchestrator.status === 'executing'
                  ? STEP_COLOR.in_progress
                  : orchestrator.status === 'blocked'
                    ? STEP_COLOR.failed
                    : 'rgba(255,255,255,0.45)',
            flexShrink: 0,
          }}
        >
          {orchestrator.status}
        </span>
      </div>

      <div style={{ height: 3, borderRadius: 99, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: 'linear-gradient(90deg, #22d3ee, #34d399)',
            transition: 'width 200ms ease',
          }}
        />
      </div>
      <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>
        {done}/{total} steps ·{' '}
        {orchestrator.budget.limitCents != null
          ? t('cockpit.budget.spentOfLimit', {
              spent: formatCredits(orchestrator.budget.spentCents),
              limit: formatCredits(orchestrator.budget.limitCents),
            })
          : t('cockpit.budget.spent', { spent: formatCredits(orchestrator.budget.spentCents) })}
      </div>

      {/* Steps grouped into waves (see groupStepsIntoWaves's own doc
          comment): each row is one wave — steps sharing a row have no
          dependsOn path between them and can legitimately run in parallel.
          Numbering stays the step's ORIGINAL position in `orchestrator.steps`
          (never re-numbered per-wave), so "step 3" means the same thing here
          as everywhere else this plan is referenced. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {groupStepsIntoWaves(orchestrator.steps).map((wave, waveIdx) => (
          <div
            key={waveIdx}
            data-testid={`orchestrator-tree-${orchestrator.id}-wave-${waveIdx}`}
            style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}
          >
            {wave.map((s) => {
              const idx = orchestrator.steps.indexOf(s);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onStepClick?.(s)}
                  style={{
                    flex: wave.length > 1 ? '1 1 200px' : '1 1 100%',
                    textAlign: 'left',
                    padding: '8px 10px',
                    borderRadius: 8,
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    cursor: 'pointer',
                    display: 'flex',
                    gap: 8,
                    alignItems: 'flex-start',
                  }}
                >
                  <span
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 6,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 10,
                      fontWeight: 700,
                      color: STEP_COLOR[s.status],
                      background: `${STEP_COLOR[s.status]}18`,
                      flexShrink: 0,
                    }}
                  >
                    {idx + 1}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 12, color: 'rgba(255,255,255,0.88)', lineHeight: 1.35 }}>
                      {s.description}
                    </span>
                    <span style={{ display: 'block', marginTop: 3, fontSize: 10, color: STEP_COLOR[s.status] }}>
                      {s.status}
                      {s.missionIds.length > 0 ? ` · ${s.missionIds.length} mission(s)` : ''}
                      {s.costCents != null ? ` · ${t('cockpit.budget.spent', { spent: formatCredits(s.costCents) })}` : ''}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
