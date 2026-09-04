/* MemberDetailDrawer — Lead view's member detail panel (design-team.md §7).
   560px right drawer. Real stats only (credits used/allocated, last
   activity) — merges/week and per-member neurons are OMITTED per D5e (no
   real per-member data exists for either). Permissions are role-derived
   (roleView.ts, grounded in what the backend RPCs actually enforce).
   "Promouvoir co-lead" wires to the real setMemberRole mutation (same
   mutation MembersList.tsx already uses inline).
*/

import { useState } from 'react';
import type { OrgMember, OrgAllocation, MemberUsageRow } from '../../../lib/teams/types';
import { formatCredits } from '../../../lib/billing';
import { setMemberRole, removeMember } from '../../../lib/teams/orgApi';
import { getRolePermissions } from '../../../lib/teams/roleView';
import { Avatar, displayNameFor } from './shared';
import { useToast } from '../../ui/Toast';
import { Spinner } from '../../ui';
import { useI18n } from '../../../i18n';

interface MemberDetailDrawerProps {
  orgId: string;
  member: OrgMember;
  allocation: OrgAllocation | null;
  usage: MemberUsageRow | undefined;
  /** Caller must be org-admin for role/removal mutations to succeed server-side. */
  callerIsOrgAdmin: boolean;
  /** True when `member` is the organization owner — removal is never
   *  offered for the owner (server rejects it too; see org-remove-member). */
  isOwner: boolean;
  onClose: () => void;
  onRefetch: () => void;
  /** Called after a successful removal, in addition to onRefetch — lets the
   *  caller also close the (now-stale) drawer. */
  onRemoved: () => void;
}

function formatLastActivity(iso: string | null, t: (k: string, p?: Record<string, string | number>) => string): string {
  if (!iso) return t('team.redesign.drawer.neverActive');
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  const diffH = Math.round(diffMs / 3_600_000);
  if (diffH < 1) return t('team.redesign.drawer.activityJustNow');
  if (diffH < 24) return t('team.redesign.drawer.activityHoursAgo', { count: diffH });
  const diffD = Math.round(diffH / 24);
  return t('team.redesign.drawer.activityDaysAgo', { count: diffD });
}

export function MemberDetailDrawer({
  orgId,
  member,
  allocation,
  usage,
  callerIsOrgAdmin,
  isOwner,
  onClose,
  onRefetch,
  onRemoved,
}: MemberDetailDrawerProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [promoting, setPromoting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const name = displayNameFor(member);
  const usedCredits = usage ? Math.round(usage.cost_charged_usd * 100) : 0;
  const limitCredits = allocation?.limit_cents ?? 0;
  const permissions = getRolePermissions(member.role);
  const canPromote = callerIsOrgAdmin && member.role === 'member';
  const canRemove = callerIsOrgAdmin && !isOwner;

  async function handlePromote() {
    setPromoting(true);
    const result = await setMemberRole(orgId, member.user_id, 'team-lead');
    setPromoting(false);
    if (result.success) {
      toast(t('team.redesign.drawer.promoteSuccess', { name }), 'success');
      onRefetch();
      onClose();
    } else {
      toast(result.error, 'error');
    }
  }

  async function handleRemove() {
    setRemoving(true);
    const result = await removeMember(orgId, member.user_id);
    setRemoving(false);
    if (result.success) {
      toast(t('team.redesign.drawer.removeSuccess', { name }), 'success');
      onRefetch();
      onRemoved();
    } else {
      toast(result.error, 'error');
      setConfirmingRemove(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(6,6,10,0.55)',
        zIndex: 40,
        display: 'flex',
        justifyContent: 'flex-end',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxWidth: '90vw',
          height: '100%',
          background: 'var(--color-panel)',
          borderLeft: '1px solid var(--color-border)',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '-20px 0 60px rgba(0,0,0,0.5)',
          padding: 24,
          gap: 16,
          overflowY: 'auto',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Avatar id={member.user_id} name={name} size={52} />
          <div>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-text)' }}>{name}</div>
            <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
              {t(`team.role.${member.role}`)} · {member.dept_name ?? t('team.redesign.lead.noDept')}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label={t('common.close')}
            data-testid="drawer-close-btn"
            style={{
              marginLeft: 'auto',
              background: 'none',
              border: 'none',
              color: 'var(--color-text-ghost)',
              fontSize: 17,
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </div>

        {/* Real stats (D5e: merges/neurons omitted — no real per-member data) */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div style={{ background: 'var(--color-panel-2)', borderRadius: 10, padding: 12 }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text)' }}>
              {allocation ? `${formatCredits(usedCredits)}/${formatCredits(limitCredits)}` : formatCredits(usedCredits)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
              {t('team.redesign.drawer.creditsStatLabel')}
            </div>
          </div>
          <div style={{ background: 'var(--color-panel-2)', borderRadius: 10, padding: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text)' }}>
              {formatLastActivity(usage?.last_event_at ?? null, t)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
              {t('team.redesign.drawer.lastActivityLabel')}
            </div>
          </div>
        </div>

        {/* Permissions — role-derived */}
        <div>
          <div
            style={{
              fontSize: 11.5,
              fontWeight: 700,
              letterSpacing: '1.8px',
              textTransform: 'uppercase',
              color: 'var(--color-text-muted)',
              marginBottom: 10,
            }}
          >
            {t('team.redesign.drawer.permissionsLabel')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13.5, color: 'var(--color-text-secondary)' }}>
            {permissions.map((p) => (
              <div key={p.key} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ color: p.allowed ? 'var(--color-success)' : 'var(--color-danger)' }}>
                  {p.allowed ? '✓' : '✕'}
                </span>
                {t(`team.redesign.drawer.permission.${p.key}`)}
              </div>
            ))}
          </div>
        </div>

        {/* Removal (B28) — org-admin only, never for the owner. */}
        {canRemove && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {!confirmingRemove ? (
              <button
                onClick={() => setConfirmingRemove(true)}
                data-testid="remove-member-btn"
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--color-danger-text)',
                  fontSize: 12.5,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  padding: 0,
                  textDecoration: 'underline',
                }}
              >
                {t('team.redesign.drawer.remove')}
              </button>
            ) : (
              <>
                <span style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>
                  {t('team.redesign.drawer.removeConfirmPrompt', { name })}
                </span>
                <button
                  onClick={handleRemove}
                  disabled={removing}
                  data-testid="remove-member-confirm-btn"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '5px 12px',
                    borderRadius: 7,
                    border: 'none',
                    background: 'var(--color-danger)',
                    color: '#fff',
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: removing ? 'not-allowed' : 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  {removing && <Spinner size={11} color="#fff" />}
                  {t('team.redesign.drawer.removeConfirmBtn')}
                </button>
                <button
                  onClick={() => setConfirmingRemove(false)}
                  disabled={removing}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--color-text-ghost)',
                    fontSize: 12,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    padding: 0,
                  }}
                >
                  {t('common.cancel')}
                </button>
              </>
            )}
          </div>
        )}

        {/* Footer actions */}
        <div style={{ marginTop: 'auto', display: 'flex', gap: 9 }}>
          {canPromote && (
            <button
              onClick={handlePromote}
              disabled={promoting}
              data-testid="promote-colead-btn"
              style={{
                flex: 1,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                textAlign: 'center',
                padding: 10,
                borderRadius: 9,
                background: 'var(--color-accent)',
                color: '#fff',
                fontSize: 13.5,
                fontWeight: 700,
                border: 'none',
                cursor: promoting ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {promoting && <Spinner size={13} color="#fff" />}
              {t('team.redesign.drawer.promote')}
            </button>
          )}
          <button
            onClick={onClose}
            style={{
              padding: '10px 20px',
              borderRadius: 9,
              border: '1px solid rgba(255,255,255,0.2)',
              background: 'transparent',
              color: 'var(--color-text)',
              fontSize: 13.5,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {t('team.redesign.drawer.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
