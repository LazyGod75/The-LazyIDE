import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetValidatorCacheForTests } from '../src/capture/validator.js';
import { runCaptureVibe } from '../src/commands/capture-vibe.js';
import { closeDb } from '../src/indexer/fts.js';
import { resetConfigForTests } from '../src/util/config.js';

describe('runCaptureVibe', () => {
  let brain: string;
  let vibeHome: string;
  let transcript: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    brain = mkdtempSync(join(tmpdir(), 'lb-brain-'));
    vibeHome = mkdtempSync(join(tmpdir(), 'lb-vh-'));
    cpSync(join(__dirname, 'fixtures', 'vibe'), vibeHome, { recursive: true });
    transcript = join(
      vibeHome,
      'logs',
      'session',
      'session_20260601_120000_a1b2c3d4',
      'messages.jsonl',
    );
    process.env.LAZYBRAIN_BRAIN_PATH = brain;
    process.env.LAZYBRAIN_CACHE_PATH = join(brain, '_cache');
    resetConfigForTests();
  });

  afterEach(() => {
    closeDb();
    resetValidatorCacheForTests();
    process.env = { ...savedEnv };
    resetConfigForTests();
  });

  it('captures a transcript and advances the cursor', async () => {
    const first = JSON.parse(await runCaptureVibe({ transcriptPath: transcript }));
    expect(first.status).toBe('ok');
    expect(first.processedMessages).toBe(5);

    const second = JSON.parse(await runCaptureVibe({ transcriptPath: transcript }));
    expect(second.status).toBe('noop');
  });

  it('processes only appended messages on subsequent calls', async () => {
    await runCaptureVibe({ transcriptPath: transcript });
    appendFileSync(
      transcript,
      `${JSON.stringify({
        role: 'user',
        content:
          'Important: never retry a webhook event without checking the idempotency store first.',
      })}\n`,
      'utf8',
    );
    const result = JSON.parse(await runCaptureVibe({ transcriptPath: transcript }));
    expect(result.status).toBe('ok');
    expect(result.processedMessages).toBe(1);
  });

  it('no-ops on empty transcript path', async () => {
    const result = JSON.parse(await runCaptureVibe({ transcriptPath: '' }));
    expect(result.status).toBe('noop');
  });

  it('refreshes the project AGENTS.md after a successful capture (debounced)', async () => {
    process.env.LAZYBRAIN_VIBE_REFRESH_SECONDS = '0';
    const projDir = mkdtempSync(join(tmpdir(), 'lb-proj-'));
    // Point the transcript's meta cwd at our temp project dir
    const sessionDir = join(vibeHome, 'logs', 'session', 'session_20260601_120000_a1b2c3d4');
    const metaPath = join(sessionDir, 'meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    meta.environment.working_directory = projDir.replace(/\\/g, '/');
    writeFileSync(metaPath, JSON.stringify(meta), 'utf8');

    const result = JSON.parse(await runCaptureVibe({ transcriptPath: transcript }));
    expect(result.status).toBe('ok');
    // The refresh is fire-and-forget — poll up to 2s for the file
    const agentsMd = join(projDir, 'AGENTS.md');
    const deadline = Date.now() + 2000;
    while (!existsSync(agentsMd) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(existsSync(agentsMd)).toBe(true);
    expect(readFileSync(agentsMd, 'utf8')).toContain('lazybrain:begin');
  });
});
