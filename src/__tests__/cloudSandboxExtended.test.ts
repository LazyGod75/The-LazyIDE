/* cloudSandboxExtended.test.ts — unit tests for the extended sandbox handlers
   (cloudSandboxRunCode, cloudSandboxFileSearch, cloudSandboxDownload,
   cloudSandboxUpload, cloudSandboxCommandStart, cloudSandboxCommandPoll).
*/

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolExecutionContext } from '../lib/tools/handlers/types.js';
import {
  cloudSandboxRunCode,
  cloudSandboxFileSearch,
  cloudSandboxDownload,
  cloudSandboxUpload,
  cloudSandboxCommandStart,
  cloudSandboxCommandPoll,
} from '../lib/tools/handlers/cloudSandbox.js';

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  getSolariClients: vi.fn(),
  mapSolariError: vi.fn(),
  openSandbox: vi.fn(),
  getSandbox: vi.fn(),
  releaseSandbox: vi.fn(),
}));

vi.mock('../lib/bus', () => ({ emit: mocks.emit }));
vi.mock('../lib/solari/solariClient', () => ({
  getSolariClients: mocks.getSolariClients,
  mapSolariError: mocks.mapSolariError,
}));
vi.mock('../lib/solari/solariSessions', () => ({
  openSandbox: mocks.openSandbox,
  getSandbox: mocks.getSandbox,
  releaseSandbox: mocks.releaseSandbox,
  registerRunArtifactStamper: vi.fn(),
}));

const MISSION_REQUIRED = 'ERROR: cloud_* tools require a mission context';

function makeCtx(missionId?: string): ToolExecutionContext {
  return {
    rootPath: '/repo',
    policy: {} as ToolExecutionContext['policy'],
    agentMode: 'auto',
    missionId,
  };
}

function makeSandboxHandle(id = 'sbx_1') {
  return {
    sandbox: {
      sandboxId: id,
      id,
      files: {
        readText: vi.fn().mockResolvedValue('file content'),
        list: vi.fn().mockResolvedValue([{ name: 'a.txt', dir: false, size: 10 }]),
        write: vi.fn().mockResolvedValue(undefined),
        upload: vi.fn().mockResolvedValue(undefined),
        search: vi.fn().mockResolvedValue([]),
      },
      commands: {
        run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'out', stderr: '' }),
        start: vi.fn(),
      },
      previewUrl: vi.fn().mockResolvedValue({ url: 'https://preview.example.com' }),
      runCode: vi.fn().mockResolvedValue({ results: [], charts: [] }),
      createCodeContext: vi.fn().mockResolvedValue('ctx_default'),
      downloadUrl: vi.fn().mockResolvedValue({ url: 'https://download.example.com', expiresAt: '2026-01-01T00:00:00Z' }),
    },
    close: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mapSolariError.mockImplementation((err: unknown) => ({
    userMessage:
      err instanceof Error && err.name === 'SolariNotConfiguredError'
        ? 'Your Solari API key is invalid or missing — set it in Settings > Solari.'
        : 'An unexpected Solari error occurred — retry or contact support.',
  }));
});

describe('cloud sandbox extended handlers', () => {
  it('cloudSandboxRunCode runs python and returns stdout text', async () => {
    const handle = makeSandboxHandle('sbx_run');
    mocks.getSandbox.mockReturnValue(handle);
    handle.sandbox.runCode.mockResolvedValue({
      results: [{ type: 'stdout', text: 'hello world' }],
      charts: [],
    });

    const result = await cloudSandboxRunCode({ code: 'print("hello world")', language: 'python' }, makeCtx('m_run'));

    expect(handle.sandbox.createCodeContext).toHaveBeenCalledWith('python');
    expect(handle.sandbox.runCode).toHaveBeenCalledWith('print("hello world")', {
      language: 'python',
      contextId: 'ctx_default',
    });
    expect(result).toBe('hello world');
  });

  it('cloudSandboxRunCode emits browser:stateChange for png results and summarizes charts', async () => {
    const handle = makeSandboxHandle('sbx_chart');
    mocks.getSandbox.mockReturnValue(handle);
    handle.sandbox.runCode.mockResolvedValue({
      results: [{ type: 'result', png: 'abc123', chart: { type: 'line', title: 'Sales' } }],
      charts: [{ type: 'line', title: 'Sales' }],
    });

    const result = await cloudSandboxRunCode({ code: 'plt.plot()' }, makeCtx('m_chart'));

    expect(mocks.emit).toHaveBeenCalledWith(
      'browser:stateChange',
      expect.objectContaining({
        missionId: 'm_chart',
        isOpen: true,
        title: 'Sandbox chart',
        lastAction: 'cloud_sandbox_run_code',
        screenshotDataUrl: 'data:image/png;base64,abc123',
      }),
    );
    expect(result).toContain('[chart] line Sales');
    expect(result).toContain('Chart: line - Sales');
  });

  it('cloudSandboxRunCode reuses the per-mission default context_id', async () => {
    const handle = makeSandboxHandle('sbx_ctx');
    mocks.getSandbox.mockReturnValue(handle);
    handle.sandbox.createCodeContext.mockResolvedValue('ctx_python');
    handle.sandbox.runCode.mockResolvedValue({ results: [], charts: [] });

    await cloudSandboxRunCode({ code: 'a = 1' }, makeCtx('m_ctx'));
    expect(handle.sandbox.createCodeContext).toHaveBeenCalledTimes(1);

    await cloudSandboxRunCode({ code: 'print(a)' }, makeCtx('m_ctx'));
    expect(handle.sandbox.createCodeContext).toHaveBeenCalledTimes(1);
    expect(handle.sandbox.runCode).toHaveBeenLastCalledWith('print(a)', {
      language: 'python',
      contextId: 'ctx_python',
    });
  });

  it('cloudSandboxRunCode falls back to commands.run when the code.* path throws', async () => {
    const handle = makeSandboxHandle('sbx_fb');
    mocks.getSandbox.mockReturnValue(handle);
    handle.sandbox.createCodeContext.mockRejectedValue(
      Object.assign(new Error('Action "code.context.create" timed out'), {
        name: 'TimeoutError',
        method: 'code.context.create',
      }),
    );
    handle.sandbox.commands.run.mockResolvedValue({ exitCode: 0, stdout: '0 1 1 2 3', stderr: '' });

    const result = await cloudSandboxRunCode(
      { code: 'print("x")', language: 'python' },
      makeCtx('m_fb'),
    );

    expect(handle.sandbox.files.write).toHaveBeenCalledWith(
      expect.stringMatching(/^\/tmp\/lazy_code_.*\.py$/),
      'print("x")',
    );
    expect(handle.sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringMatching(/^python3 "\/tmp\/lazy_code_.*\.py"$/),
    );
    expect(result).toContain('kernel unavailable');
    expect(result).toContain('stdout: 0 1 1 2 3');
  });

  it('cloudSandboxRunCode skips the kernel path once it proved dead for the mission', async () => {
    const handle = makeSandboxHandle('sbx_dead');
    mocks.getSandbox.mockReturnValue(handle);
    handle.sandbox.createCodeContext.mockRejectedValue(new Error('kernel refused'));
    handle.sandbox.commands.run.mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' });

    await cloudSandboxRunCode({ code: 'print(1)' }, makeCtx('m_dead'));
    await cloudSandboxRunCode({ code: 'print(2)' }, makeCtx('m_dead'));

    // The second call must not re-attempt code.context.create — the kernel is
    // already marked dead for this mission.
    expect(handle.sandbox.createCodeContext).toHaveBeenCalledTimes(1);
    expect(handle.sandbox.runCode).not.toHaveBeenCalled();
    expect(handle.sandbox.commands.run).toHaveBeenCalledTimes(2);
  });

  it('cloudSandboxRunCode falls back when the kernel call hangs past the deadline', async () => {
    vi.useFakeTimers();
    try {
      const handle = makeSandboxHandle('sbx_hang');
      mocks.getSandbox.mockReturnValue(handle);
      handle.sandbox.createCodeContext.mockReturnValue(new Promise(() => {}));
      handle.sandbox.commands.run.mockResolvedValue({ exitCode: 0, stdout: 'fib', stderr: '' });

      const pending = cloudSandboxRunCode({ code: 'print(1)' }, makeCtx('m_hang'));
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await pending;

      expect(result).toContain('kernel unavailable');
      expect(result).toContain('stdout: fib');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cloudSandboxFileSearch validates the query argument', async () => {
    const result = await cloudSandboxFileSearch({}, makeCtx('m_search'));
    expect(result).toContain('No query provided');
  });

  it('cloudSandboxFileSearch returns formatted matches with defaults', async () => {
    const handle = makeSandboxHandle('sbx_search');
    mocks.getSandbox.mockReturnValue(handle);
    handle.sandbox.files.search.mockResolvedValue([
      { path: '/workspace/f.py', line: 2, text: 'def x():' },
    ]);

    const result = await cloudSandboxFileSearch({ query: 'def' }, makeCtx('m_search2'));

    expect(handle.sandbox.files.search).toHaveBeenCalledWith('/workspace', 'def', 50);
    expect(result).toContain('/workspace/f.py:2: def x():');
  });

  it('cloudSandboxDownload returns a signed URL and expiry', async () => {
    const handle = makeSandboxHandle('sbx_dl');
    mocks.getSandbox.mockReturnValue(handle);

    const result = await cloudSandboxDownload({ path: '/workspace/data.csv' }, makeCtx('m_dl'));

    expect(handle.sandbox.downloadUrl).toHaveBeenCalledWith('/workspace/data.csv');
    expect(result).toContain('https://download.example.com');
    expect(result).toContain('Expires: 2026-01-01T00:00:00Z');
  });

  it('cloudSandboxUpload writes utf8 content through files.upload', async () => {
    const handle = makeSandboxHandle('sbx_up');
    mocks.getSandbox.mockReturnValue(handle);

    const result = await cloudSandboxUpload(
      { path: '/workspace/x.txt', content: 'hello' },
      makeCtx('m_up'),
    );

    expect(handle.sandbox.files.upload).toHaveBeenCalledWith('/workspace/x.txt', 'hello');
    expect(result).toContain('Wrote 5 bytes');
  });

  it('cloudSandboxCommandStart and cloudSandboxCommandPoll track a background command lifecycle', async () => {
    const handle = makeSandboxHandle('sbx_cmd');
    mocks.getSandbox.mockReturnValue(handle);

    let resolveWait: (value: number) => void = () => {};
    const waitPromise = new Promise<number>((resolve) => {
      resolveWait = resolve;
    });
    let onDataCb: ((chunk: { stream: 'stdout' | 'stderr'; data: string }) => void) | undefined;
    const cmdHandle = {
      cmdId: 'cmd_1',
      onData: vi.fn((cb) => {
        onDataCb = cb;
      }),
      wait: vi.fn().mockReturnValue(waitPromise),
      kill: vi.fn(),
    };
    handle.sandbox.commands.start.mockResolvedValue(cmdHandle);

    const startResult = await cloudSandboxCommandStart(
      { command: 'python', args: ['-u', 'script.py'], cwd: '/workspace' },
      makeCtx('m_cmd'),
    );

    expect(startResult).toContain('cmd_1');
    expect(handle.sandbox.commands.start).toHaveBeenCalledWith('python', {
      args: ['-u', 'script.py'],
      cwd: '/workspace',
    });

    let poll = await cloudSandboxCommandPoll({ cmd_id: 'cmd_1' }, makeCtx('m_cmd'));
    expect(poll).toContain('[running]');

    onDataCb!({ stream: 'stdout', data: 'hello' });
    poll = await cloudSandboxCommandPoll({ cmd_id: 'cmd_1' }, makeCtx('m_cmd'));
    expect(poll).toContain('stdout: hello');

    resolveWait(0);
    await new Promise((r) => setTimeout(r, 0));
    poll = await cloudSandboxCommandPoll({ cmd_id: 'cmd_1' }, makeCtx('m_cmd'));
    expect(poll).toContain('[done] exit: 0');
  });

  it.each([
    ['cloudSandboxRunCode', cloudSandboxRunCode],
    ['cloudSandboxFileSearch', cloudSandboxFileSearch],
    ['cloudSandboxDownload', cloudSandboxDownload],
    ['cloudSandboxUpload', cloudSandboxUpload],
    ['cloudSandboxCommandStart', cloudSandboxCommandStart],
    ['cloudSandboxCommandPoll', cloudSandboxCommandPoll],
  ])('%s requires a mission context', async (_name, handler) => {
    await expect(handler({}, makeCtx())).resolves.toBe(MISSION_REQUIRED);
  });
});
