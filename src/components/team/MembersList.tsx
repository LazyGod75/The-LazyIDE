/* MembersList — renders org members with role, dept, and remove action.
   Admins get inline role + department selectors; non-admins see a read-only
   directory (badge only). Owner (org-admin) role is immutable server-side.
*/

import { useState } from 'react';
import { removeMember, setMemberRole, setMemberDept } from '../../lib/teams/orgApi';
import type { OrgMember, OrgRole, Department } from '../../lib/teams/types';
import { ORG_ROLES } from '../../lib/teams/types';
import { Spinner, EmptyState } from '../ui';
import { useToast } from '../ui/Toast';
import { useI18n } from '../../i18n';
import { RoleBadge } from './RoleBadge';

// ── Props ─────────────────────────────────────────────────────────

interface MembersListProps {
  orgId: string;
  members: OrgMember[];
  departments: Department[];
  callerUserId: string;
  isAdmin: boolean;
  onRefetch: () => void;
}

// ── Shared compact select style ───────────────────────────────────

const SELECT_STYLE: React.CSSProperties = {
  padding: '5px 8px',
  background: 'var(--color-panel-2)',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  color: 'var(--color-text)',
  fontSize: 11,
  fontFamily: 'inherit',
  outline: 'none',
  cursor: 'pointer',
  appearance: 'none',
  flexShrink: 0,
};

// ── MemberRow ─────────────────────────────────────────────────────

function MemberRow({
  member,
  orgId,
  departments,
  isAdmin,
  callerUserId,
  onRefetch,
}: {
  member: OrgMember;
  orgId: string;
  departments: Department[];
  isAdmin: boolean;
  callerUserId: string;
  onRefetch: () => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [removing, setRemoving] = useState(false);
  const [savingRole, setSavingRole] = useState(false);
  const [savingDept, setSavingDept] = useState(false);

  const isOwner = member.role === 'org-admin';
  const isSelf = member.user_id === callerUserId;
  const canRemove = isAdmin && !isOwner && !isSelf;

  const displayName =
    member.display_name ?? member.email ?? member.user_id.slice(0, 8) + '…';

  async function handleRemove() {
    setRemoving(true);
    const result = await removeMember(orgId, member.user_id);
    setRemoving(false);

    if (result.success) {
      toast(t('team.members.removed'), 'success');
      onRefetch();
    } else {
      toast(result.error, 'error');
    }
  }

  async function handleRoleChange(role: OrgRole) {
    setSavingRole(true);
    const result = await setMemberRole(orgId, member.user_id, role);
    setSavingRole(false);

    if (result.success) {
      toast(t('team.members.roleUpdated'), 'success');
      onRefetch();
    } else {
      toast(result.error, 'error');
    }
  }

  async function handleDeptChange(value: string) {
    const deptId = value === '' ? null : value;
    setSavingDept(true);
    const result = await setMemberDept(orgId, member.user_id, deptId);
    setSavingDept(false);

    if (result.success) {
      toast(t('team.members.deptUpdated'), 'success');
      onRefetch();
    } else {
      toast(result.error, 'error');
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        borderBottom: '1px solid var(--color-border-3)',
      }}
      data-testid="member-row"
    >
      {/* Avatar */}
      <div
        style={{
          width: 30,
          height: 30,
          borderRadius: '50%',
          background: 'linear-gradient(135deg,#4F46E5,#7C5CFF)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 12,
          fontWeight: 700,
          color: '#fff',
          flexShrink: 0,
        }}
      >
        {(member.display_name ?? member.email ?? '?').charAt(0).toUpperCase()}
      </div>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--color-text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {displayName}
        </div>
        {!isAdmin && member.dept_name && (
          <div style={{ fontSize: 11, color: 'var(--color-text-ghost)', marginTop: 1 }}>
            {member.dept_name}
          </div>
        )}
      </div>

      {/* Admin controls: role + dept selects. Non-admins see a read-only badge. */}
      {isAdmin ? (
        <>
          <select
            value={member.role}
            onChange={(e) => handleRoleChange(e.target.value as OrgRole)}
            disabled={isSelf || savingRole}
            aria-label={t('team.members.roleLabel')}
            data-testid={`role-select-${member.user_id}`}
            title={isSelf ? t('team.members.selfProtected') : undefined}
            style={{
              ...SELECT_STYLE,
              cursor: isSelf || savingRole ? 'not-allowed' : 'pointer',
              opacity: isSelf || savingRole ? 0.6 : 1,
            }}
          >
            {ORG_ROLES.map((role) => (
              <option key={role} value={role}>
                {t(`team.role.${role}`)}
              </option>
            ))}
          </select>

          <select
            value={member.dept_id ?? ''}
            onChange={(e) => handleDeptChange(e.target.value)}
            disabled={savingDept}
            aria-label={t('team.members.deptLabel')}
            data-testid={`dept-select-${member.user_id}`}
            style={{
              ...SELECT_STYLE,
              cursor: savingDept ? 'not-allowed' : 'pointer',
              opacity: savingDept ? 0.6 : 1,
            }}
          >
            <option value="">{t('team.members.deptUnassigned')}</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </>
      ) : (
        <RoleBadge role={member.role} />
      )}

      {/* Remove button — admin only, owner protected */}
      {isAdmin && (
        <button
          onClick={handleRemove}
          disabled={!canRemove || removing}
          aria-label={t('team.members.remove')}
          data-testid={`remove-member-${member.user_id}`}
          title={isOwner ? t('team.members.ownerProtected') : isSelf ? t('team.members.selfProtected') : undefined}
          style={{
            background: 'none',
            border: 'none',
            cursor: canRemove && !removing ? 'pointer' : 'not-allowed',
            color: canRemove && !removing ? 'rgba(239,68,68,0.5)' : 'rgba(255,255,255,0.1)',
            fontSize: 14,
            lineHeight: 1,
            padding: '4px 6px',
            borderRadius: 4,
            display: 'flex',
            alignItems: 'center',
            opacity: canRemove ? 1 : 0.3,
            transition: 'color 0.15s',
          }}
          onMouseEnter={(e) => {
            if (canRemove && !removing) {
              (e.currentTarget as HTMLButtonElement).style.color = 'rgba(239,68,68,0.9)';
            }
          }}
          onMouseLeave={(e) => {
            if (canRemove && !removing) {
              (e.currentTarget as HTMLButtonElement).style.color = 'rgba(239,68,68,0.5)';
            }
          }}
        >
          {removing ? <Spinner size={12} color="rgba(239,68,68,0.7)" /> : '×'}
        </button>
      )}
    </div>
  );
}

// ── MembersList ───────────────────────────────────────────────────

export function MembersList({ orgId, members, departments, callerUserId, isAdmin, onRefetch }: MembersListProps) {
  const { t } = useI18n();

  if (members.length === 0) {
    return (
      <EmptyState
        icon="👥"
        title={t('team.members.empty')}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {members.map((m) => (
        <MemberRow
          key={m.user_id}
          member={m}
          orgId={orgId}
          departments={departments}
          isAdmin={isAdmin}
          callerUserId={callerUserId}
          onRefetch={onRefetch}
        />
      ))}
    </div>
  );
}
