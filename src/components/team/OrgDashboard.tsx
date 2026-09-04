/* OrgDashboard — main org management screen.
   Header (name + seats) + Members + Pending Invitations + Invite button.
   Visible after org is loaded.
*/

import { useState } from 'react';
import { MembersList } from './MembersList';
import { InvitationsList } from './InvitationsList';
import { InviteModal } from './InviteModal';
import { DepartmentsSection } from './DepartmentsSection';
import { CreditsSection } from './CreditsSection';
import type { OrgData } from '../../lib/teams/types';
import { Spinner, SkeletonList } from '../ui';
import { useI18n } from '../../i18n';

// ── Props ─────────────────────────────────────────────────────────

interface OrgDashboardProps {
  data: OrgData;
  loading: boolean;
  callerUserId: string;
  onRefetch: () => void;
}

// ── Section title ─────────────────────────────────────────────────

function SectionTitle({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '12px 14px 8px',
        borderBottom: '1px solid var(--color-border)',
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--color-text-muted)',
        }}
      >
        {children}
      </span>
      {count !== undefined && (
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: 'var(--color-text-ghost)',
            background: 'rgba(255,255,255,0.04)',
            borderRadius: 99,
            padding: '1px 7px',
          }}
        >
          {count}
        </span>
      )}
    </div>
  );
}

// ── OrgHeader ─────────────────────────────────────────────────────

function OrgHeader({
  orgId,
  memberCount,
  name,
  seats,
}: {
  orgId: string;
  memberCount: number;
  name?: string;
  seats?: number;
}) {
  const { t } = useI18n();
  const shortId = orgId.slice(0, 8);
  const title = name && name.length > 0 ? name : t('team.org.title');
  const used = memberCount;
  const total = seats !== undefined ? seats : '–';

  return (
    <div
      style={{
        padding: '16px 20px',
        background: 'var(--color-panel)',
        borderBottom: '1px solid var(--color-border)',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
      }}
    >
      {/* Org icon */}
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 10,
          background: 'linear-gradient(135deg, #7C5CFF, #9D7FFF)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 18,
          flexShrink: 0,
          boxShadow: '0 4px 12px rgba(124,92,255,0.3)',
        }}
      >
        ⬡
      </div>

      {/* Name + short id */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 15,
            fontWeight: 700,
            color: 'var(--color-text)',
            letterSpacing: '-0.01em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-ghost)', marginTop: 2, fontFamily: 'var(--font-mono)' }}>
          {shortId}
        </div>
      </div>

      {/* Seats counter */}
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text)', letterSpacing: '-0.02em' }}>
          {used}<span style={{ color: 'var(--color-text-ghost)', fontWeight: 400, fontSize: 14 }}>/{total}</span>
        </div>
        <div style={{ fontSize: 10, color: 'var(--color-text-ghost)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 1 }}>
          {t('team.org.seats')}
        </div>
      </div>
    </div>
  );
}

// ── OrgDashboard ──────────────────────────────────────────────────

export function OrgDashboard({ data, loading, callerUserId, onRefetch }: OrgDashboardProps) {
  const { t } = useI18n();
  const [showInviteModal, setShowInviteModal] = useState(false);

  const callerMember = data.members.find((m) => m.user_id === callerUserId);
  const isAdmin = callerMember?.role === 'org-admin';

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        minHeight: 0,
        background: 'var(--color-bg)',
      }}
    >
      {/* Header */}
      <OrgHeader
        orgId={data.orgId}
        memberCount={data.members.length}
        name={data.name}
        seats={data.seats}
      />

      {/* Scrollable content */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
        }}
      >
        {/* Members section */}
        <div
          style={{
            margin: '16px 16px 0',
            background: 'var(--color-panel)',
            borderRadius: 10,
            border: '1px solid var(--color-border)',
            overflow: 'hidden',
          }}
        >
          <SectionTitle count={data.members.length}>
            {t('team.members.title')}
          </SectionTitle>

          {loading ? (
            <div style={{ padding: '8px 0' }}>
              <SkeletonList count={3} />
            </div>
          ) : (
            <MembersList
              orgId={data.orgId}
              members={data.members}
              departments={data.departments}
              callerUserId={callerUserId}
              isAdmin={isAdmin}
              onRefetch={onRefetch}
            />
          )}
        </div>

        {/* Invitations section — admin only */}
        {isAdmin && (
          <div
            style={{
              margin: '12px 16px 0',
              background: 'var(--color-panel)',
              borderRadius: 10,
              border: '1px solid var(--color-border)',
              overflow: 'hidden',
            }}
          >
            <SectionTitle count={data.invitations.length}>
              {t('team.invitations.title')}
            </SectionTitle>

            {loading ? (
              <div style={{ padding: '8px 0' }}>
                <SkeletonList count={2} />
              </div>
            ) : (
              <InvitationsList
                invitations={data.invitations}
                onRefetch={onRefetch}
              />
            )}
          </div>
        )}

        {/* Departments section — admin only */}
        <DepartmentsSection
          orgId={data.orgId}
          isAdmin={isAdmin}
          departments={data.departments}
          onRefetch={onRefetch}
        />

        {/* Credits & Budgets section — admin only */}
        <CreditsSection
          orgId={data.orgId}
          isAdmin={isAdmin}
          onRefetch={onRefetch}
        />

        {/* Spacer at bottom */}
        <div style={{ height: 24 }} />
      </div>

      {/* Footer: invite button + refresh */}
      <div
        style={{
          padding: '12px 16px',
          borderTop: '1px solid var(--color-border)',
          background: 'var(--color-panel)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        {isAdmin && (
          <button
            onClick={() => setShowInviteModal(true)}
            data-testid="open-invite-modal-btn"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 18px',
              borderRadius: 8,
              border: '1px solid rgba(124,92,255,0.4)',
              background: 'rgba(124,92,255,0.12)',
              color: 'var(--color-accent-pale)',
              fontSize: 13,
              fontWeight: 500,
              fontFamily: 'inherit',
              cursor: 'pointer',
              transition: 'background 0.15s, border-color 0.15s',
            }}
            onMouseEnter={(e) => {
              const el = e.currentTarget as HTMLButtonElement;
              el.style.background = 'rgba(124,92,255,0.2)';
              el.style.borderColor = 'rgba(124,92,255,0.6)';
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget as HTMLButtonElement;
              el.style.background = 'rgba(124,92,255,0.12)';
              el.style.borderColor = 'rgba(124,92,255,0.4)';
            }}
          >
            + {t('team.invite.cta')}
          </button>
        )}

        {/* Refresh */}
        <button
          onClick={onRefetch}
          disabled={loading}
          aria-label={t('common.refresh')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 14px',
            borderRadius: 8,
            border: '1px solid var(--color-border)',
            background: 'transparent',
            color: loading ? 'var(--color-text-ghost)' : 'var(--color-text-muted)',
            fontSize: 12,
            fontFamily: 'inherit',
            cursor: loading ? 'not-allowed' : 'pointer',
          }}
        >
          {loading ? <Spinner size={12} /> : null}
          {t('common.refresh')}
        </button>
      </div>

      {/* Invite modal */}
      {showInviteModal && (
        <InviteModal
          orgId={data.orgId}
          onClose={() => setShowInviteModal(false)}
          onInvited={() => {
            onRefetch();
          }}
        />
      )}
    </div>
  );
}
