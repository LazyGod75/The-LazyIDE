/**
 * Live LazyManager eval — real Claude CLI (sonnet), not mocked completions.
 *
 * Opt-in: LIVE_MANAGER=1 npx vitest run src/__tests__/liveManagerSonnet.eval.test.ts
 *
 * Why this file exists: the browser LazyManager cannot reach the free GLM without
 * a Supabase session, and cannot reach the Claude CLI (getProviderMode() is
 * always 'mock' outside Tauri, then falls through to the managed proxy).
 * This drives the SAME runManagerTurn + parseManagerActions path with a
 * real sonnet completion via `claude -p`.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return {
    ...actual,
    getProviderMode: () => 'claude-code' as const,
  };
});

vi.mock('../lib/models/claudeCodeProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/claudeCodeProvider')>();
  return {
    ...actual,
    streamClaudeCodeTurn: streamViaClaudeCli,
  };
});

vi.mock('../lib/platform', () => ({
  getPlatform: () => ({
    brain: {
      recall: async () => ({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }),
    },
  }),
}));

import { runManagerTurn } from '../lib/agents/managerEngine';
import type { ManagerMessage } from '../lib/agents/types';
import { resolveClaudeExe } from '../cli/lib/claude';

const LIVE = process.env.LIVE_MANAGER === '1';

async function* streamViaClaudeCli(opts: {
  system: string;
  messages: Array<{ role: string; content: string }>;
  model: string;
  signal?: AbortSignal;
}): AsyncIterable<string> {
  const dir = mkdtempSync(join(tmpdir(), 'lazy-mgr-live-'));
  const sysPath = join(dir, 'system.txt');
  writeFileSync(sysPath, opts.system, 'utf8');
  const user = opts.messages.map((m) => `${m.role.toUpperCase()}:\n${m.content}`).join('\n\n');
  const exe = resolveClaudeExe();
  const args = [
    '-p', user,
    '--model', 'sonnet',
    '--output-format', 'text',
    '--print',
    '--safe-mode',
    '--system-prompt-file', sysPath,
  ];

  const text = await new Promise<string>((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const onAbort = () => {
      child.kill();
      reject(new Error('claude aborted'));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (code === 0 || (stdout.trim() && code === null)) resolve(stdout);
      else reject(new Error(`claude exited ${code}: ${stderr.slice(0, 400)}\n${stdout.slice(0, 200)}`));
    });
  });

  yield text;
}

describe.skipIf(!LIVE)('live LazyManager via Claude CLI sonnet', () => {
  it('empty fleet status: honest zero, no fabricated agents, no launch_mission', async () => {
    const t0 = Date.now();
    const messages: ManagerMessage[] = [{
      id: 'u1',
      role: 'user',
      content: "Combien d'agents et de missions sont en cours ? Ne crée rien. Réponds uniquement à partir du contexte flotte réel, sans inventer de noms.",
      timestamp: new Date().toISOString(),
    }];

    const result = await runManagerTurn({
      messages,
      context: { agents: [], missions: [] },
      model: 'claude-sonnet-5',
      engineOverride: 'cli',
      maxTurns: 1,
    });

    const ms = Date.now() - t0;
    const types = result.actions.map((a) => a.type);
    const lower = `${result.responseText}\n${result.rawResponse}`.toLowerCase();
    const fabricated = /maya chen|auth\.ts|bug #342|pending_changes/.test(lower);
    const launched = types.some((t) => t === 'launch_mission' || t === 'create_agent' || t === 'create_draft');

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      bench: 'live-manager-sonnet',
      ms,
      actionTypes: types,
      responseChars: result.responseText.length,
      rawChars: result.rawResponse.length,
      fabricated,
      launched,
      responsePreview: result.responseText.slice(0, 400),
    }, null, 2));

    expect(fabricated).toBe(false);
    expect(launched).toBe(false);
    expect(result.responseText.trim().length).toBeGreaterThan(0);
  }, 180_000);
});
