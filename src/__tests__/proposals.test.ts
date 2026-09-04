/* proposals.test.ts — real empty-state mission proposals (src/lib/agents/proposals.ts).

   Covers:
   1. Happy path: a bounded scan over a fake in-memory filesystem produces
      the expected todoFixme + missingTests proposals, with real file refs
      baked into taskText and a real quote()/sizeClassOf() attached.
   2. Each source is isolated: one source finding nothing (or its supporting
      lookup failing) still yields the other's proposal.
   3. Genuinely nothing found (or no scan root reachable) resolves to [].
   4. Defensive bounds: MAX_TODO_HITS caps the collected hit count.
   5. The resolved default model (getModelPickerOptions) actually flows into
      the attached quote (cost scales with model tier).

   getPlatform() is mocked with a tiny in-memory fs (Map-based readDir/
   readFile) rather than touching the real filesystem — same boundary
   estimator.test.ts mocks journalQuery at (proposals.ts's only two real
   collaborators are the Platform.fs abstraction and estimator.quote()).
*/

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateProposals } from '../lib/agents/proposals';
import { SIZE_CLASSES } from '../lib/agents/estimator';
import type { DirEntry } from '../lib/platform/types';
import { journalQuery } from '../lib/journal/journal';
import { getModelPickerOptions } from '../lib/models/modelPickerOptions';

vi.mock('../lib/journal/journal', () => ({
  journalQuery: vi.fn(),
}));

vi.mock('../lib/models/modelPickerOptions', () => ({
  getModelPickerOptions: vi.fn(),
}));

// ── Fake in-memory filesystem ──────────────────────────────────────────

let dirEntries: Map<string, DirEntry[]>;
let fileContents: Map<string, string>;

vi.mock('../lib/platform', () => ({
  getPlatform: () => ({
    fs: {
      readDir: (path: string) => {
        const entries = dirEntries.get(path);
        if (!entries) return Promise.reject(new Error(`ENOENT: ${path}`));
        return Promise.resolve(entries);
      },
      readFile: (path: string) => {
        const content = fileContents.get(path);
        if (content === undefined) return Promise.reject(new Error(`ENOENT: ${path}`));
        return Promise.resolve(content);
      },
    },
  }),
}));

function dir(name: string, path: string): DirEntry {
  return { name, path, isDir: true };
}
function file(name: string, path: string): DirEntry {
  return { name, path, isDir: false };
}

const mockJournalQuery = vi.mocked(journalQuery);
const mockGetModelPickerOptions = vi.mocked(getModelPickerOptions);

beforeEach(() => {
  dirEntries = new Map();
  fileContents = new Map();
  mockJournalQuery.mockReset();
  mockJournalQuery.mockResolvedValue([]);
  mockGetModelPickerOptions.mockReset();
  mockGetModelPickerOptions.mockReturnValue({
    claudeSub: true,
    pro: 'inactive',
    byok: null,
    groups: [],
    hasOptions: true,
    proExhausted: false,
    codexManaged: false,
    defaultModelId: 'claude-sonnet-5',
  });
});

/** Wires a standard /proj/src tree with 3 code files + a src/__tests__ dir
    covering only one of them, so both sources have something to find. */
function seedStandardProject() {
  dirEntries.set('/proj/src', [
    file('a.ts', '/proj/src/a.ts'),
    file('b.ts', '/proj/src/b.ts'),
    file('c.ts', '/proj/src/c.ts'),
    dir('__tests__', '/proj/src/__tests__'),
  ]);
  dirEntries.set('/proj/src/__tests__', [file('a.test.ts', '/proj/src/__tests__/a.test.ts')]);

  fileContents.set(
    '/proj/src/a.ts',
    ['export function a() {}', '// TODO: handle the edge case here', 'export const x = 1;', '// FIXME broken on windows'].join('\n'),
  );
  fileContents.set('/proj/src/b.ts', ['export function b() {}', '// TODO clean this up'].join('\n'));
  fileContents.set('/proj/src/c.ts', ['export function c() {}', 'export const y = 2;'].join('\n'));
}

// ── Happy path ──────────────────────────────────────────────────────────

describe('generateProposals — happy path', () => {
  it('produces both todoFixme and missingTests proposals from a real scan', async () => {
    seedStandardProject();

    const proposals = await generateProposals('/proj');

    expect(proposals.length).toBeLessThanOrEqual(3);
    const bySource = Object.fromEntries(proposals.map((p) => [p.source, p]));

    // a.ts has 2 markers (TODO + FIXME), b.ts has 1 -> 3 total.
    expect(bySource.todoFixme).toBeDefined();
    expect(bySource.todoFixme!.titleParams.count).toBe(3);
    expect(bySource.todoFixme!.taskText).toContain('/proj/src/a.ts');
    expect(bySource.todoFixme!.taskText).toContain('/proj/src/b.ts');

    // a.ts is covered by a.test.ts; b.ts and c.ts are not -> 2 uncovered.
    expect(bySource.missingTests).toBeDefined();
    expect(bySource.missingTests!.titleParams.count).toBe(2);
    expect(bySource.missingTests!.taskText).toContain('/proj/src/b.ts');
    expect(bySource.missingTests!.taskText).toContain('/proj/src/c.ts');
    expect(bySource.missingTests!.taskText).not.toContain('/proj/src/a.ts');
  });

  it('attaches a real quote (monotonic bounds) and a valid sizeClass to every proposal', async () => {
    seedStandardProject();
    const proposals = await generateProposals('/proj');

    expect(proposals.length).toBeGreaterThan(0);
    for (const p of proposals) {
      expect(p.quote.costUsd[0]).toBeGreaterThan(0);
      expect(p.quote.costUsd[0]).toBeLessThanOrEqual(p.quote.costUsd[1]);
      expect(p.quote.durationMin[0]).toBeLessThanOrEqual(p.quote.durationMin[1]);
      expect(p.quote.agents).toBeGreaterThanOrEqual(1);
      expect(SIZE_CLASSES).toContain(p.sizeClass);
    }
  });

  it('falls back to scanning projectRoot itself when no src/ directory exists', async () => {
    dirEntries.set('/proj', [file('main.py', '/proj/main.py')]);
    fileContents.set('/proj/main.py', '# TODO: add real logic');

    const proposals = await generateProposals('/proj');
    const todo = proposals.find((p) => p.source === 'todoFixme');
    expect(todo).toBeDefined();
    expect(todo!.taskText).toContain('/proj/main.py');
  });
});

// ── Source isolation ──────────────────────────────────────────────────

describe('generateProposals — source isolation', () => {
  it('still returns the todoFixme proposal when no src/__tests__ directory exists', async () => {
    dirEntries.set('/proj/src', [file('a.ts', '/proj/src/a.ts')]);
    fileContents.set('/proj/src/a.ts', '// TODO: fix me');
    // No '/proj/src/__tests__' entry registered -> readDir rejects for it.

    const proposals = await generateProposals('/proj');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].source).toBe('todoFixme');
  });

  it('still returns the missingTests proposal when every scanned file is unreadable (TODO scan finds nothing)', async () => {
    dirEntries.set('/proj/src', [
      file('a.ts', '/proj/src/a.ts'),
      dir('__tests__', '/proj/src/__tests__'),
    ]);
    dirEntries.set('/proj/src/__tests__', []);
    // a.ts is listed as a candidate but unreadable -> scanFileForTodos catches
    // the rejection and contributes no hits; missingTests only needs the
    // directory listing, not file content, so it is unaffected.

    const proposals = await generateProposals('/proj');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].source).toBe('missingTests');
    expect(proposals[0].titleParams.count).toBe(1);
  });

  it('resolves to [] when no candidate files are found at all', async () => {
    dirEntries.set('/proj/src', []);
    const proposals = await generateProposals('/proj');
    expect(proposals).toEqual([]);
  });

  it('resolves to [] (never throws) when the project root is completely unreachable', async () => {
    // Neither '/ghost/src' nor '/ghost' is registered -> both readDir calls reject.
    const proposals = await generateProposals('/ghost');
    expect(proposals).toEqual([]);
  });

  it('resolves to [] for an empty projectRoot without touching the platform', async () => {
    const proposals = await generateProposals('');
    expect(proposals).toEqual([]);
  });

  it('finds nothing to propose when every file has a marker-free, fully-tested counterpart', async () => {
    dirEntries.set('/proj/src', [
      file('a.ts', '/proj/src/a.ts'),
      dir('__tests__', '/proj/src/__tests__'),
    ]);
    dirEntries.set('/proj/src/__tests__', [file('a.test.ts', '/proj/src/__tests__/a.test.ts')]);
    fileContents.set('/proj/src/a.ts', 'export function a() { return 1; }');

    const proposals = await generateProposals('/proj');
    expect(proposals).toEqual([]);
  });
});

// ── Bounds ──────────────────────────────────────────────────────────────

describe('generateProposals — defensive bounds', () => {
  it('caps collected TODO/FIXME hits at 20 even when more exist', async () => {
    dirEntries.set('/proj/src', [file('big.ts', '/proj/src/big.ts')]);
    const lines = Array.from({ length: 25 }, (_, i) => `// TODO number ${i}`);
    fileContents.set('/proj/src/big.ts', lines.join('\n'));

    const proposals = await generateProposals('/proj');
    const todo = proposals.find((p) => p.source === 'todoFixme');
    expect(todo).toBeDefined();
    expect(todo!.titleParams.count).toBe(20);
  });
});

// ── Model wiring ──────────────────────────────────────────────────────

describe('generateProposals — default model wiring', () => {
  it('quotes a proposal more expensively when the resolved default model is a premium tier', async () => {
    seedStandardProject();

    mockGetModelPickerOptions.mockReturnValue({
      claudeSub: true,
      pro: 'inactive',
      byok: null,
      groups: [],
      hasOptions: true,
      proExhausted: false,
      codexManaged: false,
      defaultModelId: 'claude-haiku-4-5',
    });
    const cheap = await generateProposals('/proj');

    mockGetModelPickerOptions.mockReturnValue({
      claudeSub: true,
      pro: 'inactive',
      byok: null,
      groups: [],
      hasOptions: true,
      proExhausted: false,
      codexManaged: false,
      defaultModelId: 'claude-opus-5',
    });
    const premium = await generateProposals('/proj');

    const cheapTodo = cheap.find((p) => p.source === 'todoFixme')!;
    const premiumTodo = premium.find((p) => p.source === 'todoFixme')!;
    expect(premiumTodo.quote.costUsd[1]).toBeGreaterThan(cheapTodo.quote.costUsd[1]);
  });
});
