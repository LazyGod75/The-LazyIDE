/**
 * SymbolPicker — Go to Symbol in file (Ctrl+Shift+O / Cmd+Shift+O).
 *
 * Uses workspace/symbol via the platform LSP bridge when available.
 * Falls back to an empty state labelled "LSP unavailable" when not.
 * Never throws; never blocks the editor.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Lsp } from '../../lib/platform/types';
import { stripVerbatimPrefix } from '../../lib/paths';
import { useI18n } from '../../i18n';

// ── LSP symbol shapes (minimal) ───────────────────────────────────

interface LspSymbolInformation {
  name: string;
  kind: number;
  location: {
    uri: string;
    range: {
      start: { line: number; character: number };
    };
  };
}

// LSP SymbolKind labels (1-26)
const SYMBOL_KIND_LABEL: Record<number, string> = {
  1: 'File', 2: 'Module', 3: 'Namespace', 4: 'Package',
  5: 'Class', 6: 'Method', 7: 'Property', 8: 'Field',
  9: 'Constructor', 10: 'Enum', 11: 'Interface', 12: 'Function',
  13: 'Variable', 14: 'Constant', 15: 'String', 16: 'Number',
  17: 'Boolean', 18: 'Array', 19: 'Object', 20: 'Key',
  21: 'Null', 22: 'EnumMember', 23: 'Struct', 24: 'Event',
  25: 'Operator', 26: 'TypeParameter',
};

function kindLabel(kind: number): string {
  return SYMBOL_KIND_LABEL[kind] ?? '?';
}

// ── Props ─────────────────────────────────────────────────────────

interface SymbolPickerProps {
  lsp: Lsp;
  /** Repository root — required to resolve the LSP server id. */
  repoPath: string;
  /** LSP language identifier (e.g. "typescript", "javascript"). */
  language: string;
  /** Current open file path (used to filter document symbols). */
  filePath: string;
  /** Called with 1-based line to jump to. */
  onJump: (line: number) => void;
  /** Called when the picker is dismissed without a selection. */
  onClose: () => void;
}

// ── Component ─────────────────────────────────────────────────────

export function SymbolPicker({ lsp, repoPath, language, filePath, onJump, onClose }: SymbolPickerProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [symbols, setSymbols] = useState<LspSymbolInformation[]>([]);
  const [lspAvailable, setLspAvailable] = useState<boolean | null>(null);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Check LSP availability once on mount.
  useEffect(() => {
    lsp.available(language).then(setLspAvailable).catch(() => setLspAvailable(false));
  }, [lsp, language]);

  // Fetch document symbols when available.
  useEffect(() => {
    if (!lspAvailable || !filePath) return;

    // Strip a Windows verbatim (`\\?\`) prefix before normalizing — same
    // fix as lspClient.ts's pathToUri, and the same reason: left in place,
    // it survives backslash normalization as a doubled leading slash and
    // produces a malformed `file://` URI for a canonicalize()-sourced path
    // (see paths.ts's header for this bug class's history).
    const normalizedFilePath = stripVerbatimPrefix(filePath).replace(/\\/g, '/');
    const fileUri = normalizedFilePath.startsWith('/')
      ? `file://${normalizedFilePath}`
      : `file:///${normalizedFilePath}`;

    lsp
      .request(repoPath, language, 'textDocument/documentSymbol', {
        textDocument: { uri: fileUri },
      })
      .then((res) => {
        if (!Array.isArray(res)) {
          setSymbols([]);
          return;
        }
        // Flatten — may be SymbolInformation[] or DocumentSymbol[]
        const flat: LspSymbolInformation[] = (res as LspSymbolInformation[]).filter(
          (s) => s && s.name && s.location,
        );
        setSymbols(flat);
      })
      .catch(() => setSymbols([]));
  }, [lsp, repoPath, language, filePath, lspAvailable]);

  // Focus input on mount.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = query
    ? symbols.filter((s) => s.name.toLowerCase().includes(query.toLowerCase()))
    : symbols;

  // selected is reset in the onChange handler below (avoids set-state-in-effect lint rule).

  const handleSelect = useCallback(
    (sym: LspSymbolInformation) => {
      onJump(sym.location.range.start.line + 1);
      onClose();
    },
    [onJump, onClose],
  );

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((prev) => Math.min(prev + 1, filtered.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((prev) => Math.max(prev - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      const sym = filtered[selected];
      if (sym) handleSelect(sym);
    }
  }

  // Scroll selected item into view.
  useEffect(() => {
    const el = listRef.current?.children[selected] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  return (
    <div
      style={{
        position: 'absolute',
        top: 48,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 480,
        maxWidth: '90vw',
        background: '#1A1A24',
        border: '1px solid rgba(124,92,255,0.35)',
        borderRadius: 8,
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
        zIndex: 999,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div
        style={{
          padding: '6px 12px',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          fontSize: 10,
          color: 'rgba(255,255,255,0.3)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
        }}
      >
        Go to Symbol
        {lspAvailable === false && (
          <span style={{ marginLeft: 8, color: '#F07178' }}>
            {t('symbolPicker.unavailable')}
          </span>
        )}
      </div>

      {/* Search input */}
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
        onKeyDown={handleKeyDown}
        placeholder={lspAvailable === false ? t('symbolPicker.lspPlaceholder') : t('symbolPicker.filterPlaceholder')}
        disabled={lspAvailable === false}
        style={{
          background: 'transparent',
          border: 'none',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          color: '#D5D8E0',
          fontSize: 13,
          fontFamily: "'JetBrains Mono', monospace",
          padding: '8px 12px',
          outline: 'none',
          width: '100%',
          boxSizing: 'border-box',
        }}
      />

      {/* Symbol list */}
      <div
        ref={listRef}
        style={{
          maxHeight: 320,
          overflowY: 'auto',
          padding: '4px 0',
        }}
      >
        {lspAvailable === null && (
          <div style={{ padding: '8px 12px', color: 'rgba(255,255,255,0.3)', fontSize: 12 }}>
            {t('symbolPicker.checkingLsp')}
          </div>
        )}

        {lspAvailable === false && (
          <div style={{ padding: '8px 12px', color: '#F07178', fontSize: 12 }}>
            {t('symbolPicker.lspNotRunning')}
          </div>
        )}

        {lspAvailable === true && filtered.length === 0 && (
          <div style={{ padding: '8px 12px', color: 'rgba(255,255,255,0.3)', fontSize: 12 }}>
            {symbols.length === 0 ? t('symbolPicker.noSymbols') : t('symbolPicker.noMatches')}
          </div>
        )}

        {lspAvailable === true &&
          filtered.map((sym, i) => (
            <div
              key={`${sym.name}-${i}`}
              role="option"
              aria-selected={i === selected}
              onClick={() => handleSelect(sym)}
              style={{
                padding: '4px 12px',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                cursor: 'pointer',
                fontSize: 12,
                color: i === selected ? '#E6E8EF' : 'rgba(255,255,255,0.6)',
                background: i === selected ? 'rgba(124,92,255,0.15)' : 'transparent',
              }}
              onMouseEnter={() => setSelected(i)}
            >
              <span
                style={{
                  color: '#7C5CFF',
                  fontSize: 10,
                  minWidth: 68,
                  flexShrink: 0,
                }}
              >
                {kindLabel(sym.kind)}
              </span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {sym.name}
              </span>
              <span style={{ color: 'rgba(255,255,255,0.2)', fontSize: 10, flexShrink: 0 }}>
                :{sym.location.range.start.line + 1}
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}
