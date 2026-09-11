/* ComposerMenus — mode selector (Ask/Plan/Edit) and model selector popovers
   used by Composer.tsx. Extracted to keep Composer.tsx under the file-size
   guideline — purely presentational, no store access of their own. */

import type { ChatMode } from '../../lib/models';

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

// The model dropdown itself moved to src/components/common/
// ModelPickerDropdown.tsx — a shared searchable/collapsible picker fed by
// modelPickerOptions.ts's normalized groups (the old flat list here was
// unusable once the Devin catalog landed, ~200 rows of scroll).
