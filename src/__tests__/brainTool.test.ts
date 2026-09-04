/**
 * Tests for the on-demand brain_search tool (WS3):
 *   - parseBrainSearchDirective(): pure directive parser
 *   - buildSystemPrompt(): tool grounding line is injected when brain_search
 *     is offered, and absent otherwise.
 */

import { describe, it, expect } from 'vitest';

import {
  BRAIN_SEARCH_TOOL,
  BRAIN_QUERY_CSS_TOOL,
  BRAIN_NEIGHBOURS_TOOL,
  STRUCTURAL_BRAIN_TOOLS,
  runBrainQueryCss,
  runBrainNeighbours,
  hasBrainSearchTool,
  hasStructuralBrainTools,
  parseBrainSearchDirective,
  parseBrainDirective,
} from '../lib/brain/brainTool';
import {
  buildSystemPrompt,
  BRAIN_SEARCH_GROUNDING,
} from '../lib/models/systemPrompts';
import type { ChatTool } from '../lib/models/types';

// ── parseBrainSearchDirective ──────────────────────────────────────

describe('parseBrainSearchDirective', () => {
  it('extracts the query from a BRAIN_SEARCH directive line', () => {
    const out = 'BRAIN_SEARCH: how is auth built';
    expect(parseBrainSearchDirective(out)).toBe('how is auth built');
  });

  it('extracts the query when the directive follows reasoning/prose', () => {
    const out = [
      'Let me check the project memory first.',
      'BRAIN_SEARCH: how is auth built',
    ].join('\n');
    expect(parseBrainSearchDirective(out)).toBe('how is auth built');
  });

  it('strips leading reasoning-channel lines before matching', () => {
    const out = `\x1b[reasoning]internal planning\nBRAIN_SEARCH: payment flow`;
    expect(parseBrainSearchDirective(out)).toBe('payment flow');
  });

  it('tolerates leading whitespace on the directive line', () => {
    const out = '   BRAIN_SEARCH:   trailing and leading   ';
    expect(parseBrainSearchDirective(out)).toBe('trailing and leading');
  });

  it('returns the last directive when several are present', () => {
    const out = 'BRAIN_SEARCH: first query\nsome text\nBRAIN_SEARCH: second query';
    expect(parseBrainSearchDirective(out)).toBe('second query');
  });

  it('returns null for a normal answer with no directive', () => {
    const out = 'Auth uses OAuth with a refresh token rotation. Done.';
    expect(parseBrainSearchDirective(out)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseBrainSearchDirective('')).toBeNull();
    expect(parseBrainSearchDirective('   \n  ')).toBeNull();
  });

  it('returns null when the directive has no query', () => {
    expect(parseBrainSearchDirective('BRAIN_SEARCH:')).toBeNull();
    expect(parseBrainSearchDirective('BRAIN_SEARCH:   ')).toBeNull();
  });
});

// ── hasBrainSearchTool ─────────────────────────────────────────────

describe('hasBrainSearchTool', () => {
  it('is true when the brain_search tool is present', () => {
    expect(hasBrainSearchTool([BRAIN_SEARCH_TOOL])).toBe(true);
  });

  it('is false for undefined, empty, or unrelated tool lists', () => {
    expect(hasBrainSearchTool(undefined)).toBe(false);
    expect(hasBrainSearchTool([])).toBe(false);
    const other: ChatTool = { name: 'other', description: '', input_schema: {} };
    expect(hasBrainSearchTool([other])).toBe(false);
  });
});

// ── buildSystemPrompt grounding ────────────────────────────────────

describe('buildSystemPrompt tool grounding', () => {
  it('includes the brain_search grounding line when the tool is offered', () => {
    const prompt = buildSystemPrompt('ask', null, { tools: [BRAIN_SEARCH_TOOL] });
    expect(prompt).toContain(BRAIN_SEARCH_GROUNDING);
    expect(prompt).toContain('BRAIN_SEARCH: <query>');
  });

  it('omits the grounding line when no tools are offered', () => {
    const prompt = buildSystemPrompt('ask', null, {});
    expect(prompt).not.toContain(BRAIN_SEARCH_GROUNDING);
  });

  it('keeps the epistemic guardrail last, after the grounding line', () => {
    const prompt = buildSystemPrompt('ask', null, { tools: [BRAIN_SEARCH_TOOL] });
    const groundingIdx = prompt.indexOf(BRAIN_SEARCH_GROUNDING);
    const guardrailIdx = prompt.lastIndexOf('IMPORTANT: If you do not have');
    expect(groundingIdx).toBeGreaterThan(-1);
    expect(guardrailIdx).toBeGreaterThan(groundingIdx);
  });
});

// ── Structural recall tools (brain_query_css / brain_neighbours) ────

interface JsonSchemaShape {
  type: string;
  properties: Record<string, { type: string }>;
  required: string[];
}

describe('structural brain tools — definitions', () => {
  it('brain_query_css is registered with a sane schema + the data-cerveau-* CSS vocabulary', () => {
    expect(BRAIN_QUERY_CSS_TOOL.name).toBe('brain_query_css');
    const schema = BRAIN_QUERY_CSS_TOOL.input_schema as unknown as JsonSchemaShape;
    expect(schema.type).toBe('object');
    expect(schema.required).toContain('selector');
    expect(schema.properties.selector.type).toBe('string');
    expect(schema.properties.limit.type).toBe('number');
    // The description must teach every vocabulary item the task calls out.
    const d = BRAIN_QUERY_CSS_TOOL.description;
    expect(d).toContain('data-cerveau-type');
    expect(d).toContain('data-cerveau-valid-until');
    expect(d).toContain('doc-warning');
    expect(d).toContain('saliency-kind');
    expect(d).toContain('data value="src/'); // file-path vocabulary (<data value="src/...">)
    expect(d).toContain('data-cerveau-tier');
    expect(d).toContain('data-cerveau-confidence');
    // At least one concrete, runnable selector example.
    expect(d).toContain(':not([data-cerveau-valid-until])');
    expect(d).toContain('#fn-');
    expect(d).toContain('data-cerveau-symbol');
  });

  it('brain_neighbours is registered with a sane schema', () => {
    expect(BRAIN_NEIGHBOURS_TOOL.name).toBe('brain_neighbours');
    const schema = BRAIN_NEIGHBOURS_TOOL.input_schema as unknown as JsonSchemaShape;
    expect(schema.type).toBe('object');
    expect(schema.required).toContain('id');
    expect(schema.properties.id.type).toBe('string');
    expect(BRAIN_NEIGHBOURS_TOOL.description.toLowerCase()).toContain('neighbour');
  });

  it('STRUCTURAL_BRAIN_TOOLS advertises exactly the two, distinct from brain_search', () => {
    const names = STRUCTURAL_BRAIN_TOOLS.map((t) => t.name);
    expect(names).toEqual(['brain_query_css', 'brain_neighbours']);
    expect(names).not.toContain(BRAIN_SEARCH_TOOL.name);
  });
});

describe('structural brain tools — executors guard empty input', () => {
  // The empty-input guard returns BEFORE getPlatform() is consulted, so these
  // assert the guard without needing a Tauri backend.
  it('runBrainQueryCss rejects an empty/whitespace selector', async () => {
    expect(await runBrainQueryCss('   ')).toMatch(/empty selector/i);
  });
  it('runBrainNeighbours rejects an empty/whitespace id', async () => {
    expect(await runBrainNeighbours('')).toMatch(/empty id/i);
  });
});

// ── hasStructuralBrainTools ────────────────────────────────────────

describe('hasStructuralBrainTools', () => {
  it('is true when either structural tool is present', () => {
    expect(hasStructuralBrainTools([BRAIN_QUERY_CSS_TOOL])).toBe(true);
    expect(hasStructuralBrainTools([BRAIN_NEIGHBOURS_TOOL])).toBe(true);
    expect(hasStructuralBrainTools([BRAIN_SEARCH_TOOL, ...STRUCTURAL_BRAIN_TOOLS])).toBe(true);
  });

  it('is false for undefined, empty, or brain_search-only tool lists', () => {
    expect(hasStructuralBrainTools(undefined)).toBe(false);
    expect(hasStructuralBrainTools([])).toBe(false);
    // brain_search alone must NOT enable structural grounding.
    expect(hasStructuralBrainTools([BRAIN_SEARCH_TOOL])).toBe(false);
  });
});

// ── parseBrainDirective (semantic + structural) ────────────────────
// The unified parser every text-convention loop uses: recognizes all three
// directives, LAST of any kind wins, matched anywhere (reasoning-inline).

describe('parseBrainDirective', () => {
  it('parses a semantic BRAIN_SEARCH directive', () => {
    expect(parseBrainDirective('BRAIN_SEARCH: how is auth built')).toEqual({
      kind: 'search',
      arg: 'how is auth built',
    });
  });

  it('parses a structural BRAIN_QUERY_CSS directive with a spaces-containing selector', () => {
    const sel = 'article[data-cerveau-type="decision"]:not([data-cerveau-valid-until])';
    expect(parseBrainDirective(`BRAIN_QUERY_CSS: ${sel}`)).toEqual({ kind: 'query_css', arg: sel });
  });

  it('parses a structural BRAIN_NEIGHBOURS directive', () => {
    expect(parseBrainDirective('BRAIN_NEIGHBOURS: decision-oauth-pkce-2026-06-01')).toEqual({
      kind: 'neighbours',
      arg: 'decision-oauth-pkce-2026-06-01',
    });
  });

  it('extracts a directive emitted inline in a reasoning-channel line', () => {
    const out = '\x1b[reasoning]Let me list warnings. BRAIN_QUERY_CSS: aside[role="doc-warning"]';
    expect(parseBrainDirective(out)).toEqual({ kind: 'query_css', arg: 'aside[role="doc-warning"]' });
  });

  it('returns the LAST directive of ANY kind when several are present', () => {
    const out = 'BRAIN_SEARCH: fuzzy topic\nBRAIN_NEIGHBOURS: node-7';
    expect(parseBrainDirective(out)).toEqual({ kind: 'neighbours', arg: 'node-7' });
  });

  it('returns null for prose with no directive (and does not misfire on "search:")', () => {
    expect(parseBrainDirective('Voici le résultat de la recherche: tout va bien.')).toBeNull();
    expect(parseBrainDirective('')).toBeNull();
    expect(parseBrainDirective('   \n ')).toBeNull();
  });

  it('returns null when a directive keyword has no argument', () => {
    expect(parseBrainDirective('BRAIN_QUERY_CSS:   ')).toBeNull();
    expect(parseBrainDirective('BRAIN_NEIGHBOURS:')).toBeNull();
  });

  it('keeps parseBrainSearchDirective behaviour aligned for the semantic case', () => {
    // Regression: the legacy semantic-only parser and the unified parser must
    // agree on a plain BRAIN_SEARCH directive.
    const out = 'BRAIN_SEARCH: postgres sqlite migration';
    expect(parseBrainSearchDirective(out)).toBe('postgres sqlite migration');
    expect(parseBrainDirective(out)).toEqual({ kind: 'search', arg: 'postgres sqlite migration' });
  });
});
