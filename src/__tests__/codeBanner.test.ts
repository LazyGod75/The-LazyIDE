import { describe, it, expect } from 'vitest';
import { deriveCodeBanner } from '../lib/agents/codeBanner';
import type { FleetMission } from '../lib/agents/fleetMissions';

function mission(overrides: Partial<FleetMission> = {}): FleetMission {
  return {
    id: 'm1',
    title: 'Test mission',
    status: 'running',
    stage: 'code',
    model: 'sonnet',
    updatedMs: Date.now(),
    urgent: false,
    ...overrides,
  };
}

describe('deriveCodeBanner', () => {
  it('is none for a file with no activity and no scoped running mission', () => {
    expect(deriveCodeBanner('src/tokens.css', 'tokens.css', [])).toEqual({ kind: 'none' });
  });

  it('is run when a mission is writing the file', () => {
    const m = mission({ diffFiles: [{ filename: 'src/a.ts', added: 1, removed: 0 }] });
    expect(deriveCodeBanner('src/a.ts', 'a.ts', [m])).toEqual({ kind: 'run', mission: m });
  });

  it('is question when the touching mission has a pending ask_user question', () => {
    const m = mission({ diffFiles: [{ filename: 'src/a.ts', added: 1, removed: 0 }], pendingQuestion: 'Autoriser ?' });
    expect(deriveCodeBanner('src/a.ts', 'a.ts', [m])).toEqual({ kind: 'question', mission: m, question: 'Autoriser ?' });
  });

  it('is failed when the touching mission failed', () => {
    const m = mission({ status: 'failed', diffFiles: [{ filename: 'src/a.py', added: 1, removed: 0 }] });
    expect(deriveCodeBanner('src/a.py', 'a.py', [m])).toEqual({ kind: 'failed', mission: m });
  });

  it('is locked when a running scoped mission exists but the file is outside its scope', () => {
    const m = mission({ contractScopePaths: ['src/server/anticheat'] });
    expect(deriveCodeBanner('src/server/auth.rs', 'auth.rs', [m])).toEqual({ kind: 'locked', mission: m });
  });

  it('is none when the file is inside a running mission scope even with no direct activity', () => {
    const m = mission({ contractScopePaths: ['src/server'] });
    expect(deriveCodeBanner('src/server/auth.rs', 'auth.rs', [m])).toEqual({ kind: 'none' });
  });

  it('is none when scoped missions exist but none are running', () => {
    const m = mission({ status: 'done', contractScopePaths: ['src/server'] });
    expect(deriveCodeBanner('src/other.rs', 'other.rs', [m])).toEqual({ kind: 'none' });
  });

  it('is review when the touching mission is in review', () => {
    const m = mission({ status: 'review', diffFiles: [{ filename: 'src/a.ts', added: 1, removed: 0 }] });
    expect(deriveCodeBanner('src/a.ts', 'a.ts', [m])).toEqual({ kind: 'review', mission: m });
  });
});
