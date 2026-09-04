/* LeadRail — Lead view's right rail (design-team.md §4.2): real weekly
   aggregates from org_usage_summary + "LE MANAGER TE SIGNALE" cards
   derived ONLY from real conditions (D5's honesty mandate — no fabricated
   "brain reuse" or "reaction time" signals). 0 real signals -> an honest
   "rien à signaler" state, never a placeholder card.
*/

import type { OrgMember, OrgAllocation, MemberUsageRow } from '../../../lib/teams/types';
import { formatCredits } from '../../../lib/billing';
import { usageState } from '../../../lib/teams/roleView';
import { displayNameFor } from './shared';
import { useI18n } from '../../../i18n';

interface LeadRailProps {
  members: OrgMember[];
  allocations: OrgAllocation[];
  usageRows: MemberUsageRow[];
  seatsPaid: number;
}

interface ManagerSignal {
  id: string;
  tone: 'red' | 'amber' | 'violet';
  text: React.ReactNode;
}

export function LeadRail({ members, allocations, usageRows, seatsPaid }: LeadRailProps) {
  const { t } = useI18n();

  const totalEvents = usageRows.reduce((sum, r) => sum + r.events, 0);
  const totalCreditsConsumed = usageRows.reduce((sum, r) => sum + Math.round(r.cost_charged_usd * 100), 0);
  const activeMembers = usageRows.filter((r) => r.events > 0).length;

  const signals: ManagerSignal[] = [];

  // Real condition 1: any member at/above 90% of their own allocation.
  for (const m of members) {
    const alloc = allocations.find((a) => a.entity_type === 'member' && a.entity_id === m.user_id);
    if (!alloc || alloc.limit_cents <= 0) continue;
    const usage = usageRows.find((r) => r.user_id === m.user_id);
    const used = usage ? Math.round(usage.cost_charged_usd * 100) : 0;
    if (usageState(used, alloc.limit_cents) === 'hot') {
      signals.push({
        id: `hot-${m.user_id}`,
        tone: 'red',
        text: t('team.redesign.lead.signal.hotMember', {
          name: displayNameFor(m),
          used: formatCredits(used),
          limit: formatCredits(alloc.limit_cents),
        }),
      });
    }
  }

  // Real condition 2: free (unfilled) paid seats.
  const freeSeats = seatsPaid - members.length;
  if (freeSeats > 0) {
    signals.push({
      id: 'free-seats',
      tone: 'violet',
      text: t('team.redesign.lead.signal.freeSeats', { count: freeSeats, seats: seatsPaid }),
    });
  }

  const toneStyle: Record<ManagerSignal['tone'], { border: string }> = {
    red: { border: '1px solid rgba(248,113,113,0.35)' },
    amber: { border: '1px solid rgba(251,185,36,0.3)' },
    violet: { border: '1px solid rgba(124,92,255,0.3)' },
  };

  return (
    <div
      style={{
        width: 420,
        borderLeft: '1px solid var(--color-border)',
        background: 'var(--color-panel)',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        overflowY: 'auto',
      }}
    >
      {/* Weekly KPIs */}
      <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--color-border)' }}>
        <div
          style={{
            fontSize: 11.5,
            fontWeight: 700,
            letterSpacing: '1.8px',
            textTransform: 'uppercase',
            color: 'var(--color-text-muted)',
            marginBottom: 4,
          }}
        >
          {t('team.redesign.lead.rail.title')}
        </div>
        {/* Money-pool disambiguation (David 2026-08-14): org_usage_summary
            sums EVERY usage_events row for the member — both the personal-
            plan path (org_id null, billed against the member's own
            credits_remaining_cents) and the org-wallet path (org_id =
            this org, billed against the pot commun below). It is NOT a
            team-pool balance, so it must never sit unlabeled next to
            "TEAM BUDGET" — see LeadBudgetPanel for the actual shared pool. */}
        <div style={{ fontSize: 11, color: 'var(--color-text-ghost)', marginBottom: 12, lineHeight: 1.4 }}>
          {t('team.redesign.lead.rail.subtitle')}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div style={{ background: 'var(--color-panel-2)', borderRadius: 10, padding: '12px 14px' }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-warning-text)' }}>
              {formatCredits(totalCreditsConsumed)}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
              {t('team.redesign.lead.rail.creditsConsumed')}
            </div>
          </div>
          <div style={{ background: 'var(--color-panel-2)', borderRadius: 10, padding: '12px 14px' }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-text)' }}>{totalEvents}</div>
            <div style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>{t('team.redesign.lead.rail.events')}</div>
          </div>
          <div style={{ background: 'var(--color-panel-2)', borderRadius: 10, padding: '12px 14px', gridColumn: '1 / -1' }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-success)' }}>{activeMembers}</div>
            <div style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>{t('team.redesign.lead.rail.activeMembers')}</div>
          </div>
        </div>
      </div>

      {/* Manager signals */}
      <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 11, flex: 1 }}>
        <div
          style={{
            fontSize: 11.5,
            fontWeight: 700,
            letterSpacing: '1.8px',
            textTransform: 'uppercase',
            color: 'var(--color-accent-pale)',
          }}
        >
          {t('team.redesign.lead.rail.signalsTitle')}
        </div>

        {signals.length === 0 ? (
          // W-UX-team finding (David 2026-08-14): a single left-aligned line
          // of muted text inside this flex:1 panel left a large dead void
          // below it (the rail stretches to the viewport's full height).
          // Center the reassurance state instead so the empty space reads
          // as an intentional "all clear", not a broken layout.
          <div
            data-testid="lead-signals-empty"
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              textAlign: 'center',
              padding: '24px 12px',
            }}
          >
            <span style={{ fontSize: 22, color: 'var(--color-success)' }}>✓</span>
            <span style={{ fontSize: 13, color: 'var(--color-text-ghost)' }}>
              {t('team.redesign.lead.rail.signalsEmpty')}
            </span>
          </div>
        ) : (
          signals.map((s) => (
            <div
              key={s.id}
              data-testid={`lead-signal-${s.id}`}
              style={{
                background: 'var(--color-panel-2)',
                borderRadius: 11,
                padding: '13px 16px',
                fontSize: 13,
                lineHeight: 1.55,
                color: 'var(--color-text-secondary)',
                ...toneStyle[s.tone],
              }}
            >
              {s.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
