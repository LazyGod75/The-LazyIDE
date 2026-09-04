/**
 * AppShellScheduledRun.test.ts
 *
 * 'agent://scheduled-run' (agent.rs's cron scheduler thread) used to have
 * zero TS-side listener, unlike its siblings agent://step/{id},
 * agent://done/{id}, agent://error/{id} — the user never saw a scheduled
 * agent fire live. watchScheduledAgentRuns (AppShell.tsx) is the fix,
 * exported so it can be unit tested without mounting AppShellInner's full
 * provider tree (mirrors seedProgressStore.ts's own testable-export shape).
 */

import { describe, it, expect, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { watchScheduledAgentRuns } from '../components/AppShell';

describe('watchScheduledAgentRuns', () => {
  it('subscribes to agent://scheduled-run', async () => {
    const listenMock = vi.mocked(listen).mockResolvedValue(() => undefined);
    const toast = vi.fn();
    const t = (key: string) => key;

    await watchScheduledAgentRuns(toast, t);

    expect(listenMock).toHaveBeenCalledWith('agent://scheduled-run', expect.any(Function));
  });

  it('toasts a discrete notification carrying the agent name on receipt', async () => {
    let handler: ((event: { payload: Record<string, unknown> }) => void) | undefined;
    vi.mocked(listen).mockImplementation(((_name: string, cb: typeof handler) => {
      handler = cb;
      return Promise.resolve(() => undefined);
    }) as typeof listen);

    const toast = vi.fn();
    const t = (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${JSON.stringify(params)}` : key;

    await watchScheduledAgentRuns(toast, t);
    expect(handler).toBeDefined();

    handler!({
      payload: {
        missionId: 'sched-nightly-audit-1770000000',
        agentName: 'Audit nocturne',
        agentId: 'agent-1',
        scheduledAt: '2026-08-11T02:00:00Z',
      },
    });

    expect(toast).toHaveBeenCalledWith(
      'agents.notification.scheduledRun:{"name":"Audit nocturne"}',
      'info',
      4000,
    );
  });

  it('returns the unlisten function the Tauri listen() call resolved', async () => {
    const unlisten = vi.fn();
    vi.mocked(listen).mockResolvedValue(unlisten);

    const result = await watchScheduledAgentRuns(vi.fn(), (key: string) => key);

    expect(result).toBe(unlisten);
  });
});
