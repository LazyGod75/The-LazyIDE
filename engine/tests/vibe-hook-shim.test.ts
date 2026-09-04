import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SHIM = join(__dirname, '..', 'plugins', 'lazybrain', 'vibe', 'vibe-hook.mjs');

function runShim(
  stdin: string,
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SHIM], {
      env: { ...process.env, ...env, LAZYBRAIN_VIBE_HOOK_NO_SPAWN: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (c) => {
      stdout += String(c);
    });
    child.once('close', (code) => resolve({ code, stdout }));
    child.stdin.end(stdin);
  });
}

describe('vibe-hook shim', () => {
  it('POSTs the transcript path to the daemon and exits 0 with no stdout', async () => {
    const received: unknown[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += String(c);
      });
      req.on('end', () => {
        received.push({ url: req.url, body: JSON.parse(body || '{}') });
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('{"status":"ok"}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;

    const { code, stdout } = await runShim(
      JSON.stringify({
        session_id: 'abc',
        transcript_path: 'C:/tmp/messages.jsonl',
        cwd: 'C:/proj/x',
        hook_event_name: 'post_agent_turn',
      }),
      { LAZYBRAIN_PORT: String(port), LAZYBRAIN_VIBE_HOOK_ASSUME_DAEMON: '1' },
    );
    server.close();

    expect(code).toBe(0);
    expect(stdout).toBe(''); // CRITICAL: stdout must stay empty (exit-2 footgun)
    expect(received).toHaveLength(1);
    const post = received[0] as { url: string; body: Record<string, unknown> };
    expect(post.url).toBe('/capture-vibe');
    expect(post.body.transcript_path).toBe('C:/tmp/messages.jsonl');
  });

  it('exits 0 on empty transcript_path without any request', async () => {
    const { code, stdout } = await runShim(
      JSON.stringify({
        session_id: 'x',
        transcript_path: '',
        cwd: '',
        hook_event_name: 'post_agent_turn',
      }),
      { LAZYBRAIN_PORT: '1', LAZYBRAIN_VIBE_HOOK_ASSUME_DAEMON: '1' },
    );
    expect(code).toBe(0);
    expect(stdout).toBe('');
  });

  it('exits 0 even when the daemon is unreachable', async () => {
    const { code, stdout } = await runShim(
      JSON.stringify({
        session_id: 'x',
        transcript_path: 'C:/tmp/m.jsonl',
        cwd: '',
        hook_event_name: 'post_agent_turn',
      }),
      { LAZYBRAIN_PORT: '59999', LAZYBRAIN_VIBE_HOOK_ASSUME_DAEMON: '1' },
    );
    expect(code).toBe(0);
    expect(stdout).toBe('');
  });
});
