/* lazyReasoningBlocks/fsm.ts — Difficulty Finite State Machine.
   Scores each agent reasoning step and classifies difficulty in real-time.
   States: INIT → FAST → NORMAL → SLOW → SKIP → END.

   The FSM drives:
   - Model routing (FAST → cheap model, SLOW → expensive model)
   - Monitor cooldowns (how many steps between injections)
   - E-trace retrieval gating
   - Early-exit nudges (SKIP state)

   Inspired by ReasonBlocks' DifficultyFSM, adapted for Lazy's managed agent loop.
   Pure local heuristics — no external API calls.
*/

// ── Types ─────────────────────────────────────────────────────────

export type FSMState = 'INIT' | 'FAST' | 'NORMAL' | 'SLOW' | 'SKIP' | 'END';

export interface FSMThresholds {
  fastThreshold: number;
  slowThreshold: number;
  skipThreshold: number;
  hysteresisMargin: number;
  fastWindow: number;
  slowWindow: number;
  skipWindow: number;
}

export const DEFAULT_THRESHOLDS: FSMThresholds = {
  fastThreshold: 0.2,
  slowThreshold: 0.6,
  skipThreshold: 0.85,
  hysteresisMargin: 0.1,
  fastWindow: 6,
  slowWindow: 5,
  skipWindow: 35,
};

// ── Step scoring ──────────────────────────────────────────────────

/**
 * Score a reasoning step on [0, 1] where 0 = trivially easy, 1 = very hard.
 * Heuristic combining:
 * - Hedging density ("maybe", "perhaps", "might", "could be")
 * - Response length (longer = more complex)
 * - Error language ("error", "failed", "cannot", "unable")
 * - Entity density (many file/function names = complex context)
 */
export function scoreStep(text: string): number {
  if (!text || text.trim().length === 0) return 0;

  const lower = text.toLowerCase();
  const wordCount = lower.split(/\s+/).filter(Boolean).length;

  // Hedging density
  const hedgeWords = ['maybe', 'perhaps', 'might', 'could be', 'possibly', 'not sure', 'unclear', 'uncertain', 'i think', 'probably'];
  const hedgeCount = hedgeWords.reduce((acc, w) => acc + (lower.match(new RegExp(w, 'g'))?.length ?? 0), 0);
  const hedgeDensity = wordCount > 0 ? Math.min(1, hedgeCount / Math.max(1, wordCount / 20)) : 0;

  // Error language
  const errorWords = ['error', 'failed', 'cannot', 'unable', 'exception', 'crash', 'bug', 'broken', 'does not work', "doesn't work"];
  const errorCount = errorWords.reduce((acc, w) => acc + (lower.match(new RegExp(w, 'g'))?.length ?? 0), 0);
  const errorDensity = Math.min(1, errorCount / 5);

  // Response length factor (normalized: 500+ words = max complexity)
  const lengthFactor = Math.min(1, wordCount / 500);

  // Entity density (file paths, function names, class names)
  const entityMatches = lower.match(/[a-z_][a-z0-9_]*\.(ts|js|tsx|jsx|py|rs|go|java)|\b[a-z][a-z0-9_]*\(\)/g) ?? [];
  const entityDensity = Math.min(1, entityMatches.length / 10);

  // Weighted combination
  const score = hedgeDensity * 0.3 + errorDensity * 0.25 + lengthFactor * 0.2 + entityDensity * 0.25;
  return Math.min(1, Math.max(0, score));
}

// ── FSM ───────────────────────────────────────────────────────────

export class DifficultyFSM {
  private state: FSMState = 'INIT';
  private scores: number[] = [];
  private thresholds: FSMThresholds;

  constructor(thresholds?: Partial<FSMThresholds>) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  /** Advance the FSM with a new step score. Returns the new state. */
  transition(score: number): FSMState {
    this.scores.push(score);

    if (this.state === 'INIT') {
      this.state = 'NORMAL';
      return this.state;
    }

    if (this.state === 'END') return this.state;

    const { fastThreshold, slowThreshold, skipThreshold, hysteresisMargin, fastWindow, slowWindow, skipWindow } = this.thresholds;

    if (this.state === 'NORMAL') {
      // Enter FAST if last fastWindow steps all below fastThreshold
      if (this.scores.length >= fastWindow) {
        const recent = this.scores.slice(-fastWindow);
        if (recent.every((s) => s < fastThreshold)) {
          this.state = 'FAST';
          return this.state;
        }
      }
      // Enter SLOW if last slowWindow steps all above slowThreshold
      if (this.scores.length >= slowWindow) {
        const recent = this.scores.slice(-slowWindow);
        if (recent.every((s) => s > slowThreshold)) {
          this.state = 'SLOW';
          return this.state;
        }
      }
      // Stay NORMAL
      return this.state;
    }

    if (this.state === 'FAST') {
      // Return to NORMAL if current score exceeds fastThreshold + hysteresisMargin
      if (score > fastThreshold + hysteresisMargin) {
        this.state = 'NORMAL';
        return this.state;
      }
      // Stay FAST
      return this.state;
    }

    if (this.state === 'SLOW') {
      // Return to NORMAL if current score drops below slowThreshold - hysteresisMargin
      if (score < slowThreshold - hysteresisMargin) {
        this.state = 'NORMAL';
        return this.state;
      }
      // Enter SKIP from SLOW if last skipWindow steps all above skipThreshold
      if (this.scores.length >= skipWindow) {
        const recent = this.scores.slice(-skipWindow);
        if (recent.every((s) => s > skipThreshold)) {
          this.state = 'SKIP';
          return this.state;
        }
      }
      // Stay SLOW
      return this.state;
    }

    if (this.state === 'SKIP') {
      // Return to SLOW if score drops below skipThreshold
      if (score < skipThreshold) {
        this.state = 'SLOW';
        return this.state;
      }
      // Stay SKIP
      return this.state;
    }

    return this.state;
  }

  getState(): FSMState {
    return this.state;
  }

  getScores(): number[] {
    return [...this.scores];
  }

  /** Monitor cooldown in steps for the current state. */
  getMonitorCooldown(): number {
    switch (this.state) {
      case 'SLOW':
      case 'SKIP':
        return 2;
      case 'NORMAL':
        return 3;
      case 'FAST':
        return 5;
      default:
        return 3;
    }
  }

  /** Whether E1 (instance-level) retrieval is allowed based on recent monitor history. */
  isE1Allowed(monitorHistory: { fired: boolean; composite: number }[]): boolean {
    if (monitorHistory.length === 0) return false;
    const current = monitorHistory[monitorHistory.length - 1];
    if (current.fired) return true;
    if (current.composite > 0.15) return true;
    // Check previous 2 steps
    const prev2 = monitorHistory.slice(-3, -1);
    return prev2.some((m) => m.fired);
  }

  reset(): void {
    this.state = 'INIT';
    this.scores = [];
  }
}
