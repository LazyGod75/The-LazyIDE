import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeSource, extractConversationChunks } from '../src/sources/claude-code.js';

function makeClaudeDir(): string {
  const home = mkdtempSync(join(tmpdir(), 'lb-cc-'));
  const proj = join(home, '.claude', 'projects', 'C--proj-acme');
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, 'conv1.jsonl'),
    [
      JSON.stringify({
        type: 'user',
        message: { content: 'We decided to use vitest for all new tests in this repo.' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Done. I migrated the suite because jest was flaky here.' },
            { type: 'tool_use', name: 'Edit', input: { file_path: 'C:/proj/acme/src/a.ts' } },
          ],
        },
      }),
    ].join('\n'),
    'utf8',
  );
  return home;
}

describe('ClaudeCodeSource', () => {
  it('discovers conversations and produces a claude payload', async () => {
    const home = makeClaudeDir();
    const source = new ClaudeCodeSource({ userProfile: home });
    const refs = source.listConversations();
    expect(refs).toHaveLength(1);
    expect(refs[0].agent).toBe('claude-code');
    expect(refs[0].projectRoot).toBe('C:/proj/acme');

    const payloads = await source.readConversation(refs[0]);
    expect(payloads).toHaveLength(1);
    expect(payloads[0].sessionId).toMatch(/^dream-[0-9a-f]{8}$/);
    expect(payloads[0].text).toContain('vitest');
    expect(payloads[0].filesModified).toContain('src/a.ts');
    expect(payloads[0].agent).toBe('claude-code');
    expect(payloads[0].sourceKind).toBe('transcript');
  });

  it('skips lazybrain project dirs by default (default-skip)', () => {
    // The shipped default skips the engine's own project to avoid self-referential noise.
    // Only non-engine projects are ingested unless opt-in is set.
    // The skip is keyed on the package name 'lazybrain' only — no personal folder names.
    const home = makeClaudeDir();
    const lazybrain = join(home, '.claude', 'projects', 'C--Users-x-LazyBrain');
    mkdirSync(lazybrain, { recursive: true });
    writeFileSync(
      join(lazybrain, 'lb-conv.jsonl'),
      JSON.stringify({
        type: 'user',
        message: { content: 'We decided to use LazyBrain for persistent memory across sessions.' },
      }),
      'utf8',
    );
    const prev = process.env.LAZYBRAIN_DREAM_INCLUDE_SELF;
    delete process.env.LAZYBRAIN_DREAM_INCLUDE_SELF;
    try {
      const source = new ClaudeCodeSource({ userProfile: home });
      const refs = source.listConversations();
      // C--Users-x-LazyBrain must be excluded; only C--proj-acme should remain
      expect(refs).toHaveLength(1);
      expect(refs[0].projectRoot).toBe('C:/proj/acme');
    } finally {
      if (prev === undefined) {
        delete process.env.LAZYBRAIN_DREAM_INCLUDE_SELF;
      } else {
        process.env.LAZYBRAIN_DREAM_INCLUDE_SELF = prev;
      }
    }
  });

  it('does NOT skip a project whose path contains an unrelated personal folder name', () => {
    // Only 'lazybrain' is the skip token — project folder names that are not code directories
    // (e.g. 'mybrain', 'workspace', 'notes') must NOT be filtered out.
    const home = makeClaudeDir();
    const personalDir = join(home, '.claude', 'projects', 'C--Users-x-cerveau-MyProject');
    mkdirSync(personalDir, { recursive: true });
    writeFileSync(
      join(personalDir, 'personal-conv.jsonl'),
      JSON.stringify({
        type: 'user',
        message: { content: 'We decided to structure the project with clean modules.' },
      }),
      'utf8',
    );
    const prev = process.env.LAZYBRAIN_DREAM_INCLUDE_SELF;
    delete process.env.LAZYBRAIN_DREAM_INCLUDE_SELF;
    try {
      const source = new ClaudeCodeSource({ userProfile: home });
      const refs = source.listConversations();
      // Both C--proj-acme AND C--Users-x-cerveau-MyProject must be present
      expect(refs.length).toBeGreaterThanOrEqual(2);
      const paths = refs.map((r) => r.projectRoot);
      expect(paths).toContain('C:/proj/acme');
      expect(paths.some((p) => /cerveau/i.test(p))).toBe(true);
    } finally {
      if (prev === undefined) {
        delete process.env.LAZYBRAIN_DREAM_INCLUDE_SELF;
      } else {
        process.env.LAZYBRAIN_DREAM_INCLUDE_SELF = prev;
      }
    }
  });

  it('includes lazybrain project dirs when LAZYBRAIN_DREAM_INCLUDE_SELF=1 (opt-in)', () => {
    // Opt-in: set LAZYBRAIN_DREAM_INCLUDE_SELF=1 to include the engine's own project (dogfood/demo).
    const home = makeClaudeDir();
    const lazybrain = join(home, '.claude', 'projects', 'C--Users-x-LazyBrain');
    mkdirSync(lazybrain, { recursive: true });
    writeFileSync(
      join(lazybrain, 'lb-conv.jsonl'),
      JSON.stringify({
        type: 'user',
        message: { content: 'We decided to use LazyBrain for persistent memory across sessions.' },
      }),
      'utf8',
    );
    const prev = process.env.LAZYBRAIN_DREAM_INCLUDE_SELF;
    process.env.LAZYBRAIN_DREAM_INCLUDE_SELF = '1';
    try {
      const source = new ClaudeCodeSource({ userProfile: home });
      // Both C--proj-acme and C--Users-x-LazyBrain must be scanned
      expect(source.listConversations().length).toBeGreaterThanOrEqual(2);
    } finally {
      if (prev === undefined) {
        delete process.env.LAZYBRAIN_DREAM_INCLUDE_SELF;
      } else {
        process.env.LAZYBRAIN_DREAM_INCLUDE_SELF = prev;
      }
    }
  });

  it('produces multiple chunks for large conversations (chunking)', async () => {
    // Create 40 unique decision messages each ~100 chars → ~4000 chars total.
    // With targetCharsPerChunk=500 this must produce multiple chunks.
    const lines = Array.from({ length: 40 }, (_, i) =>
      JSON.stringify({
        type: 'user',
        message: {
          content: `We decided to use approach-${i} because it solves the scaling problem for module-${i}.`,
        },
      }),
    );
    const content = lines.join('\n');

    // Directly test extractConversationChunks with a small target to force splitting
    const chunks = extractConversationChunks(content, 'C:/proj/chunked', 25, 500);
    expect(chunks.length).toBeGreaterThan(1);

    // Each chunk must have non-empty text
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThan(50);
    }

    // Small conversations (< targetCharsPerChunk) yield exactly 1 chunk
    const smallContent = JSON.stringify({
      type: 'user',
      message: { content: 'We decided to keep things simple for this small project.' },
    });
    const smallChunks = extractConversationChunks(smallContent, 'C:/proj/small', 25, 6000);
    expect(smallChunks).toHaveLength(1);
  });

  it('readConversation returns multiple payloads for very large conversations', async () => {
    // With the default 6000-char target, need 7000+ chars to get multiple payloads.
    // Build 80 messages × ~100 chars = ~8000 chars to guarantee splitting.
    const home = mkdtempSync(join(tmpdir(), 'lb-cc-big-'));
    const proj = join(home, '.claude', 'projects', 'C--proj-big');
    mkdirSync(proj, { recursive: true });

    const lines = Array.from({ length: 80 }, (_, i) =>
      JSON.stringify({
        type: 'user',
        message: {
          content: `We decided to use approach-${i} because it solves the scaling problem for module-${i} in our distributed system architecture.`,
        },
      }),
    );
    writeFileSync(join(proj, 'big-conv.jsonl'), lines.join('\n'), 'utf8');

    const source = new ClaudeCodeSource({ userProfile: home });
    const refs = source.listConversations();
    expect(refs).toHaveLength(1);
    const payloads = await source.readConversation(refs[0]);
    expect(payloads.length).toBeGreaterThan(1);

    // Chunk 0 keeps the base session id (dream-<8hex>)
    expect(payloads[0].sessionId).toMatch(/^dream-[0-9a-f]{8}$/);
    // Subsequent chunks get a -cN suffix
    expect(payloads[1].sessionId).toMatch(/^dream-[0-9a-f]{8}-c1$/);

    // All payloads have correct agent/sourceKind
    for (const p of payloads) {
      expect(p.agent).toBe('claude-code');
      expect(p.sourceKind).toBe('transcript');
    }
  });

  it('--include-cwd-project flag: setting LAZYBRAIN_DREAM_INCLUDE_SELF=1 enables self-ingestion', () => {
    // Simulates what `lazybrain dream --include-cwd-project` does at the CLI layer:
    // it sets LAZYBRAIN_DREAM_INCLUDE_SELF=1 before calling runDream, which
    // ClaudeCodeSource.listConversations() reads. This test validates the env-var
    // contract so refactors to the flag wiring don't silently break self-ingestion.
    const home = makeClaudeDir();
    const lazybrain = join(home, '.claude', 'projects', 'C--Users-x-lazybrain');
    mkdirSync(lazybrain, { recursive: true });
    writeFileSync(
      join(lazybrain, 'lb-self.jsonl'),
      JSON.stringify({
        type: 'user',
        message: { content: 'We decided to build the demo brain from the engine itself.' },
      }),
      'utf8',
    );
    const prev = process.env.LAZYBRAIN_DREAM_INCLUDE_SELF;
    // Simulate CLI flag: set the env var the flag writes
    process.env.LAZYBRAIN_DREAM_INCLUDE_SELF = '1';
    try {
      const source = new ClaudeCodeSource({ userProfile: home });
      const refs = source.listConversations();
      const selfIncluded = refs.some((r) => /lazybrain/i.test(r.projectRoot));
      expect(selfIncluded).toBe(true);
    } finally {
      if (prev === undefined) {
        delete process.env.LAZYBRAIN_DREAM_INCLUDE_SELF;
      } else {
        process.env.LAZYBRAIN_DREAM_INCLUDE_SELF = prev;
      }
    }
  });

  it('non-engine projects are always included regardless of LAZYBRAIN_DREAM_INCLUDE_SELF', () => {
    // Non-engine projects (no lazybrain in path) are never filtered by the self-skip guard.
    // This test confirms C--proj-acme is included whether opt-in is set or not.
    const home = makeClaudeDir();
    const prev = process.env.LAZYBRAIN_DREAM_INCLUDE_SELF;
    delete process.env.LAZYBRAIN_DREAM_INCLUDE_SELF;
    try {
      const source = new ClaudeCodeSource({ userProfile: home });
      const refs = source.listConversations();
      // C--proj-acme should always be listed (it is not the engine repo)
      expect(refs.length).toBeGreaterThanOrEqual(1);
      expect(refs[0].projectRoot).toBe('C:/proj/acme');
    } finally {
      if (prev === undefined) {
        delete process.env.LAZYBRAIN_DREAM_INCLUDE_SELF;
      } else {
        process.env.LAZYBRAIN_DREAM_INCLUDE_SELF = prev;
      }
    }
  });
});
