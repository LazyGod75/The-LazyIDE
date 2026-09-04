/* BrainControls — left panel: search, type/cluster filters, palette
   selector, 3D/2D toggle, zoom, legend.
   Search is wired to platform.brain.search() (debounced 300ms).
   Cluster list is derived from real graph data (prop), not hardcoded.
   Palette/3D-2D/zoom are controlled by the parent (BrainSpace) so the same
   values also drive BrainGraph3D's rendering. Time-travel now lives in its
   own dedicated overlay — see TimelineScrubber.tsx, mounted by BrainSpace
   directly over the graph canvas — rather than this filters/settings panel.
*/

import { useState, useEffect, useRef, useCallback } from 'react';
import { getPlatform } from '../../lib/platform';
import { useI18n } from '../../i18n';
import type { BrainSearchResult } from '../../lib/platform/types';
import type { NodeType } from '../../lib/mock/brain';
import { clusterDisplayLabel, resolveClusterColors, type PaletteId } from '../../lib/brain/brainAdapter';
import { formatNeuronTitle } from '../../lib/brain/neuronTitle';
import { PALETTES, PALETTE_IDS } from './canvas/palettes';
import { ZOOM_MAX, ZOOM_MIN } from './canvas/projection';

const TYPES: { label: string; value: NodeType }[] = [
  { label: 'Decisions', value: 'decision' },
  { label: 'Bugs',      value: 'bug' },
  { label: 'Files',     value: 'file' },
  { label: 'Concepts',  value: 'concept' },
  { label: 'Modules',   value: 'module' },
];

const ZOOM_STEP_FACTOR = 1.25;

// ── Sub-components ───────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 9,
        fontWeight: 700,
        color: 'rgba(255,255,255,0.3)',
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        marginBottom: 7,
      }}
    >
      {children}
    </div>
  );
}

// ── BrainControls ────────────────────────────────────────────────

export interface BrainControlsProps {
  /** List of cluster ids present in the loaded graph. */
  clusters: string[];
  /** Called when the filter state changes; parent wires filtered nodes to BrainGraph3D. */
  onFilterChange: (activeTypes: Set<NodeType>, activeClusters: Set<string>) => void;
  /** Called when the user selects a search result (node id). */
  onSearchSelect: (nodeId: string) => void;
  /** Active color palette — shared with BrainGraph3D so the canvas and this panel always agree. */
  paletteId: PaletteId;
  onPaletteChange: (paletteId: PaletteId) => void;
  /** 3D orbit projection vs flattened 2D. */
  is3D: boolean;
  onIs3DChange: (is3D: boolean) => void;
  /** Zoom factor, clamped to [ZOOM_MIN, ZOOM_MAX]. */
  zoom: number;
  onZoomChange: (zoom: number) => void;
}

export function BrainControls({
  clusters,
  onFilterChange,
  onSearchSelect,
  paletteId,
  onPaletteChange,
  is3D,
  onIs3DChange,
  zoom,
  onZoomChange,
}: BrainControlsProps) {
  const platform = getPlatform();
  const { t } = useI18n();

  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<BrainSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // B3.1: guards against the classic "slowest response wins" race — a
  // request for an EARLIER query can resolve after a request for a LATER
  // query and overwrite it with stale results. Same discard-stale-work
  // principle as ContextPicker.tsx's `cancelled` flag, adapted to a
  // monotonic token because runSearch is invoked directly from a
  // setTimeout ref rather than from an effect with its own cleanup.
  const searchTokenRef = useRef(0);

  const [activeTypes, setActiveTypes] = useState<Set<NodeType>>(
    new Set<NodeType>(['decision', 'bug', 'file', 'concept', 'module']),
  );
  const [activeClusters, setActiveClusters] = useState<Set<string>>(
    new Set(clusters),
  );

  // Sync activeClusters when the cluster list changes (graph reload).
  useEffect(() => {
    setActiveClusters(new Set(clusters)); // eslint-disable-line react-hooks/set-state-in-effect
  }, [clusters.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // Notify parent whenever filters change
  useEffect(() => {
    onFilterChange(activeTypes, activeClusters);
  }, [activeTypes, activeClusters, onFilterChange]);

  // Debounced search — token-guarded so a slow response for a superseded
  // query can never overwrite the results of a more recent one (B3.1).
  const runSearch = useCallback(async (q: string) => {
    const token = ++searchTokenRef.current;
    if (!q.trim()) {
      setSearchResults([]);
      return;
    }
    setSearchLoading(true);
    try {
      const results = await platform.brain.search(q.trim(), 8);
      if (token !== searchTokenRef.current) return; // superseded by a newer search
      setSearchResults(results);
    } catch {
      if (token === searchTokenRef.current) setSearchResults([]);
    } finally {
      if (token === searchTokenRef.current) setSearchLoading(false);
    }
  }, [platform]);

  const handleQueryChange = (value: string) => {
    setQuery(value);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => runSearch(value), 300);
  };

  const toggleType = (t: NodeType) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  const toggleCluster = (c: string) => {
    setActiveClusters((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  };

  const handleSearchSelect = (result: BrainSearchResult) => {
    setQuery(result.title);
    setSearchResults([]);
    onSearchSelect(result.id);
  };

  const displayClusters = clusters.length > 0 ? clusters : ['unknown'];
  // Single source of truth for cluster -> color across the whole Brain UI
  // (canvas nodes/links, filter chips, legend) — palette-aware.
  const clusterColors = resolveClusterColors(paletteId, displayClusters);

  return (
    <div
      style={{
        width: 230,
        minWidth: 0,
        flexShrink: 0,
        borderRight: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        padding: '16px 14px',
        gap: 20,
        background: '#0E0E12',
      }}
    >
      {/* Search */}
      <div>
        <div
          style={{
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 7,
            height: 32,
            display: 'flex',
            alignItems: 'center',
            padding: '0 10px',
            gap: 7,
          }}
        >
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.25)' }}>
            {searchLoading ? '...' : '⌕'}
          </span>
          <input
            type="text"
            value={query}
            placeholder={t('brain.searchPlaceholder')}
            onChange={(e) => handleQueryChange(e.target.value)}
            style={{
              background: 'none',
              border: 'none',
              outline: 'none',
              color: '#E8E3FF',
              fontSize: 11,
              width: '100%',
              fontFamily: 'inherit',
            }}
          />
          {query && (
            <button
              onClick={() => { setQuery(''); setSearchResults([]); }}
              style={{
                background: 'none',
                border: 'none',
                color: 'rgba(255,255,255,0.3)',
                cursor: 'pointer',
                fontSize: 12,
                padding: 0,
                lineHeight: 1,
              }}
            >
              x
            </button>
          )}
        </div>

        {/* Search results dropdown */}
        {searchResults.length > 0 && (
          <div
            style={{
              marginTop: 4,
              background: '#18181E',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 7,
              overflow: 'hidden',
            }}
          >
            {searchResults.map((r) => (
              <button
                key={r.id}
                onClick={() => handleSearchSelect(r)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '7px 10px',
                  background: 'none',
                  border: 'none',
                  borderBottom: '1px solid rgba(255,255,255,0.05)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.06)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'none';
                }}
              >
                <div style={{ fontSize: 11, color: '#E8E3FF', fontWeight: 600 }}>{formatNeuronTitle(r.title, 80)}</div>
                {r.snippet && (
                  <div
                    style={{
                      fontSize: 10,
                      color: 'rgba(255,255,255,0.4)',
                      marginTop: 2,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {r.snippet}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}

        {query && !searchLoading && searchResults.length === 0 && (
          <div
            style={{
              marginTop: 4,
              padding: '6px 10px',
              fontSize: 10,
              color: 'rgba(255,255,255,0.3)',
            }}
          >
            {t('brain.noResults', { query })}
          </div>
        )}
      </div>

      {/* Type filters */}
      <div>
        <SectionTitle>Filters — type</SectionTitle>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {TYPES.map(({ label, value }) => {
            const active = activeTypes.has(value);
            return (
              <button
                key={value}
                onClick={() => toggleType(value)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  borderRadius: 5,
                  padding: '3px 9px',
                  fontSize: 10,
                  fontWeight: 600,
                  cursor: 'pointer',
                  border: `1px solid ${active ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.07)'}`,
                  background: active ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.04)',
                  color: active ? '#E8E3FF' : 'rgba(255,255,255,0.45)',
                  transition: 'all 0.15s',
                  fontFamily: 'inherit',
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Cluster filters — built from real graph data */}
      <div>
        <SectionTitle>Filters — cluster</SectionTitle>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {displayClusters.map((c) => {
            const active = activeClusters.has(c);
            const color = clusterColors[c] ?? '#888888';
            const displayLabel = clusterDisplayLabel(c);
            return (
              <button
                key={c}
                onClick={() => toggleCluster(c)}
                title={displayLabel !== c ? c : undefined}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  borderRadius: 5,
                  padding: '4px 9px',
                  fontSize: 10,
                  fontWeight: 600,
                  cursor: 'pointer',
                  opacity: active ? 1 : 0.38,
                  border: `1px solid ${color}33`,
                  background: `${color}14`,
                  color: color,
                  transition: 'all 0.15s',
                  fontFamily: 'inherit',
                  textAlign: 'left',
                  maxWidth: 190,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: color,
                    flexShrink: 0,
                    display: 'inline-block',
                  }}
                />
                {displayLabel}
              </button>
            );
          })}
        </div>
      </div>

      {/* Palette selector */}
      <div>
        <SectionTitle>{t('brain.palette')}</SectionTitle>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {PALETTE_IDS.map((id) => {
            const active = paletteId === id;
            return (
              <button
                key={id}
                onClick={() => onPaletteChange(id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  borderRadius: 6,
                  padding: '6px 9px',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer',
                  textAlign: 'left',
                  border: `1px solid ${active ? 'rgba(124,92,255,0.5)' : 'rgba(255,255,255,0.08)'}`,
                  background: active ? 'rgba(124,92,255,0.12)' : 'rgba(255,255,255,0.03)',
                  color: active ? '#E8E3FF' : 'rgba(255,255,255,0.55)',
                  transition: 'all 0.15s',
                  fontFamily: 'inherit',
                }}
              >
                <span style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                  {PALETTES[id].colors.map((swatch) => (
                    <span
                      key={swatch}
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: swatch,
                        boxShadow: `0 0 4px ${swatch}`,
                      }}
                    />
                  ))}
                </span>
                {t(`brain.palette.${id}`)}
              </button>
            );
          })}
        </div>
      </div>

      {/* 3D/2D toggle */}
      <div>
        <SectionTitle>{t('brain.view')}</SectionTitle>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 11,
            color: 'rgba(255,255,255,0.55)',
          }}
        >
          <span style={{ fontWeight: 500, minWidth: 20, color: is3D ? '#C7B6FF' : 'rgba(255,255,255,0.35)' }}>
            {t('brain.view3d')}
          </span>
          <label
            style={{ position: 'relative', width: 36, height: 20, cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              checked={!is3D}
              onChange={(e) => onIs3DChange(!e.target.checked)}
              style={{ opacity: 0, width: 0, height: 0 }}
            />
            <div
              style={{
                position: 'absolute',
                inset: 0,
                background: 'rgba(124,92,255,0.3)',
                borderRadius: 10,
                border: '1px solid rgba(124,92,255,0.4)',
              }}
            />
            <div
              style={{
                position: 'absolute',
                top: 2,
                left: is3D ? 2 : 18,
                width: 14,
                height: 14,
                background: '#7C5CFF',
                borderRadius: '50%',
                transition: 'left 0.2s',
                boxShadow: '0 0 4px rgba(124,92,255,0.5)',
              }}
            />
          </label>
          <span style={{ color: is3D ? 'rgba(255,255,255,0.35)' : '#C7B6FF' }}>{t('brain.view2d')}</span>
        </div>
      </div>

      {/* Zoom */}
      <div>
        <SectionTitle>{t('brain.zoom')}</SectionTitle>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => onZoomChange(Math.max(ZOOM_MIN, zoom / ZOOM_STEP_FACTOR))}
            title={t('brain.zoomOut')}
            aria-label={t('brain.zoomOut')}
            style={{
              width: 26,
              height: 26,
              borderRadius: 7,
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(255,255,255,0.04)',
              color: '#E8E3FF',
              fontSize: 15,
              lineHeight: 1,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            −
          </button>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#C7B6FF', minWidth: 40, textAlign: 'center' }}>
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={() => onZoomChange(Math.min(ZOOM_MAX, zoom * ZOOM_STEP_FACTOR))}
            title={t('brain.zoomIn')}
            aria-label={t('brain.zoomIn')}
            style={{
              width: 26,
              height: 26,
              borderRadius: 7,
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(255,255,255,0.04)',
              color: '#E8E3FF',
              fontSize: 15,
              lineHeight: 1,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            +
          </button>
        </div>
      </div>

      {/* Legend — built from real clusters */}
      <div>
        <SectionTitle>Legend</SectionTitle>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {displayClusters.map((c) => {
            const color = clusterColors[c] ?? '#888888';
            const isTopical = c === 'topical';
            const displayLabel = clusterDisplayLabel(c);
            return (
              <div
                key={c}
                title={displayLabel !== c ? c : undefined}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 11,
                  color: 'rgba(255,255,255,0.6)',
                }}
              >
                <div
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: isTopical ? 3 : '50%',
                    background: color,
                    flexShrink: 0,
                    boxShadow: `0 0 6px ${color}bb`,
                  }}
                />
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {displayLabel}
                </span>
                {isTopical && (
                  <span
                    style={{
                      fontSize: 8,
                      color: '#F472B6',
                      background: 'rgba(244,114,182,0.12)',
                      border: '1px solid rgba(244,114,182,0.25)',
                      borderRadius: 3,
                      padding: '1px 4px',
                      fontWeight: 700,
                      letterSpacing: '0.04em',
                    }}
                  >
                    TOPICAL
                  </span>
                )}
              </div>
            );
          })}
          <div
            style={{
              marginTop: 4,
              paddingTop: 8,
              borderTop: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', marginBottom: 5 }}>
              Size = importance
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {[6, 10, 14].map((s) => (
                <div
                  key={s}
                  style={{
                    width: s,
                    height: s,
                    borderRadius: '50%',
                    background: `rgba(51,225,255,${0.3 + s * 0.025})`,
                  }}
                />
              ))}
              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', marginLeft: 2 }}>
                1 - 10
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
