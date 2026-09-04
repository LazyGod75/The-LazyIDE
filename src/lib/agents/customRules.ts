/* customRules.ts — User-defined autonomy rules (Pillar C4).
   Parses and evaluates simple custom rules that override default autonomy behavior.

   Credits-not-currency fix (real user report, 2026-08-15): the `cost>N`
   condition clause compares against RuleContext.costEstimateCents, which —
   same standing convention as ProvisioningPanel.tsx's
   costEstimateCents/formatCredits doc comment — is a CREDITS count, never a
   currency amount (this app never debits real money; on a Claude
   subscription there is no monetary charge at all, see
   formatCreditsSummary/managerEngine.ts). `credits>` is now the documented
   spelling in CustomRulesPanel.tsx's hint text; `cost>` is kept working as a
   silent alias below so any rule a user already saved under the old
   spelling keeps matching unchanged.
*/

export interface CustomRule {
  id: string;
  condition: string;
  action: 'allow' | 'deny' | 'ask';
  message?: string;
}

export interface RuleContext {
  actionType: string;
  projectId?: string;
  costEstimateCents?: number;
  model?: string;
}

export function parseRules(input: string): CustomRule[] {
  try {
    const parsed = JSON.parse(input);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidRule);
  } catch {
    return [];
  }
}

export function evaluateRule(rule: CustomRule, context: RuleContext): boolean {
  const parts = rule.condition.toLowerCase().split(/\s+and\s+/i);
  return parts.every((part) => matches(part.trim(), context));
}

function isValidRule(value: unknown): value is CustomRule {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as CustomRule;
  return (
    typeof r.id === 'string' &&
    typeof r.condition === 'string' &&
    ['allow', 'deny', 'ask'].includes(r.action)
  );
}

function matches(part: string, ctx: RuleContext): boolean {
  if (part.startsWith('action=')) return ctx.actionType === part.slice('action='.length).trim();
  if (part.startsWith('project=')) return ctx.projectId === part.slice('project='.length).trim();
  if (part.startsWith('credits>')) {
    const limit = Number(part.slice('credits>'.length).trim());
    return (ctx.costEstimateCents ?? 0) > limit;
  }
  // Legacy alias — pre-2026-08-15 spelling of the same clause (see this
  // file's header comment). Kept matching forever so an already-saved rule
  // never silently stops working.
  if (part.startsWith('cost>')) {
    const limit = Number(part.slice('cost>'.length).trim());
    return (ctx.costEstimateCents ?? 0) > limit;
  }
  if (part.startsWith('model=')) return ctx.model === part.slice('model='.length).trim();
  return part.length === 0;
}

// ── Strict validation for the authoring UI ───────────────────────────
//
// `parseRules` above is deliberately lenient (silently drops anything that
// doesn't look like a rule, returns [] on a JSON syntax error) — it exists
// for callers that just want "whatever is valid, best-effort" (e.g.
// evaluateActionGate's consumers). CustomRulesPanel.tsx used to call
// `parseRules` directly for its Save action too, which meant a typo could
// silently vanish a rule with zero feedback. `validateRulesInput` is the
// strict counterpart the panel's Save path uses instead: it is all-or-
// nothing (a single bad rule blocks the whole batch) and every problem
// found is reported in structured form so the caller can render it next to
// the editor without parsing an error string.

export type RuleValidationError =
  | { type: 'invalidJson'; message: string }
  | { type: 'notArray' }
  | { type: 'notObject'; index: number }
  | { type: 'unknownField'; index: number; field: string }
  | { type: 'missingId'; index: number }
  | { type: 'missingCondition'; index: number }
  | { type: 'unknownCondition'; index: number; clause: string }
  | { type: 'invalidAction'; index: number }
  | { type: 'invalidMessage'; index: number };

export interface RuleValidationResult {
  rules: CustomRule[];
  errors: RuleValidationError[];
}

const KNOWN_RULE_FIELDS = new Set(['id', 'condition', 'action', 'message']);
const KNOWN_ACTIONS = new Set(['allow', 'deny', 'ask']);
// 'cost>' stays accepted here too, so a rule saved under the legacy
// spelling round-trips through the editor without tripping validation.
const CONDITION_PREFIXES = ['action=', 'project=', 'credits>', 'cost>', 'model='];

/** Validates raw textarea input into rules, or the list of every problem
 *  found. All-or-nothing by design: if anything is wrong, `rules` is empty
 *  so a caller can never partially persist a malformed batch. Empty /
 *  whitespace-only input is valid and means "no rules" (clearing the
 *  textarea and saving removes every rule). */
export function validateRulesInput(input: string): RuleValidationResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { rules: [], errors: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { rules: [], errors: [{ type: 'invalidJson', message }] };
  }

  if (!Array.isArray(parsed)) {
    return { rules: [], errors: [{ type: 'notArray' }] };
  }

  const errors: RuleValidationError[] = [];

  parsed.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push({ type: 'notObject', index });
      return;
    }
    const record = entry as Record<string, unknown>;
    for (const field of Object.keys(record)) {
      if (!KNOWN_RULE_FIELDS.has(field)) errors.push({ type: 'unknownField', index, field });
    }
    if (typeof record.id !== 'string' || record.id.trim().length === 0) {
      errors.push({ type: 'missingId', index });
    }
    if (typeof record.condition !== 'string' || record.condition.trim().length === 0) {
      errors.push({ type: 'missingCondition', index });
    } else {
      const badClause = record.condition
        .split(/\s+and\s+/i)
        .map((clause) => clause.trim())
        .find((clause) => clause.length > 0 && !CONDITION_PREFIXES.some((prefix) => clause.toLowerCase().startsWith(prefix)));
      if (badClause) errors.push({ type: 'unknownCondition', index, clause: badClause });
    }
    if (typeof record.action !== 'string' || !KNOWN_ACTIONS.has(record.action)) {
      errors.push({ type: 'invalidAction', index });
    }
    if (record.message !== undefined && typeof record.message !== 'string') {
      errors.push({ type: 'invalidMessage', index });
    }
  });

  if (errors.length > 0) return { rules: [], errors };
  return { rules: parsed as CustomRule[], errors: [] };
}
