/* lspActionErrors.ts — logging for lspClient.ts's user-initiated request
   failures (err-3 fix, silent-failure audit).

   Two of lspClient.ts's six `.catch(() => {})` sites are notifications
   (didOpen/didChange/didClose/exit) — fire-and-forget by LSP protocol
   design, documented best-effort where they are defined. The other two are
   REQUESTS the user explicitly triggered (ctrl/cmd-click for a code action,
   F2 for rename): a failure there must not be silent, since the user is
   actively waiting for a visible result. Extracted as a small named
   function so it is independently testable without mounting CodeMirror.
*/

export type LspUserAction = 'codeAction' | 'rename';

export interface LspActionErrorContext {
  filePath: string;
  language: string;
}

export function logLspActionFailure(action: LspUserAction, context: LspActionErrorContext, error: unknown): void {
  console.error(`lspClient: ${action} request failed`, { ...context, error });
}
