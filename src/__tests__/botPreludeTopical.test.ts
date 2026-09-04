import { beforeEach, describe, expect, it, vi } from 'vitest';

const recall = vi.fn();
const startupContext = vi.fn();
const federatedRecall = vi.fn();
const loadHarnessSessionBlock = vi.fn();
const injectSkills = vi.fn();
const loadToolProfiles = vi.fn();
const loadBotTopicalContext = vi.fn();

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
vi.mock('../lib/bots/botTopicalRecall', () => ({
  loadBotTopicalContext: (...args: unknown[]) => loadBotTopicalContext(...args),
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
  loadBotTopicalContext.mockResolvedValue('Bot topical: last scrape of example.com found title Example Domain');
});

describe("prepareManagedMission — prelude 'bot' (D93)", () => {
  it("'bot' skips harness/skills/overlays and injects bot-scoped topical recall", async () => {
    const prep = await prepareManagedMission({
      ...baseOpts,
      prelude: 'bot',
      botId: 'bot_1',
    });

    expect(loadHarnessSessionBlock).not.toHaveBeenCalled();
    expect(injectSkills).not.toHaveBeenCalled();
    expect(loadToolProfiles).not.toHaveBeenCalled();
    expect(startupContext).not.toHaveBeenCalled();
    expect(recall).not.toHaveBeenCalled();
    expect(federatedRecall).not.toHaveBeenCalled();
    expect(loadBotTopicalContext).toHaveBeenCalledWith('bot_1', baseOpts.missionTask);

    expect(prep.fullTaskPrompt).toContain('Bot topical:');
    expect(prep.fullTaskPrompt).toContain(baseOpts.missionTask);
    expect(prep.effectiveSystemPrompt).toContain('You are SolariTest');
  });

  it("'lean' still skips everything including bot topical", async () => {
    await prepareManagedMission({ ...baseOpts, prelude: 'lean', botId: 'bot_1' });
    expect(loadBotTopicalContext).not.toHaveBeenCalled();
  });
});
