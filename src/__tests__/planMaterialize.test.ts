import { describe, it, expect } from 'vitest';
import { partitionMaterializedDrafts } from '../lib/agents/planMaterialize';

describe('partitionMaterializedDrafts', () => {
  it('does not cancel the plan when one draft is missing', () => {
    const result = partitionMaterializedDrafts({
      expectedIds: ['audit', 'implement', 'test'],
      survivingIds: new Set(['audit', 'test']),
    });
    expect(result.canLaunch).toBe(true);
    expect(result.missingIds).toEqual(['implement']);
    expect(result.launchIds).toEqual(['audit', 'test']);
  });

  it('refuses to launch only when every draft is missing', () => {
    const result = partitionMaterializedDrafts({
      expectedIds: ['a', 'b'],
      survivingIds: new Set(),
    });
    expect(result.canLaunch).toBe(false);
    expect(result.missingIds).toEqual(['a', 'b']);
    expect(result.launchIds).toEqual([]);
  });
});
