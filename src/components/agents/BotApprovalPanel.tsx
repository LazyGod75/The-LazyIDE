/* BotApprovalPanel — the human-verdict surface for the LazyBot cloud gate.

   The approval gate (approvalGate.ts) BLOCKS a consequential cloud_* tool
   call until a human verdict lands. It emits `solari:approvalRequest` on the
   bus and keeps the promise pending until `resolveApproval` settles it. This
   panel is the only UI that listens for those requests and lets the user
   Approve / Edit / Deny / Always-allow the action.

   It renders as a fixed overlay (bottom-right) so an approval is visible
   regardless of which space the user is in. It re-syncs from the gate's
   in-memory list on every request/resolved event, so it never drifts.
*/

import { useCallback, useEffect, useState } from 'react';
import { on } from '../../lib/bus';
import {
  resolveApproval,
  listPendingApprovals,
  type PendingApproval,
} from '../../lib/agents/approval/approvalGate';
import type { ActionClass } from '../../lib/agents/approval/approvalTypes';

const CLASS_COLORS: Record<ActionClass, string> = {
  browse: '#66E27A',
  read: '#66E27A',
  screenshot: '#66E27A',
  compose: '#B8A9FF',
  send: '#FFB86B',
  publish: '#FFB86B',
  pay: '#FF6B6B',
  delete: '#FF6B6B',
  credentials: '#FF6B6B',
  exec: '#FFB86B',
  file_write: '#FFB86B',
  unknown: '#FFB86B',
};

export function BotApprovalPanel() {
  const [pending, setPending] = useState<PendingApproval[]>(() => listPendingApprovals());
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});

  const sync = useCallback(() => setPending(listPendingApprovals()), []);

  useEffect(() => {
    const offRequest = on('solari:approvalRequest', sync);
    const offResolved = on('solari:approvalResolved', sync);
    return () => {
      offRequest();
      offResolved();
    };
  }, [sync]);

  const verdict = useCallback((missionId: string, v: 'approve' | 'deny' | 'alwaysAllow') => {
    resolveApproval(missionId, v);
  }, []);

  const approveEdited = useCallback((missionId: string) => {
    const raw = edits[missionId];
    if (raw === undefined) return;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setEditErrors((prev) => ({ ...prev, [missionId]: 'Args must be a JSON object.' }));
        return;
      }
      setEditErrors((prev) => {
        const next = { ...prev };
        delete next[missionId];
        return next;
      });
      resolveApproval(missionId, 'edit', parsed as Record<string, unknown>);
    } catch {
      setEditErrors((prev) => ({ ...prev, [missionId]: 'Invalid JSON.' }));
    }
  }, [edits]);

  if (pending.length === 0) return null;

  return (
    <div style={S.overlay}>
      {pending.map((p) => {
        const argsText = edits[p.missionId] ?? JSON.stringify(p.args, null, 2);
        const err = editErrors[p.missionId];
        return (
          <div key={p.missionId} style={S.card} data-testid={`bot-approval-${p.missionId}`}>
            <div style={S.header}>
              <span style={{ ...S.classBadge, color: CLASS_COLORS[p.klass], borderColor: CLASS_COLORS[p.klass] }}>
                {p.klass.toUpperCase()}
              </span>
              <span style={S.tool}>{p.tool}</span>
              <span style={S.reason}>{p.reason}</span>
            </div>

            {p.page.url && <div style={S.metaLine}>URL: {p.page.url}</div>}
            {p.page.targetText && <div style={S.metaLine}>Target: {p.page.targetText}</div>}
            {p.page.screenshotDataUrl && (
              <img
                src={p.page.screenshotDataUrl}
                alt="Approval preview"
                data-testid={`bot-approval-shot-${p.missionId}`}
                style={S.shot}
              />
            )}

            <textarea
              style={S.args}
              rows={4}
              value={argsText}
              onChange={(e) => setEdits((prev) => ({ ...prev, [p.missionId]: e.target.value }))}
              aria-label="Action arguments"
            />
            {err && <div style={S.error}>{err}</div>}

            <div style={S.actions}>
              <button style={S.approve} onClick={() => verdict(p.missionId, 'approve')}>Approve</button>
              <button style={S.edit} onClick={() => approveEdited(p.missionId)}>Approve edited</button>
              <button style={S.always} onClick={() => verdict(p.missionId, 'alwaysAllow')}>Always allow</button>
              <button style={S.deny} onClick={() => verdict(p.missionId, 'deny')}>Deny</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const S = {
  overlay: {
    position: 'fixed' as const,
    bottom: 20,
    right: 20,
    zIndex: 9990,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
    maxWidth: 420,
    width: 'min(420px, calc(100vw - 40px))',
  },
  card: {
    background: '#16161D',
    border: '1px solid rgba(255, 183, 107, 0.45)',
    borderRadius: 12,
    padding: 14,
    boxShadow: '0 24px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,183,107,0.12)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
  },
  header: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const },
  classBadge: {
    fontSize: 11,
    fontWeight: 700,
    padding: '2px 8px',
    borderRadius: 6,
    border: '1px solid',
    letterSpacing: '0.04em',
  },
  tool: { fontSize: 13, fontWeight: 600, color: '#E2E2F0', fontFamily: 'monospace' },
  reason: { fontSize: 11, color: '#9994B8' },
  metaLine: { fontSize: 11, color: '#9994B8', wordBreak: 'break-all' as const },
  shot: {
    width: '100%', maxHeight: 160, objectFit: 'cover' as const, borderRadius: 8,
    border: '1px solid rgba(255,255,255,0.08)',
  },
  args: {
    background: '#0E0E14',
    border: '1px solid rgba(124,92,255,0.25)',
    borderRadius: 8,
    padding: '8px 10px',
    color: '#E2E2F0',
    fontSize: 12,
    fontFamily: 'monospace',
    outline: 'none',
    resize: 'vertical' as const,
    width: '100%',
    boxSizing: 'border-box' as const,
  },
  error: { fontSize: 12, color: '#FF6B6B' },
  actions: { display: 'flex', gap: 8, flexWrap: 'wrap' as const },
  approve: {
    flex: 1, padding: '8px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
    background: 'rgba(102,226,122,0.15)', border: '1px solid rgba(102,226,122,0.4)', color: '#66E27A',
  },
  edit: {
    flex: 1, padding: '8px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
    background: 'rgba(124,92,255,0.15)', border: '1px solid rgba(124,92,255,0.4)', color: '#B8A9FF',
  },
  always: {
    flex: 1, padding: '8px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
    background: 'rgba(255,183,107,0.12)', border: '1px solid rgba(255,183,107,0.4)', color: '#FFB86B',
  },
  deny: {
    flex: 1, padding: '8px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
    background: 'rgba(255,107,107,0.15)', border: '1px solid rgba(255,107,107,0.4)', color: '#FF6B6B',
  },
};
