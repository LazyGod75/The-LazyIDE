/**
 * EmptyStateProposals — actionable proposal cards shown when the cockpit
 * has no missions. Each proposal is generated from a REAL bounded scan of
 * the open project (src/lib/agents/proposals.ts) — never a static/
 * hardcoded list (T2.6, spec §9). Three states: loading while the scan
 * runs, an honest "nothing to propose" empty state when the scan finds
 * nothing concrete, or the real proposal cards.
 */

import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import { useAppContext } from '../../app/AppContext';
import { EmptyState } from '../ui';
import { CpuIcon } from '../icons';
import { generateProposals, type MissionProposal } from '../../lib/agents/proposals';

interface EmptyStateProposalsProps {
  onLaunch: (prompt: string) => void;
}

type LoadState = 'loading' | 'ready' | 'empty';

export function EmptyStateProposals({ onLaunch }: EmptyStateProposalsProps) {
  const { t } = useI18n();
  const { projectRoot } = useAppContext();
  const [proposals, setProposals] = useState<MissionProposal[]>([]);
  const [state, setState] = useState<LoadState>('loading');

  useEffect(() => {
    let cancelled = false;
    setState('loading'); // eslint-disable-line react-hooks/set-state-in-effect
    generateProposals(projectRoot)
      .then((result) => {
        if (cancelled) return;
        setProposals(result);
        setState(result.length > 0 ? 'ready' : 'empty');
      })
      .catch(() => {
        // generateProposals() itself never throws, but keep this component
        // honest even if that guarantee is ever violated: fall back to the
        // empty state, never to filler cards.
        if (cancelled) return;
        setProposals([]);
        setState('empty');
      });
    return () => {
      cancelled = true;
    };
  }, [projectRoot]);

  if (state === 'loading') {
    return (
      <div data-testid="empty-state-proposals" style={S.container}>
        <span style={S.loadingText}>{t('agents.proposals.loading')}</span>
      </div>
    );
  }

  if (state === 'empty') {
    return (
      <div data-testid="empty-state-proposals" style={S.container}>
        <EmptyState
          icon={CpuIcon}
          title={t('agents.proposals.emptyTitle')}
          subtitle={t('agents.proposals.emptySubtitle')}
        />
      </div>
    );
  }

  return (
    <div data-testid="empty-state-proposals" style={S.container}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <div style={S.badge}>🚀</div>
        <h3 style={S.title}>{t('agents.proposals.title')}</h3>
        <p style={S.subtitle}>{t('agents.proposals.subtitle')}</p>
      </div>

      <div style={S.grid}>
        {proposals.map((proposal) => (
          <button
            key={proposal.id}
            data-testid={`proposal-${proposal.id}`}
            onClick={() => onLaunch(proposal.taskText)}
            style={S.card}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = `${proposal.accent}44`;
              e.currentTarget.style.background = '#1A1A22';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
              e.currentTarget.style.background = '#16161D';
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 18 }}>{proposal.icon}</span>
              <span style={S.cardTitle}>{t(proposal.titleKey, proposal.titleParams)}</span>
            </div>
            <span style={S.cardDesc}>{t(proposal.descKey, proposal.descParams)}</span>
            <div style={S.quoteRow}>
              <span data-testid="proposal-quote" style={S.quoteText}>
                {t('agents.proposals.quoteLine', {
                  costLo: proposal.quote.costUsd[0].toFixed(2),
                  costHi: proposal.quote.costUsd[1].toFixed(2),
                  durLo: String(proposal.quote.durationMin[0]),
                  durHi: String(proposal.quote.durationMin[1]),
                })}
              </span>
              <span style={S.sizeBadge}>{proposal.sizeClass.toUpperCase()}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────

const S = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center' as const,
    gap: 20,
    padding: '40px 32px',
    flex: 1,
  },
  loadingText: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.4)',
  },
  badge: {
    width: 56,
    height: 56,
    borderRadius: '50%',
    background: 'rgba(124,92,255,0.08)',
    border: '1px solid rgba(124,92,255,0.2)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 22,
  },
  title: {
    margin: 0,
    fontSize: 14,
    fontWeight: 600,
    color: 'rgba(255,255,255,0.6)',
  },
  subtitle: {
    margin: 0,
    fontSize: 12,
    color: 'rgba(255,255,255,0.28)',
    maxWidth: 320,
    textAlign: 'center' as const,
    lineHeight: 1.5,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: 12,
    maxWidth: 640,
    width: '100%',
  },
  card: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
    padding: '14px 16px',
    borderRadius: 10,
    border: '1px solid rgba(255,255,255,0.08)',
    background: '#16161D',
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left' as const,
    transition: 'border-color 0.15s, background 0.15s',
  },
  cardTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: '#E2E2F0',
  },
  cardDesc: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.35)',
    lineHeight: 1.4,
  },
  quoteRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 4,
  },
  quoteText: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.4)',
  },
  sizeBadge: {
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.04em',
    color: 'rgba(255,255,255,0.45)',
    background: 'rgba(255,255,255,0.06)',
    borderRadius: 4,
    padding: '2px 5px',
    flexShrink: 0,
  },
} as const;
