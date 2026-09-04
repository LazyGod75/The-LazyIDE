/* skillCompiler — compiles a TeachJournal into a reusable skill prompt.

   The compiled skill is a structured natural-language prompt that a bot can
   follow to reproduce the demonstrated workflow. It transforms raw steps
   (navigate, click, type, ...) into imperative instructions ("Go to URL X",
   "Click the 'Add to Cart' button", "Type 'laptop' in the search field").
*/

import type { TeachJournal, TeachStep } from './teachMode.js';

/** A compiled skill — the output of the compiler. */
export interface CompiledSkill {
  /** The skill name (from the journal). */
  name: string;
  /** The compiled prompt — inject this into the bot's system prompt or task. */
  prompt: string;
  /** The number of steps in the source journal. */
  stepCount: number;
  /** The source journal id. */
  sourceJournalId: string;
}

const KIND_VERBS: Record<TeachStep['kind'], string> = {
  navigate: 'Navigate to',
  click: 'Click',
  type: 'Type',
  select: 'Select',
  submit: 'Submit',
  wait: 'Wait for',
  screenshot: 'Take a screenshot of',
  note: 'Note:',
};

/** Compile a single teach step into an instruction line. */
export function compileStep(step: TeachStep): string {
  const verb = KIND_VERBS[step.kind];
  const parts: string[] = [verb];

  if (step.kind === 'navigate') {
    parts.push(step.target);
  } else if (step.kind === 'type' || step.kind === 'select') {
    parts.push(`"${step.value ?? ''}"`);
    parts.push('in');
    parts.push(step.target);
  } else if (step.kind === 'note') {
    parts.push(step.note ?? step.target);
  } else {
    parts.push(step.target);
  }

  if (step.selector && step.kind !== 'navigate' && step.kind !== 'note') {
    parts.push(`(selector: ${step.selector})`);
  }

  if (step.note && step.kind !== 'note') {
    parts.push(`— ${step.note}`);
  }

  return parts.join(' ');
}

/** Compile a full teach journal into a reusable skill prompt. */
export function compileSkill(journal: TeachJournal): CompiledSkill {
  const lines: string[] = [];

  lines.push(`# Skill: ${journal.skillName}`);
  lines.push('');
  lines.push('Follow these steps in order to complete this task:');
  lines.push('');

  journal.steps.forEach((step, idx) => {
    lines.push(`${idx + 1}. ${compileStep(step)}`);
  });

  lines.push('');
  lines.push('If any step fails, take a screenshot and report what went wrong before retrying.');

  return {
    name: journal.skillName,
    prompt: lines.join('\n'),
    stepCount: journal.steps.length,
    sourceJournalId: journal.id,
  };
}

/** Compile a skill and format it as a system prompt overlay that can be
 *  appended to a bot's existing system prompt. */
export function compileSkillOverlay(journal: TeachJournal): string {
  const skill = compileSkill(journal);
  const lines: string[] = [];
  lines.push('');
  lines.push('=== LEARNED SKILL ===');
  lines.push(`You have been taught the skill "${skill.name}" via demonstration.`);
  lines.push('When asked to perform this skill, follow the steps below precisely:');
  lines.push('');
  lines.push(skill.prompt);
  return lines.join('\n');
}
