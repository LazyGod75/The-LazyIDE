/* SoloView — Team space viewpoint for a user with no org membership at all
   (design-team.md §3). Hero + 2 real option cards + a right-rail of 4 real
   personal KPIs + a brain callout using the real neuron count.
*/

import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { pluralKey } from '../../../i18n/plural';
import { usePersonalKpis } from '../../../lib/teams/usePersonalKpis';
import { formatCredits } from '../../../lib/billing';
import { emit } from '../../../lib/bus';
import { CreateAndInviteModal } from './CreateAndInviteModal';
import { CreateTeamModal } from './CreateTeamModal';
import { JoinOrgModal } from './JoinOrgModal';
import { GitHubPanel } from './GitHubPanel';
import { TeamLiveAgents } from './TeamLiveAgents';
import { useFleetMissions } from '../../../lib/agents/fleetMissions';
import { SectionLabel, KpiTile, Card } from './shared';
import { BrainIcon } from '../../icons';

interface SoloViewProps {
  onOrgReady: (orgId: string) => void;
}

type ActiveModal = 'invite' | 'create' | 'join' | null;

export function SoloView({ onOrgReady }: SoloViewProps) {
  const { t, locale } = useI18n();
  const kpis = usePersonalKpis();
  const { projects } = useFleetMissions();
  const [activeModal, setActiveModal] = useState<ActiveModal>(null);
  const [invited, setInvited] = useState(false);

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 60,
        padding: '0 80px',
        overflowY: 'auto',
      }}
    >
      {/* Left column */}
      <div style={{ maxWidth: 620, display: 'flex', flexDirection: 'column', gap: 22 }}>
        <h1 style={{ margin: 0, fontSize: 38, fontWeight: 700, lineHeight: 1.2, color: 'var(--color-text)' }}>
          {t('team.redesign.solo.heroLine1')}
          <br />
          <span style={{ color: 'var(--color-text-muted)' }}>{t('team.redesign.solo.heroLine2')}</span>
        </h1>
        <p style={{ margin: 0, fontSize: 16, lineHeight: 1.65, color: 'var(--color-text-secondary)' }}>
          {t('team.redesign.solo.subhead')}
        </p>

        <div style={{ display: 'flex', gap: 12 }}>
          {/* Card A — Inviter un coéquipier */}
          <Card
            style={{ flex: 1, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}
          >
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text)' }}>
              {t('team.redesign.solo.cardInvite.title')}
            </div>
            <div style={{ fontSize: 13.5, lineHeight: 1.55, color: 'var(--color-text-muted)' }}>
              {t('team.redesign.solo.cardInvite.body')}
            </div>
            <button
              onClick={() => setActiveModal('invite')}
              data-testid="solo-invite-cta"
              style={{
                marginTop: 'auto',
                textAlign: 'center',
                padding: 10,
                borderRadius: 9,
                border: '1px solid rgba(255,255,255,0.2)',
                background: 'transparent',
                color: 'var(--color-text)',
                fontSize: 14,
                fontWeight: 600,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              {t('team.redesign.solo.cardInvite.cta')}
            </button>
          </Card>

          {/* Card B — Créer une team */}
          <Card
            border="1px solid rgba(124,92,255,0.4)"
            style={{ flex: 1, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}
          >
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text)' }}>
              {t('team.redesign.solo.cardCreate.title')}{' '}
              <span
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  background: 'var(--color-accent)',
                  color: '#fff',
                  borderRadius: 4,
                  padding: '1px 7px',
                  verticalAlign: 'middle',
                }}
              >
                {t('team.redesign.solo.cardCreate.badge')}
              </span>
            </div>
            <div style={{ fontSize: 13.5, lineHeight: 1.55, color: 'var(--color-text-muted)' }}>
              {t('team.redesign.solo.cardCreate.body')}
            </div>
            <button
              onClick={() => setActiveModal('create')}
              data-testid="solo-create-cta"
              style={{
                marginTop: 'auto',
                background: 'var(--color-accent)',
                color: '#fff',
                fontSize: 14,
                fontWeight: 700,
                padding: 10,
                borderRadius: 9,
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {t('team.redesign.solo.cardCreate.cta')}
            </button>
          </Card>
        </div>

        {invited && (
          <div
            data-testid="solo-invite-confirmation"
            style={{
              background: 'rgba(74,222,128,0.08)',
              border: '1px solid rgba(74,222,128,0.35)',
              borderRadius: 11,
              padding: '13px 17px',
              fontSize: 14,
              color: 'var(--color-success-text)',
            }}
          >
            {t('team.redesign.solo.inviteConfirmation')}
          </div>
        )}

        {/* Not in the design mock, but a real join-via-link capability must
            stay reachable somewhere (see JoinOrgModal.tsx's doc comment). */}
        <button
          onClick={() => setActiveModal('join')}
          data-testid="solo-join-link"
          style={{
            alignSelf: 'flex-start',
            background: 'none',
            border: 'none',
            color: 'var(--color-text-ghost)',
            fontSize: 12.5,
            cursor: 'pointer',
            fontFamily: 'inherit',
            padding: 0,
            textDecoration: 'underline',
          }}
        >
          {t('team.redesign.solo.joinLink')}
        </button>
      </div>

      {/* Right column — personal KPIs + GitHub connect */}
      <div style={{ width: 460, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <SectionLabel>{t('team.redesign.solo.kpiLabel')}</SectionLabel>
        <TeamLiveAgents projects={projects} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <KpiTile value={kpis.agentsActive} label={t('team.redesign.solo.kpi.agentsActive')} />
          <KpiTile
            value={kpis.mergedThisWeek}
            valueColor="var(--color-success)"
            label={t('team.redesign.solo.kpi.mergedThisWeek')}
          />
          <KpiTile
            value={kpis.creditsRemaining === null ? '—' : formatCredits(kpis.creditsRemaining)}
            valueColor="var(--color-warning-text)"
            label={t('team.redesign.solo.kpi.credits')}
            testId="solo-credits-kpi"
            onClick={() => emit('nav:openAccountPopover', undefined)}
          />
          <KpiTile
            value={
              // QA fix (no emoji in UI chrome): this used to inline the raw
              // brain emoji (\u{1F9E0}) into the tile's value string. Reuse
              // the same drawn BrainIcon used for "brain" chrome elsewhere
              // (SpacesRail's nav icon, CodeSidebarBrain's header) instead
              // of a second icon implementation — currentColor stroke
              // inherits KpiTile's valueColor with no extra prop needed.
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <BrainIcon size={20} />
                {formatCredits(kpis.brainNeurons)}
              </span>
            }
            valueColor="var(--color-accent-pale)"
            label={t('team.redesign.solo.kpi.brainNeurons')}
          />
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            background: 'rgba(124,92,255,0.06)',
            border: '1px solid rgba(124,92,255,0.3)',
            borderRadius: 12,
            padding: '14px 17px',
            fontSize: 13.5,
            lineHeight: 1.55,
            color: 'var(--color-accent-pale)',
          }}
        >
          {/* QA fix (no emoji in UI chrome): the locale string used to carry
              a leading brain emoji inline (see codespace.brain.title's own
              fix for the same class of issue) — the emoji is now stripped
              from the six locale strings and BrainIcon renders alongside
              instead, reusing the same drawn glyph as the tile above. */}
          <BrainIcon size={15} />
          <span>{t(pluralKey('team.redesign.solo.brainCallout', kpis.brainNeurons, locale), { count: formatCredits(kpis.brainNeurons) })}</span>
        </div>

        {/* GitHub connect — available before org creation so the first thing
            the user does after creating their team is provision the repos. */}
        <GitHubPanel orgId="" />
      </div>

      {activeModal === 'invite' && (
        <CreateAndInviteModal
          onClose={() => setActiveModal(null)}
          onDone={(orgId, wasInvited) => {
            setActiveModal(null);
            if (wasInvited) setInvited(true);
            onOrgReady(orgId);
          }}
        />
      )}
      {activeModal === 'create' && (
        <CreateTeamModal
          onClose={() => setActiveModal(null)}
          onCreated={(orgId) => {
            setActiveModal(null);
            onOrgReady(orgId);
          }}
        />
      )}
      {activeModal === 'join' && (
        <JoinOrgModal
          onClose={() => setActiveModal(null)}
          onJoined={(orgId) => {
            setActiveModal(null);
            onOrgReady(orgId);
          }}
        />
      )}
    </div>
  );
}
