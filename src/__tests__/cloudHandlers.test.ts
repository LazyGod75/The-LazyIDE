/* cloudHandlers.test.ts — unit tests for the cloud_* tool handlers
   (src/lib/tools/handlers/cloud*.ts).

   The three SDK packages, the solariSessions/solariClient layers and the event
   bus are mocked; sessions live in in-memory handles so no network or disk is
   touched.
*/

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolExecutionContext } from '../lib/tools/handlers/types.js';
import {
  cloudBrowserOpen,
  cloudBrowserClose,
  cloudBrowserNavigate,
  cloudBrowserReadPage,
  cloudBrowserClick,
  cloudBrowserType,
  cloudBrowserScreenshot,
  cloudBrowserScroll,
  cloudBrowserWait,
  cloudBrowserReplayUrl,
  cloudBrowserProfilesList,
  cloudBrowserProfileSave,
} from '../lib/tools/handlers/cloudBrowser.js';
import {
  cloudDesktopOpen,
  cloudDesktopClose,
  cloudDesktopScreenshot,
  cloudDesktopStreamUrl,
  cloudDesktopMouseClick,
  cloudDesktopMouseMove,
  cloudDesktopKeyboardType,
  cloudDesktopKeyboardHotkey,
  cloudDesktopExec,
  cloudDesktopClipboardGet,
  cloudDesktopClipboardSet,
  cloudDesktopFileWrite,
} from '../lib/tools/handlers/cloudDesktop.js';
import {
  cloudSandboxOpen,
  cloudSandboxClose,
  cloudSandboxReadFile,
  cloudSandboxFileList,
  cloudSandboxWriteFile,
  cloudSandboxExec,
  cloudSandboxPreviewUrl,
} from '../lib/tools/handlers/cloudSandbox.js';

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  getSolariClients: vi.fn(),
  mapSolariError: vi.fn(),
  openBrowserSession: vi.fn(),
  getBrowserSession: vi.fn(),
  releaseBrowser: vi.fn(),
  openSandbox: vi.fn(),
  getSandbox: vi.fn(),
  releaseSandbox: vi.fn(),
  ensureAgentComputer: vi.fn(),
  acquireAgentComputer: vi.fn(),
  releaseAgentComputer: vi.fn(),
}));

vi.mock('../lib/bus', () => ({ emit: mocks.emit }));
vi.mock('../lib/solari/solariClient', () => ({
  getSolariClients: mocks.getSolariClients,
  mapSolariError: mocks.mapSolariError,
}));
vi.mock('../lib/solari/solariSessions', () => ({
  openBrowserSession: mocks.openBrowserSession,
  getBrowserSession: mocks.getBrowserSession,
  releaseBrowser: mocks.releaseBrowser,
  openSandbox: mocks.openSandbox,
  getSandbox: mocks.getSandbox,
  releaseSandbox: mocks.releaseSandbox,
  ensureAgentComputer: mocks.ensureAgentComputer,
  acquireAgentComputer: mocks.acquireAgentComputer,
  releaseAgentComputer: mocks.releaseAgentComputer,
}));
vi.mock('../lib/bots/botEngine', () => ({
  botIdForMission: vi.fn(() => undefined),
}));

const MISSION_REQUIRED = 'ERROR: cloud_* tools require a mission context';

type CloudHandler = (args: Record<string, unknown>, ctx: ToolExecutionContext) => Promise<string>;

function makeCtx(missionId?: string): ToolExecutionContext {
  return {
    rootPath: '/repo',
    policy: {} as ToolExecutionContext['policy'],
    agentMode: 'auto',
    missionId,
  };
}

function makePage() {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    title: vi.fn().mockResolvedValue('Example'),
    content: vi.fn().mockResolvedValue('<html>content</html>'),
    accessibility: { snapshot: vi.fn().mockResolvedValue(null) },
    click: vi.fn().mockResolvedValue(undefined),
    getByText: vi.fn(() => ({ click: vi.fn().mockResolvedValue(undefined) })),
    fill: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockResolvedValue('https://example.com'),
    screenshot: vi.fn().mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
    mouse: { wheel: vi.fn().mockResolvedValue(undefined) },
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    context: vi.fn(() => ({ storageState: vi.fn().mockResolvedValue({ cookies: [] }) })),
  };
}

function makeBrowserHandle(id = 'ses_1') {
  const page = makePage();
  const browser = {
    contexts: vi.fn(() => [{ pages: () => [page] }]),
    newPage: vi.fn().mockResolvedValue(page),
  };
  return { sessionId: id, browser, close: vi.fn().mockResolvedValue(undefined) };
}

function makeSandboxHandle(id = 'sbx_1') {
  const sandbox = {
    sandboxId: id,
    id,
    files: {
      readText: vi.fn().mockResolvedValue('file content'),
      list: vi.fn().mockResolvedValue([{ name: 'a.txt', dir: false, size: 10 }]),
      write: vi.fn().mockResolvedValue(undefined),
    },
    commands: { run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'out', stderr: '' }) },
    previewUrl: vi.fn().mockResolvedValue({ url: 'https://preview.example.com' }),
  };
  return { sandbox, close: vi.fn().mockResolvedValue(undefined) };
}

function makeDesktopHandle(id = 'dsk_1') {
  const desktop = {
    desktopId: id,
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'out', stderr: '' }),
    screenshot: vi.fn().mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
    stream: { start: vi.fn().mockResolvedValue({ streamUrl: 'wss://vnc.example.com', token: 'tok' }) },
    mouse: { click: vi.fn().mockResolvedValue(undefined), move: vi.fn().mockResolvedValue(undefined) },
    keyboard: { type: vi.fn().mockResolvedValue(undefined), hotkey: vi.fn().mockResolvedValue(undefined) },
    clipboard: { get: vi.fn().mockResolvedValue('clipboard'), set: vi.fn().mockResolvedValue(undefined) },
    fs: { write: vi.fn().mockResolvedValue(undefined) },
  };
  return { desktop, desktopId: id, volumeId: 'vol_1' };
}

const ALL_HANDLERS: Array<[string, CloudHandler]> = [
  ['cloud_browser_open', cloudBrowserOpen],
  ['cloud_browser_close', cloudBrowserClose],
  ['cloud_browser_navigate', cloudBrowserNavigate],
  ['cloud_browser_read_page', cloudBrowserReadPage],
  ['cloud_browser_click', cloudBrowserClick],
  ['cloud_browser_type', cloudBrowserType],
  ['cloud_browser_screenshot', cloudBrowserScreenshot],
  ['cloud_browser_scroll', cloudBrowserScroll],
  ['cloud_browser_wait', cloudBrowserWait],
  ['cloud_browser_replay_url', cloudBrowserReplayUrl],
  ['cloud_browser_profiles_list', cloudBrowserProfilesList],
  ['cloud_browser_profile_save', cloudBrowserProfileSave],
  ['cloud_desktop_open', cloudDesktopOpen],
  ['cloud_desktop_close', cloudDesktopClose],
  ['cloud_desktop_screenshot', cloudDesktopScreenshot],
  ['cloud_desktop_stream_url', cloudDesktopStreamUrl],
  ['cloud_desktop_mouse_click', cloudDesktopMouseClick],
  ['cloud_desktop_mouse_move', cloudDesktopMouseMove],
  ['cloud_desktop_keyboard_type', cloudDesktopKeyboardType],
  ['cloud_desktop_keyboard_hotkey', cloudDesktopKeyboardHotkey],
  ['cloud_desktop_exec', cloudDesktopExec],
  ['cloud_desktop_clipboard_get', cloudDesktopClipboardGet],
  ['cloud_desktop_clipboard_set', cloudDesktopClipboardSet],
  ['cloud_desktop_file_write', cloudDesktopFileWrite],
  ['cloud_sandbox_open', cloudSandboxOpen],
  ['cloud_sandbox_close', cloudSandboxClose],
  ['cloud_sandbox_read_file', cloudSandboxReadFile],
  ['cloud_sandbox_file_list', cloudSandboxFileList],
  ['cloud_sandbox_write_file', cloudSandboxWriteFile],
  ['cloud_sandbox_exec', cloudSandboxExec],
  ['cloud_sandbox_preview_url', cloudSandboxPreviewUrl],
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mapSolariError.mockImplementation((err: unknown) => ({
    userMessage:
      err instanceof Error && err.name === 'SolariNotConfiguredError'
        ? 'Your Solari API key is invalid or missing — set it in Settings > Solari.'
        : 'An unexpected Solari error occurred — retry or contact support.',
  }));
});

describe('mission context guard', () => {
  it.each(ALL_HANDLERS)('%s requires a mission context', async (_name, handler) => {
    await expect(handler({}, makeCtx())).resolves.toBe(MISSION_REQUIRED);
  });
});

describe('cloud browser handlers', () => {
  it('cloud_browser_open opens a session with mapped args', async () => {
    mocks.openBrowserSession.mockResolvedValue(makeBrowserHandle('ses_open'));
    const result = await cloudBrowserOpen(
      { profile_id: 'prof_1', stealth: true, proxy_country: 'gb', captcha: true, recording: true },
      makeCtx('m1'),
    );
    expect(mocks.openBrowserSession).toHaveBeenCalledWith('m1', {
      profileId: 'prof_1',
      stealth: true,
      proxyCountry: 'gb',
      captcha: true,
      recording: true,
      botId: undefined,
      longLived: false,
    });
    expect(result).toContain('ses_open');
  });

  it('cloud_browser_navigate navigates the open page', async () => {
    const handle = makeBrowserHandle('ses_nav');
    mocks.getBrowserSession.mockReturnValue(handle);
    const result = await cloudBrowserNavigate({ url: 'https://example.com' }, makeCtx('m1'));
    const page = handle.browser.contexts()[0].pages()[0];
    expect(page.goto).toHaveBeenCalledWith('https://example.com');
    expect(result).toContain('Navigated to https://example.com');
  });

  it('cloud_browser_navigate returns an error when no session is open', async () => {
    mocks.getBrowserSession.mockReturnValue(undefined);
    const result = await cloudBrowserNavigate({ url: 'https://example.com' }, makeCtx('m1'));
    expect(result).toContain('no browser session');
  });

  it('cloud_browser_screenshot emits browser:stateChange with a data URL', async () => {
    const handle = makeBrowserHandle('ses_shot');
    mocks.getBrowserSession.mockReturnValue(handle);
    const result = await cloudBrowserScreenshot({}, makeCtx('m1'));
    expect(mocks.emit).toHaveBeenCalledWith('browser:stateChange', expect.objectContaining({
      isOpen: true,
      url: 'https://example.com',
      screenshotDataUrl: 'data:image/png;base64,iVBORw==',
    }));
    expect(result).toContain('Screenshot captured');
  });

  it('cloud_browser_replay_url returns the replay URL', async () => {
    mocks.getBrowserSession.mockReturnValue(makeBrowserHandle('ses_replay'));
    mocks.getSolariClients.mockResolvedValue({
      browser: { sessions: { getReplayUrl: vi.fn().mockResolvedValue({ url: 'https://replay.example.com' }) } },
    });
    const result = await cloudBrowserReplayUrl({}, makeCtx('m1'));
    expect(result).toBe('https://replay.example.com');
  });

  it('cloud_browser_profiles_list lists saved profiles', async () => {
    mocks.getSolariClients.mockResolvedValue({
      browser: { profiles: { list: vi.fn().mockResolvedValue([{ id: 'prof_1', name: 'Work' }]) } },
    });
    const result = await cloudBrowserProfilesList({}, makeCtx('m1'));
    expect(result).toContain('Work (prof_1)');
  });
});

describe('cloud desktop handlers', () => {
  it('cloud_desktop_open ensures and acquires the Agent Computer', async () => {
    mocks.ensureAgentComputer.mockResolvedValue(makeDesktopHandle('dsk_open'));
    const result = await cloudDesktopOpen({}, makeCtx('m1'));
    expect(mocks.ensureAgentComputer).toHaveBeenCalledTimes(1);
    expect(mocks.acquireAgentComputer).toHaveBeenCalledWith('m1', undefined);
    expect(result).toContain('dsk_open');
  });

  it('cloud_desktop_close releases the Agent Computer mutex', async () => {
    const result = await cloudDesktopClose({}, makeCtx('m1'));
    expect(mocks.releaseAgentComputer).toHaveBeenCalledWith('m1', undefined);
    expect(result).toBe('Agent Computer released.');
  });

  it('cloud_desktop_exec returns exit/stdout/stderr', async () => {
    const handle = makeDesktopHandle('dsk_exec');
    mocks.ensureAgentComputer.mockResolvedValue(handle);
    const result = await cloudDesktopExec({ command: 'ls', cwd: '/tmp' }, makeCtx('m1'));
    expect(handle.desktop.exec).toHaveBeenCalledWith('ls', { cwd: '/tmp' });
    expect(result).toContain('exit: 0');
    expect(result).toContain('stdout: out');
  });

  it('cloud_desktop_screenshot emits browser:stateChange with a data URL', async () => {
    mocks.ensureAgentComputer.mockResolvedValue(makeDesktopHandle('dsk_shot'));
    const result = await cloudDesktopScreenshot({}, makeCtx('m1'));
    expect(mocks.emit).toHaveBeenCalledWith('browser:stateChange', expect.objectContaining({
      screenshotDataUrl: 'data:image/png;base64,iVBORw==',
    }));
    expect(result).toContain('Desktop screenshot captured');
  });
});

describe('cloud sandbox handlers', () => {
  it('cloud_sandbox_open opens a sandbox with mapped args', async () => {
    mocks.openSandbox.mockResolvedValue(makeSandboxHandle('sbx_open'));
    const result = await cloudSandboxOpen({ template: 'code', cpu: 2, mem_mb: 2048 }, makeCtx('m1'));
    expect(mocks.openSandbox).toHaveBeenCalledWith('m1', { template: 'code', cpu: 2, memMb: 2048 });
    expect(result).toContain('sbx_open');
  });

  it('cloud_sandbox_write_file writes through the sandbox filesystem', async () => {
    const handle = makeSandboxHandle('sbx_write');
    mocks.getSandbox.mockReturnValue(handle);
    const result = await cloudSandboxWriteFile({ path: '/workspace/x.txt', content: 'hello' }, makeCtx('m1'));
    expect(handle.sandbox.files.write).toHaveBeenCalledWith('/workspace/x.txt', 'hello');
    expect(result).toContain('Wrote 5 bytes');
  });

  it('cloud_sandbox_exec returns exit/stdout/stderr', async () => {
    const handle = makeSandboxHandle('sbx_exec');
    mocks.getSandbox.mockReturnValue(handle);
    const result = await cloudSandboxExec({ command: 'pwd' }, makeCtx('m1'));
    expect(handle.sandbox.commands.run).toHaveBeenCalledWith('pwd', undefined);
    expect(result).toContain('exit: 0');
  });

  it('cloud_sandbox_read_file truncates long content', async () => {
    const handle = makeSandboxHandle('sbx_read');
    handle.sandbox.files.readText.mockResolvedValue('x'.repeat(2500));
    mocks.getSandbox.mockReturnValue(handle);
    const result = await cloudSandboxReadFile({ path: '/workspace/f.txt' }, makeCtx('m1'));
    expect(result.length).toBe(2000);
  });
});

describe('cloud error handling', () => {
  it('maps a SolariNotConfiguredError to an actionable message', async () => {
    const err = Object.assign(new Error('no key'), { name: 'SolariNotConfiguredError' });
    mocks.openBrowserSession.mockRejectedValue(err);
    const result = await cloudBrowserOpen({}, makeCtx('m1'));
    expect(result).toContain('ERROR: cloud_browser_open failed');
    expect(result).toContain('Settings > Solari');
  });
});




