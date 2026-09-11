/**
 * Briefing — cockpit v2 "resume briefing" (T2.5, spec §9).
 *
 * Answers "what happened while I was away": queries every journal event
 * since this scope's lastSeen anchor (default: last 24h on first run),
 * groups them into a digest (shipped / asks / learned / spent / night
 * shift — see ../../lib/agents/briefing.ts's buildBriefingDigest, a pure
 * function), and shows a short grounded narrative paragraph on top of it.
 *
 * The narrative is generated once per digest window (cached in
 * localStorage, keyed by the window's lastSeq) and degrades honestly to
 * digest-only bullets if the model call fails or no model is configured —
 * the sections below are ALWAYS deterministic digest output, never LLM
 * output, so there is always something real to show even with no model.
 */

import { useEffect, useState, useCallback, type CSSProperties, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { useAgentsStoreActions } from './agentsStore';
import { queryJournalSince } from '../../lib/journal/projections';
import {
  buildBriefingDigest,
  generateBriefingNarrative,
  resolveScope,
  resolveSinceAnchor,
  readBriefingCache,
  writeBriefingCache,
  writeLastSeen,
  type BriefingDigest,
  type ShippedItem,
  type AskItem,
  type NightShiftItem,
} from '../../lib/agents/briefing';
import { EmptyState, Skeleton } from '../ui';
import { BrainIcon } from '../icons';

interface BriefingProps {
  /** Scopes the briefing to one project. Omitted (default) = fleet-wide. */
  projectId?: string;
}

type NarrativeStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

const PANEL_STYLE: CSSProperties = {
  background: '#16161D',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 10,
  padding: '16px 20px',
};

const SECTION_TITLE_STYLE: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: 'rgba(255,255,255,0.45)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  marginBottom: 10,
};

export function Briefing({ projectId }: BriefingProps = {}) {
  const { t, locale } = useI18n();
  const { setSelectedMissionId } = useAgentsStoreActions();
  const [digest, setDigest] = useState<BriefingDigest | null>(null);
  const [loading, setLoading] = useState(true);
  const [narrative, setNarrative] = useState<string | null>(null);
  const [narrativeStatus, setNarrativeStatus] = useState<NarrativeStatus>('idle');

  const refresh = useCallback(async () => {
    setLoading(true);
    const scope = resolveScope(projectId);
    const sinceMs = resolveSinceAnchor(scope);
    const events = await queryJournalSince(projectId, sinceMs);
    const nextDigest = buildBriefingDigest(events);
    setDigest(nextDigest);
    setLoading(false);

    // Recorded on DISPLAY (this mount), read back as next open's anchor —
    // never inside a polling loop, or "since" would collapse to "since the
    // last poll" instead of "since the user last looked".
    writeLastSeen(scope, Date.now());

    if (nextDigest.eventCount === 0) {
      setNarrative(null);
      setNarrativeStatus('idle');
      return;
    }

    const cached = readBriefingCache(scope, nextDigest.lastSeq);
    if (cached) {
      setNarrative(cached.narrative);
      setNarrativeStatus('ready');
      return;
    }

    setNarrativeStatus('loading');
    try {
      const text = await generateBriefingNarrative(nextDigest, locale, t);
      setNarrative(text);
      setNarrativeStatus('ready');
      writeBriefingCache(scope, { lastSeq: nextDigest.lastSeq, narrative: text, generatedAtMs: Date.now() });
    } catch (err: unknown) {
      console.warn('[Briefing] narrative generation failed, falling back to digest bullets:', err);
      setNarrative(null);
      setNarrativeStatus('unavailable');
    }
  }, [projectId, locale, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!loading && (!digest || digest.eventCount === 0)) {
    return (
      <div
        data-testid="briefing"
        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <EmptyState
          icon={BrainIcon}
          title={t('agents.briefing.emptyTitle')}
          subtitle={t('agents.briefing.emptySubtitle')}
        />
      </div>
    );
  }

  const d = digest ?? buildBriefingDigest([]);
  const learnedCount = d.learned.capturedCount + d.learned.decisionCount + d.learned.promotedCount;
  const spentProjects = Object.keys(d.spent.byProject);

  return (
    <div
      data-testid="briefing"
      style={{
        padding: '20px 24px',
        overflowY: 'auto',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      <NarrativeBlock status={narrativeStatus} text={narrative} t={t} />

      <Section testId="briefing-section-shipped" title={t('agents.briefing.shipped')} count={d.shipped.length}>
        {d.shipped.length === 0 ? (
          <EmptyRow t={t} />
        ) : (
          d.shipped.map((item) => (
            <ShippedRow key={`${item.missionId}-${item.tsMs}`} item={item} onSelect={setSelectedMissionId} />
          ))
        )}
      </Section>

      <Section testId="briefing-section-asks" title={t('agents.briefing.needsAttention')} count={d.asks.length}>
        {d.asks.length === 0 ? (
          <EmptyRow t={t} />
        ) : (
          d.asks.map((item, idx) => (
            <AskRow key={`${item.missionId ?? item.projectId}-${item.tsMs}-${idx}`} item={item} onSelect={setSelectedMissionId} />
          ))
        )}
      </Section>

      <Section testId="briefing-section-learned" title={t('agents.briefing.learned')} count={learnedCount}>
        {learnedCount === 0 ? (
          <EmptyRow t={t} />
        ) : (
          <>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', marginBottom: d.learned.topItems.length > 0 ? 8 : 0 }}>
              {t('agents.briefing.learnedSummary', {
                captured: d.learned.capturedCount,
                decisions: d.learned.decisionCount,
                promoted: d.learned.promotedCount,
              })}
            </div>
            {d.learned.topItems.map((item, idx) => (
              <div key={`${item.kind}-${item.tsMs}-${idx}`} style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', padding: '2px 0' }}>
                · {item.label}
              </div>
            ))}
          </>
        )}
      </Section>

      <Section testId="briefing-section-spent" title={t('agents.briefing.spent')} count={spentProjects.length}>
        {spentProjects.length === 0 ? (
          <EmptyRow t={t} />
        ) : (
          <>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', marginBottom: 8 }}>
              {t('agents.briefing.spentSummary', { total: d.spent.totalUsd.toFixed(2), projects: spentProjects.length })}
            </div>
            {spentProjects.map((p) => (
              <div key={p} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'rgba(255,255,255,0.45)', padding: '2px 0' }}>
                <span style={{ fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}>{p}</span>
                <span>${d.spent.byProject[p].toFixed(3)}</span>
              </div>
            ))}
          </>
        )}
      </Section>

      <Section testId="briefing-section-nightshift" title={t('agents.briefing.nightShift')} count={d.nightShift.count}>
        {d.nightShift.count === 0 ? (
          <EmptyRow t={t} />
        ) : (
          <>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', marginBottom: 8 }}>
              {t('agents.briefing.nightShiftSummary', {
                count: d.nightShift.count,
                projects: Object.keys(d.nightShift.byProject).length,
              })}
            </div>
            {d.nightShift.items.map((item, idx) => (
              <NightShiftRow key={`${item.projectId}-${item.tsMs}-${idx}`} item={item} onSelect={setSelectedMissionId} />
            ))}
          </>
        )}
      </Section>
    </div>
  );
}

// ── Narrative ─────────────────────────────────────────────────────────

function NarrativeBlock({
  status,
  text,
  t,
}: {
  status: NarrativeStatus;
  text: string | null;
  t: (key: string) => string;
}) {
  if (status === 'loading') {
    return (
      <div
        data-testid="briefing-narrative-skeleton"
        role="status"
        aria-label={t('agents.briefing.narrativeLoading')}
        style={PANEL_STYLE}
      >
        <Skeleton width="100%" height={14} style={{ marginBottom: 8 }} />
        <Skeleton width="70%" height={14} />
      </div>
    );
  }
  if (status === 'ready' && text) {
    return (
      <div data-testid="briefing-narrative" style={PANEL_STYLE}>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: '#E2E2F0' }}>{text}</p>
      </div>
    );
  }
  if (status === 'unavailable') {
    return (
      <div data-testid="briefing-narrative-unavailable" style={{ ...PANEL_STYLE, color: 'rgba(255,255,255,0.35)', fontSize: 12 }}>
        {t('agents.briefing.narrativeUnavailable')}
      </div>
    );
  }
  return null;
}

// ── Section shell ─────────────────────────────────────────────────────

function Section({
  testId,
  title,
  count,
  children,
}: {
  testId: string;
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <div data-testid={testId} style={PANEL_STYLE}>
      <div style={SECTION_TITLE_STYLE}>
        {title} ({count})
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>
    </div>
  );
}

function EmptyRow({ t }: { t: (key: string) => string }) {
  return <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)' }}>{t('agents.briefing.emptySection')}</div>;
}

// ── Row renderers ─────────────────────────────────────────────────────

const KIND_COLORS: Record<string, string> = {
  completed: '#4ADE80',
  approved: '#4ADE80',
  blocked: '#FB923C',
  question: '#FBB924',
  budget_warning: '#FBB924',
  budget_exceeded: '#F87171',
};

function DrillRow({
  color,
  primary,
  secondary,
  missionId,
  onSelect,
  testId,
}: {
  color: string;
  primary: string;
  secondary: string;
  missionId: string | null;
  onSelect: (id: string | null) => void;
  testId: string;
}) {
  const content = (
    <>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{ fontWeight: 600, color: '#E2E2F0' }}>{primary}</span>
      <span style={{ color: 'rgba(255,255,255,0.35)' }}>· {secondary}</span>
    </>
  );
  const rowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 12,
    padding: '2px 0',
    width: '100%',
    background: 'transparent',
    border: 'none',
    textAlign: 'left',
    fontFamily: 'inherit',
  };

  if (!missionId) {
    return <div style={rowStyle}>{content}</div>;
  }
  return (
    <button data-testid={testId} onClick={() => onSelect(missionId)} style={{ ...rowStyle, cursor: 'pointer' }}>
      {content}
    </button>
  );
}

function ShippedRow({ item, onSelect }: { item: ShippedItem; onSelect: (id: string | null) => void }) {
  const secondary = item.proofRefs.length > 0 ? `${item.kind} · proof: ${item.proofRefs.join('/')}` : item.kind;
  return (
    <DrillRow
      testId={`briefing-shipped-${item.missionId}`}
      color={KIND_COLORS[item.kind]}
      primary={item.missionId}
      secondary={`${secondary} · ${item.projectId}`}
      missionId={item.missionId}
      onSelect={onSelect}
    />
  );
}

function AskRow({ item, onSelect }: { item: AskItem; onSelect: (id: string | null) => void }) {
  return (
    <DrillRow
      testId={`briefing-ask-${item.missionId ?? item.projectId}`}
      color={KIND_COLORS[item.kind] ?? 'rgba(255,255,255,0.4)'}
      primary={item.missionId ?? item.projectId}
      secondary={`${item.reason} · ${item.projectId}`}
      missionId={item.missionId}
      onSelect={onSelect}
    />
  );
}

function NightShiftRow({ item, onSelect }: { item: NightShiftItem; onSelect: (id: string | null) => void }) {
  return (
    <DrillRow
      testId={`briefing-nightshift-${item.missionId ?? item.projectId}-${item.tsMs}`}
      color="#A78BFA"
      primary={item.missionId ?? item.projectId}
      secondary={item.summary ?? item.projectId}
      missionId={item.missionId}
      onSelect={onSelect}
    />
  );
}
