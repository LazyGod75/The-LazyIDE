/**
 * AgentRoster — cockpit v2 surface showing active agents and their missions.
 *
 * Derives from the missions in the store: groups by agentName/modelLabel
 * to show which agents are running, queued, or done. Clicking an agent
 * selects its most recent mission.
 *
 * Audit follow-up (T2.0/T2.7 gap): per-agent-identity stats (runs, success
 * rate, avg cost) are additionally merged in from the journal's
 * `journal_agent_stats` aggregate query (`queryAgentStats`, projections.ts)
 * instead of being derived from the in-memory mission store — the store
 * only ever reflects THIS session's missions, while the journal is the
 * durable cross-session source of truth (spec section 4.3: "agent profiles
 * (aggregates by agent_id)"). The existing grouping key (`agentName` when
 * present, matching `LazyAgent.name` from the Library — see
 * `agentDef.ts` — else `model`, else `'default'`) doubles as the join key
 * against `AgentStatsOut.agent_id`, since call sites that populate the
 * journal's `agent_id` column already use that same stable identity string
 * (see runtime.ts's sub-agent handoff). Honest by construction: a group
 * with no matching journal rows (new identity, or historical data recorded
 * before `agent_id` was populated) renders "-" per cell, never a fabricated
 * 0 — see `StatCell` below.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Mission } from '../../lib/agents/types';
import { useI18n } from '../../i18n';
import { EmptyState } from '../ui';
import { BotIcon } from '../icons';
import { queryAgentStats, type AgentStatsOut } from '../../lib/journal/projections';
import { rosterStatusColors, type RosterStatusKey } from './missionStatusColors';
import { usdToCredits } from '../../lib/billing/credits';

/** Poll cadence for refreshing journal-backed stats — matches the other
 *  cockpit v2 surfaces built on top of projections.ts (GlobalFeed.tsx,
 *  AttentionInbox.tsx both refresh every 30s). */
const STATS_POLL_MS = 30_000;

interface AgentRosterProps {
  missions: Mission[];
  onMissionClick: (id: string) => void;
}

interface AgentGroup {
  agentName: string;
  model: string;
  running: number;
  queued: number;
  done: number;
  failed: number;
  review: number;
  total: number;
  lastMissionId: string;
  lastActivity: number;
}

/** Narrow an arbitrary mission status to a roster counter key (or null for
 *  statuses the roster does not track). Replaces the two previous
 *  `(g as any)[m.status]` casts — identical runtime check
 *  (`status in rosterStatusColors`), now expressed as a type guard. */
function asRosterStatus(status: string): RosterStatusKey | null {
  return status in rosterStatusColors ? (status as RosterStatusKey) : null;
}

export function AgentRoster({ missions, onMissionClick }: AgentRosterProps) {
  const { t } = useI18n();

  const groups = useMemo(() => {
    const map = new Map<string, AgentGroup>();
    for (const m of missions) {
      const key = m.agentName || m.model || 'default';
      const existing = map.get(key);
      if (!existing) {
        const g: AgentGroup = {
          agentName: key,
          model: m.model,
          running: 0, queued: 0, done: 0, failed: 0, review: 0,
          total: 1,
          lastMissionId: m.id,
          lastActivity: m.createdAt ?? 0,
        };
        if (g.agentName === key) g.model = m.model;
        const statusKey = asRosterStatus(m.status);
        if (statusKey) {
          g[statusKey] = 1;
        }
        map.set(key, g);
      } else {
        existing.total++;
        const statusKey = asRosterStatus(m.status);
        if (statusKey) {
          existing[statusKey]++;
        }
        const mActivity = m.createdAt ?? 0;
        if (mActivity > existing.lastActivity) {
          existing.lastActivity = mActivity;
          existing.lastMissionId = m.id;
        }
      }
    }
    return [...map.values()].sort((a, b) => b.lastActivity - a.lastActivity);
  }, [missions]);

  // Journal-backed stats (audit follow-up — see module doc comment above).
  // `statsByAgent === null` means "still loading" (distinct from "loaded,
  // no rows" — an empty Map after the first resolved fetch), so the roster
  // can render an honest loading skeleton instead of a premature "-".
  const [statsByAgent, setStatsByAgent] = useState<Map<string, AgentStatsOut> | null>(null);

  const refreshStats = useCallback(async () => {
    const rows = await queryAgentStats();
    setStatsByAgent(new Map(rows.map((row) => [row.agent_id, row])));
  }, []);

  useEffect(() => {
    void refreshStats();
    const interval = setInterval(() => void refreshStats(), STATS_POLL_MS);
    return () => clearInterval(interval);
  }, [refreshStats]);

  if (missions.length === 0) {
    return (
      <div
        data-testid="agent-roster"
        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <EmptyState
          icon={BotIcon}
          title={t('agents.roster.emptyTitle')}
          subtitle={t('agents.roster.emptySubtitle')}
        />
      </div>
    );
  }

  return (
    <div
      data-testid="agent-roster"
      style={{
        padding: '16px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
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
          marginBottom: 4,
        }}
      >
        {t('agents.roster.title')} ({groups.length})
      </div>
      {groups.map((group) => {
        const isActive = group.running > 0;

        // Journal-backed stats merge (audit follow-up — see module doc
        // comment). `statsByAgent === null` = still loading the first
        // fetch; a resolved Map with no entry for this group = genuinely
        // no journal data recorded yet for this identity (both render
        // honestly, never a fabricated number — see StatCell).
        const stats = statsByAgent?.get(group.agentName);
        const successRateLabel =
          stats && stats.completed + stats.failed > 0
            ? `${Math.round((stats.completed / (stats.completed + stats.failed)) * 100)}%`
            : null;
        // Fix D (2026-08-19 dollar-kill incident, display half) — credits,
        // never a dollar figure (usdToCredits, the same conversion every
        // other real-spend display in this app shares). journal_agent_stats
        // is a SQL aggregate with no per-row rail column (unlike
        // CompletedMissionReport.costIsApiEquivalent, which projectReport.ts
        // CAN split on) — total_cost_usd may silently mix real managed/BYOK
        // spend with native-rail API-equivalent figures across an agent's
        // history, so this stays ONE number but is honestly captioned via
        // StatCell's tooltip rather than presented as pure real spend.
        const avgCostLabel =
          stats && stats.runs > 0 ? `${usdToCredits(stats.total_cost_usd / stats.runs).toLocaleString()} ${t('canvas.node.creditsUnit')}` : null;
        const runsLabel = stats ? String(stats.runs) : null;

        return (
          <button
            key={group.agentName}
            data-testid={`roster-agent-${group.agentName}`}
            onClick={() => onMissionClick(group.lastMissionId)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '12px 16px',
              borderRadius: 8,
              border: `1px solid ${isActive ? 'rgba(124,92,255,0.25)' : 'rgba(255,255,255,0.06)'}`,
              background: isActive ? 'rgba(124,92,255,0.06)' : 'rgba(255,255,255,0.02)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              textAlign: 'left',
              width: '100%',
            }}
          >
            {/* Agent avatar */}
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: isActive ? 'rgba(124,92,255,0.15)' : 'rgba(255,255,255,0.05)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 14,
                fontWeight: 700,
                color: isActive ? '#C4B5FD' : 'rgba(255,255,255,0.4)',
                flexShrink: 0,
              }}
            >
              {group.agentName.slice(0, 2).toUpperCase()}
            </div>

            {/* Agent info */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: '#E2E2F0',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {group.agentName}
              </div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>
                {group.model} · {group.total} {t('agents.roster.missions')}
              </div>
            </div>

            {/* Journal-backed stats (audit follow-up) */}
            <div
              data-testid={`roster-agent-stats-${group.agentName}`}
              style={{ display: 'flex', gap: 14, flexShrink: 0, marginRight: 4 }}
            >
              <StatCell label={t('agents.roster.runs')} value={runsLabel} loading={statsByAgent === null} />
              <StatCell label={t('agents.roster.successRate')} value={successRateLabel} loading={statsByAgent === null} />
              <StatCell
                label={t('agents.roster.avgCost')}
                value={avgCostLabel}
                loading={statsByAgent === null}
                tooltip={avgCostLabel ? t('agents.roster.avgCostScope') : undefined}
              />
            </div>

            {/* Status pills */}
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              {group.running > 0 && <StatusPill label={t('agents.roster.running')} count={group.running} color={rosterStatusColors.running} />}
              {group.queued > 0 && <StatusPill label={t('agents.roster.queued')} count={group.queued} color={rosterStatusColors.queued} />}
              {group.review > 0 && <StatusPill label={t('agents.roster.review')} count={group.review} color={rosterStatusColors.review} />}
              {group.done > 0 && <StatusPill label={t('agents.roster.done')} count={group.done} color={rosterStatusColors.done} />}
              {group.failed > 0 && <StatusPill label={t('agents.roster.failed')} count={group.failed} color={rosterStatusColors.failed} />}
            </div>
          </button>
        );
      })}
    </div>
  );
}

/**
 * One journal-stat cell (runs / success rate / avg cost). Three honest
 * states, never conflated: `loading` (still resolving the first
 * `queryAgentStats` call — a neutral skeleton block, no number), a real
 * `value` (journal has data for this agent), or `null` (query resolved but
 * this agent has no matching journal rows — renders "-", never a
 * fabricated 0/0%/$0).
 */
function StatCell({
  label,
  value,
  loading,
  tooltip,
}: {
  label: string;
  value: string | null;
  loading: boolean;
  /** Fix D (2026-08-19 dollar-kill incident) — an honest caveat surfaced via
   *  the native title attribute for a stat that cannot be cleanly split by
   *  rail (see avgCostLabel below: journal_agent_stats aggregates real
   *  managed/BYOK spend and native-rail API-equivalent figures together,
   *  with no per-row rail column to split on). Optional — most stats need
   *  no caveat at all. */
  tooltip?: string;
}) {
  return (
    <div title={tooltip} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', minWidth: 40 }}>
      {loading ? (
        <div
          aria-hidden="true"
          data-testid="stat-cell-skeleton"
          style={{ width: 28, height: 12, borderRadius: 3, background: 'rgba(255,255,255,0.08)' }}
        />
      ) : (
        <div style={{ fontSize: 12, fontWeight: 600, color: value ? '#E2E2F0' : 'rgba(255,255,255,0.25)' }}>
          {value ?? '—'}
        </div>
      )}
      <div
        style={{
          fontSize: 9,
          color: 'rgba(255,255,255,0.32)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          marginTop: 2,
        }}
      >
        {label}
      </div>
    </div>
  );
}

function StatusPill({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: 4,
        background: `${color}15`,
        color,
        fontSize: 10,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {count} {label}
    </span>
  );
}
