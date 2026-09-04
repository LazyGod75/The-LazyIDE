/* MultiTeamView — rendered ONLY when the backend actually returns >1 org
   for the signed-in user (D5d, fail-closed; deriveTeamView in roleView.ts
   gates this). Real per-org fields only: name, the caller's role IN that
   org, seat count, member count. The mock's cross-team inbox ("À TOI DE
   JOUER") and per-org live-status/pending/agent counts have NO real data
   source (no cross-org decision queue, no per-org fleet attribution
   exists anywhere in lib/teams/ or lib/agents/) — omitted rather than
   fabricated; each team card instead shows only what's real.
*/

import { useState } from 'react';
import type { OrgMembership } from '../../../lib/teams/useOrgMemberships';
import { colorForId, RedesignRoleBadge, Card } from './shared';
import { emit } from '../../../lib/bus';
import { useI18n } from '../../../i18n';
import { switchTeamBrain } from '../../../lib/teams/activateTeamBrain';

interface MultiTeamViewProps {
  memberships: OrgMembership[];
  onSwitchOrg: (orgId: string) => void;
}

export function MultiTeamView({ memberships, onSwitchOrg }: MultiTeamViewProps) {
  const { t } = useI18n();
  const [switching, setSwitching] = useState<string | null>(null);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflowY: 'auto', padding: '24px 28px', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, color: 'var(--color-text)' }}>
          {t('team.redesign.multi.title', { count: memberships.length })}
        </h1>
        <span style={{ fontSize: 15, color: 'var(--color-text-muted)' }}>{t('team.redesign.multi.subtitle')}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14 }}>
        {memberships.map((org) => (
          <Card key={org.orgId} style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 12, height: 12, borderRadius: 4, background: colorForId(org.orgId) }} />
              <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--color-text)' }}>{org.orgName}</span>
              <RedesignRoleBadge role={org.role} />
            </div>
            <div style={{ display: 'flex', gap: 8, fontSize: 12, color: 'var(--color-text-secondary)', flexWrap: 'wrap' }}>
              <span style={{ background: 'var(--color-panel-2)', borderRadius: 6, padding: '4px 10px' }}>
                {t('team.redesign.multi.humans', { count: org.memberCount })}
              </span>
              <span style={{ background: 'var(--color-panel-2)', borderRadius: 6, padding: '4px 10px' }}>
                {t('team.redesign.multi.seats', { count: org.seats })}
              </span>
            </div>
            <button
              onClick={async () => {
                if (!org.brainRepoUrl) return;
                setSwitching(org.orgId);
                const result = await switchTeamBrain(org.orgId, org.brainRepoUrl, org.role);
                setSwitching(null);
                if (!result.ok) return;
                onSwitchOrg(org.orgId);
                emit('nav:navigateSpace', 'team');
              }}
              disabled={!org.brainRepoUrl || switching === org.orgId}
              data-testid={`open-org-${org.orgId}`}
              style={{
                marginTop: 'auto',
                textAlign: 'center',
                padding: 9,
                borderRadius: 9,
                border: '1px solid rgba(255,255,255,0.15)',
                background: 'transparent',
                color: org.brainRepoUrl ? 'var(--color-text)' : 'var(--color-text-ghost)',
                fontSize: 13,
                fontWeight: 600,
                cursor: org.brainRepoUrl && switching !== org.orgId ? 'pointer' : 'not-allowed',
                fontFamily: 'inherit',
                opacity: switching === org.orgId ? 0.6 : 1,
              }}
            >
              {switching === org.orgId
                ? '…'
                : org.brainRepoUrl
                  ? t('team.redesign.multi.openCockpit', { name: org.orgName })
                  : 'Brain not published'}
            </button>
          </Card>
        ))}
      </div>
    </div>
  );
}
