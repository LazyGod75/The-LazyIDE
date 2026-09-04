/* BotDetailPanel — cockpit side panel showing a LazyBot's config, runtime
   state, and action buttons (run, pause, delete). Rendered in the cockpit
   right rail when a bot is selected.
*/

import { useCallback, useState } from 'react';
import type { BotConfig } from '../../lib/bots/botTypes';
import { useBots } from './botsStore';
import { BotPersonaEditor } from './BotPersonaEditor';
import { BotRoutineEditor } from './BotRoutineEditor';
import { BotReplayPlayer } from './BotReplayPlayer';

interface BotDetailPanelProps {
  bot: BotConfig;
  onLaunchRun?: (bot: BotConfig, task: string) => void;
}

const AUTONOMY_COLORS: Record<BotConfig['autonomy'], string> = {
  manual: '#FF6B6B',
  supervised: '#FFB86B',
  yolo: '#66E27A',
};

export function BotDetailPanel({ bot, onLaunchRun }: BotDetailPanelProps) {
  const { updateBot, removeBot, toggleEnabled, getRuntimeState } = useBots();
  const [taskInput, setTaskInput] = useState('');
  const [replayUrl, setReplayUrl] = useState('');
  const runtime = getRuntimeState(bot.id);

  const handleLaunch = useCallback(() => {
    const task = taskInput.trim();
    if (!task) return;
    onLaunchRun?.(bot, task);
    setTaskInput('');
  }, [taskInput, bot, onLaunchRun]);

  const handleToggleCap = useCallback((key: 'browser' | 'desktop' | 'sandbox') => {
    void updateBot({ ...bot, capabilities: { ...bot.capabilities, [key]: !bot.capabilities[key] } });
  }, [bot, updateBot]);

  const handleAutonomyChange = useCallback((autonomy: BotConfig['autonomy']) => {
    void updateBot({ ...bot, autonomy });
  }, [bot, updateBot]);

  const handleDelete = useCallback(() => {
    if (confirm(`Delete bot "${bot.name}"? This cannot be undone.`)) {
      void removeBot(bot.id);
    }
  }, [bot, removeBot]);

  return (
    <div style={S.panel}>
      <div style={S.header}>
        <div style={S.avatar}>{bot.avatar ?? '🤖'}</div>
        <div style={S.headerInfo}>
          <div style={S.botName}>{bot.name}</div>
          <div style={S.botDesc}>{bot.description || 'No description'}</div>
        </div>
      </div>

      <div style={S.section}>
        <div style={S.sectionTitle}>Status</div>
        <div style={S.statusRow}>
          <span style={{ ...S.badge, background: bot.enabled ? 'rgba(102,226,122,0.15)' : 'rgba(255,107,107,0.15)', color: bot.enabled ? '#66E27A' : '#FF6B6B' }}>
            {bot.enabled ? 'Enabled' : 'Paused'}
          </span>
          <span style={{ ...S.badge, color: AUTONOMY_COLORS[bot.autonomy] }}>
            {bot.autonomy.toUpperCase()}
          </span>
          {runtime.activeRuns.length > 0 && (
            <span style={{ ...S.badge, background: 'rgba(124,92,255,0.15)', color: '#B8A9FF' }}>
              {runtime.activeRuns.length} active run{runtime.activeRuns.length > 1 ? 's' : ''}
            </span>
          )}
        </div>
        {runtime.lastError && <div style={S.errorText}>Last error: {runtime.lastError}</div>}
      </div>

      <BotPersonaEditor
        bot={bot}
        onSave={(systemPrompt) => { void updateBot({ ...bot, systemPrompt }); }}
      />

      <div style={S.section}>
        <div style={S.sectionTitle}>Quick Run</div>
        <textarea
          style={S.taskInput}
          value={taskInput}
          onChange={(e) => setTaskInput(e.target.value)}
          placeholder="Enter a task for this bot..."
          rows={3}
        />
        <button onClick={handleLaunch} disabled={!taskInput.trim() || !bot.enabled} style={S.runBtn}>
          Launch Run
        </button>
      </div>

      <div style={S.section}>
        <div style={S.sectionTitle}>Autonomy</div>
        <div style={S.autonomyRow}>
          {(['manual', 'supervised', 'yolo'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => handleAutonomyChange(mode)}
              style={{
                ...S.autonomyBtn,
                ...(bot.autonomy === mode ? { ...S.autonomyBtnActive, borderColor: AUTONOMY_COLORS[mode] } : {}),
              }}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      <div style={S.section}>
        <div style={S.sectionTitle}>Capabilities</div>
        <div style={S.capRow}>
          <CapToggle label="Browser" active={bot.capabilities.browser} onClick={() => handleToggleCap('browser')} />
          <CapToggle label="Desktop" active={bot.capabilities.desktop} onClick={() => handleToggleCap('desktop')} />
          <CapToggle label="Sandbox" active={bot.capabilities.sandbox} onClick={() => handleToggleCap('sandbox')} />
        </div>
      </div>

      <BotRoutineEditor
        bot={bot}
        onChange={(routines) => { void updateBot({ ...bot, routines }); }}
      />

      <div style={S.section}>
        <div style={S.sectionTitle}>Replay (C58)</div>
        <input
          style={S.taskInput}
          value={replayUrl}
          onChange={(e) => setReplayUrl(e.target.value)}
          placeholder="Paste Solari replay URL…"
        />
        {replayUrl.trim().startsWith('http') && (
          <div style={{ marginTop: 8, height: 260 }}>
            <BotReplayPlayer replayUrl={replayUrl.trim()} title={`${bot.name} replay`} />
          </div>
        )}
      </div>

      {bot.profileIds.length > 0 && (
        <div style={S.section}>
          <div style={S.sectionTitle}>Solari Profiles ({bot.profileIds.length})</div>
          <div style={S.profileList}>
            {bot.profileIds.map((id) => (
              <span key={id} style={S.profileChip}>{id}</span>
            ))}
          </div>
        </div>
      )}

      <div style={S.actions}>
        <button onClick={() => toggleEnabled(bot.id, !bot.enabled)} style={S.toggleBtn}>
          {bot.enabled ? 'Pause Bot' : 'Enable Bot'}
        </button>
        <button onClick={handleDelete} style={S.deleteBtn}>Delete</button>
      </div>
    </div>
  );
}

function CapToggle({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        ...S.capBtn,
        ...(active ? S.capBtnActive : {}),
      }}
    >
      {label}
    </button>
  );
}

// ── Styles ─────────────────────────────────────────────────────────

const S = {
  panel: {
    display: 'flex', flexDirection: 'column' as const, gap: 16,
    padding: 20, overflowY: 'auto' as const, height: '100%',
  },
  header: { display: 'flex', gap: 12, alignItems: 'center' },
  avatar: { fontSize: 32, width: 48, height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(124,92,255,0.1)', borderRadius: 12 },
  headerInfo: { flex: 1, minWidth: 0 },
  botName: { fontSize: 16, fontWeight: 600, color: '#E2E2F0' },
  botDesc: { fontSize: 13, color: '#9994B8', marginTop: 2 },
  section: { display: 'flex', flexDirection: 'column' as const, gap: 8 },
  sectionTitle: { fontSize: 11, fontWeight: 600, color: '#9994B8', textTransform: 'uppercase' as const, letterSpacing: '0.05em' },
  statusRow: { display: 'flex', gap: 8, flexWrap: 'wrap' as const },
  badge: { fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6, background: 'rgba(255,255,255,0.05)' },
  errorText: { fontSize: 12, color: '#FF6B6B', marginTop: 4 },
  taskInput: {
    background: '#0E0E14', border: '1px solid rgba(124,92,255,0.2)',
    borderRadius: 8, padding: '10px 12px', color: '#E2E2F0', fontSize: 14,
    outline: 'none', resize: 'vertical' as const, width: '100%', boxSizing: 'border-box' as const,
  },
  runBtn: {
    padding: '10px 16px', borderRadius: 8, cursor: 'pointer',
    background: 'rgba(124,92,255,0.2)', border: '1px solid rgba(124,92,255,0.5)',
    color: '#B8A9FF', fontSize: 14, fontWeight: 600,
  },
  autonomyRow: { display: 'flex', gap: 8 },
  autonomyBtn: {
    flex: 1, padding: '8px 12px', borderRadius: 8, cursor: 'pointer',
    background: '#0E0E14', border: '1px solid rgba(124,92,255,0.2)',
    color: '#9994B8', fontSize: 13,
  },
  autonomyBtnActive: { background: 'rgba(124,92,255,0.15)', color: '#B8A9FF' },
  capRow: { display: 'flex', gap: 8 },
  capBtn: {
    flex: 1, padding: '8px 12px', borderRadius: 8, cursor: 'pointer',
    background: '#0E0E14', border: '1px solid rgba(124,92,255,0.2)',
    color: '#9994B8', fontSize: 13,
  },
  capBtnActive: { background: 'rgba(124,92,255,0.15)', border: '1px solid rgba(124,92,255,0.5)', color: '#B8A9FF' },
  profileList: { display: 'flex', gap: 6, flexWrap: 'wrap' as const },
  profileChip: { fontSize: 11, padding: '3px 8px', borderRadius: 6, background: 'rgba(124,92,255,0.1)', color: '#B8A9FF' },
  routineRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' },
  routineName: { fontSize: 13, color: '#E2E2F0', flex: 1 },
  routineSchedule: { fontSize: 12, color: '#9994B8', fontFamily: 'monospace' },
  actions: { display: 'flex', gap: 8, marginTop: 'auto', paddingTop: 16 },
  toggleBtn: {
    flex: 1, padding: '10px 16px', borderRadius: 8, cursor: 'pointer',
    background: '#0E0E14', border: '1px solid rgba(124,92,255,0.2)',
    color: '#9994B8', fontSize: 14,
  },
  deleteBtn: {
    padding: '10px 16px', borderRadius: 8, cursor: 'pointer',
    background: 'rgba(255,107,107,0.1)', border: '1px solid rgba(255,107,107,0.3)',
    color: '#FF6B6B', fontSize: 14,
  },
};
