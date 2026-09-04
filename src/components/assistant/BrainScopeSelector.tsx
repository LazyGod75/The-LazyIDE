/* BrainScopeSelector — dropdown to pick the brain scope for recall queries.
   Renders next to the brain toggle in the Composer toolbar.
   Only visible when brain is enabled.
*/

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrainScope } from '../../lib/platform/types';
import { getPlatform } from '../../lib/platform';
import { basename } from '../../lib/paths';
import { useI18n } from '../../i18n';

// ── Types ─────────────────────────────────────────────────────────

interface ScopeOption {
  label: string;
  value: BrainScope;
}

const FIXED_OPTIONS: ScopeOption[] = [
  { label: 'This project', value: 'current' },
  { label: 'All brains', value: 'all' },
];

// ── Helpers ───────────────────────────────────────────────────────

function scopeLabel(scope: BrainScope, projects: string[]): string {
  if (scope === 'current') return 'This project';
  if (scope === 'all') return 'All brains';
  const name = basename(scope.project);
  // Verify the project is still configured; fall back gracefully
  if (projects.length > 0 && !projects.includes(scope.project)) return 'This project';
  return name;
}

function scopesEqual(a: BrainScope, b: BrainScope): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  if (typeof a === 'object' && typeof b === 'object') return a.project === b.project;
  return false;
}

// ── Component ─────────────────────────────────────────────────────

interface BrainScopeSelectorProps {
  selectedScope: BrainScope;
  onSelect: (scope: BrainScope) => void;
}

export function BrainScopeSelector({ selectedScope, onSelect }: BrainScopeSelectorProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<string[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load configured project paths once
  useEffect(() => {
    let cancelled = false;
    getPlatform().brain.getProjects().then(list => {
      if (!cancelled) setProjects(list);
    }).catch(() => {
      // Not fatal — project list simply stays empty
    });
    return () => { cancelled = true; };
  }, []);

  const close = useCallback(() => setOpen(false), []);

  const handleSelect = useCallback((scope: BrainScope) => {
    onSelect(scope);
    close();
  }, [onSelect, close]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        close();
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  const label = scopeLabel(selectedScope, projects);

  // Project-specific options (exclude the currently-active project from "pick project" list
  // if scope is already set to that project — still show it so user can switch back)
  const projectOptions: ScopeOption[] = projects.map(p => ({
    label: basename(p),
    value: { project: p } as BrainScope,
  }));

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      {open && (
        <div
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 4px)',
            left: 0,
            background: '#1C1C2A',
            border: '1px solid rgba(34,197,94,0.3)',
            borderRadius: 7,
            overflow: 'hidden',
            zIndex: 110,
            minWidth: 154,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          }}
        >
          {/* Fixed options */}
          {FIXED_OPTIONS.map(opt => (
            <button
              key={String(opt.value)}
              onClick={() => handleSelect(opt.value)}
              style={{
                display: 'block',
                width: '100%',
                padding: '6px 11px',
                background: scopesEqual(selectedScope, opt.value)
                  ? 'rgba(34,197,94,0.12)'
                  : 'transparent',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: 'inherit',
                fontSize: 11,
                color: scopesEqual(selectedScope, opt.value)
                  ? 'var(--color-success-alt)'
                  : '#D5D8E0',
                fontWeight: scopesEqual(selectedScope, opt.value) ? 600 : 400,
              }}
            >
              {opt.label}
            </button>
          ))}

          {/* Divider + per-project list when projects are available */}
          {projectOptions.length > 0 && (
            <>
              <div
                style={{
                  height: 1,
                  background: 'rgba(255,255,255,0.06)',
                  margin: '2px 0',
                }}
              />
              <div
                style={{
                  padding: '3px 11px 2px',
                  fontSize: 9,
                  fontWeight: 700,
                  color: 'rgba(255,255,255,0.3)',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                }}
              >
                Pick project
              </div>
              {projectOptions.map(opt => {
                const projectScope = opt.value as { project: string };
                const isActive = typeof selectedScope === 'object'
                  && selectedScope.project === projectScope.project;
                return (
                  <button
                    key={projectScope.project}
                    onClick={() => handleSelect(opt.value)}
                    title={projectScope.project}
                    style={{
                      display: 'block',
                      width: '100%',
                      padding: '5px 11px',
                      background: isActive ? 'rgba(34,197,94,0.12)' : 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontFamily: 'inherit',
                      fontSize: 11,
                      color: isActive ? 'var(--color-success-alt)' : 'rgba(255,255,255,0.6)',
                      fontWeight: isActive ? 600 : 400,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxWidth: 180,
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}

      {/* Trigger chip */}
      <button
        onClick={() => setOpen(v => !v)}
        title={t('assistant.brainScope.tooltip')}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 3,
          background: open ? 'rgba(34,197,94,0.14)' : 'rgba(34,197,94,0.07)',
          border: `1px solid ${open ? 'rgba(34,197,94,0.35)' : 'rgba(34,197,94,0.18)'}`,
          borderRadius: 5,
          padding: '3px 7px',
          cursor: 'pointer',
          fontFamily: 'inherit',
          transition: 'background 0.15s, border-color 0.15s',
        }}
      >
        <span
          style={{
            fontSize: 10,
            color: 'var(--color-success-alt)',
            fontWeight: 500,
            maxWidth: 80,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label} ▾
        </span>
      </button>
    </div>
  );
}
