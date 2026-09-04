/* BehaviorDiffPanel.tsx — two-column before/after rendering for a
   `behavior_diff` proof artifact. */

import { useI18n } from '../../../i18n';
import type { ProofArtifact } from '../../../lib/agents/types';

interface BehaviorDiffPanelProps {
  artifact: Extract<ProofArtifact, { kind: 'behavior_diff' }>;
}

const colStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: 'var(--color-panel-3)',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  padding: '8px 10px',
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  color: 'var(--color-text-secondary)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 200,
  overflowY: 'auto',
};

export function BehaviorDiffPanel({ artifact }: BehaviorDiffPanelProps) {
  const { t } = useI18n();
  return (
    <div data-testid="artifact-behavior_diff" style={{ display: 'flex', gap: 10, width: '100%' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: 'var(--color-text-disabled)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginBottom: 4,
          }}
        >
          {t('report.artifact.diffBefore')}
        </div>
        <div style={colStyle}>{artifact.before}</div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: 'var(--color-text-disabled)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginBottom: 4,
          }}
        >
          {t('report.artifact.diffAfter')}
        </div>
        <div style={colStyle}>{artifact.after}</div>
      </div>
    </div>
  );
}
