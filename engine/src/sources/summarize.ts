/**
 * Shared conversation summarization: categorize message texts into
 * decisions / errors / facts / general and assemble a <=4000 char summary.
 * Extracted from dream.ts extractConversationSummary so every
 * ConversationSource shares identical semantics (golden-locked by dream tests).
 */

import { isAgentMetaText } from './noise.js';

export interface SummaryItem {
  role: 'user' | 'assistant';
  text: string;
}

export function summarizeMessages(items: SummaryItem[]): string {
  const decisions: string[] = [];
  const errors: string[] = [];
  const facts: string[] = [];
  const general: string[] = [];

  for (const item of items) {
    const text = item.text.trim();
    if (!text || text.length < 20) continue;
    if (isAgentMetaText(text)) continue;

    if (item.role === 'assistant') {
      if (text.startsWith('{') || text.startsWith('[') || text.startsWith('```')) continue;
      if (/^(Running|Reading|Searching|Checking|Let me)/i.test(text)) continue;
    }

    const clipped = item.role === 'user' ? text.slice(0, 500) : text.slice(0, 600);
    categorize(clipped, decisions, errors, facts, general);
  }

  const parts = [
    ...decisions.slice(0, 8),
    ...errors.slice(0, 5),
    ...facts.slice(0, 5),
    ...general.slice(-3),
  ];
  return parts.join('\n\n').slice(0, 4000);
}

function categorize(
  text: string,
  decisions: string[],
  errors: string[],
  facts: string[],
  general: string[],
): void {
  if (
    /\b(decided|decision|chose|choosing|switched|migration|use .+ instead|we('ll| will) use|going with|opted for)\b/i.test(
      text,
    )
  ) {
    decisions.push(text);
  } else if (/\b(error|bug|fix|broken|failed|crash|issue|exception|traceback)\b/i.test(text)) {
    errors.push(text);
  } else if (
    /\b(because|reason|important|always|never|warning|careful|don't|avoid|must|should|need to|has to)\b/i.test(
      text,
    )
  ) {
    facts.push(text);
  } else if (text.length > 40) {
    general.push(text);
  }
}
