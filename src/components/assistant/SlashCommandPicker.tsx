/* SlashCommandPicker — filterable list shown when the user types "/" at the
   start of the Composer's message. Mirrors ContextPicker.tsx's established
   popup conventions for this same composer (window-level keydown listener
   for Arrow/Enter/Escape, hover-to-highlight + click-to-select rows, Escape
   closes) instead of introducing a second keyboard-nav mechanism — the data
   shape (SlashCommandDef vs ContextItem) and trigger point (always the start
   of the message, not an arbitrary cursor position) are different enough
   that sharing the component itself was not a clean fit, so this is a
   sibling that follows the same interaction contract.
*/

import { useState, useEffect, useCallback } from 'react';
import { suggestSlashCommands, type SlashCommandDef } from '../../lib/ai/slashCommands';
import { useI18n } from '../../i18n';

interface SlashCommandPickerProps {
  /** Raw typed text, e.g. "/doc" — matched against command names/aliases. */
  query: string;
  onSelect: (def: SlashCommandDef) => void;
  onClose: () => void;
}

export function SlashCommandPicker({ query, onSelect, onClose }: SlashCommandPickerProps) {
  const { t } = useI18n();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const matches = suggestSlashCommands(query);

  // Reset the highlight whenever the filtered set changes so it never points
  // past the end of a narrower list (e.g. typing another character).
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (matches[selectedIndex]) onSelect(matches[selectedIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [matches, selectedIndex, onSelect, onClose]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div
      data-testid="slash-command-picker"
      style={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        right: 0,
        marginBottom: 6,
        background: '#1C1C2A',
        border: '1px solid rgba(124,92,255,0.3)',
        borderRadius: 8,
        overflow: 'hidden',
        zIndex: 100,
        maxHeight: 220,
        overflowY: 'auto',
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
      }}
      onClick={e => e.stopPropagation()}
    >
      {matches.length === 0 && (
        <div style={{ padding: '10px 12px', fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>
          {t('assistant.slashPicker.noMatches')}
        </div>
      )}
      {matches.map((def, i) => (
        <div
          key={def.name}
          data-testid={`slash-command-item-${def.name}`}
          onClick={() => onSelect(def)}
          onMouseEnter={() => setSelectedIndex(i)}
          style={{
            padding: '6px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
            cursor: 'pointer',
            background: i === selectedIndex ? 'rgba(124,92,255,0.12)' : 'transparent',
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 600, color: i === selectedIndex ? 'var(--color-accent-light)' : '#D5D8E0' }}>
            {def.usage}
          </span>
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>
            {def.description}
          </span>
        </div>
      ))}
    </div>
  );
}
