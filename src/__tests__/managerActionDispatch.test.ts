import { describe, it, expect, vi } from 'vitest';
import {
  isManagerActionExecutorNoop,
  runManagerActionHandler,
} from '../lib/agents/managerActionDispatch';

describe('managerActionDispatch', () => {
  it('treats grounding and display types as executor no-ops', () => {
    expect(isManagerActionExecutorNoop('brain_query')).toBe(true);
    expect(isManagerActionExecutorNoop('web_search')).toBe(true);
    expect(isManagerActionExecutorNoop('list_agents')).toBe(true);
    expect(isManagerActionExecutorNoop('propose_mission_charter')).toBe(true);
    expect(isManagerActionExecutorNoop('launch_mission')).toBe(false);
  });

  it('skips handlers for no-op types', async () => {
    const launch = vi.fn();
    await runManagerActionHandler({ type: 'info' }, { info: launch, launch_mission: launch });
    expect(launch).not.toHaveBeenCalled();
  });

  it('runs the matching handler', async () => {
    const launch = vi.fn(async () => 'ok');
    const result = await runManagerActionHandler(
      { type: 'launch_mission' },
      { launch_mission: launch },
    );
    expect(launch).toHaveBeenCalledOnce();
    expect(result).toBe('ok');
  });

  it('throws on an unknown type instead of silently no-opping', async () => {
    await expect(
      runManagerActionHandler({ type: 'not_a_real_action' }, {}),
    ).rejects.toThrow('Unknown manager action type: not_a_real_action');
  });
});
