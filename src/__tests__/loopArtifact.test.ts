/**
 * Tests for loopArtifact.ts — generic versioned "frozen once" artifact
 * storage (spec §4 gate 1).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  freezeLoopArtifact,
  getCurrentLoopArtifact,
  getLoopArtifactVersion,
  listLoopArtifactVersions,
} from '../lib/agents/loopArtifact';

// In-memory fake filesystem so a freeze followed by a read genuinely
// round-trips (same rationale as loopScheduler.test.ts's own fake fs: a
// trivial always-reject mock would not prove "consumed without
// regeneration").
const files = new Map<string, string>();

const readFile = vi.fn(async (path: string): Promise<string> => {
  const content = files.get(path);
  if (content === undefined) throw new Error('not found');
  return content;
});
const writeFile = vi.fn(async (path: string, content: string): Promise<void> => {
  files.set(path, content);
});
const createDir = vi.fn().mockResolvedValue(undefined);

vi.mock('../lib/platform', () => ({
  getPlatform: () => ({ fs: { readFile, writeFile, createDir } }),
}));

beforeEach(() => {
  files.clear();
  readFile.mockClear();
  writeFile.mockClear();
  createDir.mockClear();
});

const REPO = '/repo';

describe('freezeLoopArtifact / getCurrentLoopArtifact', () => {
  it('returns null when nothing has ever been frozen', async () => {
    expect(await getCurrentLoopArtifact(REPO, 'owner-1')).toBeNull();
  });

  it('freezes version 1 on the first call', async () => {
    const v1 = await freezeLoopArtifact(REPO, 'owner-1', 'template', { slides: 4 }, 'Carousel template');
    expect(v1.version).toBe(1);
    expect(v1.kind).toBe('template');
    expect(v1.content).toEqual({ slides: 4 });
  });

  it('is consumed without regeneration: reading twice returns the identical version, no extra write', async () => {
    await freezeLoopArtifact(REPO, 'owner-1', 'template', { slides: 4 });
    writeFile.mockClear();

    const read1 = await getCurrentLoopArtifact(REPO, 'owner-1');
    const read2 = await getCurrentLoopArtifact(REPO, 'owner-1');

    expect(read1).toEqual(read2);
    expect(read1?.version).toBe(1);
    // Reading is a pure read — never a write (never "regenerates" on read).
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('never mutates a previous version when a new one is frozen — append-only', async () => {
    const v1 = await freezeLoopArtifact(REPO, 'owner-1', 'template', { slides: 4 });
    const v2 = await freezeLoopArtifact(REPO, 'owner-1', 'template', { slides: 5 });

    expect(v2.version).toBe(2);
    expect(await getLoopArtifactVersion(REPO, 'owner-1', 1)).toEqual(v1);
    expect(await getLoopArtifactVersion(REPO, 'owner-1', 2)).toEqual(v2);
    expect(await getCurrentLoopArtifact(REPO, 'owner-1')).toEqual(v2);
  });

  it('keeps separate owners fully isolated', async () => {
    await freezeLoopArtifact(REPO, 'owner-a', 'template', { x: 1 });
    await freezeLoopArtifact(REPO, 'owner-b', 'template', { x: 2 });

    expect((await getCurrentLoopArtifact(REPO, 'owner-a'))?.content).toEqual({ x: 1 });
    expect((await getCurrentLoopArtifact(REPO, 'owner-b'))?.content).toEqual({ x: 2 });
  });

  it('listLoopArtifactVersions returns every version, oldest first', async () => {
    await freezeLoopArtifact(REPO, 'owner-1', 'template', { v: 1 });
    await freezeLoopArtifact(REPO, 'owner-1', 'template', { v: 2 });
    await freezeLoopArtifact(REPO, 'owner-1', 'template', { v: 3 });

    const versions = await listLoopArtifactVersions(REPO, 'owner-1');
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
  });

  it('getLoopArtifactVersion returns null for a version that was never frozen', async () => {
    await freezeLoopArtifact(REPO, 'owner-1', 'template', { v: 1 });
    expect(await getLoopArtifactVersion(REPO, 'owner-1', 42)).toBeNull();
  });

  it('is fully generic content — accepts a plain string artifact just as well as an object', async () => {
    const v1 = await freezeLoopArtifact(REPO, 'owner-tone', 'tone-of-voice', 'Direct, no filler, technical.');
    expect(v1.content).toBe('Direct, no filler, technical.');
  });
});
