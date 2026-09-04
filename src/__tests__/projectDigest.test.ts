/**
 * Tests for lib/agents/projectDigest.ts — the structural digest behind the
 * LazyManager's `scan_project` action (see qa-manager-2026-07-25/
 * UC-SCORECARD.md use cases D/E: without a way to measure a project, the
 * manager could only guess how many agents a request needed).
 *
 * Uses a small in-memory fake FileSystem/Git/CodeGraphPlatform (no Tauri,
 * no real disk) so these tests are fast, deterministic, and cover the
 * required behaviors directly:
 *   - bounded output size for 'quick' and 'deep'
 *   - artifact/dependency directories (node_modules, .git, dist, ...) never
 *     walked
 *   - truncation is announced in the text when the walk is capped
 *   - honest degrade when the root does not exist / is not readable
 */

import { describe, it, expect } from 'vitest';
import { buildProjectDigest, type ProjectDigestPlatform } from '../lib/agents/projectDigest';
import type { DirEntry, GitLogEntry, GitStatus } from '../lib/platform/types';

// ── In-memory fake filesystem ─────────────────────────────────────────────

interface VDir {
  [name: string]: VDir | string; // string value = file content
}

/** Builds a fake FileSystem over a plain nested-object tree keyed by POSIX
 *  path segments (root is always '/proj'). `tree['a']['b.ts'] = '...'` is a
 *  file; a nested object is a directory. */
function makeFakeFs(tree: VDir) {
  function resolve(path: string): VDir | string | undefined {
    const segments = path.split('/').filter(Boolean).filter((s) => s !== 'proj');
    let node: VDir | string = tree;
    for (const seg of segments) {
      if (typeof node === 'string') return undefined;
      const next: VDir | string | undefined = node[seg];
      if (next === undefined) return undefined;
      node = next;
    }
    return node;
  }

  return {
    async readDir(path: string): Promise<DirEntry[]> {
      const node = resolve(path);
      if (node === undefined || typeof node === 'string') {
        throw new Error(`ENOENT: ${path}`);
      }
      return Object.entries(node).map(([name, value]) => ({
        name,
        path: `${path.replace(/\/$/, '')}/${name}`,
        isDir: typeof value !== 'string',
      }));
    },
    async readFile(path: string): Promise<string> {
      const node = resolve(path);
      if (typeof node !== 'string') throw new Error(`ENOENT: ${path}`);
      return node;
    },
  };
}

function fakeGit(status: Partial<GitStatus> = {}, log: GitLogEntry[] = []) {
  return {
    async status(): Promise<GitStatus> {
      return { branch: 'main', ahead: 0, behind: 0, files: [], ...status };
    },
    async log(): Promise<GitLogEntry[]> {
      return log;
    },
  };
}

function fakePlatform(tree: VDir, opts: { git?: ReturnType<typeof fakeGit>; repos?: Array<{ name: string; path: string; indexedAt: number; nodeCount: number; edgeCount: number }> } = {}): ProjectDigestPlatform {
  return {
    fs: makeFakeFs(tree),
    git: opts.git ?? fakeGit(),
    codegraph: {
      async listRepos() {
        return opts.repos ?? [];
      },
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('buildProjectDigest', () => {
  it('returns an honest not-found digest for an empty root path', async () => {
    const platform = fakePlatform({});
    const digest = await buildProjectDigest('', platform);
    expect(digest.notFound).toBe(true);
    expect(digest.text.toLowerCase()).toContain('no project root');
  });

  it('returns an honest not-found digest when the root is not readable', async () => {
    const platform = fakePlatform({ 'package.json': '{}' });
    const digest = await buildProjectDigest('/does-not-exist', platform);
    expect(digest.notFound).toBe(true);
    expect(digest.text.toLowerCase()).toContain('not readable');
  });

  it('detects stack, scripts, and package manager from package.json + lockfile', async () => {
    const tree: VDir = {
      'package.json': JSON.stringify({
        scripts: { dev: 'vite', build: 'tsc', test: 'vitest', lint: 'eslint .' },
        dependencies: { react: '^19', '@tauri-apps/api': '^2' },
        devDependencies: { vite: '^5', typescript: '^5' },
      }),
      'package-lock.json': '{}',
      src: {
        'index.ts': 'export {}',
        'App.tsx': 'export {}',
      },
    };
    const platform = fakePlatform(tree);
    const digest = await buildProjectDigest('/proj', platform, { depth: 'quick' });

    expect(digest.notFound).toBe(false);
    expect(digest.text).toContain('React');
    expect(digest.text).toContain('Tauri');
    expect(digest.text).toContain('Vite');
    expect(digest.text).toContain('pkg: npm');
    expect(digest.text).toMatch(/dev|build|test|lint/);
  });

  it('never walks into ignored artifact/dependency directories', async () => {
    const tree: VDir = {
      src: { 'a.ts': 'x' },
      node_modules: { 'huge-package': { 'index.js': 'x'.repeat(10) } },
      '.git': { HEAD: 'ref: refs/heads/main' },
      dist: { 'bundle.js': 'x' },
    };
    const platform = fakePlatform(tree);
    const digest = await buildProjectDigest('/proj', platform, { depth: 'quick' });

    expect(digest.text).not.toContain('node_modules');
    expect(digest.text).not.toContain('huge-package');
    expect(digest.text).not.toContain('.git');
    expect(digest.text).not.toContain('dist');
  });

  it('announces truncation in the text and sets truncated:true when the walk is capped', async () => {
    // Build a wide tree (many top-level directories) — 'quick' budget caps
    // at 80 directories total, so 200 top-level dirs guarantees a cap.
    const tree: VDir = {};
    for (let i = 0; i < 200; i++) {
      tree[`dir${i}`] = { 'f.ts': 'x' };
    }
    const platform = fakePlatform(tree);
    const digest = await buildProjectDigest('/proj', platform, { depth: 'quick' });

    expect(digest.truncated).toBe(true);
    expect(digest.text.toLowerCase()).toContain('capped');
    expect(digest.text.toLowerCase()).toContain('lower bound');
  });

  it('stays within the quick budget (~900 chars) even on a large tree', async () => {
    const tree: VDir = {};
    for (let i = 0; i < 50; i++) {
      const dir: VDir = {};
      for (let j = 0; j < 30; j++) dir[`file${j}.ts`] = 'x';
      tree[`module${i}`] = dir;
    }
    const platform = fakePlatform(tree);
    const digest = await buildProjectDigest('/proj', platform, { depth: 'quick' });
    expect(digest.charCount).toBeLessThanOrEqual(900);
  });

  it('stays within the deep budget (~2500 chars) even on a large tree', async () => {
    const tree: VDir = {};
    for (let i = 0; i < 80; i++) {
      const dir: VDir = {};
      for (let j = 0; j < 30; j++) dir[`file${j}.ts`] = 'x';
      tree[`module${i}`] = dir;
    }
    const platform = fakePlatform(tree);
    const digest = await buildProjectDigest('/proj', platform, { depth: 'deep' });
    expect(digest.charCount).toBeLessThanOrEqual(2500);
  });

  it('produces a larger, more thorough digest for depth "deep" than "quick" on the same tree', async () => {
    const tree: VDir = {
      src: {
        components: { 'a.tsx': 'x', 'b.tsx': 'x' },
        pages: { 'index.tsx': 'x', 'about.tsx': 'x' },
      },
    };
    const platform = fakePlatform(tree);
    const quick = await buildProjectDigest('/proj', platform, { depth: 'quick' });
    const deep = await buildProjectDigest('/proj', platform, { depth: 'deep' });
    expect(quick.text).toContain('Project scan (quick)');
    expect(deep.text).toContain('Project scan (deep)');
  });

  it('reports git branch/dirty/last-commit when git succeeds', async () => {
    const platform = fakePlatform(
      { src: { 'a.ts': 'x' } },
      {
        git: fakeGit(
          { branch: 'feat/x', files: [{ path: 'a.ts', status: 'M' }] },
          [{ hash: 'abc123', subject: 'fix: something', author: 'dev', date: '2026-07-28T10:00:00Z' }],
        ),
      },
    );
    const digest = await buildProjectDigest('/proj', platform);
    expect(digest.text).toContain('branch=feat/x');
    expect(digest.text).toContain('dirty=1');
    expect(digest.text).toContain('fix: something');
  });

  it('degrades gracefully (no git section, no throw) when git fails', async () => {
    const failingGit = {
      async status(): Promise<GitStatus> {
        throw new Error('not a git repo');
      },
      async log(): Promise<GitLogEntry[]> {
        throw new Error('not a git repo');
      },
    };
    const platform = fakePlatform({ src: { 'a.ts': 'x' } }, { git: failingGit });
    const digest = await buildProjectDigest('/proj', platform);
    expect(digest.notFound).toBe(false);
    expect(digest.text).not.toContain('Git:');
  });

  it('uses the codegraph index (nodeCount/edgeCount) for code volume when a cached entry matches the root', async () => {
    const platform = fakePlatform(
      { src: { 'a.ts': 'x' } },
      { repos: [{ name: 'proj', path: '/proj', indexedAt: Date.now(), nodeCount: 12000, edgeCount: 30000 }] },
    );
    const digest = await buildProjectDigest('/proj', platform);
    expect(digest.text).toContain('indexed: 12000 symbols');
  });

  it('falls back to a file-count estimate when no codegraph index matches', async () => {
    const platform = fakePlatform({ src: { 'a.ts': 'x', 'b.ts': 'x' } });
    const digest = await buildProjectDigest('/proj', platform);
    expect(digest.text).toContain('unindexed estimate');
  });

  it('never includes raw file content in the digest', async () => {
    const secretMarker = 'THIS_SHOULD_NEVER_LEAK_INTO_THE_DIGEST';
    const tree: VDir = {
      src: { 'secret.ts': secretMarker },
      'package.json': JSON.stringify({ scripts: {}, dependencies: {} }),
    };
    const platform = fakePlatform(tree);
    const digest = await buildProjectDigest('/proj', platform);
    expect(digest.text).not.toContain(secretMarker);
  });
});
