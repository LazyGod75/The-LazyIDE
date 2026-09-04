/* HomeSpace — dashboard "Pendant ton absence"
   Sections: agent activity, brain highlights, quick actions.

   Platform contract: honest empty states everywhere — no hardcoded/mock
   data is ever rendered, on web or on desktop. Missions are loaded from
   real platform persistence (Tauri filesystem / web localStorage). Brain
   highlights come from the live /_api/graph endpoint when reachable.
*/

import { useState, useEffect } from 'react';
import { useAppContext } from '../app/AppContext';
import { useI18n } from '../i18n';
import type { SpaceId } from '../app/AppContext';
import { getPlatform } from '../lib/platform';
import type { Mission } from '../lib/agents/types';
import { HomeKpiBar } from '../components/home/HomeKpiBar';
import { HomeActivityCard } from '../components/home/HomeActivityCard';
import { HomeHealthCard } from '../components/home/HomeHealthCard';
import { HomeRecentMissions } from '../components/home/HomeRecentMissions';
import { GettingStarted } from '../components/home/GettingStarted';

// ── Platform guard ──────────────────────────────────────────────────

function isWebPlatform(): boolean {
  return getPlatform().name === 'web';
}

// ── Types ──────────────────────────────────────────────────────────

interface QuickActionProps {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

interface AgentActivityItemProps {
  title: string;
  detail: string;
  status: 'running' | 'review' | 'done';
  targetSpace?: SpaceId;
  onNavigate: (space: SpaceId) => void;
}

interface BrainHighlightItemProps {
  title: string;
  meta: string;
  type: string;
  onNavigate: (space: SpaceId) => void;
}

// ── Sub-components ──────────────────────────────────────────────────

function SectionTitle({ children }: { children: string }) {
  return (
    <h2 style={{
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: '0.1em',
      textTransform: 'uppercase',
      color: 'rgba(255,255,255,0.3)',
      marginBottom: 10,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
    }}>
      {children}
    </h2>
  );
}

const STATUS_COLOR: Record<string, string> = {
  running: '#FFC76B',
  review:  '#7C5CFF',
  done:    '#66E27A',
};

const STATUS_KEYS: Record<string, string> = {
  running: 'status.running',
  review:  'status.review',
  done:    'status.done',
};

function AgentActivityItem({ title, detail, status, targetSpace, onNavigate }: AgentActivityItemProps) {
  const { t } = useI18n();
  return (
    <button
      onClick={() => targetSpace && onNavigate(targetSpace)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 8,
        cursor: targetSpace ? 'pointer' : 'default',
        textAlign: 'left',
        width: '100%',
        color: 'inherit',
        transition: 'border-color 0.15s',
      }}
      onMouseEnter={e => {
        if (targetSpace) {
          (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(124,92,255,0.35)';
        }
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--color-border)';
      }}
    >
      <span style={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: STATUS_COLOR[status] ?? '#888',
        flexShrink: 0,
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text)', marginBottom: 1 }}>
          {title}
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {detail}
        </div>
      </div>
      <span style={{
        fontSize: 10,
        fontWeight: 600,
        color: STATUS_COLOR[status],
        background: `${STATUS_COLOR[status]}18`,
        borderRadius: 4,
        padding: '2px 7px',
        flexShrink: 0,
      }}>
        {t(STATUS_KEYS[status] ?? status)}
      </span>
    </button>
  );
}

function BrainHighlightItem({ title, meta, type, onNavigate }: BrainHighlightItemProps) {
  const TYPE_ICON: Record<string, string> = {
    decision: '◉',
    bug:      '▲',
    concept:  '◈',
    file:     '◻',
    module:   '⬡',
  };
  return (
    <button
      onClick={() => onNavigate('brain')}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        background: 'transparent',
        border: '1px solid var(--color-border)',
        borderRadius: 8,
        cursor: 'pointer',
        textAlign: 'left',
        width: '100%',
        color: 'inherit',
        transition: 'background 0.15s',
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-accent-soft)';
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
      }}
    >
      <span style={{ fontSize: 14, color: 'var(--color-accent-light)', flexShrink: 0 }}>
        {TYPE_ICON[type] ?? '◈'}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text)', marginBottom: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title}
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{meta}</div>
      </div>
    </button>
  );
}

function QuickAction({ label, onClick, primary }: QuickActionProps) {
  return (
    <button
      onClick={onClick}
      data-primary={primary ? 'true' : undefined}
      style={{
        padding: '9px 16px',
        background: primary ? 'var(--color-accent)' : 'var(--color-panel-2)',
        border: `1px solid ${primary ? 'transparent' : 'var(--color-border)'}`,
        borderRadius: 7,
        color: primary ? '#fff' : 'var(--color-text)',
        fontSize: 13,
        fontWeight: primary ? 600 : 500,
        cursor: 'pointer',
        fontFamily: 'inherit',
        boxShadow: primary ? '0 2px 12px rgba(124,92,255,0.3)' : 'none',
        transition: 'box-shadow 0.15s, transform 0.1s, background 0.15s, opacity 0.15s',
      }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLButtonElement;
        if (primary) {
          el.style.boxShadow = '0 0 0 3px rgba(124,92,255,0.25), 0 4px 16px rgba(124,92,255,0.35)';
          el.style.transform = 'translateY(-1px)';
        } else {
          el.style.opacity = '0.8';
        }
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLButtonElement;
        if (primary) {
          el.style.boxShadow = '0 2px 12px rgba(124,92,255,0.3)';
          el.style.transform = 'translateY(0)';
        } else {
          el.style.opacity = '1';
        }
      }}
    >
      {label}
    </button>
  );
}

// ── Empty state for desktop ─────────────────────────────────────────

function EmptySection({ message }: { message: string }) {
  return (
    <div style={{
      padding: '16px 12px',
      border: '1px dashed rgba(255,255,255,0.1)',
      borderRadius: 8,
      fontSize: 12,
      color: 'rgba(255,255,255,0.25)',
      fontStyle: 'italic',
      textAlign: 'center',
    }}>
      {message}
    </div>
  );
}

// ── Derived types ─────────────────────────────────────────────────

type ActivityItem = {
  title: string;
  detail: string;
  status: 'running' | 'review' | 'done';
  targetSpace?: SpaceId;
};

type BrainHighlight = {
  title: string;
  meta: string;
  type: string;
};

// ── HomeSpace ──────────────────────────────────────────────────────

export function HomeSpace() {
  const { t } = useI18n();
  const { setActiveSpace, openProject, projectRoot } = useAppContext();
  const isWeb = isWebPlatform();

  // No real derivation for a distinct "activity feed" exists yet — honest
  // empty state (HomeActivityCard and HomeRecentMissions below already
  // cover real mission activity from `missions`).
  const activityItems: ActivityItem[] = [];
  const [brainHighlights, setBrainHighlights] = useState<BrainHighlight[]>([]);

  const [missions, setMissions] = useState<Mission[]>([]);

  useEffect(() => {
    if (!projectRoot) return;
    let cancelled = false;
    async function loadMissions(): Promise<void> {
      try {
        const raw = await getPlatform().missions.load(projectRoot);
        if (cancelled || !Array.isArray(raw)) return;
        const parsed = raw.filter(
          (item): item is Mission =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as Record<string, unknown>).id === 'string',
        );
        setMissions(parsed);
      } catch { /* best-effort — leave empty on error */ }
    }
    loadMissions();
    return () => { cancelled = true; };
  }, [projectRoot]);

  useEffect(() => {
    if (!isWeb) return;
    let cancelled = false;
    async function fetchHighlights() {
      try {
        const res = await fetch('/_api/graph');
        if (!res.ok) return;
        const raw = await res.json() as { nodes: Array<{ id: string; title: string; type: string | null; importance: number; created?: string }> };
        if (cancelled) return;
        // Take top 3 by importance
        const top = [...raw.nodes]
          .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
          .slice(0, 3);
        setBrainHighlights(top.map(n => ({
          title: n.title.slice(0, 60),
          meta: n.type ?? 'brain',
          type: n.type === 'bug' ? 'bug' : n.type === 'decision' ? 'decision' : 'concept',
        })));
      } catch { /* brain unavailable */ }
    }
    fetchHighlights();
    return () => { cancelled = true; };
  }, [isWeb]);

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'auto',
      background: 'var(--color-bg)',
      padding: '28px 32px',
      gap: 28,
    }}>
      {/* Header */}
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text)', marginBottom: 4 }}>
          {t('home.welcome')}
        </h1>
        <p style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
          {t('home.subtitle')}
        </p>
      </div>

      {/* First-run checklist — real progress, Tauri only, self-gating */}
      <GettingStarted hasMissions={missions.length > 0} />

      {/* KPI overview row — usage metrics for the selected time window */}
      <HomeKpiBar />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, minWidth: 0 }}>
        {/* Left column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24, minWidth: 0, overflow: 'hidden' }}>
          {/* Agent activity */}
          <section>
            <SectionTitle>{t('home.whileAway')}</SectionTitle>
            {activityItems.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {activityItems.map((item, idx) => (
                  <AgentActivityItem
                    key={idx}
                    title={item.title}
                    detail={item.detail}
                    status={item.status}
                    targetSpace={item.targetSpace}
                    onNavigate={setActiveSpace}
                  />
                ))}
              </div>
            ) : (
              <EmptySection message={t('home.noMissions')} />
            )}
          </section>

          {/* Activity card — token sparkline + mission status bars */}
          <HomeActivityCard missions={missions} />
        </div>

        {/* Right column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24, minWidth: 0, overflow: 'hidden' }}>
          {/* Health card — active model, neuron count, agent count, brain status */}
          <HomeHealthCard />

          {/* Brain highlights — real data from /_api/graph (web-reachable path only for now) */}
          <section>
            <SectionTitle>{t('home.brainHighlights')}</SectionTitle>
            {brainHighlights.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {brainHighlights.map((item, idx) => (
                  <BrainHighlightItem
                    key={idx}
                    title={item.title}
                    meta={item.meta}
                    type={item.type}
                    onNavigate={setActiveSpace}
                  />
                ))}
              </div>
            ) : (
              <EmptySection message={t('home.noBrainHighlights')} />
            )}
          </section>

          {/* Quick actions */}
          <section>
            <SectionTitle>{t('home.quickActions')}</SectionTitle>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <QuickAction
                label={t('home.action.openFolder')}
                onClick={() => openProject()}
                primary
              />
              <QuickAction
                label={t('home.action.resume')}
                onClick={() => setActiveSpace('agents')}
              />
              <QuickAction
                label={t('home.action.newMission')}
                onClick={() => setActiveSpace('agents')}
              />
              <QuickAction
                label={t('home.action.openBrain')}
                onClick={() => setActiveSpace('brain')}
              />
              <QuickAction
                label={t('home.action.newTerminal')}
                onClick={() => setActiveSpace('terminals')}
              />
            </div>
          </section>
        </div>
      </div>

      {/* Recent missions — full-width feed below the grid */}
      <HomeRecentMissions missions={missions} />
    </div>
  );
}
