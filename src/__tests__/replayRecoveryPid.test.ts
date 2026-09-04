import { describe, it, expect } from 'vitest';
import { applyReplayRecovery } from '../lib/agents/replayRecovery';
import type { Mission } from '../lib/agents/types';

const t = (key: string) => key;

function mission(partial: Partial<Mission> & Pick<Mission, 'id' | 'status'>): Mission {
  return { title: partial.title ?? 't', model: 'Sonnet', ...partial };
}

describe('applyReplayRecovery — live PID reattach', () => {
  it('keeps a running mission running when its CLI pid is still alive', () => {
    const running = mission({
      id: 'M-live',
      status: 'running',
      liveAction: 'Thinking…',
    });
    const { missions, interruptedIds, reattachedIds } = applyReplayRecovery(
      [running],
      t,
      { liveMissionIds: new Set(['M-live']) },
    );
    expect(missions[0].status).toBe('running');
    expect(missions[0].liveAction).toBe('Thinking…');
    expect(interruptedIds).toEqual([]);
    expect(reattachedIds).toEqual(['M-live']);
  });

  it('fails a running mission with no live pid (historical boot behaviour)', () => {
    const running = mission({ id: 'M-dead', status: 'running', liveAction: 'Thinking…' });
    const { missions, interruptedIds, reattachedIds } = applyReplayRecovery([running], t);
    expect(missions[0].status).toBe('failed');
    expect(missions[0].statusReason).toBe('agents.recoveredOnRestart');
    expect(interruptedIds).toEqual(['M-dead']);
    expect(reattachedIds).toEqual([]);
  });

  it('still preserves a review mission with a real diff', () => {
    const review = mission({
      id: 'M-rev',
      status: 'review',
      liveAction: 'eval',
      diffFiles: [{ filename: 'a.ts', added: 1, removed: 0 }],
      diffAdded: 1,
    });
    const { missions, interruptedIds } = applyReplayRecovery([review], t);
    expect(missions[0].status).toBe('review');
    expect(interruptedIds).toEqual([]);
  });
});
