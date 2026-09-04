/* botRunModel.test.ts — which brain a LazyBot run gets, per rail readiness.
   Readiness helpers are mocked at their source modules (runtime.ts for the
   CLI/Pro checks, byokProviders.ts for the key check) so each case states
   exactly which rails the "user" has. */

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
    loadByokModel: vi.fn(() => ''),
  };
});

vi.mock('../lib/agents/cliAgentTurnStreamer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/cliAgentTurnStreamer')>();
  return {
    ...actual,
    resolveCliEngineMode: vi.fn(() => 'claude-code'),
  };
});

import { isManagedModelReady, isNativeModelReady } from '../lib/agents/runtime';
import { hasByokKey } from '../lib/models/byokProviders';
import { resolveCliEngineMode } from '../lib/agents/cliAgentTurnStreamer';
import { FREE_OPENROUTER_MODEL_ID, DEFAULT_OPENROUTER_MODEL_ID } from '../lib/models/openrouterCatalog';
import {
  applyTierHintWithinRail,
  classifyBotModelRail,
  firstReadyRailDefault,
  isExactBotModelId,
  resolveLazyBotRunModel,
} from '../lib/bots/botRunModel';

const managedReady = isManagedModelReady as unknown as ReturnType<typeof vi.fn>;
const nativeReady = isNativeModelReady as unknown as ReturnType<typeof vi.fn>;
const byokKey = hasByokKey as unknown as ReturnType<typeof vi.fn>;
const cliMode = resolveCliEngineMode as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  managedReady.mockReturnValue(false);
  nativeReady.mockReturnValue(false);
  byokKey.mockReturnValue(false);
  cliMode.mockReturnValue('claude-code');
});

describe('classifyBotModelRail', () => {
  it('maps an OpenRouter id to pro, a free-tier id to free, a Claude id to cli', () => {
    expect(classifyBotModelRail('anthropic/claude-sonnet-5')).toBe('pro');
    expect(classifyBotModelRail(FREE_OPENROUTER_MODEL_ID)).toBe('free');
    expect(classifyBotModelRail('claude-sonnet-5')).toBe('cli');
  });

  it('maps a BYOK catalog id to byok only when that provider key is set', () => {
    expect(classifyBotModelRail('deepseek-chat')).toBe('cli');
    byokKey.mockImplementation((p: string) => p === 'deepseek');
    expect(classifyBotModelRail('deepseek-chat')).toBe('byok');
  });

  it('treats an empty id as the codex CLI default only in codex mode', () => {
    expect(classifyBotModelRail('')).toBeUndefined();
    cliMode.mockReturnValue('codex');
    expect(classifyBotModelRail('')).toBe('cli');
  });
});

describe('resolveLazyBotRunModel', () => {
  it('honors the requested model when its rail is ready (no note)', () => {
    nativeReady.mockReturnValue(true);
    expect(resolveLazyBotRunModel('claude-sonnet-5', ['anthropic/claude-sonnet-5'])).toEqual({
      model: 'claude-sonnet-5',
      rail: 'cli',
      note: undefined,
    });
  });

  it('keeps a BYOK model when the key is present, regardless of CLI/Pro', () => {
    byokKey.mockImplementation((p: string) => p === 'deepseek');
    const r = resolveLazyBotRunModel('deepseek-chat', []);
    expect(r.rail).toBe('byok');
    expect(r.model).toBe('deepseek-chat');
  });

  it('falls through to the first READY fallback and explains the substitution', () => {
    managedReady.mockReturnValue(true);
    const r = resolveLazyBotRunModel('claude-haiku-4-5', ['anthropic/claude-sonnet-5']);
    expect(r).toMatchObject({ model: 'anthropic/claude-sonnet-5', rail: 'pro' });
    expect(r.note).toContain('claude-haiku-4-5');
    expect(r.note).toContain('anthropic/claude-sonnet-5');
  });

  it('never sends a bot to the CLI rail when no CLI is detected — picks the ready rail default', () => {
    managedReady.mockReturnValue(true);
    const r = resolveLazyBotRunModel(undefined, ['claude-haiku-4-5']);
    expect(r).toMatchObject({ model: DEFAULT_OPENROUTER_MODEL_ID, rail: 'pro' });
    expect(r.note).toContain('CLI');
  });

  it('prefers a BYOK key over CLI and Pro when nothing requested is runnable', () => {
    byokKey.mockImplementation((p: string) => p === 'deepseek');
    nativeReady.mockReturnValue(true);
    managedReady.mockReturnValue(true);
    const r = resolveLazyBotRunModel('anthropic/claude-opus-5', []);
    // Pro IS ready here, so the requested Pro model wins outright.
    expect(r.rail).toBe('pro');
    managedReady.mockReturnValue(false);
    const r2 = resolveLazyBotRunModel('anthropic/claude-opus-5', []);
    expect(r2).toMatchObject({ model: 'deepseek-chat', rail: 'byok' });
  });

  it('uses the codex CLI default (empty id) when codex is the CLI tool', () => {
    cliMode.mockReturnValue('codex');
    nativeReady.mockReturnValue(true);
    expect(resolveLazyBotRunModel(undefined, [''])).toMatchObject({ model: '', rail: 'cli' });
  });

  it('lands on the free tier with an honest note when no rail is usable', () => {
    const r = resolveLazyBotRunModel('claude-sonnet-5', ['anthropic/claude-sonnet-5']);
    expect(r).toMatchObject({ model: FREE_OPENROUTER_MODEL_ID, rail: 'free' });
    expect(r.note).toContain('CLI');
    expect(r.note).toContain(FREE_OPENROUTER_MODEL_ID);
  });

  it('accepts a requested free-tier model even with nothing else ready', () => {
    expect(resolveLazyBotRunModel(FREE_OPENROUTER_MODEL_ID, [])).toEqual({
      model: FREE_OPENROUTER_MODEL_ID,
      rail: 'free',
      note: undefined,
    });
  });

  // The live QA regression: the manager (on a BYOK DeepSeek) said
  // model:"haiku"; "haiku" classified as CLI, the CLI binary was detected,
  // so the bot went to a CLI whose org had disabled access and died. A bare
  // tier word must stay INSIDE the rail the user actually uses.
  it('treats a bare tier word as a hint within the manager rail, never as a rail switch', () => {
    byokKey.mockImplementation((p: string) => p === 'deepseek');
    nativeReady.mockReturnValue(true);
    const r = resolveLazyBotRunModel('haiku', ['deepseek-chat']);
    expect(r).toMatchObject({ model: 'deepseek-chat', rail: 'byok' });
    expect(r.note).toContain('haiku');
  });

  it('applies a tier hint inside the Pro catalog when the manager is on Pro', () => {
    managedReady.mockReturnValue(true);
    nativeReady.mockReturnValue(true);
    const r = resolveLazyBotRunModel('haiku', ['anthropic/claude-sonnet-5']);
    expect(r).toMatchObject({ model: 'anthropic/claude-haiku-4.5', rail: 'pro' });
  });

  it('applies a tier hint inside the native catalog when the manager is on the CLI', () => {
    nativeReady.mockReturnValue(true);
    const r = resolveLazyBotRunModel('opus', ['claude-sonnet-5']);
    expect(r).toMatchObject({ model: 'claude-opus-5', rail: 'cli' });
  });

  it('still lets a tier hint reach the CLI when it is the only ready rail', () => {
    nativeReady.mockReturnValue(true);
    expect(resolveLazyBotRunModel('haiku', ['anthropic/claude-sonnet-5'])).toMatchObject({ model: 'haiku', rail: 'cli' });
  });
});

describe('isExactBotModelId / applyTierHintWithinRail', () => {
  it('knows exact ids from every catalog and rejects bare tier words', () => {
    expect(isExactBotModelId('anthropic/claude-sonnet-5')).toBe(true);
    expect(isExactBotModelId('claude-haiku-4-5')).toBe(true);
    expect(isExactBotModelId('deepseek-chat')).toBe(true);
    expect(isExactBotModelId('haiku')).toBe(false);
    expect(isExactBotModelId('Claude Sonnet 5')).toBe(false);
    expect(isExactBotModelId(undefined)).toBe(false);
  });

  it('leaves BYOK and free models untouched and ignores non-tier hints', () => {
    expect(applyTierHintWithinRail('haiku', { model: 'deepseek-chat', rail: 'byok' })).toBe('deepseek-chat');
    expect(applyTierHintWithinRail('haiku', { model: FREE_OPENROUTER_MODEL_ID, rail: 'free' })).toBe(FREE_OPENROUTER_MODEL_ID);
    expect(applyTierHintWithinRail('fast please', { model: 'anthropic/claude-sonnet-5', rail: 'pro' })).toBe('anthropic/claude-sonnet-5');
  });
});

describe('firstReadyRailDefault (brain failover source)', () => {
  it('skips the excluded rail and keeps the BYOK → CLI → Pro → free order', () => {
    byokKey.mockImplementation((p: string) => p === 'deepseek');
    nativeReady.mockReturnValue(true);
    managedReady.mockReturnValue(true);
    expect(firstReadyRailDefault()).toMatchObject({ rail: 'byok', model: 'deepseek-chat' });
    expect(firstReadyRailDefault('byok')).toMatchObject({ rail: 'cli' });
    nativeReady.mockReturnValue(false);
    expect(firstReadyRailDefault('byok')).toMatchObject({ rail: 'pro', model: DEFAULT_OPENROUTER_MODEL_ID });
    byokKey.mockReturnValue(false);
    expect(firstReadyRailDefault('cli')).toMatchObject({ rail: 'pro' });
  });

  it('falls to the free tier when nothing else is ready, and to nothing when Pro itself failed', () => {
    expect(firstReadyRailDefault('cli')).toMatchObject({ rail: 'free', model: FREE_OPENROUTER_MODEL_ID });
    // Pro and free share the ai-proxy: if Pro just refused, free would too.
    expect(firstReadyRailDefault('pro')).toBeUndefined();
    expect(firstReadyRailDefault('free')).toBeUndefined();
  });
});
