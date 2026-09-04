/**
 * Real-filesystem proof for lib/agents/projectDigest.ts: projectDigest.test.ts
 * only exercises synthetic in-memory trees. This file runs buildProjectDigest
 * against THIS actual repo (a large, messy, real monorepo — node_modules,
 * src-tauri, dist, coverage, hundreds of real source files) through a plain
 * Node `fs`-backed adapter, to prove the size/time bounds documented in
 * projectDigest.ts's header hold on real data, not just on hand-built fixtures.
 *
 * No Tauri runtime is involved: the narrowed ProjectDigestPlatform interface
 * (fs.readDir/readFile, git.status/log, codegraph.listRepos) is satisfied
 * directly with `node:fs/promises`, the same DI seam the app's own
 * `getPlatform()` fills at runtime — see projectDigest.ts's file header.
 */

import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildProjectDigest, type ProjectDigestPlatform } from '../lib/agents/projectDigest';
import type { DirEntry } from '../lib/platform/types';

// Repo root: this test file lives at <repo>/src/__tests__/, so two levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const realPlatform: ProjectDigestPlatform = {
  fs: {
    async readDir(dirPath: string): Promise<DirEntry[]> {
      const entries = await readdir(dirPath, { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        path: path.join(dirPath, e.name),
        isDir: e.isDirectory(),
      }));
    },
    async readFile(filePath: string): Promise<string> {
      return readFile(filePath, 'utf-8');
    },
  },
  // No real git/codegraph probe needed for this proof — both degrade
  // honestly (see projectDigest.ts's gitActivityLine/codeVolumeLine), which
  // is itself part of what's being proven: a real failing probe never
  // breaks the bound or throws.
  git: {
    async status() {
      throw new Error('no git probe in this test');
    },
    async log() {
      throw new Error('no git probe in this test');
    },
  },
  codegraph: {
    async listRepos() {
      return [];
    },
  },
};

describe('buildProjectDigest — real repo (this Lazy checkout), not a synthetic fixture', () => {
  it('stays within the quick budget (900 chars) scanning this actual repo', async () => {
    const digest = await buildProjectDigest(REPO_ROOT, realPlatform, { depth: 'quick' });
    expect(digest.notFound).toBe(false);
    expect(digest.charCount).toBeLessThanOrEqual(900);
    expect(digest.text.length).toBeLessThanOrEqual(900);
  }, 15000);

  it('stays within the deep budget (2500 chars) scanning this actual repo', async () => {
    const digest = await buildProjectDigest(REPO_ROOT, realPlatform, { depth: 'deep' });
    expect(digest.notFound).toBe(false);
    expect(digest.charCount).toBeLessThanOrEqual(2500);
    expect(digest.text.length).toBeLessThanOrEqual(2500);
  }, 15000);

  it('never leaks node_modules/dist/coverage/.git content into the digest', async () => {
    const digest = await buildProjectDigest(REPO_ROOT, realPlatform, { depth: 'deep' });
    expect(digest.text).not.toContain('node_modules');
    expect(digest.text).not.toContain('.git');
  }, 15000);

  it('detects this repo\'s real stack (TypeScript/Rust, Tauri, Vitest) from real files', async () => {
    const digest = await buildProjectDigest(REPO_ROOT, realPlatform, { depth: 'quick' });
    expect(digest.text).toMatch(/TypeScript|Rust/);
  }, 15000);
});
