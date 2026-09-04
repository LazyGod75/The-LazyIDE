/* unifiedEntitlement.ts — Single source of truth for feature entitlements.

   Unifies three previously-separate gating systems:
   1. Engine readiness (cli/byok/pro) from entitlement.ts
   2. Plan tier (free/pro/pro+) from useSubscription
   3. Org scope (solo/team/dept/global) from scope.ts

   Provides a synchronous `getEntitlements()` call that returns a complete
   feature map, used by UI components to gate visibility without each
   component needing to independently check three different systems.

   The module is pure/synchronous — all runtime signals are cached elsewhere
   and only read here, same pattern as entitlement.ts.
*/

import { loadAccessSettings } from '../models/accessSettings.js';
import { isCliBackendAvailable } from '../models/cliBackendProvider.js';
import { hasAnthropicKey } from '../models/anthropicProvider.js';
import { hasManagedCreditsActive, getProPlanState } from '../models/index.js';
import type { OrgScope } from '../brain/scope.js';
import { teamsActive } from '../features.js';

// ── Types ───────────────────────────────────────────────────────────

export type PlanTier = 'free' | 'pro' | 'pro_plus';
export type EngineMode = 'cli' | 'byok' | 'pro';

export interface UnifiedEntitlements {
  planTier: PlanTier;
  engineMode: EngineMode;
  engineReady: boolean;
  orgScope: OrgScope;
  teamsEnabled: boolean;
  features: {
    canLaunchMissions: boolean;
    canUseManagedProxy: boolean;
    canUseFederatedRecall: boolean;
    canUseDecisionRegistry: boolean;
    canUseNightShift: boolean;
    canUseRootTrunk: boolean;
    canUseTeamSearch: boolean;
    canUseCockpitV2: boolean;
    canUseLoops: boolean;
    maxConcurrentMissions: number;
    maxProjects: number;
  };
}

// ── Plan tier resolution ────────────────────────────────────────────

let _planTier: PlanTier = 'free';

/**
 * Push the current plan tier from the billing layer.
 * Called by useSubscription when the subscription state settles.
 */
export function setPlanTier(tier: PlanTier): void {
  _planTier = tier;
}

/**
 * Read the cached plan tier. Defaults to 'free' until the billing
 * layer pushes an update — same cold-start pattern as getProPlanState.
 */
export function getPlanTier(): PlanTier {
  // If pro plan state is 'unknown', we haven't settled yet —
  // stay optimistic for Pro users by checking managed credits
  if (_planTier === 'free' && getProPlanState() === 'unknown' && hasManagedCreditsActive()) {
    return 'pro';
  }
  return _planTier;
}

// ── Org scope cache ─────────────────────────────────────────────────

let _orgScope: OrgScope = 'solo';

/**
 * Push the current org scope from the teams layer.
 * Called when scope.json is loaded or changes.
 */
export function setOrgScope(scope: OrgScope): void {
  _orgScope = scope;
}

/**
 * Read the cached org scope. Defaults to 'solo'.
 */
export function getOrgScopeCached(): OrgScope {
  return _orgScope;
}

// ── Feature limits per tier ─────────────────────────────────────────

const TIER_LIMITS: Record<PlanTier, { maxConcurrent: number; maxProjects: number }> = {
  free: { maxConcurrent: 1, maxProjects: 1 },
  pro: { maxConcurrent: 3, maxProjects: 5 },
  pro_plus: { maxConcurrent: 10, maxProjects: 20 },
};

// ── Unified entitlements ────────────────────────────────────────────

/**
 * Get the complete entitlement snapshot. Synchronous, safe to call
 * on every render/submit. Reads only cached state.
 */
export function getEntitlements(): UnifiedEntitlements {
  const settings = loadAccessSettings();
  const planTier = getPlanTier();
  const orgScope = getOrgScopeCached();

  // Engine readiness — mirrors entitlement.ts logic
  let engineMode: EngineMode = 'cli';
  let engineReady = false;

  if (hasManagedCreditsActive()) {
    engineMode = 'pro';
    engineReady = true;
  } else if (isCliBackendAvailable('claude') === true || isCliBackendAvailable('codex') === true) {
    engineMode = 'cli';
    engineReady = true;
  } else if (hasAnthropicKey()) {
    engineMode = 'byok';
    engineReady = true;
  } else if (isCliBackendAvailable('claude') === null) {
    // Startup window — optimistic
    engineMode = 'cli';
    engineReady = true;
  }

  // If an explicit mode is set, respect it
  if (settings.accessMode) {
    engineMode = settings.accessMode as EngineMode;
    if (engineMode === 'cli') {
      const tool = settings.cliTool ?? 'claude';
      const avail = isCliBackendAvailable(tool);
      engineReady = avail !== false;
    } else if (engineMode === 'byok') {
      engineReady = hasAnthropicKey();
    } else if (engineMode === 'pro') {
      const planState = getProPlanState();
      engineReady = hasManagedCreditsActive() || planState === 'unknown';
    }
  }

  const limits = TIER_LIMITS[planTier];
  const isTeamContext = orgScope !== 'solo' && teamsActive();

  return {
    planTier,
    engineMode,
    engineReady,
    orgScope,
    teamsEnabled: teamsActive(),
    features: {
      canLaunchMissions: engineReady,
      canUseManagedProxy: planTier !== 'free' && engineReady,
      canUseFederatedRecall: planTier !== 'free',
      canUseDecisionRegistry: planTier !== 'free',
      canUseNightShift: planTier !== 'free',
      canUseRootTrunk: planTier === 'pro_plus',
      canUseTeamSearch: isTeamContext && planTier !== 'free',
      canUseCockpitV2: true,
      canUseLoops: planTier !== 'free',
      maxConcurrentMissions: limits.maxConcurrent,
      maxProjects: limits.maxProjects,
    },
  };
}

/**
 * Check a single feature gate. Convenience wrapper for getEntitlements().
 */
export function hasFeature(feature: keyof UnifiedEntitlements['features']): boolean {
  const ents = getEntitlements();
  return ents.features[feature] === true;
}
