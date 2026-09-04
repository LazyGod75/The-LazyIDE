/* agentMailbox.ts — P7.2: Agent mailbox peer messaging.

   Allows agents (missions) to send messages to each other through a
   journal-backed mailbox system. Uses the existing `agent.message` journal
   event type (from/to/text) plus a new `agent.message_read` receipt event.
*/

import { emitEvent, journalQuery } from '../journal/journal.js';
import type { JournalEventRow } from '../journal/eventTypes.js';

export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  timestamp: number;
  read: boolean;
  projectId?: string;
}

export interface AgentMailbox {
  send(args: {
    fromMissionId: string;
    toMissionId: string;
    subject: string;
    body: string;
    projectId: string;
  }): Promise<string>;

  read(missionId: string, opts?: { projectId?: string }): Promise<AgentMessage[]>;

  markRead(messageId: string, missionId: string, projectId?: string): Promise<void>;
}

export function createAgentMailbox(): AgentMailbox {
  return {
    async send({ fromMissionId, toMissionId, subject, body, projectId }): Promise<string> {
      const tsMs = Date.now();
      // Stable id derived from content + time (AgentMessagePayload is only from/to/text).
      const messageId = `msg-${tsMs}-${fromMissionId.slice(0, 6)}-${toMissionId.slice(0, 6)}`;
      await emitEvent({
        type: 'agent.message',
        tsMs,
        projectId,
        actor: 'agent',
        payload: {
          from: fromMissionId,
          to: toMissionId,
          text: `[${messageId}]\n${subject}\n\n${body}`,
        },
      });
      return messageId;
    },

    async read(missionId, opts): Promise<AgentMessage[]> {
      const events = await journalQuery({
        types: ['agent.message'],
        projectId: opts?.projectId,
        limit: 200,
      });

      return events
        .map((e) => parseMessageEvent(e))
        .filter((p): p is AgentMessage => p !== null)
        .filter((p) => p.to === missionId)
        .filter((p) => !opts?.projectId || p.projectId === opts.projectId)
        .sort((a, b) => a.timestamp - b.timestamp);
    },

    async markRead(messageId, missionId, projectId): Promise<void> {
      await emitEvent({
        type: 'agent.message_read',
        tsMs: Date.now(),
        projectId: projectId ?? '',
        actor: 'agent',
        payload: { messageId, missionId },
      });
    },
  };
}

function parseMessageEvent(e: JournalEventRow): AgentMessage | null {
  try {
    const p = JSON.parse(e.payload) as Record<string, unknown>;
    const from = typeof p.from === 'string' ? p.from : null;
    const to = typeof p.to === 'string' ? p.to : null;
    const text = typeof p.text === 'string' ? p.text : null;
    if (!from || !to || !text) return null;
    const idMatch = text.match(/^\[(msg-[^\]]+)\]/);
    const id = idMatch?.[1] ?? `msg-seq-${e.seq}`;
    return {
      id,
      from,
      to,
      text,
      timestamp: e.ts_ms,
      read: false,
      projectId: e.project_id,
    };
  } catch {
    return null;
  }
}
