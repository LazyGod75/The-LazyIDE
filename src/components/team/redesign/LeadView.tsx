/* LeadView — org-admin / team-lead viewpoint (design-team.md §4). Real
   member list with budget bars (org_usage_summary), real member detail
   drawer, real team budget panel (pot commun + dept allocations), real
   weekly-KPI + manager-signals rail.
*/

import { useState } from 'react';
import type { OrgData, OrgMember, MemberUsageRow } from '../../../lib/teams/types';
import { setAllocation } from '../../../lib/teams/orgApi';
import { LeadMemberRow } from './LeadMemberRow';
import { MemberDetailDrawer } from './MemberDetailDrawer';
import { LeadBudgetPanel } from './LeadBudgetPanel';
import { LeadRail } from './LeadRail';
import { TeamFleetCockpit } from './TeamFleetCockpit';
import { PromotionPipelinePanel } from './PromotionPipelinePanel';
import { InvitationsPanel } from './InvitationsPanel';
import { LeaveOrgControl } from './LeaveOrgControl';
import { DeleteOrgPanel } from './DeleteOrgPanel';
import { GitHubPanel } from './GitHubPanel';
import { ContributeHistoryWizard } from '../ContributeHistoryWizard';
import { Card } from './shared';
import { useToast } from '../../ui/Toast';
import { formatCredits } from '../../../lib/billing';
import { useI18n } from '../../../i18n';

interface LeadViewProps {
  data: OrgData;
  usageRows: MemberUsageRow[];
  callerUserId: string;
  onRefetch: () => void;
  /** Called once the caller has left (non-owner) or deleted (owner) this
   *  org — clears the locally-remembered active org so TeamSpace can
   *  re-derive the right viewpoint (B26). */
  onLeftOrg: () => void;
}

/** Picks the `<base>One` or `<base>Many` i18n key by the ACTIVE locale's
 *  CLDR cardinal rule (Intl.PluralRules) — 'one' → singular, everything
 *  else → the plural/other form. Locale-correct for fr (0,1 singular), en
 *  (1 singular), and a no-op for ja/zh (always 'other'). Falls back to the
 *  English rule if a locale is somehow unknown to Intl. */
function pluralKey(base: string, count: number, locale: string): string {
  let category: Intl.LDMLPluralRule = count === 1 ? 'one' : 'other';
  try {
    category = new Intl.PluralRules(locale).select(count);
  } catch {
    // keep the count === 1 fallback
  }
  return `${base}${category === 'one' ? 'One' : 'Many'}`;
}

export function LeadView({ data, usageRows, callerUserId, onRefetch, onLeftOrg }: LeadViewProps) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const [drawerUserId, setDrawerUserId] = useState<string | null>(null);
  const [rallongerDone, setRallongerDone] = useState<{ name: string; amount: number } | null>(null);
  const [showContributeWizard, setShowContributeWizard] = useState(false);
  const callerRole = data.members.find((m) => m.user_id === callerUserId)?.role;
  const isOwner = data.ownerUserId === callerUserId;

  const usageByUserId = new Map(usageRows.map((r) => [r.user_id, r]));
  const deptUsedCents = new Map<string, number>();
  for (const row of usageRows) {
    if (!row.dept_id) continue;
    deptUsedCents.set(row.dept_id, (deptUsedCents.get(row.dept_id) ?? 0) + Math.round(row.cost_charged_usd * 100));
  }

  const drawerMember: OrgMember | null = data.members.find((m) => m.user_id === drawerUserId) ?? null;
  const drawerAllocation = drawerMember
    ? data.allocations.find((a) => a.entity_type === 'member' && a.entity_id === drawerMember.user_id) ?? null
    : null;

  async function handleRallonger(member: OrgMember, currentLimitCents: number, period: string) {
    // "Rallonger" = a real allocation bump — a pragmatic +50% step, applied
    // through the existing setAllocation mutation (same API MembersList /
    // AllocationForm already use). Generates the confirmation from the
    // ACTUAL member + amount, not the mock's hardcoded string.
    const newLimit = Math.round(currentLimitCents * 1.5);
    const result = await setAllocation(data.orgId, 'member', member.user_id, newLimit, period);
    if (result.success) {
      setRallongerDone({ name: member.display_name ?? member.email ?? member.user_id, amount: newLimit });
      onRefetch();
    } else {
      toast(result.error, 'error');
    }
  }

  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      {/* Main column */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflowY: 'auto', padding: '28px 32px', gap: 26 }}>
        {/* Title row */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
          <h1 style={{ margin: 0, fontSize: 30, fontWeight: 700, color: 'var(--color-text)' }}>{data.name}</h1>
          <span style={{ fontSize: 15, color: 'var(--color-text-muted)' }}>
            {t('team.redesign.lead.titleMeta', {
              // Proper singular/plural agreement — « 1 humain » not « 1 humains ».
              // This flat i18n dict has no ICU plurals, so the CLDR rule for the
              // ACTIVE locale (via Intl.PluralRules) picks the singular vs plural
              // key: French treats 0 AND 1 as singular (« 0 département »),
              // English only 1 (« 0 departments »), ja/zh have no inflection.
              humans: t(pluralKey('team.redesign.lead.humans', data.members.length, locale), { count: data.members.length }),
              depts: t(pluralKey('team.redesign.lead.depts', data.departments.length, locale), { count: data.departments.length }),
            })}
          </span>
          {!isOwner && (
            <span style={{ marginLeft: 'auto' }}>
              <LeaveOrgControl orgId={data.orgId} orgName={data.name} onLeft={onLeftOrg} />
            </span>
          )}
        </div>

        {/* Members section */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                fontSize: 11.5,
                fontWeight: 700,
                letterSpacing: '1.8px',
                textTransform: 'uppercase',
                color: 'var(--color-text-muted)',
              }}
            >
              {t('team.redesign.lead.membersLabel')}
            </span>
            <span style={{ fontSize: 12, color: 'var(--color-text-ghost)' }}>
              {t('team.redesign.lead.seatsUsed', { used: data.members.length, total: data.seats })}
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {data.members.map((member) => {
              const allocation = data.allocations.find((a) => a.entity_type === 'member' && a.entity_id === member.user_id) ?? null;
              return (
                <LeadMemberRow
                  key={member.user_id}
                  member={member}
                  allocation={allocation}
                  usage={usageByUserId.get(member.user_id)}
                  onOpenDrawer={setDrawerUserId}
                  onRallonger={allocation ? (m, a) => handleRallonger(m, a.limit_cents, a.period) : undefined}
                />
              );
            })}
          </div>

          {rallongerDone && (
            <div
              data-testid="rallonger-confirmation"
              style={{
                background: 'rgba(74,222,128,0.08)',
                border: '1px solid rgba(74,222,128,0.35)',
                borderRadius: 11,
                padding: '12px 16px',
                fontSize: 13.5,
                color: 'var(--color-success-text)',
              }}
            >
              {t('team.redesign.lead.rallongerDone', { name: rallongerDone.name, amount: formatCredits(rallongerDone.amount) })}
            </div>
          )}
        </div>

        {/* T4.7: cross-project fleet KPIs (missions, cost, tokens, brain
            promotions) — null when not entitled or outside Tauri, see
            TeamFleetCockpit's own doc comment. */}
        <TeamFleetCockpit members={data.members} />

        <LeadBudgetPanel
          orgId={data.orgId}
          creditsRemainingCents={data.creditsRemainingCents}
          lastMonthlyGrantCents={data.lastMonthlyGrantCents}
          allocations={data.allocations}
          departments={data.departments}
          members={data.members}
          deptUsedCents={deptUsedCents}
          onRefetch={onRefetch}
        />

        {/* B27: pending invitations + revoke + "+ Inviter" — org-admin only
            (org-list only populates data.invitations for an org-admin caller). */}
        {callerRole === 'org-admin' && (
          <InvitationsPanel orgId={data.orgId} invitations={data.invitations} onRefetch={onRefetch} />
        )}

        {/* GitHub-backed brain + canvas sharing — the lead provisions the
            shared repos and every member connects. */}
        <GitHubPanel orgId={data.orgId} />

        <Card style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
            {t('contribute.title')}
          </div>
          <button
            onClick={() => setShowContributeWizard(true)}
            style={{
              padding: '8px 16px',
              background: 'var(--color-accent)',
              border: 'none',
              borderRadius: 7,
              color: '#fff',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              alignSelf: 'flex-start',
            }}
          >
            {t('contribute.title')}
          </button>
        </Card>

        {showContributeWizard && (
          <Card style={{ padding: '20px 18px' }}>
            <ContributeHistoryWizard
              orgId={data.orgId}
              onDone={() => setShowContributeWizard(false)}
              onCancel={() => setShowContributeWizard(false)}
            />
          </Card>
        )}

        {/* T3.3/T4.4: curated root-trunk promotion pipeline — manual/visible
            trigger, org-admin only (see PromotionPipelinePanel's own doc
            comment for why this stays a button, not a daemon cadence). */}
        {callerRole === 'org-admin' && <PromotionPipelinePanel />}

        {/* B26: danger zone — owner only. */}
        {isOwner && (
          <DeleteOrgPanel orgId={data.orgId} orgName={data.name} onDeleted={onLeftOrg} />
        )}
      </div>

      <LeadRail members={data.members} allocations={data.allocations} usageRows={usageRows} seatsPaid={data.seats} />

      {drawerMember && (
        <MemberDetailDrawer
          orgId={data.orgId}
          member={drawerMember}
          allocation={drawerAllocation}
          usage={usageByUserId.get(drawerMember.user_id)}
          callerIsOrgAdmin={callerRole === 'org-admin'}
          isOwner={drawerMember.user_id === data.ownerUserId}
          onClose={() => setDrawerUserId(null)}
          onRefetch={onRefetch}
          onRemoved={() => setDrawerUserId(null)}
        />
      )}
    </div>
  );
}
