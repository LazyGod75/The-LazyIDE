/* managerTurnRetry — helpers for runManagerTurn's validation/nudge loop.

   Measured 2026-08-28: runManagerTurn cyclomatic complexity was 33
   (ESLint ratchet ceiling 12). These stay free of managerEngine imports
   so the turn loop can call them without a circular module graph.
*/

import type { ProviderMode } from '../models/index.js';
import type { ManagerEngineChoice, ManagerMessage } from './types.js';
import { validateManagerAction } from './managerActionValidator.js';

export function resolveManagerTurnMode(
  rawMode: ProviderMode,
  engineOverride: ManagerEngineChoice | undefined,
  nativeMode: ProviderMode,
): ProviderMode {
  if (engineOverride === 'cli') return nativeMode;
  if (engineOverride === 'pro') return 'managed';
  return rawMode;
}

export const SUBSTANTIAL_INFO_REPLY_CHARS = 500;

/** A long analysis/comparatif reply is not an unexecuted command — nudging
 *  it discards the real answer (stream preview) and replaces it with
 *  "[system] No executable action was emitted". */
export function isSubstantialInformationalReply(text: string): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length < SUBSTANTIAL_INFO_REPLY_CHARS) return false;
  return !/\b(?:je (?:vais )?(?:lance|lancer|supprime|archive|arr[êe]te)|i(?:['’]ll| will) (?:launch|delete|stop|archive))\b/i.test(trimmed);
}

export function shouldNudgeZeroActions(opts: {
  announcementNudged: boolean;
  turn: number;
  maxTurns: number;
  userAskedForAction: boolean;
  isClarifying: boolean;
  isSubstantialInfo?: boolean;
}): boolean {
  return (
    !opts.announcementNudged &&
    opts.turn < opts.maxTurns - 1 &&
    opts.userAskedForAction &&
    !opts.isClarifying &&
    !opts.isSubstantialInfo
  );
}

export function formatZeroActionNudgeLog(
  turnIndex: number,
  parseFailureReason: string | null,
  preview: string,
): string {
  if (parseFailureReason) {
    return (
      `[managerEngine] turn ${turnIndex}: <lazy_actions> block opened but unparseable ` +
      `(${parseFailureReason}) — issuing one corrective nudge with the specific reason ` +
      `(never repeated within this call): "${preview}"`
    );
  }
  return (
    `[managerEngine] turn ${turnIndex}: user asked for an action but the reply emitted ` +
    `no <lazy_actions> block — issuing one corrective nudge (never repeated within this call): ` +
    `"${preview}"`
  );
}

export function zeroActionNudgeUserContent(
  parseFailureReason: string | null,
  announcementNudgeMessage: string,
): string {
  if (!parseFailureReason) return announcementNudgeMessage;
  return (
    `Your previous reply opened a <lazy_actions> block, but ${parseFailureReason} — ` +
    `nothing was parsed from it, so nothing executed. Re-emit a SYNTACTICALLY VALID ` +
    `<lazy_actions>[...]</lazy_actions> block for the same action(s), exactly this shape, ` +
    `e.g.: <lazy_actions>[{"type":"archive_mission","missionId":"M12"}]</lazy_actions>. ` +
    `Double-check matching brackets/braces and quoted strings.`
  );
}

export function collectInvalidActionReasons(rawActions: readonly unknown[]): string[] {
  const invalidReasons: string[] = [];
  for (const a of rawActions) {
    const result = validateManagerAction(a);
    if (!result.ok) {
      invalidReasons.push(`Action "${actionTypeLabel(a)}": ${result.reason}`);
    }
  }
  return invalidReasons;
}

function actionTypeLabel(a: unknown): string {
  if (typeof a === 'object' && a !== null && 'type' in a) {
    return String((a as Record<string, unknown>).type);
  }
  return '(unknown)';
}

export function appendTurnRetryMessages(
  apiMessages: ManagerMessage[],
  rawResponse: string,
  userContent: string,
  nextId: () => string,
): void {
  const timestamp = new Date().toISOString();
  apiMessages.push({ id: nextId(), role: 'assistant', content: rawResponse, timestamp });
  apiMessages.push({ id: nextId(), role: 'user', content: userContent, timestamp });
}

export function eligibleRepairMode(
  nudgeFailed: boolean,
  llmCallCount: number,
  maxCallsBeforeSkip: number,
  lastResolvedMode: ProviderMode | undefined,
): ProviderMode | undefined {
  if (!nudgeFailed || llmCallCount > maxCallsBeforeSkip) return undefined;
  return lastResolvedMode;
}

export function firstTurnPartial<T>(turn: number, onPartial: T | undefined): T | undefined {
  return turn === 0 ? onPartial : undefined;
}

export function shouldRetryInvalidActions(turn: number, maxTurns: number): boolean {
  return turn < maxTurns - 1;
}

export function nudgeFailedOutcome(
  announcementNudged: boolean,
  actionCount: number,
  isClarifying: boolean,
): boolean {
  return announcementNudged && actionCount === 0 && !isClarifying;
}

export function showNudgeFailureNotice(nudgeFailed: boolean, repairRecovered: boolean): boolean {
  return nudgeFailed && !repairRecovered;
}

export function applyRepairedActions<T>(current: T[], repaired: T[]): { actions: T[]; recovered: boolean } {
  if (repaired.length === 0) return { actions: current, recovered: false };
  return { actions: repaired, recovered: true };
}

/** Drops prose that claims an action is happening when none was emitted
 *  ("Je lance…", "I'll launch…"). Keeps a real informational reply. */
export function stripUnexecutedActionClaims(text: string): string {
  if (typeof text !== 'string') return '';
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const kept = sentences.filter(
    (s) => !/\b(?:je (?:vais )?(?:lance|lancer)|i(?:['’]ll| will) (?:launch|run))\b/i.test(s),
  );
  return kept.join(' ').trim();
}

export function assembleManagerTurnResponseText(
  baseResponseText: string,
  showFailureNotice: boolean,
  failureNotice: string,
): string {
  if (!showFailureNotice) return baseResponseText;
  // Never bury a real analysis under the stall notice — that is how a
  // 7k-char comparatif vanished from the transcript after the retry loop.
  if (isSubstantialInformationalReply(baseResponseText)) return baseResponseText;
  const honest = stripUnexecutedActionClaims(baseResponseText);
  if (honest.length > 0) return `${failureNotice}\n\n${honest}`;
  return failureNotice;
}
