/* MissionReportCard.tsx — one completed mission's card in the Rapport page:
   title (opens MissionDetail via onOpenMission), terminal badge, duration/
   cost/tokens chips with tokensSource honesty, chain-fire mentions, and the
   artifact gallery.
*/

import { memo } from 'react';
import { useI18n } from '../../../i18n';
import type { CompletedMissionReport } from '../../../lib/journal/projectReport';
import { ArtifactGallery } from './ArtifactGallery';
import { usdToCredits } from '../../../lib/billing/credits';

interface MissionReportCardProps {
  mission: CompletedMissionReport;
  onOpenMission: (missionId: string) => void;
}

function Chip({ label, value, 'data-testid': testId }: { label: string; value: string; 'data-testid'?: string }) {
  return (
    <div
      data-testid={testId}
      style={{
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 6,
        padding: '5px 9px',
      }}
    >
      <span
        style={{
          fontSize: 9.5,
          color: 'var(--color-text-disabled)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginRight: 6,
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)' }}>{value}</span>
    </div>
  );
}

export const MissionReportCard = memo(function MissionReportCard({ mission, onOpenMission }: MissionReportCardProps) {
  const { t } = useI18n();
  const isApproved = mission.terminalType === 'mission.approved';
  const isEstimated = mission.tokensSource === 'estimated' || mission.tokensSource === 'mixed';
  // Cost-honesty wave: native claude-code/codex CLI missions report an exact
  // API-list-price EQUIVALENT of their real tokens, never an amount Lazy
  // actually billed (see CompletedMissionReport.costIsApiEquivalent's doc
  // comment) — flagged only when there is a real cost figure to qualify.
  const isApiEquivalent = mission.costUsd > 0 && mission.costIsApiEquivalent === true;

  const durationLabel = mission.durationMs !== null ? `${(mission.durationMs / 1000).toFixed(0)}s` : '—';
  // Fix D (2026-08-19 dollar-kill incident, display half) — credits, never
  // a dollar figure (usdToCredits — the same conversion every other
  // real-spend display in this app shares). The isApiEquivalent badge below
  // already flags native-rail missions; the chip itself now ALSO prefixes
  // "≈" for that case so the figure reads as a non-debited equivalent even
  // if the badge scrolls out of view.
  const costLabel = mission.costUsd > 0 ? `${isApiEquivalent ? '≈' : ''}${usdToCredits(mission.costUsd).toLocaleString()} ${t('canvas.node.creditsUnit')}` : '—';
  const tokensInLabel = mission.tokensIn > 0 ? mission.tokensIn.toLocaleString() : '—';
  const tokensOutLabel = mission.tokensOut > 0 ? mission.tokensOut.toLocaleString() : '—';
  // M12 dogfood fix (undercount honesty): tokensIn never included
  // prompt-cache READ tokens (see CompletedMissionReport.cacheReadInputTokens's
  // doc comment) — when that figure was never recorded, the label says so
  // explicitly instead of silently implying tokensIn is the mission's whole
  // input volume; when it WAS recorded, an extra chip surfaces it.
  const tokensInHasCacheData = mission.cacheReadInputTokens !== null;
  const tokensInChipLabel = tokensInHasCacheData ? t('report.mission.tokensIn') : t('report.mission.tokensInNoCache');
  const cacheReadTokensLabel =
    mission.cacheReadInputTokens !== null && mission.cacheReadInputTokens > 0
      ? mission.cacheReadInputTokens.toLocaleString()
      : null;

  return (
    <div
      data-testid={`mission-report-card-${mission.missionId}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        background: 'var(--color-panel)',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
        padding: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <button
          data-testid={`mission-report-open-${mission.missionId}`}
          onClick={() => onOpenMission(mission.missionId)}
          title={mission.title ?? mission.missionId}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            textAlign: 'left',
            padding: 0,
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--color-text)',
            fontFamily: 'inherit',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
            minWidth: 0,
          }}
        >
          {mission.title ?? mission.missionId}
        </button>
        <span
          data-testid="mission-report-terminal-badge"
          style={{
            flexShrink: 0,
            fontSize: 10,
            fontWeight: 700,
            padding: '2px 8px',
            borderRadius: 999,
            background: isApproved ? 'rgba(124,92,255,0.12)' : 'rgba(34,197,94,0.12)',
            border: `1px solid ${isApproved ? 'var(--color-accent-border)' : 'var(--color-success-border)'}`,
            color: isApproved ? 'var(--color-accent-light)' : 'var(--color-success)',
          }}
        >
          {isApproved ? t('report.mission.terminalApproved') : t('report.mission.terminalCompleted')}
        </span>
        {/* W-MODES-ui safety legibility — mirrors the FLUX ticker's own
            "(auto)" line (activityFeedFormat.ts's humanizeActivityItem):
            CompletedMissionReport.autoMerged (projectReport.ts, set from
            the same mission.approved payload.actor === 'auto') was landed
            by the engine wave but never surfaced anywhere in the Rapport
            page until now — an unattended merge must read as unattended
            here too, not just in the live ticker. */}
        {isApproved && mission.autoMerged && (
          <span
            data-testid="mission-report-auto-merged-badge"
            title={t('report.mission.autoMergedTitle')}
            style={{
              flexShrink: 0,
              fontSize: 10,
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: 999,
              background: 'color-mix(in srgb, var(--color-warning) 18%, transparent)',
              border: '1px solid color-mix(in srgb, var(--color-warning) 50%, transparent)',
              color: 'var(--color-warning)',
            }}
          >
            {t('report.mission.autoMergedBadge')}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Chip label={t('report.mission.duration')} value={durationLabel} />
        <Chip label={t('report.mission.cost')} value={costLabel} />
        <Chip label={tokensInChipLabel} value={tokensInLabel} />
        <Chip label={t('report.mission.tokensOut')} value={tokensOutLabel} />
        {cacheReadTokensLabel && (
          <Chip data-testid="mission-report-cache-tokens" label={t('report.mission.cacheReadTokens')} value={cacheReadTokensLabel} />
        )}
        {isEstimated && (
          <span
            data-testid="mission-report-estimated-badge"
            style={{
              fontSize: 9,
              padding: '2px 7px',
              borderRadius: 4,
              color: 'var(--color-warning)',
              background: 'rgba(251,185,36,0.12)',
              border: '1px solid rgba(251,185,36,0.3)',
              fontWeight: 600,
            }}
          >
            {t('report.mission.estimatedBadge')}
          </span>
        )}
        {isApiEquivalent && (
          <span
            data-testid="mission-report-api-equivalent-badge"
            title={t('report.mission.apiEquivalentTitle')}
            style={{
              fontSize: 9,
              padding: '2px 7px',
              borderRadius: 4,
              color: 'var(--color-text-muted)',
              background: 'var(--color-panel-3)',
              border: '1px solid var(--color-border-3)',
              fontWeight: 600,
            }}
          >
            {t('report.mission.apiEquivalentBadge')}
          </span>
        )}
      </div>

      {mission.chainFires.length > 0 && (
        <div data-testid="mission-report-chain-fires" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {mission.chainFires.map((fire, i) => (
            <div key={i} style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
              {fire.sourceMissionId === mission.missionId
                ? t('report.mission.chainFiredTarget', { ref: fire.targetRef })
                : t('report.mission.chainFiredBy', { id: fire.sourceMissionId })}
            </div>
          ))}
        </div>
      )}

      <ArtifactGallery artifacts={mission.artifacts} />
    </div>
  );
});
