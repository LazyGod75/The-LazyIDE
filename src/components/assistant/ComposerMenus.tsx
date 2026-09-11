/* ComposerMenus — mode selector (Ask/Plan/Edit) and model selector popovers
   used by Composer.tsx. Extracted to keep Composer.tsx under the file-size
   guideline — purely presentational, no store access of their own. */

import type { ChatMode } from '../../lib/models';
import { MODELS_BY_PROVIDER } from '../../lib/models';
import { OPENROUTER_MODELS_BY_PROVIDER } from '../../lib/models/openrouterCatalog';
import { devinModelInfos } from '../../lib/models/devinCatalog';

// ── Mode config ───────────────────────────────────────────────────

export interface ModeOption {
  id: ChatMode;
  label: string;
  subtitleKey: string;
}

export const MODES: ModeOption[] = [
  { id: 'ask',  label: 'Ask',  subtitleKey: 'assistant.mode.ask.subtitle' },
  { id: 'plan', label: 'Plan', subtitleKey: 'assistant.mode.plan.subtitle' },
  { id: 'edit', label: 'Edit', subtitleKey: 'assistant.mode.edit.subtitle' },
];

// ── Mode icon ─────────────────────────────────────────────────────

export function ModeIcon({ modeId, active }: { modeId: ChatMode; active: boolean }) {
  const color = active ? 'var(--color-accent-light)' : 'rgba(255,255,255,0.5)';
  if (modeId === 'ask') {
    return (
      <span style={{ color }}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M8 1L3 8h5l-2 5 6-7H7L8 1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
        </svg>
      </span>
    );
  }
  if (modeId === 'plan') {
    return (
      <span style={{ color }}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <rect x="3" y="2" width="8" height="10" rx="1" stroke="currentColor" strokeWidth="1.2"/>
          <line x1="5" y1="5" x2="9" y2="5" stroke="currentColor" strokeWidth="1"/>
          <line x1="5" y1="7.5" x2="9" y2="7.5" stroke="currentColor" strokeWidth="1"/>
        </svg>
      </span>
    );
  }
  return (
    <span style={{ color }}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M9.5 2.5l2 2-7 7H2.5V9l7-6.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
      </svg>
    </span>
  );
}

// ── ModePopover ───────────────────────────────────────────────────

interface ModePopoverProps {
  current: ChatMode;
  onSelect: (mode: ChatMode) => void;
  onClose: () => void;
  t: (key: string) => string;
}

export function ModePopover({ current, onSelect, onClose, t }: ModePopoverProps) {
  return (
    <div
      style={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        marginBottom: 6,
        background: '#1C1C2A',
        border: '1px solid rgba(124,92,255,0.3)',
        borderRadius: 8,
        overflow: 'hidden',
        zIndex: 100,
        minWidth: 190,
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
      }}
    >
      {MODES.map(mode => (
        <button
          key={mode.id}
          onClick={() => { onSelect(mode.id); onClose(); }}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            padding: '8px 12px',
            width: '100%',
            background: mode.id === current ? 'rgba(124,92,255,0.12)' : 'transparent',
            border: 'none',
            cursor: 'pointer',
            textAlign: 'left',
            fontFamily: 'inherit',
          }}
        >
          <ModeIcon modeId={mode.id} active={mode.id === current} />
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: mode.id === current ? 'var(--color-accent-light)' : '#D5D8E0' }}>
              {mode.label}
            </div>
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginTop: 1 }}>
              {t(mode.subtitleKey)}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

// ── ModelDropdown ─────────────────────────────────────────────────

export interface ModelDropdownProps {
  currentId: string;
  showNative: boolean;
  showOpenRouter: boolean;
  /** Devin CLI detected — renders the ACP-harvested catalog (SWE-2 + the
   *  account's model list) as its own section, between the native and the
   *  Pro groups. */
  showDevin: boolean;
  /** Shown instead of the (otherwise empty) dropdown body when neither
      catalog is entitled — see modelPickerOptions.ts's emptyReadiness. */
  emptyMessage?: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  /** Same "presentational, no store access of its own" convention as
   *  ModePopover's own `t` prop above — passed down from Composer.tsx's
   *  useI18n(). */
  t: (key: string, params?: Record<string, string | number>) => string;
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};

const DROPDOWN_STYLE: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  left: 0,
  marginBottom: 6,
  background: '#1C1C2A',
  border: '1px solid rgba(124,92,255,0.3)',
  borderRadius: 8,
  overflow: 'hidden',
  zIndex: 100,
  minWidth: 220,
  maxHeight: 360,
  overflowY: 'auto',
  boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
};

function SectionHeader({ label, color }: { label: string; color: string }) {
  return (
    <div
      style={{
        padding: '6px 12px 4px',
        fontSize: 9,
        fontWeight: 700,
        color,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        borderTop: '1px solid rgba(255,255,255,0.05)',
      }}
    >
      {label}
    </div>
  );
}

export function ModelDropdown({ currentId, showNative, showOpenRouter, showDevin, emptyMessage, onSelect, onClose, t }: ModelDropdownProps) {
  return (
    <div style={DROPDOWN_STYLE}>
      {/* Clear disabled state — neither catalog is entitled right now
          (see modelPickerOptions.ts's emptyReadiness) instead of silently
          rendering an empty dropdown. */}
      {!showNative && !showOpenRouter && !showDevin && (
        <div style={{ padding: '10px 12px', fontSize: 11, color: 'rgba(255,255,255,0.5)', lineHeight: 1.5, maxWidth: 240 }}>
          {emptyMessage}
        </div>
      )}
      {/* Native Anthropic models (CLI / BYOK) */}
      {showNative && Object.entries(MODELS_BY_PROVIDER).map(([providerId, models]) => (
        <div key={`native-${providerId}`}>
          <SectionHeader label={t('assistant.composer.modelSectionSubscription', { provider: PROVIDER_LABELS[providerId] ?? providerId })} color="rgba(255,255,255,0.4)" />
          {models.map(model => (
            <button
              key={model.id}
              onClick={() => { onSelect(model.id); onClose(); }}
              style={{
                display: 'flex',
                flexDirection: 'column',
                padding: '6px 12px',
                width: '100%',
                background: model.id === currentId ? 'rgba(124,92,255,0.12)' : 'transparent',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: 'inherit',
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 500, color: model.id === currentId ? 'var(--color-accent-light)' : '#D5D8E0' }}>
                {model.label}
              </span>
              {model.description && (
                <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', marginTop: 1 }}>
                  {model.description}
                </span>
              )}
            </button>
          ))}
        </div>
      ))}

      {/* Devin CLI catalog (ACP — real account catalog, see devinCatalog.ts) */}
      {showDevin && (
        <div>
          <SectionHeader label="Devin · CLI" color="#2DD4BF" />
          {devinModelInfos().map(model => (
            <button
              key={model.id}
              onClick={() => { onSelect(model.id); onClose(); }}
              style={{
                display: 'flex',
                flexDirection: 'column',
                padding: '6px 12px',
                width: '100%',
                background: model.id === currentId ? 'rgba(124,92,255,0.12)' : 'transparent',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: 'inherit',
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 500, color: model.id === currentId ? 'var(--color-accent-light)' : '#D5D8E0' }}>
                {model.label}
              </span>
              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', marginTop: 1 }}>
                {model.id}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* OpenRouter catalog (Lazy Pro) */}
      {showOpenRouter && Object.entries(OPENROUTER_MODELS_BY_PROVIDER).map(([providerName, models]) => (
        <div key={`or-${providerName}`}>
          <SectionHeader label={`${providerName} · Lazy Pro`} color="#F6A945" />
          {models.map(model => (
            <button
              key={model.id}
              onClick={() => { onSelect(model.id); onClose(); }}
              style={{
                display: 'flex',
                flexDirection: 'column',
                padding: '6px 12px',
                width: '100%',
                background: model.id === currentId ? 'rgba(124,92,255,0.12)' : 'transparent',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: 'inherit',
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 500, color: model.id === currentId ? 'var(--color-accent-light)' : '#D5D8E0' }}>
                {model.label}
              </span>
              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', marginTop: 1 }}>
                {model.tier} · {model.provider}
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
