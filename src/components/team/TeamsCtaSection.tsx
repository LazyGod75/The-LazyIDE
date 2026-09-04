import { useState } from 'react';
import { useI18n } from '../../i18n';
import { useToast } from '../ui/Toast';
import { useActiveTeamContext } from '../../lib/teams/ActiveTeamContext';
import { createOrg } from '../../lib/teams/orgApi';
import { startTeamsCheckout } from '../../lib/billing';
import { emit } from '../../lib/bus';
import { Spinner } from '../ui';

export function TeamsCtaSection({ onCreated }: { onCreated: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const { hasActiveTeam } = useActiveTeamContext();
  const [showForm, setShowForm] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [seats, setSeats] = useState(5);
  const [monthlyCredits, setMonthlyCredits] = useState(0);
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    const trimmed = orgName.trim();
    if (!trimmed) return;
    setCreating(true);
    const result = await createOrg(trimmed, seats);
    if (!result.success) {
      setCreating(false);
      toast(t('settings.teams.createError', { error: result.error }), 'error');
      return;
    }
    // Org created (incomplete). Redirect to Stripe to pay for the seats (platform
    // fee) plus the chosen monthly credits; the webhook activates the org once the
    // payment completes. The org already exists, so a checkout failure is recoverable.
    toast(t('settings.teams.checkoutRedirect'), 'info');
    const checkout = await startTeamsCheckout(result.data.orgId, seats, monthlyCredits);
    setCreating(false);
    onCreated();
    if (checkout.error) {
      toast(t('settings.teams.checkoutError', { error: checkout.error }), 'error');
      return;
    }
    setShowForm(false);
    setOrgName('');
  }

  return (
    <div
      data-testid="teams-cta-section"
      style={{
        padding: 16,
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
      }}
    >
      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 8 }}>
        {t('settings.teams.section')}
      </div>

      {hasActiveTeam ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13, color: '#4ADE80', fontWeight: 500 }}>
            {t('settings.teams.active')}
          </div>
          <button
            data-testid="go-to-team-btn"
            onClick={() => emit('nav:navigateSpace', 'team')}
            style={{
              alignSelf: 'flex-start',
              padding: '7px 14px',
              background: 'transparent',
              border: '1px solid var(--color-accent-border)',
              borderRadius: 7,
              color: 'var(--color-accent-light)',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {t('settings.teams.goToTeam')}
          </button>
        </div>
      ) : showForm ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            {t('settings.teams.desc')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label htmlFor="settings-org-name" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
              {t('settings.teams.orgNameLabel')}
            </label>
            <input
              id="settings-org-name"
              type="text"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder={t('settings.teams.orgNamePlaceholder')}
              style={{
                padding: '7px 10px',
                background: 'var(--color-panel)',
                border: '1px solid var(--color-border)',
                borderRadius: 6,
                color: 'var(--color-text)',
                fontSize: 12,
                fontFamily: 'inherit',
                outline: 'none',
              }}
              onFocus={(e) => {
                (e.target as HTMLInputElement).style.borderColor = 'var(--color-accent-border)';
              }}
              onBlur={(e) => {
                (e.target as HTMLInputElement).style.borderColor = 'var(--color-border)';
              }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label htmlFor="settings-org-seats" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
              {t('settings.teams.seatsLabel')}
            </label>
            <input
              id="settings-org-seats"
              type="number"
              min={1}
              value={seats}
              onChange={(e) => setSeats(Math.max(1, Number(e.target.value)))}
              style={{
                width: 80,
                padding: '7px 10px',
                background: 'var(--color-panel)',
                border: '1px solid var(--color-border)',
                borderRadius: 6,
                color: 'var(--color-text)',
                fontSize: 12,
                fontFamily: 'inherit',
                outline: 'none',
              }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label htmlFor="settings-org-monthly-credits" style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
              {t('settings.teams.monthlyCreditsLabel')}
            </label>
            <input
              id="settings-org-monthly-credits"
              type="number"
              min={0}
              max={100000}
              value={monthlyCredits}
              onChange={(e) => setMonthlyCredits(Math.max(0, Math.min(100000, Number(e.target.value))))}
              placeholder={t('settings.teams.monthlyCreditsPlaceholder')}
              style={{
                width: 120,
                padding: '7px 10px',
                background: 'var(--color-panel)',
                border: '1px solid var(--color-border)',
                borderRadius: 6,
                color: 'var(--color-text)',
                fontSize: 12,
                fontFamily: 'inherit',
                outline: 'none',
              }}
            />
            <span style={{ fontSize: 10, color: 'var(--color-text-ghost)' }}>
              {t('settings.teams.monthlyCreditsHint')}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handleCreate}
              disabled={creating || !orgName.trim()}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '7px 14px',
                background: creating || !orgName.trim()
                  ? 'rgba(124,92,255,0.3)'
                  : 'var(--color-accent)',
                border: 'none',
                borderRadius: 7,
                color: '#fff',
                fontSize: 12,
                fontWeight: 600,
                cursor: creating || !orgName.trim() ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
                opacity: creating || !orgName.trim() ? 0.7 : 1,
              }}
            >
              {creating && <Spinner size={12} color="#fff" />}
              {creating ? t('common.loading') : t('settings.teams.createAndPay')}
            </button>
            <button
              onClick={() => { setShowForm(false); setOrgName(''); }}
              disabled={creating}
              style={{
                padding: '7px 14px',
                background: 'transparent',
                border: '1px solid var(--color-border)',
                borderRadius: 7,
                color: 'var(--color-text-muted)',
                fontSize: 12,
                cursor: creating ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            {t('settings.teams.desc')}
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text)' }}>
            <span style={{ color: '#A78BFF' }}>5 €</span>
            <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--color-text-muted)' }}>{t('settings.teams.perSeatPerMonth')}</span>
            <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--color-text-muted)' }}> · {t('settings.teams.planDesc')}</span>
          </div>
          <button
            data-testid="create-team-cta"
            onClick={() => setShowForm(true)}
            style={{
              alignSelf: 'flex-start',
              padding: '7px 14px',
              background: 'transparent',
              border: '1px solid var(--color-accent-border)',
              borderRadius: 7,
              color: 'var(--color-accent-light)',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {t('settings.teams.createTeam')}
          </button>
        </div>
      )}
    </div>
  );
}
