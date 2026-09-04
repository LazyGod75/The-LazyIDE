/* Custom + preset credit top-up row (Pro Account). */

import { useI18n } from '../../../i18n';
import { submitCustomTopup } from './submitCustomTopup';
import type { AccountBilling } from './useAccountBilling';

const PRESETS = [5, 10, 20, 50] as const;

export function AccountTopupRow({ billing }: { billing: AccountBilling }) {
  const { t } = useI18n();
  const busy = billing.topupLoading !== null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
        {t('settings.billing.topupCredits')}
      </span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {PRESETS.map((amt) => (
          <PresetButton key={amt} amt={amt} billing={billing} busy={busy} />
        ))}
      </div>
      <CustomTopup billing={billing} busy={busy} />
    </div>
  );
}

function PresetButton({
  amt,
  billing,
  busy,
}: {
  amt: number;
  billing: AccountBilling;
  busy: boolean;
}) {
  return (
    <button
      onClick={() => billing.handleTopup(amt)}
      disabled={busy}
      style={{
        padding: '5px 10px',
        background: 'var(--color-panel-3)',
        border: '1px solid var(--color-border)',
        borderRadius: 6,
        color: 'var(--color-text)',
        fontSize: 11,
        fontWeight: 500,
        cursor: busy ? 'not-allowed' : 'pointer',
        fontFamily: 'inherit',
        opacity: busy && billing.topupLoading !== amt ? 0.5 : 1,
      }}
    >
      {billing.topupLoading === amt ? '...' : `+${amt} €`}
    </button>
  );
}

function CustomTopup({ billing, busy }: { billing: AccountBilling; busy: boolean }) {
  const { t } = useI18n();
  const empty = !billing.topupInput;
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <input
        type="number"
        min={1}
        max={500}
        value={billing.topupInput}
        onChange={(e) => billing.setTopupInput(e.target.value)}
        placeholder={t('settings.billing.topupCustomPlaceholder')}
        style={{
          width: 140,
          padding: '5px 8px',
          background: 'var(--color-panel-3)',
          border: '1px solid var(--color-border)',
          borderRadius: 6,
          color: 'var(--color-text)',
          fontSize: 11,
          fontFamily: 'inherit',
        }}
      />
      <button
        onClick={() => submitCustomTopup(billing)}
        disabled={busy || empty}
        style={{
          padding: '5px 12px',
          background: busy || empty ? 'rgba(124,92,255,0.3)' : 'var(--color-accent)',
          border: 'none',
          borderRadius: 6,
          color: '#fff',
          fontSize: 11,
          fontWeight: 600,
          cursor: busy || empty ? 'not-allowed' : 'pointer',
          fontFamily: 'inherit',
        }}
      >
        {billing.topupLoading === parseFloat(billing.topupInput)
          ? '...'
          : t('settings.billing.topupConfirm')}
      </button>
    </div>
  );
}
