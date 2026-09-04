import { useRef, useState } from 'react';
import { createOrg } from '../../../lib/teams/orgApi';
import { InviteModal } from '../InviteModal';
import { Spinner } from '../../ui';
import { useToast } from '../../ui/Toast';
import { useI18n } from '../../../i18n';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { readGitHubToken, fetchGitHubUser } from '../../../lib/teams/githubOAuth';
import {
  publishExistingBrainAsTeam,
  createEmptyTeamBrain,
  cloneExistingTeamBrain,
} from '../../../lib/teams/activateTeamBrain';

interface CreateAndInviteModalProps {
  onClose: () => void;
  onDone: (orgId: string, wasInvited: boolean) => void;
}

const DEFAULT_SEATS = 5;

type BrainChoice = 'A' | 'B' | 'C';

export function CreateAndInviteModal({ onClose, onDone }: CreateAndInviteModalProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [wasInvited, setWasInvited] = useState(false);
  const [brainActivated, setBrainActivated] = useState(false);
  const [brainChoice, setBrainChoice] = useState<BrainChoice>('A');
  const [brainUrl, setBrainUrl] = useState('');
  const [activating, setActivating] = useState(false);
  const [ghToken, setGhToken] = useState<string | null>(null);
  const [ghOwner, setGhOwner] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, { onClose, isDisabled: brainActivated });

  async function handleCreate() {
    if (!name.trim()) return;
    setCreating(true);
    const result = await createOrg(name.trim(), DEFAULT_SEATS);
    setCreating(false);
    if (result.success) {
      setOrgId(result.data.orgId);
      try {
        const store = await readGitHubToken();
        if (store) {
          setGhToken(store.token);
          const user = await fetchGitHubUser(store.token);
          if (user) setGhOwner(user.login);
        }
      } catch {
        // GitHub not connected — wizard will show a notice
      }
    } else {
      toast(result.error, 'error');
    }
  }

  async function handleActivateBrain() {
    if (!orgId || !ghToken || !ghOwner) return;
    setActivating(true);
    try {
      let result;
      if (brainChoice === 'A') {
        result = await publishExistingBrainAsTeam({
          orgId,
          owner: ghOwner,
          repoName: 'brain',
          token: ghToken,
        });
      } else if (brainChoice === 'B') {
        result = await createEmptyTeamBrain({
          orgId,
          owner: ghOwner,
          repoName: 'brain',
          token: ghToken,
        });
      } else {
        if (!brainUrl.trim()) {
          toast('GitHub repo URL is required', 'error');
          setActivating(false);
          return;
        }
        result = await cloneExistingTeamBrain({
          orgId,
          repoUrl: brainUrl.trim(),
          token: ghToken,
        });
      }
      if (result.ok) {
        setBrainActivated(true);
      } else {
        toast(result.message, 'error');
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
    setActivating(false);
  }

  if (orgId && brainActivated) {
    return (
      <InviteModal
        orgId={orgId}
        onClose={() => onDone(orgId, wasInvited)}
        onInvited={() => setWasInvited(true)}
      />
    );
  }

  if (orgId && !brainActivated) {
    return (
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
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          onClick={(e) => e.stopPropagation()}
          style={{
            width: '100%',
            maxWidth: 440,
            background: 'var(--color-panel)',
            border: '1px solid var(--color-border)',
            borderRadius: 12,
            padding: 24,
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            boxShadow: '0 24px 80px rgba(0,0,0,0.7)',
          }}
        >
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--color-text)' }}>
            Le cerveau de l'equipe part de ou?
          </h3>
          {!ghToken && (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
              Connect your GitHub account first to create a team brain.
            </p>
          )}
          {ghToken && (
            <>
              <BrainOptionCard
                selected={brainChoice === 'A'}
                onClick={() => setBrainChoice('A')}
                title="My current brain"
                description="Publish your existing brain as the team brain"
              />
              <BrainOptionCard
                selected={brainChoice === 'B'}
                onClick={() => setBrainChoice('B')}
                title="Empty brain"
                description="Start fresh with an empty team brain"
              />
              <BrainOptionCard
                selected={brainChoice === 'C'}
                onClick={() => setBrainChoice('C')}
                title="Existing GitHub repo"
                description="Clone an existing LazyBrain repo"
              />
              {brainChoice === 'C' && (
                <input
                  type="text"
                  value={brainUrl}
                  onChange={(e) => setBrainUrl(e.target.value)}
                  placeholder="https://github.com/owner/brain.git"
                  data-testid="brain-clone-url"
                  style={{
                    padding: '9px 12px',
                    background: 'var(--color-panel-2)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 8,
                    color: 'var(--color-text)',
                    fontSize: 13,
                    fontFamily: 'inherit',
                    outline: 'none',
                  }}
                />
              )}
            </>
          )}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', alignItems: 'center' }}>
            <button
              onClick={() => setBrainActivated(true)}
              style={{
                padding: '9px 16px',
                borderRadius: 8,
                border: 'none',
                background: 'transparent',
                color: 'var(--color-text-muted)',
                fontSize: 13,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              Skip
            </button>
            <button
              onClick={handleActivateBrain}
              disabled={activating || !ghToken || (brainChoice === 'C' && !brainUrl.trim())}
              data-testid="brain-activate-btn"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '9px 20px',
                borderRadius: 8,
                border: 'none',
                background: activating || !ghToken ? 'rgba(124,92,255,0.3)' : 'var(--color-accent)',
                color: '#fff',
                fontSize: 13,
                fontWeight: 600,
                fontFamily: 'inherit',
                cursor: activating || !ghToken ? 'not-allowed' : 'pointer',
              }}
            >
              {activating && <Spinner size={14} color="#fff" />}
              Continue
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
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
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 400,
          background: 'var(--color-panel)',
          border: '1px solid var(--color-border)',
          borderRadius: 12,
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          boxShadow: '0 24px 80px rgba(0,0,0,0.7)',
        }}
      >
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--color-text)' }}>
          {t('team.redesign.solo.inviteModal.title')}
        </h3>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
          {t('team.redesign.solo.inviteModal.subtitle')}
        </p>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('team.redesign.solo.inviteModal.namePlaceholder')}
          data-testid="solo-invite-org-name"
          style={{
            padding: '9px 12px',
            background: 'var(--color-panel-2)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            color: 'var(--color-text)',
            fontSize: 13,
            fontFamily: 'inherit',
            outline: 'none',
          }}
        />
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
            onClick={handleCreate}
            disabled={!name.trim() || creating}
            data-testid="solo-invite-continue-btn"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '9px 20px',
              borderRadius: 8,
              border: 'none',
              background: !name.trim() || creating ? 'rgba(124,92,255,0.3)' : 'var(--color-accent)',
              color: '#fff',
              fontSize: 13,
              fontWeight: 600,
              fontFamily: 'inherit',
              cursor: !name.trim() || creating ? 'not-allowed' : 'pointer',
            }}
          >
            {creating && <Spinner size={14} color="#fff" />}
            {t('team.redesign.solo.inviteModal.continue')}
          </button>
        </div>
      </div>
    </div>
  );
}

function BrainOptionCard({
  selected,
  onClick,
  title,
  description,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  description: string;
}) {
  return (
    <div
      onClick={onClick}
      role="radio"
      aria-checked={selected}
      data-testid={`brain-option-${title}`}
      style={{
        padding: '12px 14px',
        background: selected ? 'rgba(124,92,255,0.12)' : 'var(--color-panel-2)',
        border: `1px solid ${selected ? 'var(--color-accent)' : 'var(--color-border)'}`,
        borderRadius: 8,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        transition: 'border-color 0.15s, background 0.15s',
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)' }}>
        {title}
      </span>
      <span style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.4 }}>
        {description}
      </span>
    </div>
  );
}
