/* BotBootService - wires Solari orphan sweep and bot routine scheduler
   to app boot. Mounts once at app root, INSIDE AgentsStoreProvider (see
   AppShell.tsx), runs the sweep fire-and-forget, and starts the bot
   scheduler for due routines.

   No UI - returns null. Just side effects on mount.
*/

import { useEffect, useRef } from 'react';
import { bootSweepOrphans } from '../../lib/bots/sweepBoot';
import {
  startBotScheduler,
  startWebRoutineCatcher,
  WEB_ROUTINES_DISABLED_MESSAGE,
  type BotSchedulerHandle,
} from '../../lib/bots/botScheduler';
import { drainQueuedRoutineFires } from '../../lib/bots/botRoutineQueue';
import { getBot } from '../../lib/bots/botStorage';
import { launchBotRun, restoreBotRuntime, toBotNewMissionInput } from '../../lib/bots/botEngine';
import { registerBotToolHandlers, setBotToolContext } from '../../lib/bots/botToolHandlers';
import { setBotRuntimeRoot } from '../../lib/bots/botRuntimeStore';
import { resolveLazyBotRunModel } from '../../lib/bots/botRunModel';
import { getCachedProjectRoot } from '../../lib/agents/projectRootCache';
import { getPlatform } from '../../lib/platform';
import { getActiveModel } from '../../lib/models';
import { on } from '../../lib/bus';
import { useToast } from '../ui';
import { useI18n } from '../../i18n';
import { useAgentsStoreActions } from './agentsStore';

async function waitForProjectRoot(maxMs = 9000): Promise<string | null> {
  const steps = Math.ceil(maxMs / 300);
  for (let i = 0; i < steps && !getCachedProjectRoot(); i++) {
    await new Promise((r) => setTimeout(r, 300));
  }
  return getCachedProjectRoot();
}

export function BotBootService() {
  const schedulerRef = useRef<BotSchedulerHandle | null>(null);
  const { addMission } = useAgentsStoreActions();
  const { toast } = useToast();
  const { t } = useI18n();

  useEffect(() => {
    registerBotToolHandlers();
    setBotToolContext({
      createMission: async (input) => addMission(toBotNewMissionInput(input)),
      defaultModel: () => resolveLazyBotRunModel(undefined, [getActiveModel().id]).model,
    });
    void bootSweepOrphans();
    void import('../../lib/solari/solariClient').then(({ hydrateSolariCdpProxy }) => {
      void hydrateSolariCdpProxy();
    });
    void (async () => {
      const root = await waitForProjectRoot();
      if (root) setBotRuntimeRoot(root);
      await restoreBotRuntime();
    })();

    const resolveModel = () => {
      let managerModel: string | undefined;
      try {
        managerModel = localStorage.getItem('lazy.manager.model') ?? undefined;
      } catch {
        managerModel = undefined;
      }
      return resolveLazyBotRunModel(undefined, [managerModel, getActiveModel().id]).model;
    };

    const createMission = async (input: Parameters<typeof toBotNewMissionInput>[0]) =>
      addMission(toBotNewMissionInput(input));

    // C76 — surface cron failures to the user (toast), not console only.
    const offFail = on('bot:routineFailed', (p) => {
      const name = p.routineName || p.botName || 'routine';
      toast(
        t('agents.notification.routineFailed', { name, error: p.error.slice(0, 120) }),
        'error',
        6000,
      );
    });

    const platform = getPlatform();
    if (platform.name === 'tauri') {
      schedulerRef.current = startBotScheduler({
        createMission,
        defaultModelId: resolveModel,
        onRoutineFired: (bot, routine) => {
          toast(
            t('agents.notification.botRoutineFired', { bot: bot.name, routine: routine.name }),
            'info',
            4000,
          );
        },
      });

      // C67 — drain web→desktop queue from a prior browser session.
      void (async () => {
        const queued = drainQueuedRoutineFires();
        for (const entry of queued) {
          const bot = await getBot(entry.botId);
          if (!bot || !bot.enabled) continue;
          try {
            await launchBotRun(bot, entry.task, {
              createMission,
              model: resolveModel(),
              routineId: entry.routineId,
            });
            toast(
              t('agents.notification.botRoutineResumed', {
                bot: entry.botName || bot.name,
                routine: entry.routineName,
              }),
              'info',
              5000,
            );
          } catch (err) {
            console.error('[BotBootService] queued routine resume failed:', err);
          }
        }
      })();
    } else {
      // C67 — web builds: clear message + persist due routines for Tauri.
      console.info(`[BotBootService] ${WEB_ROUTINES_DISABLED_MESSAGE}`);
      schedulerRef.current = startWebRoutineCatcher();
    }

    return () => {
      offFail();
      schedulerRef.current?.stop();
      schedulerRef.current = null;
    };
  }, [addMission, toast, t]);

  return null;
}
