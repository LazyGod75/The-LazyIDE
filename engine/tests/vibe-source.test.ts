import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VibeSource, vibeSessionLogDir } from '../src/sources/vibe.js';

function makeVibeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'lb-vibe-'));
  cpSync(join(__dirname, 'fixtures', 'vibe'), home, { recursive: true });
  return home;
}

describe('VibeSource', () => {
  it('discovers sessions, subagent logs, plans and history', () => {
    const source = new VibeSource({ home: makeVibeHome() });
    const refs = source.listConversations();
    const kinds = refs.map((r) => r.kind).sort();
    // 2 session transcripts + 1 subagent + 1 plan + 1 history
    expect(refs).toHaveLength(5);
    expect(kinds).toEqual(['history', 'plan', 'subagent', 'transcript', 'transcript']);
    const transcript = refs.find((r) => r.path.includes('session_20260601_120000'));
    expect(transcript?.projectRoot).toBe('C:/proj/acme');
  });

  it('produces a transcript payload with git provenance and tool files', async () => {
    const source = new VibeSource({ home: makeVibeHome() });
    const ref = source
      .listConversations()
      .find((r) => r.kind === 'transcript' && r.path.includes('session_20260601_120000'));
    expect(ref).toBeDefined();
    const payloads = await source.readConversation(ref!);
    expect(payloads).toHaveLength(1);
    const p = payloads[0];
    expect(p.sessionId).toMatch(/^vibe-[0-9a-f]{8}$/);
    expect(p.agent).toBe('vibe');
    expect(p.gitCommit).toBe('deadbeef12345678');
    expect(p.gitBranch).toBe('main');
    expect(p.cwd).toBe('C:/proj/acme');
    expect(p.timestamp).toBe('2026-06-01T12:00:00Z');
    expect(p.filesModified).toContain('src/payments/stripe.ts');
    expect(p.text).toContain('idempot');
  });

  it('emits a compaction-summary payload with sessionParent on the child session', async () => {
    const source = new VibeSource({ home: makeVibeHome() });
    const ref = source.listConversations().find((r) => r.path.includes('session_20260601_140000'));
    const payloads = await source.readConversation(ref!);
    const compaction = payloads.find((p) => p.sourceKind === 'compaction-summary');
    expect(compaction).toBeDefined();
    expect(compaction?.sessionParent).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90');
    expect(compaction?.text).toContain('idempotency bug');
  });

  it('reads plans as decision-grade payloads and history as one payload', async () => {
    const source = new VibeSource({ home: makeVibeHome() });
    const refs = source.listConversations();
    const plan = refs.find((r) => r.kind === 'plan');
    const planPayloads = await source.readConversation(plan!);
    expect(planPayloads[0].text).toContain('deduplicate webhook events');
    expect(planPayloads[0].sourceKind).toBe('plan');

    const history = refs.find((r) => r.kind === 'history');
    const historyPayloads = await source.readConversation(history!);
    expect(historyPayloads[0].text).toContain('stripe webhook');
    expect(historyPayloads[0].text).toContain('plain text line kept as-is');
  });

  it('returns [] when the vibe home does not exist', () => {
    const source = new VibeSource({ home: join(tmpdir(), 'definitely-missing-vibe-home') });
    expect(source.listConversations()).toEqual([]);
  });

  it('self-ingest guard: skips sessions whose cwd is a lazybrain repo', async () => {
    const home = makeVibeHome();
    const source = new VibeSource({ home });
    const { readFileSync, writeFileSync } = await import('node:fs');
    const metaPath = join(home, 'logs', 'session', 'session_20260601_120000_a1b2c3d4', 'meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    meta.environment.working_directory = 'C:/Users/x/Documents/cerveau/LazyBrain';
    writeFileSync(metaPath, JSON.stringify(meta), 'utf8');
    const ref = source
      .listConversations()
      .find((r) => r.path.includes('session_20260601_120000') && r.kind === 'transcript');
    expect(await source.readConversation(ref!)).toEqual([]);
  });

  // Task 6c: /clear lineage (v2.9.4) — parent_session_id absent — graceful degradation
  it('emits no sessionParent when meta has no parent_session_id (post-/clear chain end)', async () => {
    const home = makeVibeHome();
    const { readFileSync: rf, writeFileSync: wf } = await import('node:fs');
    const metaPath = join(home, 'logs', 'session', 'session_20260601_140000_99887766', 'meta.json');
    const meta = JSON.parse(rf(metaPath, 'utf8'));
    // v2.9.4 /clear: parent_session_id absent (chain ends)
    delete meta.parent_session_id;
    wf(metaPath, JSON.stringify(meta), 'utf8');
    const source = new VibeSource({ home });
    const ref = source.listConversations().find((r) => r.path.includes('session_20260601_140000'));
    const payloads = await source.readConversation(ref!);
    // The compaction summary payload should still be produced but with no sessionParent
    const compaction = payloads.find((p) => p.sourceKind === 'compaction-summary');
    expect(compaction).toBeDefined();
    expect(compaction?.sessionParent).toBeUndefined();
  });
});

// Task 6d: vibeSessionLogDir resolves relative save_dir against VIBE_HOME, not cwd
describe('vibeSessionLogDir', () => {
  it('returns the default when no config.toml exists', () => {
    const home = mkdtempSync(join(tmpdir(), 'lb-vsld-'));
    expect(vibeSessionLogDir(home)).toBe(join(home, 'logs', 'session'));
  });

  it('resolves an absolute save_dir as-is', () => {
    const home = mkdtempSync(join(tmpdir(), 'lb-vsld-'));
    const absDir = join(tmpdir(), 'my-vibe-logs');
    writeFileSync(
      join(home, 'config.toml'),
      `[session_logging]\nsave_dir = "${absDir.replace(/\\/g, '/')}"`,
      'utf8',
    );
    expect(vibeSessionLogDir(home)).toBe(absDir.replace(/\\/g, '/'));
  });

  it('resolves a relative save_dir against VIBE_HOME (not process.cwd)', () => {
    const home = mkdtempSync(join(tmpdir(), 'lb-vsld-'));
    writeFileSync(join(home, 'config.toml'), '[session_logging]\nsave_dir = "custom/logs"', 'utf8');
    const result = vibeSessionLogDir(home);
    expect(result).toBe(join(home, 'custom', 'logs'));
    // Ensure it is NOT relative to process.cwd()
    expect(result).not.toBe(join(process.cwd(), 'custom', 'logs'));
  });

  it('falls back to default on unparseable config.toml', () => {
    const home = mkdtempSync(join(tmpdir(), 'lb-vsld-'));
    writeFileSync(join(home, 'config.toml'), 'not valid toml [[[', 'utf8');
    expect(vibeSessionLogDir(home)).toBe(join(home, 'logs', 'session'));
  });
});
