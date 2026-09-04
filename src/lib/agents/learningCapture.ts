/* learningCapture.ts — Pattern capture and cross-project learning (Pillar D4).
   Captures DecisionPattern neurons from mission outcomes and merges them with
   prior patterns to build confidence over time.
*/

import type { DecisionPattern, MissionOutcome } from './types.js';
import { noteDecisionPattern } from './brainNotation.js';

export function capturePattern(
  trigger: string,
  action: string,
  outcome: MissionOutcome,
  projectId?: string,
  agentName?: string,
): DecisionPattern {
  const pattern: DecisionPattern = {
    id: `pattern-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    trigger,
    action,
    outcome: outcomeToPatternOutcome(outcome.status),
    confidence: 0.5,
    occurrences: 1,
    lastSeen: Date.now(),
    projectId,
    agentName,
  };
  noteDecisionPattern(pattern);
  return pattern;
}

export function mergePatterns(existing: DecisionPattern[], outcome: MissionOutcome): DecisionPattern[] {
  const targetOutcome = outcomeToPatternOutcome(outcome.status);
  const updated: DecisionPattern[] = [];
  for (const p of existing) {
    if (p.outcome === targetOutcome) {
      updated.push({
        ...p,
        occurrences: p.occurrences + 1,
        lastSeen: Date.now(),
        confidence: Math.min(0.99, p.confidence + 0.05),
      });
    } else {
      updated.push(p);
    }
  }
  return updated;
}

export function findHighConfidencePatterns(patterns: DecisionPattern[], minConfidence = 0.8, minOccurrences = 3): DecisionPattern[] {
  return patterns.filter((p) => p.confidence >= minConfidence && p.occurrences >= minOccurrences);
}

function outcomeToPatternOutcome(status: string): 'success' | 'failure' | 'partial' {
  if (status === 'done') return 'success';
  if (status === 'failed') return 'failure';
  return 'partial';
}
