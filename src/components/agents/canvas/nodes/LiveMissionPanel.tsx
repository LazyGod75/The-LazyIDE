/* LiveMissionPanel.tsx — R7 "living surfaces": the LIVE PANEL content a
   mission node expands into (spec: "watch the agent work" — October.dev's
   giant-canvas-with-visible-agents idea, reimplemented over our own real
   streaming facts, never a second fake feed).

   Every value here is a real accessor already used elsewhere in this app —
   no new data source, no synthetic stream:
     - stage rail / live-action line / diff stat: the SAME `FleetMission`
       fields MissionNode.tsx's own card already reads (liveAction/
       diffAdded/diffRemoved/stage) — always available, any project.
     - action timeline tail / plan steps: `Mission.actionTimeline`/
       `planSteps` — NOT on `FleetMission` (see reconciler.ts's header gap #1
       for why), only resolvable via the SAME honest "fullMission" lookup
       MissionNode.tsx already established for its pin-output hover action
       (`agentsStore.missions.find(...)`, real ONLY for the active project's
       live missions). Absent `fullMission` (a non-active-project mission, or
       a disconnected fixture render) renders an honest "indisponible ici"
       line for JUST those two sections — never fabricated content. Reuses
       `parseTimelineEntry` (MissionDetailTranscript.tsx) and
       `MissionDetailPlan` (its own file) verbatim, read-only, rather than
       re-deriving the same rendering twice.
*/

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FleetMission } from '../../../../lib/agents/fleetMissions';
import type { Mission } from '../../../../lib/agents/types';
import { useI18n } from '../../../../i18n';
import { parseTimelineEntry } from '../../MissionDetailTranscript';
import { MissionDetailPlan } from '../../MissionDetailPlan';
import { StageRail } from '../chrome/StageRail';
import { deriveMissionLiveness, statusAccentColor } from '../chrome/nodeChrome';
import { deriveLiveLine } from './missionLiveLine';

/** Spec: "auto-scrolling last ~12 entries". */
const TIMELINE_TAIL_COUNT = 12;

export interface LivePanelQuickAction {
  key: string;
  label: string;
  onSelect: () => void;
}

interface LiveMissionPanelProps {
  mission: FleetMission;
  /** Honest degradation — see module header. */
  fullMission?: Mission;
  width: number;
  height: number;
  quickActions: readonly LivePanelQuickAction[];
  onOpen: () => void;
  onCollapse: () => void;
  /**
   * W-CLOSE row 5 (canvas scorecard "LangGraph interrupt-and-patch" gap,
   * honestly re-scoped — see this prop's own header comment on MissionNode.tsx
   * for the full "what we have vs. what we don't" framing). Present only
   * while `mission.paused` is true (MissionNode.tsx gates this); receives
   * the user's edited plan-steps text (one line per step) and is expected to
   * both queue it as a structured « PLAN AJUSTÉ » intervene message AND
   * resume the mission — see MissionNode.tsx's wiring for the two real
   * primitives this composes (interveneMission + resumeMission), never a
   * new "patch the agent's live state" mechanism this app doesn't have.
   */
  onAdjustPlan?: (adjustedPlanText: string) => void;
}

export function LiveMissionPanel({ mission, fullMission, width, height, quickActions, onOpen, onCollapse, onAdjustPlan }: LiveMissionPanelProps) {
  const { t } = useI18n();
  const liveness = deriveMissionLiveness(mission);
  const statusColor = statusAccentColor(liveness);
  const timelineEndRef = useRef<HTMLDivElement>(null);
  const [adjusting, setAdjusting] = useState(false);
  const [planDraft, setPlanDraft] = useState('');

  const timelineTail = useMemo(
    () => (fullMission?.actionTimeline ?? []).slice(-TIMELINE_TAIL_COUNT),
    [fullMission?.actionTimeline],
  );

  useEffect(() => {
    timelineEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [timelineTail.length]);

  const hasDiffStat = mission.diffAdded !== undefined || mission.diffRemoved !== undefined;

  return (
    <div
      data-testid={`live-mission-panel-${mission.id}`}
      style={{
        width,
        height,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 10,
        overflow: 'hidden',
        background: 'var(--canvas-node-bg)',
        border: '2px solid var(--color-accent)',
        boxShadow: '2px 2px 0 rgba(0,0,0,0.35)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 8px',
          background: 'var(--color-panel-2)',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          flexShrink: 0,
        }}
      >
        <span data-testid="live-mission-panel-status-dot" style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor, flexShrink: 0 }} />
        <span
          data-testid="live-mission-panel-title"
          style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {mission.title}
        </span>
        <button
          type="button"
          data-testid={`live-mission-panel-open-${mission.id}`}
          className="nodrag"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          style={headerButtonStyle}
        >
          {t('canvas.livePanel.open')}
        </button>
        <button
          type="button"
          data-testid={`live-mission-panel-collapse-${mission.id}`}
          className="nodrag"
          aria-label={t('canvas.livePanel.collapse')}
          onClick={(e) => {
            e.stopPropagation();
            onCollapse();
          }}
          style={headerButtonStyle}
        >
          ▢
        </button>
      </div>

      <div className="nodrag" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8, padding: 8, overflowY: 'auto' }}>
        <StageRail currentStage={mission.stage} variant="full" currentStageErrored={liveness === 'failed'} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span
            data-testid="live-mission-panel-live-line"
            style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--color-text-secondary)', flex: 1, minWidth: 0 }}
          >
            {deriveLiveLine(mission, liveness, t)}
          </span>
          {hasDiffStat && (
            <span data-testid="live-mission-panel-diff-stat" style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, flexShrink: 0 }}>
              <span style={{ color: 'var(--color-success)' }}>+{mission.diffAdded ?? 0}</span>{' '}
              <span style={{ color: 'var(--color-danger)' }}>−{mission.diffRemoved ?? 0}</span>
            </span>
          )}
        </div>

        <section>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
            <SectionLabel text={t('canvas.livePanel.sectionPlan')} />
            {/* W-CLOSE row 5 — only offered on a PAUSED managed mission
                (mission.paused, see LiveMissionPanelProps.onAdjustPlan's own
                doc comment): honest v1 of "interrupt-and-patch" — this edits
                the REMAINING PLAN as visible, structured intervention text,
                never a claim of rewriting arbitrary in-flight agent state. */}
            {mission.paused && onAdjustPlan && !adjusting && (
              <button
                type="button"
                data-testid={`live-mission-panel-adjust-plan-${mission.id}`}
                className="nodrag"
                onClick={(e) => {
                  e.stopPropagation();
                  setPlanDraft((fullMission?.planSteps ?? []).map((s) => s.label).join('\n'));
                  setAdjusting(true);
                }}
                style={adjustPlanButtonStyle}
              >
                {t('canvas.livePanel.adjustPlan')}
              </button>
            )}
          </div>
          {adjusting ? (
            <div className="nodrag" style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <textarea
                data-testid={`live-mission-panel-adjust-plan-textarea-${mission.id}`}
                value={planDraft}
                onChange={(e) => setPlanDraft(e.target.value)}
                rows={4}
                style={{
                  fontSize: 10.5,
                  fontFamily: 'var(--font-mono)',
                  background: '#0A0A10',
                  color: 'var(--color-text)',
                  border: '1px solid rgba(255,255,255,0.14)',
                  borderRadius: 6,
                  padding: '5px 7px',
                  resize: 'vertical',
                }}
              />
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  data-testid={`live-mission-panel-adjust-plan-cancel-${mission.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setAdjusting(false);
                  }}
                  style={{ ...quickActionButtonStyle, flex: 'unset' }}
                >
                  {t('canvas.livePanel.adjustPlanCancel')}
                </button>
                <button
                  type="button"
                  data-testid={`live-mission-panel-adjust-plan-resume-${mission.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onAdjustPlan?.(planDraft);
                    setAdjusting(false);
                  }}
                  style={{ ...quickActionButtonStyle, flex: 'unset', borderColor: 'var(--color-accent)', color: 'var(--color-accent)' }}
                >
                  {t('canvas.livePanel.adjustPlanResume')}
                </button>
              </div>
            </div>
          ) : fullMission?.planSteps && fullMission.planSteps.length > 0 ? (
            <MissionDetailPlan planSteps={fullMission.planSteps} />
          ) : (
            <HonestEmpty testId="live-mission-panel-plan-empty" text={t('canvas.livePanel.noPlan')} />
          )}
        </section>

        <section style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <SectionLabel text={t('canvas.livePanel.sectionTimeline')} />
          {timelineTail.length > 0 ? (
            <div
              data-testid={`live-mission-panel-timeline-${mission.id}`}
              style={{
                flex: 1,
                minHeight: 60,
                overflowY: 'auto',
                background: '#0A0A10',
                border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: 7,
                padding: '6px 8px',
              }}
            >
              {timelineTail.map((event, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, padding: '2px 0', fontSize: 10.5 }}>
                  <span style={{ color: 'var(--color-text-disabled)', fontFamily: 'var(--font-mono)', flexShrink: 0, width: 32 }}>{event.time}</span>
                  <span style={{ color: event.isLive ? 'var(--color-text)' : 'var(--color-text-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {timelineEntryText(event.text)}
                  </span>
                </div>
              ))}
              <div ref={timelineEndRef} />
            </div>
          ) : (
            <HonestEmpty testId="live-mission-panel-timeline-empty" text={t('canvas.livePanel.noTimeline')} />
          )}
        </section>

        {quickActions.length > 0 && (
          <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
            {quickActions.map((action) => (
              <button
                key={action.key}
                type="button"
                data-testid={`live-mission-panel-action-${mission.id}-${action.key}`}
                onClick={(e) => {
                  e.stopPropagation();
                  action.onSelect();
                }}
                style={quickActionButtonStyle}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Plain-text projection of `parseTimelineEntry`'s structured result — the
 *  live panel is a compact tail view (not the full drawer transcript), so it
 *  renders one text line per entry rather than MissionDetailTranscript's own
 *  richer action/observation styling; still reuses the SAME parser so a raw
 *  `[3] read_file: {...}` line reads as "Read file …" here too, not a second
 *  divergent format. */
function timelineEntryText(raw: string): string {
  const entry = parseTimelineEntry(raw);
  if (entry.kind === 'action') return `#${entry.step} · ${entry.toolLabel}${entry.argsSummary ? ` ${entry.argsSummary}` : ''}`;
  if (entry.kind === 'observation') return `→ ${entry.text}`;
  return entry.text;
}

function SectionLabel({ text }: { text: string }) {
  return (
    <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-text-disabled)', marginBottom: 3 }}>
      {text}
    </div>
  );
}

function HonestEmpty({ text, testId }: { text: string; testId: string }) {
  return (
    <div data-testid={testId} style={{ fontSize: 10.5, color: 'var(--color-text-disabled)', fontStyle: 'italic', padding: '4px 2px' }}>
      {text}
    </div>
  );
}

const headerButtonStyle = {
  fontSize: 10,
  fontWeight: 700,
  padding: '2px 6px',
  borderRadius: 5,
  border: 'none',
  background: 'transparent',
  color: 'var(--color-text-muted)',
  cursor: 'pointer',
  flexShrink: 0,
} as const;

const quickActionButtonStyle = {
  flex: 1,
  fontSize: 10.5,
  fontWeight: 700,
  padding: '4px 6px',
  borderRadius: 6,
  fontFamily: 'inherit',
  cursor: 'pointer',
  border: '1px solid rgba(255,255,255,0.18)',
  background: 'transparent',
  color: 'var(--color-text)',
} as const;

const adjustPlanButtonStyle = {
  fontSize: 9.5,
  fontWeight: 700,
  padding: '2px 6px',
  borderRadius: 5,
  border: '1px solid var(--color-accent-border)',
  background: 'transparent',
  color: 'var(--color-accent)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  flexShrink: 0,
} as const;
