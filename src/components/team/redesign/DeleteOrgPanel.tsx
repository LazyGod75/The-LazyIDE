/* DeleteOrgPanel — LeadView's danger-zone "Supprimer la team" (B26).
   Owner-only (enforced server-side by delete_org AND hidden client-side —
   LeadView only renders this for data.ownerUserId === callerUserId).
   Typed-confirm dialog (type the exact org name) before the irreversible
   call. Server-side honestly blocks (no silent no-op) while a paid seats
   subscription is still active — that error surfaces as a toast exactly
   as returned by the RPC, no client-side guess at Stripe state.
*/

import { useState } from 'react';
import { deleteOrg } from '../../../lib/teams/orgApi';
import { useToast } from '../../ui/Toast';
import { Spinner } from '../../ui';
import { useI18n } from '../../../i18n';

interface DeleteOrgPanelProps {
  orgId: string;
  orgName: string;
  onDeleted: () => void;
}

export function DeleteOrgPanel({ orgId, orgName, onDeleted }: DeleteOrgPanelProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);

  const canConfirm = confirmText.trim() === orgName;

  async function handleDelete() {
    if (!canConfirm) return;
    setDeleting(true);
    const result = await deleteOrg(orgId);
    setDeleting(false);
    if (result.success) {
      toast(t('team.redesign.delete.success', { name: orgName }), 'success');
      onDeleted();
    } else {
      toast(result.error, 'error');
    }
  }

  return (
    <div
      style={{
        border: '1px solid rgba(248,113,113,0.3)',
        borderRadius: 13,
        padding: '16px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        marginTop: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--color-danger-text)' }}>
            {t('team.redesign.delete.title')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>
            {t('team.redesign.delete.subtitle')}
          </div>
        </div>
        {!expanded && (
          <button
            onClick={() => setExpanded(true)}
            data-testid="delete-org-open-btn"
            style={{
              padding: '8px 16px',
              borderRadius: 8,
              border: '1px solid rgba(248,113,113,0.4)',
              background: 'rgba(248,113,113,0.08)',
              color: 'var(--color-danger-text)',
              fontSize: 12.5,
              fontWeight: 700,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              fontFamily: 'inherit',
            }}
          >
            {t('team.redesign.delete.cta')}
          </button>
        )}
      </div>

      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
            {t('team.redesign.delete.typeToConfirm', { name: orgName })}
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={orgName}
              data-testid="delete-org-confirm-input"
              style={{
                flex: 1,
                padding: '9px 12px',
                background: 'var(--color-panel-2)',
                border: '1px solid var(--color-border)',
                borderRadius: 8,
                color: 'var(--color-text)',
                fontSize: 13,
                fontFamily: 'inherit',
                outline: 'none',
              }}
            />
            <button
              onClick={handleDelete}
              disabled={!canConfirm || deleting}
              data-testid="delete-org-confirm-btn"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '9px 18px',
                borderRadius: 8,
                border: 'none',
                background: !canConfirm || deleting ? 'rgba(248,113,113,0.25)' : 'var(--color-danger)',
                color: '#fff',
                fontSize: 13,
                fontWeight: 700,
                cursor: !canConfirm || deleting ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
                whiteSpace: 'nowrap',
              }}
            >
              {deleting && <Spinner size={13} color="#fff" />}
              {t('team.redesign.delete.confirmBtn')}
            </button>
            <button
              onClick={() => {
                setExpanded(false);
                setConfirmText('');
              }}
              disabled={deleting}
              style={{
                padding: '9px 14px',
                borderRadius: 8,
                border: '1px solid var(--color-border)',
                background: 'transparent',
                color: 'var(--color-text-muted)',
                fontSize: 13,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
