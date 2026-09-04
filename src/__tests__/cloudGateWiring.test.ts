/* cloudGateWiring.test.ts — unit tests for the approval-gate wiring in
   toolRuntime.executeTool: cloud_* tools are intercepted when a mission
   context is present, and the resulting GateOutcome steers the call. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolExecutionContext } from '../lib/tools/handlers/types';
import { executeTool } from '../lib/tools/toolRuntime';
import { interceptAction } from '../lib/agents/approval/approvalGate';
import { toolHandlers } from '../lib/tools/handlers/index';

vi.mock('../lib/agents/approval/approvalGate', () => ({
  interceptAction: vi.fn(),
  resolveApproval: vi.fn(),
  getPendingApproval: vi.fn(),
  listPendingApprovals: vi.fn(),
}));

vi.mock('../lib/tools/handlers/index', () => ({
  toolHandlers: {
    cloud_browser_navigate: vi.fn(),
    cloud_browser_click: vi.fn(),
    read_file: vi.fn(),
  },
}));

const interceptActionMock = vi.mocked(interceptAction);
const navigateHandler = vi.mocked(toolHandlers.cloud_browser_navigate);
const clickHandler = vi.mocked(toolHandlers.cloud_browser_click);
const readFileHandler = vi.mocked(toolHandlers.read_file);

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    rootPath: '/tmp',
    policy: {},
    agentMode: 'default',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('executeTool cloud approval gate', () => {
  it('calls the gate for a readonly cloud tool and lets an allow through', async () => {
    interceptActionMock.mockResolvedValue({ kind: 'allow' });
    navigateHandler.mockResolvedValue('navigated');

    const result = await executeTool(
      'cloud_browser_navigate',
      { url: 'https://x.com' },
      makeCtx({ missionId: 'm1' }),
    );

    expect(interceptActionMock).toHaveBeenCalledTimes(1);
    expect(interceptActionMock).toHaveBeenCalledWith({
      missionId: 'm1',
      tool: 'cloud_browser_navigate',
      args: { url: 'https://x.com' },
      page: { url: 'https://x.com', targetText: undefined, targetRole: undefined, inputType: undefined },
      autonomy: 'supervised',
      signal: undefined,
    });
    expect(navigateHandler).toHaveBeenCalledTimes(1);
    expect(result).toBe('navigated');
  });

  it('returns the denied observation without calling the handler', async () => {
    interceptActionMock.mockResolvedValue({ kind: 'denied', observation: 'DENIED OBSERVATION' });

    const result = await executeTool(
      'cloud_browser_click',
      { selector: '#submit' },
      makeCtx({ missionId: 'm2', autonomy: 'manual' }),
    );

    expect(interceptActionMock).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'cloud_browser_click',
      autonomy: 'manual',
    }));
    expect(clickHandler).not.toHaveBeenCalled();
    expect(result).toBe('DENIED OBSERVATION');
  });

  it('calls the handler with edited args when the gate edits', async () => {
    interceptActionMock.mockResolvedValue({ kind: 'edited', args: { selector: '#safe' } });
    clickHandler.mockResolvedValue('clicked');

    const result = await executeTool(
      'cloud_browser_click',
      { selector: '#danger' },
      makeCtx({ missionId: 'm3' }),
    );

    expect(clickHandler).toHaveBeenCalledWith({ selector: '#safe' }, expect.anything());
    expect(result).toBe('clicked');
  });

  it('calls the handler normally when the gate allows', async () => {
    interceptActionMock.mockResolvedValue({ kind: 'allow' });
    clickHandler.mockResolvedValue('clicked');

    const result = await executeTool(
      'cloud_browser_click',
      { selector: '#submit' },
      makeCtx({ missionId: 'm4' }),
    );

    expect(clickHandler).toHaveBeenCalledWith({ selector: '#submit' }, expect.anything());
    expect(result).toBe('clicked');
  });

  it('does not call the gate for a non-cloud tool', async () => {
    readFileHandler.mockResolvedValue('file contents');

    const result = await executeTool(
      'read_file',
      { path: 'a.txt' },
      makeCtx({ missionId: 'm5' }),
    );

    expect(interceptActionMock).not.toHaveBeenCalled();
    expect(readFileHandler).toHaveBeenCalled();
    expect(result).toBe('file contents');
  });

  it('does not call the gate for a cloud tool without a mission context', async () => {
    clickHandler.mockResolvedValue('ERROR: cloud_* tools require a mission context');

    const result = await executeTool(
      'cloud_browser_click',
      { selector: '#submit' },
      makeCtx(),
    );

    expect(interceptActionMock).not.toHaveBeenCalled();
    expect(clickHandler).toHaveBeenCalled();
    expect(result).toBe('ERROR: cloud_* tools require a mission context');
  });

  it('returns the cancelled observation when the gate cancels', async () => {
    interceptActionMock.mockResolvedValue({ kind: 'cancelled', observation: 'CANCELLED OBSERVATION' });

    const result = await executeTool(
      'cloud_browser_click',
      { selector: '#submit' },
      makeCtx({ missionId: 'm7' }),
    );

    expect(clickHandler).not.toHaveBeenCalled();
    expect(result).toBe('CANCELLED OBSERVATION');
  });

  it('defaults autonomy to supervised and threads the abort signal through', async () => {
    interceptActionMock.mockResolvedValue({ kind: 'allow' });
    const signal = new AbortController().signal;

    await executeTool(
      'cloud_browser_click',
      { selector: '#submit' },
      makeCtx({ missionId: 'm8', abortSignal: signal }),
    );

    expect(interceptActionMock).toHaveBeenCalledWith(expect.objectContaining({
      autonomy: 'supervised',
      signal,
    }));
  });
});
