/**
 * Tests for Phase 1 of the orchestration overhaul:
 * - managerActionValidator: per-type field validation
 * - parseManagerActions: integration with the validator (drops malformed actions)
 * - MAX_MANAGER_TURNS: the hard cap on LLM calls per exchange
 * - groundingDedupKey: dedup cache keys for grounding actions
 */

import { describe, it, expect, vi } from 'vitest';
import { validateManagerAction } from '../lib/agents/managerActionValidator';
import { parseManagerActions, MANAGER_LLM_CALL_TIMEOUT_MS } from '../lib/agents/managerEngine';
import { MAX_MANAGER_TURNS } from '../components/agents/agentsStore';

// ── managerActionValidator ──────────────────────────────────────────

describe('validateManagerAction', () => {
  it('accepts a valid launch_mission with required fields', () => {
    const result = validateManagerAction({ type: 'launch_mission', task: 'do something' });
    expect(result.ok).toBe(true);
  });

  it('rejects launch_mission missing task', () => {
    const result = validateManagerAction({ type: 'launch_mission' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('task');
  });

  it('rejects launch_mission with empty string task', () => {
    const result = validateManagerAction({ type: 'launch_mission', task: '' });
    expect(result.ok).toBe(false);
  });

  it('accepts a valid brain_query', () => {
    const result = validateManagerAction({ type: 'brain_query', query: 'how to fix auth' });
    expect(result.ok).toBe(true);
  });

  it('rejects brain_query missing query', () => {
    const result = validateManagerAction({ type: 'brain_query' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('query');
  });

  it('accepts a valid move_node with x and y', () => {
    const result = validateManagerAction({ type: 'move_node', x: 100, y: 200 });
    expect(result.ok).toBe(true);
  });

  it('rejects move_node missing x', () => {
    const result = validateManagerAction({ type: 'move_node', y: 200 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('x');
  });

  it('rejects move_node with non-number x', () => {
    const result = validateManagerAction({ type: 'move_node', x: '100', y: 200 });
    expect(result.ok).toBe(false);
  });

  // ── reject_plan (retroactive plan-proposal rejection, types.ts) ──────
  it('accepts a valid reject_plan with a planId', () => {
    const result = validateManagerAction({ type: 'reject_plan', planId: 'plan-123' });
    expect(result.ok).toBe(true);
  });

  it('rejects reject_plan missing planId', () => {
    const result = validateManagerAction({ type: 'reject_plan' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('planId');
  });

  it('rejects reject_plan with empty string planId', () => {
    const result = validateManagerAction({ type: 'reject_plan', planId: '' });
    expect(result.ok).toBe(false);
  });

  it('accepts actions with no required fields (list_agents, stop_all, etc.)', () => {
    expect(validateManagerAction({ type: 'list_agents' }).ok).toBe(true);
    expect(validateManagerAction({ type: 'stop_all' }).ok).toBe(true);
    expect(validateManagerAction({ type: 'canvas_overview' }).ok).toBe(true);
    expect(validateManagerAction({ type: 'info', message: 'hello' }).ok).toBe(true);
  });

  it('rejects info with missing message', () => {
    const result = validateManagerAction({ type: 'info' });
    expect(result.ok).toBe(false);
  });

  it('accepts a valid create_router with 2 branches', () => {
    const result = validateManagerAction({
      type: 'create_router',
      branches: [
        { label: 'success', condition: { kind: 'outcome', value: 'success' } },
        { label: 'fail', condition: { kind: 'outcome', value: 'fail' } },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('rejects create_router with less than 2 branches', () => {
    const result = validateManagerAction({
      type: 'create_router',
      branches: [{ label: 'only', condition: { kind: 'default' } }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('2 branches');
  });

  // ── clear_canvas / includeReview (P0 fix — review-status cleanup coverage) ──

  it('accepts a valid clear_canvas without includeReview (optional field omitted)', () => {
    const result = validateManagerAction({ type: 'clear_canvas', scope: 'terminated' });
    expect(result.ok).toBe(true);
  });

  it('accepts clear_canvas with a boolean includeReview', () => {
    expect(validateManagerAction({ type: 'clear_canvas', scope: 'terminated', includeReview: true }).ok).toBe(true);
    expect(validateManagerAction({ type: 'clear_canvas', scope: 'all', includeReview: false }).ok).toBe(true);
  });

  it('rejects clear_canvas with a non-boolean includeReview', () => {
    const result = validateManagerAction({ type: 'clear_canvas', scope: 'terminated', includeReview: 'true' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('includeReview');
  });

  it('rejects clear_canvas missing scope', () => {
    const result = validateManagerAction({ type: 'clear_canvas', includeReview: true });
    expect(result.ok).toBe(false);
  });

  it('rejects create_router missing branches', () => {
    const result = validateManagerAction({ type: 'create_router' });
    expect(result.ok).toBe(false);
  });

  // ── modelId (exact catalog id, catalog wave) — optional, string-when-present ──
  it('accepts launch_mission/create_loop/create_draft with an optional modelId', () => {
    expect(validateManagerAction({ type: 'launch_mission', task: 'do it', modelId: 'anthropic/claude-sonnet-5' }).ok).toBe(true);
    expect(validateManagerAction({ type: 'create_loop', task: 'do it', cadence: '15m', modelId: 'claude-opus-5' }).ok).toBe(true);
    expect(validateManagerAction({ type: 'create_draft', task: 'do it', modelId: 'claude-opus-5' }).ok).toBe(true);
    expect(validateManagerAction({ type: 'launch_best_of_n', task: 'do it', n: 3, modelId: 'claude-opus-5' }).ok).toBe(true);
  });

  it('rejects a non-string modelId', () => {
    const result = validateManagerAction({ type: 'launch_mission', task: 'do it', modelId: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('modelId');
  });

  it('still accepts these action types when modelId is simply absent (optional, no regression)', () => {
    expect(validateManagerAction({ type: 'launch_mission', task: 'do it' }).ok).toBe(true);
    expect(validateManagerAction({ type: 'create_draft', task: 'do it' }).ok).toBe(true);
  });

  // ── propose_mission_charter (charte de mission) ────────────────────
  const validCharter = {
    type: 'propose_mission_charter',
    objective: 'Post Instagram carousels autonomously',
    nature: { kind: 'recurring', cadence: '1d' },
    decisions: [
      {
        question: 'publishing route?',
        options: ['official API', 'browser automation'],
        recommended: 'official API',
        rationale: 'stable; the other risks automation detection/account blocks',
      },
    ],
    validationGates: { frozenOnce: ['template', 'tone'], superviseFirstN: 3 },
    learning: {
      measure: 'engagement rate',
      measureSource: 'external analytics',
      influences: 'subjects/timing',
      killSwitch: '3 failures or a measure drop',
    },
  };

  it('accepts a fully-formed propose_mission_charter', () => {
    expect(validateManagerAction(validCharter).ok).toBe(true);
  });

  it('accepts nature "unique" with no cadence (a one-off task never carries a recurrence)', () => {
    const result = validateManagerAction({
      ...validCharter,
      nature: { kind: 'unique' },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects propose_mission_charter missing objective', () => {
    const { objective: _objective, ...rest } = validCharter;
    const result = validateManagerAction(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('objective');
  });

  it('rejects an invalid nature.kind', () => {
    const result = validateManagerAction({ ...validCharter, nature: { kind: 'sometimes' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('nature.kind');
  });

  it('rejects a decision missing "recommended" (a bare question is not a charter decision)', () => {
    const result = validateManagerAction({
      ...validCharter,
      decisions: [{ question: 'route?', options: ['A', 'B'], rationale: 'because' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('recommended');
  });

  it('rejects a decision missing "rationale"', () => {
    const result = validateManagerAction({
      ...validCharter,
      decisions: [{ question: 'route?', options: ['A', 'B'], recommended: 'A' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('rationale');
  });

  it('rejects validationGates missing frozenOnce', () => {
    const result = validateManagerAction({ ...validCharter, validationGates: { superviseFirstN: 3 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('frozenOnce');
  });

  it('rejects learning missing a required field (e.g. killSwitch)', () => {
    const { killSwitch: _killSwitch, ...restLearning } = validCharter.learning;
    const result = validateManagerAction({ ...validCharter, learning: restLearning });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('killSwitch');
  });

  // ── propose_artifact (visible-artifact fix) ────────────────────────
  const validArtifact = {
    type: 'propose_artifact',
    artifactId: 'hero-banner',
    name: 'Homepage hero banner',
    variants: [
      { id: 'a', label: 'Option A', views: [{ id: 'v1', label: 'Desktop', html: '<html>A</html>' }] },
      { id: 'b', label: 'Option B', views: [{ id: 'v1', label: 'Desktop', html: '<html>B</html>' }] },
    ],
  };

  it('accepts a fully-formed propose_artifact', () => {
    expect(validateManagerAction(validArtifact).ok).toBe(true);
  });

  it('accepts propose_artifact with only the required fields (name + one variant/view)', () => {
    const result = validateManagerAction({
      type: 'propose_artifact',
      name: 'Single option',
      variants: [{ id: 'a', label: 'Only option', views: [{ id: 'v1', label: 'Page', html: '<p>x</p>' }] }],
    });
    expect(result.ok).toBe(true);
  });

  it('accepts propose_artifact resolving a prior proposal via selectedVariantId', () => {
    const result = validateManagerAction({ ...validArtifact, selectedVariantId: 'b' });
    expect(result.ok).toBe(true);
  });

  it('rejects propose_artifact missing name', () => {
    const { name: _name, ...rest } = validArtifact;
    const result = validateManagerAction(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('name');
  });

  it('rejects propose_artifact missing variants', () => {
    const { variants: _variants, ...rest } = validArtifact;
    const result = validateManagerAction(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('variants');
  });

  it('rejects propose_artifact with an empty variants array', () => {
    const result = validateManagerAction({ ...validArtifact, variants: [] });
    expect(result.ok).toBe(false);
  });

  it('rejects a variant missing views', () => {
    const result = validateManagerAction({
      ...validArtifact,
      variants: [{ id: 'a', label: 'Option A' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('views');
  });

  it('rejects a variant with an empty views array', () => {
    const result = validateManagerAction({
      ...validArtifact,
      variants: [{ id: 'a', label: 'Option A', views: [] }],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a view missing html', () => {
    const result = validateManagerAction({
      ...validArtifact,
      variants: [{ id: 'a', label: 'Option A', views: [{ id: 'v1', label: 'Page' }] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('html');
  });

  it('rejects a non-string optional artifactId/version/selectedVariantId/projectId', () => {
    expect(validateManagerAction({ ...validArtifact, artifactId: 42 }).ok).toBe(false);
    expect(validateManagerAction({ ...validArtifact, version: 42 }).ok).toBe(false);
    expect(validateManagerAction({ ...validArtifact, selectedVariantId: 42 }).ok).toBe(false);
    expect(validateManagerAction({ ...validArtifact, projectId: 42 }).ok).toBe(false);
  });

  it('accepts a valid open_project with a path', () => {
    const result = validateManagerAction({ type: 'open_project', path: 'C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON' });
    expect(result.ok).toBe(true);
  });

  it('rejects open_project missing path', () => {
    const result = validateManagerAction({ type: 'open_project' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('path');
  });

  it('rejects open_project with empty string path', () => {
    const result = validateManagerAction({ type: 'open_project', path: '' });
    expect(result.ok).toBe(false);
  });

  it('rejects unknown action type', () => {
    const result = validateManagerAction({ type: 'totally_made_up' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('unknown');
  });

  it('rejects non-object', () => {
    expect(validateManagerAction(null).ok).toBe(false);
    expect(validateManagerAction('string').ok).toBe(false);
    expect(validateManagerAction(42).ok).toBe(false);
    expect(validateManagerAction([1, 2]).ok).toBe(false);
  });

  it('rejects object missing type', () => {
    const result = validateManagerAction({ task: 'do something' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('type');
  });

  it('accepts a valid set_budget with limitUsd', () => {
    const result = validateManagerAction({ type: 'set_budget', limitUsd: 5.0 });
    expect(result.ok).toBe(true);
  });

  it('rejects set_budget with non-number limitUsd', () => {
    const result = validateManagerAction({ type: 'set_budget', limitUsd: '5' });
    expect(result.ok).toBe(false);
  });

  it('accepts a valid chain_agents with target', () => {
    const result = validateManagerAction({ type: 'chain_agents', target: { draftId: 'draft-1' } });
    expect(result.ok).toBe(true);
  });

  it('rejects chain_agents missing target', () => {
    const result = validateManagerAction({ type: 'chain_agents' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('target');
  });

  it('accepts a valid reject_mission with missionId and feedback', () => {
    const result = validateManagerAction({ type: 'reject_mission', missionId: 'M1', feedback: 'try again' });
    expect(result.ok).toBe(true);
  });

  it('rejects reject_mission missing feedback', () => {
    const result = validateManagerAction({ type: 'reject_mission', missionId: 'M1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('feedback');
  });

  it('accepts a valid save_macro with name and refs', () => {
    const result = validateManagerAction({ type: 'save_macro', name: 'my-macro', refs: ['draft:1', 'draft:2'] });
    expect(result.ok).toBe(true);
  });

  it('rejects save_macro missing refs', () => {
    const result = validateManagerAction({ type: 'save_macro', name: 'my-macro' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('refs');
  });
});

// ── parseManagerActions integration with validator ──────────────────

describe('parseManagerActions with validator', () => {
  it('keeps valid actions and drops malformed ones', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const text = `<lazy_actions>[
      {"type": "launch_mission", "task": "valid task"},
      {"type": "brain_query"},
      {"type": "info", "message": "hello"}
    ]</lazy_actions>`;
    const actions = parseManagerActions(text);
    expect(actions).toHaveLength(2);
    expect(actions[0].type).toBe('launch_mission');
    expect(actions[1].type).toBe('info');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('brain_query');
    warnSpy.mockRestore();
  });

  it('drops actions with unknown type', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const text = `<lazy_actions>[
      {"type": "totally_fake", "foo": "bar"},
      {"type": "list_agents"}
    ]</lazy_actions>`;
    const actions = parseManagerActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('list_agents');
    warnSpy.mockRestore();
  });

  it('keeps all actions when all are valid', () => {
    const text = `<lazy_actions>[
      {"type": "list_agents"},
      {"type": "list_missions"},
      {"type": "info", "message": "done"}
    ]</lazy_actions>`;
    const actions = parseManagerActions(text);
    expect(actions).toHaveLength(3);
  });

  it('returns empty array when all actions are malformed', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const text = `<lazy_actions>[
      {"type": "launch_mission"},
      {"type": "brain_query"},
      {"type": "move_node", "x": "not-a-number", "y": 100}
    ]</lazy_actions>`;
    const actions = parseManagerActions(text);
    expect(actions).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledTimes(3);
    warnSpy.mockRestore();
  });
});

// ── MAX_MANAGER_TURNS constant ──────────────────────────────────────

describe('MAX_MANAGER_TURNS', () => {
  it('is defined and equals 4 (1 main + 3 grounding)', () => {
    expect(MAX_MANAGER_TURNS).toBe(4);
    expect(typeof MAX_MANAGER_TURNS).toBe('number');
  });

  it('is greater than 1 (allows at least one grounding follow-up)', () => {
    expect(MAX_MANAGER_TURNS).toBeGreaterThan(1);
  });

  it('is bounded (prevents unbounded credit burn)', () => {
    expect(MAX_MANAGER_TURNS).toBeLessThanOrEqual(6);
  });
});

// ── MANAGER_LLM_CALL_TIMEOUT_MS sanity ──────────────────────────────

describe('MANAGER_LLM_CALL_TIMEOUT_MS', () => {
  it('is defined and reasonable (300s)', () => {
    expect(MANAGER_LLM_CALL_TIMEOUT_MS).toBe(300_000);
  });
});
