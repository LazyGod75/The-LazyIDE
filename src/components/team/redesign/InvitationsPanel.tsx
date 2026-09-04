/* InvitationsPanel — LeadView's "Invitations en attente" section (B27).
   Reuses InvitationsList.tsx's real logic (revokeInvite, expiry formatting)
   restyled to the redesign's Card/token language, plus a "+ Inviter"
   trigger that was previously missing from the redesign entirely (the old
   OrgDashboard footer CTA never made it into LeadView — see code-team-map.md
   §1). org-admin only: org-list's Edge Function only populates
   OrgData.invitations for an org-admin caller, so a team-lead caller here
   would just see an (accurate) honest-empty list; LeadView additionally
   gates the whole section on callerRole === 'org-admin' to avoid a
   misleading "no invitations" for a role that can't see them at all.
*/

import { useState } from 'react';
import type { OrgInvitation } from '../../../lib/teams/types';
import { revokeInvite, inviteMember } from '../../../lib/teams/orgApi';
import { InviteModal } from '../InviteModal';
import { useToast } from '../../ui/Toast';
import { Spinner } from '../../ui';
import { Card } from './shared';
import { useI18n } from '../../../i18n';

interface InvitationsPanelProps {
  orgId: string;
  invitations: OrgInvitation[];
  onRefetch: () => void;
}

function formatExpiry(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'short' }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

function InvitationRow({ orgId, invitation, onRefetch }: { orgId: string; invitation: OrgInvitation; onRefetch: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [revoking, setRevoking] = useState(false);
  const [resending, setResending] = useState(false);
  const expired = new Date(invitation.expires_at) < new Date();

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

  /* Resend (David 2026-08-14): there is no dedicated "resend" RPC — the
     backend (supabase/functions/org-invite -> invite_member) only ever
     INSERTs a fresh row and has no upsert-by-email path, and it counts
     every status='pending' row (expired ones included — nothing in the DB
     auto-transitions expired invites to a terminal status) against the
     org's seat ceiling. Calling org-invite again for the same email
     without first revoking the dead row would risk a spurious "seat limit
     reached" once seats are tight. So "resend" here is the safe compound
     of the two existing, already-audited primitives: revoke the expired
     row (frees its seat slot), then re-invite with the same email/role/
     department. Two round-trips, no new backend surface. */
  async function handleResend() {
    setResending(true);
    const revokeResult = await revokeInvite(invitation.id);
    if (!revokeResult.success) {
      setResending(false);
      toast(revokeResult.error, 'error');
      return;
    }
    const inviteResult = await inviteMember(orgId, invitation.email, invitation.role, invitation.dept_id ?? undefined);
    setResending(false);
    if (inviteResult.success) {
      toast(t('team.invitations.resent'), 'success');
      onRefetch();
    } else {
      toast(t('team.invitations.resendFailed', { error: inviteResult.error }), 'error');
    }
  }

  return (
    <div
      data-testid="lead-invitation-row"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 4px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        // Layout fix (David 2026-08-14): an expired invite still needs an
        // action (Resend) — fading the whole row to 0.55 opacity made that
        // action itself look disabled/unavailable, and "Revoke" was the
        // ONLY control offered, which isn't the obvious move for a dead
        // invite. Keep the row at full opacity; the "Expired" text below
        // already carries the state in a warning color.
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {invitation.email}
        </div>
        <div style={{ fontSize: 11, color: expired ? 'var(--color-warning-text)' : 'var(--color-text-ghost)', marginTop: 1 }}>
          {expired ? t('team.invitations.expired') : `${t('team.invitations.expiresAt')} ${formatExpiry(invitation.expires_at)}`}
        </div>
      </div>
      <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--color-text-muted)' }}>{t(`team.role.${invitation.role}`)}</span>
      {expired && (
        <button
          onClick={handleResend}
          disabled={resending || revoking}
          data-testid={`resend-invite-${invitation.id}`}
          style={{
            background: 'var(--color-accent)',
            border: 'none',
            borderRadius: 6,
            cursor: resending || revoking ? 'not-allowed' : 'pointer',
            color: '#fff',
            fontSize: 11,
            fontWeight: 600,
            fontFamily: 'inherit',
            padding: '4px 10px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          {resending && <Spinner size={10} color="#fff" />}
          {t('team.invitations.resend')}
        </button>
      )}
      <button
        onClick={handleRevoke}
        disabled={revoking || resending}
        data-testid={`revoke-invite-${invitation.id}`}
        style={{
          background: 'none',
          border: '1px solid var(--color-border)',
          borderRadius: 6,
          cursor: revoking || resending ? 'not-allowed' : 'pointer',
          color: 'var(--color-text-muted)',
          fontSize: 11,
          fontWeight: 600,
          fontFamily: 'inherit',
          padding: '4px 10px',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        {revoking && <Spinner size={10} />}
        {t('team.invitations.revoke')}
      </button>
    </div>
  );
}

export function InvitationsPanel({ orgId, invitations, onRefetch }: InvitationsPanelProps) {
  const { t } = useI18n();
  const [inviting, setInviting] = useState(false);

  return (
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
          {t('team.invitations.title')}
        </span>
        <button
          onClick={() => setInviting(true)}
          data-testid="lead-invite-btn"
          style={{
            marginLeft: 'auto',
            background: 'none',
            border: 'none',
            color: 'var(--color-accent-pale)',
            fontSize: 12.5,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          + {t('team.invite.cta')}
        </button>
      </div>

      <Card style={{ padding: invitations.length === 0 ? '16px 18px' : '4px 18px' }}>
        {invitations.length === 0 ? (
          <div data-testid="lead-invitations-empty" style={{ fontSize: 12.5, color: 'var(--color-text-ghost)' }}>
            {t('team.invitations.empty')}
          </div>
        ) : (
          invitations.map((inv) => <InvitationRow key={inv.id} orgId={orgId} invitation={inv} onRefetch={onRefetch} />)
        )}
      </Card>

      {inviting && (
        <InviteModal
          orgId={orgId}
          onClose={() => {
            setInviting(false);
            onRefetch();
          }}
          onInvited={onRefetch}
        />
      )}
    </div>
  );
}
