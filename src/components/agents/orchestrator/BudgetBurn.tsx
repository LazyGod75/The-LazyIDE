/* BudgetBurn.tsx — Real-time budget burn indicator (Pillar E5).

   Duplicate-heading fix (real user report, 2026-08-14): this used to render
   its own "Budget" row label directly under CockpitRailPopover's own
   "BUDGET" title — same redundant-nesting bug FleetMap.tsx/DecisionCenter.tsx
   already had fixed (see FleetMap.tsx's header comment: "the popover chrome
   IS the heading"). No label rendered here now, just the real number.

   Currency-leak fix (same report): the spend readout used to render as
   "{spentCents} cents" (a currency framing, and a stray English word in an
   otherwise-unlocalized component) — this app's standing rule is credits,
   never currency, for cost-of-work figures. `spentCents`/`limitCents` are
   already credits-denominated (this codebase's established
   `credits_remaining_cents` convention, lib/billing/credits.ts), so this
   is a pure formatting fix — no unit conversion needed.
*/

import type { CSSProperties } from 'react';
import { useI18n } from '../../../i18n';
import { formatCredits } from '../../../lib/billing';

export interface BudgetBurnProps {
  spentCents: number;
  limitCents?: number;
}

function burnColor(ratio: number): string {
  if (ratio >= 1) return 'var(--color-danger)';
  if (ratio >= 0.8) return 'var(--color-warning)';
  return 'var(--color-success)';
}

export function BudgetBurn({ spentCents, limitCents }: BudgetBurnProps) {
  const { t } = useI18n();
  const ratio = limitCents && limitCents > 0 ? Math.min(1, spentCents / limitCents) : 0;
  const color = burnColor(ratio);
  const label =
    limitCents !== undefined
      ? t('cockpit.budget.spentOfLimit', { spent: formatCredits(spentCents), limit: formatCredits(limitCents) })
      : t('cockpit.budget.spent', { spent: formatCredits(spentCents) });
  const track: CSSProperties = {
    height: 8,
    width: '100%',
    background: 'var(--color-panel-2)',
    borderRadius: 999,
    overflow: 'hidden',
  };
  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', fontSize: 12, color: 'var(--color-text-secondary)' }}>
        <span data-testid="budget-burn-label">{label}</span>
      </div>
      {limitCents !== undefined && (
        <div data-testid="budget-burn-track" style={track}>
          <div
            data-testid="budget-burn-fill"
            style={{ height: '100%', width: `${ratio * 100}%`, background: color }}
          />
        </div>
      )}
    </div>
  );
}
