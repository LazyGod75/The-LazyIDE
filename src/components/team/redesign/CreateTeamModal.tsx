/* CreateTeamModal — Solo view's "Créer une team" card (D-Solo Card B,
   "ENTREPRISE"). Real flow, same underlying calls as
   components/team/TeamsCtaSection.tsx (Settings' existing org-creation
   upsell): createOrg(name, seats) then startTeamsCheckout(orgId, seats,
   monthlyCredits) — Stripe Checkout for the seat subscription + optional
   monthly credit grant (the paid "pot commun" model the design's copy
   describes). Restyled as a modal instead of Settings' inline card.
*/

import { useRef, useState } from 'react';
import { createOrg } from '../../../lib/teams/orgApi';
import { startTeamsCheckout } from '../../../lib/billing';
import { Spinner } from '../../ui';
import { useToast } from '../../ui/Toast';
import { useI18n } from '../../../i18n';
import { useFocusTrap } from '../../../hooks/useFocusTrap';

interface CreateTeamModalProps {
  onClose: () => void;
  onCreated: (orgId: string) => void;
}

export function CreateTeamModal({ onClose, onCreated }: CreateTeamModalProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [seats, setSeats] = useState(5);
  const [monthlyCredits, setMonthlyCredits] = useState(1000);
  const [creating, setCreating] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, { onClose });

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    const result = await createOrg(trimmed, seats);
    if (!result.success) {
      setCreating(false);
      toast(result.error, 'error');
      return;
    }
    toast(t('team.redesign.solo.createModal.checkoutRedirect'), 'info');
    const checkout = await startTeamsCheckout(result.data.orgId, seats, monthlyCredits / 100);
    setCreating(false);
    onCreated(result.data.orgId);
    if (checkout.error) {
      toast(checkout.error, 'error');
    }
  }

  const fieldStyle: React.CSSProperties = {
    padding: '9px 12px',
    background: 'var(--color-panel-2)',
    border: '1px solid var(--color-border)',
    borderRadius: 8,
    color: 'var(--color-text)',
    fontSize: 13,
    fontFamily: 'inherit',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  };

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 420,
          background: 'var(--color-panel)',
          border: '1px solid rgba(124,92,255,0.4)',
          borderRadius: 12,
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          boxShadow: '0 24px 80px rgba(0,0,0,0.7)',
        }}
      >
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--color-text)' }}>
          {t('team.redesign.solo.createModal.title')}
        </h3>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
          {t('team.redesign.solo.createModal.subtitle')}
        </p>

        <label style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
          {t('team.redesign.solo.createModal.nameLabel')}
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('team.redesign.solo.createModal.namePlaceholder')}
          data-testid="create-team-name-input"
          style={fieldStyle}
        />

        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
              {t('team.redesign.solo.createModal.seatsLabel')}
            </label>
            <input
              type="number"
              min={1}
              value={seats}
              onChange={(e) => setSeats(Math.max(1, Number(e.target.value)))}
              data-testid="create-team-seats-input"
              style={fieldStyle}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
              {t('team.redesign.solo.createModal.creditsLabel')}
            </label>
            <input
              type="number"
              min={0}
              step={100}
              value={monthlyCredits}
              onChange={(e) => setMonthlyCredits(Math.max(0, Number(e.target.value)))}
              data-testid="create-team-credits-input"
              style={fieldStyle}
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
          <button
            onClick={onClose}
            style={{
              padding: '9px 16px',
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
          <button
            onClick={handleCreate}
            disabled={!name.trim() || creating}
            data-testid="create-team-submit-btn"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '9px 20px',
              borderRadius: 8,
              border: 'none',
              background: !name.trim() || creating ? 'rgba(124,92,255,0.3)' : 'var(--color-accent)',
              color: '#fff',
              fontSize: 13,
              fontWeight: 700,
              fontFamily: 'inherit',
              cursor: !name.trim() || creating ? 'not-allowed' : 'pointer',
            }}
          >
            {creating && <Spinner size={14} color="#fff" />}
            {t('team.redesign.solo.createModal.submit')}
          </button>
        </div>
      </div>
    </div>
  );
}
