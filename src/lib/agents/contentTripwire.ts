/* contentTripwire.ts — P7.7: Content tripwire hook.

   Provides a hook system that fires when mission output matches configurable
   patterns (regex/keyword), enabling automated responses to specific content
   in agent outputs — e.g. detecting secrets, banned patterns, or triggering
   reviews when certain keywords appear.

   Tripwires are registered globally and checked against mission output text.
   When a tripwire fires, it emits a journal event and optionally runs a
   callback.
*/

import { emitEvent } from '../journal/journal.js';

export type TripwireSeverity = 'info' | 'warning' | 'critical';

export interface TripwireRule {
  id: string;
  name: string;
  /** Regex pattern to match against output text. */
  pattern: string;
  /** Severity level. */
  severity: TripwireSeverity;
  /** Optional action to run when the tripwire fires. */
  action?: (match: TripwireMatch) => void | Promise<void>;
  /** Description of what this tripwire detects. */
  description?: string;
  /** If true, the mission is flagged for review. */
  flagForReview?: boolean;
}

export interface TripwireMatch {
  ruleId: string;
  ruleName: string;
  severity: TripwireSeverity;
  matchedText: string;
  missionId: string;
  projectId: string;
  timestamp: number;
}

class TripwireRegistry {
  private rules = new Map<string, TripwireRule>();

  register(rule: TripwireRule): void {
    this.rules.set(rule.id, rule);
  }

  unregister(id: string): void {
    this.rules.delete(id);
  }

  get(id: string): TripwireRule | undefined {
    return this.rules.get(id);
  }

  list(): TripwireRule[] {
    return Array.from(this.rules.values());
  }

  /** Check text against all registered tripwires. Returns all matches. */
  async check(
    text: string,
    context: { missionId: string; projectId: string },
  ): Promise<TripwireMatch[]> {
    const matches: TripwireMatch[] = [];

    for (const rule of this.rules.values()) {
      try {
        const regex = new RegExp(rule.pattern, 'gi');
        const match = regex.exec(text);
        if (match) {
          const tripwireMatch: TripwireMatch = {
            ruleId: rule.id,
            ruleName: rule.name,
            severity: rule.severity,
            matchedText: match[0],
            missionId: context.missionId,
            projectId: context.projectId,
            timestamp: Date.now(),
          };

          matches.push(tripwireMatch);

          // Emit journal event
          await emitEvent({
            type: 'agent.message',
            tsMs: Date.now(),
            projectId: context.projectId,
            actor: 'system',
            payload: {
              from: 'tripwire',
              to: context.missionId,
              text: `[${rule.severity.toUpperCase()}] ${rule.name}: matched "${match[0]}"`,
            },
          }).catch(() => {});

          // Run optional action
          if (rule.action) {
            try {
              await rule.action(tripwireMatch);
            } catch {
              // Action failure is non-fatal
            }
          }
        }
      } catch {
        // Invalid regex — skip this rule
      }
    }

    return matches;
  }

  /** Check if any critical tripwire matched. */
  hasCritical(matches: TripwireMatch[]): boolean {
    return matches.some((m) => m.severity === 'critical');
  }

  /** Check if any tripwire flagged for review. */
  hasReviewFlag(matches: TripwireMatch[]): boolean {
    return matches.some((m) => {
      const rule = this.rules.get(m.ruleId);
      return rule?.flagForReview === true;
    });
  }
}

/** Global tripwire registry instance. */
export const tripwireRegistry = new TripwireRegistry();

/** Common tripwire presets. */
export const TripwirePresets = {
  /** Detect potential API keys / secrets in output. */
  secretLeak: (): TripwireRule => ({
    id: 'secret-leak',
    name: 'Secret Leak Detection',
    pattern: '(?:sk-[a-zA-Z0-9]{32,}|ghp_[a-zA-Z0-9]{36,}|AKIA[A-Z0-9]{16})',
    severity: 'critical',
    flagForReview: true,
    description: 'Detects potential API keys, GitHub tokens, or AWS keys in output',
  }),

  /** Detect error stack traces in final output. */
  stackTrace: (): TripwireRule => ({
    id: 'stack-trace',
    name: 'Stack Trace in Output',
    pattern: 'at\\s+\\S+\\s+\\(.*:\\d+:\\d+\\)',
    severity: 'warning',
    description: 'Detects stack traces that may indicate unhandled errors',
  }),

  /** Detect TODO/FIXME left in output. */
  todoLeftover: (): TripwireRule => ({
    id: 'todo-leftover',
    name: 'TODO/FIXME Leftover',
    pattern: '\\b(?:TODO|FIXME|HACK|XXX)\\b',
    severity: 'info',
    description: 'Detects TODO/FIXME comments that may indicate incomplete work',
  }),
};
