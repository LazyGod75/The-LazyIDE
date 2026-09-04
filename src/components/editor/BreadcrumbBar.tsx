import { useState, useEffect, useRef } from 'react';
import type { Lsp } from '../../lib/platform/types';
import { basename, stripVerbatimPrefix } from '../../lib/paths';
import { relativeToRoot } from './codespace/fileTree';

interface BreadcrumbBarProps {
  path: string;
  filename: string;
  lsp: Lsp;
  repoPath: string;
  /** Root of the open project that owns `path` (as resolved by
   *  findOwningProject — see EditorPane.tsx), or null when `path` isn't
   *  under any currently open project. Distinct from `repoPath` above,
   *  which is the LSP workspace root and may differ in a multi-project
   *  session. Drives the breadcrumb's project-relative rendering below. */
  projectRoot: string | null;
  language: string;
  onJump: (line: number) => void;
}

/**
 * Breadcrumb crumb segments for `path`: workspace-relative (VS Code
 * convention) when `projectRoot` is known — project name first, then each
 * path segment under it — or the raw absolute path (verbatim-prefix
 * stripped) when `projectRoot` is null, e.g. a file outside any open
 * project (degrades gracefully rather than crashing).
 *
 * Reuses relativeToRoot (fileTree.ts, itself built on paths.ts's shared
 * stripVerbatimPrefix) and basename (paths.ts) instead of re-deriving
 * `\\?\` verbatim-prefix handling here — see paths.ts's header comment for
 * the project's policy against re-deriving that logic ad hoc. Exported for
 * unit testing without rendering the full component (LSP client, dropdown
 * listeners, etc.).
 */
export function breadcrumbSegments(path: string, projectRoot: string | null): string[] {
  if (projectRoot) {
    const relPath = relativeToRoot(projectRoot, path);
    // relPath is relativeToRoot's own already-normalized output (verbatim
    // prefix stripped, forward-slash unified) — splitting it further is
    // safe, not a second raw-path derivation.
    // path-lint-ignore: relPath already normalized by relativeToRoot above
    return [basename(projectRoot), ...relPath.split(/[\\/]+/).filter(Boolean)];
  }
  return stripVerbatimPrefix(path).split(/[\\/]+/).filter(Boolean);
}

interface SymbolInfo {
  name: string;
  kind: number;
  line: number;
}

export function BreadcrumbBar({ path, filename, lsp, repoPath, projectRoot, language, onJump }: BreadcrumbBarProps) {
  const [symbols, setSymbols] = useState<SymbolInfo[]>([]);
  const [currentSymbol, setCurrentSymbol] = useState<string | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [hoveredSym, setHoveredSym] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setSymbols([]);
    setCurrentSymbol(null);

    lsp.available(language).then(ok => {
      if (!ok || cancelled) return;
      lsp.request(repoPath, language, 'textDocument/documentSymbol', {
        textDocument: { uri: `file://${path}` },
      }).then((result: unknown) => {
        if (cancelled || !Array.isArray(result)) return;
        const mapped: SymbolInfo[] = (result as Array<Record<string, unknown>>).map(s => {
          const loc = s.location as Record<string, unknown> | undefined;
          const range = (loc?.range ?? s.range) as Record<string, unknown> | undefined;
          const start = range?.start as Record<string, unknown> | undefined;
          return {
            name: String(s.name ?? ''),
            kind: Number(s.kind ?? 0),
            line: Number(start?.line ?? 0) + 1,
          };
        });
        setSymbols(mapped);
      }).catch(() => {});
    });

    return () => { cancelled = true; };
  }, [path, lsp, repoPath, language]);

  useEffect(() => {
    if (!showDropdown) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setShowDropdown(false); }
    function onMouseDown(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setShowDropdown(false);
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onMouseDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onMouseDown); };
  }, [showDropdown]);

  const pathSegments = breadcrumbSegments(path, projectRoot);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: '4px 12px',
        background: 'rgba(255,255,255,0.02)',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        fontSize: 11,
        color: 'rgba(255,255,255,0.4)',
        flexShrink: 0,
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      }}
    >
      {pathSegments.slice(0, -1).map((seg, i) => (
        <span key={i} style={{ opacity: 0.5, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          {seg}
          <svg width="6" height="10" viewBox="0 0 6 10" fill="none" style={{ opacity: 0.3, flexShrink: 0 }}>
            <path d="M1 1l4 4-4 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      ))}
      <span style={{ color: 'rgba(255,255,255,0.6)', fontWeight: 500 }}>
        {filename}
      </span>
      {symbols.length > 0 && (
        <>
          <svg width="6" height="10" viewBox="0 0 6 10" fill="none" style={{ opacity: 0.3, flexShrink: 0 }}>
            <path d="M1 1l4 4-4 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div ref={dropdownRef} style={{ position: 'relative' }}>
            <button
              onClick={() => setShowDropdown(!showDropdown)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--color-accent-light)',
                cursor: 'pointer',
                fontSize: 11,
                fontFamily: 'inherit',
                padding: 0,
              }}
            >
              {currentSymbol ?? 'Symbols'}
            </button>
            {showDropdown && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  background: '#1C1C2A',
                  border: '1px solid rgba(124,92,255,0.3)',
                  borderRadius: 6,
                  maxHeight: 300,
                  overflowY: 'auto',
                  zIndex: 100,
                  minWidth: 200,
                  boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                }}
              >
                {symbols.map((sym, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      onJump(sym.line);
                      setCurrentSymbol(sym.name);
                      setShowDropdown(false);
                    }}
                    onMouseEnter={() => setHoveredSym(sym.name)}
                    onMouseLeave={() => setHoveredSym(null)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      background: hoveredSym === sym.name ? 'rgba(124,92,255,0.1)' : 'transparent',
                      border: 'none',
                      color: '#D5D8E0',
                      cursor: 'pointer',
                      fontSize: 11,
                      fontFamily: 'inherit',
                      padding: '6px 12px',
                    }}
                  >
                    {sym.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
