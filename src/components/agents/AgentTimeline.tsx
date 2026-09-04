/**
 * AgentTimeline — cross-project timeline by agent_id (T5).
 *
 * Shows a horizontal timeline of recent agent activity across ALL projects,
 * grouped by agent_id. Each row is an agent, each segment is a mission event
 * colored by status. Uses journal_agent_stats for aggregate stats and
 * journal_activity_feed for the timeline events themselves.
 *
 * Degrades gracefully to an empty state when no journal data is available
 * (web/mock mode, or no missions have been run yet).
 */

import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import { EmptyState } from '../ui';
import { CpuIcon } from '../icons';
import {
  queryAgentStats,
  queryActivityFeed,
  type AgentStatsOut,
  type ActivityFeedItem,
} from '../../lib/journal/projections';

const POLL_MS = 30_000;
const MAX_EVENTS = 200;
const TIMELINE_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours

const STATUS_COLORS: Record<string, string> = {
  'mission.created': 'rgba(255,255,255,0.25)',
  'mission.launched': '#7C5CFF',
  'mission.step': 'rgba(124,92,255,0.4)',
  'mission.completed': '#4ADE80',
  'mission.failed': '#F87171',
  'mission.approved': '#4ADE80',
  'mission.reverted': '#F87171',
  'mission.rejected': '#F87171',
  'mission.paused': '#FBB924',
  'mission.resumed': '#7C5CFF',
  'brain.recalled': '#2563EB',
  'brain.decision_created': '#2563EB',
  'brain.decision_hit': '#4ADE80',
  'spend.tokens': 'rgba(255,199,107,0.3)',
  'budget.warning': '#FB923C',
  'budget.exceeded': '#F87171',
  'tool.called': 'rgba(255,255,255,0.15)',
};

interface TimelineRow {
  agentId: string;
  events: ActivityFeedItem[];
  stats: AgentStatsOut | null;
  lastActiveMs: number;
}

/** rows + the wall-clock window they were computed against, captured
 *  together at refresh time. Keeping `now`/`windowStart` here — instead of
 *  calling Date.now() directly in the render body below — avoids an impure
 *  render (react-hooks/purity): the "current time" this component displays
 *  only ever changes when refresh() actually runs (on mount and every
 *  POLL_MS), never on an arbitrary unrelated re-render. */
interface TimelineSnapshot {
  rows: TimelineRow[];
  now: number;
  windowStart: number;
}

export function AgentTimeline() {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<TimelineSnapshot | null>(null);

  const refresh = useCallback(async () => {
    const [stats, feed] = await Promise.all([
      queryAgentStats(),
      queryActivityFeed(undefined, MAX_EVENTS),
    ]);

    const statsMap = new Map(stats.map((s) => [s.agent_id, s]));
    const now = Date.now();
    const windowStart = now - TIMELINE_WINDOW_MS;

    // Group feed events by agent_id (or 'system' when null)
    const byAgent = new Map<string, ActivityFeedItem[]>();
    for (const item of feed) {
      if (item.ts_ms < windowStart) continue;
      const key = item.actor || 'system';
      const existing = byAgent.get(key);
      if (existing) existing.push(item);
      else byAgent.set(key, [item]);
    }

    // Build rows from stats (known agents) + any feed-only agents
    const allAgentIds = new Set([...statsMap.keys(), ...byAgent.keys()]);
    const timelineRows: TimelineRow[] = [];
    for (const agentId of allAgentIds) {
      const events = byAgent.get(agentId) ?? [];
      const st = statsMap.get(agentId) ?? null;
      if (events.length === 0 && !st) continue;
      timelineRows.push({
        agentId,
        events: events.sort((a, b) => a.ts_ms - b.ts_ms),
        stats: st,
        lastActiveMs: st?.last_active_ms ?? (events[events.length - 1]?.ts_ms ?? 0),
      });
    }
    timelineRows.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
    setSnapshot({ rows: timelineRows, now, windowStart });
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  if (snapshot !== null && snapshot.rows.length === 0) {
    return (
      <div
        data-testid="agent-timeline"
        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <EmptyState
          icon={CpuIcon}
          title={t('agents.timeline.emptyTitle') ?? 'No agent activity yet'}
          subtitle={t('agents.timeline.emptySubtitle') ?? 'Agent missions will appear here as they run'}
        />
      </div>
    );
  }

  return (
    <div
      data-testid="agent-timeline"
      style={{
        padding: '16px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        overflowY: 'auto',
        height: '100%',
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: 'rgba(255,255,255,0.45)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          marginBottom: 8,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span>{t('agents.timeline.title') ?? 'Agent Timeline'}</span>
        <span style={{ fontSize: 9, fontWeight: 500, color: 'rgba(255,255,255,0.3)' }}>
          {t('agents.timeline.windowLabel') ?? 'last 6h'}
        </span>
      </div>

      {snapshot === null ? (
        <div style={{ padding: '20px 0', textAlign: 'center', color: 'rgba(255,255,255,0.3)', fontSize: 11 }}>
          {t('agents.timeline.loading') ?? 'Loading...'}
        </div>
      ) : (
        snapshot.rows.map((row) => (
          <AgentTimelineRow key={row.agentId} row={row} windowStart={snapshot.windowStart} now={snapshot.now} />
        ))
      )}
    </div>
  );
}

function AgentTimelineRow({ row, windowStart, now }: { row: TimelineRow; windowStart: number; now: number }) {
  const spanMs = now - windowStart;

  return (
    <div
      data-testid={`timeline-row-${row.agentId}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        borderRadius: 6,
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.04)',
      }}
    >
      {/* Agent label */}
      <div style={{ flexShrink: 0, width: 100, minWidth: 0 }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: '#E2E2F0',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {row.agentId}
        </div>
        {row.stats && (
          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.32)', marginTop: 1 }}>
            {row.stats.runs} runs · {row.stats.completed}✓ · {row.stats.failed}✗
          </div>
        )}
      </div>

      {/* Timeline track */}
      <div
        style={{
          flex: 1,
          position: 'relative',
          height: 20,
          background: 'rgba(255,255,255,0.03)',
          borderRadius: 4,
          overflow: 'hidden',
        }}
      >
        {row.events.map((evt, i) => {
          const left = ((evt.ts_ms - windowStart) / spanMs) * 100;
          const color = STATUS_COLORS[evt.event_type] ?? 'rgba(255,255,255,0.2)';
          const isTerminal = evt.event_type.startsWith('mission.completed') || evt.event_type.startsWith('mission.failed');
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: `${left}%`,
                top: 0,
                bottom: 0,
                width: isTerminal ? 3 : 2,
                background: color,
                opacity: 0.8,
              }}
              title={`${new Date(evt.ts_ms).toLocaleTimeString()} — ${evt.event_type} (${evt.project_id})`}
            />
          );
        })}
      </div>

      {/* Project count */}
      <div style={{ flexShrink: 0, fontSize: 9, color: 'rgba(255,255,255,0.3)', textAlign: 'right', minWidth: 50 }}>
        {new Set(row.events.map((e) => e.project_id)).size} proj
      </div>
    </div>
  );
}
