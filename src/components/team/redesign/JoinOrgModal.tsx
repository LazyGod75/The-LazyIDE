/* JoinOrgModal — "I already have an invite link" flow. The design mock's
   Solo view only shows the invite/create cards (no join affordance), but
   the real app must still let a solo user who received an invite link
   accept it — dropping that capability silently would be a real
   regression. Reuses acceptInvite() verbatim (same logic as
   OrgOnboarding.tsx's JoinPanel), restyled as a small modal reachable from
   a tertiary link under the Solo view's two cards.
*/

import { useRef, useState } from 'react';
import { acceptInvite, listOrg } from '../../../lib/teams/orgApi';
import { joinTeamBrain } from '../../../lib/teams/activateTeamBrain';
import { readGitHubToken } from '../../../lib/teams/githubOAuth';
import { isTauri } from '../../../lib/platform';
import { Spinner } from '../../ui';
import { useToast } from '../../ui/Toast';
import { useI18n } from '../../../i18n';
import { useFocusTrap } from '../../../hooks/useFocusTrap';

interface JoinOrgModalProps {
  onClose: () => void;
  onJoined: (orgId: string) => void;
}

function extractToken(raw: string): string {
  try {
    const url = new URL(raw.trim());
    return url.searchParams.get('token') ?? raw.trim();
  } catch {
    return raw.trim();
  }
}

export function JoinOrgModal({ onClose, onJoined }: JoinOrgModalProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [tokenOrLink, setTokenOrLink] = useState('');
  const [loading, setLoading] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, { onClose });

  async function handleJoin() {
    const token = extractToken(tokenOrLink);
    if (!token) return;
    setLoading(true);
    const result = await acceptInvite(token);
    if (result.success) {
      const orgId = result.data.orgId;
      if (isTauri()) {
        try {
          const gh = await readGitHubToken();
          if (gh) {
            const org = await listOrg(orgId);
            const repoUrl = org.success ? org.data.brainRepoUrl : null;
            if (repoUrl) {
              const brainResult = await joinTeamBrain(orgId, repoUrl, gh.token);
              if (!brainResult.ok) {
                toast(t('team.join.brainNotActivated'), 'warning');
              }
            } else {
              toast(t('team.join.brainNotActivated'), 'warning');
            }
          } else {
            toast(t('team.join.brainNotActivated'), 'warning');
          }
        } catch {
          toast(t('team.join.brainNotActivated'), 'warning');
        }
      }
      setLoading(false);
      toast(t('team.join.success'), 'success');
      onJoined(orgId);
    } else {
      setLoading(false);
      toast(result.error, 'error');
    }
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
          {t('team.join.tokenLabel')}
        </h3>
        <input
          type="text"
          value={tokenOrLink}
          onChange={(e) => setTokenOrLink(e.target.value)}
          placeholder={t('team.join.tokenPlaceholder')}
          data-testid="solo-join-token-input"
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
            onClick={handleJoin}
            disabled={!tokenOrLink.trim() || loading}
            data-testid="solo-join-submit-btn"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '9px 20px',
              borderRadius: 8,
              border: 'none',
              background: !tokenOrLink.trim() || loading ? 'rgba(124,92,255,0.3)' : 'var(--color-accent)',
              color: '#fff',
              fontSize: 13,
              fontWeight: 600,
              fontFamily: 'inherit',
              cursor: !tokenOrLink.trim() || loading ? 'not-allowed' : 'pointer',
            }}
          >
            {loading && <Spinner size={14} color="#fff" />}
            {t('team.join.cta')}
          </button>
        </div>
      </div>
    </div>
  );
}
