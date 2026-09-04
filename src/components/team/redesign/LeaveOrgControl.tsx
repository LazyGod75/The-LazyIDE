/* LeaveOrgControl — "Quitter la team" self-service action (B26). Used by
   both LeadView (a non-owner org-admin/team-lead) and MemberView (a
   member/viewer). The organization owner never sees this — deleting the
   org (DeleteOrgPanel.tsx, LeadView-only) is their equivalent action.

   Real call: orgApi.leaveOrg(orgId) -> the leave_org RPC (server-enforced:
   rejects the owner and the last org-admin). On success, clears the
   locally-remembered active org and lets the caller re-derive the Team
   viewpoint (TeamSpace falls back to Solo or another org via
   useOrgMemberships).
*/

import { useState } from 'react';
import { leaveTeamBrain } from '../../../lib/teams/activateTeamBrain';
import { useToast } from '../../ui/Toast';
import { Spinner } from '../../ui';
import { useI18n } from '../../../i18n';

interface LeaveOrgControlProps {
  orgId: string;
  orgName: string;
  onLeft: () => void;
}

export function LeaveOrgControl({ orgId, orgName, onLeft }: LeaveOrgControlProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);

  async function handleConfirm() {
    setLeaving(true);
    const result = await leaveTeamBrain(orgId);
    setLeaving(false);
    if (result.ok) {
      toast(t('team.redesign.leave.success', { name: orgName }), 'success');
      if (result.remindRevokeGithub) {
        toast(t('team.redesign.leave.githubNote'), 'info');
      }
      onLeft();
    } else {
      toast(result.message, 'error');
      setConfirming(false);
    }
  }

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        data-testid="leave-org-btn"
        style={{
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
        {t('team.redesign.leave.cta')}
      </button>
    );
  }

  return (
    <div
      data-testid="leave-org-confirm"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        fontSize: 12.5,
        color: 'var(--color-text-muted)',
      }}
    >
      <span>{t('team.redesign.leave.confirmPrompt', { name: orgName })}</span>
      <span style={{ fontSize: 11.5, color: 'var(--color-text-ghost)', lineHeight: 1.5 }}>
        {t('team.redesign.leave.brainNote')}
      </span>
      <span style={{ fontSize: 11.5, color: 'var(--color-text-ghost)', lineHeight: 1.5 }}>
        {t('team.redesign.leave.githubNote')}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          onClick={handleConfirm}
          disabled={leaving}
          data-testid="leave-org-confirm-btn"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 12px',
            borderRadius: 7,
            border: 'none',
            background: 'var(--color-danger)',
            color: '#fff',
            fontSize: 12,
            fontWeight: 700,
            cursor: leaving ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {leaving && <Spinner size={11} color="#fff" />}
          {t('team.redesign.leave.confirmBtn')}
        </button>
        <button
          onClick={() => setConfirming(false)}
          disabled={leaving}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--color-text-ghost)',
            fontSize: 12,
            cursor: 'pointer',
            fontFamily: 'inherit',
            padding: 0,
          }}
        >
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}
