/* ModelsAssistantPanel — per-mode model selection (ask / plan / edit)
   and default agent model, persisted to the same accessSettings store.

   localStorage key: lazy.accessSettings (via loadAccessSettings/saveAccessSettings)
   Additional keys added here:
     lazy.models.modeAsk     — model id for ask mode
     lazy.models.modePlan    — model id for plan mode
     lazy.models.modeEdit    — model id for edit mode
     lazy.models.agentModel  — default model id for agent sub-tasks
*/

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { MODELS_BY_PROVIDER } from '../../lib/models/registry';
import type { ModelInfo } from '../../lib/models/types';
import type { ModelOptionGroup } from '../../lib/models/modelPickerOptions';
import { ModelPickerDropdown } from '../common/ModelPickerDropdown';
import { useI18n } from '../../i18n';

// ── localStorage keys ──────────────────────────────────────────────

export const LS_MODE_ASK    = 'lazy.models.modeAsk';
export const LS_MODE_PLAN   = 'lazy.models.modePlan';
export const LS_MODE_EDIT   = 'lazy.models.modeEdit';
export const LS_AGENT_MODEL = 'lazy.models.agentModel';

// ── All models flattened ───────────────────────────────────────────

function getAllModels(): ModelInfo[] {
  return Object.values(MODELS_BY_PROVIDER).flat();
}

// ── Persistence helpers ────────────────────────────────────────────

interface ModeModels {
  ask:   string;
  plan:  string;
  edit:  string;
  agent: string;
}

function loadModeModels(fallbackId: string): ModeModels {
  const get = (key: string) => {
    try {
      return localStorage.getItem(key) ?? fallbackId;
    } catch {
      return fallbackId;
    }
  };
  return {
    ask:   get(LS_MODE_ASK),
    plan:  get(LS_MODE_PLAN),
    edit:  get(LS_MODE_EDIT),
    agent: get(LS_AGENT_MODEL),
  };
}

function saveModeModels(m: ModeModels): void {
  try {
    localStorage.setItem(LS_MODE_ASK,    m.ask);
    localStorage.setItem(LS_MODE_PLAN,   m.plan);
    localStorage.setItem(LS_MODE_EDIT,   m.edit);
    localStorage.setItem(LS_AGENT_MODEL, m.agent);
  } catch {
    // localStorage unavailable
  }
}

// ── ModelSelect ────────────────────────────────────────────────────

function ModelSelect({
  value,
  onChange,
  models,
}: {
  value: string;
  onChange: (id: string) => void;
  models: ModelInfo[];
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Group the flat provider map into the shared picker's group shape —
  // one group per provider, so a long list stays navigable.
  const groups = useMemo<ModelOptionGroup[]>(
    () =>
      Object.entries(MODELS_BY_PROVIDER).map(([provider, list]) => ({
        id: `prov-${provider}`,
        label: provider,
        models: list.map((m) => ({ id: m.id, label: m.label, provider })),
      })),
    [],
  );

  // Outside-click dismissal — same contract as the header/composer pickers.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const currentLabel = models.find((m) => m.id === value)?.label ?? value;

  return (
    <div ref={rootRef} style={{ position: 'relative', width: 240 }}>
      <button
        type="button"
        data-testid="assistant-model-select"
        onClick={() => setOpen((o) => !o)}
        style={{
          background: 'var(--color-panel)',
          border: '1px solid var(--color-border)',
          borderRadius: 6,
          padding: '6px 10px',
          fontSize: 12,
          color: 'var(--color-text)',
          fontFamily: 'var(--font-mono, monospace)',
          outline: 'none',
          cursor: 'pointer',
          width: '100%',
          textAlign: 'left',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {currentLabel}
        </span>
        <span style={{ opacity: 0.5, flexShrink: 0 }}>▾</span>
      </button>
      {open && (
        <ModelPickerDropdown
          groups={groups}
          currentId={value}
          onSelect={onChange}
          onClose={() => setOpen(false)}
          t={t}
          direction="up"
          optionTestId="assistant-model-option"
          unknownCurrent={models.some((m) => m.id === value) ? undefined : { id: value, label: value }}
        />
      )}
    </div>
  );
}

// ── ModeRow ────────────────────────────────────────────────────────

function ModeRow({
  label,
  sub,
  value,
  onChange,
  models,
}: {
  label: string;
  sub: string;
  value: string;
  onChange: (id: string) => void;
  models: ModelInfo[];
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
        <div style={{ fontSize: 13, color: 'var(--color-text)', fontWeight: 500, marginBottom: 2 }}>
          {label}
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{sub}</div>
      </div>
      <ModelSelect value={value} onChange={onChange} models={models} />
    </div>
  );
}

// ── ModelsAssistantPanel ───────────────────────────────────────────

export function ModelsAssistantPanel() {
  const { t } = useI18n();
  const allModels = getAllModels();
  const fallback = allModels[0]?.id ?? '';

  const [modes, setModes] = useState<ModeModels>(() => loadModeModels(fallback));

  // Persist on every change (immutable update via setModes + useEffect)
  useEffect(() => {
    saveModeModels(modes);
  }, [modes]);

  const update = useCallback(<K extends keyof ModeModels>(key: K, value: string) => {
    setModes(prev => ({ ...prev, [key]: value }));
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{
        fontSize: 12,
        color: 'var(--color-text-muted)',
        marginBottom: 8,
      }}>
        {t('settings.modelsAssistant.intro')}
      </div>

      <div style={{
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
        overflow: 'hidden',
      }}>
        <ModeRow
          label={t('settings.modelsAssistant.ask.label')}
          sub={t('settings.modelsAssistant.ask.sub')}
          value={modes.ask}
          onChange={v => update('ask', v)}
          models={allModels}
        />
        <ModeRow
          label={t('settings.modelsAssistant.plan.label')}
          sub={t('settings.modelsAssistant.plan.sub')}
          value={modes.plan}
          onChange={v => update('plan', v)}
          models={allModels}
        />
        <ModeRow
          label={t('settings.modelsAssistant.edit.label')}
          sub={t('settings.modelsAssistant.edit.sub')}
          value={modes.edit}
          onChange={v => update('edit', v)}
          models={allModels}
        />
        <div style={{
          padding: '12px 16px',
          borderTop: '1px solid var(--color-border)',
        }}>
          <div style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--color-text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginBottom: 10,
          }}>
            {t('settings.modelsAssistant.agentsHeading')}
          </div>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: 'var(--color-text)', fontWeight: 500, marginBottom: 2 }}>
                {t('settings.modelsAssistant.agentModel.label')}
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                {t('settings.modelsAssistant.agentModel.sub')}
              </div>
            </div>
            <ModelSelect
              value={modes.agent}
              onChange={v => update('agent', v)}
              models={allModels}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
