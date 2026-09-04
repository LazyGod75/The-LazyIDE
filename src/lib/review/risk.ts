/* risk.ts — pure heuristic risk scoring, lifted from ReviewSpace.tsx's
   private computeHeuristicRisk (ReviewSpace.tsx itself is left untouched).
   Shared by any future review surface that wants a cheap, deterministic
   "does this diff look risky" signal without an LLM round-trip. */

export type RiskLevel = 'low' | 'medium' | 'high';

export interface HeuristicRisk {
  level: RiskLevel;
  reasons: string[];
}

const RISK_AUTH_RE = /\b(auth|oauth|token|password|credential|secret|jwt|session)\b/i;
const RISK_PAYMENT_RE = /\b(payment|stripe|charge|billing|invoice|card|pii)\b/i;
const RISK_DB_RE = /\b(migration|schema|drop\s+table|alter\s+table|delete\s+from|truncate)\b/i;
const RISK_DELETION_THRESHOLD = 40;

export interface RiskInput {
  /** File path / change title — checked alongside the diff body content. */
  title: string;
  /** Full diff text (all files concatenated) to scan for risk keywords. */
  content: string;
  /** Total removed-line count across the change. */
  removed: number;
}

export function computeHeuristicRisk(input: RiskInput): HeuristicRisk {
  const reasons: string[] = [];

  if (RISK_AUTH_RE.test(input.content) || RISK_AUTH_RE.test(input.title)) {
    reasons.push('touches auth/credentials');
  }
  if (RISK_PAYMENT_RE.test(input.content) || RISK_PAYMENT_RE.test(input.title)) {
    reasons.push('touches payment/PII');
  }
  if (RISK_DB_RE.test(input.content)) {
    reasons.push('touches DB schema');
  }
  if (input.removed >= RISK_DELETION_THRESHOLD) {
    reasons.push(`large deletion (${input.removed} lines)`);
  }

  const level: RiskLevel = reasons.length >= 2 ? 'high' : reasons.length === 1 ? 'medium' : 'low';
  return { level, reasons };
}
