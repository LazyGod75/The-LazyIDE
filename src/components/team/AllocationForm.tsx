/* AllocationForm — define or update a credit allocation.
   Amount entered directly in credits (D4: the app-wide formatCredits()
   "crédits" abstraction — same convention as AccountChip's credit balance,
   NOT euros; `limit_cents` is stored/compared as a plain credit count, no
   /100 or *100 conversion).
   Can be pre-populated for editing an existing allocation.
*/

import { useState, useEffect } from 'react';
import type { OrgAllocation, OrgMember } from '../../lib/teams/types';
import { Spinner } from '../ui';
import { useI18n } from '../../i18n';
import type { MutationResult } from '../../lib/teams/useAllocations';

// ── Constants ─────────────────────────────────────────────────────

const PERIODS = ['month', 'week', 'day'] as const;
type Period = (typeof PERIODS)[number];

// ── Shared form primitives (same style as InviteModal) ────────────

function Label({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label
      htmlFor={htmlFor}
      style={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: 'var(--color-text-muted)',
        display: 'block',
        marginBottom: 6,
      }}
    >
      {children}
    </label>
  );
}

function FieldInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        width: '100%',
        padding: '9px 12px',
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 8,
        color: 'var(--color-text)',
        fontSize: 13,
        fontFamily: 'inherit',
        outline: 'none',
        transition: 'border-color 0.15s',
        boxSizing: 'border-box',
        ...props.style,
      }}
      onFocus={(e) => {
        e.currentTarget.style.borderColor = 'var(--color-accent)';
        props.onFocus?.(e);
      }}
      onBlur={(e) => {
        e.currentTarget.style.borderColor = 'var(--color-border)';
        props.onBlur?.(e);
      }}
    />
  );
}

function FieldSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      style={{
        width: '100%',
        padding: '9px 12px',
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 8,
        color: 'var(--color-text)',
        fontSize: 13,
        fontFamily: 'inherit',
        outline: 'none',
        cursor: 'pointer',
        appearance: 'none',
        ...props.style,
      }}
    />
  );
}

// ── Props ─────────────────────────────────────────────────────────

interface AllocationFormProps {
  members: OrgMember[];
  initial?: OrgAllocation | null;
  loading?: boolean;
  onSubmit: (
    entityType: 'member' | 'dept',
    entityId: string,
    limitCents: number,
    period: string,
  ) => Promise<MutationResult>;
  onCancel?: () => void;
}

// ── AllocationForm ─────────────────────────────────────────────────

export function AllocationForm({ members, initial, loading: externalLoading, onSubmit, onCancel }: AllocationFormProps) {
  const { t } = useI18n();

  const [entityType, setEntityType] = useState<'member' | 'dept'>(
    initial?.entity_type === 'dept' ? 'dept' : 'member',
  );
  const [entityId, setEntityId] = useState(initial?.entity_id ?? '');
  const [amountCredits, setAmountCredits] = useState(
    initial ? String(initial.limit_cents) : '',
  );
  const [period, setPeriod] = useState<Period>(
    PERIODS.includes(initial?.period as Period) ? (initial!.period as Period) : 'month',
  );
  const [loading, setLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (initial) {
      setEntityType(initial.entity_type === 'dept' ? 'dept' : 'member');
      setEntityId(initial.entity_id);
      setAmountCredits(String(initial.limit_cents));
      setPeriod(PERIODS.includes(initial.period as Period) ? (initial.period as Period) : 'month');
    } else {
      setEntityType('member');
      setEntityId('');
      setAmountCredits('');
      setPeriod('month');
    }
    setFormError(null);
  }, [initial]);

  const parsedAmount = parseFloat(amountCredits);
  const isValid =
    entityId.trim() !== '' && !isNaN(parsedAmount) && parsedAmount > 0;

  async function handleSubmit() {
    if (!isValid || loading) return;
    setLoading(true);
    setFormError(null);
    const limitCents = Math.round(parsedAmount);
    const result = await onSubmit(entityType, entityId.trim(), limitCents, period);
    setLoading(false);
    if (result.success) {
      setEntityId('');
      setAmountCredits('');
      setFormError(null);
      onCancel?.();
    } else {
      setFormError(result.error ?? 'Unknown error');
    }
  }

  const isSubmitting = loading || (externalLoading ?? false);

  return (
    <div
      style={{
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      {/* Entity type toggle */}
      <div>
        <Label>{t('team.credits.form.entityType')}</Label>
        <div style={{ display: 'flex', gap: 8 }}>
          {(['member', 'dept'] as const).map((type) => (
            <button
              key={type}
              onClick={() => {
                setEntityType(type);
                setEntityId('');
              }}
              data-testid={`entity-type-${type}`}
              style={{
                flex: 1,
                padding: '8px',
                borderRadius: 8,
                border: `1px solid ${entityType === type ? 'rgba(124,92,255,0.6)' : 'var(--color-border)'}`,
                background: entityType === type ? 'rgba(124,92,255,0.15)' : 'transparent',
                color: entityType === type ? '#A78BFF' : 'var(--color-text-muted)',
                fontSize: 12,
                fontWeight: 500,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              {type === 'member'
                ? t('team.credits.form.entityTypeMember')
                : t('team.credits.form.entityTypeDept')}
            </button>
          ))}
        </div>
      </div>

      {/* Entity selector */}
      <div>
        <Label htmlFor="alloc-entity">
          {entityType === 'member'
            ? t('team.credits.form.entityId')
            : t('team.credits.form.entityIdDept')}
        </Label>
        {entityType === 'member' ? (
          <FieldSelect
            id="alloc-entity"
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
            data-testid="alloc-entity-select"
          >
            <option value="">—</option>
            {members.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.display_name ?? m.email ?? m.user_id}
              </option>
            ))}
          </FieldSelect>
        ) : (
          <FieldInput
            id="alloc-entity"
            type="text"
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
            placeholder={t('team.credits.form.entityIdDeptPlaceholder')}
            data-testid="alloc-entity-input"
          />
        )}
      </div>

      {/* Amount in euros */}
      <div>
        <Label htmlFor="alloc-amount">{t('team.credits.form.amount')}</Label>
        <FieldInput
          id="alloc-amount"
          type="number"
          min="1"
          step="1"
          value={amountCredits}
          onChange={(e) => setAmountCredits(e.target.value)}
          placeholder={t('team.credits.form.amountPlaceholder')}
          data-testid="alloc-amount-input"
        />
      </div>

      {/* Period */}
      <div>
        <Label htmlFor="alloc-period">{t('team.credits.form.period')}</Label>
        <FieldSelect
          id="alloc-period"
          value={period}
          onChange={(e) => setPeriod(e.target.value as Period)}
          data-testid="alloc-period-select"
        >
          {PERIODS.map((p) => (
            <option key={p} value={p}>
              {t(`team.credits.period.${p}`)}
            </option>
          ))}
        </FieldSelect>
      </div>

      {/* Inline form error */}
      {formError && (
        <div
          style={{
            padding: '8px 12px',
            borderRadius: 6,
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.2)',
            color: '#FCA5A5',
            fontSize: 12,
          }}
        >
          {formError}
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        {onCancel && (
          <button
            onClick={onCancel}
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
            {t('team.credits.form.cancel')}
          </button>
        )}
        <button
          onClick={handleSubmit}
          disabled={!isValid || isSubmitting}
          data-testid="alloc-submit-btn"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '9px 20px',
            borderRadius: 8,
            border: 'none',
            background:
              !isValid || isSubmitting ? 'rgba(124,92,255,0.3)' : 'var(--color-accent)',
            color: '#fff',
            fontSize: 13,
            fontWeight: 600,
            fontFamily: 'inherit',
            cursor: !isValid || isSubmitting ? 'not-allowed' : 'pointer',
            opacity: !isValid || isSubmitting ? 0.7 : 1,
          }}
        >
          {isSubmitting && <Spinner size={14} color="#fff" />}
          {t('team.credits.form.submit')}
        </button>
      </div>
    </div>
  );
}
