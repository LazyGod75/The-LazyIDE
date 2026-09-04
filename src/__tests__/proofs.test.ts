/**
 * proofs.test.ts — proof-of-work artifact storage + Done-gate helpers
 * (spec §8, T1.4): proofsDir/storeProofText path handling, buildProofArtifact
 * validation, parseProofBlocks transcript parsing, addProof immutability,
 * hasRequiredProofs/missingProofKinds, and the checkApproveGate integration
 * (proof gate stacked on top of the existing judge-verdict gate).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  proofsDir,
  storeProofText,
  buildProofArtifact,
  parseProofBlocks,
  addProof,
  hasRequiredProofs,
  missingProofKinds,
  UNKNOWN_EXIT_CODE,
} from '../lib/agents/proofs';
import { checkApproveGate, ApproveBlockedError } from '../components/agents/approveGate';
import type { Mission, MissionContract, ProofArtifact, JudgeVerdict } from '../lib/agents/types';

const createDir = vi.fn().mockResolvedValue(undefined);
const writeFile = vi.fn().mockResolvedValue(undefined);

vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(() => ({
    fs: { createDir, writeFile },
  })),
}));

// ── Helpers ────────────────────────────────────────────────────────

function makeContract(proofs: MissionContract['proofs']): MissionContract {
  return {
    objective: 'test objective',
    model: 'haiku',
    permissionMode: 'acceptEdits',
    budgetCapUsd: 5,
    proofs,
    gates: { evaluators: true, humanApprove: true },
    shareToTeam: false,
  };
}

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'm-1',
    title: 'Test mission',
    status: 'review',
    model: 'haiku',
    ...overrides,
  };
}

function makeVerdict(passed: boolean, score = 80): JudgeVerdict {
  return { score, passed, risk: 'medium', reviewers: [], createdAt: new Date().toISOString() };
}

beforeEach(() => {
  createDir.mockClear().mockResolvedValue(undefined);
  writeFile.mockClear().mockResolvedValue(undefined);
});

// ── proofsDir / storeProofText ─────────────────────────────────────

describe('proofsDir', () => {
  it('joins projectRoot + .lazy/artifacts + missionId', () => {
    expect(proofsDir('/repo', 'm-1')).toBe('/repo/.lazy/artifacts/m-1');
  });

  it('sanitizes unsafe missionId characters', () => {
    expect(proofsDir('/repo', 'm/1:weird?')).toBe('/repo/.lazy/artifacts/m-1-weird-');
  });

  it('is verbatim-safe (backslash base throughout, never a literal "/")', () => {
    const dir = proofsDir(String.raw`\\?\C:\repo`, 'm-1');
    expect(dir).toBe(String.raw`\\?\C:\repo\.lazy\artifacts\m-1`);
    expect(dir).not.toContain('/');
  });
});

describe('storeProofText', () => {
  it('creates the mission proof dir and writes the file, returning its path', async () => {
    const path = await storeProofText('/repo', 'm-1', 'test_run-1.txt', 'hello output');

    expect(createDir).toHaveBeenCalledWith('/repo/.lazy/artifacts/m-1');
    expect(writeFile).toHaveBeenCalledWith('/repo/.lazy/artifacts/m-1/test_run-1.txt', 'hello output');
    expect(path).toBe('/repo/.lazy/artifacts/m-1/test_run-1.txt');
  });

  it('sanitizes unsafe filename characters', async () => {
    await storeProofText('/repo', 'm-1', 'weird:name?.txt', 'x');
    expect(writeFile).toHaveBeenCalledWith('/repo/.lazy/artifacts/m-1/weird-name-.txt', 'x');
  });
});

// ── buildProofArtifact ──────────────────────────────────────────────

describe('buildProofArtifact', () => {
  it('builds a screenshot artifact', () => {
    expect(buildProofArtifact({ kind: 'screenshot', path: 'a.png', label: 'Login page' })).toEqual({
      kind: 'screenshot',
      path: 'a.png',
      label: 'Login page',
    });
  });

  it('rejects a screenshot missing label', () => {
    expect(buildProofArtifact({ kind: 'screenshot', path: 'a.png' })).toBeNull();
  });

  it('builds an e2e_recording artifact', () => {
    expect(buildProofArtifact({ kind: 'e2e_recording', path: 'rec.mp4' })).toEqual({
      kind: 'e2e_recording',
      path: 'rec.mp4',
    });
  });

  it('rejects e2e_recording missing path', () => {
    expect(buildProofArtifact({ kind: 'e2e_recording' })).toBeNull();
  });

  it('builds a behavior_diff artifact', () => {
    expect(buildProofArtifact({ kind: 'behavior_diff', before: 'crashes', after: 'works' })).toEqual({
      kind: 'behavior_diff',
      before: 'crashes',
      after: 'works',
    });
  });

  it('falls back to `content` for behavior_diff.after when `after` is absent', () => {
    expect(
      buildProofArtifact({ kind: 'behavior_diff', before: 'crashes', content: 'works now' }),
    ).toEqual({ kind: 'behavior_diff', before: 'crashes', after: 'works now' });
  });

  it('builds a test_run artifact (numeric exitCode, pre-resolved outputPath)', () => {
    expect(
      buildProofArtifact({ kind: 'test_run', command: 'npm test', exitCode: 0, outputPath: '/out.txt' }),
    ).toEqual({ kind: 'test_run', command: 'npm test', exitCode: 0, outputPath: '/out.txt' });
  });

  it('accepts a string exitCode for test_run (text-protocol transcript parsing)', () => {
    expect(
      buildProofArtifact({ kind: 'test_run', command: 'npm test', exitCode: '1', outputPath: '/out.txt' }),
    ).toEqual({ kind: 'test_run', command: 'npm test', exitCode: 1, outputPath: '/out.txt' });
  });

  // Run-12/M14 root cause: a declared test_run whose exitCode couldn't be
  // determined (npm CLI usage error, e.g. "Missing script") used to null the
  // WHOLE artifact here, silently discarding the agent's genuine test_run
  // declaration and forcing it to fall back to a different proof kind —
  // which is exactly how contract.proofs=[test_run] ended up satisfied only
  // by an unrelated command_output artifact, tripping "Preuves manquantes :
  // test_run" despite a real (failing) test having been attempted. exitCode
  // is best-effort only: hasRequiredProofs never inspects it (kind coverage
  // only) — command + outputPath remain the real validity requirements.
  it('falls back to UNKNOWN_EXIT_CODE for test_run with a non-numeric exitCode (does NOT drop the artifact)', () => {
    expect(
      buildProofArtifact({ kind: 'test_run', command: 'npm test', exitCode: 'nope', outputPath: '/out.txt' }),
    ).toEqual({ kind: 'test_run', command: 'npm test', exitCode: UNKNOWN_EXIT_CODE, outputPath: '/out.txt' });
  });

  it('falls back to UNKNOWN_EXIT_CODE for test_run with exitCode entirely absent', () => {
    expect(
      buildProofArtifact({ kind: 'test_run', command: 'npm test', outputPath: '/out.txt' }),
    ).toEqual({ kind: 'test_run', command: 'npm test', exitCode: UNKNOWN_EXIT_CODE, outputPath: '/out.txt' });
  });

  it('rejects test_run missing outputPath (command + outputPath remain required)', () => {
    expect(buildProofArtifact({ kind: 'test_run', command: 'npm test', exitCode: 0 })).toBeNull();
  });

  it('rejects test_run missing command even when exitCode is valid', () => {
    expect(buildProofArtifact({ kind: 'test_run', exitCode: 0, outputPath: '/out.txt' })).toBeNull();
  });

  it('builds a command_output artifact', () => {
    expect(
      buildProofArtifact({ kind: 'command_output', command: 'git status', outputPath: '/out.txt' }),
    ).toEqual({ kind: 'command_output', command: 'git status', outputPath: '/out.txt' });
  });

  it('returns null for an unknown kind', () => {
    expect(buildProofArtifact({ kind: 'video_call' })).toBeNull();
  });
});

// ── parseProofBlocks ──────────────────────────────────────────────

describe('parseProofBlocks', () => {
  it('returns [] for an empty transcript', async () => {
    expect(await parseProofBlocks('', '/repo', 'm-1')).toEqual([]);
  });

  it('parses a screenshot block and a test_run block from one transcript', async () => {
    const transcript = [
      'Some agent narration before the proofs.',
      '```PROOF:screenshot',
      'path: shots/login.png',
      'label: Login page renders',
      '```',
      '```PROOF:test_run',
      'command: npm test',
      'exit_code: 0',
      '5 passed, 0 failed',
      '```',
    ].join('\n');

    const proofs = await parseProofBlocks(transcript, '/repo', 'm-1');

    expect(proofs).toHaveLength(2);
    expect(proofs[0]).toEqual({ kind: 'screenshot', path: 'shots/login.png', label: 'Login page renders' });
    expect(proofs[1]).toMatchObject({ kind: 'test_run', command: 'npm test', exitCode: 0 });
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('test_run-1.txt'),
      '5 passed, 0 failed',
    );
  });

  it('ignores a malformed block (missing required field) without throwing', async () => {
    const transcript = [
      '```PROOF:screenshot',
      'path: shots/login.png',
      '```', // no label — malformed, must be skipped
      '```PROOF:command_output',
      'command: git status',
      'clean tree',
      '```',
    ].join('\n');

    const proofs = await parseProofBlocks(transcript, '/repo', 'm-1');

    expect(proofs).toHaveLength(1);
    expect(proofs[0]).toMatchObject({ kind: 'command_output', command: 'git status' });
  });

  it('caps parsing at 10 proofs even when more blocks are present', async () => {
    const blocks = Array.from(
      { length: 15 },
      (_, i) => '```PROOF:e2e_recording\npath: rec-' + i + '.mp4\n```',
    ).join('\n');

    const proofs = await parseProofBlocks(blocks, '/repo', 'm-1');

    expect(proofs).toHaveLength(10);
    expect(proofs[0]).toEqual({ kind: 'e2e_recording', path: 'rec-0.mp4' });
    expect(proofs[9]).toEqual({ kind: 'e2e_recording', path: 'rec-9.mp4' });
  });

  it('skips a block whose output storage fails, without aborting the rest of the parse', async () => {
    writeFile.mockRejectedValueOnce(new Error('disk full'));
    const transcript = [
      '```PROOF:test_run',
      'command: npm test',
      'exit_code: 0',
      'output one',
      '```',
      '```PROOF:e2e_recording',
      'path: rec.mp4',
      '```',
    ].join('\n');

    const proofs = await parseProofBlocks(transcript, '/repo', 'm-1');

    expect(proofs).toHaveLength(1);
    expect(proofs[0]).toEqual({ kind: 'e2e_recording', path: 'rec.mp4' });
  });
});

// ── addProof ────────────────────────────────────────────────────────

describe('addProof', () => {
  it('appends immutably without mutating the original mission', () => {
    const original = makeMission({ proofs: [{ kind: 'e2e_recording', path: 'a.mp4' }] });
    const proof: ProofArtifact = { kind: 'screenshot', path: 'b.png', label: 'B' };

    const updated = addProof(original, proof);

    expect(updated).not.toBe(original);
    expect(updated.proofs).toHaveLength(2);
    expect(original.proofs).toHaveLength(1); // original untouched
    expect(updated.proofs).toEqual([
      { kind: 'e2e_recording', path: 'a.mp4' },
      { kind: 'screenshot', path: 'b.png', label: 'B' },
    ]);
  });

  it('initializes proofs from undefined', () => {
    const original = makeMission();
    const proof: ProofArtifact = { kind: 'behavior_diff', before: 'x', after: 'y' };

    const updated = addProof(original, proof);

    expect(original.proofs).toBeUndefined();
    expect(updated.proofs).toEqual([proof]);
  });
});

// ── hasRequiredProofs / missingProofKinds ──────────────────────────

describe('hasRequiredProofs', () => {
  it('is satisfied when the mission has no contract at all', () => {
    expect(hasRequiredProofs(makeMission())).toBe(true);
  });

  it('is satisfied when contract.proofs is empty', () => {
    expect(hasRequiredProofs(makeMission({ contract: makeContract([]) }))).toBe(true);
  });

  it('is satisfied when every required kind has a matching artifact', () => {
    const mission = makeMission({
      contract: makeContract([{ kind: 'screenshot' }, { kind: 'test_run' }]),
      proofs: [
        { kind: 'screenshot', path: 'a.png', label: 'A' },
        { kind: 'test_run', command: 'npm test', exitCode: 0, outputPath: '/o.txt' },
      ],
    });
    expect(hasRequiredProofs(mission)).toBe(true);
  });

  it('is NOT satisfied when a required kind is missing', () => {
    const mission = makeMission({
      contract: makeContract([{ kind: 'screenshot' }, { kind: 'test_run' }]),
      proofs: [{ kind: 'screenshot', path: 'a.png', label: 'A' }],
    });
    expect(hasRequiredProofs(mission)).toBe(false);
  });

  it('is NOT satisfied when proofs is entirely absent but proofs are required', () => {
    const mission = makeMission({ contract: makeContract([{ kind: 'screenshot' }]) });
    expect(hasRequiredProofs(mission)).toBe(false);
  });
});

describe('missingProofKinds', () => {
  it('is empty when there is no contract', () => {
    expect(missingProofKinds(makeMission())).toEqual([]);
  });

  it('is empty when contract.proofs is empty', () => {
    expect(missingProofKinds(makeMission({ contract: makeContract([]) }))).toEqual([]);
  });

  it('lists exactly the missing kinds, de-duplicated', () => {
    const mission = makeMission({
      contract: makeContract([
        { kind: 'screenshot' },
        { kind: 'test_run' },
        { kind: 'test_run', label: 'again' },
      ]),
      proofs: [{ kind: 'screenshot', path: 'a.png', label: 'A' }],
    });
    expect(missingProofKinds(mission)).toEqual(['test_run']);
  });
});

// ── run-12/M14 regression — real persisted shapes ──────────────────
// Ground truth copied verbatim from the actual QA harness run 12 output:
// scratchpad/qa-projects/alpha/.lazy/missions.json's M14 entry (contract
// requires test_run; only a command_output artifact for an unrelated
// `type README.md` command was ever produced) — the exact shape that
// tripped "Preuves manquantes : test_run", forcing "Merger quand même".
describe('run-12/M14 regression — real persisted shapes', () => {
  const m14Contract = makeContract([{ kind: 'test_run' }]);
  const m14ProducedProofs: ProofArtifact[] = [
    {
      kind: 'command_output',
      command: 'type README.md',
      outputPath:
        String.raw`\\?\C:\Users\user\AppData\Local\Temp\claude\C--Users-David-Documents-cerveau\cf11c5e0-5379-4fe9-8c85-391c96b17f97\scratchpad\qa-projects\alpha\.lazy\artifacts\M14\command_output-1.txt`,
    },
  ];

  it('a command_output for an unrelated (non-test) command genuinely does NOT satisfy a required test_run — the gate is correct to block this exact historical mismatch', () => {
    const mission = makeMission({ contract: m14Contract, proofs: m14ProducedProofs });
    expect(hasRequiredProofs(mission)).toBe(false);
    expect(missingProofKinds(mission)).toEqual(['test_run']);
  });

  it('reproduces the exact blocked-approve reason run-12 hit ("Preuves manquantes : test_run") via checkApproveGate', () => {
    const mission = makeMission({
      judgeVerdict: makeVerdict(true, 82),
      contract: m14Contract,
      proofs: m14ProducedProofs,
    });
    const result = checkApproveGate(mission);
    expect(result).toBeInstanceOf(ApproveBlockedError);
    expect(result!.reason).toBe(
      'Preuves manquantes avant de passer en Terminé : test_run. Utilisez "Merger quand même" pour forcer.',
    );
  });

  it('the fix: had the agent honestly declared test_run for its actual (failing) `npm test` attempt, the SAME contract now passes via the normal approve — no force-merge needed', () => {
    // What run-12 SHOULD have produced: a genuine test_run for the real `npm
    // test` invocation (exit 1, "Missing script") instead of substituting an
    // unrelated command_output — exactly what buildProofArtifact's relaxed
    // exitCode handling now preserves rather than silently discarding.
    const honestProof = buildProofArtifact({
      kind: 'test_run',
      command: 'npm test',
      exitCode: undefined, // the agent couldn't cleanly report one — no longer fatal
      outputPath: (m14ProducedProofs[0] as Extract<ProofArtifact, { kind: 'command_output' }>).outputPath,
    });
    expect(honestProof).not.toBeNull();

    const mission = makeMission({
      judgeVerdict: makeVerdict(true, 82),
      contract: m14Contract,
      proofs: [honestProof as ProofArtifact],
    });
    expect(checkApproveGate(mission)).toBeNull();
  });
});

// ── checkApproveGate — proof-of-work gate integration ──────────────

describe('checkApproveGate — proof-of-work gate', () => {
  it('allows when judge passed and there is no contract', () => {
    const mission = makeMission({ judgeVerdict: makeVerdict(true) });
    expect(checkApproveGate(mission)).toBeNull();
  });

  it('allows when judge passed and contract.proofs is empty', () => {
    const mission = makeMission({ judgeVerdict: makeVerdict(true), contract: makeContract([]) });
    expect(checkApproveGate(mission)).toBeNull();
  });

  it('blocks when judge passed but a required proof is missing', () => {
    const mission = makeMission({
      judgeVerdict: makeVerdict(true),
      contract: makeContract([{ kind: 'screenshot' }]),
    });
    const result = checkApproveGate(mission);
    expect(result).toBeInstanceOf(ApproveBlockedError);
    expect(result!.reason).toMatch(/Preuves manquantes/);
    expect(result!.reason).toMatch(/screenshot/);
  });

  it('allows when judge passed and all required proofs are present', () => {
    const mission = makeMission({
      judgeVerdict: makeVerdict(true),
      contract: makeContract([{ kind: 'screenshot' }]),
      proofs: [{ kind: 'screenshot', path: 'a.png', label: 'A' }],
    });
    expect(checkApproveGate(mission)).toBeNull();
  });

  it('force=true bypasses the proof gate even with missing proofs', () => {
    const mission = makeMission({
      judgeVerdict: makeVerdict(true),
      contract: makeContract([{ kind: 'screenshot' }]),
    });
    expect(checkApproveGate(mission, { force: true })).toBeNull();
  });

  it('the judge-verdict block still takes precedence over the proof-gate message', () => {
    const mission = makeMission({
      judgeVerdict: undefined,
      contract: makeContract([{ kind: 'screenshot' }]),
    });
    const result = checkApproveGate(mission);
    expect(result).toBeInstanceOf(ApproveBlockedError);
    expect(result!.reason).toMatch(/Évaluation manquante/);
  });
});
