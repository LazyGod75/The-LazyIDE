/* ModelPickerDropdown — shared searchable model picker popover.

   Why this exists: the LazyManager header used a native <select> whose
   optgroups render fully expanded — fine at 20 models, unusable at 200+
   (the Devin ACP catalog alone is ~80-240 entries). A single flat list is
   equally bad. This component is the SOTA shape for a long catalog:

     - a search field (autofocused) that filters across every group by
       label / id / provider — the primary path once the list is long;
     - collapsible group sections — only the group holding the CURRENT
       selection (and the always-tiny 'free' group) starts expanded, so the
       default view is a dozen rows, not a wall;
     - compact single-line rows (label + provider/id tag);
     - a locked (non-selectable) group rendered last for upsell, collapsed
       by default;
     - the active model auto-scrolls into view on open.

   Consumers own the open/close state and the outside-click dismissal
   (Composer keeps its own pattern, LazyManagerHeader uses useDismissable).
   Escape closes. */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ModelOptionGroup, Translate } from '../../lib/models/modelPickerOptions';

export interface ModelPickerDropdownProps {
  groups: ModelOptionGroup[];
  /** Non-selectable upsell group (Pro catalog when inactive/no-credits). */
  lockedGroup?: ModelOptionGroup;
  currentId: string;
  /** Empty-catalog message — shown when `groups` is empty. */
  emptyMessage?: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  t: Translate;
  /** 'up' opens above the trigger (composer), 'down' below (header). */
  direction?: 'up' | 'down';
  /** data-testid for each selectable row — keeps callers' tests stable. */
  optionTestId?: string;
  lockedOptionTestId?: string;
  /** Extra row rendered inside the list for a persisted id that no catalog
   *  group knows (GraphProposalCard's stale-per-step-model case). */
  unknownCurrent?: { id: string; label: string };
}

const PANEL_STYLE: React.CSSProperties = {
  position: 'absolute',
  background: '#1C1C2A',
  border: '1px solid rgba(124,92,255,0.3)',
  borderRadius: 8,
  zIndex: 100,
  minWidth: 240,
  maxWidth: 320,
  boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};

const GROUP_COLOR: Record<string, string> = {
  free: 'rgba(52,211,153,0.85)',
  'claude-sub': '#A78BFF',
  devin: '#2DD4BF',
  pro: '#F6A945',
  byok: '#74C0FC',
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Recently-picked model ids, newest first — persisted across sessions so
 *  the picker's "Recent" row survives a restart. Capped small: the section
 *  exists to re-pick fast, not to mirror the catalog. */
const RECENTS_KEY = 'lazy.modelPicker.recents';
const RECENTS_MAX = 5;

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string').slice(0, RECENTS_MAX) : [];
  } catch {
    return [];
  }
}

function pushRecent(id: string): string[] {
  const next = [id, ...loadRecents().filter((x) => x !== id)].slice(0, RECENTS_MAX);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable (private mode / quota) — recents just won't persist.
  }
  return next;
}

function ModelRow({
  id,
  label,
  meta,
  active,
  locked,
  testId,
  onSelect,
}: {
  id: string;
  label: string;
  meta?: string;
  active: boolean;
  locked?: boolean;
  testId: string;
  onSelect?: (id: string) => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={locked}
      title={locked ? meta : undefined}
      onClick={() => onSelect?.(id)}
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 8,
        padding: '5px 12px',
        width: '100%',
        background: active ? 'rgba(124,92,255,0.14)' : 'transparent',
        border: 'none',
        cursor: locked ? 'not-allowed' : 'pointer',
        textAlign: 'left',
        fontFamily: 'inherit',
        opacity: locked ? 0.45 : 1,
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: active ? 600 : 500,
          color: active ? 'var(--color-accent-light)' : '#D5D8E0',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      {meta && (
        <span
          style={{
            fontSize: 9,
            color: 'rgba(255,255,255,0.3)',
            flexShrink: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: '45%',
          }}
        >
          {meta}
        </span>
      )}
    </button>
  );
}

export function ModelPickerDropdown({
  groups,
  lockedGroup,
  currentId,
  emptyMessage,
  onSelect,
  onClose,
  t,
  direction = 'up',
  optionTestId = 'model-picker-option',
  lockedOptionTestId = 'model-picker-option-locked',
  unknownCurrent,
}: ModelPickerDropdownProps) {
  const [query, setQuery] = useState('');
  const searching = normalize(query).length > 0;
  const [recents, setRecents] = useState<string[]>(loadRecents);

  // Collapsed state per group id. Initially only the group holding the
  // current selection is expanded (plus 'free', always tiny) — every other
  // group renders as a header with its model count. Searching ignores
  // collapse state entirely.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const g of groups) {
      init[g.id] = !(g.id === 'free' || g.models.some((m) => m.id === currentId));
    }
    if (lockedGroup) init[lockedGroup.id] = true;
    return init;
  });

  const listRef = useRef<HTMLDivElement>(null);
  // Bring the active model into view once on mount.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-model-id="${CSS.escape(currentId)}"]`);
    if (typeof el?.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const terms = normalize(query).split(' ').filter(Boolean);
  const matches = (label: string, id: string, provider: string) => {
    const hay = normalize(`${label} ${id} ${provider}`);
    return terms.every((term) => hay.includes(term));
  };

  const filteredGroups = useMemo(
    () =>
      groups
        .map((g) => ({
          ...g,
          models: searching ? g.models.filter((m) => matches(m.label, m.id, m.provider)) : g.models,
        }))
        .filter((g) => g.models.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, query],
  );
  const filteredLocked =
    lockedGroup && searching
      ? { ...lockedGroup, models: lockedGroup.models.filter((m) => matches(m.label, m.id, m.provider)) }
      : lockedGroup;

  const toggle = (id: string) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));

  return (
    <div
      style={{
        ...PANEL_STYLE,
        ...(direction === 'up' ? { bottom: '100%', marginBottom: 6 } : { top: '100%', marginTop: 4 }),
        left: 0,
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div style={{ padding: '8px 8px 6px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <input
          autoFocus
          data-testid="model-picker-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('models.picker.search')}
          style={{
            width: '100%',
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 6,
            padding: '5px 9px',
            fontSize: 11,
            color: '#E5E7EB',
            outline: 'none',
            fontFamily: 'inherit',
            boxSizing: 'border-box',
          }}
        />
      </div>

      <div ref={listRef} style={{ maxHeight: 320, overflowY: 'auto', minHeight: 0 }}>
        {groups.length === 0 && emptyMessage && (
          <div style={{ padding: '10px 12px', fontSize: 11, color: 'rgba(255,255,255,0.5)', lineHeight: 1.5, maxWidth: 260 }}>
            {emptyMessage}
          </div>
        )}
        {searching && filteredGroups.length === 0 && groups.length > 0 && (
          <div style={{ padding: '10px 12px', fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
            {t('models.picker.noMatch', { query })}
          </div>
        )}

        {unknownCurrent && !filteredGroups.some((g) => g.models.some((m) => m.id === unknownCurrent.id)) && (
          <div data-model-id={unknownCurrent.id}>
            <ModelRow id={unknownCurrent.id} label={unknownCurrent.label || unknownCurrent.id} active testId={optionTestId} onSelect={onSelect} />
          </div>
        )}

        {(() => {
          // Recent picks — resolved against the live catalogs (a recent id
          // that no group knows anymore is dropped from display, not from
          // storage). Hidden while searching (results already narrow).
          if (searching || recents.length === 0) return null;
          const byId = new Map<string, ModelOptionGroup['models'][number]>();
          for (const g of groups) for (const m of g.models) byId.set(m.id, m);
          const rows = recents.map((id) => byId.get(id)).filter((m): m is ModelOptionGroup['models'][number] => !!m);
          if (rows.length === 0) return null;
          return (
            <div>
              <div style={{
                padding: '6px 12px 4px', fontSize: 9, fontWeight: 700,
                color: 'rgba(255,255,255,0.45)', letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}>
                {t('models.picker.recent')}
              </div>
              {rows.map((m) => (
                <div key={`recent-${m.id}`} data-model-id={m.id}>
                  <ModelRow
                    id={m.id}
                    label={m.label}
                    meta={m.provider}
                    active={m.id === currentId}
                    testId={optionTestId}
                    onSelect={(id) => { setRecents(pushRecent(id)); onSelect(id); onClose(); }}
                  />
                </div>
              ))}
            </div>
          );
        })()}

        {filteredGroups.map((group) => {
          const isCollapsed = !searching && collapsed[group.id];
          return (
            <div key={group.id}>
              <button
                type="button"
                onClick={() => toggle(group.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  width: '100%',
                  padding: '6px 12px 4px',
                  fontSize: 9,
                  fontWeight: 700,
                  color: GROUP_COLOR[group.id] ?? 'rgba(255,255,255,0.4)',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  background: 'transparent',
                  border: 'none',
                  borderTop: '1px solid rgba(255,255,255,0.05)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                <span>{group.label}</span>
                <span style={{ opacity: 0.6, fontWeight: 500, letterSpacing: 0 }}>
                  {group.models.length} {isCollapsed ? '▸' : '▾'}
                </span>
              </button>
              {!isCollapsed &&
                group.models.map((m) => (
                  <div key={m.id} data-model-id={m.id}>
                    <ModelRow
                      id={m.id}
                      label={m.label}
                      meta={m.description ?? m.provider}
                      active={m.id === currentId}
                      testId={optionTestId}
                      onSelect={(id) => { setRecents(pushRecent(id)); onSelect(id); onClose(); }}
                    />
                  </div>
                ))}
            </div>
          );
        })}

        {filteredLocked && filteredLocked.models.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => toggle(filteredLocked.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                width: '100%',
                padding: '6px 12px 4px',
                fontSize: 9,
                fontWeight: 700,
                color: 'rgba(246,169,69,0.6)',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                background: 'transparent',
                border: 'none',
                borderTop: '1px solid rgba(255,255,255,0.05)',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              <span>{filteredLocked.label} · {t('models.picker.lockedHint')}</span>
              <span style={{ opacity: 0.6 }}>
                {filteredLocked.models.length} {collapsed[filteredLocked.id] && !searching ? '▸' : '▾'}
              </span>
            </button>
            {!(collapsed[filteredLocked.id] && !searching) &&
              filteredLocked.models.map((m) => (
                <ModelRow
                  key={m.id}
                  id={m.id}
                  label={m.label}
                  meta={m.description ?? m.provider}
                  active={false}
                  locked
                  testId={lockedOptionTestId}
                />
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
