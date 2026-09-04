/* AgentsPanel — agent-runner defaults persisted to localStorage.
   Future logic reads these keys to configure agent launches.

   localStorage keys (public contract):
     lazy.agents.worktreeDir      — string: default worktree parent directory
     lazy.agents.maxParallel      — number: max parallel agents (1–20)
     lazy.agents.costLimitUsd     — number: per-session cost limit in USD (0 = no limit)
     lazy.agents.autoApprove      — boolean: auto-approve low-risk tool calls
*/

import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../../i18n';
import type { AcpAgent } from '../../lib/agents/acpAgent';
// LS_AGENTS_MAX_PARALLEL lives in agentSettingsKeys.ts (a plain .ts module)
// so scheduler.ts — reachable from tsconfig.cli.json's non-JSX program via
// runtime.ts's dynamic import — can read it without needing --jsx support.
// Re-exported below so this panel stays the registry of record for every
// `lazy.agents.*` key.
import { LS_AGENTS_MAX_PARALLEL } from '../../lib/agents/agentSettingsKeys';
import {
  defaultMaxParallelFromHardware,
  detectHardwareConcurrency,
  MAX_PARALLEL_HARD_MAX,
} from '../../lib/agents/schedulerHardware';

// Windows-vs-POSIX example path for the worktree-folder placeholder below —
// showing a POSIX path unconditionally on a Windows-first desktop app read
// as a bug (a path the user can never actually paste from Explorer).
function isWindowsPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return navigator.platform.toUpperCase().includes('WIN');
}

// ── localStorage keys ──────────────────────────────────────────────

export const LS_AGENTS_WORKTREE_DIR  = 'lazy.agents.worktreeDir';
export { LS_AGENTS_MAX_PARALLEL };
export const LS_AGENTS_COST_LIMIT    = 'lazy.agents.costLimitUsd';
export const LS_AGENTS_AUTO_APPROVE  = 'lazy.agents.autoApprove';
export const LS_ACP_AGENTS            = 'lazy.agents.acpAgents';

// ── Default values ─────────────────────────────────────────────────

const DEFAULT_MAX_PARALLEL = defaultMaxParallelFromHardware(detectHardwareConcurrency());
const DEFAULT_COST_LIMIT   = 0;

// ── Persistence helpers ────────────────────────────────────────────

interface AgentsSettings {
  worktreeDir: string;
  maxParallel: number;
  costLimitUsd: number;
  autoApprove: boolean;
}

function loadAgentsSettings(): AgentsSettings {
  try {
    return {
      worktreeDir:  localStorage.getItem(LS_AGENTS_WORKTREE_DIR) ?? '',
      maxParallel:  Number(localStorage.getItem(LS_AGENTS_MAX_PARALLEL) ?? DEFAULT_MAX_PARALLEL),
      costLimitUsd: Number(localStorage.getItem(LS_AGENTS_COST_LIMIT) ?? DEFAULT_COST_LIMIT),
      autoApprove:  (localStorage.getItem(LS_AGENTS_AUTO_APPROVE) ?? 'false') === 'true',
    };
  } catch {
    return {
      worktreeDir:  '',
      maxParallel:  DEFAULT_MAX_PARALLEL,
      costLimitUsd: DEFAULT_COST_LIMIT,
      autoApprove:  false,
    };
  }
}

function saveAgentsSettings(s: AgentsSettings): void {
  try {
    localStorage.setItem(LS_AGENTS_WORKTREE_DIR, s.worktreeDir);
    localStorage.setItem(LS_AGENTS_MAX_PARALLEL, String(s.maxParallel));
    localStorage.setItem(LS_AGENTS_COST_LIMIT,   String(s.costLimitUsd));
    localStorage.setItem(LS_AGENTS_AUTO_APPROVE,  String(s.autoApprove));
  } catch {
    // localStorage unavailable
  }
}

// ── Toggle ─────────────────────────────────────────────────────────

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      onClick={() => onChange(!value)}
      role="switch"
      tabIndex={0}
      aria-checked={value}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onChange(!value);
        }
      }}
      style={{
        width: 36,
        height: 20,
        borderRadius: 10,
        background: value ? 'var(--color-accent)' : 'rgba(255,255,255,0.12)',
        flexShrink: 0,
        position: 'relative',
        cursor: 'pointer',
        transition: 'background 0.15s',
      }}
    >
      <div style={{
        position: 'absolute',
        top: 3,
        left: value ? 19 : 3,
        width: 14,
        height: 14,
        borderRadius: '50%',
        background: '#fff',
        transition: 'left 0.15s',
      }} />
    </div>
  );
}

// ── SettingRow ─────────────────────────────────────────────────────

function SettingRow({ label, sub, children }: {
  label: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      padding: '12px 16px',
      borderBottom: '1px solid var(--color-border)',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: 'var(--color-text)', fontWeight: 500, marginBottom: sub ? 2 : 0 }}>
          {label}
        </div>
        {sub && (
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{sub}</div>
        )}
      </div>
      {children}
    </div>
  );
}

// ── AgentsPanel ────────────────────────────────────────────────────

export function AgentsPanel() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<AgentsSettings>(loadAgentsSettings);

  // Persist on every change
  useEffect(() => {
    saveAgentsSettings(settings);
  }, [settings]);

  const update = useCallback(<K extends keyof AgentsSettings>(key: K, value: AgentsSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  }, []);

  const inputStyle: React.CSSProperties = {
    background: 'var(--color-panel)',
    border: '1px solid var(--color-border)',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 12,
    color: 'var(--color-text)',
    fontFamily: 'var(--font-mono, monospace)',
    outline: 'none',
    width: 180,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {/* Notice */}
      <div style={{
        padding: '10px 14px',
        background: 'rgba(124,92,255,0.06)',
        border: '1px solid rgba(124,92,255,0.2)',
        borderRadius: 8,
        fontSize: 12,
        color: 'var(--color-accent-pale)',
        marginBottom: 8,
      }}>
        {t('settings.agents.notice')}
      </div>

      {/* Settings card */}
      <div style={{
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
        overflow: 'hidden',
      }}>
        {/* Worktree dir */}
        <SettingRow
          label={t('settings.agents.worktreeDir.label')}
          sub={t('settings.agents.worktreeDir.sub')}
        >
          <input
            type="text"
            value={settings.worktreeDir}
            onChange={e => update('worktreeDir', e.target.value)}
            placeholder={isWindowsPlatform()
              ? t('settings.agents.worktreeDir.placeholderWindows')
              : t('settings.agents.worktreeDir.placeholderPosix')}
            style={inputStyle}
          />
        </SettingRow>

        {/* Max parallel */}
        <SettingRow
          label={t('settings.agents.maxParallel.label')}
          sub={t('settings.agents.maxParallel.sub')}
        >
          <input
            type="number"
            min={1}
            max={MAX_PARALLEL_HARD_MAX}
            value={settings.maxParallel}
            onChange={e => {
              const v = Math.min(MAX_PARALLEL_HARD_MAX, Math.max(1, Number(e.target.value)));
              update('maxParallel', v);
            }}
            style={{ ...inputStyle, width: 72 }}
          />
        </SettingRow>

        {/* Cost limit */}
        <SettingRow
          label={t('settings.agents.costLimit.label')}
          sub={t('settings.agents.costLimit.sub')}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>$</span>
            <input
              type="number"
              min={0}
              step={0.5}
              value={settings.costLimitUsd}
              onChange={e => update('costLimitUsd', Math.max(0, Number(e.target.value)))}
              style={{ ...inputStyle, width: 72 }}
            />
          </div>
        </SettingRow>

        {/* Auto-approve */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '12px 16px',
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, color: 'var(--color-text)', fontWeight: 500, marginBottom: 2 }}>
              {t('settings.agents.autoApprove.label')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
              {t('settings.agents.autoApprove.sub')}
            </div>
          </div>
          <Toggle
            value={settings.autoApprove}
            onChange={v => update('autoApprove', v)}
          />
        </div>
      </div>

      {/* P7.5 — ACP agent registry */}
      <AcpAgentsSection />
    </div>
  );
}

// ── ACP Agents Section ─────────────────────────────────────────────

const LS_ACP_AGENTS_KEY = 'lazy.agents.acpAgents';

function loadAcpAgents(): AcpAgent[] {
  try {
    const raw = localStorage.getItem(LS_ACP_AGENTS_KEY);
    return raw ? JSON.parse(raw) as AcpAgent[] : [];
  } catch { return []; }
}

function saveAcpAgents(agents: AcpAgent[]): void {
  try { localStorage.setItem(LS_ACP_AGENTS_KEY, JSON.stringify(agents)); } catch { /* */ }
}

function AcpAgentsSection() {
  const { t } = useI18n();
  const [agents, setAgents] = useState<AcpAgent[]>(loadAcpAgents);
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [token, setToken] = useState('');

  const addAgent = useCallback(() => {
    if (!name.trim() || !endpoint.trim()) return;
    const agent: AcpAgent = {
      id: `acp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: name.trim(),
      endpoint: endpoint.trim(),
      token: token.trim() || undefined,
    };
    const updated = [...agents, agent];
    setAgents(updated);
    saveAcpAgents(updated);
    setName('');
    setEndpoint('');
    setToken('');
  }, [agents, name, endpoint, token]);

  const removeAgent = useCallback((id: string) => {
    const updated = agents.filter(a => a.id !== id);
    setAgents(updated);
    saveAcpAgents(updated);
  }, [agents]);

  const inputStyle: React.CSSProperties = {
    background: 'var(--color-bg-2)',
    border: '1px solid var(--color-border-3)',
    borderRadius: 6,
    padding: '6px 10px',
    color: 'var(--color-text)',
    fontSize: 12,
    fontFamily: 'inherit',
    outline: 'none',
  };

  return (
    <div style={{ marginTop: 20 }}>
      <div style={{
        fontSize: 11,
        fontWeight: 700,
        color: 'var(--color-text-muted)',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        marginBottom: 10,
      }}>
        {t('settings.agents.acp.title')}
      </div>
      {agents.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {agents.map(a => (
            <div key={a.id} style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 12px',
              background: 'var(--color-bg-2)',
              borderRadius: 6,
              border: '1px solid var(--color-border-3)',
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text)' }}>{a.name}</div>
                <div style={{ fontSize: 10, color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.endpoint}</div>
              </div>
              <button
                onClick={() => removeAgent(a.id)}
                style={{
                  padding: '3px 8px',
                  fontSize: 11,
                  borderRadius: 4,
                  border: '1px solid rgba(248,113,113,0.25)',
                  background: 'rgba(248,113,113,0.06)',
                  color: '#F87171',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {t('settings.agents.acp.removeButton')}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div style={{
          fontSize: 12,
          color: 'var(--color-text-muted)',
          fontStyle: 'italic',
          marginBottom: 12,
        }}>
          {t('settings.agents.acp.emptyState')}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={t('settings.agents.acp.namePlaceholder')}
          style={{ ...inputStyle, flex: '1 1 120px' }}
        />
        <input
          value={endpoint}
          onChange={e => setEndpoint(e.target.value)}
          placeholder="https://agent.example.com/api"
          style={{ ...inputStyle, flex: '2 1 240px' }}
        />
        <input
          value={token}
          onChange={e => setToken(e.target.value)}
          placeholder={t('settings.agents.acp.tokenPlaceholder')}
          type="password"
          style={{ ...inputStyle, flex: '1 1 120px' }}
        />
        <button
          onClick={addAgent}
          disabled={!name.trim() || !endpoint.trim()}
          style={{
            padding: '6px 14px',
            fontSize: 12,
            borderRadius: 6,
            border: 'none',
            background: name.trim() && endpoint.trim() ? 'var(--color-accent)' : 'rgba(124,92,255,0.25)',
            color: '#fff',
            cursor: name.trim() && endpoint.trim() ? 'pointer' : 'default',
            fontFamily: 'inherit',
            fontWeight: 500,
          }}
        >
          {t('settings.agents.acp.addButton')}
        </button>
      </div>
    </div>
  );
}
