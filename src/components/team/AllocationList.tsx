/* AllocationList — displays existing per-member and per-dept allocations.
   Each row has an Edit and a Remove action.
   Empty state explains the common-pool model (no allocation = draws from common pool).
*/

import type { OrgAllocation, OrgMember } from '../../lib/teams/types';
import { Spinner } from '../ui';
import { useI18n } from '../../i18n';
import { formatCredits } from '../../lib/billing';

// ── Props ─────────────────────────────────────────────────────────

interface AllocationListProps {
  allocations: OrgAllocation[];
  members: OrgMember[];
  loading: boolean;
  onEdit: (allocation: OrgAllocation) => void;
  onRemove: (allocation: OrgAllocation) => void;
  removingId?: string | null;
}

function resolveDisplayName(entityId: string, members: OrgMember[]): string {
  const member = members.find((m) => m.user_id === entityId);
  if (!member) return entityId;
  return member.display_name ?? member.email ?? entityId.slice(0, 8) + '…';
}

// ── AllocationRow ─────────────────────────────────────────────────

function AllocationRow({
  allocation,
  members,
  onEdit,
  onRemove,
  isRemoving,
}: {
  allocation: OrgAllocation;
  members: OrgMember[];
  onEdit: () => void;
  onRemove: () => void;
  isRemoving: boolean;
}) {
  const { t } = useI18n();
  const isMember = allocation.entity_type === 'member';
  const displayName = isMember
    ? resolveDisplayName(allocation.entity_id, members)
    : allocation.entity_id;

  return (
    <div
      data-testid={`allocation-row-${allocation.id}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        borderBottom: '1px solid var(--color-border-3)',
      }}
    >
      {/* Entity type badge */}
      <span
        style={{
          padding: '2px 8px',
          borderRadius: 99,
          background: isMember ? 'rgba(124,92,255,0.15)' : 'rgba(246,169,69,0.12)',
          color: isMember ? '#A78BFF' : '#F6A945',
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        {isMember ? t('team.credits.allocations.entityMember') : t('team.credits.allocations.entityDept')}
      </span>

      {/* Entity name */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 13,
          color: 'var(--color-text)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {displayName}
      </div>

      {/* Amount + period */}
      <div
        style={{
          fontSize: 12,
          color: 'var(--color-text-muted)',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        {formatCredits(allocation.limit_cents)}
        <span style={{ color: 'var(--color-text-ghost)', marginLeft: 4 }}>
          / {t(`team.credits.period.${allocation.period}`) || allocation.period}
        </span>
      </div>

      {/* Consumption placeholder — phase 4 */}
      <span
        title={t('team.credits.allocations.phaseConsumption')}
        style={{
          fontSize: 10,
          color: 'var(--color-text-ghost)',
          fontStyle: 'italic',
          flexShrink: 0,
        }}
      >
        —
      </span>

      {/* Edit */}
      <button
        onClick={onEdit}
        data-testid={`edit-allocation-${allocation.id}`}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--color-accent-pale)',
          fontSize: 12,
          padding: '4px 8px',
          borderRadius: 4,
          fontFamily: 'inherit',
          flexShrink: 0,
        }}
      >
        {t('team.credits.form.edit')}
      </button>

      {/* Remove */}
      <button
        onClick={onRemove}
        disabled={isRemoving}
        data-testid={`remove-allocation-${allocation.id}`}
        style={{
          background: 'none',
          border: 'none',
          cursor: isRemoving ? 'not-allowed' : 'pointer',
          color: isRemoving ? 'rgba(255,255,255,0.1)' : 'rgba(239,68,68,0.5)',
          fontSize: 12,
          padding: '4px 8px',
          borderRadius: 4,
          fontFamily: 'inherit',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        {isRemoving && <Spinner size={10} color="rgba(239,68,68,0.7)" />}
        {t('team.credits.form.remove')}
      </button>
    </div>
  );
}

// ── AllocationList ─────────────────────────────────────────────────

export function AllocationList({
  allocations,
  members,
  loading,
  onEdit,
  onRemove,
  removingId,
}: AllocationListProps) {
  const { t } = useI18n();

  if (loading) {
    return (
      <div
        style={{
          padding: '24px',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <Spinner size={20} color="#7C5CFF" />
      </div>
    );
  }

  if (allocations.length === 0) {
    return (
      <div
        data-testid="allocations-empty"
        style={{
          padding: '20px 16px',
          textAlign: 'center',
          color: 'var(--color-text-ghost)',
          fontSize: 13,
        }}
      >
        {t('team.credits.allocations.empty')}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {allocations.map((a) => (
        <AllocationRow
          key={a.id}
          allocation={a}
          members={members}
          onEdit={() => onEdit(a)}
          onRemove={() => onRemove(a)}
          isRemoving={removingId === a.id}
        />
      ))}
    </div>
  );
}
