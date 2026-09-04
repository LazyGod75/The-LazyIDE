/* GitHubPanel — connect the team's brain sharing to GitHub (design §10).

   The single control surface for the GitHub-backed brain + canvas sync:
     - "Connecter GitHub": runs the OAuth device flow (code + verification
       URL shown in-app, auto-polling until authorized), stores the token in
       the app-data dir via Rust.
     - Once connected: shows the account, a "Provisionner le brain" action
       (creates a single private brain repo under the chosen
       owner — the connected user's account or an org they belong to), and
       the live sync status from the daemon's config.
*/

import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../../i18n';
import { useToast } from '../../ui/Toast';
import {
  requestDeviceCode,
  pollAccessToken,
  writeGitHubToken,
  readGitHubToken,
  clearGitHubToken,
  fetchGitHubUser,
  fetchGitHubOrgs,
  type GitHubTokenStore,
  type GitHubUser,
  type GitHubOrg,
} from '../../../lib/teams/githubOAuth';
import { type TeamRepoConfig } from '../../../lib/teams/githubConnect';
import { publishExistingBrainAsTeam } from '../../../lib/teams/activateTeamBrain';
import { readActiveBrainConfig } from '../../../lib/teams/activeBrainConfig';
import { openExternal } from '../../../lib/platform/openExternal';
import { SectionLabel, Card } from './shared';
import { Spinner } from '../../ui';

type ConnectPhase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'device'; deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresAt: number }
  | { kind: 'done'; login: string }
  | { kind: 'error'; message: string };

interface GitHubPanelProps {
  /** Org id the brain repos belong to (for the sync status + provisioning). */
  orgId: string;
}


export function GitHubPanel({ orgId }: GitHubPanelProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [stored, setStored] = useState<GitHubTokenStore | null>(null);
  const [user, setUser] = useState<GitHubUser | null>(null);
  const [orgs, setOrgs] = useState<GitHubOrg[]>([]);
  const [phase, setPhase] = useState<ConnectPhase>({ kind: 'idle' });
  const [owner, setOwner] = useState<string>('');
  const [ownerIsOrg, setOwnerIsOrg] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncRepos, setSyncRepos] = useState<TeamRepoConfig[]>([]);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadStored = useCallback(async () => {
    try {
      const s = await readGitHubToken();
      setStored(s);
      if (s) {
        const u = await fetchGitHubUser(s.token);
        setUser(u);
        if (u) setOwner(u.login);
        const o = await fetchGitHubOrgs(s.token);
        setOrgs(o);
      } else {
        setUser(null);
        setOrgs([]);
      }
    } catch {
      // offline / command unavailable — keep current state
    }
  }, []);

  useEffect(() => {
    void loadStored();
  }, [loadStored]);

  useEffect(() => {
    const active = readActiveBrainConfig();
    if (active && active.orgId === orgId) {
      setSyncRepos([{
        orgId: active.orgId,
        repoUrl: active.repoUrl,
        localDir: active.localDir,
        lastPushedAt: active.lastPushedAt,
        lastPulledAt: active.lastPulledAt,
        lastError: active.lastError ?? undefined,
      }]);
    } else {
      setSyncRepos([]);
    }
  }, [orgId, phase, provisioning]);

  useEffect(() => () => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
  }, []);

  async function handleConnect(): Promise<void> {
    setPhase({ kind: 'loading' });
    const res = await requestDeviceCode();
    if (!res.ok || !res.deviceCode || !res.userCode || !res.verificationUri) {
      setPhase({ kind: 'error', message: res.error ?? t('team.github.deviceError') });
      return;
    }
    const interval = res.interval ?? 5;
    // eslint-disable-next-line react-hooks/purity -- event handler, not render: Date.now() stamps the device-code expiry.
    const expiresAt = Date.now() + (res.expiresIn ?? 900) * 1000;
    setPhase({
      kind: 'device',
      deviceCode: res.deviceCode,
      userCode: res.userCode,
      verificationUri: res.verificationUri,
      interval,
      expiresAt,
    });
    // Like `gh auth login`: open the verification page in the system browser
    // automatically so the user only has to enter the code — zero friction.
    void openExternal(res.verificationUri).catch(() => {
      // The manual link below is always available; a failed auto-open is
      // non-fatal (e.g. shell permission missing in some sandboxes).
    });
    pollForToken(res.deviceCode, interval, expiresAt);
  }

  async function copyCode(userCode: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(userCode);
      toast(t('team.github.codeCopied'), 'success');
    } catch {
      // Clipboard unavailable (non-secure context) — the code is big and
      // copyable by hand; never block the flow.
    }
  }

  async function pollForToken(deviceCode: string, interval: number, expiresAt: number): Promise<void> {
    const attempt = async (): Promise<void> => {
      if (Date.now() > expiresAt) {
        setPhase({ kind: 'error', message: t('team.github.deviceExpired') });
        return;
      }
      const poll = await pollAccessToken('<github-oauth-client-id>', deviceCode);
      if (poll.ok && poll.accessToken) {
        const u = await fetchGitHubUser(poll.accessToken);
        const store: GitHubTokenStore = {
          token: poll.accessToken,
          login: u?.login ?? '',
          name: u?.name,
          email: u?.email,
          updatedAt: Date.now(),
        };
        await writeGitHubToken(store);
        setStored(store);
        setUser(u);
        if (u) setOwner(u.login);
        const o = await fetchGitHubOrgs(store.token);
        setOrgs(o);
        setPhase({ kind: 'done', login: store.login });
        toast(t('team.github.connected', { login: store.login }), 'success');
        return;
      }
      if (poll.error && poll.error !== 'authorization_pending' && poll.error !== 'slow_down') {
        setPhase({ kind: 'error', message: poll.errorDescription ?? poll.error });
        return;
      }
      const waitMs = (interval + (poll.error === 'slow_down' ? 5 : 0)) * 1000;
      pollTimerRef.current = setTimeout(() => {
        void attempt();
      }, Math.max(1000, waitMs));
    };
    await attempt();
  }

  async function handleProvision(): Promise<void> {
    if (!stored?.token) return;
    if (!owner.trim()) {
      toast(t('team.github.ownerRequired'), 'error');
      return;
    }
    setProvisioning(true);
    try {
      const result = await publishExistingBrainAsTeam({
        orgId,
        owner: owner.trim(),
        repoName: 'brain',
        token: stored.token,
        isOrg: ownerIsOrg,
      });
      if (!result.ok) {
        toast(result.message, 'error');
        return;
      }
      toast(`${t('team.github.provisioned')} brain`, 'success');
      const active = readActiveBrainConfig();
      if (active) {
        setSyncRepos([{
          orgId: active.orgId,
          repoUrl: active.repoUrl,
          localDir: active.localDir,
          lastPushedAt: active.lastPushedAt,
          lastPulledAt: active.lastPulledAt,
          lastError: active.lastError ?? undefined,
        }]);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setProvisioning(false);
    }
  }

  async function handleDisconnect(): Promise<void> {
    await clearGitHubToken();
    setStored(null);
    setUser(null);
    setOrgs([]);
    setPhase({ kind: 'idle' });
    toast(t('team.github.disconnected'), 'info');
  }


  async function handleSyncNow(): Promise<void> {
    setSyncing(true);
    try {
      const { runTeamPullCycle, runTeamPushCycle } = await import('../../../lib/teams/syncDaemon');
      await runTeamPullCycle();
      await runTeamPushCycle();
      const active = readActiveBrainConfig();
      if (active && active.orgId === orgId) {
        setSyncRepos([{
          orgId: active.orgId,
          repoUrl: active.repoUrl,
          localDir: active.localDir,
          lastPushedAt: active.lastPushedAt,
          lastPulledAt: active.lastPulledAt,
          lastError: active.lastError ?? undefined,
        }]);
      }
      toast(t('team.github.synced'), 'success');
    } catch {
      toast(t('team.github.syncError'), 'error');
    } finally {
      setSyncing(false);
    }
  }  const connected = !!stored?.token;
  return (
    <Card border="1px solid rgba(124,92,255,0.25)" style={{ padding: 16 }}>
      <SectionLabel color="var(--color-accent-pale)">{t('team.github.label')}</SectionLabel>

      {phase.kind === 'device' && (
        <div data-testid="github-device-pending" style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
            {t('team.github.deviceInstructions')}
          </div>
          <a
            href={phase.verificationUri}
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--color-accent-light)', fontSize: 13, fontWeight: 600 }}
          >
            {phase.verificationUri}
          </a>
          <div
            data-testid="github-user-code"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 24,
              letterSpacing: '6px',
              color: 'var(--color-text)',
              background: 'var(--color-panel-2)',
              border: '1px dashed rgba(124,92,255,0.4)',
              borderRadius: 10,
              padding: '10px 14px',
              textAlign: 'center',
            }}
          >
            {phase.userCode}
          </div>

          <button
            data-testid="github-copy-code-btn"
            onClick={() => copyCode(phase.userCode)}
            style={{
              alignSelf: "center",
              padding: "5px 12px",
              background: "transparent",
              border: "1px solid var(--color-border)",
              borderRadius: 7,
              color: "var(--color-text-muted)",
              fontSize: 11.5,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {t("team.github.copyCode")}
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--color-text-muted)' }}>
            <Spinner size={13} />
            {t('team.github.waitingAuthorization')}
          </div>
        </div>
      )}

      {phase.kind === 'error' && (
        <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--color-danger)' }}>
          {phase.message}
        </div>
      )}

      {phase.kind === 'idle' && !connected && (
        // Layout fix (David 2026-08-14): SectionLabel above renders a plain
        // <span> (inline), and this <button> is a browser-default
        // inline-block — as direct siblings with no block-level element
        // between them, they shared the same line box, so the button sat
        // glued to the heading text with the panel's real content pushed
        // into extra line-box whitespace below it. Wrapping in a block div
        // forces the button onto its own line, same as every other phase
        // branch in this component (device/error/loading/connected all
        // already render their own wrapping <div>).
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 10, lineHeight: 1.5 }}>
            {t('team.github.connectDesc')}
          </div>
          <button
            data-testid="github-connect-btn"
            onClick={handleConnect}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '9px 16px',
              borderRadius: 9,
              background: 'rgba(124,92,255,0.15)',
              border: '1px solid rgba(124,92,255,0.45)',
              color: '#C4B5FD',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {t('team.github.connect')}
          </button>
        </div>
      )}

      {phase.kind === 'loading' && (
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--color-text-muted)' }}>
          <Spinner size={13} />
          {t('common.loading')}
        </div>
      )}
      {connected && (
        <div data-testid="github-connected" style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 30,
                height: 30,
                borderRadius: '50%',
                background: 'rgba(124,92,255,0.25)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 13,
                fontWeight: 700,
                color: '#C4B5FD',
              }}
            >
              {(user?.login ?? stored.login).slice(0, 2).toUpperCase()}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text)' }}>
                {user?.name ?? user?.login ?? stored.login}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
                @{user?.login ?? stored.login}
              </div>
            </div>
            <button
              data-testid="github-disconnect-btn"
              onClick={handleDisconnect}
              style={{
                padding: '5px 10px',
                background: 'transparent',
                border: '1px solid var(--color-border)',
                borderRadius: 6,
                color: 'var(--color-text-muted)',
                fontSize: 11.5,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {t('team.github.disconnect')}
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
              {t('team.github.provisionDesc')}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <select
                data-testid="github-owner-select"
                value={`${ownerIsOrg ? 'org:' : 'user:'}${owner}`}
                onChange={(e) => {
                  const [kind, ...rest] = e.target.value.split(':');
                  setOwner(rest.join(':'));
                  setOwnerIsOrg(kind === 'org');
                }}
                style={{
                  flex: 1,
                  minWidth: 180,
                  background: 'var(--color-panel)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 7,
                  color: 'var(--color-text)',
                  fontSize: 12.5,
                  padding: '7px 10px',
                  fontFamily: 'inherit',
                }}
              >
                {user && (
                  <option value={`user:${user.login}`}>
                    {user.login} {t('team.github.ownerUser')}
                  </option>
                )}
                {orgs.map((o) => (
                  <option key={o.login} value={`org:${o.login}`}>
                    {o.login} {t('team.github.ownerOrg')}
                  </option>
                ))}
              </select>
              <button
                data-testid="github-provision-btn"
                onClick={handleProvision}
                disabled={provisioning || !owner}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '7px 14px',
                  borderRadius: 7,
                  background: provisioning || !owner ? 'rgba(124,92,255,0.3)' : 'rgba(124,92,255,0.85)',
                  border: 'none',
                  color: '#fff',
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: provisioning || !owner ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {provisioning && <Spinner size={12} color="#fff" />}
                {t('team.github.provision')}
              </button>
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-text-ghost)' }}>
              brain
            </div>
          </div>
          {syncRepos.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--color-text-muted)', letterSpacing: '1px', textTransform: 'uppercase' }}>
                  {t('team.github.syncStatus')}
                </div>
                <button
                  data-testid="github-sync-now-btn"
                  onClick={handleSyncNow}
                  disabled={syncing}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '4px 10px',
                    borderRadius: 6,
                    background: 'transparent',
                    border: '1px solid var(--color-border)',
                    color: 'var(--color-text-muted)',
                    fontSize: 11,
                    cursor: syncing ? 'not-allowed' : 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  {syncing && <Spinner size={11} />}
                  {t('team.github.syncNow')}
                </button>
              </div>
              {(() => {
                const r = syncRepos[0];
                return (
                  <div style={{ fontSize: 11.5, color: 'var(--color-text-secondary)', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.repoUrl.replace('https://github.com/', '')}
                    </span>
                    <span style={{ color: 'var(--color-text-ghost)', flexShrink: 0 }}>
                      {r.lastPushedAt ? new Date(r.lastPushedAt).toLocaleTimeString() : '—'}
                    </span>
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
