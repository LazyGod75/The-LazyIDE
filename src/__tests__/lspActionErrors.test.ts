/**
 * lspActionErrors.test.ts — err-3 fix (silent-failure audit).
 *
 * lspClient.ts's buildCodeActionExtension/buildRenameExtension used to
 * swallow request failures with `.catch(() => {})` — a user pressing F2 or
 * ctrl-clicking for a quick fix that failed saw nothing, ever.
 * logLspActionFailure is the extracted, independently-testable replacement.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { logLspActionFailure } from '../components/editor/lspActionErrors';

describe('logLspActionFailure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs a console.error trace with the action, file, and language on a simulated request failure', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('LSP server disconnected');

    logLspActionFailure('rename', { filePath: '/repo/src/App.tsx', language: 'typescript' }, error);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const [message, context] = consoleErrorSpy.mock.calls[0];
    expect(String(message)).toContain('rename');
    expect(context).toMatchObject({
      filePath: '/repo/src/App.tsx',
      language: 'typescript',
      error,
    });
  });

  it('distinguishes codeAction failures from rename failures in the trace', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logLspActionFailure('codeAction', { filePath: '/repo/src/App.tsx', language: 'typescript' }, new Error('boom'));

    const [message] = consoleErrorSpy.mock.calls[0];
    expect(String(message)).toContain('codeAction');
  });
});
