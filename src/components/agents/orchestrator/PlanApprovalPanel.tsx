/* PlanApprovalPanel.tsx — Approve/revise/reject a generated plan (Pillar E7).

   Reviewer surface uses the same design tokens as Team/Cockpit (not
   leftover Tailwind `bg-green-700` utilities). Each step's meta line is
   built from real OrchestratorPlanStep fields only — never fabricated.
   Git diffs are loaded from the worktree when present; empty/error is
   omitted (never invented hunks).

   Plan-mode: Approve is a two-click confirm (review → confirm
   execution) so a full-plan gate cannot fire from a single misclick.
*/

import { useEffect, useState, type CSSProperties } from 'react';
import type { OrchestratorPlanStep, OrchestratorState } from '../../../lib/agents/types';
import {
  planConfirmSummary,
  planCostRollup,
  stepMetaLine,
  stepScopeLine,
} from '../../../lib/agents/planApprovalMeta';
import { loadPlanScopeDiffs } from '../../../lib/agents/planScopeDiffs';

export interface PlanApprovalPanelProps {
  orchestrator: OrchestratorState;
  onApprove: () => void;
  onRevise: () => void;
  onReject: () => void;
  /** Real git_diff for declared scopePaths. Absent → no diff row (honest). */
  loadFileDiff?: (path: string) => Promise<string>;
}

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: 16,
  background: 'var(--color-panel)',
  border: '1px solid var(--color-border)',
  borderRadius: 12,
};

const btnBase: CSSProperties = {
  padding: '6px 12px',
  fontSize: 12,
  fontWeight: 650,
  borderRadius: 8,
  cursor: 'pointer',
  fontFamily: 'inherit',
  border: '1px solid transparent',
};

function approveStyle(): CSSProperties {
  return {
    ...btnBase,
    background: 'var(--color-success-soft)',
    color: 'var(--color-success-text)',
    borderColor: 'var(--color-success-border)',
  };
}

function PlanStepDiffPreview({
  stepId,
  paths,
  loadFileDiff,
}: {
  stepId: string;
  paths: string[];
  loadFileDiff: (path: string) => Promise<string>;
}) {
  const [diff, setDiff] = useState<string | null>(null);
  const pathKey = paths.join('\0');
  useEffect(() => {
    let cancelled = false;
    void loadPlanScopeDiffs(pathKey ? pathKey.split('\0') : [], loadFileDiff).then((text) => {
      if (!cancelled) setDiff(text);
    });
    return () => { cancelled = true; };
  }, [pathKey, loadFileDiff]);
  if (!diff) return null;
  return (
    <pre
      data-testid={`plan-approval-step-diff-${stepId}`}
      style={{
        display: 'block',
        margin: '4px 0 0',
        padding: 8,
        maxHeight: 120,
        overflow: 'auto',
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        color: 'var(--color-text-muted)',
        background: 'var(--color-panel-2)',
        borderRadius: 6,
        whiteSpace: 'pre-wrap',
      }}
    >
      {diff}
    </pre>
  );
}

function PlanStepRow({
  step,
  index,
  stepById,
  loadFileDiff,
}: {
  step: OrchestratorPlanStep;
  index: number;
  stepById: ReadonlyMap<string, number>;
  loadFileDiff?: (path: string) => Promise<string>;
}) {
  const meta = stepMetaLine(step, stepById);
  const scope = stepScopeLine(step);
  const paths = step.scopePaths?.filter((p) => p.trim().length > 0) ?? [];
  return (
    <li style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
      <span style={{ color: 'var(--color-text)' }}>#{index + 1} {step.description}</span>
      {meta && (
        <span
          style={{ display: 'block', color: 'var(--color-text-muted)', marginTop: 2 }}
          data-testid={`plan-approval-step-meta-${step.id}`}
        >
          {meta}
        </span>
      )}
      {scope && (
        <span
          style={{ display: 'block', color: 'var(--color-text-muted)', marginTop: 2, fontFamily: 'var(--font-mono)', fontSize: 11 }}
          data-testid={`plan-approval-step-scope-${step.id}`}
        >
          {scope}
        </span>
      )}
      {loadFileDiff && paths.length > 0 && (
        <PlanStepDiffPreview stepId={step.id} paths={paths} loadFileDiff={loadFileDiff} />
      )}
    </li>
  );
}

export function PlanApprovalPanel({
  orchestrator,
  onApprove,
  onRevise,
  onReject,
  loadFileDiff,
}: PlanApprovalPanelProps) {
  const [confirming, setConfirming] = useState(false);
  const stepById = new Map(orchestrator.steps.map((s, i) => [s.id, i] as const));
  const rollup = planCostRollup(orchestrator.steps);

  return (
    <div data-testid="plan-approval-panel" style={panelStyle}>
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 650, color: 'var(--color-text)' }}>
        Plan: {orchestrator.name}
      </h3>
      <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-muted)' }}>{orchestrator.objective}</p>
      <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {orchestrator.steps.map((s, i) => (
          <PlanStepRow
            key={s.id}
            step={s}
            index={i}
            stepById={stepById}
            loadFileDiff={loadFileDiff}
          />
        ))}
      </ol>
      {confirming ? (
        <div data-testid="plan-approval-confirm-box" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p
            data-testid="plan-approval-confirm-summary"
            style={{ margin: 0, fontSize: 12, color: 'var(--color-text-secondary)' }}
          >
            {planConfirmSummary(rollup)}
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              data-testid="plan-approval-confirm"
              style={approveStyle()}
              onClick={onApprove}
            >
              Confirm
            </button>
            <button
              type="button"
              data-testid="plan-approval-back"
              style={{ ...btnBase, background: 'var(--color-panel-2)', color: 'var(--color-text)', borderColor: 'var(--color-border)' }}
              onClick={() => setConfirming(false)}
            >
              Back
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            data-testid="plan-approval-approve"
            style={approveStyle()}
            onClick={() => setConfirming(true)}
          >
            Approve
          </button>
          <button
            type="button"
            data-testid="plan-approval-revise"
            style={{ ...btnBase, background: 'var(--color-panel-2)', color: 'var(--color-warning-text)', borderColor: 'var(--color-border)' }}
            onClick={onRevise}
          >
            Revise
          </button>
          <button
            type="button"
            data-testid="plan-approval-reject"
            style={{ ...btnBase, background: 'transparent', color: 'var(--color-danger-text)', borderColor: 'var(--color-border)' }}
            onClick={onReject}
          >
            Reject
          </button>
        </div>
      )}
    </div>
  );
}
