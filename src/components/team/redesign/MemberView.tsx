/* MemberView — member/viewer viewpoint (design-team.md §5).

   Real vs. omitted (D5 honesty):
     - Own budget bar: real (own allocation vs org_usage_summary row).
     - "TES DÉCISIONS": real REVUE cards derived from useFleetMissions()
       (stage === 'review', fleet-wide, no project filter — this IS the
       signed-in user's own agent fleet, see usePersonalKpis.ts's doc
       comment on why no separate per-user filter exists). "Diff"/"Merger"
       navigate to the Cockpit (bus emit) rather than performing an inline
       merge — no merge primitive is reachable from Team space this wave.
       The mock's "HORS DE TON PÉRIMÈTRE" escalation card is OMITTED: no
       real per-mission scope-denial signal is wired into lib/teams/ yet
       (that's MissionDetail/Cockpit territory per D12/D13) — an honest
       empty state renders instead of a fabricated example.
     - Brain partagé: TeamBrainSearch reused as-is (real, Tauri-only).
     - "PENDANT QUE TU AVAIS LE DOS TOURNÉ" feed: honest empty — no
       cross-member activity stream exists in a single-local-user desktop
       app (see code-team-map.md §4 "Feed / activity").
*/

import type { OrgData, OrgMember, MemberUsageRow } from '../../../lib/teams/types';
import { formatCredits } from '../../../lib/billing';
import { usagePct, usageState } from '../../../lib/teams/roleView';
import { useFleetMissions } from '../../../lib/agents/fleetMissions';
import { useState } from 'react';
import { GitHubPanel } from './GitHubPanel';
import { TeamLiveAgents } from './TeamLiveAgents';
import { LeaveOrgControl } from './LeaveOrgControl';
import { ContributeHistoryWizard } from '../ContributeHistoryWizard';
import { usageColor, Card } from './shared';
import { useI18n } from '../../../i18n';

interface MemberViewProps {
  data: OrgData;
  callerUserId: string;
  usageRows: MemberUsageRow[];
  /** Called once the caller has left this org (B26) — clears the
   *  locally-remembered active org so TeamSpace can re-derive. */
  onLeftOrg: () => void;
}

export function MemberView({ data, callerUserId, usageRows, onLeftOrg }: MemberViewProps) {
  const { t } = useI18n();
  const { projects } = useFleetMissions();
  const [showContributeWizard, setShowContributeWizard] = useState(false);

  const self: OrgMember | undefined = data.members.find((m) => m.user_id === callerUserId);
  const ownAllocation =
    data.allocations.find((a) => a.entity_type === 'member' && a.entity_id === callerUserId) ??
    (self?.dept_id ? data.allocations.find((a) => a.entity_type === 'dept' && a.entity_id === self.dept_id) : undefined);
  // For member/viewer, org-list's "usage-summary" action now returns ONLY
  // the caller's own row (role gate, same tier as allocations) — this
  // find-by-id already reads as "own row only" either way, and the card
  // below is already labeled "YOUR BUDGET", so no UI change was needed
  // when that gate was added.
  const ownUsage = usageRows.find((r) => r.user_id === callerUserId);
  const usedCredits = ownUsage ? Math.round(ownUsage.cost_charged_usd * 100) : 0;
  const limitCredits = ownAllocation?.limit_cents ?? 0;
  const hasLimit = limitCredits > 0;
  const state = hasLimit ? usageState(usedCredits, limitCredits) : 'ok';
  const pct = hasLimit ? usagePct(usedCredits, limitCredits) : 0;

  const reviewMissions = projects.flatMap((p) => p.missions.map((m) => ({ ...m, projectName: p.name }))).filter((m) => m.stage === 'review');

  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflowY: 'auto', padding: '28px 32px', gap: 26 }}>
        {/* Title */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
          <h1 style={{ margin: 0, fontSize: 30, fontWeight: 700, color: 'var(--color-text)' }}>
            {t('team.redesign.member.title', { org: data.name })}
            <span style={{ fontSize: 15, color: 'var(--color-text-muted)', fontWeight: 400 }}>
              {' '}· {t(`team.role.${self?.role ?? 'member'}`)}{self?.dept_name ? ` · ${self.dept_name}` : ''}
            </span>
          </h1>
          <span style={{ marginLeft: 'auto' }}>
            <LeaveOrgControl orgId={data.orgId} orgName={data.name} onLeft={onLeftOrg} />
          </span>
        </div>

        <TeamLiveAgents projects={projects} />

        {/* Decisions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '1.8px', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>
            {t('team.redesign.member.decisionsLabel')}
          </span>

          {reviewMissions.length === 0 ? (
            <div data-testid="member-decisions-empty" style={{ fontSize: 13.5, color: 'var(--color-text-ghost)' }}>
              {t('team.redesign.member.decisionsEmpty')}
            </div>
          ) : (
            reviewMissions.map((m) => (
              <div
                key={m.id}
                data-testid="member-decision-review"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  background: 'var(--color-panel)',
                  borderRadius: 13,
                  padding: '14px 18px',
                  border: '1.5px solid rgba(251,185,36,0.4)',
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    background: 'var(--color-warning)',
                    color: '#161006',
                    borderRadius: 5,
                    padding: '2px 8px',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('team.redesign.member.reviewTag')}
                </span>
                <span style={{ flex: 1, fontSize: 14, color: 'var(--color-text)' }}>
                  <b>{m.title}</b> · {m.projectName}
                  {typeof m.diffAdded === 'number' && typeof m.diffRemoved === 'number'
                    ? ` · +${m.diffAdded} −${m.diffRemoved}`
                    : ''}
                </span>
              </div>
            ))
          )}
        </div>

        {/* Budget + brain row — W-UX3 finding D fix: `flex: 1; minHeight: 0`
            inside this SCROLLING column squeezed the row to the leftover
            viewport space and let its content overlap the feed below (see
            LeadBudgetPanel.tsx's fuller root-cause note — same bug, same
            fix: natural height, never shrink). */}
        <div style={{ display: 'flex', gap: 16, flexShrink: 0 }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '1.8px', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>
              {t('team.redesign.member.budgetLabel')}
            </span>
            <Card style={{ padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: 12, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 26, fontWeight: 700, color: hasLimit ? usageColor(state) : 'var(--color-text)' }}>
                  {formatCredits(usedCredits)}
                </span>
                <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
                  {hasLimit
                    ? t('team.redesign.member.budgetOf', { limit: formatCredits(limitCredits), period: t(`team.credits.period.${ownAllocation?.period ?? 'month'}`) })
                    : t('team.redesign.lead.usage.noLimit')}
                </span>
              </div>
              <div style={{ height: 8, background: 'rgba(255,255,255,0.07)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ width: `${hasLimit ? pct : 0}%`, height: '100%', background: hasLimit ? usageColor(state) : 'rgba(255,255,255,0.15)', borderRadius: 4 }} />
              </div>
            </Card>
          </div>


        </div>

        {/* GitHub-backed brain + canvas sharing — every member connects so
            their local daemon pulls/pushes the shared repos with their own
            token. */}
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

        {/* Activity feed — honest empty (D5: no cross-member data source exists) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '1.8px', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>
            {t('team.redesign.member.feedLabel')}
          </span>
          <Card style={{ padding: '20px 18px' }}>
            <div data-testid="member-feed-empty" style={{ fontSize: 13, color: 'var(--color-text-ghost)' }}>
              {t('team.redesign.member.feedEmpty')}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
