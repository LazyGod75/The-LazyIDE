/* automatedTurnModel.test.ts — background manager turns (approval-queue
   resume, wake-ups, loop notices) stay on the rail the user's chat model
   actually runs on, cheap tier applied within that rail. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    isManagedModelReady: vi.fn(() => false),
    isNativeModelReady: vi.fn(() => false),
  };
});

vi.mock('../lib/models/byokProviders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/byokProviders')>();
  return {
    ...actual,
    hasByokKey: vi.fn(() => false),
  };
});

vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return {
    ...actual,
    getProviderMode: vi.fn(() => 'cli'),
  };
});

import { isManagedModelReady, isNativeModelReady } from '../lib/agents/runtime';
import { hasByokKey } from '../lib/models/byokProviders';
import { getProviderMode } from '../lib/models/index';
import { FREE_OPENROUTER_MODEL_ID } from '../lib/models/openrouterCatalog';
import { resolveAutomatedTurnModel } from '../lib/agents/automatedTurnModel';

const managedReady = isManagedModelReady as unknown as ReturnType<typeof vi.fn>;
const nativeReady = isNativeModelReady as unknown as ReturnType<typeof vi.fn>;
const byokKey = hasByokKey as unknown as ReturnType<typeof vi.fn>;
const providerMode = getProviderMode as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  managedReady.mockReturnValue(false);
  nativeReady.mockReturnValue(false);
  byokKey.mockReturnValue(false);
  providerMode.mockReturnValue('cli');
});

describe('resolveAutomatedTurnModel', () => {
  // Live QA 2026-09-02: provider mode "cli" + a chat running on BYOK DeepSeek
  // → every approval resume hit the (unentitled) Claude CLI and the chat
  // filled with "Your organization has disabled Claude subscription access".
  it('keeps a BYOK chat model as-is instead of the provider-mode CLI default', () => {
    byokKey.mockImplementation((p: string) => p === 'deepseek');
    nativeReady.mockReturnValue(true);
    expect(resolveAutomatedTurnModel('deepseek-chat')).toBe('deepseek-chat');
  });

  it('applies the synthesis tier within the CLI rail when the chat runs on the CLI', () => {
    nativeReady.mockReturnValue(true);
    expect(resolveAutomatedTurnModel('claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('applies the synthesis tier within the Pro catalog when the chat runs on Pro', () => {
    managedReady.mockReturnValue(true);
    expect(resolveAutomatedTurnModel('anthropic/claude-opus-5')).toBe('anthropic/claude-sonnet-5');
  });

  it('leaves the free tier untouched', () => {
    expect(resolveAutomatedTurnModel(FREE_OPENROUTER_MODEL_ID)).toBe(FREE_OPENROUTER_MODEL_ID);
  });

  it('falls back to the provider-mode default when the chat model rail is not ready or unknown', () => {
    // CLI chat model but no CLI detected → provider-mode ("cli") default.
    expect(resolveAutomatedTurnModel('claude-sonnet-5')).toBe('claude-sonnet-5');
    providerMode.mockReturnValue('managed');
    expect(resolveAutomatedTurnModel(undefined)).toBe('anthropic/claude-sonnet-5');
    expect(resolveAutomatedTurnModel('')).toBe('anthropic/claude-sonnet-5');
  });
});
