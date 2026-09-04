import { describe, it, expect } from 'vitest';
import {
  buildSystemPrompt,
  RECALL_TEACHING,
  EPISTEMIC_GUARDRAIL,
  BRAIN_SEARCH_GROUNDING,
  STRUCTURAL_BRAIN_GROUNDING,
} from '../lib/models/systemPrompts';
import {
  BRAIN_SEARCH_TOOL,
  STRUCTURAL_BRAIN_TOOLS,
} from '../lib/brain/brainTool';

// Regression coverage for the Ctrl+K inline-edit HIGH defect's root cause:
// InlineEditBar.tsx / autoFix.ts used to send mode: 'edit', which carries
// an agentic "apply changes directly using your tools, then summarize"
// system prompt — appropriate for the chat Composer's "Edit" mode, wrong
// for a single-shot code transform that treats the whole response as
// literal replacement code. 'transform' is the dedicated, non-agentic mode
// introduced by the fix; these tests pin its exact contract and its
// distinctness from 'edit' so a future refactor can't quietly re-merge them.

describe('buildSystemPrompt — transform mode (code-only contract)', () => {
  it('instructs the model to return only code, with no tools, narration, or fences', () => {
    const prompt = buildSystemPrompt('transform', null);

    expect(prompt).toMatch(/only the replacement code/i);
    expect(prompt).toMatch(/do not use any tools/i);
    expect(prompt).toMatch(/do not explain, narrate/i);
    expect(prompt).toMatch(/do not wrap the code in markdown fences/i);
  });

  it('is model-agnostic (no backend-specific wording — must hold for CLI/BYOK/managed alike)', () => {
    const prompt = buildSystemPrompt('transform', null);

    expect(prompt.toLowerCase()).not.toContain('claude');
    expect(prompt.toLowerCase()).not.toContain('anthropic');
  });

  it('still appends the epistemic guardrail like every other mode', () => {
    const prompt = buildSystemPrompt('transform', null);
    expect(prompt).toMatch(/If you do not have brain\/memory context/);
  });
});

describe('buildSystemPrompt — transform vs edit (must stay distinct)', () => {
  it('edit mode keeps its agentic "use your tools" contract untouched', () => {
    // This is the Composer's "Edit" chat mode (Ask/Plan/Edit toggle) —
    // genuinely agentic and narrated by design. The fix must not touch it.
    const editPrompt = buildSystemPrompt('edit', null);
    expect(editPrompt).toMatch(/apply the requested changes directly using your tools/i);
  });

  it('transform mode does not carry the agentic "use your tools" wording', () => {
    const transformPrompt = buildSystemPrompt('transform', null);
    expect(transformPrompt).not.toMatch(/using your tools/i);
    expect(transformPrompt).not.toMatch(/summarize what you changed/i);
  });
});

// ── RECALL_TEACHING — when/how to consult and interpret project memory ──
// Condensed from the original LazyBrain recall recipe (WHEN to recall, TOPIC
// extraction, citing #ids, interpreting staleness/confidence/tier/anti-
// patterns). Wired into every mode's system prompt except 'transform' (whose
// entire response is treated as literal replacement code).

describe('buildSystemPrompt — RECALL_TEACHING', () => {
  it('is present verbatim for the default (ask) mode', () => {
    const prompt = buildSystemPrompt('ask', null);
    expect(prompt).toContain(RECALL_TEACHING);
  });

  it('is present for plan and edit modes too', () => {
    expect(buildSystemPrompt('plan', null)).toContain(RECALL_TEACHING);
    expect(buildSystemPrompt('edit', null)).toContain(RECALL_TEACHING);
  });

  it('is present regardless of whether brain_search tools are offered', () => {
    // RECALL_TEACHING teaches WHEN to recall and HOW to interpret whatever
    // context IS already injected — valuable even without an active search
    // tool, so it must not be gated on opts.tools.
    expect(buildSystemPrompt('ask', null, {})).toContain(RECALL_TEACHING);
  });

  it('teaches the FR+EN triggers, topic extraction, and result-interpretation rules', () => {
    const prompt = buildSystemPrompt('ask', null);
    // WHEN triggers (FR + EN)
    expect(prompt).toMatch(/déjà/);
    expect(prompt).toMatch(/have we/i);
    // HOW TO QUERY: topic/entity extraction, not verbatim text
    expect(prompt.toLowerCase()).toContain('postgres sqlite migration');
    // HOW TO USE RESULTS: staleness, confidence, tier, anti-patterns
    expect(prompt.toLowerCase()).toContain('supersede');
    expect(prompt).toMatch(/confidence below 0\.5/i);
    expect(prompt.toLowerCase()).toContain('working-tier');
    expect(prompt.toLowerCase()).toContain('anti-pattern');
  });

  it('still avoids genuinely-absent capabilities (no lazybrain-recall skill / Skill tool / lazybrain search CLI)', () => {
    const prompt = buildSystemPrompt('ask', null);
    expect(prompt.toLowerCase()).not.toContain('lazybrain-recall');
    expect(prompt.toLowerCase()).not.toContain('skill tool');
    expect(prompt.toLowerCase()).not.toContain('lazybrain search');
  });

  it('teaches the structural recall tools now that they are wired (brain_query_css + brain_neighbours)', () => {
    // Previously RECALL_TEACHING deliberately avoided naming CSS query /
    // neighbours because no model in the app could reach them. They are now
    // real tools (managed-agent dispatcher + native brain-MCP server), so the
    // teaching MUST name them and show at least one concrete selector.
    const prompt = buildSystemPrompt('ask', null);
    expect(prompt).toContain('brain_query_css');
    expect(prompt).toContain('brain_neighbours');
    // Structural vocabulary + a real selector example over data-cerveau-*.
    expect(prompt).toContain('data-cerveau-type="decision"');
    expect(prompt).toContain(':not([data-cerveau-valid-until])');
    expect(prompt).toContain('doc-warning');
    expect(prompt).toContain('#fn-');
  });

  it('is OMITTED for transform mode — the literal-code-output contract must stay untouched', () => {
    const prompt = buildSystemPrompt('transform', null);
    expect(prompt).not.toContain(RECALL_TEACHING);
    expect(prompt).not.toContain('MEMORY RECALL');
  });

  it('is positioned before the epistemic guardrail (always last)', () => {
    const prompt = buildSystemPrompt('ask', null);
    expect(prompt.indexOf(RECALL_TEACHING)).toBeLessThan(prompt.indexOf(EPISTEMIC_GUARDRAIL));
  });
});

// ── STRUCTURAL_BRAIN_GROUNDING — the CSS-query / graph-hop directive syntax ──
// The two structural tools are text-convention directives, not rendered JSON
// schemas — so they are "callable" on the assistant chat only when this
// grounding teaches the BRAIN_QUERY_CSS: / BRAIN_NEIGHBOURS: line syntax. It
// must appear ONLY when those tools are actually offered (assistant chat),
// mirroring BRAIN_SEARCH_GROUNDING.

describe('buildSystemPrompt — STRUCTURAL_BRAIN_GROUNDING', () => {
  const withStructural = { tools: [BRAIN_SEARCH_TOOL, ...STRUCTURAL_BRAIN_TOOLS] };

  it('teaches the BRAIN_QUERY_CSS: and BRAIN_NEIGHBOURS: directive lines when the structural tools are offered', () => {
    const prompt = buildSystemPrompt('ask', null, withStructural);
    expect(prompt).toContain(STRUCTURAL_BRAIN_GROUNDING);
    expect(prompt).toContain('BRAIN_QUERY_CSS: <css-selector>');
    expect(prompt).toContain('BRAIN_NEIGHBOURS: <note-id>');
    // A concrete, runnable selector example must be present.
    expect(prompt).toContain(':not([data-cerveau-valid-until])');
  });

  it('is OMITTED when only brain_search is offered (structural tools not runnable there)', () => {
    const prompt = buildSystemPrompt('ask', null, { tools: [BRAIN_SEARCH_TOOL] });
    expect(prompt).toContain(BRAIN_SEARCH_GROUNDING);
    expect(prompt).not.toContain(STRUCTURAL_BRAIN_GROUNDING);
  });

  it('is OMITTED when no tools are offered at all', () => {
    const prompt = buildSystemPrompt('ask', null, {});
    expect(prompt).not.toContain(STRUCTURAL_BRAIN_GROUNDING);
  });

  it('sits after the semantic grounding and still before the epistemic guardrail', () => {
    const prompt = buildSystemPrompt('ask', null, withStructural);
    expect(prompt.indexOf(BRAIN_SEARCH_GROUNDING)).toBeLessThan(prompt.indexOf(STRUCTURAL_BRAIN_GROUNDING));
    expect(prompt.indexOf(STRUCTURAL_BRAIN_GROUNDING)).toBeLessThan(prompt.indexOf(EPISTEMIC_GUARDRAIL));
  });
});
