/* OrgOnboarding — shown when no org is found.
   Two paths:
   1. Create a team (name + seats -> org-create).
   2. Join via invite link/token -> org-accept-invite.
   Design matches the rest of the IDE (dark/violet, inline styles, no jargon).
*/

import { useState } from 'react';
import { createOrg, acceptInvite } from '../../lib/teams/orgApi';
import { Spinner } from '../ui';
import { useToast } from '../ui/Toast';
import { useI18n } from '../../i18n';

// ── Props ─────────────────────────────────────────────────────────

interface OrgOnboardingProps {
  onOrgCreated: (orgId: string) => void;
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

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
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

function PrimaryButton({
  children,
  loading,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  loading?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 22px',
        borderRadius: 8,
        border: 'none',
        background: disabled || loading ? 'rgba(124,92,255,0.3)' : 'var(--color-accent)',
        color: '#fff',
        fontSize: 13,
        fontWeight: 600,
        fontFamily: 'inherit',
        cursor: disabled || loading ? 'not-allowed' : 'pointer',
        transition: 'background 0.15s, opacity 0.15s',
        opacity: disabled || loading ? 0.7 : 1,
      }}
    >
      {loading && <Spinner size={14} color="#fff" />}
      {children}
    </button>
  );
}

// ── CreatePanel ───────────────────────────────────────────────────

function CreatePanel({ onCreated }: { onCreated: (orgId: string) => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [seats, setSeats] = useState('5');
  const [loading, setLoading] = useState(false);

  async function handleCreate() {
    const parsedSeats = parseInt(seats, 10);
    if (!name.trim()) return;
    if (!parsedSeats || parsedSeats < 1) return;

    setLoading(true);
    const result = await createOrg(name.trim(), parsedSeats);
    setLoading(false);

    if (result.success) {
      toast(t('team.org.created'), 'success');
      onCreated(result.data.orgId);
    } else {
      toast(result.error, 'error');
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <Label htmlFor="create-org-name">{t('team.create.nameLabel')}</Label>
        <Input
          id="create-org-name"
          type="text"
          placeholder={t('team.create.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          data-testid="org-name-input"
        />
      </div>
      <div>
        <Label htmlFor="create-org-seats">{t('team.create.seatsLabel')}</Label>
        <Input
          id="create-org-seats"
          type="number"
          placeholder="5"
          value={seats}
          min={1}
          max={500}
          onChange={(e) => setSeats(e.target.value)}
          style={{ maxWidth: 120 }}
          data-testid="org-seats-input"
        />
        <p style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--color-text-ghost)' }}>
          {t('team.create.seatsHint')}
        </p>
      </div>
      <PrimaryButton
        loading={loading}
        disabled={!name.trim() || !seats}
        onClick={handleCreate}
        data-testid="org-create-btn"
      >
        {t('team.create.cta')}
      </PrimaryButton>
    </div>
  );
}

// ── JoinPanel ─────────────────────────────────────────────────────

function JoinPanel({ onJoined }: { onJoined: (orgId: string) => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [tokenOrLink, setTokenOrLink] = useState('');
  const [loading, setLoading] = useState(false);

  function extractToken(raw: string): string {
    try {
      const url = new URL(raw.trim());
      return url.searchParams.get('token') ?? raw.trim();
    } catch {
      return raw.trim();
    }
  }

  async function handleJoin() {
    const token = extractToken(tokenOrLink);
    if (!token) return;

    setLoading(true);
    const result = await acceptInvite(token);
    setLoading(false);

    if (result.success) {
      toast(t('team.join.success'), 'success');
      onJoined(result.data.orgId);
    } else {
      toast(result.error, 'error');
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <Label htmlFor="join-org-token">{t('team.join.tokenLabel')}</Label>
        <Input
          id="join-org-token"
          type="text"
          placeholder={t('team.join.tokenPlaceholder')}
          value={tokenOrLink}
          onChange={(e) => setTokenOrLink(e.target.value)}
          data-testid="org-token-input"
        />
        <p style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--color-text-ghost)' }}>
          {t('team.join.tokenHint')}
        </p>
      </div>
      <PrimaryButton
        loading={loading}
        disabled={!tokenOrLink.trim()}
        onClick={handleJoin}
        data-testid="org-join-btn"
      >
        {t('team.join.cta')}
      </PrimaryButton>
    </div>
  );
}

// ── OrgOnboarding ─────────────────────────────────────────────────

type Mode = 'create' | 'join';

export function OrgOnboarding({ onOrgCreated }: OrgOnboardingProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>('create');

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
        minHeight: 0,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 440,
          display: 'flex',
          flexDirection: 'column',
          gap: 32,
        }}
      >
        {/* Header */}
        <div>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: '50%',
              background: 'rgba(124,92,255,0.08)',
              border: '1px solid rgba(124,92,255,0.2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 22,
              marginBottom: 16,
            }}
          >
            ⬡
          </div>
          <h2
            style={{
              margin: 0,
              fontSize: 18,
              fontWeight: 700,
              color: 'var(--color-text)',
              letterSpacing: '-0.02em',
            }}
          >
            {t('team.onboarding.title')}
          </h2>
          <p
            style={{
              margin: '8px 0 0',
              fontSize: 13,
              color: 'var(--color-text-muted)',
              lineHeight: 1.5,
            }}
          >
            {t('team.onboarding.subtitle')}
          </p>
        </div>

        {/* Mode switcher */}
        <div
          style={{
            display: 'flex',
            background: 'var(--color-panel)',
            borderRadius: 8,
            border: '1px solid var(--color-border)',
            padding: 4,
            gap: 4,
          }}
        >
          {(['create', 'join'] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              data-testid={`mode-${m}`}
              aria-pressed={mode === m}
              style={{
                flex: 1,
                padding: '7px 12px',
                borderRadius: 6,
                border: 'none',
                background: mode === m ? 'var(--color-accent)' : 'transparent',
                color: mode === m ? '#fff' : 'var(--color-text-muted)',
                fontSize: 12,
                fontWeight: 600,
                fontFamily: 'inherit',
                cursor: 'pointer',
                transition: 'background 0.15s, color 0.15s',
              }}
            >
              {t(m === 'create' ? 'team.onboarding.modeCreate' : 'team.onboarding.modeJoin')}
            </button>
          ))}
        </div>

        {/* Panel */}
        <div
          style={{
            padding: 20,
            background: 'var(--color-panel)',
            borderRadius: 10,
            border: '1px solid var(--color-border)',
          }}
        >
          {mode === 'create' ? (
            <CreatePanel onCreated={onOrgCreated} />
          ) : (
            <JoinPanel onJoined={onOrgCreated} />
          )}
        </div>
      </div>
    </div>
  );
}
