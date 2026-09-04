/**
 * projections.test.ts — the journal projection query wrappers (T2.0 +
 * audit follow-up queryAgentStats).
 *
 * Every wrapper in projections.ts shares one hardened contract: it never
 * rejects and resolves [] outside Tauri or on any invoke failure — cockpit
 * surfaces (AgentRoster, GlobalFeed, AttentionInbox) rely on that to
 * degrade to honest empty/loading states instead of crashing. These tests
 * pin that contract plus the exact invoke wire shape (command name +
 * flattened camelCase args) for the new queryAgentStats.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { AgentStatsOut } from '../lib/journal/projections';

const mockInvoke = vi.mocked(invoke);

// isTauri() controls the short-circuit path; toggled per test.
const { mockIsTauri } = vi.hoisted(() => ({ mockIsTauri: vi.fn() }));
vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return { ...actual, isTauri: () => mockIsTauri() };
});

import {
  queryAgentStats,
  queryFleetOverview,
  queryAttentionInbox,
  queryActivityFeed,
} from '../lib/journal/projections';

function statsRow(agentId: string, overrides: Partial<AgentStatsOut> = {}): AgentStatsOut {
  return {
    agent_id: agentId,
    runs: 4,
    completed: 3,
    failed: 1,
    total_tokens: 12_000,
    total_cost_usd: 0.48,
    last_active_ms: 1_720_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockReset();
  mockIsTauri.mockReturnValue(true);
});

describe('queryAgentStats (audit follow-up: journal_agent_stats wrapper)', () => {
  it('calls journal_agent_stats with agentId: null when unscoped', async () => {
    const rows = [statsRow('test-writer'), statsRow('security-reviewer', { runs: 2 })];
    mockInvoke.mockResolvedValueOnce(rows);

    const result = await queryAgentStats();

    expect(mockInvoke).toHaveBeenCalledWith('journal_agent_stats', { agentId: null });
    expect(result).toEqual(rows);
  });

  it('passes an explicit agentId through', async () => {
    mockInvoke.mockResolvedValueOnce([statsRow('test-writer')]);

    const result = await queryAgentStats('test-writer');

    expect(mockInvoke).toHaveBeenCalledWith('journal_agent_stats', { agentId: 'test-writer' });
    expect(result).toHaveLength(1);
    expect(result[0].agent_id).toBe('test-writer');
  });

  it('resolves [] outside Tauri without ever invoking', async () => {
    mockIsTauri.mockReturnValue(false);

    await expect(queryAgentStats()).resolves.toEqual([]);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('never rejects: resolves [] when invoke fails', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('backend unavailable'));

    await expect(queryAgentStats()).resolves.toEqual([]);
  });
});

describe('existing projection wrappers share the never-rejects contract', () => {
  it.each([
    ['queryFleetOverview', () => queryFleetOverview()],
    ['queryAttentionInbox', () => queryAttentionInbox()],
    ['queryActivityFeed', () => queryActivityFeed()],
  ])('%s resolves [] on invoke failure', async (_name, call) => {
    mockInvoke.mockRejectedValueOnce(new Error('boom'));
    await expect(call()).resolves.toEqual([]);
  });

  it.each([
    ['queryFleetOverview', () => queryFleetOverview()],
    ['queryAttentionInbox', () => queryAttentionInbox()],
    ['queryActivityFeed', () => queryActivityFeed()],
  ])('%s resolves [] outside Tauri', async (_name, call) => {
    mockIsTauri.mockReturnValue(false);
    await expect(call()).resolves.toEqual([]);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
