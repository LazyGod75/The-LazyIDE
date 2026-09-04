/* ArtifactChip.tsx — chip rendering for `test_run` / `command_output` /
   `e2e_recording` proof artifacts. test_run/command_output are clickable —
   opening ArtifactOutputModal on their outputPath; e2e_recording is a
   static file chip (no player, per this wave's spec).
*/

import { useState } from 'react';
import { useI18n } from '../../../i18n';
import type { ProofArtifact } from '../../../lib/agents/types';
import { UNKNOWN_EXIT_CODE } from '../../../lib/agents/proofs';
import { ArtifactOutputModal } from './ArtifactOutputModal';

type ChipArtifact = Extract<ProofArtifact, { kind: 'test_run' | 'command_output' | 'e2e_recording' }>;

interface ArtifactChipProps {
  artifact: ChipArtifact;
}

const chipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '5px 10px',
  borderRadius: 6,
  border: '1px solid var(--color-border)',
  background: 'var(--color-panel-2)',
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  maxWidth: 320,
};

export function ArtifactChip({ artifact }: ArtifactChipProps) {
  const { t } = useI18n();
  const [modalOpen, setModalOpen] = useState(false);

  if (artifact.kind === 'e2e_recording') {
    return (
      <div data-testid="artifact-chip-e2e_recording" style={chipStyle} title={artifact.path}>
        <span style={{ color: 'var(--color-cluster-ui)', fontWeight: 600 }}>{t('report.artifact.e2eRecording')}</span>
        <span
          style={{
            color: 'var(--color-text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {artifact.path}
        </span>
      </div>
    );
  }

  const isTestRun = artifact.kind === 'test_run';
  const exitCode = isTestRun ? artifact.exitCode : null;
  const exitColor =
    exitCode === null || exitCode === UNKNOWN_EXIT_CODE
      ? 'var(--color-text-disabled)'
      : exitCode === 0
      ? 'var(--color-success)'
      : 'var(--color-danger)';

  return (
    <>
      <button
        data-testid={`artifact-chip-${artifact.kind}`}
        onClick={() => setModalOpen(true)}
        title={artifact.command}
        style={{ ...chipStyle, cursor: 'pointer' }}
      >
        <span style={{ color: 'var(--color-text-secondary)', fontWeight: 600 }}>
          {isTestRun ? t('report.artifact.testRun') : t('report.artifact.commandOutput')}
        </span>
        <span
          style={{
            color: 'var(--color-text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: 160,
          }}
        >
          {artifact.command}
        </span>
        {isTestRun && (
          <span style={{ color: exitColor, fontWeight: 700, flexShrink: 0 }}>
            {exitCode === UNKNOWN_EXIT_CODE ? t('report.artifact.exitUnknown') : t('report.artifact.exitCode', { code: String(exitCode) })}
          </span>
        )}
      </button>
      {modalOpen && (
        <ArtifactOutputModal title={artifact.command} path={artifact.outputPath} onClose={() => setModalOpen(false)} />
      )}
    </>
  );
}
