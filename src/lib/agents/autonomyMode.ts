/* autonomyMode.ts — Four-level autonomy model (Pillar C1).
   Maps user-facing autonomy modes to internal approval/execution behavior.
*/

import type { AutonomyMode, AutonomyConfig } from './types.js';

// ── Defaults ──────────────────────────────────────────────────────

export const DEFAULT_AUTONOMY: AutonomyConfig = {
  mode: 'supervised',
  crossProjectPolicy: 'ask',
  deletePolicy: 'ask',
  deployPolicy: 'ask',
};

export const SAFE_ACTIONS = new Set([
  'brain_query',
  'brain_query_css',
  'brain_neighbours',
  'web_search',
  'web_fetch',
  'focus_canvas',
  'canvas_note',
  'answer_question',
  'set_budget',
  'info',
  'list_agents',
  'list_missions',
  'canvas_overview',
  'query_mission',
  'get_agent_output',
  'briefing_query',
  'decision_lookup',
  'quote_mission',
]);

export const SENSITIVE_ACTIONS = new Set([
  'launch_mission',
  'create_loop',
  'stop_all',
  'delete_mission',
  'revert_mission',
  'deploy',
  'self_improve',
  'approve_mission',
  'reject_mission',
  'clear_canvas',
  'close_project',
  'execute_plan',
  'provision_service',
  'teardown_service',
  'create_agent_template',
  'learn_pattern',
]);

// ── Public helpers ────────────────────────────────────────────────

export function getEffectiveAutonomy(config?: Partial<AutonomyConfig>): AutonomyConfig {
  return { ...DEFAULT_AUTONOMY, ...config };
}

export function isSafeAction(actionType: string): boolean {
  return SAFE_ACTIONS.has(actionType);
}

export function isSensitiveAction(actionType: string): boolean {
  return SENSITIVE_ACTIONS.has(actionType);
}

export function mapModeToApproval(mode: AutonomyMode): 'default' | 'acceptEdits' | 'full' {
  if (mode === 'manual') return 'default';
  if (mode === 'yolo') return 'full';
  return 'acceptEdits';
}
