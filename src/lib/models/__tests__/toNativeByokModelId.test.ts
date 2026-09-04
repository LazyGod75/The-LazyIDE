import { describe, expect, it } from 'vitest';
import { resolveByokDef, toNativeByokModelId } from '../byokProviders';

describe('toNativeByokModelId', () => {
  // Regression (2026-08-03, mission M1): CHEAP_MODEL "deepseek/deepseek-v4-flash"
  // reached the native DeepSeek API unmangled -> 400 invalid_request_error.
  it('strips the vendor prefix for the native DeepSeek provider', () => {
    const deepseek = resolveByokDef('deepseek')!;
    expect(toNativeByokModelId(deepseek, 'deepseek/deepseek-v4-flash')).toBe('deepseek-v4-flash');
  });

  it('keeps native catalog ids unchanged', () => {
    const deepseek = resolveByokDef('deepseek')!;
    expect(toNativeByokModelId(deepseek, 'deepseek-chat')).toBe('deepseek-chat');
    expect(toNativeByokModelId(deepseek, 'deepseek-reasoner')).toBe('deepseek-reasoner');
  });

  it('keeps the vendor prefix for OpenRouter', () => {
    const openrouter = resolveByokDef('openrouter')!;
    expect(toNativeByokModelId(openrouter, 'deepseek/deepseek-v4-flash')).toBe('deepseek/deepseek-v4-flash');
  });

  it('leaves prefix-less ids untouched on any provider', () => {
    const openai = resolveByokDef('openai');
    if (openai) expect(toNativeByokModelId(openai, 'gpt-5.4-mini')).toBe('gpt-5.4-mini');
  });
});
