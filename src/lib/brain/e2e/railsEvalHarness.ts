/* Isolated engine-rail eval table (CLI / Pro / free / BYOK Anthropic|DeepSeek).

   Stubs an entitlement snapshot so CI can lock routing without live secrets.
   Live path (C86): detectLiveEvalRailSnapshot() reads env / process without
   leaking secrets — only booleans + rail ids. Gate real HTTP with LIVE=1.

   BYOK historical proof path is DeepSeek (OpenAI-compatible). Anthropic
   Messages remains an optional additional probe when ANTHROPIC_API_KEY is set.
*/

export type EvalRail =
  | 'cli'
  | 'pro'
  | 'free'
  | 'byok-anthropic'
  | 'byok-deepseek'
  | 'blocked';

export interface EvalRailSnapshot {
  ambientMode: 'claude-code' | 'managed' | 'pro' | 'byok';
  engineOverride?: 'cli' | 'pro';
  hasProCredits: boolean;
  hasAnthropicKey: boolean;
  hasDeepseekKey?: boolean;
  isFreeModel?: boolean;
  modelId?: string;
}

export function resolveEvalRail(snap: EvalRailSnapshot): EvalRail {
  if (snap.engineOverride === 'cli') return 'cli';
  if (snap.engineOverride === 'pro') {
    return snap.hasProCredits ? 'pro' : 'blocked';
  }
  if (snap.isFreeModel) return 'free';
  if (snap.ambientMode === 'byok' && snap.hasAnthropicKey) return 'byok-anthropic';
  if (snap.ambientMode === 'byok' && snap.hasDeepseekKey) return 'byok-deepseek';
  if (snap.ambientMode === 'claude-code') return 'cli';
  if ((snap.ambientMode === 'managed' || snap.ambientMode === 'pro') && snap.hasProCredits) {
    return 'pro';
  }
  return 'blocked';
}

/** Env detection only — never returns key material. */
export interface LiveRailEnvPresence {
  liveFlag: boolean;
  hasAnthropicKey: boolean;
  hasDeepseekKey: boolean;
  hasOpenRouterKey: boolean;
  hasSupabase: boolean;
  cliHint: boolean;
}

function envTruthy(name: string): boolean {
  const v = process.env[name];
  return v === '1' || v === 'true' || v === 'yes';
}

function envNonEmpty(...names: string[]): boolean {
  return names.some((n) => {
    const v = process.env[n];
    return typeof v === 'string' && v.trim().length > 0;
  });
}

/**
 * Read which rails *could* be probed live from the current process env.
 * Safe to log — no secret values.
 */
export function detectLiveRailEnvPresence(): LiveRailEnvPresence {
  const cliOnPath = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
      const probe = spawnSync(
        process.platform === 'win32' ? 'where' : 'which',
        ['claude'],
        { encoding: 'utf8', windowsHide: true },
      );
      return probe.status === 0 && String(probe.stdout || '').trim().length > 0;
    } catch {
      return false;
    }
  })();
  return {
    liveFlag: envTruthy('LIVE') || envTruthy('LIVE_RAILS'),
    hasAnthropicKey: envNonEmpty('ANTHROPIC_API_KEY', 'ANTHROPIC_KEY'),
    hasDeepseekKey: envNonEmpty('DEEPSEEK_API_KEY', 'LAZY_DEEPSEEK_KEY', 'VITE_DEEPSEEK_API_KEY'),
    hasOpenRouterKey: envNonEmpty('OPENROUTER_API_KEY', 'LAZY_OPENROUTER_KEY', 'VITE_OPENROUTER_API_KEY'),
    hasSupabase: envNonEmpty('VITE_SUPABASE_URL', 'SUPABASE_URL')
      && envNonEmpty('VITE_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY'),
    cliHint: envTruthy('LIVE_CLI') || envNonEmpty('CLAUDE_CLI_PATH') || cliOnPath,
  };
}

/** Build stub-compatible snapshots for each rail we can attempt live. */
export function buildLiveRailSnapshots(presence = detectLiveRailEnvPresence()): Array<{
  rail: EvalRail;
  snap: EvalRailSnapshot;
  skipReason?: string;
}> {
  const out: Array<{ rail: EvalRail; snap: EvalRailSnapshot; skipReason?: string }> = [
    {
      rail: 'cli',
      snap: {
        ambientMode: 'claude-code',
        engineOverride: 'cli',
        hasProCredits: false,
        hasAnthropicKey: presence.hasAnthropicKey,
        hasDeepseekKey: presence.hasDeepseekKey,
      },
      skipReason: presence.cliHint || presence.hasAnthropicKey
        ? undefined
        : 'no CLAUDE_CLI_PATH / LIVE_CLI / ANTHROPIC_API_KEY',
    },
    {
      rail: 'pro',
      snap: {
        ambientMode: 'managed',
        engineOverride: 'pro',
        hasProCredits: presence.hasSupabase,
        hasAnthropicKey: false,
        hasDeepseekKey: false,
      },
      skipReason: presence.hasSupabase ? undefined : 'no Supabase env (Pro proxy)',
    },
    {
      rail: 'free',
      snap: {
        ambientMode: 'managed',
        hasProCredits: presence.hasSupabase || presence.hasOpenRouterKey,
        hasAnthropicKey: false,
        hasDeepseekKey: false,
        isFreeModel: true,
        modelId: 'z-ai/glm-5.2:free',
      },
      skipReason: (presence.hasSupabase || presence.hasOpenRouterKey)
        ? undefined
        : 'no Supabase / OpenRouter env for free catalog',
    },
    {
      rail: 'byok-anthropic',
      snap: {
        ambientMode: 'byok',
        hasProCredits: false,
        hasAnthropicKey: presence.hasAnthropicKey,
        hasDeepseekKey: false,
        modelId: 'claude-sonnet-5',
      },
      skipReason: presence.hasAnthropicKey ? undefined : 'no ANTHROPIC_API_KEY',
    },
    {
      rail: 'byok-deepseek',
      snap: {
        ambientMode: 'byok',
        hasProCredits: false,
        hasAnthropicKey: false,
        hasDeepseekKey: presence.hasDeepseekKey,
        modelId: 'deepseek-chat',
      },
      skipReason: presence.hasDeepseekKey ? undefined : 'no DEEPSEEK_API_KEY',
    },
  ];
  return out;
}

/**
 * Lightweight live probe — hits Anthropic Messages with max_tokens=1 when a
 * key is present. Never logs the key. Returns ok/skip/fail without throwing.
 */
export async function probeByokAnthropicLive(): Promise<{
  status: 'ok' | 'skip' | 'fail';
  detail: string;
}> {
  const key = (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_KEY || '').trim();
  if (!key) return { status: 'skip', detail: 'ANTHROPIC_API_KEY absent' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    if (res.ok) return { status: 'ok', detail: `HTTP ${res.status}` };
    return { status: 'fail', detail: `HTTP ${res.status}` };
  } catch (err) {
    return { status: 'fail', detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * C86 BYOK historical rail — DeepSeek OpenAI-compatible chat/completions.
 * Never logs the key. max_tokens=1 ping.
 */
export async function probeByokDeepseekLive(): Promise<{
  status: 'ok' | 'skip' | 'fail';
  detail: string;
}> {
  const key = (
    process.env.DEEPSEEK_API_KEY
    || process.env.LAZY_DEEPSEEK_KEY
    || process.env.VITE_DEEPSEEK_API_KEY
    || ''
  ).trim();
  if (!key) return { status: 'skip', detail: 'DEEPSEEK_API_KEY absent' };
  const apiUrl = (process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions').trim();
  const model = (process.env.DEEPSEEK_MODEL || 'deepseek-chat').trim();
  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    if (res.ok) return { status: 'ok', detail: `HTTP ${res.status}` };
    return { status: 'fail', detail: `HTTP ${res.status}` };
  } catch (err) {
    return { status: 'fail', detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Unified BYOK live proof: Anthropic if present, else DeepSeek (historical
 * C86 path). Never logs keys.
 */
export async function probeByokLive(): Promise<{
  status: 'ok' | 'skip' | 'fail';
  provider: 'anthropic' | 'deepseek' | 'none';
  detail: string;
}> {
  const anthropic = await probeByokAnthropicLive();
  if (anthropic.status !== 'skip') {
    return { ...anthropic, provider: 'anthropic' };
  }
  const deepseek = await probeByokDeepseekLive();
  if (deepseek.status !== 'skip') {
    return { ...deepseek, provider: 'deepseek' };
  }
  return { status: 'skip', provider: 'none', detail: 'no ANTHROPIC_API_KEY / DEEPSEEK_API_KEY' };
}

/** F111 — prove Claude CLI is callable (`claude --version`) without secrets. */
export function probeClaudeCliVersion(): {
  status: 'ok' | 'skip' | 'fail';
  detail: string;
} {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const bin = process.env.CLAUDE_CLI_PATH?.trim() || 'claude';
    const probe = spawnSync(bin, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      shell: process.platform === 'win32',
    });
    if (probe.error) {
      return { status: 'fail', detail: probe.error.message };
    }
    const out = `${probe.stdout || ''}${probe.stderr || ''}`.trim();
    if (probe.status === 0 && out.length > 0) {
      return { status: 'ok', detail: out.split(/\r?\n/)[0]!.slice(0, 120) };
    }
    return { status: 'fail', detail: `exit ${probe.status}` };
  } catch (err) {
    return { status: 'fail', detail: err instanceof Error ? err.message : String(err) };
  }
}
