/* WikiTree — left sidebar for the Brain Wiki view.

   Renders the project→module→topic hierarchy from platform.brain.tree()
   (/_api/tree) as a collapsible, clickable, Wikipedia-style outline. A "home"
   row at the top returns to the brain-index overview page; a "back" row
   above it (shown only once there is history) returns to the previous page.
   Selecting a node asks the parent (WikiTab) to open its page in the right
   pane. */

import { useState, type CSSProperties } from 'react';
import { useI18n } from '../../i18n';
import type { BrainTree, BrainTreeNode } from '../../lib/platform/types';
import { formatNeuronTitle } from '../../lib/brain/neuronTitle';
import { KindPill } from './NoteMeta';

interface WikiTreeProps {
  tree: BrainTree;
  activeId: string | null;
  onSelect: (node: BrainTreeNode) => void;
  onHome: () => void;
  homeActive: boolean;
  /** True once the Wiki has a back-navigation history to return to. */
  canGoBack: boolean;
  onBack: () => void;
}

const ROW_BASE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: '4px 8px',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 12,
  fontFamily: 'inherit',
  border: 'none',
  width: '100%',
  textAlign: 'left',
  background: 'transparent',
};

function rowColor(active: boolean): string {
  return active ? '#C4B5FD' : 'rgba(255,255,255,0.72)';
}

function HomeRow({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...ROW_BASE,
        marginBottom: 4,
        fontWeight: 600,
        color: rowColor(active),
        background: active ? 'rgba(124,92,255,0.18)' : 'transparent',
      }}
    >
      <span aria-hidden style={{ width: 14, flexShrink: 0, textAlign: 'center' }}>📖</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </button>
  );
}

function BackRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...ROW_BASE,
        marginBottom: 4,
        color: 'rgba(255,255,255,0.55)',
      }}
    >
      <span aria-hidden style={{ width: 14, flexShrink: 0, textAlign: 'center' }}>
        ←
      </span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </button>
  );
}

function treeKind(type: string | null): string | null {
  if (!type || type === 'project' || type === 'aggregate-neuron') return null;
  return type.replace(/-neuron$/, '');
}

function TreeRow({
  node,
  depth,
  activeId,
  onSelect,
}: {
  node: BrainTreeNode;
  depth: number;
  activeId: string | null;
  onSelect: (n: BrainTreeNode) => void;
}) {
  const [open, setOpen] = useState(depth === 0);
  const hasChildren = node.children.length > 0;
  const active = activeId === node.id || activeId === node.noteId;
  // A tree node's label can be a neuron title derived from a mission prompt —
  // sanitize markup/mid-tag truncation the same way every other neuron-title
  // render site does (see lib/brain/neuronTitle.ts).
  const label = formatNeuronTitle(node.label, 60);
  const kind = treeKind(node.type);

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => onSelect(node)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect(node);
          }
        }}
        title={label}
        style={{
          ...ROW_BASE,
          paddingLeft: 8 + depth * 12,
          fontWeight: depth === 0 ? 600 : 400,
          color: rowColor(active),
          background: active ? 'rgba(124,92,255,0.18)' : 'transparent',
        }}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={open ? 'collapse' : 'expand'}
            onClick={(e) => {
              e.stopPropagation();
              setOpen((o) => !o);
            }}
            style={{
              width: 14,
              flexShrink: 0,
              border: 'none',
              background: 'transparent',
              color: 'rgba(255,255,255,0.4)',
              cursor: 'pointer',
              fontSize: 9,
              padding: 0,
              fontFamily: 'inherit',
            }}
          >
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span style={{ width: 14, flexShrink: 0 }} />
        )}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
          {label}
        </span>
        {kind && <KindPill kind={kind} />}
      </div>
      {open &&
        node.children.map((child) => (
          <TreeRow
            key={child.id}
            node={child}
            depth={depth + 1}
            activeId={activeId}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}

export function WikiTree({ tree, activeId, onSelect, onHome, homeActive, canGoBack, onBack }: WikiTreeProps) {
  const { t } = useI18n();
  return (
    <div
      style={{
        width: 240,
        flexShrink: 0,
        borderRight: '1px solid rgba(255,255,255,0.06)',
        overflowY: 'auto',
        background: '#0E0E12',
        padding: '10px 6px',
      }}
    >
      <div
        style={{
          fontSize: 9,
          fontWeight: 700,
          color: 'rgba(255,255,255,0.3)',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          padding: '4px 8px 8px',
        }}
      >
        {t('brain.wikiContents')}
      </div>
      {canGoBack && <BackRow label={t('brain.wikiBack')} onClick={onBack} />}
      <HomeRow label={t('brain.wikiHome')} active={homeActive} onClick={onHome} />
      {tree.projects.map((project) => (
        <TreeRow
          key={project.id}
          node={project}
          depth={0}
          activeId={activeId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
