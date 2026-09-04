/* features.ts — single runtime entitlement for the Teams feature.

   Previously exported a build-time-only TEAMS_ENABLED flag wired to
   VITE_TEAMS_ENABLED. Combined with a second hardcoded
   `TEAMS_ENABLED = false as const` in src/lib/brain/scope.ts (imported by
   capture.ts's dispatch() and unifiedEntitlement.ts), the teams layer was
   permanently dead for every real, paying org — no env var flip or org
   state could ever surface it in production (T4.2 audit finding: the
   "three-flag trap").

   teamsActive() replaces all of that with one RUNTIME entitlement, sourced
   from the active-team snapshot below — the same "active org exists &&
   subscription active/trialing && user is a member" check useActiveTeam.ts
   already performs (see deriveHasActiveTeam), just made readable outside
   React. VITE_TEAMS_ENABLED is demoted to a DEV-ONLY override: it can force
   the feature on for local testing, but being gated on import.meta.env.DEV
   it can never affect a production build, and it can never turn a real
   org's access OFF — teamsActive() only ever ORs the override in, never
   ANDs a paying org out.
*/

// ── Active-team snapshot (module-level cache) ──────────────────────
//
// capture.ts and unifiedEntitlement.ts are plain modules — they cannot call
// the useActiveTeamContext() / useActiveTeam() hooks directly. AppShellInner
// (the single long-lived root of the authenticated app, see AppShell.tsx)
// mirrors the hook's settled hasActiveTeam value into this snapshot on
// every change — the same push-on-settle pattern useSubscription.ts uses
// for setPlanTier (src/lib/entitlements/unifiedEntitlement.ts).
//
// `null` = unhydrated: no provider has reported yet (cold start, signed
// out, or a context outside the AppShell tree, e.g. an isolated test).
// Treated as "no active team" — fail-closed, never crashes, never routes
// to the teams dispatch path.

let _activeTeamSnapshot: boolean | null = null;

/**
 * Push whether the current user currently has at least one active/trialing
 * org membership. Call whenever useActiveTeamContext()'s hasActiveTeam
 * value settles or changes (see AppShell.tsx's AppShellInner).
 */
export function setActiveTeamSnapshot(hasActiveTeam: boolean): void {
  _activeTeamSnapshot = hasActiveTeam;
}

/** Test-only: reset the snapshot to its unhydrated (null) state. */
export function _resetActiveTeamSnapshotForTests(): void {
  _activeTeamSnapshot = null;
}

// ── Dev override ────────────────────────────────────────────────────
//
// Dev-build-only escape hatch so the Team tab and team capture dispatch
// can be exercised locally without a live Supabase org. import.meta.env.DEV
// guarantees this is always false in a production build regardless of how
// VITE_TEAMS_ENABLED is set — it can never be the thing that turns a real
// org's access off, only ever an additional way to turn the UI on locally.

const DEV_OVERRIDE: boolean =
  import.meta.env.DEV && import.meta.env.VITE_TEAMS_ENABLED === 'true';

/**
 * The single runtime entitlement for the teams feature.
 *
 * @param liveHasActiveTeam  When called from a component that already holds
 *   a live hasActiveTeam value (e.g. useActiveTeamContext()), pass it here
 *   for a render-fresh result: the cached snapshot is only refreshed by an
 *   effect one tick after hasActiveTeam changes, so a component with the
 *   live value in hand should not take that lag (this matters for a
 *   visible affordance like the Team tab). Non-React callers (capture.ts's
 *   dispatch, unifiedEntitlement.ts) omit it and read the cached snapshot.
 *
 * Fail-closed: no live value AND an unhydrated snapshot both read as false.
 */
export function teamsActive(liveHasActiveTeam?: boolean): boolean {
  const hasActiveTeam = liveHasActiveTeam ?? _activeTeamSnapshot === true;
  return hasActiveTeam || DEV_OVERRIDE;
}

// ── Legacy export ─────────────────────────────────────────────────
//
/**
 * @deprecated Prefer teamsActive(). Kept only so existing consumers that
 * still import the old build-time constant (e.g. NewMissionModal.tsx's
 * shareToTeam gating) keep compiling. Reflects only the dev-override
 * component of teamsActive() — same scope this constant always had
 * (build-time only) — NOT a real org's runtime entitlement.
 */
export const TEAMS_ENABLED: boolean = DEV_OVERRIDE;
