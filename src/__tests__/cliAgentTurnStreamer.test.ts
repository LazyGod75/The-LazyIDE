/* cliAgentTurnStreamer.test.ts — the CLI subscription as a TEXT backend for
   the managed ReAct loop (LazyBot brain on the CLI rail). */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/models/claudeCodeProvider', () => ({
  streamClaudeCodeTurn: vi.fn(),
}));

vi.mock('../lib/models/cliBackendProvider', () => ({
  cliBackendProvider: vi.fn(),
}));

vi.mock('../lib/models/accessSettings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/accessSettings')>();
  return { ...actual, loadAccessSettings: vi.fn(() => ({ accessMode: 'cli', cliTool: 'claude' })) };
});

import { streamClaudeCodeTurn } from '../lib/models/claudeCodeProvider';
import { cliBackendProvider } from '../lib/models/cliBackendProvider';
import { loadAccessSettings } from '../lib/models/accessSettings';
import { ALL_MODELS } from '../lib/models/registry';
import {
  createCliAgentTurnStreamer,
  resolveCliEngineMode,
  toNativeCliModelId,
} from '../lib/agents/cliAgentTurnStreamer';

const mockedClaude = streamClaudeCodeTurn as unknown as ReturnType<typeof vi.fn>;
const mockedCliProvider = cliBackendProvider as unknown as ReturnType<typeof vi.fn>;
const mockedSettings = loadAccessSettings as unknown as ReturnType<typeof vi.fn>;

async function* fakeStream(...chunks: string[]): AsyncIterable<string> {
  for (const c of chunks) yield c;
}

async function collect(it: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const c of it) out += c;
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedSettings.mockReturnValue({ accessMode: 'cli', cliTool: 'claude' });
});

describe('toNativeCliModelId', () => {
  it('maps a tier word or a picker label to the registry id', () => {
    const sonnet = ALL_MODELS.find((m) => m.id.includes('sonnet'))!.id;
    expect(toNativeCliModelId('sonnet')).toBe(sonnet);
    expect(toNativeCliModelId('Claude Sonnet 5')).toBe(sonnet);
  });

  it('keeps a real native id and strips the vendor from an OpenRouter id', () => {
    expect(toNativeCliModelId(ALL_MODELS[0]!.id)).toBe(ALL_MODELS[0]!.id);
    expect(toNativeCliModelId('openai/gpt-5.4-mini')).toBe('gpt-5-4-mini');
  });

  it('passes an empty id through (codex "use your own default")', () => {
    expect(toNativeCliModelId('')).toBe('');
  });
});

describe('resolveCliEngineMode', () => {
  it('follows the Settings cliTool, defaulting to claude', () => {
    expect(resolveCliEngineMode()).toBe('claude-code');
    mockedSettings.mockReturnValue({ accessMode: 'pro', cliTool: 'codex' });
    expect(resolveCliEngineMode()).toBe('codex');
    mockedSettings.mockReturnValue({ accessMode: 'pro' });
    expect(resolveCliEngineMode()).toBe('claude-code');
  });
});

describe('createCliAgentTurnStreamer', () => {
  it('claude-code: streams one turn through streamClaudeCodeTurn with the normalized model', async () => {
    mockedClaude.mockReturnValue(fakeStream('THOUGHT: x\n', 'ACTION: FINAL'));
    const turn = createCliAgentTurnStreamer('claude-code');
    const ctrl = new AbortController();
    const text = await collect(turn({
      messages: [{ role: 'user', content: 'go' }],
      system: 'SYS',
      model: 'Claude Sonnet 5',
      signal: ctrl.signal,
    }));
    expect(text).toBe('THOUGHT: x\nACTION: FINAL');
    expect(mockedClaude).toHaveBeenCalledTimes(1);
    const arg = mockedClaude.mock.calls[0]![0] as { model: string; system: string; signal: AbortSignal };
    expect(arg.model).toBe(ALL_MODELS.find((m) => m.id.includes('sonnet'))!.id);
    expect(arg.system).toBe('SYS');
    expect(arg.signal).toBe(ctrl.signal);
    expect(mockedCliProvider).not.toHaveBeenCalled();
  });

  it('codex: routes through cliBackendProvider("codex") with the system prompt as rulesContext', async () => {
    const streamChat = vi.fn((_req: {
      messages: Array<{ role: string; content: string }>;
      model: { id: string };
      mode: string;
      rulesContext: string;
    }) => fakeStream('FINAL: done'));
    mockedCliProvider.mockReturnValue({ streamChat });
    const turn = createCliAgentTurnStreamer('codex');
    const text = await collect(turn({
      messages: [
        { role: 'user', content: 'task' },
        { role: 'assistant', content: 'ACTION: cloud_browser_open' },
        { role: 'user', content: 'Observation: ok' },
      ],
      system: 'BOT SYSTEM',
      model: '',
    }));
    expect(text).toBe('FINAL: done');
    expect(mockedCliProvider).toHaveBeenCalledWith('codex');
    const req = streamChat.mock.calls[0]![0];
    expect(req.rulesContext).toBe('BOT SYSTEM');
    expect(req.mode).toBe('ask');
    expect(req.model.id).toBe('');
    expect(req.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(mockedClaude).not.toHaveBeenCalled();
  });
});
