/* CreditsSection — admin-only credit & budget management section.
   Shown inside OrgDashboard below invitations.
   Explains the common-pool model and lets admins define per-member or per-dept allocations.
   Phase 4 note: actual consumption per member is not yet tracked here.
*/

import { useState } from 'react';
import { AllocationList } from './AllocationList';
import { AllocationForm } from './AllocationForm';
import { useAllocations } from '../../lib/teams/useAllocations';
import type { OrgAllocation } from '../../lib/teams/types';
import { useToast } from '../ui/Toast';
import { useI18n } from '../../i18n';
import { startTeamsTopup } from '../../lib/billing';

// ── Props ─────────────────────────────────────────────────────────

interface CreditsSectionProps {
  orgId: string;
  isAdmin: boolean;
  onRefetch: () => void;
}

// ── Model explanation banner ───────────────────────────────────────

function ModelBanner() {
  const { t } = useI18n();
  return (
    <div
      style={{
        margin: '0 0 0',
        padding: '10px 14px',
        background: 'rgba(124,92,255,0.06)',
        borderBottom: '1px solid var(--color-border-3)',
        fontSize: 12,
        color: 'var(--color-text-ghost)',
        lineHeight: 1.5,
      }}
    >
      {t('team.credits.model.desc')}
    </div>
  );
}

// ── Section title (reuses same pattern as OrgDashboard) ───────────

function SectionTitle({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '12px 14px 8px',
        borderBottom: '1px solid var(--color-border)',
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--color-text-muted)',
        }}
      >
        {children}
      </span>
      {count !== undefined && (
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: 'var(--color-text-ghost)',
            background: 'rgba(255,255,255,0.04)',
            borderRadius: 99,
            padding: '1px 7px',
          }}
        >
          {count}
        </span>
      )}
    </div>
  );
}

// ── Org credit top-up block ────────────────────────────────────────

function OrgTopupBlock({ orgId }: { orgId: string }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [topupLoading, setTopupLoading] = useState<number | null>(null);
  const [topupInput, setTopupInput] = useState('');

  async function handleTopup(amount: number) {
    if (amount < 1 || amount > 500) {
      toast(t('team.credits.topup.rangeError'), 'error');
      return;
    }
    setTopupLoading(amount);
    setTopupInput('');
    const { error } = await startTeamsTopup(orgId, amount);
    setTopupLoading(null);
    if (error) {
      toast(t('team.credits.topup.error', { error }), 'error');
    } else {
      toast(t('team.credits.topup.redirect'), 'info');
    }
  }

  return (
    <div
      data-testid="org-topup-block"
      style={{
        padding: '10px 14px',
        borderTop: '1px solid var(--color-border)',
      }}
    >
      <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 8 }}>
        {t('team.credits.topup.title')}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        {([10, 20, 50, 100] as const).map(amt => (
          <button
            key={amt}
            data-testid={`topup-preset-${amt}`}
            onClick={() => handleTopup(amt)}
            disabled={topupLoading !== null}
            style={{
              padding: '5px 10px',
              background: 'var(--color-panel-3)',
              border: '1px solid var(--color-border)',
              borderRadius: 6,
              color: 'var(--color-text)',
              fontSize: 11,
              fontWeight: 500,
              cursor: topupLoading !== null ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              opacity: topupLoading !== null && topupLoading !== amt ? 0.5 : 1,
            }}
          >
            {topupLoading === amt ? '...' : `+${amt} €`}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="number"
          min={1}
          max={500}
          value={topupInput}
          onChange={e => setTopupInput(e.target.value)}
          placeholder={t('team.credits.topup.customPlaceholder')}
          data-testid="topup-custom-input"
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
          data-testid="topup-confirm-btn"
          onClick={() => {
            const amt = parseFloat(topupInput);
            if (!isNaN(amt) && amt >= 1 && amt <= 500) {
              handleTopup(amt);
            } else {
              toast(t('team.credits.topup.rangeError'), 'error');
            }
          }}
          disabled={topupLoading !== null || !topupInput}
          style={{
            padding: '5px 12px',
            background: topupLoading !== null || !topupInput ? 'rgba(124,92,255,0.3)' : 'var(--color-accent)',
            border: 'none',
            borderRadius: 6,
            color: '#fff',
            fontSize: 11,
            fontWeight: 600,
            cursor: topupLoading !== null || !topupInput ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {t('team.credits.topup.confirm')}
        </button>
      </div>
    </div>
  );
}

// ── CreditsSection ─────────────────────────────────────────────────

export function CreditsSection({ orgId, isAdmin, onRefetch }: CreditsSectionProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const { allocations, members, loading, error, refetch, setAllocation, removeAllocation } =
    useAllocations(orgId);

  const [editingAllocation, setEditingAllocation] = useState<OrgAllocation | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  if (!isAdmin) return null;

  async function handleSubmit(
    entityType: 'member' | 'dept',
    entityId: string,
    limitCents: number,
    period: string,
  ) {
    const result = await setAllocation(entityType, entityId, limitCents, period);
    if (result.success) {
      toast(t('team.credits.setSuccess'), 'success');
      setEditingAllocation(null);
      setShowForm(false);
      onRefetch();
    } else {
      toast(result.error ?? 'Unknown error', 'error');
    }
    return result;
  }

  async function handleRemove(allocation: OrgAllocation) {
    setRemovingId(allocation.id);
    const result = await removeAllocation(
      allocation.entity_type as 'member' | 'dept',
      allocation.entity_id,
      allocation.period,
    );
    setRemovingId(null);
    if (result.success) {
      toast(t('team.credits.removeSuccess'), 'success');
      onRefetch();
    } else {
      toast(result.error ?? 'Unknown error', 'error');
    }
  }

  function handleEdit(allocation: OrgAllocation) {
    setEditingAllocation(allocation);
    setShowForm(true);
  }

  function handleCancelForm() {
    setEditingAllocation(null);
    setShowForm(false);
  }

  const isFormVisible = showForm || editingAllocation !== null;

  return (
    <div
      data-testid="credits-section"
      style={{
        margin: '12px 16px 0',
        background: 'var(--color-panel)',
        borderRadius: 10,
        border: '1px solid var(--color-border)',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <SectionTitle count={allocations.length}>
        {t('team.credits.title')}
      </SectionTitle>

      {/* Model explanation */}
      <ModelBanner />

      {/* Error state */}
      {error && !loading && (
        <div
          style={{
            padding: '12px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            borderBottom: '1px solid var(--color-border-3)',
          }}
        >
          <span style={{ flex: 1, color: '#FCA5A5', fontSize: 12 }}>{error}</span>
          <button
            onClick={refetch}
            style={{
              flexShrink: 0,
              padding: '4px 12px',
              borderRadius: 6,
              border: '1px solid rgba(239,68,68,0.3)',
              background: 'rgba(239,68,68,0.08)',
              color: '#FCA5A5',
              fontSize: 11,
              fontWeight: 500,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            {t('common.retry')}
          </button>
        </div>
      )}

      {/* Allocation list */}
      <AllocationList
        allocations={allocations}
        members={members}
        loading={loading}
        onEdit={handleEdit}
        onRemove={handleRemove}
        removingId={removingId}
      />

      {/* Define / edit form */}
      {isFormVisible ? (
        <div style={{ borderTop: '1px solid var(--color-border)' }}>
          <AllocationForm
            members={members}
            initial={editingAllocation}
            onSubmit={handleSubmit}
            onCancel={handleCancelForm}
          />
        </div>
      ) : (
        <div
          style={{
            padding: '10px 14px',
            borderTop: '1px solid var(--color-border)',
          }}
        >
          <button
            onClick={() => setShowForm(true)}
            data-testid="open-alloc-form-btn"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '7px 16px',
              borderRadius: 8,
              border: '1px solid rgba(124,92,255,0.4)',
              background: 'rgba(124,92,255,0.12)',
              color: 'var(--color-accent-pale)',
              fontSize: 12,
              fontWeight: 500,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            + {t('team.credits.form.title')}
          </button>
        </div>
      )}

      {/* Org credit top-up */}
      <OrgTopupBlock orgId={orgId} />
    </div>
  );
}
