/**
 * D92 — federated (cross-project) recall visible to the manager, read-only.
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
  looksLikeCrossProjectQuery,
  formatManagerFederatedDigest,
  maybeFederatedRecallForManager,
} from '../lib/agents/managerFederatedRecall';
import { buildManagerDynamicContext, type ManagerContext } from '../lib/agents/managerEngine';
import type { FederatedRecallResult } from '../lib/brain/federatedRecall';

const baseCtx: ManagerContext = { agents: [], missions: [] };

describe('looksLikeCrossProjectQuery', () => {
  it('detects an explicit other-project ask', () => {
    expect(looksLikeCrossProjectQuery('how did we do auth in the other project?')).toBe(true);
    expect(looksLikeCrossProjectQuery('reprends ça depuis l\'autre projet')).toBe(true);
  });

  it('does not treat a local question as federated', () => {
    expect(looksLikeCrossProjectQuery('add a login button')).toBe(false);
    expect(looksLikeCrossProjectQuery('ok')).toBe(false);
  });
});

describe('formatManagerFederatedDigest', () => {
  it('labels provenance and stays read-only', () => {
    const result: FederatedRecallResult = {
      hits: [{
        id: 'n9',
        title: 'JWT',
        snippet: 'other app uses JWT',
        score: 0.9,
        sourceProject: 'other-app',
        brainId: 'other-app',
        brainPath: 'other-app',
      }],
      text: '[#n9] (from other-app) JWT: other app uses JWT',
    };
    const digest = formatManagerFederatedDigest(result);
    expect(digest).toContain('other-app');
    expect(digest).toContain('#n9');
    expect(digest).toMatch(/read-only|untrusted reference/i);
  });

  it('returns undefined when there are no hits', () => {
    expect(formatManagerFederatedDigest({ hits: [], text: '' })).toBeUndefined();
  });
});

describe('maybeFederatedRecallForManager — perf filet', () => {
  it('does not fetch for a local/trivial turn', async () => {
    const fetch = vi.fn();
    const digest = await maybeFederatedRecallForManager('add a login button', { fetch });
    expect(digest).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches a bounded digest for a cross-project ask', async () => {
    const fetch = vi.fn().mockResolvedValue({
      hits: [{
        id: 'n9',
        title: 'JWT',
        snippet: 'other app uses JWT',
        score: 0.9,
        sourceProject: 'other-app',
        brainId: 'other-app',
        brainPath: 'other-app',
      }],
      text: '[#n9] (from other-app) JWT: other app uses JWT',
    });
    const digest = await maybeFederatedRecallForManager(
      'how did we do auth in the other project?',
      { fetch },
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(digest).toContain('other-app');
  });

  it('times out instead of blocking the manager turn', async () => {
    const fetch = vi.fn().mockImplementation(
      () => new Promise((resolve) => { setTimeout(() => resolve({ hits: [], text: '' }), 5_000); }),
    );
    const digest = await maybeFederatedRecallForManager(
      'how did we do auth in the other project?',
      { fetch, timeoutMs: 20 },
    );
    expect(digest).toBeUndefined();
  });
});

describe('buildManagerDynamicContext — D92 digest', () => {
  it('injects a federated recall block when the caller supplies a digest', () => {
    const dynamic = buildManagerDynamicContext({
      ...baseCtx,
      federatedRecallDigest: '[#n9] (from other-app) JWT: other app uses JWT',
    });
    expect(dynamic).toContain('Federated recall (read-only, other project brains)');
    expect(dynamic).toContain('other-app');
  });

  it('omits the block when there is no digest', () => {
    const dynamic = buildManagerDynamicContext(baseCtx);
    expect(dynamic).not.toContain('Federated recall');
  });
});
