/**
 * Tests for canvas/canvasDigest.ts — the LazyManager canvas digest (Agent
 * Canvas W4, spec §8.1/§8.2). Covers: project counts, the maxNodes cap +
 * "…+N autres" summary line, chain/draft lines, the pending
 * cross-project-fire heuristic, and the honest empty-board message.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { buildCanvasDigest, resolveProjectRootById, resolveDraftProjectId } from '../components/agents/canvas/canvasDigest';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import { makeRef, type Chain, type DraftSpec } from '../components/agents/canvas/canvasTypes';
import type { Mission } from '../lib/agents/types';

const mockInvoke = vi.mocked(invoke);

interface JournalRow {
  mission_id: string;
  project_id: string;
  status: string;
  data: string;
  updated_ms: number;
}

interface ProjectRow {
  id: string;
  root: string;
  brainId: string | null;
  active: boolean;
}

function mission(overrides: Partial<Mission> & { id: string }): Mission {
  return { title: `Mission ${overrides.id}`, status: 'running', model: 'sonnet', ...overrides };
}

function journalRow(m: Mission, projectId: string): JournalRow {
  return { mission_id: m.id, project_id: projectId, status: m.status, data: JSON.stringify(m), updated_ms: Date.now() };
}

function installInvokeFake(projects: ProjectRow[], missions: JournalRow[]): void {
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'project_list') return projects;
    if (cmd === 'journal_missions_current') return missions;
    throw new Error(`unexpected invoke: ${cmd}`);
  });
}

beforeEach(() => {
  _resetCanvasStoreForTests();
  mockInvoke.mockReset();
});

describe('buildCanvasDigest — empty board', () => {
  it('reports an honest empty message when nothing is open', async () => {
    installInvokeFake([], []);
    const digest = await buildCanvasDigest();
    expect(digest).toContain('no open project');
  });

  it('degrades to an honest empty digest on a Tauri failure (never throws)', async () => {
    mockInvoke.mockRejectedValue(new Error('no tauri runtime'));
    await expect(buildCanvasDigest()).resolves.toContain('no open project');
  });
});

describe('buildCanvasDigest — projects + nodes', () => {
  it('lists per-project status counts and marks the active project', async () => {
    installInvokeFake(
      [
        { id: 'reg-1', root: '/repo/alpha', brainId: null, active: true },
        { id: 'reg-2', root: '/repo/beta', brainId: null, active: false },
      ],
      [
        journalRow(mission({ id: 'M1', status: 'running' }), 'proj-alpha'),
        journalRow(mission({ id: 'M2', status: 'done' }), 'proj-alpha'),
        journalRow(mission({ id: 'M3', status: 'failed' }), 'proj-beta'),
      ],
    );

    const digest = await buildCanvasDigest();
    expect(digest).toContain('Projects:');
    expect(digest).toContain('[ACTIVE]');
    expect(digest).toContain('running:1');
    expect(digest).toContain('done:1');
    expect(digest).toContain('failed:1');
  });

  it('lists nodes with ref/kind/title truncated to 40 chars/status/stage/project', async () => {
    const longTitle = 'A'.repeat(60);
    installInvokeFake([], [journalRow(mission({ id: 'M1', title: longTitle, status: 'running' }), 'proj-alpha')]);

    const digest = await buildCanvasDigest();
    expect(digest).toContain(makeRef('mission', 'M1'));
    expect(digest).toContain('[mission]');
    expect(digest).toContain('status=running');
    expect(digest).toContain('project=proj-alpha');
    // Truncated to 40 chars (39 chars + ellipsis) — never the full 60-char title.
    expect(digest).not.toContain(longTitle);
    expect(digest).toContain(`${'A'.repeat(39)}…`);
  });

  it('renders a loop-config mission as kind [loop], not [mission]', async () => {
    installInvokeFake(
      [],
      [
        journalRow(
          mission({
            id: 'M1',
            status: 'running',
            loopConfig: { cadence: '5m', stopCondition: { kind: 'manual' }, enabled: true, iterationCount: 0, iterationMissionIds: [] },
          }),
          'proj-alpha',
        ),
      ],
    );

    const digest = await buildCanvasDigest();
    expect(digest).toContain(makeRef('loop', 'M1'));
    expect(digest).toContain('[loop]');
  });

  it('caps the node list and appends a "…+N autres" summary line', async () => {
    const rows: JournalRow[] = [];
    for (let i = 0; i < 5; i++) rows.push(journalRow(mission({ id: `M${i}`, status: 'queued' }), 'proj-alpha'));
    installInvokeFake([], rows);

    const digest = await buildCanvasDigest({ maxNodes: 3 });
    expect(digest).toContain('Nodes (5):');
    expect(digest).toContain('…+2 autres');
    // Exactly 3 node lines listed (plus the summary line) — not all 5.
    const nodeLines = digest.split('\n').filter((l) => l.startsWith('- mission:'));
    expect(nodeLines).toHaveLength(3);
  });
});

describe('buildCanvasDigest — chains + drafts', () => {
  it('lists chains with source -> target, condition, disabled, and lastFired', async () => {
    installInvokeFake([], []);
    const firedAt = Date.UTC(2026, 0, 1);
    const chain: Chain = {
      id: 'chain-1',
      sourceRef: makeRef('mission', 'M1'),
      targetRef: makeRef('draft', 'D1'),
      condition: 'success',
      createdBy: 'manager',
      disabled: true,
      lastFiredAtMs: firedAt,
    };
    canvasStoreVanilla.getState().addChain(chain);

    const digest = await buildCanvasDigest();
    expect(digest).toContain('chain-1: mission:M1 -> draft:D1 [success]');
    expect(digest).toContain('DISABLED');
    expect(digest).toContain(new Date(firedAt).toISOString());
  });

  it('lists drafts with their project or "(transverse)"', async () => {
    installInvokeFake([], []);
    const draft: DraftSpec = { id: 'D1', title: 'Write tests', task: 'write tests', createdBy: 'manager', projectId: 'proj-alpha' };
    const transverseDraft: DraftSpec = { id: 'D2', title: 'Cross-cutting note', task: 'x', createdBy: 'user' };
    canvasStoreVanilla.getState().addDraft(draft);
    canvasStoreVanilla.getState().addDraft(transverseDraft);

    const digest = await buildCanvasDigest();
    expect(digest).toContain(`${makeRef('draft', 'D1')}: "Write tests" project=proj-alpha`);
    expect(digest).toContain(`${makeRef('draft', 'D2')}: "Cross-cutting note" (transverse)`);
  });

  it('flags a pending cross-project fire: source terminal + target draft in an inactive project', async () => {
    installInvokeFake(
      [{ id: 'reg-1', root: '/repo/alpha', brainId: null, active: true }],
      [journalRow(mission({ id: 'M1', title: 'Build API', status: 'done' }), 'proj-alpha')],
    );
    const draft: DraftSpec = { id: 'D1', title: 'Follow-up', task: 'follow up', createdBy: 'manager', projectId: 'proj-beta' };
    canvasStoreVanilla.getState().addDraft(draft);
    canvasStoreVanilla.getState().addChain({
      id: 'chain-1',
      sourceRef: makeRef('mission', 'M1'),
      targetRef: makeRef('draft', 'D1'),
      condition: 'success',
      createdBy: 'manager',
    });

    const digest = await buildCanvasDigest();
    expect(digest).toContain('Pending cross-project fires:');
    expect(digest).toContain('chain-1');
    expect(digest).toContain('waiting on project proj-beta');
  });

  it('does not flag a chain whose source has not reached a matching terminal status', async () => {
    installInvokeFake(
      [{ id: 'reg-1', root: '/repo/alpha', brainId: null, active: true }],
      [journalRow(mission({ id: 'M1', status: 'running' }), 'proj-alpha')],
    );
    const draft: DraftSpec = { id: 'D1', title: 'Follow-up', task: 'follow up', createdBy: 'manager', projectId: 'proj-beta' };
    canvasStoreVanilla.getState().addDraft(draft);
    canvasStoreVanilla.getState().addChain({
      id: 'chain-1',
      sourceRef: makeRef('mission', 'M1'),
      targetRef: makeRef('draft', 'D1'),
      condition: 'success',
      createdBy: 'manager',
    });

    const digest = await buildCanvasDigest();
    expect(digest).not.toContain('Pending cross-project fires:');
  });

  // ── Chain project attribution (2026-08-02 escalation) ──────────────────
  //
  // Real founder repro: the manager could not tell WHICH project a chain
  // belonged to from the digest alone (a chain line carried no project
  // attribution at all) — "no chain defined after M1/M2 in lazy-backoffice"
  // even though the chain WAS in the digest, just impossible to attribute
  // without cross-referencing every other section by hand.
  it('attributes a chain line to its source mission\'s real journaled project', async () => {
    installInvokeFake([], [journalRow(mission({ id: 'M1', status: 'done' }), 'proj-backoffice')]);
    canvasStoreVanilla.getState().addChain({
      id: 'chain-1',
      sourceRef: makeRef('mission', 'M1'),
      targetRef: makeRef('draft', 'D1'),
      condition: 'success',
      createdBy: 'manager',
    });

    const digest = await buildCanvasDigest();
    expect(digest).toContain('chain-1: mission:M1 -> draft:D1 [success] project=proj-backoffice');
  });

  it('flags MISMATCH when a chain\'s source and target live in disagreeing projects — the mis-materialized-plan repro', async () => {
    installInvokeFake([], [journalRow(mission({ id: 'M1', status: 'done' }), 'proj-backoffice')]);
    canvasStoreVanilla.getState().addDraft({ id: 'D1', title: 'Next step', task: 'x', createdBy: 'manager', projectId: 'proj-lazy' });
    canvasStoreVanilla.getState().addChain({
      id: 'chain-1',
      sourceRef: makeRef('mission', 'M1'),
      targetRef: makeRef('draft', 'D1'),
      condition: 'success',
      createdBy: 'manager',
    });

    const digest = await buildCanvasDigest();
    expect(digest).toContain('MISMATCH(source=proj-backoffice target=proj-lazy)');
  });

  it('never flags MISMATCH when both ends agree', async () => {
    installInvokeFake([], [journalRow(mission({ id: 'M1', status: 'done' }), 'proj-backoffice')]);
    canvasStoreVanilla.getState().addDraft({ id: 'D1', title: 'Next step', task: 'x', createdBy: 'manager', projectId: 'proj-backoffice' });
    canvasStoreVanilla.getState().addChain({
      id: 'chain-1',
      sourceRef: makeRef('mission', 'M1'),
      targetRef: makeRef('draft', 'D1'),
      condition: 'success',
      createdBy: 'manager',
    });

    const digest = await buildCanvasDigest();
    expect(digest).not.toContain('MISMATCH');
  });
});

// ── 2026-08-05 fix: scan_project rejecting the project open_project just
// opened ("not a currently open project") — root cause was
// resolveProjectRootById/resolveDraftProjectId comparing an ALREADY
// projectIdFromRoot-normalized directory key against a RAW, unnormalized
// caller-supplied id/path. Both now normalize via the same primitive
// (projectIdFromRoot, plus slash-direction unification for comparison only)
// before comparing. ────────────────────────────────────────────────────────
describe('resolveProjectRootById — path normalization before membership comparison', () => {
  it('resolves when the stored root and the queried id share the SAME uppercase drive letter (the real repro: both differ from the normalized key)', async () => {
    const rawPath = 'C:\\Users\\user\\Documents\\cerveau\\LazySite-internet';
    installInvokeFake([{ id: 'reg-1', root: rawPath, brainId: null, active: true }], []);

    const root = await resolveProjectRootById(rawPath);

    expect(root).toBe(rawPath);
  });

  it('resolves when the query uses forward slashes but the stored root uses backslashes', async () => {
    const storedRoot = 'C:\\Users\\user\\Documents\\cerveau\\LazySite-internet';
    const queryPath = 'C:/Users/user/Documents/cerveau/LazySite-internet';
    installInvokeFake([{ id: 'reg-1', root: storedRoot, brainId: null, active: true }], []);

    const root = await resolveProjectRootById(queryPath);

    expect(root).toBe(storedRoot);
  });

  it('resolves when queried with the canvas digest\'s own lowercase-drive normalized id', async () => {
    const storedRoot = 'C:\\Users\\user\\Documents\\cerveau\\LazySite-internet';
    installInvokeFake([{ id: 'reg-1', root: storedRoot, brainId: null, active: true }], []);

    const root = await resolveProjectRootById('c:\\Users\\user\\Documents\\cerveau\\LazySite-internet');

    expect(root).toBe(storedRoot);
  });

  it('still returns undefined for a project that genuinely is not open (no false-positive matching)', async () => {
    installInvokeFake([{ id: 'reg-1', root: 'C:\\Users\\user\\Documents\\cerveau\\LazySite-internet', brainId: null, active: true }], []);

    const root = await resolveProjectRootById('C:\\Users\\user\\Documents\\cerveau\\SomeOtherProject');

    expect(root).toBeUndefined();
  });
});

describe('resolveDraftProjectId — same normalization for its exact-id match path', () => {
  it('resolves a raw uppercase-drive path to the directory\'s own normalized id', async () => {
    const rawPath = 'C:\\Users\\user\\Documents\\cerveau\\LazySite-internet';
    installInvokeFake([{ id: 'reg-1', root: rawPath, brainId: null, active: false }], []);

    const resolution = await resolveDraftProjectId(rawPath);

    expect(resolution.projectId).toBe('c:\\Users\\user\\Documents\\cerveau\\LazySite-internet');
    expect(resolution.unresolvedName).toBeUndefined();
  });

  it('still falls through to unresolvedName for a name/path that matches nothing', async () => {
    installInvokeFake([{ id: 'reg-1', root: 'C:\\Users\\user\\Documents\\cerveau\\LazySite-internet', brainId: null, active: false }], []);

    const resolution = await resolveDraftProjectId('totally-unknown-project');

    expect(resolution.projectId).toBeUndefined();
    expect(resolution.unresolvedName).toBe('totally-unknown-project');
  });
});
