/* harnessParseRules.ts — parse AGENTS.md / CLAUDE.md / .cursorrules into
   harness rules. Extracted from harnessRules.ts (parseRulesFile cyclomatic
   complexity 19, ratchet ceiling 12). */

import type { HarnessRule, RuleScope, RuleSource, RuleStatus } from './harnessRules.js';

export interface ParseRulesFileOpts {
  scope?: RuleScope;
  project?: string;
  source?: RuleSource;
  status?: RuleStatus;
  priority?: number;
  maxRuleChars?: number;
}

function toggleFence(trimmed: string, inFence: boolean): boolean | null {
  if (trimmed.startsWith('```')) return !inFence;
  return null;
}

function lineBodyIfRule(trimmed: string, maxRuleChars: number): string | null {
  const isBullet = /^[-*•]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed);
  if (!isBullet && trimmed.length > 140) return null;
  if (trimmed.length > maxRuleChars) return null;
  const body = trimmed.replace(/^[-*•]\s+/, '').replace(/^\d+[.)]\s+/, '').trim();
  if (!body || body.length < 8) return null;
  return body;
}

function ingestParsedLine(
  trimmed: string,
  state: { inFence: boolean; seen: Set<string>; rules: HarnessRule[] },
  opts: { scope: RuleScope; project?: string; source: RuleSource; status: RuleStatus; priority: number; maxRuleChars: number },
): void {
  const fence = toggleFence(trimmed, state.inFence);
  if (fence !== null) {
    state.inFence = fence;
    return;
  }
  if (state.inFence) return;
  if (/^#{1,6}\s/.test(trimmed)) return;
  const body = lineBodyIfRule(trimmed, opts.maxRuleChars);
  if (!body) return;
  const key = body.toLowerCase().replace(/\s+/g, ' ');
  if (state.seen.has(key)) return;
  state.seen.add(key);
  state.rules.push({
    id: `rule-${state.rules.length + 1}`,
    title: `[rule] ${body.slice(0, 100)}`,
    body,
    scope: opts.scope,
    project: opts.project,
    priority: opts.priority,
    source: opts.source,
    status: opts.status,
    tags: ['parsed'],
  });
}

/**
 * Parse a plain-text onboarding file into harness rules. Pure.
 * A "rule" is any bulleted/numbered line or short standalone line that is
 * NOT a heading, a blank line, a fence, or a paragraph longer than
 * `maxRuleChars`. Rules are deduplicated by normalized text.
 */
export function parseRulesFile(content: string, opts: ParseRulesFileOpts = {}): HarnessRule[] {
  const defaults = {
    scope: opts.scope ?? 'project',
    project: opts.project,
    source: opts.source ?? 'imported',
    status: opts.status ?? 'proven',
    priority: opts.priority ?? 50,
    maxRuleChars: opts.maxRuleChars ?? 240,
  };
  const state = { inFence: false, seen: new Set<string>(), rules: [] as HarnessRule[] };
  for (const raw of content.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    ingestParsedLine(trimmed, state, defaults);
  }
  return state.rules;
}
