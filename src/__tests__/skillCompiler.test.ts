/* skillCompiler.test.ts — unit tests for skill compilation. */

import { describe, it, expect } from 'vitest';
import { compileStep, compileSkill, compileSkillOverlay } from '../lib/bots/skillCompiler';
import type { TeachJournal, TeachStep } from '../lib/bots/teachMode';

function makeStep(overrides: Partial<TeachStep> = {}): TeachStep {
  return {
    id: 'step_1',
    kind: 'click',
    target: 'the Submit button',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeJournal(steps: TeachStep[] = []): TeachJournal {
  return {
    id: 'teach_1',
    botId: 'bot_1',
    skillName: 'Test Skill',
    steps,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:10:00.000Z',
  };
}

describe('compileStep', () => {
  it('compiles a navigate step', () => {
    const step = makeStep({ kind: 'navigate', target: 'https://example.com' });
    expect(compileStep(step)).toContain('Navigate to');
    expect(compileStep(step)).toContain('https://example.com');
  });

  it('compiles a type step with value and target', () => {
    const step = makeStep({ kind: 'type', target: 'the search field', value: 'laptop' });
    const result = compileStep(step);
    expect(result).toContain('Type');
    expect(result).toContain('"laptop"');
    expect(result).toContain('the search field');
  });

  it('compiles a click step with a selector', () => {
    const step = makeStep({ kind: 'click', target: 'the Buy button', selector: '.buy-btn' });
    const result = compileStep(step);
    expect(result).toContain('Click');
    expect(result).toContain('the Buy button');
    expect(result).toContain('.buy-btn');
  });

  it('compiles a note step', () => {
    const step = makeStep({ kind: 'note', target: '', note: 'This step is critical' });
    const result = compileStep(step);
    expect(result).toContain('Note:');
    expect(result).toContain('This step is critical');
  });

  it('includes the teacher note when present on a non-note step', () => {
    const step = makeStep({ kind: 'click', target: 'button', note: 'Be careful here' });
    const result = compileStep(step);
    expect(result).toContain('Be careful here');
  });
});

describe('compileSkill', () => {
  it('produces a prompt with the skill name', () => {
    const journal = makeJournal([makeStep()]);
    const skill = compileSkill(journal);
    expect(skill.name).toBe('Test Skill');
    expect(skill.prompt).toContain('Test Skill');
  });

  it('numbers the steps', () => {
    const journal = makeJournal([
      makeStep({ id: 'step_1', kind: 'navigate', target: 'url' }),
      makeStep({ id: 'step_2', kind: 'click', target: 'btn' }),
      makeStep({ id: 'step_3', kind: 'type', target: 'field', value: 'text' }),
    ]);
    const skill = compileSkill(journal);
    expect(skill.stepCount).toBe(3);
    expect(skill.prompt).toContain('1. ');
    expect(skill.prompt).toContain('2. ');
    expect(skill.prompt).toContain('3. ');
  });

  it('includes a failure instruction', () => {
    const journal = makeJournal([makeStep()]);
    const skill = compileSkill(journal);
    expect(skill.prompt).toContain('screenshot');
    expect(skill.prompt).toContain('report what went wrong');
  });
});

describe('compileSkillOverlay', () => {
  it('wraps the skill in a LEARNED SKILL section', () => {
    const journal = makeJournal([makeStep()]);
    const overlay = compileSkillOverlay(journal);
    expect(overlay).toContain('LEARNED SKILL');
    expect(overlay).toContain('Test Skill');
  });

  it('starts with a blank line for clean appending', () => {
    const journal = makeJournal();
    const overlay = compileSkillOverlay(journal);
    expect(overlay.startsWith('\n')).toBe(true);
  });
});
