/* prepareManagedMission — 'lean' prelude (LazyBots).

   Measured live 2026-09-02 (10k-note brain): the full prelude cost ~100 s
   before a LazyBot's first model turn — two cold `lazybrain query` spawns
   (harness rules + learned tool overlays) each hitting their 30 s ceiling,
   plus recall / startup context / skills. A bot is a Solari cloud computer:
   none of that repo prelude applies, so runLazyBotMission asks for 'lean'
   and the prelude must not touch the brain at all. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const recall = vi.fn();
const startupContext = vi.fn();
const federatedRecall = vi.fn();
const loadHarnessSessionBlock = vi.fn();
const injectSkills = vi.fn();
const loadToolProfiles = vi.fn();

vi.mock('../lib/platform/index', () => ({
  getPlatform: () => ({
    brain: {
      recall: (...args: unknown[]) => recall(...args),
      startupContext: (...args: unknown[]) => startupContext(...args),
    },
  }),
}));
vi.mock('../lib/brain/federatedRecall', () => ({
  federatedRecall: (...args: unknown[]) => federatedRecall(...args),
  buildCrossProjectContext: () => '',
}));
vi.mock('../lib/agents/harnessRules', () => ({
  loadHarnessSessionBlock: (...args: unknown[]) => loadHarnessSessionBlock(...args),
}));
vi.mock('../lib/agents/skillInjection', () => ({
  injectSkills: (...args: unknown[]) => injectSkills(...args),
}));
vi.mock('../lib/agents/learnedToolProfiles', () => ({
  loadToolProfiles: (...args: unknown[]) => loadToolProfiles(...args),
}));

import { prepareManagedMission } from '../lib/agents/managedAgentPrepare';

const baseOpts = {
  missionId: 'M1',
  missionTitle: 'SolariTest: read example.com',
  missionTask: 'Open https://example.com and report the exact page title',
  agentDisplayName: 'SolariTest',
  agentSystemPrompt: 'You are SolariTest, a cloud browser bot.',
  worktreePath: 'C:\\repo',
  projectId: 'p1',
  model: 'deepseek-chat',
  policy: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  recall.mockResolvedValue({ hits: [] });
  startupContext.mockResolvedValue('');
  federatedRecall.mockResolvedValue({ hits: [] });
  loadHarnessSessionBlock.mockResolvedValue('');
  injectSkills.mockResolvedValue({ text: '' });
  loadToolProfiles.mockResolvedValue(new Map());
});

describe('prepareManagedMission — prelude depth', () => {
  it("'lean' never touches the brain, harness, skills or tool overlays and keeps persona + task", async () => {
    const prep = await prepareManagedMission({ ...baseOpts, prelude: 'lean' });

    expect(recall).not.toHaveBeenCalled();
    expect(federatedRecall).not.toHaveBeenCalled();
    expect(startupContext).not.toHaveBeenCalled();
    expect(loadHarnessSessionBlock).not.toHaveBeenCalled();
    expect(injectSkills).not.toHaveBeenCalled();
    expect(loadToolProfiles).not.toHaveBeenCalled();

    expect(prep.coreTask).toBe(baseOpts.missionTask);
    expect(prep.fullTaskPrompt).toBe(`Task: ${baseOpts.missionTask}\nWorking directory: C:\\repo`);
    expect(prep.effectiveSystemPrompt).toContain('You are SolariTest, a cloud browser bot.');
  });

  it("'full' (default, local code agents) still runs the whole repo prelude", async () => {
    await prepareManagedMission(baseOpts);

    expect(recall).toHaveBeenCalledTimes(1);
    expect(federatedRecall).toHaveBeenCalledTimes(1);
    expect(startupContext).toHaveBeenCalledWith('C:\\repo');
    expect(loadHarnessSessionBlock).toHaveBeenCalledTimes(1);
    expect(injectSkills).toHaveBeenCalledWith(baseOpts.missionTask);
    expect(loadToolProfiles).toHaveBeenCalledTimes(1);
  });
});
