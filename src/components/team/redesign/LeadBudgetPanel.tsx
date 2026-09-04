/* LeadBudgetPanel — "BUDGET DE LA TEAM" section (design-team.md §4.1.3).
   Card 1: real org pot commun (OrgData.creditsRemainingCents /
   lastMonthlyGrantCents) + real top-up wired through startTeamsTopup
   (D4: pills display credits, converted to EUR for the Stripe Checkout
   call — 1 EUR = 100 credits, same convention the webhook already grants).
   Card 2: real per-department OrgAllocation rows + "+ Nouvelle allocation"
   (existing AllocationForm reused, restyled inline).
*/

import { useState } from 'react';
import type { OrgAllocation, OrgMember, Department } from '../../../lib/teams/types';
import { formatCredits } from '../../../lib/billing';
import { startTeamsTopup, openOrgBillingPortal } from '../../../lib/billing';
import { setAllocation } from '../../../lib/teams/orgApi';
import { AllocationForm } from '../AllocationForm';
import { colorForId, Card } from './shared';
import { useToast } from '../../ui/Toast';
import { useI18n } from '../../../i18n';

interface LeadBudgetPanelProps {
  orgId: string;
  creditsRemainingCents: number;
  lastMonthlyGrantCents: number;
  allocations: OrgAllocation[];
  departments: Department[];
  members: OrgMember[];
  /** Real per-department consumption, aggregated from org_usage_summary's
      dept_id column (each member row already carries their dept_id). */
  deptUsedCents: Map<string, number>;
  onRefetch: () => void;
}

const CREDIT_TOPUPS = [500, 1000] as const;

export function LeadBudgetPanel({
  orgId,
  creditsRemainingCents,
  lastMonthlyGrantCents,
  allocations,
  departments,
  members,
  deptUsedCents,
  onRefetch,
}: LeadBudgetPanelProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [topupLoading, setTopupLoading] = useState(false);
  const [topupDone, setTopupDone] = useState<number | null>(null);
  const [customAmount, setCustomAmount] = useState('');
  const [showAllocForm, setShowAllocForm] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);

  const fillPct = lastMonthlyGrantCents > 0
    ? Math.max(0, Math.min(100, Math.round((creditsRemainingCents / lastMonthlyGrantCents) * 100)))
    : creditsRemainingCents > 0 ? 100 : 0;

  async function handleTopup(credits: number) {
    setTopupLoading(true);
    const eur = credits / 100;
    const { error } = await startTeamsTopup(orgId, eur);
    setTopupLoading(false);
    if (error) {
      toast(error, 'error');
      return;
    }
    setTopupDone(credits);
  }

  function handleCustomTopup() {
    const credits = parseFloat(customAmount);
    if (isNaN(credits) || credits < 100 || credits > 50000) {
      toast(t('team.credits.topup.rangeError'), 'error');
      return;
    }
    void handleTopup(credits);
  }

  async function handleManageSeats() {
    setPortalLoading(true);
    const { error } = await openOrgBillingPortal(orgId, t);
    setPortalLoading(false);
    if (error) toast(error, 'error');
  }

  const deptAllocations = allocations.filter((a) => a.entity_type === 'dept');

  return (
    // W-UX3 finding D fix (David: « La page Team est bug ») — this panel
    // used to declare `flex: 1; minHeight: 0` (and `flex: 1` on the card
    // row below), a FIXED-HEIGHT dashboard layout — but it lives inside
    // LeadView's SCROLLING column (`overflowY: 'auto'`). In a scroll
    // container the flex algorithm hands a `minHeight: 0` child only the
    // LEFTOVER viewport space — near zero once members + invitations +
    // brain fill the page — and the panel's unclipped content then spilled
    // OVER the sections below it (the exact overlap in David's capture:
    // invitations painted inside the budget card, « Gérer les sièges »
    // colliding with the Brain section title). Scroll-column children must
    // be natural-height and non-shrinking: `flexShrink: 0`, no `flex: 1`.
    <div data-testid="lead-budget-panel" style={{ display: 'flex', flexDirection: 'column', gap: 10, flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 700,
            letterSpacing: '1.8px',
            textTransform: 'uppercase',
            color: 'var(--color-text-muted)',
            whiteSpace: 'nowrap',
          }}
        >
          {t('team.redesign.lead.budgetLabel')}
        </span>
        <span style={{ fontSize: 12, color: 'var(--color-text-ghost)' }}>{t('team.redesign.lead.budgetSubtitle')}</span>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'stretch' }}>
        {/* Pot commun */}
        <Card style={{ flex: 1.2, padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: 13 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontSize: 26, fontWeight: 700, color: 'var(--color-text)' }}>
              {formatCredits(creditsRemainingCents)}
            </span>
            <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
              {lastMonthlyGrantCents > 0
                ? t('team.redesign.lead.pot.remainingOf', { total: formatCredits(lastMonthlyGrantCents) })
                : t('team.redesign.lead.pot.remaining')}
            </span>
          </div>
          <div style={{ height: 9, background: 'rgba(255,255,255,0.07)', borderRadius: 5, overflow: 'hidden' }}>
            <div
              style={{
                width: `${fillPct}%`,
                height: '100%',
                background: 'linear-gradient(90deg,#7C5CFF,#38BDF8)',
                borderRadius: 5,
              }}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 2, flexWrap: 'wrap' }}>
            {CREDIT_TOPUPS.map((amt, i) => (
              <button
                key={amt}
                onClick={() => handleTopup(amt)}
                disabled={topupLoading}
                data-testid={`topup-${amt}`}
                style={{
                  padding: '7px 14px',
                  borderRadius: 8,
                  fontSize: 12.5,
                  fontWeight: 700,
                  cursor: topupLoading ? 'not-allowed' : 'pointer',
                  whiteSpace: 'nowrap',
                  fontFamily: 'inherit',
                  border: i === 1 ? '1px solid transparent' : '1px solid rgba(255,255,255,0.15)',
                  background: i === 1 ? 'var(--color-accent)' : 'rgba(255,255,255,0.05)',
                  color: i === 1 ? '#fff' : 'var(--color-text-secondary)',
                }}
              >
                + {formatCredits(amt)}
              </button>
            ))}
            <input
              type="number"
              min={100}
              max={50000}
              value={customAmount}
              onChange={(e) => setCustomAmount(e.target.value)}
              placeholder={t('team.redesign.lead.pot.customPlaceholder')}
              data-testid="topup-custom-input"
              style={{
                width: 110,
                padding: '6px 10px',
                borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.15)',
                background: 'rgba(255,255,255,0.05)',
                color: 'var(--color-text)',
                fontSize: 12.5,
                fontFamily: 'inherit',
              }}
            />
            <button
              onClick={handleCustomTopup}
              disabled={topupLoading || !customAmount}
              data-testid="topup-custom-btn"
              style={{
                padding: '7px 14px',
                borderRadius: 8,
                fontSize: 12.5,
                fontWeight: 700,
                cursor: topupLoading || !customAmount ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
                border: '1px solid rgba(255,255,255,0.15)',
                background: 'rgba(255,255,255,0.05)',
                color: 'var(--color-text-secondary)',
              }}
            >
              {t('team.credits.topup.confirm')}
            </button>
          </div>
          {topupDone !== null && (
            <div data-testid="topup-confirmation" style={{ fontSize: 12.5, color: 'var(--color-success-text)' }}>
              {t('team.redesign.lead.pot.topupDone', { amount: formatCredits(topupDone) })}
            </div>
          )}

          {/* Copy/layout fix (David 2026-08-14): this used to be a bare
              underlined text link sitting among real buttons (top-up pills,
              "+ Nouvelle allocation") — visually inconsistent affordance in
              a panel full of buttons. Restyle as a proper secondary button
              so its clickability reads the same way as its neighbors. */}
          <button
            onClick={() => void handleManageSeats()}
            disabled={portalLoading}
            data-testid="manage-seats-btn"
            style={{
              alignSelf: 'flex-start',
              marginTop: 'auto',
              padding: '7px 14px',
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.15)',
              background: 'rgba(255,255,255,0.05)',
              color: 'var(--color-accent-pale)',
              fontSize: 12,
              fontWeight: 600,
              cursor: portalLoading ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {t('team.redesign.lead.pot.manageSeats')}
          </button>
        </Card>

        {/* Dept allocations */}
        <Card style={{ flex: 1, padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--color-text-secondary)' }}>
            {t('team.redesign.lead.deptAllocations.title')}
          </div>
          {deptAllocations.length === 0 && !showAllocForm && (
            <div style={{ fontSize: 12.5, color: 'var(--color-text-ghost)' }}>
              {t('team.redesign.lead.deptAllocations.empty')}
            </div>
          )}
          {deptAllocations.map((a) => {
            const dept = departments.find((d) => d.id === a.entity_id);
            return (
              <div
                key={a.id}
                data-testid={`dept-alloc-${a.id}`}
                style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13.5 }}
              >
                <span style={{ width: 9, height: 9, borderRadius: 3, background: colorForId(a.entity_id), flexShrink: 0 }} />
                <span style={{ flex: 1, color: 'var(--color-text)' }}>{dept?.name ?? a.entity_id}</span>
                <span style={{ color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                  {formatCredits(deptUsedCents.get(a.entity_id) ?? 0)} / {formatCredits(a.limit_cents)}
                </span>
                <span style={{ fontSize: 11.5, color: 'var(--color-text-ghost)' }}>
                  {t(`team.redesign.lead.periodShort.${a.period}`)}
                </span>
              </div>
            );
          })}

          {showAllocForm ? (
            <AllocationForm
              members={members}
              onSubmit={async (entityType, entityId, limitCents, period) => {
                const result = await setAllocation(orgId, entityType, entityId, limitCents, period);
                if (result.success) {
                  onRefetch();
                  setShowAllocForm(false);
                  return { success: true };
                }
                return { success: false, error: result.error };
              }}
              onCancel={() => setShowAllocForm(false)}
            />
          ) : (
            <button
              onClick={() => setShowAllocForm(true)}
              data-testid="new-allocation-btn"
              style={{
                marginTop: 'auto',
                background: 'none',
                border: 'none',
                fontSize: 12,
                color: 'var(--color-accent-pale)',
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: 'inherit',
                padding: 0,
              }}
            >
              + {t('team.redesign.lead.deptAllocations.newCta')}
            </button>
          )}
        </Card>
      </div>
    </div>
  );
}
