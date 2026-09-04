/* SearchNode.tsx — P-SEARCH: the visible web-search results surface
   (founder directive, verbatim: "la recherche web doit ouvrir une fenêtre
   liée à l'agent qui demande la recherche et on voit la recherche").

   WIRING (see canvasTypes.ts's SurfaceSpec.searchSurface doc comment for
   the full rationale): a search surface piggy-backs on the EXISTING
   'preview' zone-child slot (SurfaceSpec.kind stays 'preview') rather than
   a dedicated SurfaceKind/CanvasNodeKind value — reconcilerZones.ts's
   DEFAULT_NODE_SIZE/ChildKind are exhaustively keyed over CanvasNodeKind
   and that file is frozen this wave (concurrent title-band fix). Reusing
   'preview' buys, with ZERO changes to the frozen reconciler files: grid
   placement next to the owning mission, collision avoidance,
   collapse-hiding, persisted position/size, and the dotted `ownerRef`
   surface-edge (reconcilerEdges.ts's `buildSurfaceEdges`, kind-agnostic).
   `PreviewSlotNode` below is the ONE place that decides, per node
   instance, whether a 'preview'-typed node renders as this component or as
   PreviewNode.tsx — the discriminator is `data.searchSurface`'s presence.
   Registered in nodes/index.ts's `preview` node-type-map entry.

   DATA FLOW: toolRuntime.ts's `web_search` case emits 'canvas:webSearchResult'
   (lib/bus.ts) whenever the call carries mission identity ->
   useCanvasWebSearchSurfaces.ts forwards it to canvasStore's
   `reportWebSearch` -> this component just renders whatever
   SurfaceSpec.searchSurface currently holds. No polling, no local
   fetch/probe logic (unlike PreviewNode.tsx's reachability probe) — a
   search surface is a passive projection of already-fetched results.

   WYSIWYG, no zoom-adaptive layout (founder standing rule, W-CARDS —
   restated for this node explicitly in the task brief): full chrome + full
   history at every zoom, fixed flow footprint, only an internal scroll for
   overflow history. Deliberately simpler than PreviewNode.tsx (no
   chip/compact tier, no live-iframe attendance machinery — there is no
   iframe here at all).
*/

import { memo } from 'react';
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react';
import type { SearchHistoryEntry, SurfaceSpec } from '../canvasTypes';
import { useI18n } from '../../../../i18n';
import { useCanvasStore } from '../canvasStore';
import { PREVIEW_NODE_SIZE } from '../reconcilerZones';
import { openExternal } from '../../../../lib/platform/openExternal';
import { PreviewNode, type PreviewFlowNode } from './PreviewNode';

/** Same underlying React Flow node shape as PreviewNode.tsx's own
 *  `PreviewFlowNode` (both render a 'preview'-typed node) — aliased under
 *  this name purely for readability at SearchNode's own call sites/tests. */
export type SearchFlowNode = PreviewFlowNode;

const MIN_WIDTH = 320;
const MIN_HEIGHT = 260;

function SearchGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#F0A050" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  );
}

interface SearchResultRowProps {
  result: { title: string; url: string; snippet: string };
  index: number;
  surfaceId: string;
}

function SearchResultRow({ result, index, surfaceId }: SearchResultRowProps) {
  return (
    <button
      type="button"
      data-testid={`search-node-result-${surfaceId}-${index}`}
      title={result.url}
      onClick={(e) => {
        e.stopPropagation();
        openExternal(result.url).catch(() => {
          // Best-effort, same posture as PreviewNode.tsx's own
          // open-in-browser button — no dedicated error UI for this.
        });
      }}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        padding: '4px 6px',
        borderRadius: 5,
        marginBottom: 2,
      }}
    >
      <div
        style={{
          fontSize: 11.5,
          color: 'var(--color-accent)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {result.title || result.url}
      </div>
      {result.snippet && (
        <div
          style={{
            fontSize: 10.5,
            color: 'var(--color-text-secondary)',
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical' as const,
          }}
        >
          {result.snippet}
        </div>
      )}
    </button>
  );
}

interface SearchHistoryBlockProps {
  entry: SearchHistoryEntry;
  isLatest: boolean;
  surfaceId: string;
  index: number;
  noResultsLabel: string;
}

function SearchHistoryBlock({ entry, isLatest, surfaceId, index, noResultsLabel }: SearchHistoryBlockProps) {
  return (
    <div
      data-testid={`search-node-history-${surfaceId}-${index}`}
      style={{
        marginBottom: 10,
        paddingBottom: 8,
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <div
        title={entry.query}
        style={{
          fontSize: 11.5,
          fontWeight: 600,
          color: isLatest ? 'var(--color-text)' : 'var(--color-text-secondary)',
          marginBottom: 4,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        &ldquo;{entry.query}&rdquo;
      </div>
      {entry.results.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>{noResultsLabel}</div>
      ) : (
        entry.results.map((r, i) => <SearchResultRow key={`${r.url}-${i}`} result={r} index={i} surfaceId={surfaceId} />)
      )}
    </div>
  );
}

interface SearchNodeCardProps {
  data: SurfaceSpec;
  selected?: boolean;
}

export function SearchNodeCard({ data, selected }: SearchNodeCardProps) {
  const { t } = useI18n();
  const removeSurface = useCanvasStore((s) => s.removeSurface);
  const updateSurface = useCanvasStore((s) => s.updateSurface);
  const width = data.width ?? PREVIEW_NODE_SIZE.width;
  const height = data.height ?? PREVIEW_NODE_SIZE.height;

  const search = data.searchSurface;
  const history = search?.history ?? [];
  const pendingQuery = search?.pendingQuery;
  const agentName = search?.agentName;

  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={MIN_WIDTH}
        minHeight={MIN_HEIGHT}
        onResizeEnd={(_event, params) => updateSurface(data.id, { width: params.width, height: params.height })}
      />
      <div
        data-testid={`search-node-${data.id}`}
        style={{
          width,
          height,
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 10,
          overflow: 'hidden',
          background: 'var(--color-panel)',
          border: selected ? '2px solid var(--color-accent)' : '1px solid var(--color-border)',
          boxShadow: '2px 2px 0 rgba(0,0,0,0.35)',
        }}
      >
        <div
          className="nodrag"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 8px',
            background: 'var(--color-panel-2)',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
            flexShrink: 0,
          }}
        >
          <SearchGlyph />
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text)', flexShrink: 0 }}>
            {t('canvas.search.title')}
          </span>
          {agentName && (
            <span
              data-testid={`search-node-agent-${data.id}`}
              title={agentName}
              style={{
                fontSize: 10.5,
                color: 'var(--color-text-secondary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
                minWidth: 0,
              }}
            >
              {agentName}
            </span>
          )}
          <button
            type="button"
            data-testid={`search-node-close-${data.id}`}
            aria-label={t('canvas.search.close')}
            title={t('canvas.search.close')}
            onClick={(e) => {
              e.stopPropagation();
              removeSurface(data.id);
            }}
            style={{
              width: 18,
              height: 18,
              lineHeight: '16px',
              borderRadius: 4,
              border: 'none',
              background: 'transparent',
              color: 'var(--color-text-disabled)',
              cursor: 'pointer',
              fontSize: 12,
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>

        {pendingQuery && (
          <div
            data-testid={`search-node-pending-${data.id}`}
            style={{
              padding: '6px 10px',
              fontSize: 11.5,
              color: 'var(--color-accent)',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {t('canvas.search.searching', { query: pendingQuery })}
          </div>
        )}

        <div className="nodrag" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 8px' }}>
          {history.length === 0 && !pendingQuery && (
            <div
              data-testid={`search-node-empty-${data.id}`}
              style={{ fontSize: 11.5, color: 'var(--color-text-secondary)', padding: '12px 4px', textAlign: 'center' }}
            >
              {t('canvas.search.empty')}
            </div>
          )}
          {history.map((entry, idx) => (
            <SearchHistoryBlock
              key={`${entry.atMs}-${idx}`}
              entry={entry}
              isLatest={idx === 0}
              surfaceId={data.id}
              index={idx}
              noResultsLabel={t('canvas.search.noResults')}
            />
          ))}
        </div>
      </div>
    </>
  );
}

/**
 * P2-15 fix — see PreviewNode.tsx's identical constant/doc comment for the
 * full "React Flow error 008" root cause. A search surface also carries
 * `ownerRef` (always the requesting mission, see SurfaceSpec.searchSurface's
 * own doc comment) and `PreviewSlotNode` renders THIS component instead of
 * PreviewNode.tsx for it, so it needs its own target Handle rather than
 * inheriting PreviewNode's.
 */
const SURFACE_TARGET_HANDLE_STYLE = { opacity: 0, pointerEvents: 'none' as const };

export const SearchNode = memo(function SearchNode({ data, selected }: NodeProps<SearchFlowNode>) {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} style={SURFACE_TARGET_HANDLE_STYLE} />
      <SearchNodeCard data={data} selected={selected} />
    </>
  );
});

/**
 * Dispatch wrapper registered under nodeTypes.preview (nodes/index.ts) in
 * place of a bare `PreviewNode` reference — see this module's own header
 * and SurfaceSpec.searchSurface's doc comment for the full rationale. A
 * 'preview'-typed node WITHOUT `data.searchSurface` renders EXACTLY as
 * before (PreviewNode, zero behavior change for every real preview); one
 * WITH it renders as SearchNode instead.
 */
export const PreviewSlotNode = memo(function PreviewSlotNode(props: NodeProps<PreviewFlowNode>) {
  if (props.data.searchSurface) {
    return <SearchNode {...props} />;
  }
  return <PreviewNode {...props} />;
});
