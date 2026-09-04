/**
 * Tests for managerEccCatalog: the compact, grouped ECC_AGENTS catalog
 * injected into the manager's per-turn system prompt (see
 * managerEngine.ts's buildManagerDynamicContext). Covers both the real
 * ECC_AGENTS library (the actual product guarantee: every Content/Creative
 * agent must be visible by name) and fixture-driven behavior (collapsing,
 * the "Other" safety net, empty input) that should stay stable regardless
 * of how the real library grows.
 */

import { describe, it, expect } from 'vitest';
import { buildEccAgentCatalog } from '../lib/agents/managerEccCatalog';
import { ECC_AGENTS } from '../lib/agents/eccAgents';
import type { EccAgent } from '../lib/agents/ecc/eccAgentTypes';

function fixtureAgent(overrides: Partial<EccAgent>): EccAgent {
  return {
    name: overrides.name ?? 'fixture-agent',
    displayName: overrides.displayName ?? 'Fixture Agent',
    description: overrides.description ?? 'A fixture agent used only for testing catalog behavior in isolation.',
    systemPrompt: overrides.systemPrompt ?? 'You are a fixture agent.',
    modelTier: overrides.modelTier ?? 'sonnet',
    color: overrides.color ?? 'violet',
    tags: overrides.tags ?? ['fixture'],
    tools: overrides.tools ?? { allow: ['Read'] },
    source: 'ecc',
  };
}

describe('buildEccAgentCatalog — real ECC_AGENTS (product guarantee)', () => {
  const catalog = buildEccAgentCatalog();

  it('names every Content & Creative agent individually, by @name', () => {
    const contentNames = [
      'web-researcher', 'content-strategist', 'copywriter', 'video-producer',
      'carousel-designer', 'brand-identity', 'marketing-agent', 'seo-specialist',
    ];
    for (const name of contentNames) {
      expect(catalog).toContain(`@${name}`);
    }
  });

  it('labels the Content & Creative group so it reads as one category', () => {
    expect(catalog).toContain('Content & Creative:');
  });

  it('labels the other category groups', () => {
    expect(catalog).toContain('Architecture & Planning:');
    expect(catalog).toContain('Review & Quality:');
    expect(catalog).toContain('Build & Infra:');
    expect(catalog).toContain('Meta:');
  });

  it('points to list_agents as the escape hatch for the collapsed language clusters', () => {
    expect(catalog).toContain('use list_agents to see all');
  });

  it('stays compact relative to the full 73-agent library (token-efficiency guard rail)', () => {
    // A full "@name: DisplayName — 80-char description" line per agent would
    // run well past 6000 chars for 73 agents; this catalog trades that for
    // short hand-written roles plus collapsing the two per-language
    // clusters. Regression guard, not a tight budget — bump deliberately if
    // the library grows enough to need it, never silently.
    expect(catalog.length).toBeLessThan(6000);
  });

  it('never silently drops an agent — every real ECC_AGENTS name is either named individually or a member of a deliberately collapsed language cluster', () => {
    const namedInCatalog = new Set([...catalog.matchAll(/@([a-z0-9-]+)/g)].map((m) => m[1]));
    const unnamed = ECC_AGENTS.filter((a) => !namedInCatalog.has(a.name));

    // The "Other" safety net guarantees any agent outside the curated
    // groups still appears BY NAME — so the only agents that can end up
    // unnamed here are members of the two intentionally-collapsed
    // per-language clusters (reviewers / build-resolvers).
    for (const agent of unnamed) {
      expect(agent.name.endsWith('-reviewer') || agent.name.endsWith('-build-resolver')).toBe(true);
    }
    // Sanity: the two clusters actually do produce some unnamed agents in
    // the real library, so this test is not vacuously true.
    expect(unnamed.length).toBeGreaterThan(0);
  });
});

describe('buildEccAgentCatalog — fixture-driven behavior', () => {
  it('returns an empty string for an empty agent list', () => {
    expect(buildEccAgentCatalog([])).toBe('');
  });

  it('collapses a large same-shape language-reviewer cluster into one summary line', () => {
    const fixture = [
      fixtureAgent({ name: 'python-reviewer' }),
      fixtureAgent({ name: 'typescript-reviewer' }),
      fixtureAgent({ name: 'go-reviewer' }),
      fixtureAgent({ name: 'java-reviewer' }),
      fixtureAgent({ name: 'react-reviewer' }),
      fixtureAgent({ name: 'rust-reviewer' }),
    ];
    const catalog = buildEccAgentCatalog(fixture);
    expect(catalog).toContain('Language reviewers (6):');
    expect(catalog).toContain('…and 1 more (use list_agents to see all)');
    // The collapsed cluster is a single line, not one bullet per agent.
    expect(catalog.split('\n').filter((l) => l.includes('-reviewer')).length).toBe(1);
  });

  it('collapses a large same-shape language build-resolver cluster into one summary line', () => {
    const fixture = [
      fixtureAgent({ name: 'go-build-resolver' }),
      fixtureAgent({ name: 'java-build-resolver' }),
      fixtureAgent({ name: 'react-build-resolver' }),
      fixtureAgent({ name: 'rust-build-resolver' }),
      fixtureAgent({ name: 'swift-build-resolver' }),
    ];
    const catalog = buildEccAgentCatalog(fixture);
    expect(catalog).toContain('Language build-resolvers (5):');
    expect(catalog).toContain('…and 1 more (use list_agents to see all)');
  });

  it('does not emit a collapsed-cluster line when none of its agents are present', () => {
    const fixture = [fixtureAgent({ name: 'architect' })];
    const catalog = buildEccAgentCatalog(fixture);
    expect(catalog).not.toContain('Language reviewers');
    expect(catalog).not.toContain('Language build-resolvers');
  });

  it('surfaces an unrecognized agent under "Other" instead of dropping it silently', () => {
    const fixture = [fixtureAgent({ name: 'totally-unknown-persona', description: 'Some brand new persona not yet categorized here at all.' })];
    const catalog = buildEccAgentCatalog(fixture);
    expect(catalog).toContain('Other:');
    expect(catalog).toContain('@totally-unknown-persona');
  });

  it('falls back to a truncated (<=8-word) description when an agent has no hand-written role', () => {
    const fixture = [fixtureAgent({
      name: 'totally-unknown-persona',
      description: 'One two three four five six seven eight nine ten eleven twelve.',
    })];
    const catalog = buildEccAgentCatalog(fixture);
    expect(catalog).toContain('@totally-unknown-persona — One two three four five six seven eight');
    expect(catalog).not.toContain('nine');
  });

  it('uses a hand-written role (not a description slice) for a known generalist agent', () => {
    const fixture = [fixtureAgent({
      name: 'architect',
      description: 'A totally different description that should NOT appear verbatim in the catalog output.',
    })];
    const catalog = buildEccAgentCatalog(fixture);
    expect(catalog).toContain('@architect — system design and architectural decisions');
    expect(catalog).not.toContain('A totally different description');
  });
});

// ── Relevance filtering (token-efficiency wave, 2026-08-01) ────────
//
// buildEccAgentCatalog used to render every named group in FULL on every
// single turn, unconditionally — the manager's ECC library is the only
// context block that was never gated on anything real (unlike
// modelCatalogBlock/canvasDigestBlock/etc, managerEngine.ts). These tests
// pin down the safety rule required by the remediation: filtering a group
// down to a collapsed summary must NEVER make a relevant agent for the
// CURRENT turn unreachable, and an ambiguous/missing query must fall back
// to showing everything, exactly as before this filter existed.
describe('buildEccAgentCatalog — relevance filtering (real ECC_AGENTS)', () => {
  it('is byte-identical to the unfiltered catalog when no relevanceQuery is given (default, backward-compatible)', () => {
    expect(buildEccAgentCatalog(ECC_AGENTS)).toBe(buildEccAgentCatalog(ECC_AGENTS, undefined));
  });

  it('keeps a relevant agent fully named (reachable by exact @name) for a clearly single-domain request', () => {
    const catalog = buildEccAgentCatalog(ECC_AGENTS, 'écris-moi une campagne marketing avec des posts Instagram et un carrousel');
    expect(catalog).toContain('@marketing-agent — campaign strategy, positioning, copy, launch plans');
    expect(catalog).toContain('@carousel-designer — designs multi-slide social image carousels');
  });

  it('collapses an OFF-topic group instead of dropping any of its agents by name', () => {
    const catalog = buildEccAgentCatalog(ECC_AGENTS, 'écris-moi une campagne marketing avec des posts Instagram');
    // Build & Infra did not match — collapsed shape ("- Label (N): @a, @b
    // …and M more"), not the full "Build & Infra:\n- @name — role" shape.
    expect(catalog).not.toContain('Build & Infra:\n');
    expect(catalog).toMatch(/- Build & Infra \(\d+\): @/);
    // Still names SOME real agents from that group (the collapsed
    // examples), never zero — this is what keeps "reachable" honest even
    // in the collapsed form.
    expect(catalog).toContain('@build-error-resolver');
  });

  it('reaches a Build & Infra agent fully named for a build/error-shaped request, and collapses Content & Creative instead', () => {
    const catalog = buildEccAgentCatalog(ECC_AGENTS, "le build échoue avec une erreur de compilation, il faut le fixer");
    expect(catalog).toContain('@build-error-resolver — fixes build/type errors, minimal diffs');
    expect(catalog).not.toContain('Content & Creative:\n');
    expect(catalog).toMatch(/- Content & Creative \(\d+\): @/);
  });

  it('falls back to the FULL catalog (every group named) when the query is ambiguous/generic — never narrows on uncertainty', () => {
    const ambiguous = buildEccAgentCatalog(ECC_AGENTS, 'aide-moi avec ça stp');
    expect(ambiguous).toBe(buildEccAgentCatalog(ECC_AGENTS));
  });

  it('falls back to the FULL catalog when relevanceQuery is an empty string', () => {
    expect(buildEccAgentCatalog(ECC_AGENTS, '')).toBe(buildEccAgentCatalog(ECC_AGENTS));
  });

  it('always keeps Meta fully named regardless of the query (small, cross-cutting, not tied to one domain)', () => {
    const catalog = buildEccAgentCatalog(ECC_AGENTS, 'écris-moi une campagne marketing');
    expect(catalog).toContain('@chief-of-staff — triages multi-channel communication (email/chat)');
  });

  it('measurably shrinks the catalog for a narrow single-domain request (real token-efficiency win)', () => {
    const full = buildEccAgentCatalog(ECC_AGENTS);
    const narrowed = buildEccAgentCatalog(ECC_AGENTS, 'écris-moi une campagne marketing avec des posts Instagram');
    expect(narrowed.length).toBeLessThan(full.length);
  });
});
