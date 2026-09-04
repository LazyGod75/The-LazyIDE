/* BotPersonaEditor — inline system-prompt editor for a LazyBot persona. */

import { useState } from 'react';
import type { BotConfig } from '../../lib/bots/botTypes';

interface BotPersonaEditorProps {
  bot: BotConfig;
  onSave: (systemPrompt: string) => void;
}

export function BotPersonaEditor({ bot, onSave }: BotPersonaEditorProps) {
  const [draft, setDraft] = useState(bot.systemPrompt);
  const dirty = draft !== bot.systemPrompt;

  return (
    <div style={S.section} data-testid="bot-persona-editor">
      <div style={S.sectionTitle}>Persona</div>
      <textarea
        style={S.textarea}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={8}
        aria-label="Bot persona"
      />
      <button
        style={S.save}
        disabled={!dirty || !draft.trim()}
        onClick={() => onSave(draft.trim())}
      >
        Save persona
      </button>
    </div>
  );
}

const S = {
  section: { display: 'flex', flexDirection: 'column' as const, gap: 8 },
  sectionTitle: {
    fontSize: 11, fontWeight: 600, color: '#9994B8',
    textTransform: 'uppercase' as const, letterSpacing: '0.05em',
  },
  textarea: {
    background: '#0E0E14', border: '1px solid rgba(124,92,255,0.2)',
    borderRadius: 8, padding: '10px 12px', color: '#E2E2F0', fontSize: 13,
    fontFamily: 'monospace', outline: 'none', resize: 'vertical' as const,
    width: '100%', boxSizing: 'border-box' as const, minHeight: 140,
  },
  save: {
    alignSelf: 'flex-start' as const, padding: '8px 14px', borderRadius: 8,
    cursor: 'pointer', background: 'rgba(124,92,255,0.2)',
    border: '1px solid rgba(124,92,255,0.5)', color: '#B8A9FF',
    fontSize: 13, fontWeight: 600,
  },
};
