import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
    },
  },
}));

vi.mock('../lib/models/byokProviders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/byokProviders')>();
  return {
    ...actual,
    hasByokKey: vi.fn(),
  };
});

import { supabase } from '../lib/supabase/client';
import { hasByokKey } from '../lib/models/byokProviders';
import { classifyAgentRail, gateAgentSession } from '../lib/agents/agentSessionGate';
import { FREE_OPENROUTER_MODEL_ID } from '../lib/models/openrouterCatalog';

const getSession = vi.mocked(supabase.auth.getSession);

describe('classifyAgentRail', () => {
  it('routes a free OpenRouter id to the free rail', () => {
    expect(classifyAgentRail(FREE_OPENROUTER_MODEL_ID, 'mock')).toBe('free');
  });

  it('routes a paid OpenRouter id to Pro', () => {
    expect(classifyAgentRail('anthropic/claude-sonnet-5', 'managed')).toBe('pro');
  });

  it('routes a native Claude id to CLI', () => {
    expect(classifyAgentRail('claude-sonnet-5', 'claude-code')).toBe('cli');
  });
});

describe('gateAgentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockResolvedValue({ data: { session: null } } as never);
  });

  it('blocks the free rail without a JWT', async () => {
    const result = await gateAgentSession({ model: FREE_OPENROUTER_MODEL_ID, mode: 'mock' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rail).toBe('free');
      expect(result.reasonKey).toBe('agents.sessionGate.needSession');
    }
  });

  it('allows the free rail when a session exists', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'jwt' } } } as never);
    const result = await gateAgentSession({ model: FREE_OPENROUTER_MODEL_ID, mode: 'mock' });
    expect(result).toEqual({ ok: true, rail: 'free' });
  });

  it('blocks Pro when the plan is not ready even with a session', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'jwt' } } } as never);
    const result = await gateAgentSession({
      model: 'anthropic/claude-sonnet-5',
      mode: 'managed',
      proReady: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rail).toBe('pro');
  });

  it('blocks BYOK when the provider key is missing', async () => {
    vi.mocked(hasByokKey).mockReturnValue(false);
    const result = await gateAgentSession({ model: 'deepseek-chat', mode: 'live-key' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonKey).toBe('agents.sessionGate.needByok');
  });

  it('allows CLI without a JWT when the binary is ready', async () => {
    const result = await gateAgentSession({
      model: 'claude-sonnet-5',
      mode: 'claude-code',
      cliReady: true,
    });
    expect(result).toEqual({ ok: true, rail: 'cli' });
    expect(getSession).not.toHaveBeenCalled();
  });

  it('blocks CLI when the binary is missing', async () => {
    const result = await gateAgentSession({
      model: 'claude-sonnet-5',
      mode: 'claude-code',
      cliReady: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasonKey).toBe('agents.sessionGate.needCli');
  });
});
