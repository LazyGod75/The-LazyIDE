/* agentError — locale-independent agent-failure sentinel.

   Timeline rows used to hardcode the French prefix "Erreur agent:" so
   runMission / recovery could `startsWith` it. Translating the prefix
   without a typed flag broke matching in every non-FR locale.

   Control flow keys off `ActionEvent.kind === 'error'` first, then the
   prefix list (legacy rows + tests that still emit the French sentinel).
*/

import type { ActionEvent } from './types.js';

type TFunc = (key: string, params?: Record<string, string | number>) => string;

export const AGENT_ERROR_KIND = 'error' as const;
/** Stable machine token for control-flow; prefer `kind` over localized text. */
export const AGENT_ERROR_MARKER = AGENT_ERROR_KIND;

const KNOWN_PREFIXES = [
  'Erreur agent:',
  'Agent error:',
  'Agentfehler:',
  'Error del agente:',
  'エージェントエラー:',
  '代理错误:',
] as const;

export function agentErrorPrefix(t?: TFunc): string {
  if (!t) return 'Erreur agent:';
  try {
    const translated = t('agents.runtime.agentErrorPrefix');
    if (translated && translated !== 'agents.runtime.agentErrorPrefix') return translated;
  } catch {
    // missing i18n — fall through
  }
  return 'Erreur agent:';
}

export function formatAgentError(message: string, t?: TFunc): string {
  const prefix = agentErrorPrefix(t);
  const body = stripAgentErrorPrefix(message);
  return `${prefix} ${body}`;
}

export function stripAgentErrorPrefix(text: string): string {
  let msg = text.trim();
  for (const prefix of KNOWN_PREFIXES) {
    if (msg.startsWith(prefix)) {
      msg = msg.slice(prefix.length).trim();
      break;
    }
  }
  const localized = /^(Erreur agent|Agent error|Agentfehler|Error del agente|エージェントエラー|代理错误)\s*:\s*/i;
  return msg.replace(localized, '').trim();
}

export function isAgentErrorText(text: string): boolean {
  const trimmed = text.trim();
  if (KNOWN_PREFIXES.some((p) => trimmed.startsWith(p))) return true;
  return /^(Erreur agent|Agent error|Agentfehler|Error del agente|エージェントエラー|代理错误)\s*:/i.test(trimmed);
}

export function isAgentErrorEvent(event: Pick<ActionEvent, 'text' | 'kind'>): boolean {
  return event.kind === AGENT_ERROR_KIND || isAgentErrorText(event.text);
}

export function agentErrorEvent(time: string, message: string, t?: TFunc): ActionEvent {
  return {
    time,
    text: formatAgentError(message, t),
    isLive: false,
    kind: AGENT_ERROR_KIND,
  };
}
