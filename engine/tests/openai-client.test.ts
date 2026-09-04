import { type Server, createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { callOpenAi, callOpenAiJsonArray } from '../src/util/openai-client.js';

let server: Server | null = null;

function stub(handler: (body: Record<string, unknown>) => unknown): Promise<number> {
  return new Promise((resolveStarted) => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += String(c);
      });
      req.on('end', () => {
        expect(req.url).toBe('/v1/chat/completions');
        const response = handler(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolveStarted((server!.address() as { port: number }).port);
    });
  });
}

afterEach(() => {
  server?.close();
  server = null;
});

describe('callOpenAi', () => {
  it('sends an OpenAI chat-completions request and returns the text', async () => {
    let captured: Record<string, unknown> = {};
    const port = await stub((body) => {
      captured = body;
      return { choices: [{ message: { content: 'hello from devstral' } }] };
    });
    const out = await callOpenAi('Summarize this.', {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'devstral',
      system: 'You summarize.',
    });
    expect(out).toBe('hello from devstral');
    expect(captured.model).toBe('devstral');
    const messages = captured.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: 'system', content: 'You summarize.' });
    expect(messages[1].role).toBe('user');
  });

  it('returns null on transport errors', async () => {
    const out = await callOpenAi('x', { baseUrl: 'http://127.0.0.1:1/v1', timeoutMs: 300 });
    expect(out).toBeNull();
  });
});

describe('callOpenAiJsonArray', () => {
  it('parses a fenced JSON array reply', async () => {
    const port = await stub(() => ({
      choices: [{ message: { content: '```json\n[{"text":"fact one."}]\n```' } }],
    }));
    const out = await callOpenAiJsonArray<{ text: string }>('extract', {
      baseUrl: `http://127.0.0.1:${port}/v1`,
    });
    expect(out).toEqual([{ text: 'fact one.' }]);
  });
});
