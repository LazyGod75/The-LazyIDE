import { useState, useEffect, useCallback } from 'react';
import type { Mission } from '../../lib/agents/types';
import { createAgentMailbox, type AgentMessage } from '../../lib/agents/agentMailbox';
import { useAgentsStoreOptional, resolveProjectRoot } from './agentsStore';
import { projectIdFromRoot } from '../../lib/journal/projectId';
import { isTauri } from '../../lib/platform';
import { useToast } from '../ui';
import { useI18n } from '../../i18n';

export function MissionMailbox({ mission }: { mission: Mission }) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [sendText, setSendText] = useState('');
  const [targetMissionId, setTargetMissionId] = useState('');
  // Optional on purpose (returns null outside an AgentsStoreProvider —
  // fixture/harness renders, e.g. MissionDetail.test.tsx): the "send to
  // another mission" affordance is simply omitted then, same degrade
  // pattern as MissionNode.tsx's own agentsStore?.missions read.
  const agentsStore = useAgentsStoreOptional();
  const missions = agentsStore?.missions ?? [];
  const { toast } = useToast();
  const { t } = useI18n();

  const mailbox = createAgentMailbox();

  const refresh = useCallback(async () => {
    if (!isTauri()) { setLoading(false); return; }
    try {
      const msgs = await mailbox.read(mission.id);
      setMessages(msgs);
    } catch { /* best-effort */ }
    finally { setLoading(false); }
  }, [mission.id]);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleSend = useCallback(async () => {
    const text = sendText.trim();
    const target = targetMissionId.trim();
    if (!text || !target) return;
    try {
      const root = await resolveProjectRoot();
      const projectId = projectIdFromRoot(root);
      await mailbox.send({
        fromMissionId: mission.id,
        toMissionId: target,
        subject: 'Inter-mission message',
        body: text,
        projectId,
      });
      setSendText('');
      toast(t('agents.mailbox.messageSent'), 'success');
      void refresh();
    } catch {
      toast(t('agents.mailbox.sendError'), 'error');
    }
  }, [sendText, targetMissionId, mission.id, toast, refresh, t]);

  const otherMissions = missions.filter((m) => m.id !== mission.id && m.status === 'running');

  if (!isTauri()) return null;
  if (loading) return null;
  if (messages.length === 0 && otherMissions.length === 0) return null;

  return (
    <div data-testid="mission-mailbox" style={{
      background: '#16161D',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 10,
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '9px 14px',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
        fontSize: 11,
        fontWeight: 700,
        color: 'rgba(255,255,255,0.45)',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
      }}>
        {t('agents.mailbox.title')}
      </div>
      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {messages.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {messages.map((msg) => (
              <div key={msg.id} style={{
                background: 'rgba(255,255,255,0.04)',
                borderRadius: 6,
                padding: '8px 10px',
                fontSize: 12,
              }}>
                <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10, marginBottom: 4 }}>
                  {t('agents.mailbox.from', { from: msg.from.slice(0, 12) })}
                </div>
                <div style={{ color: '#E2E2F0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {msg.text}
                </div>
              </div>
            ))}
          </div>
        )}
        {otherMissions.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <select
              value={targetMissionId}
              onChange={(e) => setTargetMissionId(e.target.value)}
              style={{
                background: '#0A0A10',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 6,
                padding: '5px 8px',
                color: '#E2E2F0',
                fontSize: 12,
                fontFamily: 'inherit',
              }}
            >
              <option value="">{t('agents.mailbox.recipientPlaceholder')}</option>
              {otherMissions.map((m) => (
                <option key={m.id} value={m.id}>{m.title.slice(0, 40)}</option>
              ))}
            </select>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={sendText}
                onChange={(e) => setSendText(e.target.value)}
                placeholder={t('agents.mailbox.messagePlaceholder')}
                style={{
                  flex: 1,
                  background: '#0A0A10',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 6,
                  padding: '5px 8px',
                  color: '#E2E2F0',
                  fontSize: 12,
                  fontFamily: 'inherit',
                  outline: 'none',
                }}
              />
              <button
                onClick={() => void handleSend()}
                disabled={!sendText.trim() || !targetMissionId}
                style={{
                  padding: '5px 12px',
                  borderRadius: 6,
                  border: 'none',
                  background: sendText.trim() && targetMissionId ? '#7C5CFF' : 'rgba(124,92,255,0.25)',
                  color: '#fff',
                  fontSize: 12,
                  cursor: sendText.trim() && targetMissionId ? 'pointer' : 'default',
                  fontFamily: 'inherit',
                }}
              >
                {t('agents.mailbox.send')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
