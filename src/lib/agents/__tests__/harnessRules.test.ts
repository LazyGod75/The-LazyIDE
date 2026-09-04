/* harnessRules.test.ts — unit tests for the brain-as-harness rule module.
   Covers the PURE functions only (parse/select/render/assemble) — the
   I/O wrappers need the platform mock and are exercised elsewhere.
*/
import { describe, it, expect } from 'vitest';
import {
  parseRulesFile,
  matchPathGlob,
  selectRulesForContext,
  buildRulesInjectionBlock,
  buildProjectStateBlock,
  assembleHarnessSessionBlock,
  buildRuleArticleHtml,
  parseRuleCssOutput,
  renderAgentsMdBlock,
  AGENTS_MD_BEGIN_MARKER,
  AGENTS_MD_END_MARKER,
  RULE_NEURON_TYPE,
  type HarnessRule,
} from '../harnessRules';

const base = (partial: Partial<HarnessRule>): HarnessRule => ({
  id: 'r1',
  title: '[rule] Test rule',
  body: 'Always run tests before claiming done',
  scope: 'project',
  priority: 50,
  source: 'manual',
  status: 'proven',
  tags: [],
  ...partial,
});

describe('parseRulesFile', () => {
  it('parses bulleted rules from a CLAUDE.md-like file', () => {
    const content = [
      '# Project Guide',
      '',
      '## Rules',
      '- Always run the test suite before merging',
      '- Use relative imports inside src/',
      '## Conventions',
      '- Never commit .env files',
      '',
      'A long paragraph that should be skipped because it is context and not a rule and it goes on and on and on and on and on and on and on and on and on and on and on and on.',
    ].join('\n');

    const rules = parseRulesFile(content, { scope: 'project', project: 'p1' });
    expect(rules.length).toBe(3);
    expect(rules.every((r) => r.scope === 'project')).toBe(true);
    expect(rules.every((r) => r.source === 'imported')).toBe(true);
    expect(rules.map((r) => r.body)).toContain('Always run the test suite before merging');
  });

  it('skips fenced code blocks and headings', () => {
    const content = [
      '```bash',
      '- ls -la',
      '```',
      '## Rules',
      '- Real rule',
    ].join('\n');
    const rules = parseRulesFile(content);
    expect(rules.map((r) => r.body)).toEqual(['Real rule']);
  });

  it('deduplicates identical rules', () => {
    const content = ['- run tests first', '- run tests first', '- run tests first'].join('\n');
    expect(parseRulesFile(content).length).toBe(1);
  });
});


describe('matchPathGlob', () => {
  it('matches ** wildcards', () => {
    expect(matchPathGlob('src/**', 'src/lib/agents/harnessRules.ts')).toBe(true);
    expect(matchPathGlob('src/**', 'docs/readme.md')).toBe(false);
  });

  it('matches single * within a segment', () => {
    expect(matchPathGlob('src/*.ts', 'src/main.ts')).toBe(true);
    expect(matchPathGlob('src/*.ts', 'src/lib/main.ts')).toBe(false);
  });

  it('treats missing glob as applies-everywhere', () => {
    expect(matchPathGlob(undefined, 'anything/at/all.ts')).toBe(true);
  });

  it('is windows-path tolerant', () => {
    expect(matchPathGlob('src\\**', 'src/lib/main.ts')).toBe(true);
  });
});

describe('selectRulesForContext', () => {
  const rules = [
    base({ id: 'g1', scope: 'general', priority: 90 }),
    base({ id: 'p1', scope: 'project', project: 'projA', priority: 80 }),
    base({ id: 'p2', scope: 'project', project: 'projB', priority: 80 }),
    base({ id: 'm1', scope: 'module', pathGlob: 'src/lib/**', priority: 70 }),
    base({ id: 'a1', scope: 'agent', agentName: 'reviewer', priority: 60 }),
    base({ id: 'mode1', scope: 'mode', mode: 'manager', priority: 50 }),
    base({ id: 'ev', scope: 'general', priority: 100, status: 'evicted' }),
    base({ id: 'tr', scope: 'general', priority: 10, status: 'trial' }),
  ];

  it('selects general + matching project + matching module + matching agent + matching mode', () => {
    const selected = selectRulesForContext(rules, {
      project: 'projA',
      activePaths: ['src/lib/agents/harnessRules.ts'],
      agentName: 'reviewer',
      mode: 'manager',
    });
    const ids = selected.map((r) => r.id);
    expect(ids).toContain('g1');
    expect(ids).toContain('p1');
    expect(ids).not.toContain('p2');
    expect(ids).toContain('m1');
    expect(ids).toContain('a1');
    expect(ids).toContain('mode1');
  });

  it('never selects evicted rules', () => {
    const selected = selectRulesForContext(rules, {});
    expect(selected.map((r) => r.id)).not.toContain('ev');
  });

  it('includes trial rules by default and excludes them when includeTrial=false', () => {
    expect(selectRulesForContext(rules, {}).map((r) => r.id)).toContain('tr');
    expect(selectRulesForContext(rules, { includeTrial: false }).map((r) => r.id)).not.toContain('tr');
  });

  it('sorts by priority descending', () => {
    const selected = selectRulesForContext(rules, {});
    const priorities = selected.map((r) => r.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => b - a));
  });
});

describe('buildRulesInjectionBlock', () => {
  it('returns empty for no rules', () => {
    expect(buildRulesInjectionBlock([])).toBe('');
  });

  it('wraps rules in harness_rules block and respects token budget', () => {
    const rules = [
      base({ id: 'a', body: 'rule one that is fairly long to consume budget tokens generously here' }),
      base({ id: 'b', body: 'rule two that is fairly long to consume budget tokens generously here' }),
    ];
    const block = buildRulesInjectionBlock(rules, 2);
    expect(block).toContain('<harness_rules>');
    expect(block).toContain('</harness_rules>');
    expect(block.split('\n').filter((l) => l.startsWith('- ')).length).toBeLessThanOrEqual(2);
  });
});

describe('buildProjectStateBlock', () => {
  it('renders objectives with counts', () => {
    const block = buildProjectStateBlock([
      { title: 'Refactor auth', currentCount: 2, targetCount: 5, projectId: 'projA' },
      { title: 'Migrate db', currentCount: 1, targetCount: null, projectId: 'projB' },
    ], { project: 'projA' });
    expect(block).toContain('<project_state>');
    expect(block).toContain('Refactor auth (2/5)');
    expect(block).not.toContain('Migrate db');
  });

  it('returns empty for no relevant objectives', () => {
    expect(buildProjectStateBlock([], { project: 'projA' })).toBe('');
  });
});

describe('assembleHarnessSessionBlock', () => {
  it('combines general + scoped rules + project state', () => {
    const rules = [
      base({ id: 'g', scope: 'general', body: 'general rule' }),
      base({ id: 'p', scope: 'project', project: 'projA', body: 'project rule' }),
      base({ id: 'other', scope: 'project', project: 'projB', body: 'other project rule' }),
    ];
    const block = assembleHarnessSessionBlock(
      rules,
      { project: 'projA' },
      [{ title: 'Ship v2', currentCount: 1, targetCount: 3, projectId: 'projA' }],
    );
    expect(block).toContain('general rule');
    expect(block).toContain('project rule');
    expect(block).not.toContain('other project rule');
    expect(block).toContain('Ship v2 (1/3)');
  });

  it('returns empty when nothing applies', () => {
    expect(assembleHarnessSessionBlock([], { project: 'projA' }, [])).toBe('');
  });
});

describe('buildRuleArticleHtml', () => {
  it('serializes rule attributes onto the article element', () => {
    const html = buildRuleArticleHtml(base({
      id: 'r1',
      scope: 'module',
      project: 'projA',
      pathGlob: 'src/**',
      agentName: 'reviewer',
      mode: 'manager',
      priority: 90,
      source: 'learned',
      status: 'trial',
      validUntil: '2027-01-01T00:00:00.000Z',
    }));
    expect(html).toContain(`data-cerveau-type="${RULE_NEURON_TYPE}"`);
    expect(html).toContain('data-cerveau-scope="module"');
    expect(html).toContain('data-cerveau-project="projA"');
    expect(html).toContain('data-cerveau-path="src/**"');
    expect(html).toContain('data-cerveau-agent="reviewer"');
    expect(html).toContain('data-cerveau-mode="manager"');
    expect(html).toContain('data-cerveau-priority="90"');
    expect(html).toContain('data-cerveau-source="learned"');
    expect(html).toContain('data-cerveau-status="trial"');
    expect(html).toContain('data-cerveau-valid-until="2027-01-01T00:00:00.000Z"');
  });
});

describe('parseRuleCssOutput', () => {
  it('parses the engine CSS-query output shape', () => {
    const raw = [
      '#abc123 | [rule] Always run tests: Always run the suite before merging',
      '#def456 | [rule] Use relative imports: Prefer relative imports inside src/',
    ].join('\n');
    const rules = parseRuleCssOutput(raw);
    expect(rules.length).toBe(2);
    expect(rules[0].id).toBe('abc123');
    expect(rules[0].body).toContain('Always run the suite');
  });

  it('returns empty for no matches', () => {
    expect(parseRuleCssOutput('0 matches')).toEqual([]);
    expect(parseRuleCssOutput('')).toEqual([]);
  });
});

describe('renderAgentsMdBlock', () => {
  it('wraps the projection in ownership markers and scopes to the project', () => {
    const block = renderAgentsMdBlock(
      [
        base({ id: 'g', scope: 'general', body: 'general rule' }),
        base({ id: 'p', scope: 'project', project: 'projA', body: 'project rule' }),
        base({ id: 'other', scope: 'project', project: 'projB', body: 'other rule' }),
      ],
      [{ title: 'Ship v2', currentCount: 1, targetCount: 3, projectId: 'projA' }],
      { project: 'projA' },
    );
    expect(block).toContain(AGENTS_MD_BEGIN_MARKER);
    expect(block).toContain(AGENTS_MD_END_MARKER);
    expect(block).toContain('general rule');
    expect(block).toContain('project rule');
    expect(block).not.toContain('other rule');
    expect(block).toContain('Ship v2 (1/3)');
  });
});
