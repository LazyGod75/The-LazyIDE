import { describe, it, expect } from 'vitest';
import { validateRulesInput, evaluateRule, type CustomRule } from '../customRules';

describe('validateRulesInput', () => {
  it('treats empty/whitespace-only input as "no rules", not an error', () => {
    expect(validateRulesInput('')).toEqual({ rules: [], errors: [] });
    expect(validateRulesInput('   \n  ')).toEqual({ rules: [], errors: [] });
  });

  it('accepts a valid rule batch', () => {
    const input = JSON.stringify([
      { id: 'r1', condition: 'action=launch_mission and credits>100', action: 'ask', message: 'High-cost mission' },
    ]);
    const result = validateRulesInput(input);
    expect(result.errors).toEqual([]);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].id).toBe('r1');
  });

  it('reports a JSON syntax error and returns no rules', () => {
    const result = validateRulesInput('not json');
    expect(result.rules).toEqual([]);
    expect(result.errors).toEqual([{ type: 'invalidJson', message: expect.any(String) }]);
  });

  it('reports non-array top-level JSON', () => {
    const result = validateRulesInput('{}');
    expect(result.rules).toEqual([]);
    expect(result.errors).toEqual([{ type: 'notArray' }]);
  });

  it('reports an unknown rule field and refuses to persist any rule from the batch', () => {
    const input = JSON.stringify([
      { id: 'r1', condition: 'action=launch_mission', action: 'ask', priority: 5 },
      { id: 'r2', condition: 'action=brain_query', action: 'allow' },
    ]);
    const result = validateRulesInput(input);
    expect(result.rules).toEqual([]);
    expect(result.errors).toContainEqual({ type: 'unknownField', index: 0, field: 'priority' });
  });

  it('reports a missing id, missing condition, and invalid action', () => {
    const input = JSON.stringify([{ action: 'notarealaction' }]);
    const result = validateRulesInput(input);
    expect(result.rules).toEqual([]);
    expect(result.errors).toContainEqual({ type: 'missingId', index: 0 });
    expect(result.errors).toContainEqual({ type: 'missingCondition', index: 0 });
    expect(result.errors).toContainEqual({ type: 'invalidAction', index: 0 });
  });

  it('reports an unrecognized condition clause', () => {
    const input = JSON.stringify([{ id: 'r1', condition: 'credit>100', action: 'ask' }]);
    const result = validateRulesInput(input);
    expect(result.rules).toEqual([]);
    expect(result.errors).toEqual([{ type: 'unknownCondition', index: 0, clause: 'credit>100' }]);
  });

  it('accepts both the legacy "cost>" and the new "credits>" condition spelling', () => {
    const input = JSON.stringify([
      { id: 'r1', condition: 'cost>500', action: 'deny' },
      { id: 'r2', condition: 'credits>500', action: 'deny' },
    ]);
    const result = validateRulesInput(input);
    expect(result.errors).toEqual([]);
    expect(result.rules).toHaveLength(2);
  });
});

describe('evaluateRule — credits>/cost> alias', () => {
  it('"credits>" and "cost>" evaluate identically against costEstimateCents', () => {
    const creditsRule: CustomRule = { id: 'r1', condition: 'credits>500', action: 'deny' };
    const costRule: CustomRule = { id: 'r2', condition: 'cost>500', action: 'deny' };
    expect(evaluateRule(creditsRule, { actionType: 'x', costEstimateCents: 600 })).toBe(true);
    expect(evaluateRule(costRule, { actionType: 'x', costEstimateCents: 600 })).toBe(true);
    expect(evaluateRule(creditsRule, { actionType: 'x', costEstimateCents: 400 })).toBe(false);
    expect(evaluateRule(costRule, { actionType: 'x', costEstimateCents: 400 })).toBe(false);
  });
});
