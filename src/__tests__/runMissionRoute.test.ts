import { describe, it, expect } from 'vitest';
import { cliModelFamily, missionBranchName } from '../lib/agents/runMissionRoute';
import type { Mission } from '../lib/agents/types';

describe('runMissionRoute', () => {
  it('maps model ids to CLI families, haiku first', () => {
    expect(cliModelFamily('claude-sonnet-5')).toBe('sonnet');
    expect(cliModelFamily('claude-opus-5')).toBe('opus');
    expect(cliModelFamily('claude-haiku-4.5')).toBe('haiku');
    expect(cliModelFamily(undefined)).toBe('haiku');
  });

  it('builds a stable agent branch from the mission id and title', () => {
    expect(missionBranchName({ id: 'M1', title: 'Fix Login!' } as Mission)).toBe('agent/M1-fix-login');
  });
});
