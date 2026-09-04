/* InviteModal — modal for inviting a member to the org.
   Fields: email (required), role (required), department (optional).
   On success: shows the invite link to copy.
*/

import { useState, useRef, useId } from 'react';
import { inviteMember } from '../../lib/teams/orgApi';
import { ORG_ROLES } from '../../lib/teams/types';
import type { OrgRole } from '../../lib/teams/types';
import { Spinner } from '../ui';
import { useToast } from '../ui/Toast';
import { useI18n } from '../../i18n';
import { useFocusTrap } from '../../hooks/useFocusTrap';

// ── Props ─────────────────────────────────────────────────────────

interface InviteModalProps {
  orgId: string;
  onClose: () => void;
  onInvited: () => void;
}

// ── Shared primitives ─────────────────────────────────────────────

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

// ── InviteLink — displayed after successful invite ─────────────────

function InviteLink({ link, onClose }: { link: string; onClose: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();

  function copyLink() {
    navigator.clipboard.writeText(link).then(() => {
      toast(t('team.invite.copied'), 'success');
    }).catch(() => {
      toast(t('team.invite.copyFailed'), 'error');
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div
        style={{
          padding: '10px 14px',
          background: 'rgba(124,92,255,0.08)',
          border: '1px solid rgba(124,92,255,0.2)',
          borderRadius: 8,
        }}
      >
        <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--color-text-muted)' }}>
          {t('team.invite.linkLabel')}
        </p>
        <code
          style={{
            fontSize: 11,
            color: 'var(--color-accent-pale)',
            wordBreak: 'break-all',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {link}
        </code>
      </div>
      {/* B32: no email is actually sent by the invite edge function today —
          say so honestly instead of implying the invitee got notified. */}
      <p
        data-testid="invite-no-email-note"
        style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--color-text-muted)' }}
      >
        {t('team.invite.noEmailNote')}
      </p>
      <div style={{ display: 'flex', gap: 10 }}>
        <button
          onClick={copyLink}
          data-testid="copy-link-btn"
          style={{
            flex: 1,
            padding: '9px 16px',
            borderRadius: 8,
            border: 'none',
            background: 'var(--color-accent)',
            color: '#fff',
            fontSize: 13,
            fontWeight: 600,
            fontFamily: 'inherit',
            cursor: 'pointer',
          }}
        >
          {t('team.invite.copyLink')}
        </button>
        <button
          onClick={onClose}
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
          {t('common.close')}
        </button>
      </div>
    </div>
  );
}

// ── InviteModal ───────────────────────────────────────────────────

export function InviteModal({ orgId, onClose, onInvited }: InviteModalProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('member');
  const [dept, setDept] = useState('');
  const [loading, setLoading] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useFocusTrap(panelRef, { onClose });

  async function handleInvite() {
    if (!email.trim()) return;
    setLoading(true);
    const result = await inviteMember(orgId, email.trim(), role, dept.trim() || undefined);
    setLoading(false);

    if (result.success) {
      setInviteLink(result.data.link);
      onInvited();
    } else {
      toast(result.error, 'error');
    }
  }

  function handleLinkClose() {
    onClose();
  }

  return (
    /* Backdrop */
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        backdropFilter: 'blur(4px)',
      }}
    >
      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{
          width: '100%',
          maxWidth: 400,
          background: 'var(--color-panel)',
          border: '1px solid var(--color-border)',
          borderRadius: 12,
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
          boxShadow: '0 24px 80px rgba(0,0,0,0.7)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3
            id={titleId}
            style={{
              margin: 0,
              fontSize: 15,
              fontWeight: 700,
              color: 'var(--color-text)',
              letterSpacing: '-0.01em',
            }}
          >
            {t('team.invite.title')}
          </h3>
          <button
            onClick={onClose}
            aria-label={t('common.close')}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--color-text-ghost)',
              cursor: 'pointer',
              fontSize: 18,
              lineHeight: 1,
              padding: '0 4px',
            }}
          >
            ×
          </button>
        </div>

        {inviteLink ? (
          <InviteLink link={inviteLink} onClose={handleLinkClose} />
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <Label htmlFor="invite-email">{t('team.invite.emailLabel')}</Label>
                <FieldInput
                  id="invite-email"
                  type="email"
                  placeholder="colleague@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  data-testid="invite-email-input"
                />
              </div>

              <div>
                <Label htmlFor="invite-role">{t('team.invite.roleLabel')}</Label>
                <FieldSelect
                  id="invite-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as OrgRole)}
                  data-testid="invite-role-select"
                >
                  {ORG_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {t(`team.role.${r}`)}
                    </option>
                  ))}
                </FieldSelect>
              </div>

              <div>
                <Label htmlFor="invite-dept">{t('team.invite.deptLabel')}</Label>
                <FieldInput
                  id="invite-dept"
                  type="text"
                  placeholder={t('team.invite.deptPlaceholder')}
                  value={dept}
                  onChange={(e) => setDept(e.target.value)}
                  data-testid="invite-dept-input"
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                onClick={onClose}
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
                {t('common.cancel')}
              </button>
              <button
                onClick={handleInvite}
                disabled={!email.trim() || loading}
                data-testid="send-invite-btn"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '9px 20px',
                  borderRadius: 8,
                  border: 'none',
                  background: !email.trim() || loading ? 'rgba(124,92,255,0.3)' : 'var(--color-accent)',
                  color: '#fff',
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: 'inherit',
                  cursor: !email.trim() || loading ? 'not-allowed' : 'pointer',
                  opacity: !email.trim() || loading ? 0.7 : 1,
                }}
              >
                {loading && <Spinner size={14} color="#fff" />}
                {t('team.invite.send')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
