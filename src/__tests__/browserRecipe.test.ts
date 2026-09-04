/**
 * Tests for browserRecipe.ts (Mission D — generic web-surface publishing
 * via a driven browser). `invoke` is globally mocked by setup.ts; each
 * test configures it via `mockInvoke.mockImplementation`.
 *
 * Scenarios required by the mission spec:
 *   - runs a recipe against a local test "page" (simulated via mocked
 *     invoke responses — no real site is ever contacted)
 *   - stops before the step flagged `irreversible` in the default
 *     (validateOnly) mode
 *   - circuit breaker: a tripped guard aborts immediately, no retry
 *   - a failed step aborts immediately, no retry
 *   - no secret literal ever appears in what's sent to `invoke`
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { invoke, type InvokeArgs } from '@tauri-apps/api/core';
import {
  runBrowserRecipe,
  validateBrowserRecipe,
  type BrowserRecipe,
} from '../lib/agents/browserRecipe';
import { validateManagerAction } from '../lib/agents/managerActionValidator';

const mockInvoke = vi.mocked(invoke);

function okStepResult(detail: string, screenshotBase64 = 'iVBORw0KG'): string {
  return JSON.stringify({ ok: true, detail, error: null, guardTripped: null, screenshotBase64 });
}

function failStepResult(error: string): string {
  return JSON.stringify({ ok: false, detail: null, error, guardTripped: null, screenshotBase64: null });
}

function guardTrippedResult(label: string): string {
  return JSON.stringify({ ok: false, detail: null, error: null, guardTripped: label, screenshotBase64: 'proof' });
}

function baseRecipe(overrides: Partial<BrowserRecipe> = {}): BrowserRecipe {
  return {
    profileName: 'test-profile',
    headless: true,
    steps: [
      { id: 'nav', kind: 'navigate', url: 'file:///local-test-page.html' },
      { id: 'wait', kind: 'waitFor', selector: '#ready' },
      { id: 'publish', kind: 'click', selector: '#publish-button', irreversible: true },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  mockInvoke.mockReset();
});

describe('validateBrowserRecipe', () => {
  it('accepts a well-formed recipe', () => {
    expect(validateBrowserRecipe(baseRecipe())).toEqual({ ok: true });
  });

  it('rejects a missing profileName', () => {
    const result = validateBrowserRecipe(baseRecipe({ profileName: '' }));
    expect(result.ok).toBe(false);
  });

  it('rejects an empty steps array', () => {
    const result = validateBrowserRecipe(baseRecipe({ steps: [] }));
    expect(result.ok).toBe(false);
  });

  it('rejects navigate without a url', () => {
    const result = validateBrowserRecipe(baseRecipe({ steps: [{ id: 'nav', kind: 'navigate' }] }));
    expect(result.ok).toBe(false);
  });

  it('rejects fill with both value and secretEnvVar', () => {
    const result = validateBrowserRecipe(
      baseRecipe({ steps: [{ id: 'f', kind: 'fill', selector: '#x', value: 'a', secretEnvVar: 'X' }] }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown step kind', () => {
    const result = validateBrowserRecipe(
      baseRecipe({ steps: [{ id: 'x', kind: 'teleport' as unknown as 'navigate' }] }),
    );
    expect(result.ok).toBe(false);
  });
});

describe('runBrowserRecipe — generic execution against a local test page', () => {
  it('stops before the irreversible step by default (validateOnly)', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'browser_recipe_open') return 'opened';
      if (cmd === 'browser_recipe_step') return okStepResult('ok');
      if (cmd === 'browser_recipe_close') return 'closed';
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const result = await runBrowserRecipe(baseRecipe());

    expect(result.stoppedBeforeFinal).toBe(true);
    expect(result.failure).toBeNull();
    expect(result.circuitBreakerTripped).toBeNull();
    // Only the 2 non-irreversible steps ran — the "publish" click never did.
    expect(result.steps.map((s) => s.id)).toEqual(['nav', 'wait']);
    expect(result.steps.every((s) => s.ok)).toBe(true);
    // Proof screenshot is present for the last completed step.
    expect(result.steps[result.steps.length - 1].screenshotBase64).toBeTruthy();

    const stepCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'browser_recipe_step');
    expect(stepCalls).toHaveLength(2);
    expect(mockInvoke).toHaveBeenCalledWith('browser_recipe_close', { sessionId: 'test-profile' });
  });

  it('proceeds past the irreversible step when validateOnly is explicitly false', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'browser_recipe_open') return 'opened';
      if (cmd === 'browser_recipe_step') return okStepResult('ok');
      if (cmd === 'browser_recipe_close') return 'closed';
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const result = await runBrowserRecipe(baseRecipe(), { validateOnly: false });

    expect(result.stoppedBeforeFinal).toBe(false);
    expect(result.steps.map((s) => s.id)).toEqual(['nav', 'wait', 'publish']);
  });

  it('circuit breaker: a tripped guard aborts immediately, never retries', async () => {
    let stepCallCount = 0;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'browser_recipe_open') return 'opened';
      if (cmd === 'browser_recipe_step') {
        stepCallCount += 1;
        return guardTrippedResult('unexpected verification screen');
      }
      if (cmd === 'browser_recipe_close') return 'closed';
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const result = await runBrowserRecipe(
      baseRecipe({ guards: [{ label: 'unexpected verification screen', selector: '#verify' }] }),
    );

    expect(result.circuitBreakerTripped).toEqual({
      label: 'unexpected verification screen',
      afterStepId: 'nav',
    });
    expect(result.steps).toHaveLength(1);
    // Aborted after the FIRST step's guard trip — never retried, never
    // proceeded to the remaining steps.
    expect(stepCallCount).toBe(1);
    expect(mockInvoke).toHaveBeenCalledWith('browser_recipe_close', { sessionId: 'test-profile' });
  });

  it('a failed step aborts the recipe immediately without retrying', async () => {
    let stepCallCount = 0;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'browser_recipe_open') return 'opened';
      if (cmd === 'browser_recipe_step') {
        stepCallCount += 1;
        return failStepResult('selector not found: #ready');
      }
      if (cmd === 'browser_recipe_close') return 'closed';
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const result = await runBrowserRecipe(baseRecipe());

    expect(result.failure).toContain('selector not found');
    expect(result.circuitBreakerTripped).toBeNull();
    expect(stepCallCount).toBe(1);
  });

  it('closes the session even when opening fails, and reports the failure honestly', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'browser_recipe_open') throw new Error('node spawn failed');
      if (cmd === 'browser_recipe_close') return 'closed';
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const result = await runBrowserRecipe(baseRecipe());

    expect(result.failure).toContain('node spawn failed');
    expect(result.steps).toEqual([]);
    expect(mockInvoke).toHaveBeenCalledWith('browser_recipe_close', { sessionId: 'test-profile' });
  });

  it('never sends a literal secret value over invoke — only the env var name', async () => {
    const sentStepPayloads: string[] = [];
    mockInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => {
      if (cmd === 'browser_recipe_open') return 'opened';
      if (cmd === 'browser_recipe_step') {
        const recipeArgs = args as Record<string, unknown> | undefined;
        sentStepPayloads.push(String(recipeArgs?.stepJson ?? ''));
        return okStepResult('filled');
      }
      if (cmd === 'browser_recipe_close') return 'closed';
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const recipe = baseRecipe({
      steps: [
        { id: 'login', kind: 'fill', selector: '#password', secretEnvVar: 'LAZY_TEST_SOCIAL_PASSWORD' },
      ],
    });
    await runBrowserRecipe(recipe, { validateOnly: false });

    expect(sentStepPayloads).toHaveLength(1);
    const parsed = JSON.parse(sentStepPayloads[0]) as Record<string, unknown>;
    expect(parsed.secretEnvVar).toBe('LAZY_TEST_SOCIAL_PASSWORD');
    expect(parsed.value).toBeUndefined();
    expect(sentStepPayloads[0]).not.toMatch(/password123|s3cr3t/i);
  });
});

describe('run_browser_recipe manager action envelope (managerActionValidator)', () => {
  it('accepts a well-formed envelope', () => {
    const result = validateManagerAction({
      type: 'run_browser_recipe',
      recipe: baseRecipe(),
      validateOnly: true,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a missing recipe object', () => {
    const result = validateManagerAction({ type: 'run_browser_recipe', validateOnly: true });
    expect(result.ok).toBe(false);
  });

  // FIX: this used to assert the OPPOSITE (reject when omitted) via
  // requireBoolean — but validateOnly defaults to true (the safe mode,
  // RunBrowserRecipeOptions in browserRecipe.ts), so the model should never
  // be forced to spell out the default just to pass validation (efficience
  // token). Only a present-but-wrong-typed value is a real error.
  it('accepts a missing validateOnly flag (defaults to the safe true)', () => {
    const result = validateManagerAction({ type: 'run_browser_recipe', recipe: baseRecipe() });
    expect(result.ok).toBe(true);
  });

  it('rejects a non-boolean validateOnly', () => {
    const result = validateManagerAction({ type: 'run_browser_recipe', recipe: baseRecipe(), validateOnly: 'true' });
    expect(result.ok).toBe(false);
  });
});
