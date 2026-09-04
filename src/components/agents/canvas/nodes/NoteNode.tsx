/* NoteNode.tsx — text-only sticky note (spec §5 "Annotations", n8n
   parity). Plain text by default; double-click swaps to a textarea, Enter
   or blur commits via CanvasActionsContext.onUpdateNote, Escape reverts
   without saving. A remove button (×) always visible on hover-ish (kept
   simple: always visible, small) calls onRemoveNote.

   W-CARDS (founder, 2026-07-21) — the old three-level semantic zoom (dot
   glyph / read-only single-line-preview compact / full editable) is
   retired: this card renders its ONE full, always-editable layout at every
   zoom, scaled naturally by React Flow's own viewport transform, same
   convention as MissionNode.tsx.
*/

import { memo, useRef, useState, type KeyboardEvent } from 'react';
import { type Node, type NodeProps } from '@xyflow/react';
import type { NoteData } from '../canvasTypes';
import { useI18n } from '../../../../i18n';
import { useCanvasActions } from '../chrome/CanvasActionsContext';
import type { CanvasZoomLevel } from '../chrome/useZoomLevel';
import { typeAccentColor } from '../chrome/nodeChrome';
import { renderNoteMarkdown } from './noteMarkdown';

// See MissionNode.tsx's MissionFlowNode doc comment for why the
// `& Record<string, unknown>` intersection is needed here.
export type NoteFlowNode = Node<NoteData & Record<string, unknown>, 'note'>;

// R2b visual overhaul — notes now use the shared type-accent palette
// (chrome/nodeChrome.tsx's TYPE_ACCENT_COLORS.note) instead of a locally
// hardcoded amber, so a note's own accent is mutually distinct from
// router's (both used to sit close together on the amber/yellow hue).
const NOTE_COLOR = typeAccentColor('note');

interface NoteNodeCardProps {
  data: NoteData;
  /** W-CARDS — accepted for call-site compatibility (every existing test/
   *  caller) but no longer read: the card always renders its one full,
   *  editable layout regardless of zoom (see this file's own header). */
  zoomLevel?: CanvasZoomLevel;
  selected?: boolean;
}

export function NoteNodeCard({ data, selected }: NoteNodeCardProps) {
  const { t } = useI18n();
  const actions = useCanvasActions();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function commit() {
    setEditing(false);
    if (draft !== data.text) actions.onUpdateNote(data.id, draft);
  }

  function cancel() {
    setDraft(data.text);
    setEditing(false);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commit();
    }
  }

  return (
    <div
      data-testid={`note-node-${data.id}`}
      onDoubleClick={() => {
        setDraft(data.text);
        setEditing(true);
        requestAnimationFrame(() => textareaRef.current?.focus());
      }}
      title={editing ? undefined : data.text || t('canvas.node.noteEmpty')}
      style={{
        background: `color-mix(in srgb, ${NOTE_COLOR} 12%, transparent)`,
        border: `1px solid ${selected ? 'var(--color-accent)' : `color-mix(in srgb, ${NOTE_COLOR} 35%, transparent)`}`,
        borderRadius: 8,
        padding: 8,
        width: 160,
        minHeight: 90,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        boxShadow: '2px 2px 0 rgba(0,0,0,0.25)',
      }}
    >
      <button
        type="button"
        data-testid={`note-node-remove-${data.id}`}
        className="nodrag"
        onClick={(e) => {
          e.stopPropagation();
          actions.onRemoveNote(data.id);
        }}
        aria-label="Supprimer la note"
        style={{
          alignSelf: 'flex-end',
          width: 16,
          height: 16,
          lineHeight: '14px',
          borderRadius: 4,
          border: 'none',
          background: 'transparent',
          color: 'var(--color-text-disabled)',
          cursor: 'pointer',
          fontSize: 12,
        }}
      >
        ×
      </button>
      {editing ? (
        <textarea
          ref={textareaRef}
          data-testid={`note-node-textarea-${data.id}`}
          className="nodrag"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          style={{
            flex: 1,
            resize: 'none',
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: 'var(--color-text)',
            fontFamily: 'var(--font-ui)',
            fontSize: 11.5,
          }}
        />
      ) : (
        // W-BYO nit (a), n8n parity — basic Markdown (bold/italic/lists/
        // links) rendered via the tiny hand-rolled renderer in
        // noteMarkdown.tsx (see that module's header for scope/rationale).
        // Kept as a `<div>` (not `<p>`, which cannot legally contain the
        // `<ul>` a bullet list produces) with the same pre-wrap/overflow
        // styling the previous plain-text `<p>` used.
        <div
          data-testid={`note-node-text-${data.id}`}
          style={{ margin: 0, flex: 1, fontSize: 11.5, color: 'var(--color-text)', whiteSpace: 'pre-wrap', overflow: 'hidden' }}
        >
          {renderNoteMarkdown(data.text)}
        </div>
      )}
    </div>
  );
}

export const NoteNode = memo(function NoteNode({ data, selected }: NodeProps<NoteFlowNode>) {
  return <NoteNodeCard data={data} selected={selected} />;
});
