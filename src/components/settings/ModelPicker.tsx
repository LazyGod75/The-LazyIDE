/* ModelPicker — Pro model selector shown when accessMode === 'pro'.
   Renders a native <select> grouped by provider (Anthropic, OpenAI, Google,
   xAI, DeepSeek, Meta). Each option shows the model label, a tier badge
   (fast / balanced / max), and a price badge ($ / $$ / $$$).
   When the selected model supports reasoning, a Thinking effort selector
   appears with Off / Low / Medium / High options.
   Persists selection to AccessSettings via saveAccessSettings.
*/

import { useState } from 'react';
import {
  OPENROUTER_MODELS_BY_PROVIDER,
  DEFAULT_OPENROUTER_MODEL_ID,
  findOpenRouterModel,
  priceBadge,
} from '../../lib/models/openrouterCatalog';
import type { OpenRouterModel, ReasoningEffort } from '../../lib/models/openrouterCatalog';
import { loadAccessSettings, saveAccessSettings } from '../../lib/models/accessSettings';
import { getEngineReadiness, engineReasonKey } from '../../lib/models/entitlement';
import { emit } from '../../lib/bus';
import { useI18n } from '../../i18n';
import { FreeModelPrivacyNotice } from './FreeModelPrivacyNotice';

const GOLD = '#F6A945';

// ── Lock glyph (inline SVG — no emoji) ──────────────────────────────

function LockIcon({ color }: { color: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <rect x="3.2" y="7" width="9.6" height="6.4" rx="1.6" stroke={color} strokeWidth="1.5" />
      <path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

// ── Provider ordering ───────────────────────────────────────────────

const PROVIDER_ORDER = ['Anthropic', 'OpenAI', 'Google', 'xAI', 'DeepSeek', 'Meta', 'Free'] as const;

// ── Tier label ──────────────────────────────────────────────────────

function tierLabel(model: OpenRouterModel, t: (key: string) => string): string {
  switch (model.tier) {
    case 'fast':     return t('settings.pro.tier.fast');
    case 'balanced': return t('settings.pro.tier.balanced');
    case 'max':      return t('settings.pro.tier.max');
    case 'free':     return t('settings.pro.tier.free');
  }
}

// ── Tier badge colors ───────────────────────────────────────────────

const TIER_COLOR: Record<string, string> = {
  fast:     '#4ADE80',
  balanced: '#74C0FC',
  max:      '#F6A945',
  free:     '#22D3EE',
};

// ── Pill badge ──────────────────────────────────────────────────────

interface BadgeProps {
  text: string;
  color: string;
}

function Badge({ text, color }: BadgeProps) {
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 700,
        color,
        background: `${color}18`,
        border: `1px solid ${color}44`,
        borderRadius: 3,
        padding: '1px 5px',
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        flexShrink: 0,
        lineHeight: 1.6,
      }}
    >
      {text}
    </span>
  );
}

// ── Model row (label rendered inside the model list) ────────────────

interface ModelRowProps {
  model: OpenRouterModel;
  selected: boolean;
  /** True when the managed catalog is locked (no Pro entitlement, W2.8):
      the row stays visible but is disabled, with a lock glyph + Pro chip. */
  locked: boolean;
  onSelect: () => void;
  t: (key: string) => string;
}

function ModelRow({ model, selected, locked, onSelect, t }: ModelRowProps) {
  const price = priceBadge(model);
  const tierColor = TIER_COLOR[model.tier] ?? '#888';

  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '6px 8px',
        borderRadius: 6,
        cursor: locked ? 'not-allowed' : 'pointer',
        opacity: locked ? 0.55 : 1,
        background: !locked && selected ? 'var(--color-accent-soft)' : 'transparent',
        border: `1px solid ${!locked && selected ? 'var(--color-accent-border)' : 'transparent'}`,
        transition: 'background 0.1s',
      }}
    >
      <input
        type="radio"
        name="pro-model"
        value={model.id}
        checked={!locked && selected}
        disabled={locked}
        onChange={onSelect}
        style={{ accentColor: 'var(--color-accent)', cursor: locked ? 'not-allowed' : 'pointer', flexShrink: 0 }}
      />
      {locked && <LockIcon color={GOLD} />}
      <span
        style={{
          fontSize: 12,
          fontWeight: 500,
          color: 'var(--color-text)',
          flex: 1,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {model.label}
      </span>
      {locked && <Badge text="Pro" color={GOLD} />}
      <Badge text={tierLabel(model, t)} color={tierColor} />
      <Badge text={price} color="rgba(255,255,255,0.45)" />
    </label>
  );
}

// ── Provider group heading ──────────────────────────────────────────

const PROVIDER_COLOR: Record<string, string> = {
  Anthropic: '#A78BFF',
  OpenAI:    '#74C0FC',
  Google:    '#F6A945',
  xAI:       '#4ADE80',
  DeepSeek:  '#60A5FA',
  Meta:      '#F87171',
  Free:      '#22D3EE',
};

interface ProviderGroupProps {
  name: string;
  models: OpenRouterModel[];
  selectedId: string;
  locked: boolean;
  onSelect: (id: string) => void;
  t: (key: string) => string;
}

function ProviderGroup({ name, models, selectedId, locked, onSelect, t }: ProviderGroupProps) {
  const color = PROVIDER_COLOR[name] ?? '#888';
  return (
    <div style={{ marginBottom: 8 }}>
      {/* Provider header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          padding: '4px 8px',
          marginBottom: 3,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: color,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            color,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          {name}
        </span>
      </div>

      {/* Model rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 8 }}>
        {models.map(model => (
          <ModelRow
            key={model.id}
            model={model}
            selected={selectedId === model.id}
            locked={locked}
            onSelect={() => onSelect(model.id)}
            t={t}
          />
        ))}
      </div>
    </div>
  );
}

// ── Thinking effort selector ────────────────────────────────────────

type EffortOption = 'off' | ReasoningEffort;

function getEffortOptions(t: (key: string) => string, supportsMax?: boolean): Array<{ value: EffortOption; label: string }> {
  const opts: Array<{ value: EffortOption; label: string }> = [
    { value: 'off',    label: t('settings.pro.thinking.off') },
    { value: 'low',    label: t('settings.pro.thinking.low') },
    { value: 'medium', label: t('settings.pro.thinking.medium') },
    { value: 'high',   label: t('settings.pro.thinking.high') },
  ];
  if (supportsMax) {
    opts.push({ value: 'max', label: t('settings.pro.thinking.max') });
  }
  return opts;
}

interface ThinkingSelectorProps {
  effort: EffortOption;
  onChange: (v: EffortOption) => void;
  t: (key: string) => string;
  supportsMax?: boolean;
}

function ThinkingSelector({ effort, onChange, t, supportsMax }: ThinkingSelectorProps) {
  const EFFORT_OPTIONS = getEffortOptions(t, supportsMax);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 10px',
        background: 'rgba(167,139,255,0.06)',
        border: '1px solid rgba(167,139,255,0.2)',
        borderRadius: 8,
        marginTop: 6,
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: '#A78BFF',
          flexShrink: 0,
        }}
      >
        {t('settings.pro.thinking')}
      </span>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {EFFORT_OPTIONS.map(opt => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            style={{
              padding: '3px 10px',
              borderRadius: 5,
              border: effort === opt.value
                ? '1px solid rgba(167,139,255,0.55)'
                : '1px solid var(--color-border)',
              background: effort === opt.value
                ? 'rgba(167,139,255,0.15)'
                : 'var(--color-panel)',
              color: effort === opt.value
                ? '#A78BFF'
                : 'var(--color-text-muted)',
              fontSize: 11,
              fontWeight: effort === opt.value ? 600 : 400,
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'background 0.1s',
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── ModelPicker ─────────────────────────────────────────────────────

export function ModelPicker() {
  const { t } = useI18n();
  const initial = loadAccessSettings();
  const resolvedId = findOpenRouterModel(initial.model ?? '')
    ? (initial.model as string)
    : DEFAULT_OPENROUTER_MODEL_ID;

  const [selectedId, setSelectedId] = useState<string>(resolvedId);
  const [effort, setEffort] = useState<EffortOption>(
    initial.reasoningEffort ?? 'medium',
  );
  const [webSearch, setWebSearch] = useState<boolean>(initial.webSearch ?? false);

  // Honest lock (v0.1.5 W2.8): evaluate the Pro engine SPECIFICALLY —
  // choosing the Pro radio is allowed so users can browse the offer, but
  // nothing becomes selectable without an active plan + credits.
  const proReadiness = getEngineReadiness('pro');
  const locked = !proReadiness.ready;

  const selectedModel = findOpenRouterModel(selectedId);
  const supportsReasoning = !locked && selectedModel?.reasoning === true;
  const supportsWebSearch = !locked && selectedModel?.webSearch === true;

  function handleSelectModel(id: string) {
    if (locked) return; // defense in depth — inputs are already disabled
    const model = findOpenRouterModel(id);
    if (!model) return;

    setSelectedId(id);

    // When switching to a non-reasoning model, clear effort from storage
    const nextEffort: EffortOption = model.reasoning ? effort : 'off';

    const current = loadAccessSettings();
    saveAccessSettings({
      ...current,
      model: id,
      reasoningEffort: nextEffort === 'off' ? undefined : nextEffort,
    });
  }

  function handleEffortChange(v: EffortOption) {
    setEffort(v);
    const current = loadAccessSettings();
    saveAccessSettings({
      ...current,
      reasoningEffort: v === 'off' ? undefined : v,
    });
  }

  function handleWebSearchToggle() {
    const next = !webSearch;
    setWebSearch(next);
    const current = loadAccessSettings();
    saveAccessSettings({
      ...current,
      webSearch: next,
    });
  }

  return (
    <div
      data-testid="model-picker"
      style={{
        padding: '12px 14px',
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 8,
        marginTop: 10,
      }}
    >
      {/* Section title */}
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: 'var(--color-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          marginBottom: 10,
        }}
      >
        {t('settings.pro.modelPicker')}
      </div>

      {/* Locked callout — single instance, above the list (W2.8) */}
      {locked && proReadiness.reason && (
        <div
          data-testid="managed-locked-callout"
          role="note"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 10,
            padding: '8px 10px',
            borderRadius: 7,
            background: 'rgba(246,169,69,0.08)',
            border: '1px solid rgba(246,169,69,0.3)',
          }}
        >
          <LockIcon color={GOLD} />
          <span style={{ flex: 1, fontSize: 11, lineHeight: 1.45, color: GOLD }}>
            {t(engineReasonKey(proReadiness.reason))}
          </span>
          <button
            type="button"
            onClick={() => emit('nav:navigateSpace', 'account')}
            style={{
              padding: '5px 12px',
              borderRadius: 6,
              border: 'none',
              background: 'var(--color-accent)',
              color: '#fff',
              fontSize: 11,
              fontWeight: 600,
              fontFamily: 'inherit',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {t('engine.preflight.goPro')}
          </button>
        </div>
      )}

      {/* Provider groups */}
      {PROVIDER_ORDER.map(providerName => {
        const models = OPENROUTER_MODELS_BY_PROVIDER[providerName];
        if (!models || models.length === 0) return null;
        return (
          <ProviderGroup
            key={providerName}
            name={providerName}
            models={models}
            selectedId={selectedId}
            locked={locked}
            onSelect={handleSelectModel}
            t={t}
          />
        );
      })}

      {/* Free-model privacy notice — persistent while a free model is
          selected, placed right below the picker so it's seen at the
          point of selection, before any message is sent. */}
      {!locked && <FreeModelPrivacyNotice isFree={selectedModel?.isFree === true} />}

      {/* Thinking effort — only for reasoning-capable models */}
      {supportsReasoning && (
        <ThinkingSelector effort={effort} onChange={handleEffortChange} t={t} supportsMax={selectedModel?.maxEffort === true} />
      )}

      {/* Web search toggle — only for models that support it */}
      {supportsWebSearch && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 10px',
            background: 'rgba(34,211,238,0.06)',
            border: '1px solid rgba(34,211,238,0.2)',
            borderRadius: 8,
            marginTop: 6,
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: '#22D3EE',
              flexShrink: 0,
            }}
          >
            {t('settings.pro.webSearch')}
          </span>
          <button
            onClick={handleWebSearchToggle}
            style={{
              padding: '3px 10px',
              borderRadius: 5,
              border: webSearch
                ? '1px solid rgba(34,211,238,0.55)'
                : '1px solid var(--color-border)',
              background: webSearch
                ? 'rgba(34,211,238,0.15)'
                : 'var(--color-panel)',
              color: webSearch ? '#22D3EE' : 'var(--color-text-muted)',
              fontSize: 11,
              fontWeight: webSearch ? 600 : 400,
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'background 0.1s',
            }}
          >
            {webSearch ? 'ON' : 'OFF'}
          </button>
        </div>
      )}

      {/* Max tokens info */}
      {selectedModel && (
        <div
          style={{
            marginTop: 6,
            fontSize: 10,
            color: 'var(--color-text-muted)',
            padding: '4px 10px',
          }}
        >
          {t('settings.pro.maxTokens')}: {selectedModel.maxTokens.toLocaleString()}
        </div>
      )}

      {/* Price legend */}
      <div
        style={{
          marginTop: 10,
          fontSize: 10,
          color: 'var(--color-text-muted)',
          lineHeight: 1.5,
        }}
      >
        {t('settings.pro.modelPicker.legend')}
      </div>
    </div>
  );
}
