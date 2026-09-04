/* approvalTypes.ts — Shared types for the LazyBot approval gate: action
   classes, page context, gate verdicts/outcomes, the observation strings and
   the canonical read-only cloud tool list.

   FAIL-CLOSED RATIONALE: `unknown` is a real ActionClass whose default
   effect is REQUIRE (see approvalRules.ts DEFAULT_CLASS_EFFECT) — the gate
   must never let an unclassified action through because a model call failed
   or a selector changed.
*/

export type ActionClass =
  | 'browse' | 'read' | 'screenshot' | 'compose' | 'send' | 'publish'
  | 'pay' | 'delete' | 'credentials' | 'exec' | 'file_write' | 'unknown';

/** Page context the gate uses to classify — assembled by the caller from the
 *  session's last-known state plus the action's own args. */
export interface PageContext {
  url?: string;            // current page URL, if a browser session is active
  targetText?: string;     // visible text of the element being acted on
  targetRole?: string;     // ARIA role (e.g. 'button', 'link', 'textbox')
  inputType?: string;      // for typing: the input's type attribute ('password', ...)
  /** Optional screenshot data URL for the approval UI preview (C79). */
  screenshotDataUrl?: string;
}

export type GateVerdict = 'approve' | 'edit' | 'deny' | 'alwaysAllow';

export type GateOutcome =
  | { kind: 'allow' }                                  // proceed with original args
  | { kind: 'edited'; args: Record<string, unknown> }  // proceed with user-edited args
  | { kind: 'denied'; observation: string }            // do NOT execute; feed observation
  | { kind: 'cancelled'; observation: string };        // mission stopped while waiting

export const DENIED_OBSERVATION =
  'DENIED by user — do not retry this action; ask the user how to proceed differently.';
export const CANCELLED_OBSERVATION =
  'CANCELLED — the mission was stopped while waiting for approval.';

/** Cloud tools that are observation-only: opening/closing sessions,
 *  navigating, reading, listing and screenshots never change the world, so
 *  the gate lets them through in every autonomy mode. Single source of truth
 *  — the classifier and the gate import this instead of duplicating it. */
export const CLOUD_READONLY_TOOLS: ReadonlySet<string> = new Set([
  'cloud_browser_navigate',
  'cloud_browser_read_page',
  'cloud_browser_screenshot',
  'cloud_browser_wait',
  'cloud_browser_replay_url',
  'cloud_desktop_screenshot',
  'cloud_desktop_stream_url',
  'cloud_sandbox_read_file',
  'cloud_sandbox_file_list',
  'cloud_desktop_clipboard_get',
  'cloud_browser_open',
  'cloud_desktop_open',
  'cloud_sandbox_open',
  'cloud_desktop_close',
  'cloud_browser_close',
  'cloud_sandbox_close',
  'cloud_browser_profiles_list',
]);
