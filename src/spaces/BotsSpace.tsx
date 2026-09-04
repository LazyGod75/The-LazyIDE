/* BotsSpace — full-page view for LazyBot management.
   Shows BotListPanel on the left, BotDetailPanel on the right,
   and NewBotModal for creation. Accessed from the cockpit or nav.
*/

import { useCallback, useEffect, useState } from 'react';
import type { BotConfig } from '../lib/bots/botTypes';
import { BotListPanel } from '../components/agents/BotListPanel';
import { BotDetailPanel } from '../components/agents/BotDetailPanel';
import { NewBotModal } from '../components/agents/NewBotModal';
import { useBots } from '../components/agents/botsStore';
import { BotApprovalPanel } from '../components/agents/BotApprovalPanel';
import { launchBotRun, toBotNewMissionInput } from '../lib/bots/botEngine';
import { resolveLazyBotRunModel } from '../lib/bots/botRunModel';
import { useAgentsStoreOptional } from '../components/agents/agentsStore';
import { useToastSafe } from '../components/ui/Toast';
import { getActiveModel } from '../lib/models';
import { isSolariConfigured } from '../lib/solari/solariClient';
import { on } from '../lib/bus';
import { BotVmWindow } from '../components/agents/canvas/nodes/BotVmWindow';

export function BotsSpace() {
  const [selectedBot, setSelectedBot] = useState<BotConfig | undefined>();
  const [showNewModal, setShowNewModal] = useState(false);
  const { bots, refresh } = useBots();
  const agents = useAgentsStoreOptional();
  const toast = useToastSafe();
  const [solariConfigured, setSolariConfigured] = useState(true);

  useEffect(() => {
    void isSolariConfigured().then(setSolariConfigured).catch(() => setSolariConfigured(false));
    const off = on('solari:configuredChange', ({ configured }) => setSolariConfigured(configured));
    return off;
  }, []);

  const handleSelect = useCallback((bot: BotConfig) => {
    setSelectedBot(bot);
  }, []);

  const handleLaunchRun = useCallback(async (bot: BotConfig, task: string) => {
    toast(`Launching run for ${bot.name}...`, 'info');
    try {
      if (!agents) throw new Error('agent store unavailable - open the Agents space once first.');
      // A bot runs on whichever rail the user actually has (BYOK / CLI /
      // Pro / free) — see resolveLazyBotRunModel; the old bare Claude id
      // sent bots to the CLI rail even when no CLI was installed.
      const { model } = resolveLazyBotRunModel(undefined, [getActiveModel().id]);
      // The run is created as a REAL mission through the agents store
      // (visible card, engine routing, stop paths) - see launchBotRun's
      // doc comment in botEngine.ts.
      await launchBotRun(bot, task, {
        model,
        createMission: async (input) => agents.addMission(toBotNewMissionInput(input)),
      });
      toast(`Run launched for ${bot.name}`, 'success');
    } catch (err) {
      toast(`Failed to launch: ${String(err)}`, 'error');
    }
  }, [agents, toast]);

  // Keep selectedBot in sync when bots list changes
  const currentBot = selectedBot ? bots.find((b) => b.id === selectedBot.id) : undefined;

  return (
    <div style={S.container}>
      <div style={S.leftRail}>
        <BotListPanel
          selectedBotId={currentBot?.id}
          onSelect={handleSelect}
          onCreateClick={() => setShowNewModal(true)}
        />
      </div>
      <div style={S.rightPanel}>
        {currentBot ? (
          <div style={S.detailRow}>
            <BotDetailPanel bot={currentBot} onLaunchRun={handleLaunchRun} />
            <BotVmWindow botId={currentBot.id} title={currentBot.name} />
          </div>
        ) : (
          <div style={S.empty}>
            <div style={S.emptyIcon}>🤖</div>
            <div style={S.emptyText}>Select a bot or create a new one</div>
            <button onClick={() => setShowNewModal(true)} style={S.emptyBtn}>
              + New Bot
            </button>
          </div>
        )}
      </div>
      <NewBotModal
        isOpen={showNewModal}
        onClose={() => setShowNewModal(false)}
        onCreated={(bot) => {
          void refresh().then(() => setSelectedBot(bot));
        }}
      />
      <BotApprovalPanel />
      {!solariConfigured && (
        <div style={S.keyBanner} data-testid="bots-no-key-banner">
          <span>🔑 LazyBot needs a Solari key to use cloud capabilities — set it in Settings → Solari.</span>
        </div>
      )}
    </div>
  );
}

const S = {
  container: {
    flex: 1, display: 'flex', overflow: 'hidden',
    background: 'var(--color-bg)',
  },
  leftRail: {
    width: 280, flexShrink: 0,
    borderRight: '1px solid var(--color-border)',
    overflow: 'hidden',
  },
  rightPanel: {
    flex: 1, overflow: 'auto',
  },
  detailRow: {
    display: 'flex', gap: 12, padding: 12, height: '100%', boxSizing: 'border-box' as const,
    alignItems: 'flex-start',
  },
  empty: {
    display: 'flex', flexDirection: 'column' as const,
    alignItems: 'center', justifyContent: 'center',
    height: '100%', gap: 16, color: 'var(--color-text-secondary)',
  },
  emptyIcon: { fontSize: 48 },
  emptyText: { fontSize: 16 },
  emptyBtn: {
    padding: '10px 20px', borderRadius: 8, cursor: 'pointer',
    background: 'rgba(124,92,255,0.15)', border: '1px solid rgba(124,92,255,0.3)',
    color: '#B8A9FF', fontSize: 14, fontWeight: 500,
  },
  keyBanner: {
    position: 'fixed' as const,
    top: 16,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 9990,
    padding: '10px 16px',
    borderRadius: 8,
    background: 'rgba(255,183,107,0.12)',
    border: '1px solid rgba(255,183,107,0.4)',
    color: '#FFB86B',
    fontSize: 13,
    fontWeight: 500,
    maxWidth: 'calc(100vw - 40px)',
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
};
