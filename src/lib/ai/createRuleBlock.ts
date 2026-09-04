// createRuleBlock.ts — Agent tool to create project rules during coding.
//
// Inspired by Continue's create_rule_block tool.
// When an agent discovers conventions or patterns while coding, it can
// persist them as rules in .lazy/rules/ for future sessions.
//
// Combined with LazyBrain, these rules are also captured as brain neurons,
// so the brain learns project conventions over time.
//
// Rule file format:
//   .lazy/rules/<name>.md
//   ---
//   description: Brief description
//   tags: [tag1, tag2]
//   ---
//   Rule content in markdown

import { getPlatform } from '../platform/index.js';
import { joinPath } from '../paths.js';
import type { CaptureEvent } from '../platform/types.js';

// ── Types ─────────────────────────────────────────────────────────

export interface RuleBlock {
  name: string;
  description: string;
  tags: string[];
  content: string;
  /** File path relative to project root: .lazy/rules/<name>.md */
  path: string;
}

// ── Rule file parsing ─────────────────────────────────────────────

/**
 * Parse a rule block file content (YAML frontmatter + markdown body).
 */
export function parseRuleFile(content: string, path: string): RuleBlock {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  let description = '';
  let tags: string[] = [];
  let body = content;

  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1];
    body = frontmatterMatch[2].trim();

    const descMatch = frontmatter.match(/description:\s*(.+)/);
    if (descMatch) description = descMatch[1].trim();

    const tagsMatch = frontmatter.match(/tags:\s*\[(.*?)\]/);
    if (tagsMatch) {
      tags = tagsMatch[1].split(',').map(t => t.trim().replace(/['"]/g, '')).filter(Boolean);
    }
  }

  const name = path.split('/').pop()?.replace(/\.md$/, '') ?? path;

  return { name, description, tags, content: body, path };
}

/**
 * Format a RuleBlock as a file content string (frontmatter + body).
 */
export function formatRuleFile(rule: Omit<RuleBlock, 'path'>): string {
  const tagsStr = rule.tags.length > 0 ? `[${rule.tags.join(', ')}]` : '[]';
  return `---\ndescription: ${rule.description}\ntags: ${tagsStr}\n---\n${rule.content}\n`;
}

// ── Rule management ───────────────────────────────────────────────

const RULES_DIR = '.lazy/rules';

/**
 * Load all rule blocks from .lazy/rules/ directory.
 */
export async function loadRuleBlocks(projectRoot: string): Promise<RuleBlock[]> {
  const platform = getPlatform();
  // joinPath (not a hardcoded '/' + forced-forward-slash .replace()) —
  // projectRoot is typically Rust's own canonicalize() output (verbatim
  // '\\?\'-prefixed on Windows). The previous .replace(/\\/g, '/') actively
  // made this worse: it rewrote the '\\?\' verbatim prefix itself into
  // '//?/', an unresolvable path. See paths.ts's header comment for the
  // full Windows verbatim-path bug-class history.
  const rulesPath = joinPath(projectRoot, RULES_DIR);
  const rules: RuleBlock[] = [];

  try {
    const entries = await platform.fs.readDir(rulesPath);
    for (const entry of entries) {
      if (entry.isDir || !entry.name.endsWith('.md')) continue;
      try {
        const content = await platform.fs.readFile(entry.path);
        const rule = parseRuleFile(content, entry.path);
        rules.push(rule);
      } catch { /* skip unreadable files */ }
    }
  } catch {
    // Directory doesn't exist yet — no rules
  }

  return rules;
}

/**
 * Create a new rule block file in .lazy/rules/.
 * Also captures it to the brain for persistence.
 */
export async function createRuleBlock(
  projectRoot: string,
  opts: {
    name: string;
    description: string;
    tags?: string[];
    content: string;
  },
): Promise<RuleBlock> {
  const platform = getPlatform();
  const safeName = opts.name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const path = joinPath(projectRoot, RULES_DIR, `${safeName}.md`);

  // Ensure directory exists
  try {
    await platform.fs.createDir(joinPath(projectRoot, RULES_DIR));
  } catch { /* might already exist */ }

  const rule: RuleBlock = {
    name: safeName,
    description: opts.description,
    tags: opts.tags ?? [],
    content: opts.content,
    path,
  };

  const fileContent = formatRuleFile(rule);
  await platform.fs.writeFile(path, fileContent);

  // Capture to brain for learning
  try {
    const event: CaptureEvent = {
      kind: 'decision',
      title: `Rule: ${opts.description}`,
      text: opts.content,
      tags: ['rule', 'convention', ...(opts.tags ?? [])],
      files: [path],
      source: 'agent-rule',
      topic: safeName,
      space: 'code',
    };
    await platform.brain.capture(event);
  } catch {
    // fire-and-forget — never blocks rule creation
  }

  return rule;
}

/**
 * Build a system prompt section from all loaded rules.
 * This is appended to the agent/chat system prompt.
 */
export function buildRulesPrompt(rules: RuleBlock[]): string {
  if (rules.length === 0) return '';

  const sections = rules.map(rule => {
    const tags = rule.tags.length > 0 ? ` [${rule.tags.join(', ')}]` : '';
    return `### ${rule.name}${tags}\n${rule.description}\n\n${rule.content}`;
  });

  return `\n\n## Project Rules (.lazy/rules)\nFollow these project-specific conventions:\n\n${sections.join('\n\n')}\n`;
}

// ── Agent tool definition ─────────────────────────────────────────

/**
 * Tool definition for the agent system prompt.
 * The agent can call this to create a rule block when it discovers a convention.
 */
export const CREATE_RULE_BLOCK_TOOL_PROMPT = `
CREATE RULE BLOCK:
When you discover a project convention, pattern, or best practice while coding,
persist it as a rule for future sessions:

ACTION: create_rule
ARGS: {"name": "naming-convention", "description": "Files use kebab-case", "tags": ["naming", "convention"], "content": "All new files should use kebab-case naming..."}
`;

/**
 * Parse agent output for a create_rule action.
 */
export function parseCreateRuleAction(args: string): {
  name: string;
  description: string;
  tags?: string[];
  content: string;
} | null {
  try {
    const parsed = JSON.parse(args);
    if (!parsed.name || !parsed.description || !parsed.content) return null;
    return {
      name: parsed.name,
      description: parsed.description,
      tags: parsed.tags,
      content: parsed.content,
    };
  } catch {
    return null;
  }
}
