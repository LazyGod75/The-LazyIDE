/* LeadMemberRow — one row in the Lead view's MEMBRES list
   (design-team.md §4.1.2). Real budget bar (allocation vs org_usage_summary),
   real "neurones apportés" column OMITTED (D5e — no per-member attribution
   exists), click opens the member detail drawer.
*/

import type { OrgMember, OrgAllocation, MemberUsageRow } from '../../../lib/teams/types';
import { formatCredits } from '../../../lib/billing';
import { usagePct, usageState } from '../../../lib/teams/roleView';
import { Avatar, RedesignRoleBadge, BudgetBarTrack, usageColor, usageBorder, displayNameFor } from './shared';
import { useI18n } from '../../../i18n';

interface LeadMemberRowProps {
  member: OrgMember;
  allocation: OrgAllocation | null;
  usage: MemberUsageRow | undefined;
  onOpenDrawer: (userId: string) => void;
  onRallonger?: (member: OrgMember, allocation: OrgAllocation) => void;
}

export function LeadMemberRow({ member, allocation, usage, onOpenDrawer, onRallonger }: LeadMemberRowProps) {
  const { t } = useI18n();
  const name = displayNameFor(member);
  const usedCredits = usage ? Math.round(usage.cost_charged_usd * 100) : 0;
  const limitCredits = allocation?.limit_cents ?? 0;
  const hasLimit = limitCredits > 0;
  const state = hasLimit ? usageState(usedCredits, limitCredits) : 'ok';
  const pct = hasLimit ? usagePct(usedCredits, limitCredits) : 0;

  const noteText =
    state === 'hot'
      ? t('team.redesign.lead.usage.hot')
      : state === 'warm'
        ? t('team.redesign.lead.usage.warm')
        : '';

  return (
    <div
      data-testid="lead-member-row"
      role="button"
      tabIndex={0}
      onClick={() => onOpenDrawer(member.user_id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onOpenDrawer(member.user_id);
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        background: 'var(--color-panel)',
        border: `1px solid ${usageBorder(state)}`,
        borderRadius: 13,
        padding: '20px 22px',
        cursor: 'pointer',
      }}
    >
      <Avatar id={member.user_id} name={name} />

      <div style={{ width: 210, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 15.5, fontWeight: 700, color: 'var(--color-text)' }}>
          {name}
          <RedesignRoleBadge role={member.role} />
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>
          {member.dept_name ?? t('team.redesign.lead.noDept')}
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: hasLimit ? usageColor(state) : 'var(--color-text)' }}>
            {formatCredits(usedCredits)}
          </span>
          <span style={{ fontSize: 12, color: 'var(--color-text-ghost)' }}>
            {hasLimit
              ? t('team.redesign.lead.usage.slashLimit', { limit: formatCredits(limitCredits), period: t(`team.credits.period.${allocation?.period ?? 'month'}`) })
              : t('team.redesign.lead.usage.noLimit')}
          </span>
          {noteText && (
            <span style={{ marginLeft: 'auto', fontSize: 11.5, color: usageColor(state) }}>{noteText}</span>
          )}
        </div>
        <BudgetBarTrack pct={hasLimit ? pct : 0} color={hasLimit ? usageColor(state) : 'rgba(255,255,255,0.15)'} />
        {/* Money-pool disambiguation (David 2026-08-14): usedCredits comes
            from org_usage_summary, which totals ALL of this member's
            usage_events — personal-plan usage AND org-wallet usage alike.
            It is this MEMBER's own activity total, never money drawn from
            the team's shared pool (see the TEAM BUDGET panel below) — spell
            that out so the row can never be misread as team spend. */}
        <span style={{ fontSize: 10.5, color: 'var(--color-text-ghost)', fontStyle: 'italic' }}>
          {t('team.redesign.lead.usage.ownActivityHint')}
        </span>
      </div>

      {state === 'hot' && allocation && onRallonger && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRallonger(member, allocation);
          }}
          data-testid={`rallonger-${member.user_id}`}
          style={{
            padding: '8px 15px',
            borderRadius: 9,
            background: 'var(--color-accent)',
            color: '#fff',
            fontSize: 12.5,
            fontWeight: 700,
            border: 'none',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            flexShrink: 0,
            fontFamily: 'inherit',
          }}
        >
          {t('team.redesign.lead.rallonger')}
        </button>
      )}
    </div>
  );
}
