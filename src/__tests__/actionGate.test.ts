/**
 * Tests for Phase 2 — Universal Action Gating + Audit Trail
 * - actionClassifier: SAFE / SENSITIVE / DESTRUCTIVE classification
 * - actionGate: evaluateActionGate with all tiers and autonomy modes
 * - gateAuditLog: in-memory audit log entries
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyAction,
  isSafeAction,
  isSensitiveAction,
  isDestructiveAction,
  SAFE_ACTIONS,
  SENSITIVE_ACTIONS,
  DESTRUCTIVE_ACTIONS,
} from '../lib/agents/actionClassifier';
import { evaluateActionGate, evaluateActionGateSync } from '../lib/agents/actionGate';
import { getEffectiveAutonomy } from '../lib/agents/autonomyMode';
import { readGateAuditLog, resetGateAuditLog } from '../lib/agents/gateAuditLog';

// ── actionClassifier ────────────────────────────────────────────────

describe('actionClassifier', () => {
  it('classifies safe actions correctly', () => {
    expect(classifyAction('brain_query')).toBe('safe');
    expect(classifyAction('list_agents')).toBe('safe');
    expect(classifyAction('info')).toBe('safe');
    expect(classifyAction('canvas_overview')).toBe('safe');
    expect(classifyAction('query_mission')).toBe('safe');
  });

  // Gate-usability fix (2026-07-28): create_draft/chain_agents/generate_plan
  // and the rest of the reversible canvas/plan-authoring surface moved from
  // sensitive to safe — they are the manager's core day-to-day work and
  // asking for approval on every single one made the manager unusable (see
  // actionClassifier.ts's own doc comment for the full rationale).
  it('classifies reversible canvas/plan-authoring actions as safe', () => {
    expect(classifyAction('create_draft')).toBe('safe');
    expect(classifyAction('chain_agents')).toBe('safe');
    expect(classifyAction('unchain')).toBe('safe');
    expect(classifyAction('generate_plan')).toBe('safe');
    expect(classifyAction('create_agent')).toBe('safe');
    expect(classifyAction('move_node')).toBe('safe');
    expect(classifyAction('create_router')).toBe('safe');
    expect(classifyAction('collapse_project')).toBe('safe');
    expect(classifyAction('save_macro')).toBe('safe');
    expect(classifyAction('instantiate_macro')).toBe('safe');
    expect(classifyAction('archive_mission')).toBe('safe');
    expect(classifyAction('archive_terminated')).toBe('safe');
    expect(classifyAction('pin_chain')).toBe('safe');
    expect(classifyAction('unpin_chain')).toBe('safe');
    expect(classifyAction('refire_chain')).toBe('safe');
  });

  it('classifies sensitive actions correctly', () => {
    expect(classifyAction('launch_mission')).toBe('sensitive');
    expect(classifyAction('execute_plan')).toBe('sensitive');
    expect(classifyAction('approve_mission')).toBe('sensitive');
    expect(classifyAction('reject_mission')).toBe('sensitive');
    expect(classifyAction('retry_mission')).toBe('sensitive');
    expect(classifyAction('clone_mission')).toBe('sensitive');
    expect(classifyAction('spawn_submissions')).toBe('sensitive');
    expect(classifyAction('launch_best_of_n')).toBe('sensitive');
    expect(classifyAction('start_preview')).toBe('sensitive');
    expect(classifyAction('stop_all')).toBe('sensitive');
    expect(classifyAction('set_budget')).toBe('sensitive');
    expect(classifyAction('set_approval_mode')).toBe('sensitive');
    // open_project (2026-08-01 QA fix) — mutates workspace state (registers
    // + activates a project) but is reversible via close_project, so it
    // sits at launch_mission's tier, not close_project's destructive one.
    expect(classifyAction('open_project')).toBe('sensitive');
  });

  it('classifies destructive actions correctly', () => {
    expect(classifyAction('delete_mission')).toBe('destructive');
    expect(classifyAction('revert_mission')).toBe('destructive');
    expect(classifyAction('close_project')).toBe('destructive');
    expect(classifyAction('delete_draft')).toBe('destructive');
    expect(classifyAction('delete_note')).toBe('destructive');
    expect(classifyAction('delete_router')).toBe('destructive');
    expect(classifyAction('delete_join')).toBe('destructive');
    expect(classifyAction('delete_frame')).toBe('destructive');
  });

  // clear_canvas is field-dependent: 'archive' (the executor's own default —
  // see agentsStore.tsx's clear_canvas case) is reversible, 'delete' is not.
  it('classifies clear_canvas by its mode field', () => {
    expect(classifyAction('clear_canvas')).toBe('sensitive');
    expect(classifyAction('clear_canvas', {})).toBe('sensitive');
    expect(classifyAction('clear_canvas', { mode: 'archive' })).toBe('sensitive');
    expect(classifyAction('clear_canvas', { mode: 'delete' })).toBe('destructive');
  });

  // P0 fix — sweeping 'review'-status missions abandons a pending human
  // approve/reject decision, unresolved, regardless of archive vs delete —
  // this ALWAYS wins to destructive so it needs approval even in YOLO mode.
  it('classifies clear_canvas with includeReview:true as destructive regardless of mode', () => {
    expect(classifyAction('clear_canvas', { includeReview: true })).toBe('destructive');
    expect(classifyAction('clear_canvas', { mode: 'archive', includeReview: true })).toBe('destructive');
    expect(classifyAction('clear_canvas', { mode: 'delete', includeReview: true })).toBe('destructive');
  });

  it('includeReview:false behaves exactly like includeReview omitted', () => {
    expect(classifyAction('clear_canvas', { includeReview: false })).toBe('sensitive');
    expect(classifyAction('clear_canvas', { mode: 'delete', includeReview: false })).toBe('destructive');
  });

  it('classifies unknown actions as unknown', () => {
    expect(classifyAction('totally_fake')).toBe('unknown');
    expect(classifyAction('')).toBe('unknown');
  });

  it('helper functions work', () => {
    expect(isSafeAction('brain_query')).toBe(true);
    expect(isSafeAction('launch_mission')).toBe(false);
    expect(isSensitiveAction('launch_mission')).toBe(true);
    expect(isSensitiveAction('brain_query')).toBe(false);
    expect(isDestructiveAction('delete_mission')).toBe(true);
    expect(isDestructiveAction('launch_mission')).toBe(false);
  });

  // Requirement: no recognized manager action type may classify as
  // 'unknown' — an unknown tier defaults to 'ask' in every mode (see
  // actionGate.ts's computeGateDecision), which is how actions used to get
  // silently stuck asking for approval with no way to resolve them.
  it('classifies every known manager action type from managerActionValidator — none unknown', async () => {
    const { KNOWN_ACTION_TYPES } = await import('../lib/agents/managerActionValidator');
    for (const type of KNOWN_ACTION_TYPES) {
      expect(classifyAction(type), `action type "${type}" classified as unknown`).not.toBe('unknown');
    }
  });

  it('SAFE and SENSITIVE and DESTRUCTIVE sets are disjoint', () => {
    for (const a of SAFE_ACTIONS) {
      expect(SENSITIVE_ACTIONS.has(a)).toBe(false);
      expect(DESTRUCTIVE_ACTIONS.has(a)).toBe(false);
    }
    for (const a of SENSITIVE_ACTIONS) {
      expect(SAFE_ACTIONS.has(a)).toBe(false);
      expect(DESTRUCTIVE_ACTIONS.has(a)).toBe(false);
    }
    for (const a of DESTRUCTIVE_ACTIONS) {
      expect(SAFE_ACTIONS.has(a)).toBe(false);
      expect(SENSITIVE_ACTIONS.has(a)).toBe(false);
    }
  });
});

// ── evaluateActionGate (async) ──────────────────────────────────────

describe('evaluateActionGate', () => {
  beforeEach(() => {
    resetGateAuditLog();
  });

  it('allows safe actions in supervised mode', async () => {
    const gate = await evaluateActionGate('brain_query', getEffectiveAutonomy({ mode: 'supervised' }));
    expect(gate.decision).toBe('allow');
  });

  it('asks for sensitive actions in supervised mode', async () => {
    const gate = await evaluateActionGate('launch_mission', getEffectiveAutonomy({ mode: 'supervised' }));
    expect(gate.decision).toBe('ask');
  });

  it('asks for destructive actions in supervised mode', async () => {
    const gate = await evaluateActionGate('delete_mission', getEffectiveAutonomy({ mode: 'supervised' }));
    expect(gate.decision).toBe('ask');
  });

  it('allows sensitive actions in yolo mode', async () => {
    const gate = await evaluateActionGate('launch_mission', getEffectiveAutonomy({ mode: 'yolo' }));
    expect(gate.decision).toBe('allow');
  });

  it('asks for destructive actions even in yolo mode', async () => {
    const gate = await evaluateActionGate('delete_mission', getEffectiveAutonomy({ mode: 'yolo' }));
    expect(gate.decision).toBe('ask');
  });

  it('asks for every action in manual mode', async () => {
    const gate = await evaluateActionGate('brain_query', getEffectiveAutonomy({ mode: 'manual' }));
    expect(gate.decision).toBe('ask');
  });

  it('denies actions on the denied list', async () => {
    const gate = await evaluateActionGate('launch_mission', getEffectiveAutonomy({ deniedActions: ['launch_mission'] }));
    expect(gate.decision).toBe('deny');
  });

  it('asks for unknown action types (conservative default)', async () => {
    const gate = await evaluateActionGate('totally_fake', getEffectiveAutonomy({ mode: 'supervised' }));
    expect(gate.decision).toBe('ask');
  });

  it('writes an audit log entry for each gate decision', async () => {
    await evaluateActionGate('brain_query', getEffectiveAutonomy({ mode: 'supervised' }), { turnId: 'turn-1' });
    await evaluateActionGate('launch_mission', getEffectiveAutonomy({ mode: 'supervised' }), { turnId: 'turn-2' });
    await evaluateActionGate('delete_mission', getEffectiveAutonomy({ mode: 'yolo' }), { turnId: 'turn-3' });

    const log = readGateAuditLog();
    expect(log).toHaveLength(3);
    expect(log[0].actionType).toBe('brain_query');
    expect(log[0].decision).toBe('allow');
    expect(log[0].turnId).toBe('turn-1');
    expect(log[1].actionType).toBe('launch_mission');
    expect(log[1].decision).toBe('ask');
    expect(log[2].actionType).toBe('delete_mission');
    expect(log[2].decision).toBe('ask');
  });

  it('logs autonomy mode in audit entries', async () => {
    await evaluateActionGate('launch_mission', getEffectiveAutonomy({ mode: 'yolo' }));
    const log = readGateAuditLog();
    expect(log[0].autonomyMode).toBe('yolo');
  });
});

// ── evaluateActionGateSync ──────────────────────────────────────────

describe('evaluateActionGateSync', () => {
  it('allows safe actions in supervised mode', () => {
    const gate = evaluateActionGateSync('brain_query', getEffectiveAutonomy({ mode: 'supervised' }));
    expect(gate.decision).toBe('allow');
  });

  it('asks for sensitive actions in supervised mode', () => {
    const gate = evaluateActionGateSync('launch_mission', getEffectiveAutonomy({ mode: 'supervised' }));
    expect(gate.decision).toBe('ask');
  });

  it('allows sensitive actions in yolo mode', () => {
    const gate = evaluateActionGateSync('launch_mission', getEffectiveAutonomy({ mode: 'yolo' }));
    expect(gate.decision).toBe('allow');
  });

  it('asks for destructive actions in yolo mode', () => {
    const gate = evaluateActionGateSync('delete_mission', getEffectiveAutonomy({ mode: 'yolo' }));
    expect(gate.decision).toBe('ask');
  });

  it('denies actions on the denied list', () => {
    const gate = evaluateActionGateSync('launch_mission', getEffectiveAutonomy({ deniedActions: ['launch_mission'] }));
    expect(gate.decision).toBe('deny');
  });
});

// ── gateAuditLog ────────────────────────────────────────────────────

describe('gateAuditLog', () => {
  beforeEach(() => {
    resetGateAuditLog();
  });

  it('starts empty after reset', () => {
    expect(readGateAuditLog()).toHaveLength(0);
  });

  it('accumulates entries from multiple gate calls', async () => {
    await evaluateActionGate('info', getEffectiveAutonomy({ mode: 'supervised' }));
    await evaluateActionGate('list_agents', getEffectiveAutonomy({ mode: 'supervised' }));
    await evaluateActionGate('list_missions', getEffectiveAutonomy({ mode: 'supervised' }));
    expect(readGateAuditLog()).toHaveLength(3);
  });

  it('entries have valid timestamps', async () => {
    await evaluateActionGate('info', getEffectiveAutonomy({ mode: 'supervised' }));
    const log = readGateAuditLog();
    expect(log[0].timestamp).toBeTruthy();
    expect(new Date(log[0].timestamp).getTime()).not.toBeNaN();
  });
});
