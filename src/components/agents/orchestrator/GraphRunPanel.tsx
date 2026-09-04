/* GraphRunPanel.tsx — Live SGR run debugger (wave status, cost, brain cites).

   Currency-leak fix (real user report, 2026-08-14): per-node and total run
   cost used to render as `$X.XXX` — this app's standing rule is credits,
   never currency, for cost-of-work figures (the same "$0.07" pattern was
   already removed from mission cards for this reason). `costUsd`/
   `totalCostUsd` are USD, so this converts dollars to their cent-equivalent
   (a unit conversion, not an invented exchange rate) before formatting as
   credits, matching this codebase's established `credits_remaining_cents`
   convention (lib/billing/credits.ts). */

import type { RunDebugSnapshot, NodeDebugInfo } from '../../../lib/agents/graph/graphDebugView';
import type { GraphRun } from '../../../lib/agents/graph/types';
import { formatCredits } from '../../../lib/billing';
import { useI18n } from '../../../i18n';

/** USD -> credits: a plain unit conversion (dollars to their cent-
 *  equivalent), not a currency exchange rate — see this file's header
 *  comment. */
function creditsFromUsd(usd: number): number {
  return Math.round(usd * 100);
}

export interface GraphRunPanelProps {
  run: GraphRun | null;
  snapshot: RunDebugSnapshot | null;
}

const STATUS_COLOR: Record<string, string> = {
  pending: 'var(--color-text-muted)',
  ready: 'var(--color-accent-light)',
  running: 'var(--color-warning)',
  done: 'var(--color-success)',
  failed: 'var(--color-danger)',
  blocked: 'var(--color-warning)',
  skipped: 'var(--color-text-disabled)',
  interrupted: 'var(--color-accent)',
  cancelled: 'var(--color-text-muted)',
};

function statusDot(status: string) {
  const color = STATUS_COLOR[status] ?? 'var(--color-text-muted)';
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: 7,
        height: 7,
        borderRadius: 99,
        background: color,
        boxShadow: `0 0 0 2px ${color}`,
        marginRight: 8,
        flexShrink: 0,
        opacity: 0.9,
      }}
    />
  );
}

function NodeRow({ node }: { node: NodeDebugInfo }) {
  return (
    <div
      data-testid={`graph-run-node-${node.nodeId}`}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '8px 10px',
        borderRadius: 8,
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border-2)',
      }}
    >
      <div style={{ paddingTop: 4 }}>{statusDot(node.status)}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text)' }}>
            {node.label}
          </span>
          <span style={{ fontSize: 10, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {node.kind}
          </span>
          <span style={{ fontSize: 10, color: STATUS_COLOR[node.status] ?? 'var(--color-text-secondary)' }}>
            {node.status}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 4, fontSize: 10, color: 'var(--color-text-muted)' }}>
          {node.missionCount > 0 && <span>{node.missionCount} mission{node.missionCount > 1 ? 's' : ''}</span>}
          {node.attempt > 0 && <span>try {node.attempt}</span>}
          {node.costUsd !== undefined && node.costUsd > 0 && <span>{formatCredits(creditsFromUsd(node.costUsd))} credits</span>}
          {node.durationMs !== undefined && <span>{(node.durationMs / 1000).toFixed(1)}s</span>}
          {node.brainNoteIds && node.brainNoteIds.length > 0 && (
            <span title={node.brainNoteIds.join(', ')}>brain ×{node.brainNoteIds.length}</span>
          )}
        </div>
        {node.errorMessage && (
          <div style={{ marginTop: 4, fontSize: 11, color: 'var(--color-danger-text)', lineHeight: 1.35 }}>
            {node.errorMessage.slice(0, 180)}
          </div>
        )}
      </div>
    </div>
  );
}

export function GraphRunPanel({ run, snapshot }: GraphRunPanelProps) {
  const { t } = useI18n();
  if (!run || !snapshot) {
    return (
      <div
        data-testid="graph-run-panel-empty"
        style={{
          padding: '12px 14px',
          fontSize: 12,
          color: 'var(--color-text-muted)',
          borderRadius: 10,
          border: '1px dashed var(--color-border)',
        }}
      >
        {t('cockpit.graphRun.empty')}
      </div>
    );
  }

  const progress =
    snapshot.totalNodes > 0
      ? Math.round(((snapshot.doneCount + snapshot.failedCount) / snapshot.totalNodes) * 100)
      : 0;

  return (
    <div
      data-testid="graph-run-panel"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 12,
        borderRadius: 12,
        background: 'var(--color-panel)',
        border: '1px solid var(--color-border)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>
            Graph run
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2, fontFamily: 'ui-monospace, monospace' }}>
            {run.runId.slice(0, 18)}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {statusDot(snapshot.status)}
          <span style={{ fontSize: 12, fontWeight: 600, color: STATUS_COLOR[snapshot.status] ?? 'var(--color-text)' }}>
            {snapshot.status}
          </span>
        </div>
      </div>

      <div
        style={{
          height: 4,
          borderRadius: 99,
          background: 'var(--color-border-2)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${progress}%`,
            height: '100%',
            background:
              snapshot.failedCount > 0
                ? 'linear-gradient(90deg, var(--color-warning), var(--color-danger))'
                : 'linear-gradient(90deg, var(--color-accent), var(--color-success))',
            transition: 'width 200ms ease',
          }}
        />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
          gap: 6,
          fontSize: 10,
          color: 'var(--color-text-muted)',
        }}
      >
        <div><strong style={{ color: 'var(--color-success)' }}>{snapshot.doneCount}</strong> done</div>
        <div><strong style={{ color: 'var(--color-warning)' }}>{snapshot.runningCount}</strong> run</div>
        <div><strong style={{ color: 'var(--color-danger)' }}>{snapshot.failedCount}</strong> fail</div>
        <div><strong style={{ color: 'var(--color-warning)' }}>{snapshot.blockedCount}</strong> block</div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--color-text-muted)' }}>
        <span>{snapshot.totalMissions} missions</span>
        <span>{formatCredits(creditsFromUsd(snapshot.totalCostUsd))} credits</span>
        {run.nodeOutputs && Object.keys(run.nodeOutputs).length > 0 && (
          <span title="Nodes with structured outputs">{Object.keys(run.nodeOutputs).length} outputs</span>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 280, overflow: 'auto' }}>
        {snapshot.nodes.map((n) => (
          <NodeRow key={n.nodeId} node={n} />
        ))}
      </div>
    </div>
  );
}
