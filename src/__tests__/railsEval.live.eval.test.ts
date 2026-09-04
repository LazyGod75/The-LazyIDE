/**
 * C86 / F109–F111 — live rails eval (CLI / Pro / free / BYOK Anthropic|DeepSeek).
 *
 * Opt-in:
 *   LIVE=1 npx vitest run src/__tests__/railsEval.live.eval.test.ts
 *
 * Or via helper (same gate):
 *   node scripts/eval-rails-live.mjs
 *
 * Without LIVE=1 the suite is skipped. Individual rails also skipIf their
 * env keys are absent (structure still documented by buildLiveRailSnapshots).
 *
 * BYOK: DeepSeek (OpenAI-compatible) is the historical C86 proof path;
 * Anthropic Messages is probed when ANTHROPIC_API_KEY is present.
 */

import { describe, expect, it } from 'vitest';
import {
  buildLiveRailSnapshots,
  detectLiveRailEnvPresence,
  probeByokLive,
  probeClaudeCliVersion,
  resolveEvalRail,
} from '../lib/brain/e2e/railsEvalHarness';
import { resolveManagerTurnMode } from '../lib/agents/managerTurnRetry';

const LIVE = process.env.LIVE === '1' || process.env.LIVE_RAILS === '1';
const presence = detectLiveRailEnvPresence();
const hasByokKey = presence.hasAnthropicKey || presence.hasDeepseekKey;

describe.skipIf(!LIVE)('rails eval LIVE (C86)', () => {
  it('logs which rails are reachable without leaking secrets', () => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ bench: 'rails-live-presence', presence }, null, 0));
    expect(presence.liveFlag).toBe(true);
  });

  for (const row of buildLiveRailSnapshots(presence)) {
    // Anthropic BYOK is optional: DeepSeek is the historical C86 BYOK proof.
    // Skip the row entirely (no vitest skip) when Anthropic key is absent so
    // live runs report 0 BYOK skips when DeepSeek covers the rail.
    if (row.rail === 'byok-anthropic' && !presence.hasAnthropicKey) continue;

    it.skipIf(!!row.skipReason)(
      `resolves ${row.rail} entitlement snapshot${row.skipReason ? ` (${row.skipReason})` : ''}`,
      () => {
        expect(resolveEvalRail(row.snap)).toBe(row.rail);
        if (row.rail === 'cli') {
          expect(resolveManagerTurnMode('managed', 'cli', 'claude-code')).toBe('claude-code');
        }
        if (row.rail === 'pro') {
          expect(resolveManagerTurnMode('claude-code', 'pro', 'claude-code')).toBe('managed');
        }
      },
    );
  }

  it.skipIf(!hasByokKey)(
    'probes BYOK live HTTP (Anthropic if present, else DeepSeek)',
    async () => {
      const result = await probeByokLive();
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ bench: 'rails-live-byok', result }));
      expect(result.status).not.toBe('skip');
      expect(result.status).toBe('ok');
      expect(['anthropic', 'deepseek']).toContain(result.provider);
    },
    30_000,
  );

  it.skipIf(!presence.cliHint)(
    'probes Claude CLI --version (F111 / C86 cli rail)',
    () => {
      const result = probeClaudeCliVersion();
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ bench: 'rails-live-cli', result }));
      expect(result.status).toBe('ok');
    },
  );
});

describe('rails eval LIVE structure (always on)', () => {
  it('exposes five rails with clear skip reasons when keys absent', () => {
    const rows = buildLiveRailSnapshots({
      liveFlag: false,
      hasAnthropicKey: false,
      hasDeepseekKey: false,
      hasOpenRouterKey: false,
      hasSupabase: false,
      cliHint: false,
    });
    expect(rows.map((r) => r.rail)).toEqual([
      'cli',
      'pro',
      'free',
      'byok-anthropic',
      'byok-deepseek',
    ]);
    expect(rows.every((r) => typeof r.skipReason === 'string')).toBe(true);
  });

  it('does not skip byok-deepseek when DEEPSEEK env is present', () => {
    const rows = buildLiveRailSnapshots({
      liveFlag: true,
      hasAnthropicKey: false,
      hasDeepseekKey: true,
      hasOpenRouterKey: false,
      hasSupabase: true,
      cliHint: true,
    });
    const byokDs = rows.find((r) => r.rail === 'byok-deepseek');
    expect(byokDs?.skipReason).toBeUndefined();
    expect(resolveEvalRail(byokDs!.snap)).toBe('byok-deepseek');
  });
});
