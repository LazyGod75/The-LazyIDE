import { describe, it, expect } from 'vitest';
import { mockProvider } from '../lib/models/mockProvider';
import type { StreamChatRequest } from '../lib/models/types';
import { DEFAULT_MODEL } from '../lib/models/registry';

function makeReq(mode: 'ask' | 'plan' | 'edit' | 'transform'): StreamChatRequest {
  return {
    messages: [{ id: 'u1', role: 'user', content: 'test' }],
    model: DEFAULT_MODEL,
    mode,
  };
}

describe('mockProvider', () => {
  it('has id "mock" and a label', () => {
    expect(mockProvider.id).toBe('mock');
    expect(mockProvider.label).toBeTruthy();
  });

  it('listModels returns all models (non-empty)', () => {
    const models = mockProvider.listModels();
    expect(models.length).toBeGreaterThan(0);
  });

  it('streamChat(ask) yields at least one chunk', async () => {
    const chunks: string[] = [];
    for await (const token of mockProvider.streamChat(makeReq('ask'))) {
      chunks.push(token);
    }
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('streamChat(plan) yields different content than ask', async () => {
    const askChunks: string[] = [];
    for await (const t of mockProvider.streamChat(makeReq('ask'))) {
      askChunks.push(t);
    }

    const planChunks: string[] = [];
    for await (const t of mockProvider.streamChat(makeReq('plan'))) {
      planChunks.push(t);
    }

    expect(askChunks.join('')).not.toBe(planChunks.join(''));
  });

  it('streamChat(edit) yields code block content', async () => {
    const chunks: string[] = [];
    for await (const t of mockProvider.streamChat(makeReq('edit'))) {
      chunks.push(t);
    }
    const full = chunks.join('');
    expect(full).toContain('```');
  });

  it('streamChat(transform) yields plain code with no conversational narration', async () => {
    // 'transform' (Ctrl+K inline-edit, auto-fix) feeds the raw accumulated
    // stream into sanitizeModelCodeOutput as if it were the whole answer —
    // unlike 'edit', which is chat narration around a fence. The mock
    // response for this mode must itself pass the sanitizer, or the
    // web-demo Ctrl+K path breaks the same way the HIGH defect did.
    const chunks: string[] = [];
    for await (const t of mockProvider.streamChat(makeReq('transform'))) {
      chunks.push(t);
    }
    const full = chunks.join('');
    expect(full).not.toContain('Voici');
    expect(full).not.toContain('```');
  });

  it('aborts early when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const req = { ...makeReq('ask'), signal: controller.signal };
    const chunks: string[] = [];
    for await (const t of mockProvider.streamChat(req)) {
      chunks.push(t);
    }
    // Should yield 0 tokens since signal was aborted at start
    expect(chunks.length).toBe(0);
  });
});
