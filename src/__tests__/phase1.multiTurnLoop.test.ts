/**
 * Phase 1 test: multi-turn retry loop in runManagerTurn.
 *
 * Mocks the LLM to return an invalid action on the first call and a valid
 * action on the second call, then asserts the function retries and returns
 * the valid actions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return {
    ...actual,
    getProviderMode: vi.fn(),
  };
});

vi.mock('../lib/models/claudeCodeProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/claudeCodeProvider')>();
  return {
    ...actual,
    streamClaudeCodeTurn: vi.fn(),
  };
});

vi.mock('../lib/models/managedProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/managedProvider')>();
  return {
    ...actual,
    streamManagedAgentTurn: vi.fn(),
  };
});

vi.mock('../lib/models/cliBackendProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/cliBackendProvider')>();
  return {
    ...actual,
    cliBackendProvider: vi.fn(),
  };
});

vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    isManagedModelReady: vi.fn(actual.isManagedModelReady),
    isNativeModelReady: vi.fn(actual.isNativeModelReady),
  };
});

vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(() => ({
    brain: {
      recall: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }),
    },
  })),
}));

import { runManagerTurn } from '../lib/agents/managerEngine';
import type { ManagerMessage } from '../lib/agents/types';
import { getProviderMode } from '../lib/models/index';
import { streamClaudeCodeTurn } from '../lib/models/claudeCodeProvider';

const mockedGetProviderMode = getProviderMode as ReturnType<typeof vi.fn>;
const mockedStreamClaudeCodeTurn = streamClaudeCodeTurn as ReturnType<typeof vi.fn>;

async function* fakeStream(...chunks: string[]): AsyncIterable<string> {
  for (const chunk of chunks) yield chunk;
}

function makeMessages(): ManagerMessage[] {
  return [
    {
      id: 'm1',
      role: 'user',
      content: 'lance @reviewer sur le module auth',
      timestamp: new Date().toISOString(),
    },
  ];
}

describe('runManagerTurn — multi-turn retry loop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetProviderMode.mockReturnValue('claude-code');
  });

  it('retries when the first response has invalid actions and returns valid actions on the second attempt', async () => {
    const invalidResponse = [
      'Here is my plan.',
      '<lazy_actions>',
      JSON.stringify([{ type: 'launch_mission' }]),
      '</lazy_actions>',
    ].join('\n');

    const validResponse = [
      'Corrected plan.',
      '<lazy_actions>',
      JSON.stringify([{ type: 'launch_mission', task: 'review auth module' }]),
      '</lazy_actions>',
    ].join('\n');

    let callCount = 0;
    mockedStreamClaudeCodeTurn.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return fakeStream(invalidResponse);
      return fakeStream(validResponse);
    });

    const result = await runManagerTurn({
      messages: makeMessages(),
      context: { agents: [], missions: [] },
      model: 'sonnet',
      maxTurns: 3,
    });

    expect(mockedStreamClaudeCodeTurn).toHaveBeenCalledTimes(2);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].type).toBe('launch_mission');
    expect(result.responseText).toContain('Corrected plan.');
  });

  it('does not retry when actions are valid on the first attempt', async () => {
    const validResponse = [
      'Plan ready.',
      '<lazy_actions>',
      JSON.stringify([{ type: 'info', message: 'all good' }]),
      '</lazy_actions>',
    ].join('\n');

    mockedStreamClaudeCodeTurn.mockImplementation(() => fakeStream(validResponse));

    const result = await runManagerTurn({
      messages: makeMessages(),
      context: { agents: [], missions: [] },
      model: 'sonnet',
    });

    expect(mockedStreamClaudeCodeTurn).toHaveBeenCalledTimes(1);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].type).toBe('info');
  });

  it('does not retry when no actions are produced', async () => {
    const noActionsResponse = 'I need more information before I can act.';

    mockedStreamClaudeCodeTurn.mockImplementation(() => fakeStream(noActionsResponse));

    const result = await runManagerTurn({
      // Non-action user request: the PROMISE-STALL nudge guard only fires for
      // a clear user ACTION request answered with zero actions — a plain
      // informational request must still resolve after exactly one call.
      messages: [
        { id: 'm1', role: 'user', content: 'What is the current project status?', timestamp: new Date().toISOString() },
      ],
      context: { agents: [], missions: [] },
      model: 'sonnet',
    });

    expect(mockedStreamClaudeCodeTurn).toHaveBeenCalledTimes(1);
    expect(result.actions).toHaveLength(0);
    expect(result.responseText).toContain('I need more information');
  });

  it('stops retrying after maxTurns and returns the last (still invalid) result', async () => {
    const invalidResponse = [
      'Bad plan.',
      '<lazy_actions>',
      JSON.stringify([{ type: 'launch_mission' }]),
      '</lazy_actions>',
    ].join('\n');

    mockedStreamClaudeCodeTurn.mockImplementation(() => fakeStream(invalidResponse));

    const result = await runManagerTurn({
      messages: makeMessages(),
      context: { agents: [], missions: [] },
      model: 'sonnet',
      maxTurns: 2,
    });

    expect(mockedStreamClaudeCodeTurn).toHaveBeenCalledTimes(2);
    expect(result.actions).toHaveLength(0);
    expect(result.rawResponse).toContain('Bad plan.');
  });
});
