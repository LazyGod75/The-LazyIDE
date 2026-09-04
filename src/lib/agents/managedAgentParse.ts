/* managedAgentParse.ts — ReAct ACTION/ARGS parser extracted from
   managedAgent.ts so parseReActAction stays under the complexity ratchet.
   Byte-for-byte same recognition as the inlined version (M6 control-char
   repair + ARGS-anchored balanced-brace rescan). Does not import
   managedAgent.ts (cycle). */

import { stripReasoningLines } from './reasoningLeak.js';
import { FILE_CONTENT_ACTIONS, parseFileToolAction } from './searchReplaceProtocol.js';
import type { ActionEvent } from './types.js';
import type { TFunc } from './runtime.js';

export type ReActParsed = { action: string; args: Record<string, unknown> };

function cleanReActText(text: string): string {
  const cleaned = stripReasoningLines(text)
    .split('\n')
    .filter((line) => !line.startsWith('\x1b[usage]'))
    .join('\n')
    // eslint-disable-next-line no-control-regex -- \x1b is the intentional ANSI escape prefix being stripped, not accidental
    .replace(/\x1b\[[0-9;]*m/g, '');
  return cleaned.replace(/^```(?:json|text)?\s*\n([\s\S]*?)\n```\s*$/m, '$1');
}

function matchActionLine(unfenced: string): { action: string; actionLower: string; match: RegExpMatchArray } | null {
  const actionMatch = unfenced.match(/^\*{0,2}ACTION\*{0,2}:\s*(.+)$/mi);
  if (!actionMatch) return null;
  const action = actionMatch[1].trim().replace(/\*+/g, '');
  return { action, actionLower: action.toLowerCase(), match: actionMatch };
}

function extractArgsString(unfenced: string): string | undefined {
  const codeFenceMatch = unfenced.match(/\*{0,2}ARGS\*{0,2}:\s*```(?:json)?\s*([\s\S]*?)```/i);
  if (codeFenceMatch) return codeFenceMatch[1].trim();
  const multiLineMatch = unfenced.match(/\*{0,2}ARGS\*{0,2}:\s*(\{[\s\S]*?\})\s*(?:\n|$)/i);
  if (multiLineMatch) return multiLineMatch[1].trim();
  const inlineMatch = unfenced.match(/^\*{0,2}ARGS\*{0,2}:\s*(.+)$/mi);
  return inlineMatch?.[1]?.trim();
}

/** deepseek-class models sometimes DROP the `ARGS:` marker and put the JSON
 *  object directly on the line(s) right after `ACTION: <tool>`. Scan only the
 *  immediate zone after the ACTION line (bounded by the next
 *  THOUGHT/ACTION/FINAL marker) so prose braces elsewhere never anchor the
 *  balanced scan. Returns the raw JSON substring or undefined. */
function extractBareArgsAfterAction(unfenced: string, actionEnd: number): string | undefined {
  const rest = unfenced.slice(actionEnd);
  const nextMarker = rest.search(/\n(?:THOUGHT|ACTION|FINAL)\s*:/i);
  const zone = nextMarker === -1 ? rest : rest.slice(0, nextMarker);
  const balanced = extractBalancedJsonObject(zone);
  return balanced ?? undefined;
}

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    try {
      return JSON.parse(sanitizeJsonStringControlChars(raw)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

function parseArgsObject(unfenced: string, argsStr: string): Record<string, unknown> | null {
  const direct = tryParseJsonObject(argsStr);
  if (direct) return direct;
  const argsMarkerMatch = unfenced.match(/\*{0,2}ARGS\*{0,2}:/i);
  const scanFrom = argsMarkerMatch?.index !== undefined ? unfenced.slice(argsMarkerMatch.index) : unfenced;
  const balanced = extractBalancedJsonObject(scanFrom);
  return balanced ? tryParseJsonObject(balanced) : null;
}

/** Parses a ReAct-format response into { action, args }; null when the format is unrecognisable or ARGS has invalid JSON. */
export function parseReActAction(text: string): ReActParsed | null {
  if (!text.trim()) return null;
  const unfenced = cleanReActText(text);
  const found = matchActionLine(unfenced);
  if (!found) return null;
  const { action, actionLower, match } = found;
  if (FILE_CONTENT_ACTIONS.has(actionLower)) {
    const textAfterAction = unfenced.slice(match.index! + match[0].length);
    const fileArgs = parseFileToolAction(actionLower, textAfterAction);
    if (fileArgs) return { action, args: fileArgs };
  }
  const argsStr = extractArgsString(unfenced) ?? extractBareArgsAfterAction(unfenced, match.index! + match[0].length);
  if (!argsStr) {
    // No ARGS at all: for FINAL and for tools that take no arguments this is
    // legitimate (deepseek-class models omit the ARGS line for no-arg tools).
    // Returning {} keeps the loop resilient — tools that genuinely require
    // args surface a normal tool-error observation the model can correct.
    return { action, args: {} };
  }
  const args = parseArgsObject(unfenced, argsStr);
  if (!args) return null;
  return { action: action.toUpperCase() === 'FINAL' ? 'FINAL' : action, args };
}

/** Format retry: when the first parse fails, stream one more turn and parse that. */
export async function parseReActActionWithRetry(
  cleaned: string,
  retry: () => Promise<string>,
): Promise<ReActParsed | null> {
  const first = parseReActAction(cleaned);
  if (first) return first;
  return parseReActAction(await retry());
}

/** V7 (M6) — same unparseable shape twice fast-tracks to the consecutive-failure cap. */
export function fastTrackUnparseable(
  cleaned: string,
  consecutiveFailures: number,
  lastUnparseableSignature: string | null,
  maxConsecutiveFailures: number,
): { consecutiveFailures: number; lastUnparseableSignature: string; hitCap: boolean } {
  let next = consecutiveFailures + 1;
  const signature = cleaned.slice(0, 300);
  if (lastUnparseableSignature !== null && signature === lastUnparseableSignature) {
    next = maxConsecutiveFailures;
  }
  return {
    consecutiveFailures: next,
    lastUnparseableSignature: signature,
    hitCap: next >= maxConsecutiveFailures,
  };
}

export function stripManagedTurnText(turnText: string): string {
  return stripReasoningLines(turnText)
    .split('\n')
    .filter((line) => !line.startsWith('\x1b[usage]'))
    .join('\n');
}

export function applyUnparseableStep(opts: {
  cleaned: string;
  consecutiveFailures: number;
  lastUnparseableSignature: string | null;
  maxConsecutiveFailures: number;
  step: number;
  t?: TFunc;
  nowTime: () => string;
  onAction: (event: ActionEvent) => void;
  escalateAndStop: () => void;
  messages: Array<{ role: string; content: string }>;
}): 'stop' | {
  messages: Array<{ role: string; content: string }>;
  consecutiveFailures: number;
  lastUnparseableSignature: string;
} {
  const tracked = fastTrackUnparseable(
    opts.cleaned,
    opts.consecutiveFailures,
    opts.lastUnparseableSignature,
    opts.maxConsecutiveFailures,
  );
  const attempt = Math.min(tracked.consecutiveFailures, opts.maxConsecutiveFailures);
  opts.onAction({
    time: opts.nowTime(),
    text: opts.t
      ? opts.t('agents.managedAgent.parseFailed', {
          step: opts.step + 1,
          attempt,
          max: opts.maxConsecutiveFailures,
        })
      : `Could not parse agent response at step ${opts.step + 1} (attempt ${attempt}/${opts.maxConsecutiveFailures})`,
    isLive: false,
  });
  const messages = [
    ...opts.messages,
    { role: 'assistant', content: opts.cleaned },
    { role: 'user', content: 'ERROR: Could not parse your response. Please respond with THOUGHT/ACTION/ARGS format.' },
  ];
  if (tracked.hitCap) {
    opts.escalateAndStop();
    return 'stop';
  }
  return {
    messages,
    consecutiveFailures: tracked.consecutiveFailures,
    lastUnparseableSignature: tracked.lastUnparseableSignature,
  };
}

/** 2026-08-04 (UC3 dogfood — M1 "Could not parse agent response at step 2"
 *  on deepseek-chat): last-resort ARGS extractor. Finds the FIRST `{` in
 *  `text` and scans for the matching balanced `}` (string-literal aware, so
 *  braces inside JSON strings never miscount), returning the raw JSON
 *  substring — or null when no balanced object exists. */
export function extractBalancedJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** 2026-08-14 (M6 incident): repairs raw newlines/CR/tabs inside JSON string
 *  literals so write_file/edit_file content still parses. Only characters
 *  inside a string literal are touched. */
export function sanitizeJsonStringControlChars(text: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        result += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        result += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
        result += ch;
        continue;
      }
      if (ch === '\n') {
        result += '\\n';
        continue;
      }
      if (ch === '\r') {
        result += '\\r';
        continue;
      }
      if (ch === '\t') {
        result += '\\t';
        continue;
      }
      result += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
    }
    result += ch;
  }
  return result;
}
