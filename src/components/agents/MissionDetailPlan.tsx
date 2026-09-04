/* MissionDetailPlan — Plan steps section for MissionDetail */

import type { PlanStep } from '../../lib/agents/types';

interface MissionDetailPlanProps {
  planSteps: PlanStep[];
}

function StepIcon({ state }: { state: PlanStep['state'] }) {
  if (state === 'done') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
        <circle cx="8" cy="8" r="7" fill="rgba(34,197,94,0.15)" stroke="#22C55E" strokeWidth="1.5" />
        <path d="M5 8.5L7.2 10.5L11 6" stroke="#22C55E" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (state === 'in_progress') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
        <circle cx="8" cy="8" r="7" fill="rgba(124,92,255,0.15)" stroke="#7C5CFF" strokeWidth="1.5" />
        <path d="M8 4 A4 4 0 0 1 12 8" stroke="#7C5CFF" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="8" cy="8" r="7" stroke="rgba(255,255,255,0.18)" strokeWidth="1.5" />
    </svg>
  );
}

export function MissionDetailPlan({ planSteps }: MissionDetailPlanProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {planSteps.map((step, i) => {
        const isActive = step.state === 'in_progress';
        return (
          <div
            key={i}
            style={{
              display: 'flex',
              gap: 10,
              padding: '8px 10px',
              borderRadius: 7,
              marginBottom: 2,
              position: 'relative',
              background: isActive ? 'rgba(124,92,255,0.07)' : 'transparent',
              borderLeft: isActive ? '2px solid #7C5CFF' : '2px solid transparent',
            }}
          >
            <div style={{ paddingTop: 1 }}>
              <StepIcon state={step.state} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: step.state === 'todo' ? 400 : 500,
                  color:
                    step.state === 'done'
                      ? 'rgba(255,255,255,0.45)'
                      : step.state === 'in_progress'
                      ? '#E2E2F0'
                      : 'rgba(255,255,255,0.55)',
                  textDecoration: step.state === 'done' ? 'line-through' : 'none',
                  lineHeight: 1.35,
                }}
              >
                {step.label}
              </div>
              {step.meta && (
                <div
                  style={{
                    fontSize: 10,
                    color: isActive ? '#C4B5FD' : 'rgba(255,255,255,0.28)',
                    marginTop: 2,
                    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                  }}
                >
                  {step.meta}
                </div>
              )}
              {/* No per-step progress fraction exists anywhere in the system today
                  (PlanStep / StageContract only carry `state`, not a numeric
                  progress value) — so we show the in-progress spinner icon only
                  and do not fabricate a sub-progress bar. */}
            </div>
          </div>
        );
      })}
    </div>
  );
}
