/* CockpitKpiBar — usage-metrics banner displayed above the mission cockpit */

import { useState, useEffect } from 'react';
import { useI18n } from '../../i18n';
import type { Mission } from '../../lib/agents/types';
import type { UsageWindow } from '../../lib/models/usageHistory';
import {
  WindowSelector,
  MetricTile,
  MissionStatusBars,
  KpiRow,
  useUsageMetrics,
  formatTokens,
  formatCost,
} from '../metrics';
import { queryFleetOverview, type FleetProjectKpi } from '../../lib/journal/projections';
import { journalQuery } from '../../lib/journal/journal';
import { poolStatus, type PoolStatusEntry } from '../../lib/agents/scheduler';

interface CockpitKpiBarProps {
  missions: Mission[];
}

// ── Tile: Missions (custom layout to include status bars) ──────────

interface MissionsTileProps {
  label: string;
  completedCount: number;
  doneLabel: string;
  liveRunning: number;
  liveReview: number;
  liveQueued: number;
  runningLabel: string;
  reviewLabel: string;
}

interface MissionsTileViewProps {
  label: string;
  completedCount: number;
  doneLabel: string;
  liveSub: string;
  liveRunning: number;
  liveReview: number;
  liveQueued: number;
}

// Presentational sub-component — pure render, no logic.
function MissionsTileView({
  label,
  completedCount,
  doneLabel,
  liveSub,
  liveRunning,
  liveReview,
  liveQueued,
}: MissionsTileViewProps) {
  return (
    <div
      style={{
        flex: '1 1 0',
        minWidth: 0,
        background: '#16161D',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 8,
        padding: '10px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.40)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600, lineHeight: 1 }}>
        {label}
      </span>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 18, fontWeight: 700, lineHeight: 1, color: '#E2E2F0', fontVariantNumeric: 'tabular-nums' }}>
          {completedCount}
        </span>
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.38)', fontWeight: 500 }}>
          {doneLabel}
        </span>
      </div>
      {liveSub.length > 0 && (
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.38)', lineHeight: 1.3 }}>
          {liveSub}
        </span>
      )}
      <MissionStatusBars
        done={completedCount}
        running={liveRunning}
        review={liveReview}
        queued={liveQueued}
      />
    </div>
  );
}

function MissionsTile({
  label,
  completedCount,
  doneLabel,
  liveRunning,
  liveReview,
  liveQueued,
  runningLabel,
  reviewLabel,
}: MissionsTileProps) {
  const liveParts: string[] = [];
  if (liveRunning > 0) liveParts.push(`${liveRunning} ${runningLabel}`);
  if (liveReview > 0) liveParts.push(`${liveReview} ${reviewLabel}`);
  const liveSub = liveParts.join(' · ');
  return (
    <MissionsTileView
      label={label}
      completedCount={completedCount}
      doneLabel={doneLabel}
      liveSub={liveSub}
      liveRunning={liveRunning}
      liveReview={liveReview}
      liveQueued={liveQueued}
    />
  );
}

// ── CockpitKpiBar ────────────────────────────────────────────────

export function CockpitKpiBar({ missions }: CockpitKpiBarProps) {
  const { t } = useI18n();
  const [selectedWindow, setSelectedWindow] = useState<UsageWindow>('today');
  const metrics = useUsageMetrics(selectedWindow);
  const [fleetKpis, setFleetKpis] = useState<FleetProjectKpi[]>([]);
  const [pools, setPools] = useState<PoolStatusEntry[]>([]);

  useEffect(() => {
    void queryFleetOverview().then(setFleetKpis);
    const interval = setInterval(() => void queryFleetOverview().then(setFleetKpis), 60_000);
    return () => clearInterval(interval);
  }, []);

  // Scheduler pools (T1.1) — poolStatus() is a synchronous snapshot of the
  // module-level scheduler singleton (scheduler.ts): every pool with
  // activity (running, queued, or backed off), with its running count and
  // concurrency cap. Polled on an interval (rather than read once) because
  // dispatch()/settle mutate that singleton outside React state.
  useEffect(() => {
    const poll = () => setPools(poolStatus());
    poll();
    const interval = setInterval(poll, 5_000);
    return () => clearInterval(interval);
  }, []);

  // Count distinct cross-project recalls (brain.recalled events with sourceProject)
  const [solutionsReused, setSolutionsReused] = useState(0);
  useEffect(() => {
    // Array.isArray guard is belt-and-suspenders on top of journalQuery's own
    // contract (always resolves an array) — cheap insurance since this
    // component polls journalQuery every 60s for the lifetime of the app.
    void journalQuery({ types: ['brain.recalled'], limit: 500 }).then((result) => {
      const rows = Array.isArray(result) ? result : [];
      const distinct = new Set<string>();
      for (const row of rows) {
        try {
          const p = JSON.parse(row.payload);
          if (p.sourceProject) distinct.add(p.sourceProject);
        } catch { /* skip */ }
      }
      setSolutionsReused(distinct.size);
    });
    const interval = setInterval(() =>
      void journalQuery({ types: ['brain.recalled'], limit: 500 }).then((result) => {
        const rows = Array.isArray(result) ? result : [];
        const distinct = new Set<string>();
        for (const row of rows) {
          try {
            const p = JSON.parse(row.payload);
            if (p.sourceProject) distinct.add(p.sourceProject);
          } catch { /* skip */ }
        }
        setSolutionsReused(distinct.size);
      }), 60_000);
    return () => clearInterval(interval);
  }, []);

  // Aggregate fleet totals from journal projection
  const fleetTotalRunning = fleetKpis.reduce((sum, k) => sum + k.running, 0);
  const fleetTotalQueued = fleetKpis.reduce((sum, k) => sum + k.queued, 0);
  const fleetTotalReview = fleetKpis.reduce((sum, k) => sum + k.review, 0);
  const fleetTotalDone = fleetKpis.reduce((sum, k) => sum + k.done, 0);
  const fleetTotalFailed = fleetKpis.reduce((sum, k) => sum + k.failed, 0);
  const fleetTotalCost = fleetKpis.reduce((sum, k) => sum + k.total_cost_usd, 0);
  const fleetTotalTokens = fleetKpis.reduce((sum, k) => sum + k.total_tokens, 0);
  const fleetProjectCount = fleetKpis.length;

  // Scheduler pools aggregates — total running/cap concurrency slots and
  // queued backlog across every active pool (claude-cli / managed /
  // byok:<hash>), plus a per-pool breakdown for the secondary line/tooltip.
  const poolTotalRunning = pools.reduce((sum, p) => sum + p.running, 0);
  const poolTotalCap = pools.reduce((sum, p) => sum + p.cap, 0);
  const poolTotalQueued = pools.reduce((sum, p) => sum + p.queued, 0);
  const poolBreakdown = pools.map((p) => `${p.pool} ${p.running}/${p.cap}`).join(' · ');

  // Live status counts from the current missions prop
  const runningCount = missions.filter((m) => m.status === 'running').length;
  const reviewCount = missions.filter((m) => m.status === 'review').length;
  const queuedCount = missions.filter((m) => m.status === 'queued').length;

  // Brain savings as a percentage of total context
  const totalContext = metrics.totalTokens + metrics.brainTokensSaved;
  const brainPct =
    totalContext > 0
      ? Math.round((metrics.brainTokensSaved / totalContext) * 100)
      : 0;

  const brainSub =
    brainPct > 0
      ? `${brainPct}% ${t('metrics.vsRawContext')}`
      : t('metrics.vsRawContext');

  // Token sub-text: show input / output counts
  const tokenSub = `${formatTokens(metrics.inputTokens)} / ${formatTokens(metrics.outputTokens)}`;

  return (
    <div
      style={{
        flexShrink: 0,
        background: '#0E0E12',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        padding: '10px 20px 12px',
      }}
    >
      {/* Header row: title + window selector */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 10,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'rgba(255,255,255,0.45)',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}
        >
          {t('metrics.bannerTitle')}
        </span>
        <WindowSelector value={selectedWindow} onChange={setSelectedWindow} />
      </div>

      {/* KPI tiles */}
      <KpiRow>
        <MetricTile
          label={t('metrics.tokens')}
          value={formatTokens(metrics.totalTokens)}
          sub={tokenSub}
          sparkline={metrics.tokenSparkline}
          sparklineColor="#7C5CFF"
        />
        <MetricTile
          label={t('metrics.cost')}
          value={formatCost(metrics.costUsd)}
          sub={t(`metrics.window.${selectedWindow}`)}
          sparkline={metrics.costSparkline}
          sparklineColor="#FFC76B"
        />
        <MissionsTile
          label={t('metrics.missions')}
          completedCount={metrics.missionsCompleted}
          doneLabel={t('metrics.missionsDone')}
          liveRunning={runningCount}
          liveReview={reviewCount}
          liveQueued={queuedCount}
          runningLabel={t('metrics.running')}
          reviewLabel={t('metrics.review')}
        />
        <MetricTile
          label={t('metrics.brainSaved')}
          value={formatTokens(metrics.brainTokensSaved)}
          sub={brainSub}
          title={t('metrics.brainSavedTooltip')}
          accent
          sparklineColor="#4ADE80"
        />
        <MetricTile
          label={t('metrics.solutionsReused')}
          value={String(solutionsReused)}
          sub={t('metrics.solutionsReusedSub')}
        />
        {pools.length > 0 && (
          <MetricTile
            label={t('metrics.scheduler') ?? 'Scheduler'}
            value={`${poolTotalRunning}/${poolTotalCap}`}
            sub={`${poolTotalQueued} queued · ${poolBreakdown}`}
            title={poolBreakdown}
            sparklineColor="#FBB924"
          />
        )}
        {fleetProjectCount > 0 && (
          <MetricTile
            label={t('metrics.fleet')}
            value={`${fleetProjectCount}`}
            sub={`${fleetTotalRunning + fleetTotalQueued + fleetTotalReview} active · ${fleetTotalDone} done · ${fleetTotalFailed} failed · ${formatCost(fleetTotalCost)} · ${formatTokens(fleetTotalTokens)}`}
          />
        )}
      </KpiRow>
    </div>
  );
}
