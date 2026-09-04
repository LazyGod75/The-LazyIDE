/* TopupForm — Pro users' inline top-up section inside AccountPopover.
   Replaces the old fixed "Recharger 500 crédits" button: collapsed, it's a
   single button; clicking it expands preset chips + a free-amount input,
   all still inside the popover's own DOM subtree (useDismissable only
   treats pointerdown OUTSIDE that subtree as a dismissal — see
   AccountPopover.tsx's `ref` — so typing/clicking here never closes it).
*/

import { useState } from 'react';
import { useI18n } from '../../i18n';
import { TOPUP_PRESETS_EUR, TOPUP_MIN_EUR, TOPUP_MAX_EUR, isValidTopupAmount } from '../../lib/billing';
import { PopoverButton } from './PopoverButton';

export interface TopupFormProps {
  /** Called with the chosen amount (EUR, validated) — the caller runs the
   *  real startTopup(amount) call (same runAction/close/toast plumbing the
   *  rest of the popover already uses). */
  onConfirm: (amount: number) => void;
}

export function TopupForm({ onConfirm }: TopupFormProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [amount, setAmount] = useState<number | null>(null);
  const [customInput, setCustomInput] = useState('');

  if (!expanded) {
    return (
      <PopoverButton testId="topup-expand-btn" onClick={() => setExpanded(true)}>
        {t('account.popover.topup')}
      </PopoverButton>
    );
  }

  function selectPreset(preset: number) {
    setAmount(preset);
    setCustomInput('');
  }

  function handleCustomInput(value: string) {
    setCustomInput(value);
    const parsed = Number(value);
    setAmount(value.trim() === '' ? null : parsed);
  }

  const valid = amount !== null && isValidTopupAmount(amount);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '8px',
        background: 'rgba(255,255,255,0.03)',
        borderRadius: 6,
        border: '1px solid var(--color-border)',
      }}
    >
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {TOPUP_PRESETS_EUR.map(preset => {
          const selected = customInput === '' && amount === preset;
          return (
            <button
              key={preset}
              type="button"
              data-testid={`topup-preset-${preset}`}
              onClick={() => selectPreset(preset)}
              style={{
                padding: '4px 9px',
                background: selected ? 'rgba(124,92,255,0.22)' : 'rgba(255,255,255,0.04)',
                border: `1px solid ${selected ? 'rgba(124,92,255,0.5)' : 'var(--color-border)'}`,
                borderRadius: 6,
                color: selected ? '#A78BFF' : 'rgba(255,255,255,0.7)',
                fontSize: 11,
                fontWeight: 500,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {preset} €
            </button>
          );
        })}
      </div>
      <input
        type="number"
        min={TOPUP_MIN_EUR}
        max={TOPUP_MAX_EUR}
        value={customInput}
        onChange={e => handleCustomInput(e.target.value)}
        placeholder={t('account.popover.topupCustomPlaceholder')}
        data-testid="topup-custom-input"
        style={{
          width: '100%',
          padding: '5px 8px',
          background: 'var(--color-panel-3, rgba(255,255,255,0.04))',
          border: '1px solid var(--color-border)',
          borderRadius: 6,
          color: 'inherit',
          fontSize: 11,
          fontFamily: 'inherit',
          boxSizing: 'border-box',
        }}
      />
      <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
        {t('account.popover.topupHint')}
      </span>
      <PopoverButton
        primary
        disabled={!valid}
        testId="topup-confirm-btn"
        onClick={() => { if (valid && amount !== null) onConfirm(amount); }}
      >
        {amount !== null
          ? t('account.popover.topupConfirm', { amount })
          : t('account.popover.topup')}
      </PopoverButton>
    </div>
  );
}
