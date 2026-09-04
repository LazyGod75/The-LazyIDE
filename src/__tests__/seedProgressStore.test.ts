/**
 * seedProgressStore.test.ts
 *
 * Regression coverage for the "dead seed-progress events" bug this store
 * exists to fix: BrainSetupStep used to own its own local
 * platform.brain.onSeedProgress() subscription tied to its own component
 * lifetime, so a seed's progress was only ever observable while that exact
 * component instance stayed mounted. This store instead tracks progress at
 * module scope, independent of any component's lifecycle — these tests
 * simulate the raw event stream a fixed backend would emit (including the
 * NEW `percent`/`imported`/`skipped`/`notesTotal`/`served` fields added to
 * the brain://seed-progress payload — see history_import.rs's
 * emit_seed_progress / the inline "done" emit) and assert the store reacts
 * to EACH event as it arrives, not just once the whole operation settles.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getSeedProgressState,
  subscribeSeedProgress,
  startSeed,
  initSeedProgressListener,
  seedProgressStateToEvent,
  resetSeedProgressForTests,
} from '../lib/brain/seedProgressStore';

// seedProgressStore imports getPlatform from '../platform' (relative to
// src/lib/brain/) — from this test file (src/__tests__/) that resolves to
// '../lib/platform', same module BrainSpace.test.tsx / assistantStore.test.tsx
// already mock this same way.
vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return {
    ...actual,
    getPlatform: vi.fn(),
  };
});

import { getPlatform } from '../lib/platform';
const mockGetPlatform = getPlatform as ReturnType<typeof vi.fn>;

type SeedProgressCallback = (p: Record<string, unknown>) => void;

/** Builds a minimal mock platform whose brain.onSeedProgress() captures the
    registered callback (returned as `emit`) so tests can simulate backend
    events, and whose brain.seedBrain() is caller-controlled via a
    resolvable/rejectable promise. */
function makeMockPlatform(seedBrainImpl?: ReturnType<typeof vi.fn>) {
  let capturedCb: SeedProgressCallback | null = null;
  const unlisten = vi.fn();
  const onSeedProgress = vi.fn((cb: SeedProgressCallback) => {
    capturedCb = cb;
    return unlisten;
  });
  const seedBrain = seedBrainImpl ?? vi.fn().mockResolvedValue({ imported: 0, skipped: 0 });

  const platform = {
    name: 'tauri',
    brain: { onSeedProgress, seedBrain },
  };

  return {
    platform,
    unlisten,
    seedBrain,
    onSeedProgress,
    /** Simulates the Rust side emitting a brain://seed-progress event. */
    emit: (payload: Record<string, unknown>) => {
      expect(capturedCb).not.toBeNull();
      capturedCb!(payload);
    },
  };
}

beforeEach(() => {
  resetSeedProgressForTests();
  vi.clearAllMocks();
});

describe('seedProgressStore — initial state', () => {
  it('starts idle', () => {
    const s = getSeedProgressState();
    expect(s.active).toBe(false);
    expect(s.phase).toBe('');
    expect(s.percent).toBe(0);
    expect(s.result).toBeNull();
    expect(s.error).toBeNull();
  });

  it('seedProgressStateToEvent returns null before any seed has ever run', () => {
    expect(seedProgressStateToEvent(getSeedProgressState())).toBeNull();
  });
});

describe('seedProgressStore — initSeedProgressListener reacts to EACH event as it arrives', () => {
  it('updates active/phase/done/total/percent/message on a plain progress event, without waiting for completion', () => {
    const { platform, emit } = makeMockPlatform();
    mockGetPlatform.mockReturnValue(platform);

    const unsub = initSeedProgressListener();

    emit({ done: 1, total: 2, phase: 'import', message: 'Importing from claude-code', percent: 45 });

    const s = getSeedProgressState();
    expect(s.active).toBe(true);
    expect(s.phase).toBe('import');
    expect(s.done).toBe(1);
    expect(s.total).toBe(2);
    expect(s.percent).toBe(45);
    expect(s.message).toBe('Importing from claude-code');
    // This is the core regression: the event was processed IMMEDIATELY,
    // not deferred until some later completion — exactly what was broken
    // before (the UI stayed frozen on its synthetic starting value for the
    // whole 40+ minute run because events never reached the frontend).

    unsub();
  });

  it('keeps the last known percent when a later event omits it', () => {
    const { platform, emit } = makeMockPlatform();
    mockGetPlatform.mockReturnValue(platform);
    initSeedProgressListener();

    emit({ done: 0, total: 2, phase: 'import', percent: 20 });
    emit({ done: 0, total: 2, phase: 'import' }); // no percent field

    expect(getSeedProgressState().percent).toBe(20);
  });

  it('a mid-run "error" phase event does NOT set the terminal error field — the backend continues past per-source failures', () => {
    const { platform, emit } = makeMockPlatform();
    mockGetPlatform.mockReturnValue(platform);
    initSeedProgressListener();

    emit({ done: 1, total: 2, phase: 'error', message: 'import exited 1 for source cursor', percent: 45 });

    const s = getSeedProgressState();
    expect(s.active).toBe(true); // still running — non-fatal
    expect(s.phase).toBe('error');
    expect(s.error).toBeNull(); // NOT the terminal error field
  });

  it('the terminal "done" event sets active=false and populates result from the additive imported/skipped fields', () => {
    const { platform, emit } = makeMockPlatform();
    mockGetPlatform.mockReturnValue(platform);
    initSeedProgressListener();

    emit({
      done: 3,
      total: 3,
      phase: 'done',
      message: 'Imported 42 notes (3 skipped) — 45 notes in brain',
      percent: 100,
      imported: 42,
      skipped: 3,
      notesTotal: 45,
      served: true,
    });

    const s = getSeedProgressState();
    expect(s.active).toBe(false);
    expect(s.percent).toBe(100);
    expect(s.result).toEqual({ imported: 42, skipped: 3 });
  });

  it('maps the post-seed pipeline phases (indexing/synthesizing/serving) through to real percents, not the source-count done/total scale', () => {
    const { platform, emit } = makeMockPlatform();
    mockGetPlatform.mockReturnValue(platform);
    initSeedProgressListener();

    emit({ done: 0, total: 3, phase: 'indexing', percent: 90 });
    expect(getSeedProgressState().percent).toBe(90);

    emit({ done: 1, total: 3, phase: 'synthesizing', percent: 94 });
    expect(getSeedProgressState().percent).toBe(94);

    emit({ done: 2, total: 3, phase: 'serving', percent: 97 });
    expect(getSeedProgressState().percent).toBe(97);
  });
});

describe('seedProgressStore — startSeed', () => {
  it('sets active=true synchronously, before seedBrain() resolves — this is what lets the caller stop awaiting it', async () => {
    let resolveSeed: (v: { imported: number; skipped: number }) => void = () => {};
    const seedBrain = vi.fn(() => new Promise<{ imported: number; skipped: number }>((resolve) => { resolveSeed = resolve; }));
    const { platform } = makeMockPlatform(seedBrain);
    mockGetPlatform.mockReturnValue(platform);

    const promise = startSeed({ sources: ['claude-code', 'cursor'], useLlm: false });

    // Synchronously true — no await needed to observe it, matching
    // BrainSetupStep's non-blocking call site (`void startSeed(...)`).
    const s = getSeedProgressState();
    expect(s.active).toBe(true);
    expect(s.phase).toBe('starting');
    expect(s.total).toBe(2);

    resolveSeed({ imported: 5, skipped: 1 });
    await promise;
  });

  it('reconciles from the resolved value as a fallback when the "done" event never arrived', async () => {
    const seedBrain = vi.fn().mockResolvedValue({ imported: 7, skipped: 2 });
    const { platform } = makeMockPlatform(seedBrain);
    mockGetPlatform.mockReturnValue(platform);

    await startSeed({ sources: ['claude-code'], useLlm: false });

    const s = getSeedProgressState();
    expect(s.active).toBe(false);
    expect(s.result).toEqual({ imported: 7, skipped: 2 });
  });

  it('does NOT override a result already delivered by the "done" event with a later resolve reconciliation', async () => {
    const { platform, emit } = makeMockPlatform(vi.fn().mockResolvedValue({ imported: 999, skipped: 999 }));
    mockGetPlatform.mockReturnValue(platform);
    initSeedProgressListener();

    const promise = startSeed({ sources: ['claude-code'], useLlm: false });
    emit({ done: 3, total: 3, phase: 'done', percent: 100, imported: 5, skipped: 1 });
    await promise;

    // The event's result (5/1) must win — not the resolved value's (999/999),
    // proving the event stream is the primary source of truth.
    expect(getSeedProgressState().result).toEqual({ imported: 5, skipped: 1 });
  });

  it('an outright seedBrain() rejection sets active=false and a non-null error', async () => {
    const seedBrain = vi.fn().mockRejectedValue(new Error('lazybrain.js not found'));
    const { platform } = makeMockPlatform(seedBrain);
    mockGetPlatform.mockReturnValue(platform);

    await startSeed({ sources: ['claude-code'], useLlm: false });

    const s = getSeedProgressState();
    expect(s.active).toBe(false);
    expect(s.error).toBe('lazybrain.js not found');
  });
});

describe('seedProgressStore — subscribeSeedProgress', () => {
  it('notifies subscribers on every applied event', () => {
    const { platform, emit } = makeMockPlatform();
    mockGetPlatform.mockReturnValue(platform);
    initSeedProgressListener();

    const seen: number[] = [];
    const unsub = subscribeSeedProgress((s) => seen.push(s.percent));

    emit({ done: 0, total: 2, phase: 'import', percent: 10 });
    emit({ done: 1, total: 2, phase: 'import', percent: 55 });

    expect(seen).toEqual([10, 55]);
    unsub();
  });

  it('unsubscribe stops further notifications', () => {
    const { platform, emit } = makeMockPlatform();
    mockGetPlatform.mockReturnValue(platform);
    initSeedProgressListener();

    const seen: number[] = [];
    const unsub = subscribeSeedProgress((s) => seen.push(s.percent));
    unsub();

    emit({ done: 0, total: 2, phase: 'import', percent: 10 });
    expect(seen).toHaveLength(0);
  });

  it('getSeedProgressState returns a snapshot, not a live reference', () => {
    const { platform, emit } = makeMockPlatform();
    mockGetPlatform.mockReturnValue(platform);
    initSeedProgressListener();

    const snap1 = getSeedProgressState();
    emit({ done: 0, total: 2, phase: 'import', percent: 33 });
    const snap2 = getSeedProgressState();

    expect(snap1.percent).toBe(0);
    expect(snap2.percent).toBe(33);
  });
});

describe('seedProgressStore — seedProgressStateToEvent', () => {
  it('adapts an active state into a SeedProgressEvent-shaped object with percent', () => {
    const { platform, emit } = makeMockPlatform();
    mockGetPlatform.mockReturnValue(platform);
    initSeedProgressListener();

    emit({ done: 1, total: 2, phase: 'import', message: 'Importing from cursor', percent: 62 });

    const evt = seedProgressStateToEvent(getSeedProgressState());
    expect(evt).toEqual({ done: 1, total: 2, phase: 'import', message: 'Importing from cursor', percent: 62 });
  });

  it('falls back to phase "starting" when phase is empty', () => {
    const evt = seedProgressStateToEvent({
      active: true, phase: '', done: 0, total: 2, percent: 0, message: '', result: null, error: null,
    });
    expect(evt?.phase).toBe('starting');
  });
});
