/**
 * consolidation.test.ts
 *
 * Coverage for the audit fix (spec §5.3): promoteToRootTrunk used to just
 * recapture promoted neurons into whichever project brain happened to be
 * active, tagged 'promoted'/'root-trunk' — never a separate brain at all.
 *
 * This file covers:
 *   1. promoteToRootTrunk now registers a REAL brain at a stable,
 *      project-independent path (appDataDir()/root-brain) with the engine's
 *      registry (label 'trunk'), surfaced as result.trunkBrainId.
 *   2. The honest fallback: capture() has no brainId-targeting parameter,
 *      so promoted neurons still land in the active project brain either
 *      way — registration success/failure must never block promotion.
 *   3. Existing promotion behavior (score threshold, sourceProject
 *      requirement, tags, journal event) is unchanged.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── journal mock ──────────────────────────────────────────────────────
const journalQueryMock = vi.fn();

vi.mock('../lib/journal/journal', () => ({
  journalQuery: (...args: unknown[]) => journalQueryMock(...args),
  emitBuffered: vi.fn(),
}));

// ── platform mock ───────────────────────────────────────────────────────
const isTauriMock = vi.fn(() => true);
const searchScopedMock = vi.fn();
const captureMock = vi.fn();

vi.mock('../lib/platform', () => ({
  isTauri: () => isTauriMock(),
  getPlatform: () => ({
    name: 'tauri',
    brain: {
      searchScoped: (...args: unknown[]) => searchScopedMock(...args),
      capture: (...args: unknown[]) => captureMock(...args),
    },
  }),
}));

// ── platform/tauri mock — get_brain_connection escape hatch ───────────
const getBrainConnectionMock = vi.fn();

vi.mock('../lib/platform/tauri', () => ({
  getBrainConnection: (...args: unknown[]) => getBrainConnectionMock(...args),
}));

// ── @tauri-apps/api/path mock ──────────────────────────────────────────
const appDataDirMock = vi.fn();

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: (...args: unknown[]) => appDataDirMock(...args),
}));

import { emitBuffered } from '../lib/journal/journal';
import { promoteToRootTrunk } from '../lib/brain/consolidation';

const mockedEmitBuffered = vi.mocked(emitBuffered);

function openBrainResponse(brainId: string, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve({ brainId }),
  };
}

const highScoreHit = {
  id: 'hit-1',
  title: 'Use retry-with-backoff for flaky network calls',
  snippet: 'Wrap network calls in an exponential-backoff retry helper.',
  score: 0.9,
  sourceProject: 'project-a',
};

beforeEach(() => {
  vi.clearAllMocks();
  isTauriMock.mockReturnValue(true);
  appDataDirMock.mockResolvedValue('C:\\Users\\test\\AppData\\Roaming\\com.lazy.dev');
  getBrainConnectionMock.mockResolvedValue({ port: 45123, token: 'sidecar-secret' });
  searchScopedMock.mockResolvedValue([highScoreHit]);
  captureMock.mockResolvedValue({ id: 'captured-1' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(openBrainResponse('trunk-brain-1')));
});

// ── Real trunk-brain registration ──────────────────────────────────────

describe('promoteToRootTrunk — registers a real trunk brain (spec §5.3)', () => {
  it('registers <appDataDir>/root-brain with label trunk and returns its brainId', async () => {
    const result = await promoteToRootTrunk();

    expect(result.trunkBrainId).toBe('trunk-brain-1');
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:45123/brains/open',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer sidecar-secret' }),
      }),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      brainPath: 'C:\\Users\\test\\AppData\\Roaming\\com.lazy.dev\\root-brain',
      label: 'trunk',
    });
  });

  it('skips registration entirely outside Tauri (no appDataDir/fetch call), trunkBrainId stays undefined', async () => {
    isTauriMock.mockReturnValue(false);

    const result = await promoteToRootTrunk();

    expect(result.trunkBrainId).toBeUndefined();
    expect(appDataDirMock).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    // Promotion itself is unaffected by the (expected, non-Tauri) skip.
    expect(captureMock).toHaveBeenCalledTimes(1);
  });
});

describe('promoteToRootTrunk — honest fallback when trunk registration fails', () => {
  it('still promotes neurons into the active brain when opening the trunk brain fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(openBrainResponse('', false, 500)));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await promoteToRootTrunk();

    expect(result.trunkBrainId).toBeUndefined();
    expect(result.neuronsPromoted).toBe(1);
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to open the root-trunk brain'),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it('warns that captured content still lands in the active brain when registration DOES succeed (capture cannot target trunkBrainId yet)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await promoteToRootTrunk();

    expect(result.trunkBrainId).toBe('trunk-brain-1');
    expect(result.neuronsPromoted).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('root-trunk brain trunk-brain-1 is registered but capture cannot target it yet'),
    );
    warnSpy.mockRestore();
  });

  it('does not warn about unreachable capture-targeting when nothing was promoted', async () => {
    searchScopedMock.mockResolvedValue([]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await promoteToRootTrunk();

    expect(result.trunkBrainId).toBe('trunk-brain-1');
    expect(result.neuronsPromoted).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ── Existing promotion behavior (regression) ────────────────────────────

describe('promoteToRootTrunk — existing promotion behavior unchanged', () => {
  it('captures a high-scoring hit tagged promoted/root-trunk/<sourceProject> and emits brain.promoted', async () => {
    const result = await promoteToRootTrunk();

    expect(result.neuronsPromoted).toBe(1);
    expect(result.errors).toEqual([]);
    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'learning',
        tags: ['promoted', 'root-trunk', 'project-a'],
        source: 'lazy-ide:root-trunk-promotion',
      }),
    );
    expect(mockedEmitBuffered).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'brain.promoted',
        projectId: 'project-a',
        payload: { neuronId: 'hit-1', scope: 'org' },
      }),
    );
  });

  it('skips hits below the score threshold', async () => {
    searchScopedMock.mockResolvedValue([{ ...highScoreHit, score: 0.5 }]);

    const result = await promoteToRootTrunk();

    expect(result.neuronsPromoted).toBe(0);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('skips hits with no sourceProject', async () => {
    const { sourceProject: _drop, ...noProject } = highScoreHit;
    searchScopedMock.mockResolvedValue([noProject]);

    const result = await promoteToRootTrunk();

    expect(result.neuronsPromoted).toBe(0);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('records a capture failure as an error without stopping the rest of the run', async () => {
    captureMock.mockRejectedValueOnce(new Error('capture boom'));

    const result = await promoteToRootTrunk();

    expect(result.neuronsPromoted).toBe(0);
    expect(result.errors[0]).toContain('Failed to promote neuron hit-1');
  });
});
