/**
 * Automated rails eval harness — CLI / Pro / free / BYOK Anthropic (stubs).
 * Structure is live-ready: swap the entitlement snapshot for a real detector.
 */

import { describe, expect, it } from 'vitest';
import { resolveEvalRail } from '../lib/brain/e2e/railsEvalHarness';
import { resolveManagerTurnMode } from '../lib/agents/managerTurnRetry';

describe('rails eval harness', () => {
  it('CLI override wins over a managed ambient mode', () => {
    expect(resolveEvalRail({
      ambientMode: 'managed',
      engineOverride: 'cli',
      hasProCredits: true,
      hasAnthropicKey: true,
    })).toBe('cli');
    expect(resolveManagerTurnMode('managed', 'cli', 'claude-code')).toBe('claude-code');
  });

  it('Pro override routes to managed when credits are live', () => {
    expect(resolveEvalRail({
      ambientMode: 'claude-code',
      engineOverride: 'pro',
      hasProCredits: true,
      hasAnthropicKey: false,
    })).toBe('pro');
    expect(resolveManagerTurnMode('claude-code', 'pro', 'claude-code')).toBe('managed');
  });

  it('empty Pro wallet does not serve the Pro rail', () => {
    expect(resolveEvalRail({
      ambientMode: 'managed',
      hasProCredits: false,
      hasAnthropicKey: false,
    })).toBe('blocked');
  });

  it('free catalog models stay on the free rail', () => {
    expect(resolveEvalRail({
      ambientMode: 'managed',
      hasProCredits: true,
      hasAnthropicKey: false,
      isFreeModel: true,
      modelId: 'z-ai/glm-5.2:free',
    })).toBe('free');
  });

  it('BYOK Anthropic wins when the key is present and no override is set', () => {
    expect(resolveEvalRail({
      ambientMode: 'byok',
      hasProCredits: false,
      hasAnthropicKey: true,
      modelId: 'claude-sonnet-5',
    })).toBe('byok-anthropic');
  });

  it('BYOK DeepSeek wins when only the DeepSeek key is present', () => {
    expect(resolveEvalRail({
      ambientMode: 'byok',
      hasProCredits: false,
      hasAnthropicKey: false,
      hasDeepseekKey: true,
      modelId: 'deepseek-chat',
    })).toBe('byok-deepseek');
  });
});
