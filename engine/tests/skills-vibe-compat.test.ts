import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SKILLS_DIR = join(__dirname, '..', 'plugins', 'lazybrain', 'skills');
const PORTED = [
  'lazybrain-recall',
  'lazybrain-search',
  'lazybrain-query',
  'lazybrain-summary',
  'lazybrain-time-travel',
];

describe('skills are agent-neutral', () => {
  for (const name of PORTED) {
    it(`${name}: frontmatter name matches Vibe regex and body shells only the CLI`, () => {
      const src = readFileSync(join(SKILLS_DIR, `${name}.SKILL.md`), 'utf8');
      const nameMatch = src.match(/^name:\s*(.+)$/m);
      expect(nameMatch?.[1].trim()).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      // No Claude-Code-only invocation mechanics in the body
      expect(src).not.toMatch(/Skill tool|settings\.local\.json|hookSpecificOutput/);
    });
  }
});
