/* RunHistoryDrawer.tsx — run-history content for MissionDetail's "Historique"
   section (Agent Canvas W8b). Wired ONLY as (a) a MissionDetail section (see
   MissionDetail.tsx's Section title={t('canvas.history.sectionTitle')} call
   site) — NOT as a standalone floating drawer/modal, despite the filename
   (kept per the wave's own naming). The keyboard 'H' shortcut and a canvas
   context-menu entry that would also open straight to this section are left
   as wiring gaps for the orchestrator (useCanvasKeyboard.ts / CanvasContextMenu.tsx
   belong to other waves' writable sets this wave must not touch).

   Renders, for the CURRENTLY VIEWED mission id (`mission.id` initially; see
   the "Missions passées" archive below for how that can change):
     - StageGantt: the primary run's stage spans, plus up to 3 loop-iteration
       comparison rows when `mission.loopConfig` exists.
     - a compact event-log timeline (time, category-colored type, a generic
       best-effort payload summary — see eventSummary.ts).
     - chain fires (source -> target, kind).
     - totals (duration/tokens/cost) — journal-derived numbers first (works
       even for an archived mission with no live Mission object), falling
       back to the live mission's own agentMetrics ONLY while still viewing
       the live mission (an archived mission has no Mission object to fall
       back to).
     - "Missions passées": every mission the journal remembers for this
       project (useProjectRunArchive), including ones pruned from the live
       canvas — clicking one loads ITS history into this same view.
*/

import { useEffect, useMemo, useState } from 'react';
import type { Mission } from '../../../../lib/agents/types';
import { useI18n } from '../../../../i18n';
import { useMissionRunHistory, useProjectRunArchive } from '../../../../lib/journal/useMissionHistory';
import { projectIdFromRoot } from '../../../../lib/journal/projectId';
import { resolveProjectRoot } from '../../agentsStore';
import { StageGantt, type StageGanttRow } from './StageGantt';
import { eventCategoryColor, eventTimeLabel, summarizePayload } from './eventSummary';
import { classifyMissionModel } from '../../../../lib/agents/runtime';
import { usdToCredits } from '../../../../lib/billing/credits';

const MAX_TIMELINE_ROWS = 100;

interface RunHistoryDrawerProps {
  mission: Mission;
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 6,
        padding: '7px 10px',
        minWidth: 90,
      }}
    >
      <div style={{ fontSize: 10, color: 'var(--color-text-disabled)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div style={{ fontSize: 13, color: value === '—' ? 'var(--color-text-ghost)' : 'var(--color-text)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
        {value}
      </div>
    </div>
  );
}

/** Resolves the active project's id (mirrors agentsStore.tsx's own
 *  `resolveProjectRoot().then(root => projectIdFromRoot(root))` pattern used
 *  throughout that module) — needed for the "Missions passées" archive
 *  query, which MissionDetail itself has no synchronous projectId for.
 *  LAZY by design (`enabled` stays false until the archive <details> is
 *  actually expanded): no project-wide journal scan on every MissionDetail
 *  open, and no resolveProjectRoot call racing the ones MissionDetail's own
 *  click handlers (handleRunReview et al.) fire — two concurrent
 *  `await import('@tauri-apps/api/core')` calls inside resolveProjectRoot
 *  intermittently crash vitest's mocked dynamic-import path ("Cannot read
 *  properties of undefined (reading 'invoke')"), which broke MissionDetail's
 *  pre-existing repoPath regression suites when this hook ran at mount. */
function useActiveProjectId(enabled: boolean): string | null {
  const [projectId, setProjectId] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void resolveProjectRoot()
      .then((root) => {
        if (!cancelled) setProjectId(projectIdFromRoot(root));
      })
      .catch(() => {
        if (!cancelled) setProjectId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return projectId;
}

export function RunHistoryDrawer({ mission }: RunHistoryDrawerProps) {
  const { t } = useI18n();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const projectId = useActiveProjectId(archiveOpen);
  // Archive selection is KEYED to the mission it was made for and derived at
  // render time — opening a different mission's detail automatically snaps
  // back to viewing IT live (the stale selection no longer matches), without
  // a sync setState-in-effect reset.
  const [archiveSelection, setArchiveSelection] = useState<{ forMissionId: string; viewId: string } | null>(null);
  const viewMissionId = archiveSelection?.forMissionId === mission.id ? archiveSelection.viewId : mission.id;

  const isViewingLive = viewMissionId === mission.id;
  const iterationIds = useMemo(
    () => (isViewingLive ? mission.loopConfig?.iterationMissionIds.slice(-3) ?? [] : []),
    [isViewingLive, mission.loopConfig],
  );

  const { primary, comparisons } = useMissionRunHistory(viewMissionId, iterationIds);
  const { entries: archive, loading: archiveLoading } = useProjectRunArchive(projectId);

  // Mission ids get RECYCLED across unrelated runs (see missionHistory.ts's
  // header) — buildProjectArchive now emits one row per (missionId,
  // generation), so `archive` can legitimately contain TWO rows sharing the
  // same missionId. useMissionRunHistory(viewMissionId) has no way to view a
  // SPECIFIC past generation of a recycled id — it always resolves to that
  // id's CURRENT generation — so clicking an OLDER generation's row would
  // misleadingly load the wrong (current) run. This map identifies which
  // generation is current per id so only THAT row stays clickable; an older
  // generation renders as a read-only, honestly-labelled historical entry
  // instead (see the "Missions passées" section below).
  const currentGenerationByMissionId = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of archive) {
      const known = map.get(entry.missionId);
      if (known === undefined || entry.generation > known) map.set(entry.missionId, entry.generation);
    }
    return map;
  }, [archive]);

  const ganttRows: StageGanttRow[] = useMemo(() => {
    const rows: StageGanttRow[] = [];
    if (primary) rows.push({ id: primary.missionId, label: t('canvas.history.ganttPrimaryLabel'), spans: primary.stageSpans });
    comparisons.forEach((c, i) => rows.push({ id: c.missionId, label: t('canvas.history.ganttIterationLabel', { n: String(i + 1) }), spans: c.stageSpans }));
    return rows;
  }, [primary, comparisons, t]);

  const fallbackMetrics = isViewingLive ? mission.agentMetrics : undefined;
  const durationMs = primary?.durationMs ?? fallbackMetrics?.durationMs ?? null;
  const tokensKnown = primary && primary.tokens.source !== 'unknown';
  const tokensIn = tokensKnown ? primary!.tokens.tokensIn : fallbackMetrics?.inputTokens ?? null;
  const tokensOut = tokensKnown ? primary!.tokens.tokensOut : fallbackMetrics?.outputTokens ?? null;
  const costUsd = tokensKnown ? primary!.tokens.costUsd : fallbackMetrics?.costUsd ?? null;
  // Fix D (2026-08-19 dollar-kill incident, display half) — same rail
  // classification runtime.ts dispatched this mission through; credits
  // everywhere (usdToCredits), never a dollar figure, with the native
  // rail's number marked as a non-debited equivalent (same convention as
  // CostChip.tsx/MissionNode.tsx/DataInspector.tsx).
  const isNativeRail = classifyMissionModel(mission.model) === 'native';
  const costLabel =
    costUsd !== null && costUsd > 0
      ? `${isNativeRail ? '≈' : ''}${usdToCredits(costUsd).toLocaleString()} ${t('canvas.node.creditsUnit')}${isNativeRail ? ` (${t('canvas.node.costNoDebit')})` : ''}`
      : '—';

  const timelineRows = primary ? primary.events.slice(-MAX_TIMELINE_ROWS) : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {!isViewingLive && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--color-warning)' }}>
          <span>{t('canvas.history.archiveViewing', { id: viewMissionId })}</span>
          <button
            data-testid="history-back-to-live"
            onClick={() => setArchiveSelection(null)}
            style={{ background: 'none', border: '1px solid var(--color-border)', borderRadius: 5, color: 'var(--color-accent-light)', fontSize: 11, padding: '2px 8px', cursor: 'pointer', fontFamily: 'inherit' }}
          >
            {t('canvas.history.archiveBackToLive')}
          </button>
        </div>
      )}

      <StageGantt rows={ganttRows} />

      {/* Totals */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-disabled)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
          {t('canvas.history.totalsTitle')}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Chip label={t('agents.detail.metricDuration')} value={durationMs !== null ? `${(durationMs / 1000).toFixed(1)}s` : '—'} />
          <Chip label={t('agents.detail.metricTokensIn')} value={tokensIn !== null && tokensIn > 0 ? tokensIn.toLocaleString() : '—'} />
          <Chip label={t('agents.detail.metricTokensOut')} value={tokensOut !== null && tokensOut > 0 ? tokensOut.toLocaleString() : '—'} />
          <Chip label={t('agents.detail.metricCost')} value={costLabel} />
        </div>
      </div>

      {/* Compact event timeline */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-disabled)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
          {t('canvas.history.eventsTitle')}
        </div>
        {timelineRows.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--color-text-disabled)' }}>{t('canvas.history.eventsEmpty')}</div>
        ) : (
          <div style={{ background: 'var(--color-panel-3)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '6px 10px', maxHeight: 260, overflowY: 'auto' }} data-testid="history-event-log">
            {timelineRows.map((row) => {
              const summary = summarizePayload(row.payload);
              return (
                <div key={row.seq} style={{ display: 'flex', gap: 8, padding: '4px 0', fontSize: 11.5, alignItems: 'baseline' }}>
                  <span style={{ color: 'var(--color-text-disabled)', fontFamily: 'var(--font-mono)', width: 36, flexShrink: 0 }}>{eventTimeLabel(row)}</span>
                  <span style={{ color: eventCategoryColor(row.type), fontFamily: 'var(--font-mono)', fontWeight: 600, flexShrink: 0 }}>{row.type}</span>
                  {summary && <span style={{ color: 'var(--color-text-muted)' }}>{summary}</span>}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Chain fires */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-disabled)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
          {t('canvas.history.chainFiresTitle')}
        </div>
        {!primary || primary.chainFires.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--color-text-disabled)' }}>{t('canvas.history.chainFiresEmpty')}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-testid="history-chain-fires">
            {primary.chainFires.map((fire, i) => (
              <div key={i} style={{ fontSize: 11.5, color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>
                {fire.sourceMissionId} {'->'} {fire.targetRef}{' '}
                <span style={{ color: 'var(--color-cluster-ui)' }}>
                  (
                  {fire.kind === 'fired'
                    ? t('canvas.history.chainFired')
                    : fire.kind === 'resumed'
                    ? t('canvas.history.chainResumed')
                    : t('canvas.history.chainPending')}
                  )
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Générations précédentes — MAJEUR fix: mission ids get recycled
          across unrelated runs (see missionHistory.ts's header), so the
          CURRENT generation's Gantt/totals/timeline above never blend in an
          older run of the same id — that older run is instead listed here,
          honestly separated, collapsed by default. Empty (id never reused)
          renders nothing at all. */}
      {primary && primary.previousGenerations.length > 0 && (
        <details data-testid="history-previous-generations">
          <summary style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-disabled)', letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer' }}>
            {t('canvas.history.previousGenerationsTitle')} ({primary.previousGenerations.length})
          </summary>
          <div style={{ marginTop: 6, marginBottom: 2, fontSize: 10.5, color: 'var(--color-text-disabled)' }}>
            {t('canvas.history.previousGenerationsHint')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
            {primary.previousGenerations.map((gen) => (
              <div
                key={gen.generation}
                data-testid={`history-previous-generation-${gen.generation}`}
                style={{ display: 'flex', justifyContent: 'space-between', gap: 8, borderRadius: 5, padding: '5px 8px', fontSize: 11.5, color: 'var(--color-text-secondary)' }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {gen.title ?? primary.missionId}
                </span>
                <span style={{ color: 'var(--color-text-disabled)', flexShrink: 0, fontFamily: 'var(--font-mono)' }}>
                  {gen.terminalType ?? '…'}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Missions passées — project archive (loaded lazily on first expand,
          see useActiveProjectId's doc comment) */}
      <details
        data-testid="history-archive"
        onToggle={(e) => {
          if ((e.currentTarget as HTMLDetailsElement).open) setArchiveOpen(true);
        }}
      >
        <summary style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-disabled)', letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer' }}>
          {t('canvas.history.archiveTitle')}
        </summary>
        <div style={{ marginTop: 8 }}>
          {archiveLoading ? (
            <div style={{ fontSize: 12, color: 'var(--color-text-disabled)' }}>{t('common.loading')}</div>
          ) : archive.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--color-text-disabled)' }}>{t('canvas.history.archiveEmpty')}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 220, overflowY: 'auto' }}>
              {archive.map((entry) => {
                // Two rows CAN share missionId (a recycled id — see the memo
                // above) — key/testid must include generation to stay unique.
                const rowKey = `${entry.missionId}-${entry.generation}`;
                const isCurrentGeneration = currentGenerationByMissionId.get(entry.missionId) === entry.generation;
                const label = (
                  <>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {entry.missionId}
                      {entry.title ? ` — ${entry.title}` : ''}
                    </span>
                    <span style={{ color: 'var(--color-text-disabled)', flexShrink: 0, fontFamily: 'var(--font-mono)' }}>
                      {isCurrentGeneration ? entry.terminalType ?? '…' : t('canvas.history.archiveOlderGeneration')}
                    </span>
                  </>
                );

                if (!isCurrentGeneration) {
                  // A superseded generation of a recycled id: honestly
                  // read-only — the underlying hook can only ever load an
                  // id's CURRENT generation, so a click here would silently
                  // show the WRONG (current) run instead of this historical
                  // one. See previousGenerations below for this same data
                  // surfaced against the mission actually being viewed.
                  return (
                    <div
                      key={rowKey}
                      data-testid={`history-archive-row-${rowKey}`}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 8,
                        borderRadius: 5,
                        padding: '5px 8px',
                        fontSize: 11.5,
                        color: 'var(--color-text-disabled)',
                        fontFamily: 'inherit',
                        opacity: 0.7,
                      }}
                    >
                      {label}
                    </div>
                  );
                }

                return (
                  <button
                    key={rowKey}
                    data-testid={`history-archive-row-${rowKey}`}
                    onClick={() => setArchiveSelection({ forMissionId: mission.id, viewId: entry.missionId })}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 8,
                      background: entry.missionId === viewMissionId ? 'var(--color-accent-soft)' : 'transparent',
                      border: 'none',
                      borderRadius: 5,
                      padding: '5px 8px',
                      fontSize: 11.5,
                      color: 'var(--color-text-secondary)',
                      textAlign: 'left',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
