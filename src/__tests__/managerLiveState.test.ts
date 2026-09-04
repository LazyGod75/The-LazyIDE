import { describe, expect, it } from 'vitest';
import { liveManagerStoreView } from '../lib/agents/managerLiveState';

describe('liveManagerStoreView', () => {
  it('reads missions and autonomy from the live ref, not a stale snapshot', () => {
    const ref = {
      current: { missions: [{ id: 'M1' }], autonomyLevel: 'supervised' as const, extra: 1 },
    };
    const view = liveManagerStoreView(ref);
    expect(view.missions).toEqual([{ id: 'M1' }]);
    ref.current = { missions: [{ id: 'M2' }], autonomyLevel: 'yolo', extra: 2 };
    expect(view.missions).toEqual([{ id: 'M2' }]);
    expect(view.autonomyLevel).toBe('yolo');
  });
});
