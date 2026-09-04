/**
 * D87 — optional/light manager recall: explicit brain_query nudge by default,
 * ambient search only when opted in, never on trivial turns.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return { ...actual, getProviderMode: vi.fn() };
});
vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(() => ({
    brain: { recall: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }) },
  })),
}));

import {
  buildExplicitBrainQueryNudge,
  isMemorySeekingUtterance,
  isTrivialManagerUtterance,
  maybeLightAmbientRecall,
} from '../lib/agents/managerAmbientRecall';
import { buildManagerDynamicContext, type ManagerContext } from '../lib/agents/managerEngine';

const baseCtx: ManagerContext = { agents: [], missions: [] };

describe('isTrivialManagerUtterance', () => {
  it('skips one-word acknowledgements', () => {
    expect(isTrivialManagerUtterance('ok')).toBe(true);
    expect(isTrivialManagerUtterance('merci')).toBe(true);
    expect(isTrivialManagerUtterance('thanks!')).toBe(true);
  });

  it('keeps real questions', () => {
    expect(isTrivialManagerUtterance('why did we pick JWT last time?')).toBe(false);
  });
});

describe('isMemorySeekingUtterance', () => {
  it('detects recall-shaped questions', () => {
    expect(isMemorySeekingUtterance('why did we pick JWT last time?')).toBe(true);
    expect(isMemorySeekingUtterance('souviens-toi de la décision auth')).toBe(true);
  });

  it('does not flag a fresh implementation ask', () => {
    expect(isMemorySeekingUtterance('add a login button on the home page')).toBe(false);
  });
});

describe('buildExplicitBrainQueryNudge', () => {
  it('nudges when the user asks for memory and no grounded result is present', () => {
    const nudge = buildExplicitBrainQueryNudge({
      lastUserMessage: 'what was the last auth decision?',
    });
    expect(nudge).toMatch(/brain_query/);
    expect(nudge).not.toMatch(/already grounded/i);
  });

  it('stays silent when a brain_query result is already grounded', () => {
    expect(buildExplicitBrainQueryNudge({
      lastUserMessage: 'what was the last auth decision?',
      brainQueryResult: '[#n1] JWT is the session strategy',
    })).toBeUndefined();
  });

  it('stays silent on trivial turns', () => {
    expect(buildExplicitBrainQueryNudge({ lastUserMessage: 'ok' })).toBeUndefined();
  });
});

describe('maybeLightAmbientRecall — perf filet', () => {
  it('does not call recall when disabled (default)', async () => {
    const recall = vi.fn();
    const text = await maybeLightAmbientRecall({
      query: 'what was the last auth decision?',
      recall,
    });
    expect(text).toBeUndefined();
    expect(recall).not.toHaveBeenCalled();
  });

  it('does not call recall on trivial text even when enabled', async () => {
    const recall = vi.fn();
    await maybeLightAmbientRecall({ query: 'ok', enabled: true, recall });
    expect(recall).not.toHaveBeenCalled();
  });

  it('returns bounded recall text when enabled and memory-seeking', async () => {
    const recall = vi.fn().mockResolvedValue('[#n1] JWT');
    const text = await maybeLightAmbientRecall({
      query: 'what was the last auth decision?',
      enabled: true,
      recall,
    });
    expect(recall).toHaveBeenCalledOnce();
    expect(text).toBe('[#n1] JWT');
  });

  it('times out instead of blocking the turn', async () => {
    const recall = vi.fn().mockImplementation(
      () => new Promise<string>((resolve) => { setTimeout(() => resolve('late'), 5_000); }),
    );
    const text = await maybeLightAmbientRecall({
      query: 'what was the last auth decision?',
      enabled: true,
      timeoutMs: 20,
      recall,
    });
    expect(text).toBeUndefined();
  });
});

describe('buildManagerDynamicContext — D87 nudge', () => {
  it('injects an explicit brain_query nudge for a memory-seeking turn', () => {
    const dynamic = buildManagerDynamicContext({
      ...baseCtx,
      lastUserMessage: 'what was the last auth decision in this repo?',
    });
    expect(dynamic).toContain('Brain recall nudge');
    expect(dynamic).toContain('brain_query');
  });

  it('does not inject the nudge when grounded recall is already present', () => {
    const dynamic = buildManagerDynamicContext({
      ...baseCtx,
      lastUserMessage: 'what was the last auth decision in this repo?',
      brainQueryResult: '[#n1] JWT',
    });
    expect(dynamic).not.toContain('Brain recall nudge');
  });
});
