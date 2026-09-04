/* NewBotModal — centered dialog for creating a new LazyBot.
   Dark/violet theme matching NewMissionModal. Esc + backdrop close.
*/

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BotConfig } from '../../lib/bots/botTypes';
import { useBots } from './botsStore';
import { useFocusTrap } from '../../hooks/useFocusTrap';

interface NewBotModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated?: (bot: BotConfig) => void;
}

interface FormState {
  name: string;
  description: string;
  systemPrompt: string;
  autonomy: BotConfig['autonomy'];
  browser: boolean;
  desktop: boolean;
  sandbox: boolean;
}

const INITIAL_STATE: FormState = {
  name: '',
  description: '',
  systemPrompt: 'You are a helpful bot that can browse the web and complete tasks autonomously.',
  autonomy: 'supervised',
  browser: true,
  desktop: false,
  sandbox: false,
};

const AUTONOMY_OPTIONS: { value: BotConfig['autonomy']; label: string; hint: string }[] = [
  { value: 'manual', label: 'Manual', hint: 'Every cloud action requires approval' },
  { value: 'supervised', label: 'Supervised', hint: 'Consequential actions require approval' },
  { value: 'yolo', label: 'YOLO', hint: 'Only credentials require approval' },
];

export function NewBotModal({ isOpen, onClose, onCreated }: NewBotModalProps) {
  const { createBot } = useBots();
  const [form, setForm] = useState<FormState>(INITIAL_STATE);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, { onClose });

  useEffect(() => {
    if (!isOpen) {
      setForm(INITIAL_STATE);
      setError(null);
      setSubmitting(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const handleSubmit = useCallback(async () => {
    if (!form.name.trim()) {
      setError('Name is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const bot = await createBot({
        name: form.name.trim(),
        description: form.description.trim(),
        systemPrompt: form.systemPrompt,
        autonomy: form.autonomy,
        capabilities: { browser: form.browser, desktop: form.desktop, sandbox: form.sandbox },
      });
      onCreated?.(bot);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }, [form, createBot, onCreated, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div role="presentation" style={S.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={modalRef} role="dialog" aria-modal="true" aria-label="New LazyBot" style={S.modal}>
        <div style={S.header}>
          <span style={S.headerTitle}>New LazyBot</span>
          <button onClick={onClose} style={S.closeBtn} aria-label="Close">x</button>
        </div>

        <div style={S.body}>
          <Field label="Name">
            <input
              style={S.input}
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="My Shopping Bot"
              autoFocus
            />
          </Field>

          <Field label="Description">
            <input
              style={S.input}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Tracks prices and buys when they drop"
            />
          </Field>

          <Field label="System Prompt">
            <textarea
              style={{ ...S.input, minHeight: 80, resize: 'vertical' as const }}
              value={form.systemPrompt}
              onChange={(e) => setForm((f) => ({ ...f, systemPrompt: e.target.value }))}
            />
          </Field>

          <Field label="Autonomy">
            <div style={S.autonomyRow}>
              {AUTONOMY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setForm((f) => ({ ...f, autonomy: opt.value }))}
                  style={{
                    ...S.autonomyBtn,
                    ...(form.autonomy === opt.value ? S.autonomyBtnActive : {}),
                  }}
                  title={opt.hint}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Cloud Capabilities">
            <div style={S.capRow}>
              <Checkbox label="Browser" checked={form.browser} onChange={(v) => setForm((f) => ({ ...f, browser: v }))} />
              <Checkbox label="Desktop" checked={form.desktop} onChange={(v) => setForm((f) => ({ ...f, desktop: v }))} />
              <Checkbox label="Sandbox" checked={form.sandbox} onChange={(v) => setForm((f) => ({ ...f, sandbox: v }))} />
            </div>
          </Field>

          {error && <div style={S.error}>{error}</div>}
        </div>

        <div style={S.footer}>
          <button onClick={onClose} style={S.cancelBtn}>Cancel</button>
          <button onClick={handleSubmit} disabled={submitting} style={S.createBtn}>
            {submitting ? 'Creating...' : 'Create Bot'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Small presentational helpers ───────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={S.field}>
      <span style={S.fieldLabel}>{label}</span>
      {children}
    </label>
  );
}

function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={S.checkbox}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

// ── Styles ─────────────────────────────────────────────────────────

const S = {
  backdrop: {
    position: 'fixed' as const, inset: 0,
    background: 'rgba(5, 5, 10, 0.75)', backdropFilter: 'blur(5px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 9998, padding: '16px',
  },
  modal: {
    width: 480, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 32px)',
    background: '#16161D', border: '1px solid rgba(124, 92, 255, 0.3)',
    borderRadius: 12, boxShadow: '0 32px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(124,92,255,0.12)',
    display: 'flex', flexDirection: 'column' as const, overflow: 'hidden',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '16px 20px', flexShrink: 0,
  },
  headerTitle: { fontSize: 15, fontWeight: 600, color: '#E2E2F0', letterSpacing: '0.01em' },
  closeBtn: {
    background: 'none', border: 'none', color: '#888', cursor: 'pointer',
    fontSize: 16, padding: '4px 8px', borderRadius: 4,
  },
  body: { padding: '0 20px', overflowY: 'auto' as const, flex: 1, display: 'flex', flexDirection: 'column' as const, gap: 14 },
  field: { display: 'flex', flexDirection: 'column' as const, gap: 6 },
  fieldLabel: { fontSize: 12, color: '#9994B8', fontWeight: 500 },
  input: {
    background: '#0E0E14', border: '1px solid rgba(124,92,255,0.2)',
    borderRadius: 8, padding: '10px 12px', color: '#E2E2F0', fontSize: 14,
    outline: 'none', width: '100%', boxSizing: 'border-box' as const,
  },
  autonomyRow: { display: 'flex', gap: 8 },
  autonomyBtn: {
    flex: 1, padding: '8px 12px', borderRadius: 8, cursor: 'pointer',
    background: '#0E0E14', border: '1px solid rgba(124,92,255,0.2)',
    color: '#9994B8', fontSize: 13, fontWeight: 500,
  },
  autonomyBtnActive: {
    background: 'rgba(124,92,255,0.15)', border: '1px solid rgba(124,92,255,0.5)',
    color: '#B8A9FF',
  },
  capRow: { display: 'flex', gap: 16 },
  checkbox: { display: 'flex', alignItems: 'center', gap: 6, color: '#E2E2F0', fontSize: 14, cursor: 'pointer' },
  error: { color: '#FF6B6B', fontSize: 13, padding: '8px 12px', background: 'rgba(255,107,107,0.1)', borderRadius: 8 },
  footer: {
    display: 'flex', justifyContent: 'flex-end', gap: 10,
    padding: '16px 20px', flexShrink: 0,
  },
  cancelBtn: {
    padding: '8px 16px', borderRadius: 8, cursor: 'pointer',
    background: 'transparent', border: '1px solid rgba(124,92,255,0.2)',
    color: '#9994B8', fontSize: 14,
  },
  createBtn: {
    padding: '8px 16px', borderRadius: 8, cursor: 'pointer',
    background: 'rgba(124,92,255,0.2)', border: '1px solid rgba(124,92,255,0.5)',
    color: '#B8A9FF', fontSize: 14, fontWeight: 600,
  },
};
