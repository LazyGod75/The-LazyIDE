/* BotRoutineEditor — add/toggle/remove cron routines on a LazyBot (C80). */

import { useCallback, useState } from 'react';
import type { BotConfig, BotRoutine } from '../../lib/bots/botTypes';
import { WEB_ROUTINES_DISABLED_MESSAGE } from '../../lib/bots/botScheduler';
import { listQueuedRoutineFires } from '../../lib/bots/botRoutineQueue';
import { getPlatform } from '../../lib/platform';
import { useI18n } from '../../i18n';

interface BotRoutineEditorProps {
  bot: BotConfig;
  onChange: (routines: BotRoutine[]) => void;
}

function newRoutineId(): string {
  return `rtn_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function BotRoutineEditor({ bot, onChange }: BotRoutineEditorProps) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState('0 9 * * 1-5');
  const [task, setTask] = useState('');
  const isWeb = getPlatform().name !== 'tauri';
  const queuedCount = isWeb ? listQueuedRoutineFires().filter((q) => q.botId === bot.id).length : 0;

  const add = useCallback(() => {
    const n = name.trim();
    const tsk = task.trim();
    if (!n || !tsk) return;
    const routine: BotRoutine = {
      id: newRoutineId(),
      name: n,
      schedule: schedule.trim() || '0 9 * * 1-5',
      task: tsk,
      enabled: true,
      lastRunAt: null,
    };
    onChange([...bot.routines, routine]);
    setName('');
    setTask('');
  }, [name, schedule, task, bot.routines, onChange]);

  const toggle = useCallback((id: string) => {
    onChange(bot.routines.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)));
  }, [bot.routines, onChange]);

  const remove = useCallback((id: string) => {
    onChange(bot.routines.filter((r) => r.id !== id));
  }, [bot.routines, onChange]);

  return (
    <div style={S.wrap} data-testid="bot-routine-editor">
      <div style={S.sectionTitle}>Routines</div>
      {isWeb && (
        <div style={S.webNote} data-testid="bot-routines-web-note" title={WEB_ROUTINES_DISABLED_MESSAGE}>
          {t('bots.routines.webDisabled')}
          {queuedCount > 0 ? ` ${t('bots.routines.queuedForDesktop', { count: queuedCount })}` : ''}
        </div>
      )}
      {bot.routines.map((r) => (
        <div key={r.id} style={S.row}>
          <span style={S.name}>{r.name}</span>
          <span style={S.sched}>{r.schedule}</span>
          <button type="button" onClick={() => toggle(r.id)} style={S.chip}>
            {r.enabled ? 'on' : 'off'}
          </button>
          <button type="button" onClick={() => remove(r.id)} style={S.del} aria-label={`Remove ${r.name}`}>×</button>
        </div>
      ))}
      <input style={S.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Routine name" />
      <input style={S.input} value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="Cron (0 9 * * 1-5)" />
      <textarea style={S.tarea} value={task} onChange={(e) => setTask(e.target.value)} placeholder="Task prompt" rows={2} />
      <button type="button" onClick={add} disabled={!name.trim() || !task.trim()} style={S.add}>
        Add routine
      </button>
    </div>
  );
}

const S = {
  wrap: { display: 'flex', flexDirection: 'column' as const, gap: 8 },
  sectionTitle: { fontSize: 11, fontWeight: 700, color: '#8B85A8', textTransform: 'uppercase' as const, letterSpacing: 0.6 },
  webNote: {
    fontSize: 11,
    lineHeight: 1.4,
    color: '#FFC76B',
    background: 'rgba(255,199,107,0.08)',
    borderRadius: 8,
    padding: '8px 10px',
  },
  row: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 },
  name: { color: '#E8E4F8', fontWeight: 600, flex: 1 },
  sched: { color: '#8B85A8', fontFamily: 'monospace' },
  chip: { background: 'rgba(102,226,122,0.12)', border: 'none', color: '#66E27A', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', fontSize: 11 },
  del: { background: 'none', border: 'none', color: '#FF6B6B', cursor: 'pointer', fontSize: 16 },
  input: { background: '#1A1A24', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: '#E8E4F8', padding: '6px 10px', fontSize: 12 },
  tarea: { background: '#1A1A24', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: '#E8E4F8', padding: '6px 10px', fontSize: 12, resize: 'vertical' as const },
  add: { background: 'rgba(124,92,255,0.2)', border: '1px solid rgba(124,92,255,0.4)', color: '#B8A9FF', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600 },
};
