/* CanvasQuickCreateModal.tsx — minimal draft create/edit modal (spec §5
   "double-click empty zone area opens quick-create (title + task ->
   Draft)"; task deliverable #8 also backs the DraftNode "Modifier"
   affordance — previously a bare "à venir" toast, see DraftNode.tsx's own
   doc comment and CanvasView.tsx's handleEditDraft).

   Deliberately NOT NewMissionModal: no provider entitlement resolution, no
   scope picker, no orchestrator toggle, no quote/estimate panel — a title
   input, a task textarea, and a model select sourced from the same native
   model catalog NewMissionModal itself falls back to for the CLI/BYOK path
   (`ALL_MODELS`/`DEFAULT_MODEL`, lib/models/registry.ts). A DraftSpec is
   inert until launched, so the full entitlement-aware picker NewMissionModal
   needs at LAUNCH time has nothing to resolve yet here.
*/

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { useI18n } from '../../../i18n';
import { ALL_MODELS, DEFAULT_MODEL } from '../../../lib/models/registry';
import { CanvasDraftVersionsPanel } from './CanvasDraftVersionsPanel';
import type { DraftVersion } from './canvasTypes';

export interface QuickCreateValue {
  title: string;
  task: string;
  model: string;
}

interface CanvasQuickCreateModalProps {
  mode: 'create' | 'edit';
  initial?: Partial<QuickCreateValue>;
  onSubmit: (value: QuickCreateValue) => void;
  onCancel: () => void;
  /** Draft version history (Activepieces parity, additive) — only
   *  meaningful in 'edit' mode; absent (create mode, or an edit-mode caller
   *  that hasn't wired history yet) simply skips rendering the « Versions »
   *  dropdown, same "prop absent -> feature not offered" convention as
   *  CanvasPalette's optional onAddRouter/onAddTerminal props. */
  versions?: DraftVersion[];
  /** Restores an old snapshot's fields (title/task/model) back onto the
   *  live draft — the caller wires this to canvasStore's
   *  `restoreDraftVersion`, which itself appends a FRESH version rather
   *  than rewriting history. Closes this modal immediately after (the
   *  draft has already changed underneath the form's own local state,
   *  which was only ever a snapshot taken at mount). */
  onRestoreVersion?: (ts: number) => void;
}

const OVERLAY_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};

const FIELD_STYLE: CSSProperties = {
  width: '100%',
  fontSize: 12.5,
  padding: '7px 9px',
  borderRadius: 7,
  border: '1px solid var(--color-border-3)',
  background: 'var(--color-panel-3)',
  color: 'var(--color-text)',
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

const LABEL_STYLE: CSSProperties = { fontSize: 11, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 4, display: 'block' };

export function CanvasQuickCreateModal({ mode, initial, onSubmit, onCancel, versions, onRestoreVersion }: CanvasQuickCreateModalProps) {
  const { t } = useI18n();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [task, setTask] = useState(initial?.task ?? '');
  const [model, setModel] = useState(initial?.model ?? DEFAULT_MODEL.id);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const titleFieldId = useId();
  const taskFieldId = useId();
  const modelFieldId = useId();

  useEffect(() => {
    titleInputRef.current?.focus();
  }, []);

  // The initial model may be a value NewMissionModal never produces (e.g.
  // a palette agent's raw modelTier like "sonnet", or the plain
  // DEFAULT_DRAFT_MODEL_LABEL fallback CanvasView.tsx already uses) —
  // surfaced as an extra option instead of silently overwritten by the
  // first catalog entry, so editing a draft never mutates a field the user
  // didn't touch.
  const knownModel = ALL_MODELS.some((m) => m.id === model);

  function handleSubmit(): void {
    if (title.trim().length === 0) return;
    onSubmit({ title: title.trim(), task, model });
  }

  return (
    <div
      data-testid="canvas-quickcreate-overlay"
      style={OVERLAY_STYLE}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
    >
      <div
        data-testid="canvas-quickcreate-modal"
        role="dialog"
        aria-modal="true"
        style={{
          width: 340,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          padding: 16,
          borderRadius: 12,
          background: 'var(--color-panel-2)',
          border: '1px solid rgba(255,255,255,0.14)',
          boxShadow: '4px 4px 0 rgba(0,0,0,0.4)',
        }}
      >
        <h3 style={{ margin: 0, fontSize: 13.5, fontWeight: 700, color: 'var(--color-text)' }}>
          {mode === 'edit' ? t('canvas.quickCreate.titleEdit') : t('canvas.draft.untitled')}
        </h3>

        {mode === 'edit' && versions && onRestoreVersion && (
          <CanvasDraftVersionsPanel
            versions={versions}
            current={{ title, task }}
            onRestore={(ts) => {
              onRestoreVersion(ts);
              onCancel();
            }}
          />
        )}

        <div>
          <label htmlFor={titleFieldId} style={LABEL_STYLE}>
            {t('canvas.quickCreate.fieldTitle')}
          </label>
          <input
            id={titleFieldId}
            ref={titleInputRef}
            data-testid="canvas-quickcreate-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            style={FIELD_STYLE}
          />
        </div>

        <div>
          <label htmlFor={taskFieldId} style={LABEL_STYLE}>
            {t('canvas.quickCreate.fieldTask')}
          </label>
          <textarea
            id={taskFieldId}
            data-testid="canvas-quickcreate-task"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            rows={4}
            style={{ ...FIELD_STYLE, resize: 'vertical', fontFamily: 'var(--font-ui)' }}
          />
        </div>

        <div>
          <label htmlFor={modelFieldId} style={LABEL_STYLE}>
            {t('canvas.quickCreate.fieldModel')}
          </label>
          <select id={modelFieldId} data-testid="canvas-quickcreate-model" value={model} onChange={(e) => setModel(e.target.value)} style={FIELD_STYLE}>
            {!knownModel && <option value={model}>{model}</option>}
            {ALL_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button
            type="button"
            data-testid="canvas-quickcreate-cancel"
            onClick={onCancel}
            style={{
              fontSize: 12,
              fontWeight: 600,
              padding: '6px 12px',
              borderRadius: 7,
              border: '1px solid rgba(255,255,255,0.18)',
              background: 'transparent',
              color: 'var(--color-text-muted)',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {t('canvas.quickCreate.cancel')}
          </button>
          <button
            type="button"
            data-testid="canvas-quickcreate-submit"
            onClick={handleSubmit}
            disabled={title.trim().length === 0}
            style={{
              fontSize: 12,
              fontWeight: 700,
              padding: '6px 14px',
              borderRadius: 7,
              border: 'none',
              cursor: title.trim().length === 0 ? 'not-allowed' : 'pointer',
              opacity: title.trim().length === 0 ? 0.5 : 1,
              background: 'var(--color-accent)',
              color: '#14141C',
              fontFamily: 'inherit',
            }}
          >
            {mode === 'edit' ? t('canvas.quickCreate.submitEdit') : t('canvas.quickCreate.submitCreate')}
          </button>
        </div>
      </div>
    </div>
  );
}
