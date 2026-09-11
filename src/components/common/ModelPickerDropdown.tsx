/* ModelPickerDropdown — shared searchable model picker popover.

   Why this exists: the LazyManager header used a native <select> whose
   optgroups render fully expanded — fine at 20 models, unusable at 200+
   (the Devin ACP catalog alone is ~190 entries). A single flat list is
   equally bad. This component is the SOTA shape for a long catalog:

     - a search field (autofocused) that filters across every group by
       label / id / provider — the primary path once the list is long;
     - collapsible group sections — only the group holding the CURRENT
       selection (and the always-tiny 'free' group) starts expanded, so the
       default view is a dozen rows, not a wall;
     - ONE row per model FAMILY (modelVariants.ts): 'Claude Opus 5' is a
       single row carrying an effort chip-strip + modifier toggles
       (Fast/Priority/Thinking/1M) instead of ~10 permutation rows — same
       model, different dials, the way every other IDE renders it;
     - compact single-line rows (label + provider/id tag);
     - a locked (non-selectable) group rendered last for upsell, collapsed
       by default;
     - the active model auto-scrolls into view on open.

   Consumers own the open/close state and the outside-click dismissal
   (Composer keeps its own pattern, LazyManagerHeader uses useDismissable).
   Escape closes. */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ModelOptionGroup, Translate } from '../../lib/models/modelPickerOptions';
import {
  decomposeModelId,
  groupModelFamilies,
  memberForEffort,
  locateInFamily,
} from '../../lib/models/modelVariants';
import type { ModelFamily, ModelEffort } from '../../lib/models/modelVariants';

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

const EFFORT_SHORT: Record<ModelEffort, string> = {
  none: 'None',
  minimal: 'Min',
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
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

type ModelOption = ModelOptionGroup['models'][number];

function ModelRow({
  id,
  label,
  meta,
  active,
  locked,
  testId,
  expandable,
  expanded,
  onSelect,
  onToggleExpand,
}: {
  id: string;
  label: string;
  meta?: string;
  active: boolean;
  locked?: boolean;
  testId: string;
  /** Family row carrying variants — renders the ▸/▾ affordance. */
  expandable?: boolean;
  expanded?: boolean;
  onSelect?: (id: string) => void;
  onToggleExpand?: () => void;
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
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexShrink: 0 }}>
        {meta && (
          <span
            style={{
              fontSize: 9,
              color: 'rgba(255,255,255,0.3)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 140,
            }}
          >
            {meta}
          </span>
        )}
        {expandable && (
          <span
            role="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand?.();
            }}
            style={{ fontSize: 9, color: 'rgba(255,255,255,0.45)', cursor: 'pointer', padding: '0 2px' }}
          >
            {expanded ? '▾' : '▸'}
          </span>
        )}
      </span>
    </button>
  );
}

/** Effort chip-strip + modifier toggles, rendered as a flyout attached to
 *  the hovered family row — the Windsurf shape: hover a model, a small
 *  panel opens glued to the row carrying the reasoning-level chips and the
 *  Fast/Priority/Thinking/1M toggles. Each chip resolves to the concrete
 *  member id via memberForEffort; toggles recombine the CURRENT
 *  selection's decomposition with the flag flipped, resolved against
 *  members that actually exist. */
function FamilyVariantControls({
  family,
  currentId,
  onPick,
}: {
  family: ModelFamily<ModelOption>;
  currentId: string;
  onPick: (id: string) => void;
}) {
  const located = locateInFamily(family, currentId);
  const cur = located?.deco;
  const activeEffort = cur?.effort;
  const chip = (label: string, on: boolean, onClick: () => void, title?: string) => (
    <button
      key={label}
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{
        fontSize: 9,
        padding: '2px 7px',
        borderRadius: 99,
        border: `1px solid ${on ? 'rgba(124,92,255,0.8)' : 'rgba(255,255,255,0.14)'}`,
        background: on ? 'rgba(124,92,255,0.22)' : 'rgba(255,255,255,0.04)',
        color: on ? 'var(--color-accent-light)' : 'rgba(255,255,255,0.55)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontWeight: on ? 700 : 500,
      }}
    >
      {label}
    </button>
  );
  return (
    <div
      data-testid="family-variant-controls"
      style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}
    >
      {/* A family member carrying NO effort/modifier (swe-1-7,
          claude-opus-4-6, glm-5-2 bare) sits outside the effort ladder —
          it gets its own chip so it stays reachable. */}
      {family.members.some((m) => {
        const d = decomposeModelId(m.id);
        return d.effort === undefined && !d.fast && !d.priority && !d.thinking && !d.longCtx;
      }) &&
        chip('Std', !!cur && cur.effort === undefined && !cur.fast && !cur.priority && !cur.thinking && !cur.longCtx, () => {
          const bare = family.members.find((m) => {
            const d = decomposeModelId(m.id);
            return d.effort === undefined && !d.fast && !d.priority && !d.thinking && !d.longCtx;
          });
          if (bare) onPick(bare.id);
        })}
      {family.efforts.map((eff) =>
        chip(EFFORT_SHORT[eff], eff === activeEffort, () => {
          const id = memberForEffort(family, currentId, eff);
          if (id) onPick(id);
        }),
      )}
      {(['fast', 'priority', 'thinking', 'longCtx'] as const).map((flag) => {
        const present =
          flag === 'fast' ? family.hasFast
          : flag === 'priority' ? family.hasPriority
          : flag === 'thinking' ? family.hasThinking
          : family.hasLongCtx;
        if (!present) return null;
        const label = flag === 'longCtx' ? '1M' : flag === 'fast' ? 'Fast' : flag === 'priority' ? 'Priority' : 'Thinking';
        const on = cur ? cur[flag] : false;
        return chip(label, on, () => {
          // Toggle the flag on the current member; fall back to the
          // family's default member when the selection sits elsewhere.
          const from = cur ?? decomposeModelId(family.defaultMember.id);
          const candidate = {
            ...from,
            [flag]: !from[flag],
          } as typeof from;
          const id = family.members.find((m) => {
            const d = decomposeModelId(m.id);
            return (
              d.effort === candidate.effort &&
              d.fast === candidate.fast &&
              d.priority === candidate.priority &&
              d.thinking === candidate.thinking &&
              d.longCtx === candidate.longCtx
            );
          })?.id;
          if (id) onPick(id);
        });
      })}
    </div>
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

  // Variant flyout state: which family row is hovered/pinned, and its
  // vertical position inside the scroll list so the flyout can glue itself
  // to the row's height (Windsurf-style — hover a model, the dial panel
  // opens attached to the row instead of expanding it inline).
  const [flyout, setFlyout] = useState<{ base: string; top: number; pinned: boolean } | null>(null);
  const flyoutCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowEls = useRef(new Map<string, HTMLDivElement>());

  const openFlyout = (base: string, pinned: boolean) => {
    if (flyoutCloseTimer.current) {
      clearTimeout(flyoutCloseTimer.current);
      flyoutCloseTimer.current = null;
    }
    const row = rowEls.current.get(base);
    // Panel coordinates: the flyout is positioned on the root picker div,
    // so measure the row's rect against the panel's, not the scroll list's.
    const panel = listRef.current?.parentElement;
    const top =
      row && panel ? row.getBoundingClientRect().top - panel.getBoundingClientRect().top : 0;
    setFlyout({ base, top, pinned });
  };

  /** Schedule flyout close on hover-leave — a short delay lets the pointer
   *  travel from the row into the flyout without the panel flickering
   *  shut. Pinned flyouts (chevron click) stay until the next pick. */
  const scheduleFlyoutClose = () => {
    if (flyout?.pinned) return;
    if (flyoutCloseTimer.current) clearTimeout(flyoutCloseTimer.current);
    flyoutCloseTimer.current = setTimeout(() => setFlyout((f) => (f && !f.pinned ? null : f)), 160);
  };

  useEffect(() => () => {
    if (flyoutCloseTimer.current) clearTimeout(flyoutCloseTimer.current);
  }, []);
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

  // A family survives the search filter when ANY member matches — typing
  // "opus high" must surface the opus-5 family even though its row label
  // says only "Claude Opus 5".
  const familyMatches = (fam: ModelFamily<ModelOption>) =>
    fam.members.some((m) => matches(m.label, m.id, m.provider)) || matches(fam.label, fam.base, '');

  const filteredGroups = useMemo(
    () =>
      groups
        .map((g) => ({
          ...g,
          // Family-grouped view: one row per base model. Searching keeps a
          // family when any member matches.
          families: groupModelFamilies(g.models).filter((f) => !searching || familyMatches(f)),
          models: g.models,
        }))
        .filter((g) => g.families.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, query],
  );
  const filteredLocked =
    lockedGroup && searching
      ? { ...lockedGroup, models: lockedGroup.models.filter((m) => matches(m.label, m.id, m.provider)) }
      : lockedGroup;

  const toggle = (id: string) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));

  const pick = (id: string) => {
    setRecents(pushRecent(id));
    onSelect(id);
    onClose();
  };

  const renderFamily = (fam: ModelFamily<ModelOption>, singleProvider?: string) => {
    const activeMember = fam.members.find((m) => m.id === currentId);
    const hasVariants = fam.members.length > 1;
    // For a family with variants, meta advertises the dial range; a plain
    // single-member row keeps the member's own provider/description meta.
    const meta = hasVariants
      ? `${fam.members[0].provider ?? singleProvider ?? ''} · ${fam.members.length}`
      : fam.members[0].description ?? fam.members[0].provider;
    return (
      <div
        key={fam.base}
        data-model-id={activeMember?.id ?? fam.defaultMember.id}
        ref={(el) => {
          if (el) rowEls.current.set(fam.base, el);
          else rowEls.current.delete(fam.base);
        }}
        onMouseEnter={() => {
          if (hasVariants) openFlyout(fam.base, false);
        }}
        onMouseLeave={scheduleFlyoutClose}
      >
        <ModelRow
          id={activeMember?.id ?? fam.defaultMember.id}
          label={fam.label}
          meta={meta}
          active={!!activeMember}
          testId={optionTestId}
          expandable={hasVariants}
          expanded={flyout?.base === fam.base}
          onToggleExpand={() => openFlyout(fam.base, true)}
          onSelect={() => pick(activeMember?.id ?? fam.defaultMember.id)}
        />
      </div>
    );
  };

  // Resolve the family the flyout is anchored to (search across groups).
  const flyoutFamily = flyout
    ? groups.flatMap((g) => groupModelFamilies(g.models)).find((f) => f.base === flyout.base)
    : undefined;

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
          const byId = new Map<string, ModelOption>();
          for (const g of groups) for (const m of g.models) byId.set(m.id, m);
          const rows = recents.map((id) => byId.get(id)).filter((m): m is ModelOption => !!m);
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
                    onSelect={() => pick(m.id)}
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
                  {group.families.length} {isCollapsed ? '▸' : '▾'}
                </span>
              </button>
              {!isCollapsed && group.families.map((fam) => renderFamily(fam))}
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
              groupModelFamilies(filteredLocked.models).map((fam) => (
                <ModelRow
                  key={fam.base}
                  id={fam.defaultMember.id}
                  label={fam.label}
                  meta={fam.members[0].description ?? fam.members[0].provider}
                  active={false}
                  locked
                  testId={lockedOptionTestId}
                />
              ))}
          </div>
        )}
      </div>

      {/* Variant flyout — glued to the picker's outer edge at the hovered
          row's height. The manager-header picker sits at the right edge of
          the window, so 'down' opens the flyout to the LEFT; the composer
          picker ('up', bottom-left) opens it to the RIGHT. */}
      {flyoutFamily && flyout && (
        <div
          data-testid="family-variant-flyout"
          onMouseEnter={() => {
            if (flyoutCloseTimer.current) {
              clearTimeout(flyoutCloseTimer.current);
              flyoutCloseTimer.current = null;
            }
          }}
          onMouseLeave={scheduleFlyoutClose}
          style={{
            position: 'absolute',
            top: Math.max(4, Math.min(flyout.top - 4, 260)),
            ...(direction === 'down' ? { right: '100%', marginRight: 4 } : { left: '100%', marginLeft: 4 }),
            background: '#1C1C2A',
            border: '1px solid rgba(124,92,255,0.3)',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            padding: '8px 10px',
            minWidth: 150,
            maxWidth: 210,
            zIndex: 101,
          }}
        >
          <div
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: 'rgba(255,255,255,0.5)',
              letterSpacing: '0.06em',
              marginBottom: 6,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {flyoutFamily.label}
          </div>
          <FamilyVariantControls family={flyoutFamily} currentId={currentId} onPick={pick} />
        </div>
      )}
    </div>
  );
}
