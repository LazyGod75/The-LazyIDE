/* SettingsSpace — Modèles + Réglages (tabs).
   BYOK keys persisted to localStorage only, never sent anywhere.
*/

import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useI18n } from '../i18n';
import { useUpdateStore } from '../lib/updateStore';
import { DEFAULT_MODEL } from '../lib/models/registry';
import {
  BYOK_PROVIDER_DEFS,
  saveByokKey,
  saveByokBaseUrl,
  saveByokModel,
  loadByokBaseUrl,
  loadByokModel,
  loadByokKey,
} from '../lib/models/byokProviders';
import type { ByokProviderDef } from '../lib/models/byokProviders';
import type { ByokProvider } from '../lib/models/byokProviders';
import type { ModelInfo } from '../lib/models/types';
import { getProviderMode, loadAccessSettings, saveAccessSettings } from '../lib/models';
import type { AccessSettings, AccessMode, CliTool } from '../lib/models';
import { loadVersionTelemetryEnabled, saveVersionTelemetryEnabled } from '../lib/billing/telemetryPrefs';
import { useToastSafe } from '../components/ui/Toast';
import { classifyMissionModel } from '../lib/agents/runtime';

import { HealthPanel } from '../components/settings/HealthPanel';
import { MemoryPanel } from '../components/settings/MemoryPanel';
import { AgentsPanel } from '../components/settings/AgentsPanel';
import { SolariPanel } from '../components/settings/SolariPanel';
import { useAgentsStoreOptional } from '../components/agents/agentsStore';
import { ModelsAssistantPanel } from '../components/settings/ModelsAssistantPanel';
import { ProvidersPanel } from '../components/settings/ProvidersPanel';
import { resetOnboarding } from '../components/onboarding/useOnboarding';
import { AccountTab } from '../components/settings/AccountTab';
import { ACCENT_PRESETS, loadStoredAccent, setAccent } from '../lib/theme/accentTheme';

// ── Types ──────────────────────────────────────────────────────────

export type SettingsTab = 'models' | 'account' | 'appearance' | 'general' | 'memory' | 'agents' | 'health' | 'solari';

interface SettingsSpaceProps {
  initialTab?: SettingsTab;
  /** Deep-link into AuthScreen's Sign in / Create account control. */
  initialAuthMode?: 'signin' | 'signup';
}

interface ProviderSectionProps {
  def: ByokProviderDef;
  models: ModelInfo[];
  defaultModelId: string;
  onSelectDefault: (id: string) => void;
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  /** Effective base URL (override or provider default). */
  baseUrl: string;
  onBaseUrlChange: (url: string) => void;
  /** Model override ('' = provider default). */
  modelOverride: string;
  onModelOverrideChange: (model: string) => void;
  /** True when this provider is the ACTIVE BYOK engine. */
  active: boolean;
  onActivate: () => void;
}

// ── Constants ──────────────────────────────────────────────────────

const PROVIDER_COLOR: Record<string, string> = {
  anthropic: '#A78BFF',
  openai:    '#74C0FC',
  google:    '#F6A945',
  deepseek:  '#4D6BFE',
  openrouter: '#F6A945',
  xai:       '#111111',
  groq:      '#F55036',
  mistral:   '#F7A600',
};

// ── Sub-components ──────────────────────────────────────────────────

function TabBar({ active, onChange }: { active: SettingsTab; onChange: (t: SettingsTab) => void }) {
  const { t } = useI18n();
  const TABS: Array<{ id: SettingsTab; labelKey: string }> = [
    { id: 'models',     labelKey: 'settings.tab.models' },
    { id: 'account',    labelKey: 'settings.tab.account' },
    { id: 'memory',     labelKey: 'settings.tab.memory' },
    { id: 'agents',     labelKey: 'settings.tab.agents' },
    { id: 'appearance', labelKey: 'settings.tab.appearance' },
    { id: 'general',    labelKey: 'settings.tab.general' },
    { id: 'health',     labelKey: 'settings.tab.health' },
    { id: 'solari',     labelKey: 'settings.tab.solari' },
  ];
  return (
    <div style={{
      display: 'flex',
      borderBottom: '1px solid var(--color-border)',
      background: 'var(--color-panel)',
      padding: '0 24px',
      overflowX: 'auto',
      overflowY: 'hidden',
    }}>
      {TABS.map(tab => (
        <button
          key={tab.id}
          type="button"
          data-testid={`settings-tab-${tab.id}`}
          onClick={() => onChange(tab.id)}
          style={{
            padding: '12px 14px',
            background: 'transparent',
            border: 'none',
            borderBottom: `2px solid ${active === tab.id ? 'var(--color-accent)' : 'transparent'}`,
            color: active === tab.id ? 'var(--color-accent-light)' : 'var(--color-text-muted)',
            fontSize: 13,
            fontWeight: active === tab.id ? 600 : 400,
            cursor: 'pointer',
            fontFamily: 'inherit',
            transition: 'color 0.12s',
            marginBottom: -1,
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {t(tab.labelKey)}
        </button>
      ))}
    </div>
  );
}

function ProviderSection({ def, models, defaultModelId, onSelectDefault, apiKey, onApiKeyChange, baseUrl, onBaseUrlChange, modelOverride, onModelOverrideChange, active, onActivate }: ProviderSectionProps) {
  const { t } = useI18n();
  const [showKey, setShowKey] = useState(false);

  return (
    <div style={{
      background: 'var(--color-panel-2)',
      border: '1px solid var(--color-border)',
      borderRadius: 10,
      overflow: 'hidden',
      marginBottom: 16,
    }}>
      {/* Provider header */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--color-border)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}>
        <span style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: PROVIDER_COLOR[def.id] ?? '#888',
          flexShrink: 0,
        }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)' }}>
          {def.label}
        </span>
        {active && (
          <span style={{
            fontSize: 9,
            fontWeight: 700,
            color: '#4ADE80',
            background: 'rgba(74,222,128,0.12)',
            border: '1px solid rgba(74,222,128,0.28)',
            borderRadius: 3,
            padding: '1px 6px',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}>
            {t('settings.providers.activeBadge')}
          </span>
        )}
        <button
          onClick={onActivate}
          data-testid={`byok-activate-${def.id}`}
          style={{
            marginLeft: 'auto',
            padding: '4px 10px',
            borderRadius: 6,
            border: active
              ? '1px solid rgba(74,222,128,0.35)'
              : '1px solid var(--color-accent-border)',
            background: active ? 'rgba(74,222,128,0.1)' : 'var(--color-accent-soft)',
            color: active ? '#4ADE80' : 'var(--color-accent-light)',
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {active ? t('settings.provider.activeLabel') : t('settings.provider.useLabel')}
        </button>
      </div>

      <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* Model list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {models.map(model => (
            <label
              key={model.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                cursor: 'pointer',
                padding: '6px 8px',
                borderRadius: 6,
                background: defaultModelId === model.id ? 'var(--color-accent-soft)' : 'transparent',
                border: `1px solid ${defaultModelId === model.id ? 'var(--color-accent-border)' : 'transparent'}`,
              }}
            >
              <input
                type="radio"
                name="default-model"
                value={model.id}
                checked={defaultModelId === model.id}
                onChange={() => onSelectDefault(model.id)}
                style={{ accentColor: 'var(--color-accent)', cursor: 'pointer' }}
              />
              <div>
                <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text)' }}>{model.label}</div>
                {model.description && (
                  <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{model.description}</div>
                )}
              </div>
              {defaultModelId === model.id && (
                <span style={{
                  marginLeft: 'auto',
                  fontSize: 10,
                  color: 'var(--color-accent-light)',
                  background: 'var(--color-accent-soft)',
                  borderRadius: 4,
                  padding: '2px 7px',
                  fontWeight: 600,
                }}>
                  {t('settings.default')}
                </span>
              )}
            </label>
          ))}
        </div>

        {/* BYOK key input */}
        <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 6 }}>
            {t('settings.provider.apiKeyLabel')}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={e => onApiKeyChange(e.target.value)}
              placeholder={t('settings.provider.apiKeyPlaceholder', { provider: def.label })}
              style={{
                flex: 1,
                background: 'var(--color-panel)',
                border: '1px solid var(--color-border)',
                borderRadius: 6,
                padding: '7px 10px',
                fontSize: 12,
                color: 'var(--color-text)',
                fontFamily: 'var(--font-mono)',
                outline: 'none',
              }}
              onFocus={e => { (e.target as HTMLInputElement).style.borderColor = 'var(--color-accent-border)'; }}
              onBlur={e => {
                (e.target as HTMLInputElement).style.borderColor = 'var(--color-border)';
                saveByokKey(def.id, apiKey);
              }}
            />
            <button
              onClick={() => setShowKey(s => !s)}
              style={{
                padding: '7px 10px',
                background: 'var(--color-panel)',
                border: '1px solid var(--color-border)',
                borderRadius: 6,
                color: 'var(--color-text-muted)',
                cursor: 'pointer',
                fontSize: 12,
                fontFamily: 'inherit',
              }}
            >
              {showKey ? t('settings.provider.hideKey') : t('settings.provider.showKey')}
            </button>
          </div>
        </div>

        {/* Base URL — pre-filled with the provider default; override for
            gateways/proxies (e.g. an Anthropic-compatible DeepSeek endpoint). */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
            {t('settings.provider.baseUrlLabel')}
          </div>
          <input
            type="text"
            value={baseUrl}
            onChange={e => onBaseUrlChange(e.target.value)}
            onBlur={e => saveByokBaseUrl(def.id, e.target.value)}
            placeholder={def.defaultBaseUrl}
            style={{
              background: 'var(--color-panel)',
              border: '1px solid var(--color-border)',
              borderRadius: 6,
              padding: '7px 10px',
              fontSize: 12,
              color: 'var(--color-text)',
              fontFamily: 'var(--font-mono)',
              outline: 'none',
            }}
          />
        </div>

        {/* Model override — empty = provider default (deepseek-chat, ...). */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
            {t('settings.provider.modelLabel')}
          </div>
          <input
            type="text"
            list={`byok-models-${def.id}`}
            value={modelOverride}
            onChange={e => onModelOverrideChange(e.target.value)}
            onBlur={e => saveByokModel(def.id, e.target.value)}
            placeholder={def.defaultModel}
            style={{
              background: 'var(--color-panel)',
              border: '1px solid var(--color-border)',
              borderRadius: 6,
              padding: '7px 10px',
              fontSize: 12,
              color: 'var(--color-text)',
              fontFamily: 'var(--font-mono)',
              outline: 'none',
            }}
          />
          <datalist id={`byok-models-${def.id}`}>
            {def.models.map(m => <option key={m.id} value={m.id} />)}
          </datalist>
        </div>
      </div>
    </div>
  );
}

// ── Access Mode Section (3-mode selector) ──────────────────────────

interface CliStatus {
  claude: boolean | null;
  codex: boolean | null;
}

function StatusDot({ available }: { available: boolean | null }) {
  const { t } = useI18n();
  const color = available === true ? '#4ADE80' : available === false ? '#F87171' : '#888';
  const label = available === true ? t('settings.cli.detected') : available === false ? t('settings.cli.notInstalled') : '...';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, display: 'inline-block' }} />
      <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{label}</span>
    </span>
  );
}

function AccessModeSection({ settings, onChange }: {
  settings: AccessSettings;
  onChange: (next: AccessSettings) => void;
}) {
  const { t } = useI18n();
  const [cliStatus, setCliStatus] = useState<CliStatus>({ claude: null, codex: null });
  const cliTool = settings.cliTool ?? 'claude';
  // Money incident (2026-08-14) — switching AWAY from the Pro rail here only
  // ever affects the manager's own next turn and any NEW mission launched
  // after this click: a mission whose loop is already running has its model
  // id resolved once, at launch, into a closure (managedAgent.ts/runtime.ts)
  // that never re-reads settings mid-run — see runMission's own doc comment.
  // That is defensible (an in-flight run cannot be silently re-pointed at a
  // different provider without losing its conversation state), but it must
  // never be SILENT: the "Abonnement (CLI d'agent)" card's own copy promises
  // "aucun coût Lazy" the instant it reads ACTIF, which is only true for
  // missions started AFTER this click. agentsStoreOptional/toastSafe degrade
  // to "nothing to warn about"/no-op outside their providers (defensive only
  // — the real app always wraps SettingsSpace in both, see
  // useRunningAgentCount's own doc comment for the identical pattern).
  const agentsStoreForRailSwitch = useAgentsStoreOptional();
  const warnOnRailSwitch = useToastSafe();
  function runningManagedMissionCount(): number {
    if (!agentsStoreForRailSwitch) return 0;
    return agentsStoreForRailSwitch.missions.filter(
      (m) => m.status === 'running' && classifyMissionModel(m.model) === 'managed',
    ).length;
  }
  function warnIfMissionsStayOnProRail(nextMode: AccessMode): void {
    if (nextMode === 'pro') return; // switching TO Pro never strands anything
    const n = runningManagedMissionCount();
    if (n > 0) warnOnRailSwitch(t('settings.access.inFlightContinueWarning', { count: n }), 'warning');
  }

  // When the user has never explicitly picked a backend (settings.accessMode
  // is undefined), getProviderMode() still auto-routes to managed/Pro
  // whenever a subscription is active (see index.ts's getProviderMode doc
  // comment: "Auto-detect: managed subscription takes priority"). Without
  // this, the three cards below would all render unselected even while Pro
  // is the engine actually running — the owner's exact complaint ("is there
  // a button to turn Pro off?" starts with "can I even SEE it's on?"). This
  // only affects which card is highlighted; an explicit click still persists
  // a real accessMode via onChange/saveAccessSettings same as before.
  const isAuto = settings.accessMode == null;
  const autoEquivalent: AccessMode | null = (() => {
    if (!isAuto) return null;
    const live = getProviderMode();
    if (live === 'managed' || live === 'pro') return 'pro';
    if (live === 'live-key') return 'byok';
    if (live === 'claude-code' || live === 'codex') return 'cli';
    return null;
  })();
  const mode = settings.accessMode ?? autoEquivalent ?? undefined;
  const activeLabel = isAuto ? t('settings.access.autoActive') : t('settings.access.active');

  useEffect(() => {
    // Detect CLI availability via Tauri (best-effort)
    const detect = async () => {
      try {
        const [claude, codex] = await Promise.all([
          invoke<boolean>('claude_available').catch(() => false),
          invoke<boolean>('agent_cli_available', { tool: 'codex' }).catch(() => false),
        ]);
        setCliStatus({ claude, codex });
      } catch {
        // Not in Tauri — leave as null
      }
    };
    detect();
  }, []);

  const activeStyle = {
    background: 'var(--color-accent-soft)',
    border: '1px solid var(--color-accent-border)',
  };
  const inactiveStyle = {
    background: 'var(--color-panel-2)',
    border: '1px solid var(--color-border)',
  };

  function selectMode(m: AccessMode) {
    warnIfMissionsStayOnProRail(m);
    onChange({ ...settings, accessMode: m });
  }

  function selectCliTool(tool: CliTool) {
    warnIfMissionsStayOnProRail('cli');
    onChange({ ...settings, accessMode: 'cli', cliTool: tool });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)', marginBottom: 4 }}>
        {t('settings.access.title')}
      </div>
      {/* Explains the auto-route + tells the user explicitly that picking
          "Subscription" or "API key" below is how Pro gets turned off. */}
      <div data-testid="access-mode-auto-hint" style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: -6, marginBottom: 2 }}>
        {t('settings.access.autoHint')}
      </div>

      {/* ── Mode 1: CLI subscription ── */}
      <div
        onClick={() => selectMode('cli')}
        style={{
          ...(mode === 'cli' ? activeStyle : inactiveStyle),
          borderRadius: 10,
          padding: '12px 16px',
          cursor: 'pointer',
          transition: 'background 0.12s',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <input
            type="radio"
            name="access-mode"
            checked={mode === 'cli'}
            onChange={() => selectMode('cli')}
            style={{ accentColor: 'var(--color-accent)', cursor: 'pointer' }}
          />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)' }}>
            {t('settings.access.cli.title')}
          </span>
          {mode === 'cli' && (
            <span style={{
              marginLeft: 'auto',
              fontSize: 10,
              fontWeight: 600,
              color: '#4ADE80',
              background: 'rgba(74,222,128,0.1)',
              border: '1px solid rgba(74,222,128,0.25)',
              borderRadius: 4,
              padding: '1px 7px',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}>{activeLabel}</span>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 10, paddingLeft: 26 }}>
          {t('settings.access.cli.desc')}
        </div>

        {/* CLI tool selector */}
        <div style={{ paddingLeft: 26, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* Claude Code */}
          <label style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '7px 10px',
            borderRadius: 7,
            background: (mode === 'cli' && cliTool === 'claude') ? 'rgba(167,139,255,0.1)' : 'var(--color-panel)',
            border: `1px solid ${(mode === 'cli' && cliTool === 'claude') ? 'rgba(167,139,255,0.3)' : 'var(--color-border)'}`,
            cursor: cliStatus.claude === false ? 'not-allowed' : 'pointer',
            opacity: cliStatus.claude === false ? 0.5 : 1,
          }}>
            <input
              type="radio"
              name="cli-tool"
              checked={cliTool === 'claude'}
              disabled={cliStatus.claude === false}
              onChange={() => selectCliTool('claude')}
              style={{ accentColor: 'var(--color-accent)', cursor: 'pointer' }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text)' }}>Claude Code</div>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{t('settings.access.cli.claudeDesc')}</div>
            </div>
            <StatusDot available={cliStatus.claude} />
          </label>

          {/* Codex */}
          <label style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '7px 10px',
            borderRadius: 7,
            background: (mode === 'cli' && cliTool === 'codex') ? 'rgba(116,192,252,0.1)' : 'var(--color-panel)',
            border: `1px solid ${(mode === 'cli' && cliTool === 'codex') ? 'rgba(116,192,252,0.3)' : 'var(--color-border)'}`,
            cursor: cliStatus.codex === false ? 'not-allowed' : 'pointer',
            opacity: cliStatus.codex === false ? 0.5 : 1,
          }}>
            <input
              type="radio"
              name="cli-tool"
              checked={cliTool === 'codex'}
              disabled={cliStatus.codex === false}
              onChange={() => selectCliTool('codex')}
              style={{ accentColor: 'var(--color-accent)', cursor: 'pointer' }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text)' }}>Codex (OpenAI)</div>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{t('settings.access.cli.codexDesc')}</div>
            </div>
            <StatusDot available={cliStatus.codex} />
          </label>
        </div>
      </div>

      {/* ── Mode 2: BYOK ── */}
      <div
        onClick={() => selectMode('byok')}
        style={{
          ...(mode === 'byok' ? activeStyle : inactiveStyle),
          borderRadius: 10,
          padding: '12px 16px',
          cursor: 'pointer',
          transition: 'background 0.12s',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="radio"
            name="access-mode"
            checked={mode === 'byok'}
            onChange={() => selectMode('byok')}
            style={{ accentColor: 'var(--color-accent)', cursor: 'pointer' }}
          />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)' }}>
            {t('settings.access.byok.title')}
          </span>
          {mode === 'byok' && (
            <span style={{
              marginLeft: 'auto',
              fontSize: 10,
              fontWeight: 600,
              color: '#74C0FC',
              background: 'rgba(116,192,252,0.1)',
              border: '1px solid rgba(116,192,252,0.25)',
              borderRadius: 4,
              padding: '1px 7px',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}>{activeLabel}</span>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 6, paddingLeft: 26 }}>
          {t('settings.access.byok.desc')}
        </div>
      </div>

      {/* ── Mode 3: Pro (placeholder) ── */}
      <div
        onClick={() => selectMode('pro')}
        style={{
          ...(mode === 'pro' ? activeStyle : inactiveStyle),
          borderRadius: 10,
          padding: '12px 16px',
          cursor: 'pointer',
          transition: 'background 0.12s',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="radio"
            name="access-mode"
            checked={mode === 'pro'}
            onChange={() => selectMode('pro')}
            style={{ accentColor: 'var(--color-accent)', cursor: 'pointer' }}
          />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)' }}>
            {t('settings.access.pro.title')}
          </span>
          {mode === 'pro' && (
            <span style={{
              marginLeft: 'auto',
              fontSize: 10,
              fontWeight: 600,
              color: '#A78BFF',
              background: 'rgba(167,139,255,0.1)',
              border: '1px solid rgba(167,139,255,0.25)',
              borderRadius: 4,
              padding: '1px 7px',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}>{activeLabel}</span>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 6, paddingLeft: 26 }}>
          {t('settings.access.pro.desc')}
        </div>
      </div>
    </div>
  );
}

// ── Engine info (legacy display) ───────────────────────────────────

function ActiveEngineInfo() {
  const { t } = useI18n();
  const mode = getProviderMode();
  const ENGINE_INFO: Record<string, { label: string; detail: string; color: string }> = {
    'claude-code': {
      label:  t('settings.engine.claudeCode'),
      detail: t('settings.engine.claudeCode.detail'),
      color:  '#A78BFF',
    },
    'codex': {
      label:  t('settings.engine.codex'),
      detail: t('settings.engine.codex.detail'),
      color:  '#74C0FC',
    },
    'live-key': {
      label:  t('settings.engine.liveKey'),
      detail: t('settings.engine.liveKey.detail'),
      color:  '#74C0FC',
    },
    'managed': {
      label:  t('settings.engine.managed'),
      detail: t('settings.engine.managed.detail'),
      color:  '#A78BFF',
    },
    'pro': {
      label:  t('settings.engine.pro'),
      detail: t('settings.engine.pro.detail'),
      color:  '#F6A945',
    },
    'mock': {
      label:  t('settings.engine.mock'),
      detail: t('settings.engine.mock.detail'),
      color:  'rgba(255,255,255,0.4)',
    },
  };
  const info = ENGINE_INFO[mode] ?? ENGINE_INFO['mock']!

  return (
    <div style={{
      padding: '8px 12px',
      background: `${info.color}12`,
      border: `1px solid ${info.color}33`,
      borderRadius: 7,
      marginBottom: 10,
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: info.color, flexShrink: 0 }} />
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: info.color }}>{info.label}</div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{info.detail}</div>
      </div>
    </div>
  );
}

function ModelsTab() {
  const { t } = useI18n();
  const [defaultModelId, setDefaultModelId] = useState<string>(DEFAULT_MODEL.id);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const def of BYOK_PROVIDER_DEFS) init[def.id] = loadByokKey(def.id);
    return init;
  });
  const [baseUrls, setBaseUrls] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const def of BYOK_PROVIDER_DEFS) init[def.id] = loadByokBaseUrl(def.id);
    return init;
  });
  const [modelOverrides, setModelOverrides] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const def of BYOK_PROVIDER_DEFS) init[def.id] = loadByokModel(def.id);
    return init;
  });
  const [accessSettings, setAccessSettings] = useState<AccessSettings>(() => loadAccessSettings());

  function handleApiKeyChange(provider: ByokProvider, key: string) {
    setApiKeys(prev => ({ ...prev, [provider]: key }));
    saveByokKey(provider, key);
  }

  function handleBaseUrlChange(provider: ByokProvider, url: string) {
    setBaseUrls(prev => ({ ...prev, [provider]: url }));
  }

  function handleModelOverrideChange(provider: ByokProvider, model: string) {
    setModelOverrides(prev => ({ ...prev, [provider]: model }));
  }

  function handleAccessChange(next: AccessSettings) {
    setAccessSettings(next);
    saveAccessSettings(next);
  }

  function activateByokProvider(provider: ByokProvider) {
    handleAccessChange({ ...accessSettings, accessMode: 'byok', byokProvider: provider });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {/* Active engine summary */}
      <ActiveEngineInfo />

      {/* 3-mode access selector */}
      <AccessModeSection settings={accessSettings} onChange={handleAccessChange} />

      {/* Per-backend readiness */}
      <div style={{ marginTop: 8, marginBottom: 8 }}>
        <ProvidersPanel />
      </div>

      {/* Per-mode model selection */}
      <div style={{ marginTop: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {t('settings.models.byMode')}
        </div>
        <ModelsAssistantPanel />
      </div>

      {/* BYOK note */}
      <div style={{
        padding: '10px 14px',
        background: 'rgba(124,92,255,0.06)',
        border: '1px solid rgba(124,92,255,0.2)',
        borderRadius: 8,
        fontSize: 12,
        color: 'var(--color-accent-pale)',
        marginBottom: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <span style={{ fontSize: 14 }}>&#128274;</span>
        {t('settings.models.byokLocalNote')}
      </div>

      {/* One section per BYOK provider — key + base URL + model + activate */}
      {BYOK_PROVIDER_DEFS.map(def => (
        <ProviderSection
          key={def.id}
          def={def}
          models={def.models.map(m => ({
            id: m.id,
            label: m.label,
            provider: def.id,
            description: def.label,
          }))}
          defaultModelId={defaultModelId}
          onSelectDefault={setDefaultModelId}
          apiKey={apiKeys[def.id] ?? ''}
          onApiKeyChange={key => handleApiKeyChange(def.id, key)}
          baseUrl={baseUrls[def.id] ?? ''}
          onBaseUrlChange={url => handleBaseUrlChange(def.id, url)}
          modelOverride={modelOverrides[def.id] ?? ''}
          onModelOverrideChange={model => handleModelOverrideChange(def.id, model)}
          active={accessSettings.accessMode === 'byok' && accessSettings.byokProvider === def.id}
          onActivate={() => activateByokProvider(def.id)}
        />
      ))}
    </div>
  );
}


// QA fix (B3): swatches used to render with no onClick at all (dead UI —
// the "active" ring was hardcoded to the first swatch forever, regardless
// of what was actually applied). Now real: clicking one swaps every
// --color-accent-* custom property at :root (accentTheme.ts derives the
// full hover/active/soft/border/light/pale/lighter set from the one base
// hex) and persists the choice to localStorage, re-applied on boot.
function AppearanceTab() {
  const { t } = useI18n();
  const [accent, setAccentState] = useState<string>(loadStoredAccent);

  function selectAccent(color: string): void {
    setAccent(color);
    setAccentState(color);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{
        padding: '16px',
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
      }}>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 10 }}>{t('settings.appearance.theme')}</div>
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 12px',
          background: 'var(--color-accent-soft)',
          border: '1px solid var(--color-accent-border)',
          borderRadius: 7,
        }}>
          <span style={{ width: 14, height: 14, borderRadius: '50%', background: '#0E0E12', border: '1px solid rgba(255,255,255,0.2)', display: 'inline-block' }} />
          <span style={{ fontSize: 13, color: 'var(--color-text)' }}>{t('settings.appearance.darkDefault')}</span>
        </div>
      </div>
      <div style={{
        padding: '16px',
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
      }}>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 10 }}>{t('settings.appearance.accentColor')}</div>
        <div style={{ display: 'flex', gap: 8 }} data-testid="accent-swatches">
          {ACCENT_PRESETS.map((color) => {
            const active = accent === color;
            return (
              <button
                key={color}
                type="button"
                data-testid="accent-swatch"
                onClick={() => selectAccent(color)}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  background: color,
                  border: active ? '2px solid white' : '2px solid transparent',
                  cursor: 'pointer',
                  outline: 'none',
                }}
                aria-label={`Accent ${color}`}
                aria-pressed={active}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Injected at build/test time from package.json's version — see the `define`
// block in vite.config.ts / vitest.config.ts, kept in lockstep with
// tauri.conf.json's "version" field. QA fix: this used to read
// `?? '0.1.0'` with NO `define` anywhere actually setting the env var, so it
// was always undefined and the settings page silently showed the stale
// '0.1.0' fallback regardless of the real shipping version (0.1.5 at time of
// fix). The literal below is a type-safe last-resort default only — it
// should never actually be hit once the `define` above is wired everywhere
// the app builds, runs, or tests from.
const APP_VERSION: string = import.meta.env.__APP_VERSION__ ?? '0.1.19';

// ── Updater Section ────────────────────────────────────────────────
//
// Talks exclusively to the shared store (src/lib/updateStore.ts — B.2 of
// the auto-update spec), never directly to Rust/IPC or the old
// @tauri-apps/plugin-updater. A check triggered here, from UpdaterService's
// background schedule, or from anywhere else always goes through that SAME
// store, so there is only ever one network check in flight and every
// surface reflects the same terminal state.

const RELATIVE_TIME_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

const SECONDARY_BUTTON_STYLE: React.CSSProperties = {
  padding: '6px 14px',
  background: 'transparent',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  color: 'var(--color-text-muted)',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
  fontFamily: 'inherit',
  flexShrink: 0,
};

const DANGER_BUTTON_STYLE: React.CSSProperties = {
  ...SECONDARY_BUTTON_STYLE,
  background: '#F87171',
  border: 'none',
  color: '#1a0d0d',
  fontWeight: 600,
};

/** "5 minutes ago" / "il y a 5 minutes" / etc — native Intl formatting so
    every locale gets correct grammar/pluralization for free, no extra i18n
    keys needed beyond the `lastChecked` wrapper string. */
function formatLastChecked(iso: string, locale: string): string {
  const diffMs = Math.max(0, Date.now() - new Date(iso).getTime());
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, unitMs] of RELATIVE_TIME_UNITS) {
    if (diffMs >= unitMs) return rtf.format(-Math.round(diffMs / unitMs), unit);
  }
  return rtf.format(0, 'minute');
}

/** Missions currently 'running', from the app-wide agents store — same live
    data FleetCommandBar's "Stop all" count reads (agentsStore.tsx's
    `missions`). Returns 0 outside AgentsStoreProvider instead of throwing —
    defensive only; AgentsStoreProvider always wraps SettingsSpace in the
    real app (see AppShell.tsx). */
function useRunningAgentCount(): number {
  const store = useAgentsStoreOptional();
  if (!store) return 0;
  return store.missions.filter((m) => m.status === 'running').length;
}

type UpdateStoreValue = ReturnType<typeof useUpdateStore>;
type Translate = (key: string, params?: Record<string, string | number>) => string;

function updateStatusText(store: UpdateStoreValue, locale: string, t: Translate): string {
  switch (store.phase) {
    case 'checking':
      return t('settings.update.checking');
    case 'available':
      return t('settings.update.available', { version: store.version ?? '' });
    case 'downloading': {
      const total = store.progress?.total;
      if (total) {
        const pct = Math.round(((store.progress?.downloaded ?? 0) / total) * 100);
        return t('settings.update.downloadingPct', { pct: String(pct) });
      }
      return t('settings.update.downloading');
    }
    case 'staged':
      return t('settings.update.stagedBody');
    case 'error':
      return t('settings.update.error', { message: store.lastError ?? '' });
    case 'idle':
    default:
      return store.lastCheckAt
        ? t('settings.update.lastChecked', { time: formatLastChecked(store.lastCheckAt, locale) })
        : t('settings.update.upToDate');
  }
}

/** Inline expand-style confirmation — the same non-`window.confirm`
    convention MemoryPanel's DangerZoneSection and
    team/redesign/DeleteOrgPanel already use elsewhere in Settings for a
    gated action: an explicit Cancel/Confirm pair instead of a browser
    confirm() dialog. No single reusable <ConfirmDialog> exists in this repo
    (every modal — NewMissionModal, OnboardingModal, CreateAndInviteModal,
    etc — is its own bespoke component) — this reuses the established
    PATTERN in place of a shared component that would be out of this
    file's scope to introduce. */
function RestartConfirmPanel({ count, onCancel, onConfirm }: { count: number; onCancel: () => void; onConfirm: () => void }) {
  const { t } = useI18n();
  const warning = t('settings.update.agentsRunningWarning', { count: String(count) });
  return (
    <div
      role="alertdialog"
      aria-label={warning}
      style={{
        padding: '10px 16px',
        background: 'rgba(248,113,113,0.08)',
        border: '1px solid rgba(248,113,113,0.3)',
        borderRadius: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <div style={{ flex: 1, fontSize: 12, color: 'var(--color-text)' }}>{warning}</div>
      <button onClick={onCancel} style={SECONDARY_BUTTON_STYLE}>{t('common.cancel')}</button>
      <button onClick={onConfirm} style={DANGER_BUTTON_STYLE}>{t('settings.update.restartNow')}</button>
    </div>
  );
}

/** The single contextual action button (Vérifier / Télécharger / Redémarrer
    / Réessayer) — null while a check/download is already in flight (the
    status line alone is enough feedback) or while auto-update is on and a
    version is merely 'available' (the background download is about to take
    over, see UpdaterService.tsx). */
function useUpdateAction(store: UpdateStoreValue, onRestartNeedsConfirm: () => void): { label: string; onClick: () => void } | null {
  const { t } = useI18n();
  if (store.phase === 'staged') return { label: t('settings.update.restartNow'), onClick: onRestartNeedsConfirm };
  if (store.phase === 'error') return { label: t('settings.update.retry'), onClick: () => void store.check() };
  if (store.phase === 'available' && !store.autoUpdate) {
    return { label: t('settings.update.downloadButton'), onClick: () => void store.download() };
  }
  if (store.phase === 'idle') return { label: t('settings.update.checkButton'), onClick: () => void store.check() };
  return null;
}

function UpdateSection() {
  const { t, locale } = useI18n();
  const store = useUpdateStore();
  const runningAgentCount = useRunningAgentCount();
  const [confirmingRestart, setConfirmingRestart] = useState(false);

  const busy = store.phase === 'checking' || store.phase === 'downloading';
  const isError = store.phase === 'error';

  function handleRestartClick() {
    if (runningAgentCount > 0) {
      setConfirmingRestart(true);
      return;
    }
    void store.restartAndApply();
  }

  function handleConfirmRestart() {
    setConfirmingRestart(false);
    void store.restartAndApply();
  }

  const action = useUpdateAction(store, handleRestartClick);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{
        padding: '12px 16px',
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, color: 'var(--color-text)', fontWeight: 500, marginBottom: 2 }}>
            {t('settings.update.title')}
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 4 }}>
            {t('settings.update.currentVersion', { version: APP_VERSION })}
          </div>
          {store.phase === 'staged' ? (
            <>
              <div style={{ fontSize: 11, color: 'var(--color-text)', fontWeight: 600 }}>
                {t('settings.update.stagedTitle', { version: store.version ?? '' })}
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                {t('settings.update.stagedBody')}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 11, color: isError ? '#F87171' : 'var(--color-text-muted)' }}>
              {updateStatusText(store, locale, t)}
            </div>
          )}
          {(store.phase === 'available' || store.phase === 'staged') && store.notes && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text)', marginBottom: 2 }}>
                {t('settings.update.whatsNew')}
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'pre-wrap' }}>
                {store.notes}
              </div>
            </div>
          )}
        </div>
        {action && (
          <button
            onClick={action.onClick}
            disabled={busy}
            style={{
              padding: '6px 14px',
              background: busy ? 'rgba(124,92,255,0.3)' : 'var(--color-accent)',
              border: 'none',
              borderRadius: 6,
              color: busy ? 'rgba(255,255,255,0.5)' : '#fff',
              fontSize: 12,
              fontWeight: 600,
              cursor: busy ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              flexShrink: 0,
              transition: 'background 0.15s',
            }}
          >
            {action.label}
          </button>
        )}
      </div>

      {confirmingRestart && (
        <RestartConfirmPanel
          count={runningAgentCount}
          onCancel={() => setConfirmingRestart(false)}
          onConfirm={handleConfirmRestart}
        />
      )}

      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '12px 16px',
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 8,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, color: 'var(--color-text)', fontWeight: 500, marginBottom: 2 }}>
            {t('settings.update.autoUpdateLabel')}
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
            {t('settings.update.autoUpdateHint')}
          </div>
        </div>
        <div
          role="switch"
          aria-checked={store.autoUpdate}
          aria-label={t('settings.update.autoUpdateLabel')}
          tabIndex={0}
          onClick={() => void store.setAuto(!store.autoUpdate)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void store.setAuto(!store.autoUpdate); }
          }}
          style={{
            width: 36,
            height: 20,
            borderRadius: 10,
            background: store.autoUpdate ? 'var(--color-accent)' : 'rgba(255,255,255,0.12)',
            flexShrink: 0,
            position: 'relative',
            cursor: 'pointer',
          }}
        >
          <div style={{
            position: 'absolute',
            top: 3,
            left: store.autoUpdate ? 19 : 3,
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: '#fff',
            transition: 'left 0.15s',
          }} />
        </div>
      </div>
    </div>
  );
}

// ── Version telemetry toggle ────────────────────────────────────────
//
// Gates reportAppVersion() (src/lib/billing/useSubscription.ts) — see
// telemetryPrefs.ts. Same role="switch" pattern as UpdateSection's
// autoUpdate toggle above (aria-checked, click + Enter/Space), but backed
// by plain localStorage (telemetryPrefs.ts) instead of a Rust-synced store:
// this preference has no Rust-side counterpart to stay in sync with, it
// only gates a client-side RPC call. Defaults to enabled.

function TelemetrySection() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState<boolean>(loadVersionTelemetryEnabled);

  function toggle() {
    const next = !enabled;
    setEnabled(next);
    saveVersionTelemetryEnabled(next);
  }

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      padding: '12px 16px',
      background: 'var(--color-panel-2)',
      border: '1px solid var(--color-border)',
      borderRadius: 8,
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, color: 'var(--color-text)', fontWeight: 500, marginBottom: 2 }}>
          {t('settings.general.versionTelemetry')}
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
          {t('settings.general.versionTelemetry.desc')}
        </div>
      </div>
      <div
        role="switch"
        aria-checked={enabled}
        aria-label={t('settings.general.versionTelemetry')}
        data-testid="version-telemetry-toggle"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        }}
        style={{
          width: 36,
          height: 20,
          borderRadius: 10,
          background: enabled ? 'var(--color-accent)' : 'rgba(255,255,255,0.12)',
          flexShrink: 0,
          position: 'relative',
          cursor: 'pointer',
        }}
      >
        <div style={{
          position: 'absolute',
          top: 3,
          left: enabled ? 19 : 3,
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: '#fff',
          transition: 'left 0.15s',
        }} />
      </div>
    </div>
  );
}

// ── Static toggle row ────────────────────────────────────────────────
//
// Display-only card (no onClick/role="switch" — unlike TelemetrySection's
// and UpdateSection's own interactive toggles above): these settings are
// not yet wired to real state/handlers, matching the behaviour this had
// before it was extracted here. Shared by every <SettingsSection> below
// that just needs a labelled on/off row, so the next static setting only
// needs a new array entry, not a new copy of this markup.

interface StaticToggleRowProps {
  label: string;
  sub: string;
  value: boolean;
}

function StaticToggleRow({ label, sub, value }: StaticToggleRowProps) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      padding: '12px 16px',
      background: 'var(--color-panel-2)',
      border: '1px solid var(--color-border)',
      borderRadius: 8,
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, color: 'var(--color-text)', fontWeight: 500, marginBottom: 2 }}>{label}</div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{sub}</div>
      </div>
      <div style={{
        width: 36,
        height: 20,
        borderRadius: 10,
        background: value ? 'var(--color-accent)' : 'rgba(255,255,255,0.12)',
        flexShrink: 0,
        position: 'relative',
        cursor: 'pointer',
      }}>
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
    </div>
  );
}

// ── Settings section ────────────────────────────────────────────────
//
// A labelled group of cards — the General tab's own extensibility seam.
// Previously every setting here (9 of them, and growing) sat in one flat
// list with no grouping at all. The next new General-tab setting should
// join whichever <SettingsSection> below already matches it (Brain,
// Agents, Preferences, Privacy, Updates); only add a new section if it
// genuinely doesn't fit any existing one — never go back to appending to
// one flat list.

interface SettingsSectionProps {
  title: string;
  children: React.ReactNode;
}

function SettingsSection({ title, children }: SettingsSectionProps) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--color-text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
      }}>
        {title}
      </div>
      {children}
    </section>
  );
}

function GeneralTab() {
  const { t, locale, setLocale, LOCALES } = useI18n();

  const BRAIN_TOGGLES = [
    { label: t('settings.general.autoMemory'), sub: t('settings.general.autoMemory.desc'), value: true },
    { label: t('settings.general.tokenSaverBadge'), sub: t('settings.general.tokenSaverBadge.desc'), value: true },
  ];
  const AGENT_TOGGLES = [
    { label: t('settings.general.dualJudge'), sub: t('settings.general.dualJudge.desc'), value: true },
    { label: t('settings.general.agentNotifications'), sub: t('settings.general.agentNotifications.desc'), value: false },
  ];

  function handleRerunOnboarding() {
    resetOnboarding();
    // Force a page reload so the onboarding hook re-reads localStorage.
    window.location.reload();
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <SettingsSection title={t('settings.section.brain')}>
        {BRAIN_TOGGLES.map(toggle => (
          <StaticToggleRow key={toggle.label} {...toggle} />
        ))}
      </SettingsSection>

      <SettingsSection title={t('settings.section.agents')}>
        {AGENT_TOGGLES.map(toggle => (
          <StaticToggleRow key={toggle.label} {...toggle} />
        ))}
      </SettingsSection>

      <SettingsSection title={t('settings.section.preferences')}>
        {/* Language switcher */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '12px 16px',
          background: 'var(--color-panel-2)',
          border: '1px solid var(--color-border)',
          borderRadius: 8,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, color: 'var(--color-text)', fontWeight: 500, marginBottom: 2 }}>
              {t('settings.language')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
              {t('settings.language.desc')}
            </div>
          </div>
          <select
            value={locale}
            onChange={(e) => setLocale(e.target.value as typeof locale)}
            style={{
              padding: '6px 12px',
              background: 'var(--color-panel)',
              border: '1px solid var(--color-border)',
              borderRadius: 6,
              color: 'var(--color-text)',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
              flexShrink: 0,
            }}
          >
            {LOCALES.map(l => (
              <option key={l.code} value={l.code}>
                {l.flag} {l.label}
              </option>
            ))}
          </select>
        </div>

        {/* Re-run onboarding affordance */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '12px 16px',
          background: 'var(--color-panel-2)',
          border: '1px solid var(--color-border)',
          borderRadius: 8,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, color: 'var(--color-text)', fontWeight: 500, marginBottom: 2 }}>
              {t('settings.rerunOnboarding')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
              {t('settings.rerunOnboarding.desc')}
            </div>
          </div>
          <button
            onClick={handleRerunOnboarding}
            style={{
              padding: '6px 14px',
              background: 'transparent',
              border: '1px solid var(--color-border)',
              borderRadius: 6,
              color: 'var(--color-text-muted)',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
              flexShrink: 0,
            }}
          >
            {t('settings.rerunOnboarding.action')}
          </button>
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.section.privacy')}>
        <TelemetrySection />
      </SettingsSection>

      <SettingsSection title={t('settings.section.updates')}>
        <UpdateSection />
      </SettingsSection>
    </div>
  );
}

// ── SettingsSpace ──────────────────────────────────────────────────

export function SettingsSpace({ initialTab = 'general', initialAuthMode }: SettingsSpaceProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const { t } = useI18n();

  useEffect(() => {
    setActiveTab(initialTab); // eslint-disable-line react-hooks/set-state-in-effect
  }, [initialTab]);

  function renderTab() {
    switch (activeTab) {
      case 'models':     return <ModelsTab />;
      case 'account':    return <AccountTab initialAuthMode={initialAuthMode} />;
      case 'memory':     return <MemoryPanel />;
      case 'agents':     return <AgentsPanel />;
      case 'appearance': return <AppearanceTab />;
      case 'general':    return <GeneralTab />;
      case 'health':     return <HealthPanel />;
      case 'solari':     return <SolariPanel />;
    }
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--color-bg)' }}>
      {/* Header */}
      <div style={{ padding: '16px 24px 0', borderBottom: '1px solid var(--color-border)', background: 'var(--color-panel)' }}>
        <h1 style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text)', marginBottom: 12 }}>
          {t('nav.settings')}
        </h1>
        <TabBar active={activeTab} onChange={setActiveTab} />
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }}>
        {renderTab()}
      </div>
    </div>
  );
}
