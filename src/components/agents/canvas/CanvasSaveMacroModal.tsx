/* CanvasSaveMacroModal.tsx — naming prompt for « Enregistrer comme macro »
   (group macros, Langflow parity, spec: multi-select drafts/routers/notes
   -> context menu -> named composite). Deliberately as minimal as
   CanvasQuickCreateModal.tsx (same overlay/field/button styling, kept as a
   SEPARATE small file rather than growing that one — this modal's fields
   (name + optional description) and submit contract are unrelated to a
   draft's title/task/model).
*/

import { useId, useRef, useState, type CSSProperties } from 'react';
import { useI18n } from '../../../i18n';
import { useFocusTrap } from '../../../hooks/useFocusTrap';

export interface SaveMacroValue {
  name: string;
  description?: string;
}

interface CanvasSaveMacroModalProps {
  /** How many pending nodes (drafts/routers/notes) will be captured —
   *  purely informational, shown so the user knows what "save" commits to
   *  before naming it. */
  nodeCount: number;
  onSubmit: (value: SaveMacroValue) => void;
  onCancel: () => void;
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

export function CanvasSaveMacroModal({ nodeCount, onSubmit, onCancel }: CanvasSaveMacroModalProps) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameFieldId = useId();
  const descriptionFieldId = useId();

  useFocusTrap(dialogRef, { onClose: onCancel });

  function handleSubmit(): void {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) return;
    const trimmedDescription = description.trim();
    onSubmit({ name: trimmedName, description: trimmedDescription.length > 0 ? trimmedDescription : undefined });
  }

  return (
    <div
      data-testid="canvas-savemacro-overlay"
      style={OVERLAY_STYLE}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        data-testid="canvas-savemacro-modal"
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
        <h3 style={{ margin: 0, fontSize: 13.5, fontWeight: 700, color: 'var(--color-text)' }}>{t('canvas.saveMacro.title')}</h3>
        <p style={{ margin: 0, fontSize: 11.5, color: 'var(--color-text-muted)' }}>{t('canvas.saveMacro.captureCount', { count: String(nodeCount) })}</p>

        <div>
          <label htmlFor={nameFieldId} style={LABEL_STYLE}>
            {t('canvas.saveMacro.fieldName')}
          </label>
          <input
            id={nameFieldId}
            data-testid="canvas-savemacro-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSubmit();
            }}
            style={FIELD_STYLE}
          />
        </div>

        <div>
          <label htmlFor={descriptionFieldId} style={LABEL_STYLE}>
            {t('canvas.saveMacro.fieldDescription')}
          </label>
          <textarea
            id={descriptionFieldId}
            data-testid="canvas-savemacro-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            style={{ ...FIELD_STYLE, resize: 'vertical', fontFamily: 'var(--font-ui)' }}
          />
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button
            type="button"
            data-testid="canvas-savemacro-cancel"
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
            {t('canvas.saveMacro.cancel')}
          </button>
          <button
            type="button"
            data-testid="canvas-savemacro-submit"
            onClick={handleSubmit}
            disabled={name.trim().length === 0}
            style={{
              fontSize: 12,
              fontWeight: 700,
              padding: '6px 14px',
              borderRadius: 7,
              border: 'none',
              cursor: name.trim().length === 0 ? 'not-allowed' : 'pointer',
              opacity: name.trim().length === 0 ? 0.5 : 1,
              background: 'var(--color-accent)',
              color: '#14141C',
              fontFamily: 'inherit',
            }}
          >
            {t('canvas.saveMacro.submit')}
          </button>
        </div>
      </div>
    </div>
  );
}
