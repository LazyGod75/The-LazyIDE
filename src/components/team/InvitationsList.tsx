/* InvitationsList — pending invitations with revoke action.
   Only visible to org-admins (enforced server-side; guarded in UI too).
*/

import { useState } from 'react';
import { revokeInvite } from '../../lib/teams/orgApi';
import type { OrgInvitation } from '../../lib/teams/types';
import { Spinner, EmptyState } from '../ui';
import { useToast } from '../ui/Toast';
import { useI18n } from '../../i18n';
import { RoleBadge } from './RoleBadge';

// ── Props ─────────────────────────────────────────────────────────

interface InvitationsListProps {
  invitations: OrgInvitation[];
  onRefetch: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'short' }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

function isExpired(iso: string): boolean {
  return new Date(iso) < new Date();
}

// ── InvitationRow ─────────────────────────────────────────────────

function InvitationRow({
  invitation,
  onRefetch,
}: {
  invitation: OrgInvitation;
  onRefetch: () => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [revoking, setRevoking] = useState(false);
  const expired = isExpired(invitation.expires_at);

  async function handleRevoke() {
    setRevoking(true);
    const result = await revokeInvite(invitation.id);
    setRevoking(false);

    if (result.success) {
      toast(t('team.invitations.revoked'), 'success');
      onRefetch();
    } else {
      toast(result.error, 'error');
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        borderBottom: '1px solid var(--color-border-3)',
        opacity: expired ? 0.5 : 1,
      }}
      data-testid="invitation-row"
    >
      {/* Email */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--color-text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {invitation.email}
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-ghost)', marginTop: 1 }}>
          {expired
            ? t('team.invitations.expired')
            : `${t('team.invitations.expiresAt')} ${formatDate(invitation.expires_at)}`}
        </div>
      </div>

      {/* Role */}
      <RoleBadge role={invitation.role} />

      {/* Status */}
      <span
        style={{
          padding: '2px 8px',
          borderRadius: 99,
          background: expired
            ? 'rgba(239,68,68,0.08)'
            : 'rgba(255,199,107,0.08)',
          color: expired ? 'rgba(239,68,68,0.7)' : '#FFC76B',
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
        }}
      >
        {expired ? t('team.invitations.statusExpired') : t('team.invitations.statusPending')}
      </span>

      {/* Revoke button */}
      <button
        onClick={handleRevoke}
        disabled={revoking}
        aria-label={t('team.invitations.revoke')}
        data-testid={`revoke-invite-${invitation.id}`}
        style={{
          background: 'none',
          border: '1px solid var(--color-border)',
          borderRadius: 6,
          cursor: revoking ? 'not-allowed' : 'pointer',
          color: 'var(--color-text-muted)',
          fontSize: 11,
          fontWeight: 500,
          fontFamily: 'inherit',
          padding: '4px 10px',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          transition: 'border-color 0.15s, color 0.15s',
        }}
        onMouseEnter={(e) => {
          if (!revoking) {
            const el = e.currentTarget as HTMLButtonElement;
            el.style.borderColor = 'rgba(239,68,68,0.4)';
            el.style.color = 'rgba(239,68,68,0.8)';
          }
        }}
        onMouseLeave={(e) => {
          const el = e.currentTarget as HTMLButtonElement;
          el.style.borderColor = 'var(--color-border)';
          el.style.color = 'var(--color-text-muted)';
        }}
      >
        {revoking ? <Spinner size={10} /> : null}
        {t('team.invitations.revoke')}
      </button>
    </div>
  );
}

// ── InvitationsList ───────────────────────────────────────────────

export function InvitationsList({ invitations, onRefetch }: InvitationsListProps) {
  const { t } = useI18n();

  if (invitations.length === 0) {
    return (
      <EmptyState
        icon="✉"
        title={t('team.invitations.empty')}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {invitations.map((inv) => (
        <InvitationRow key={inv.id} invitation={inv} onRefetch={onRefetch} />
      ))}
    </div>
  );
}
