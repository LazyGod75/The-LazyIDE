import { describe, it, expect } from 'vitest';
import { compressMessages, cavemanCompress } from '../lib/compression';
import { applyOutputStyles, OUTPUT_STYLE_CATALOG } from '../lib/assistant/outputStyles';

describe('compression — caveman engine', () => {
  it('returns messages unchanged when disabled', () => {
    const msgs = [{ role: 'user', content: 'Please make sure to fix the bug.' }];
    const result = cavemanCompress(msgs, { enabled: false });
    expect(result.compressed).toBe(false);
    expect(result.messages[0].content).toBe('Please make sure to fix the bug.');
  });

  it('removes pleasantries and filler', () => {
    const msgs = [
      { role: 'user', content: 'Thank you so much, I was wondering if you could please help me fix the database configuration issue.' },
    ];
    const result = cavemanCompress(msgs, { enabled: true, intensity: 'full' });
    expect(result.compressed).toBe(true);
    expect(result.messages[0].content).not.toContain('Thank you so much');
    expect(result.messages[0].content).not.toContain('I was wondering');
    expect(result.messages[0].content).not.toContain('please');
  });

  it('preserves code blocks byte-perfect', () => {
    const code = '```ts\nconst x: number = 42;\nconsole.log(x);\n```';
    const msgs = [
      { role: 'user', content: `Please help me with this code:\n\n${code}\n\nThanks!` },
    ];
    const result = cavemanCompress(msgs, { enabled: true, intensity: 'full' });
    expect(result.messages[0].content).toContain(code);
    expect(result.messages[0].content).not.toContain('Thanks');
  });

  it('preserves URLs and paths', () => {
    const msgs = [
      { role: 'user', content: 'Please check https://example.com/api/v2 and /src/lib/index.ts' },
    ];
    const result = cavemanCompress(msgs, { enabled: true, intensity: 'full' });
    expect(result.messages[0].content).toContain('https://example.com/api/v2');
    expect(result.messages[0].content).toContain('/src/lib/index.ts');
  });

  it('applies ultra abbreviations at ultra intensity', () => {
    const msgs = [
      { role: 'user', content: 'The database configuration function handles authentication.' },
    ];
    const result = cavemanCompress(msgs, { enabled: true, intensity: 'ultra' });
    expect(result.messages[0].content).toContain('DB');
    expect(result.messages[0].content).toContain('config');
    expect(result.messages[0].content).toContain('fn');
    expect(result.messages[0].content).toContain('auth');
  });

  it('does not apply ultra abbreviations at lite intensity', () => {
    const msgs = [
      { role: 'user', content: 'The database configuration function handles authentication.' },
    ];
    const result = cavemanCompress(msgs, { enabled: true, intensity: 'lite' });
    expect(result.messages[0].content).toContain('database');
    expect(result.messages[0].content).toContain('configuration');
  });

  it('skips messages below minMessageLength', () => {
    const msgs = [{ role: 'user', content: 'Hi' }];
    const result = cavemanCompress(msgs, { enabled: true, minMessageLength: 20 });
    expect(result.compressed).toBe(false);
  });

  it('compressMessages convenience wrapper returns stats', () => {
    const msgs = [
      { role: 'user', content: 'Thank you so much, please help me fix the database configuration.' },
    ];
    const { messages, stats, compressed } = compressMessages(msgs, { intensity: 'full' });
    expect(compressed).toBe(true);
    expect(stats.originalTokens).toBeGreaterThan(0);
    expect(stats.compressedTokens).toBeLessThanOrEqual(stats.originalTokens);
    expect(messages.length).toBe(1);
  });
});

describe('output styles', () => {
  it('injects terse-prose style into system prompt', () => {
    const prompt = 'You are a helpful assistant.';
    const result = applyOutputStyles(prompt, [{ id: 'terse-prose', level: 'full' }]);
    expect(result.applied).toBe(true);
    expect(result.systemPrompt).toContain('[Lazy Output Styles]');
    expect(result.systemPrompt).toContain('terse');
  });

  it('is idempotent — does not double-inject', () => {
    const prompt = 'You are a helpful assistant.';
    const first = applyOutputStyles(prompt, [{ id: 'terse-prose', level: 'full' }]);
    const second = applyOutputStyles(first.systemPrompt, [{ id: 'terse-prose', level: 'full' }]);
    expect(second.applied).toBe(false);
  });

  it('drops unknown style ids silently', () => {
    const prompt = 'You are a helpful assistant.';
    const result = applyOutputStyles(prompt, [{ id: 'nonexistent', level: 'full' }]);
    expect(result.applied).toBe(false);
  });

  it('injects less-code style at ultra level', () => {
    const prompt = 'You are a helpful assistant.';
    const result = applyOutputStyles(prompt, [{ id: 'less-code', level: 'ultra' }]);
    expect(result.applied).toBe(true);
    expect(result.systemPrompt).toContain('Minimal diff');
  });

  it('catalog has terse-prose, less-code, and ponytail', () => {
    expect(OUTPUT_STYLE_CATALOG['terse-prose']).toBeDefined();
    expect(OUTPUT_STYLE_CATALOG['less-code']).toBeDefined();
    expect(OUTPUT_STYLE_CATALOG['ponytail']).toBeDefined();
  });
});
