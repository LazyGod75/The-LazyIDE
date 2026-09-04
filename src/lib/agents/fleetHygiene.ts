/* fleetHygiene.ts — P58: automatic fleet hygiene.

   FOUNDER DIRECTIVE (verbatim): "hygiène naturelle et auto, fais en sorte
   que l'app soit opti et sature pas, ça peut pas freeze c'est pas normal.
   Chaque action manuelle prise pendant l'audit = une chose qui manque dans
   l'app." A real audit session needed a human to manually tell the manager
   to clean up 4 duplicate retry attempts, months-old dead missions, stale
   signals, duplicate preview placeholders, and e2e-scratch canvas debris —
   every one of those is now a standing rule here instead of a one-off
   manual cleanup.

   Every rule in this module is a PURE function over plain data fixtures —
   no I/O, no React, no journal/canvas imports — so the whole rule set is
   unit-testable in isolation (see src/__tests__/fleetHygiene.test.ts) and
   safely composable by whatever wiring calls it (agentsStore.tsx's
   `runFleetHygieneSweep`, the one real caller today).

   HARD SAFETY FLOOR (never relaxed by any rule below): a mission is only
   ever a candidate for (a)/(a2)/(b)/(c) when its OWN `status` is exactly
   'done', 'cancelled', or 'failed' — 'running', 'queued', and 'review' are
   NEVER inspected by the archive rules at all, structurally, regardless of
   age, title collisions, or anything else a caller passes in. This mirrors
   the standing product rule this feature was built under: "NEVER touch
   running/review/pending-decision missions." 'cancelled' graduated out of
   this untouchable set (worktree-leak follow-up, see (a2) below) — a
   cancelled mission is a mission the user (or the system) already decided
   to stop; leaving it un-archivable forever just because it never merged
   was a real product gap (cancelled missions never auto-archived,
   confirmed piling up in real fleets), not a safety requirement.

   Rules implemented (spec P58):
     (a) planMissionArchival  — done/merged missions, grace period (§ grace)
     (a2) planMissionArchival — cancelled missions, own grace period (worktree-
                                leak follow-up, reason 'cancelled_grace_period')
     (b) planMissionArchival  — failed missions superseded by a newer
                                same-title retry (reason 'superseded')
     (c) planMissionArchival  — failed missions stale 7+ days with no retry
                                at all (reason 'stale')
     (d) purgeStaleSignals    — anything keyed by a missionId that no longer
                                resolves to a live (non-archived) mission
     (e) dedupePreviewSurfaces — at most one preview surface per project
     (f) findTestCanvasArtifacts — canvas drafts/notes that are test debris
     (f) planTestScratchProjectClosure — 2026-07-22 memory-pressure incident
                                fix: rule (f) also sweeps the OPEN-PROJECTS
                                registry, not just canvas artifacts. A
                                leftover e2e/soak-scratch project left open
                                after its own test run can auto-spawn a dev
                                server later (devPreview.ts's auto-detect),
                                into a scratch cwd that no longer matters —
                                exactly the incident this rule closes.
     (g) planTransientSurfaceTtl — worktree-leak follow-up (Fix 4): a preview
                                surface that has NEVER been configured with a
                                real address, once it has sat past its own
                                TTL — "dead preview, server long gone" in its
                                most literal form. Scoped to `kind ===
                                'preview'` only; never a 'terminal' surface,
                                never a macro/loop/draft/note (see the
                                function's own doc comment for the full
                                boundary).
     (h) planIdleTerminalClosure — memory-pressure follow-up (Fix 2): a
                                terminal surface with no PTY output AND not
                                selected/focused for its own TTL. Scoped to
                                `kind === 'terminal'` only; fails closed on
                                unknown activity (never guesses a fresh
                                terminal is idle).
*/

import type { Mission, MissionStatus } from './types.js';

// ── Configuration (configurable, localStorage-backed — same convention as
// devPreview.ts's getIdleTimeoutMs/setIdleTimeoutMs) ──────────────────────

/** Grace period after a mission reaches 'done' before it is auto-archived —
 *  founder's own default ("24h, configurable"). */
export const DEFAULT_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

/** How long a failed mission with no retry sits before it is considered
 *  abandoned ("June's dead missions") rather than merely recent. */
export const DEFAULT_STALE_FAILED_MS = 7 * 24 * 60 * 60 * 1000;

/** Grace period after a mission reaches 'cancelled' before it is
 *  auto-archived (worktree-leak follow-up — see rule (a2)) — same 24h
 *  default as {@link DEFAULT_GRACE_PERIOD_MS}'s own "give the user a day to
 *  notice/revert before anything vanishes" intent, kept as an independently
 *  configurable knob rather than literally reusing `gracePeriodMs` (matches
 *  this module's own established "one knob per rule" convention —
 *  `staleFailedMs` is likewise separate from `gracePeriodMs`). */
export const DEFAULT_CANCELLED_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

/** TTL a NEVER-CONFIGURED preview placeholder survives before rule (g)
 *  removes it (worktree-leak follow-up, Fix 4) — same 24h default as
 *  {@link DEFAULT_GRACE_PERIOD_MS}, independently configurable. */
export const DEFAULT_TRANSIENT_SURFACE_TTL_MS = 24 * 60 * 60 * 1000;

/** How long a terminal surface survives with no PTY output AND not focused
 *  before rule (h) (planIdleTerminalClosure) makes it eligible for
 *  auto-close (Fix 2, memory-pressure follow-up) — deliberately much
 *  shorter than the mission grace periods above: an interactive shell
 *  going quiet for hours is a far stronger "forgotten, safe to reclaim"
 *  signal than a finished mission still waiting to be reviewed. Same
 *  configurable-via-localStorage convention as every other TTL here. */
export const DEFAULT_IDLE_TERMINAL_TTL_MS = 6 * 60 * 60 * 1000;

export interface FleetHygieneConfig {
  gracePeriodMs: number;
  staleFailedMs: number;
  cancelledGracePeriodMs: number;
  transientSurfaceTtlMs: number;
  idleTerminalTtlMs: number;
}

export const DEFAULT_HYGIENE_CONFIG: FleetHygieneConfig = {
  gracePeriodMs: DEFAULT_GRACE_PERIOD_MS,
  staleFailedMs: DEFAULT_STALE_FAILED_MS,
  cancelledGracePeriodMs: DEFAULT_CANCELLED_GRACE_PERIOD_MS,
  transientSurfaceTtlMs: DEFAULT_TRANSIENT_SURFACE_TTL_MS,
  idleTerminalTtlMs: DEFAULT_IDLE_TERMINAL_TTL_MS,
};

const GRACE_PERIOD_STORAGE_KEY = 'lazy.fleetHygiene.gracePeriodMs';
const STALE_FAILED_STORAGE_KEY = 'lazy.fleetHygiene.staleFailedMs';
const CANCELLED_GRACE_PERIOD_STORAGE_KEY = 'lazy.fleetHygiene.cancelledGracePeriodMs';
const TRANSIENT_SURFACE_TTL_STORAGE_KEY = 'lazy.fleetHygiene.transientSurfaceTtlMs';
const IDLE_TERMINAL_TTL_STORAGE_KEY = 'lazy.fleetHygiene.idleTerminalTtlMs';

function readStoredMs(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredMs(key: string, ms: number | undefined): void {
  try {
    if (ms === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, String(ms));
  } catch {
    // best-effort only — same convention as devPreview.ts's writeNumberRecord
  }
}

/** The configured grace period, or {@link DEFAULT_GRACE_PERIOD_MS} when
 *  never overridden. */
export function getConfiguredGracePeriodMs(): number {
  return readStoredMs(GRACE_PERIOD_STORAGE_KEY, DEFAULT_GRACE_PERIOD_MS);
}

export function setConfiguredGracePeriodMs(ms: number | undefined): void {
  writeStoredMs(GRACE_PERIOD_STORAGE_KEY, ms);
}

/** The configured stale-failed threshold, or {@link DEFAULT_STALE_FAILED_MS}
 *  when never overridden. */
export function getConfiguredStaleFailedMs(): number {
  return readStoredMs(STALE_FAILED_STORAGE_KEY, DEFAULT_STALE_FAILED_MS);
}

export function setConfiguredStaleFailedMs(ms: number | undefined): void {
  writeStoredMs(STALE_FAILED_STORAGE_KEY, ms);
}

/** The configured cancelled-mission grace period, or
 *  {@link DEFAULT_CANCELLED_GRACE_PERIOD_MS} when never overridden. */
export function getConfiguredCancelledGracePeriodMs(): number {
  return readStoredMs(CANCELLED_GRACE_PERIOD_STORAGE_KEY, DEFAULT_CANCELLED_GRACE_PERIOD_MS);
}

export function setConfiguredCancelledGracePeriodMs(ms: number | undefined): void {
  writeStoredMs(CANCELLED_GRACE_PERIOD_STORAGE_KEY, ms);
}

/** The configured transient-preview-surface TTL, or
 *  {@link DEFAULT_TRANSIENT_SURFACE_TTL_MS} when never overridden. */
export function getConfiguredTransientSurfaceTtlMs(): number {
  return readStoredMs(TRANSIENT_SURFACE_TTL_STORAGE_KEY, DEFAULT_TRANSIENT_SURFACE_TTL_MS);
}

export function setConfiguredTransientSurfaceTtlMs(ms: number | undefined): void {
  writeStoredMs(TRANSIENT_SURFACE_TTL_STORAGE_KEY, ms);
}

/** The configured idle-terminal TTL, or {@link DEFAULT_IDLE_TERMINAL_TTL_MS}
 *  when never overridden. */
export function getConfiguredIdleTerminalTtlMs(): number {
  return readStoredMs(IDLE_TERMINAL_TTL_STORAGE_KEY, DEFAULT_IDLE_TERMINAL_TTL_MS);
}

export function setConfiguredIdleTerminalTtlMs(ms: number | undefined): void {
  writeStoredMs(IDLE_TERMINAL_TTL_STORAGE_KEY, ms);
}

/** Reads every configured threshold at once — the shape `planFleetHygiene`
 *  and `planMissionArchival` accept. Callers that already have a config
 *  object (e.g. a unit test's fixture) should pass it directly instead of
 *  calling this (which touches `localStorage`). */
export function getFleetHygieneConfig(): FleetHygieneConfig {
  return {
    gracePeriodMs: getConfiguredGracePeriodMs(),
    staleFailedMs: getConfiguredStaleFailedMs(),
    cancelledGracePeriodMs: getConfiguredCancelledGracePeriodMs(),
    transientSurfaceTtlMs: getConfiguredTransientSurfaceTtlMs(),
    idleTerminalTtlMs: getConfiguredIdleTerminalTtlMs(),
  };
}

// ── (a)(b)(c) Mission archival ────────────────────────────────────────

/**
 * Minimal mission shape every archive rule reads. Deliberately NOT the full
 * `Mission` — a real `Mission` satisfies this by structural typing (every
 * field here is also on `Mission`), so callers can pass real missions
 * directly; test fixtures only need to fill in what a given rule actually
 * inspects.
 */
export type HygieneMission = Pick<Mission, 'id' | 'title' | 'status' | 'merged' | 'archived' | 'createdAt'> & {
  /**
   * Best-known epoch ms this mission reached its CURRENT status (done/
   * failed) — the anchor the grace-period rule (a) measures elapsed time
   * from. The real `Mission` type has no such field (see agentsStore.tsx's
   * wiring comment for why): the caller supplies its own best estimate —
   * an in-memory terminal-transition timestamp when the mission finished
   * this session, falling back to `createdAt` across a restart (missions
   * essentially never run for the multi-day span that would make that
   * fallback meaningfully wrong for a 24h-default grace period). Absent
   * means "unknown" — rule (a) then fails closed and never archives it,
   * same "never fabricate, never guess" convention as the rest of this
   * codebase.
   */
  terminalAtMs?: number;
};

export type ArchiveReason = 'grace_period' | 'superseded' | 'stale' | 'cancelled_grace_period';

export interface MissionArchivePlan {
  id: string;
  reason: ArchiveReason;
}

/** Case/whitespace-insensitive title key used to detect "the same mission,
 *  retried" — a plain retry (agentsStore.tsx's retryMission) never changes
 *  the title, so an exact normalized match is enough; no fuzzy matching
 *  (never risk conflating two genuinely different missions that merely
 *  share some words). */
export function normalizeMissionTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Parses the trailing digits off a `M<n>`-style mission id (agentsStore.tsx's
 *  own id convention — see its `missionIdNumber`). Returns undefined for any
 *  id that doesn't end in digits, rather than guessing 0 (which would make
 *  every such id look "oldest"). */
function trailingIdNumber(id: string): number | undefined {
  const match = /(\d+)$/.exec(id);
  return match ? Number(match[1]) : undefined;
}

/**
 * Orders two missions by creation time: real `createdAt` timestamps when
 * BOTH missions carry one (the accurate case), else each mission id's own
 * trailing sequence number when BOTH resolve to one (mission ids are minted
 * strictly increasing — see agentsStore.tsx's `nextMissionId` — so this is
 * a reliable proxy for "created later" even without a timestamp). Returns
 * undefined — never a guess — when neither signal is available on BOTH
 * sides; a caller must then treat the pair as "order unknown" rather than
 * assume one supersedes the other.
 *
 * Positive means `a` is newer than `b`, negative means `a` is older, 0 means
 * they tie (should not happen for two distinct real missions, but handled
 * honestly rather than crashing).
 */
export function compareMissionOrder(a: HygieneMission, b: HygieneMission): number | undefined {
  if (typeof a.createdAt === 'number' && typeof b.createdAt === 'number') {
    return a.createdAt - b.createdAt;
  }
  const aNum = trailingIdNumber(a.id);
  const bNum = trailingIdNumber(b.id);
  if (aNum !== undefined && bNum !== undefined) return aNum - bNum;
  return undefined;
}

/** True when some OTHER mission in `all` shares `mission`'s normalized title
 *  and is reliably ordered AFTER it (per `compareMissionOrder`) — i.e. a
 *  real retry/relaunch of the same work exists. */
function hasNewerSameTitleSibling(mission: HygieneMission, all: readonly HygieneMission[]): boolean {
  const key = normalizeMissionTitle(mission.title);
  return all.some((other) => {
    if (other.id === mission.id) return false;
    if (normalizeMissionTitle(other.title) !== key) return false;
    const order = compareMissionOrder(other, mission);
    return order !== undefined && order > 0;
  });
}

/**
 * Rules (a)(a2)(b)(c): which TERMINAL missions are safe to archive right
 * now. Never includes a mission whose status is anything other than 'done',
 * 'cancelled', or 'failed' (see this module's header — the hard safety
 * floor), and never a mission already archived.
 *
 *  (a) 'done' (merged/completed — see Mission.status's own doc comment: in
 *      this codebase 'done' always implies a real merge for a one-shot
 *      mission), whose `terminalAtMs` is known and at least
 *      `config.gracePeriodMs` in the past -> reason 'grace_period'.
 *  (a2) 'cancelled' (worktree-leak follow-up — a cancelled mission used to
 *      be structurally excluded from every rule forever, so it never
 *      auto-archived no matter how old), whose `terminalAtMs` is known and
 *      at least `config.cancelledGracePeriodMs` in the past -> reason
 *      'cancelled_grace_period'. No supersede/stale distinction (unlike
 *      'failed' below) — a cancelled mission was already a deliberate stop,
 *      there is no "abandoned vs. actively retried" question left to ask.
 *  (b) 'failed', superseded by a newer same-title mission (any status) ->
 *      reason 'superseded', archived immediately (no age requirement — the
 *      user has already moved on by retrying).
 *  (c) 'failed', not superseded (rule b did not already claim it), whose
 *      `terminalAtMs` is known and at least `config.staleFailedMs` in the
 *      past -> reason 'stale'.
 *
 * A mission can only ever match ONE reason — (b) is checked before (c), so
 * a superseded-and-also-old failed mission is reported as 'superseded'
 * (the more informative reason).
 */
export function planMissionArchival(
  missions: readonly HygieneMission[],
  nowMs: number,
  config: FleetHygieneConfig = DEFAULT_HYGIENE_CONFIG,
): MissionArchivePlan[] {
  const plans: MissionArchivePlan[] = [];

  for (const mission of missions) {
    if (mission.archived) continue;

    if (mission.status === 'done') {
      if (mission.terminalAtMs === undefined) continue;
      if (nowMs - mission.terminalAtMs >= config.gracePeriodMs) {
        plans.push({ id: mission.id, reason: 'grace_period' });
      }
      continue;
    }

    if (mission.status === 'cancelled') {
      if (mission.terminalAtMs === undefined) continue;
      if (nowMs - mission.terminalAtMs >= config.cancelledGracePeriodMs) {
        plans.push({ id: mission.id, reason: 'cancelled_grace_period' });
      }
      continue;
    }

    if (mission.status === 'failed') {
      if (hasNewerSameTitleSibling(mission, missions)) {
        plans.push({ id: mission.id, reason: 'superseded' });
        continue;
      }
      if (mission.terminalAtMs === undefined) continue;
      if (nowMs - mission.terminalAtMs >= config.staleFailedMs) {
        plans.push({ id: mission.id, reason: 'stale' });
      }
    }
    // Every other status (running/queued/review) is deliberately never
    // inspected — see this module's header.
  }

  return plans;
}

// ── (d) Stale-signal purge ─────────────────────────────────────────────

/**
 * Anything that references a mission by id — a manager-rail bubble, an
 * attention-inbox entry, or any future notification-shaped record. Kept
 * generic (not tied to any one concrete signal type in the app) so this
 * rule stays reusable wherever a "signal" collection is actually persisted,
 * without this low-level module importing from a higher-level UI module.
 */
export interface HygieneSignal {
  id: string;
  missionId: string;
}

/**
 * Rule (d): a signal whose `missionId` does not resolve to a currently LIVE
 * mission — `liveMissionIds` is the caller's set of mission ids that both
 * (1) still exist and (2) are not archived — is stale and should be purged
 * (resolved/removed). Never mutates `signals`; returns both halves so a
 * caller can log/journal exactly what was purged.
 */
export function purgeStaleSignals<S extends HygieneSignal>(
  signals: readonly S[],
  liveMissionIds: ReadonlySet<string>,
): { kept: S[]; purged: S[] } {
  const kept: S[] = [];
  const purged: S[] = [];
  for (const signal of signals) {
    if (liveMissionIds.has(signal.missionId)) kept.push(signal);
    else purged.push(signal);
  }
  return { kept, purged };
}

// ── (e) Preview-surface dedup ──────────────────────────────────────────

/**
 * A canvas preview/terminal surface's hygiene-relevant fields (mirrors
 * canvasTypes.ts's `SurfaceSpec` structurally — see agentsStore.tsx's
 * wiring for how a real `SurfaceSpec` is mapped onto this shape).
 */
export interface HygienePreviewSurface {
  id: string;
  /** Absent for a Transverse-zone surface — never deduped against anything
   *  (there is no "per project" ownership to dedupe within). */
  projectId?: string;
  /** Empty/absent means "no address" (the placeholder repro the founder
   *  named) — never navigated, never worth keeping more than one of. */
  url?: string;
  /**
   * Best-known epoch ms this surface's address was last configured — higher
   * wins when more than one CONFIGURED surface exists for the same project.
   * `SurfaceSpec` itself carries no such timestamp (see agentsStore.tsx's
   * wiring comment); a caller without a real one may pass insertion order
   * as a monotonic proxy. Absent is treated as older than anything with a
   * value, and ties keep the LAST one seen in the input array (stable,
   * deterministic — never an arbitrary pick).
   */
  configuredAtMs?: number;
  /**
   * Fix 4 (rule (g), worktree-leak follow-up) — epoch ms this surface was
   * FIRST OBSERVED still without a real address by the hygiene sweep (see
   * agentsStore.tsx's `previewPlaceholderFirstSeenRef`). Deliberately a
   * SEPARATE field from `configuredAtMs` above: that field is an
   * insertion-order PROXY, correct only for the RELATIVE "which one is
   * newer" comparison rule (e) needs — using it for rule (g)'s ABSOLUTE
   * `nowMs - x >= ttl` age check would compare a small array-index-shaped
   * number against a real epoch-ms `nowMs`, which is always "ancient" and
   * would make every placeholder look expired immediately. Absent for a
   * surface never yet observed by a sweep, or one that already carries a
   * real address (rule (g) never inspects a configured surface's age at
   * all — see that function's own doc comment).
   */
  placeholderSinceMs?: number;
  /**
   * Fix 4 (rule (g)) — `'preview'` vs `'terminal'` (mirrors
   * canvasTypes.ts's `SurfaceKind` structurally; this low-level module
   * deliberately never imports that type directly — see
   * `HygieneCanvasArtifact`'s own doc comment on the same convention).
   * Absent is treated the same as `'terminal'` by rule (g): the safe
   * default for a rule this destructive is "never touch an unidentified
   * surface", never "assume it's safe to sweep".
   */
  kind?: 'terminal' | 'preview';
  /**
   * Fix 2 (idle-terminal auto-close) — epoch ms this surface's PTY last
   * produced OUTPUT (`lib/agents/terminalActivity.ts`'s
   * recordTerminalOutputActivity, fed by TerminalView.tsx's `onActivity` —
   * real PTY data chunks only, never the user's own keystrokes). `'preview'`
   * surfaces never set this. Absent for a `'terminal'` surface means "never
   * observed producing output yet" — rule (h) below fails closed on that,
   * same "unknown -> never touch, never guess" convention rule (a)/(g)
   * already use for their own age checks.
   */
  lastOutputAtMs?: number;
  /**
   * Fix 2 — epoch ms this surface was last the SELECTED canvas node (the
   * best available "the user is looking at/about to use this" proxy this
   * pure module has access to — see TerminalNode.tsx's wiring). Absent
   * means "never (observed) selected" — rule (h) treats that as vacuously
   * "not focused" (nothing to protect), unlike `lastOutputAtMs` above: a
   * terminal that was truly never once clicked is not somehow MORE likely
   * to be in active use than one that was.
   */
  lastFocusedAtMs?: number;
}

/** Exported for `planTransientSurfaceTtl` (rule (g)) and for
 *  agentsStore.tsx's wiring, which needs the identical "has a real
 *  address" predicate to decide which surface ids to stamp with
 *  `placeholderSinceMs` — one canonical definition, never a second
 *  hand-rolled copy that could drift from this one. */
export function hasAddress(surface: HygienePreviewSurface): boolean {
  return typeof surface.url === 'string' && surface.url.trim().length > 0;
}

/**
 * Rule (e): "keep at most ONE preview surface per project, most recently
 * configured wins; drop 'no address' placeholders when a configured one
 * exists." Surfaces with no `projectId` (Transverse zone) are always kept
 * untouched — there is nothing to dedupe them against.
 *
 * Within one project's group:
 *   - If at least one surface has a real address, keep only the most
 *     recently configured ONE of those (ties broken by last-in-input-order)
 *     and remove every other configured surface AND every placeholder.
 *   - Otherwise (every surface in the group is a placeholder), still cap at
 *     one — keep the most recently configured (or last-seen) placeholder,
 *     remove the rest.
 */
export function dedupePreviewSurfaces(
  surfaces: readonly HygienePreviewSurface[],
): { keep: HygienePreviewSurface[]; remove: HygienePreviewSurface[] } {
  const untouched: HygienePreviewSurface[] = [];
  const byProject = new Map<string, HygienePreviewSurface[]>();

  for (const surface of surfaces) {
    // Bugfix — this rule is a PREVIEW-only dedup (its own name says so); it
    // used to group every surface sharing a projectId regardless of `kind`,
    // so a live 'terminal' surface could be picked as the "loser" and
    // removed purely for lacking a preview `url`, just because it happened
    // to share a project with a real preview. Same `kind !== 'preview'` ->
    // untouched guard rule (g) (planTransientSurfaceTtl) already uses below
    // — an absent/other kind is never touched, the safe default for a rule
    // this destructive.
    if (surface.projectId === undefined || surface.kind !== 'preview') {
      untouched.push(surface);
      continue;
    }
    const group = byProject.get(surface.projectId) ?? [];
    group.push(surface);
    byProject.set(surface.projectId, group);
  }

  const keep: HygienePreviewSurface[] = [...untouched];
  const remove: HygienePreviewSurface[] = [];

  for (const group of byProject.values()) {
    const configured = group.filter(hasAddress);
    const candidates = configured.length > 0 ? configured : group;

    let winner = candidates[0];
    for (const candidate of candidates.slice(1)) {
      const winnerAt = winner.configuredAtMs ?? -Infinity;
      const candidateAt = candidate.configuredAtMs ?? -Infinity;
      if (candidateAt >= winnerAt) winner = candidate;
    }

    for (const surface of group) {
      if (surface.id === winner.id) keep.push(surface);
      else remove.push(surface);
    }
  }

  return { keep, remove };
}

// ── (g) Transient preview-surface TTL (Fix 4, worktree-leak follow-up) ────

/**
 * Rule (g): TTL for a TRANSIENT preview surface — one that has NEVER been
 * configured with a real address (`!hasAddress`, same check rule (e) uses)
 * — once it has sat for at least `config.transientSurfaceTtlMs`. This is
 * "dead preview, server long gone" in its most literal form: no server was
 * ever pointed at it in the first place.
 *
 * Scoped to `kind === 'preview'` ONLY (and an absent `kind`, from a caller
 * that has not been updated to supply it, is treated the same as
 * `'terminal'` — never touched). A `'terminal'` surface has no address
 * concept at all, so `hasAddress` is always false for one; without this
 * guard every idle-but-wanted terminal on the canvas would look identically
 * "dead" and get swept by age alone, which would be wrong.
 *
 * A surface that DOES carry a real address is never touched by this rule,
 * regardless of age. Confirming "this one WAS alive and its server died"
 * needs a live reachability signal this pure module has no access to
 * (PreviewNode.tsx's own client-local probe is never persisted to the
 * canvas store) — the existing event-driven removal on an explicit
 * `devPreview:serverStopped` (useCanvasAutoComposition.ts) already covers
 * the one case that IS tracked today (an auto-detected dev server Lazy
 * itself started and later stopped).
 *
 * Same "unknown age -> never touch, never guess" honesty as rule (a): a
 * surface with no known `placeholderSinceMs` is skipped, never assumed
 * expired.
 *
 * Never touches macros, loops/workflows, drafts, or notes — this rule only
 * ever inspects `HygienePreviewSurface`, a shape drafts/notes/macros/loops
 * are never mapped onto (see `planFleetHygiene`'s wiring).
 */
export function planTransientSurfaceTtl(
  surfaces: readonly HygienePreviewSurface[],
  nowMs: number,
  config: FleetHygieneConfig = DEFAULT_HYGIENE_CONFIG,
): HygienePreviewSurface[] {
  return surfaces.filter((surface) => {
    if (surface.kind !== 'preview') return false;
    if (hasAddress(surface)) return false;
    if (surface.placeholderSinceMs === undefined) return false;
    return nowMs - surface.placeholderSinceMs >= config.transientSurfaceTtlMs;
  });
}

// ── (h) Idle-terminal auto-close (Fix 2, memory-pressure follow-up) ──────
//
// Terminal surfaces (real PTY + xterm, 2000-line scrollback each) had NO
// count cap and NO auto-eviction at all — this module's rule (g) above
// explicitly excludes them (a terminal has no "address" concept), and
// nothing else in the app ever closed one the user didn't explicitly click
// "x" on. A canvas left open for days with a handful of forgotten terminals
// keeps every one of their PTYs + xterm buffers resident indefinitely.

/**
 * Rule (h): terminal surfaces safe to auto-close because they look
 * ABANDONED — no PTY output for at least `config.idleTerminalTtlMs`, AND
 * not selected/focused within that same window either. Conservative by
 * construction:
 *   - Scoped to `kind === 'terminal'` ONLY (mirrors rule (g)'s own guard);
 *     an absent/other kind is never touched.
 *   - `lastOutputAtMs` unknown -> never eligible (fails closed, same
 *     "unknown -> never touch, never guess" convention as rule (a)/(g) —
 *     see HygienePreviewSurface.lastOutputAtMs's own doc comment).
 *   - A RECENT focus inside the window always protects the surface
 *     regardless of how quiet its output has been — a human sitting at an
 *     idle prompt, about to type, is exactly the case this must never
 *     auto-close. `lastFocusedAtMs` unknown does NOT protect (see that
 *     field's own doc comment).
 *
 * Never inspects "does this terminal have a running foreground process"
 * directly — this pure module has no OS-level process-tree signal to read.
 * A real foreground process that is still producing output keeps refreshing
 * `lastOutputAtMs`, which is the best available proxy without adding a
 * Rust-side process inspection this fix does not attempt.
 */
export function planIdleTerminalClosure(
  surfaces: readonly HygienePreviewSurface[],
  nowMs: number,
  config: FleetHygieneConfig = DEFAULT_HYGIENE_CONFIG,
): HygienePreviewSurface[] {
  return surfaces.filter((surface) => {
    if (surface.kind !== 'terminal') return false;
    if (surface.lastOutputAtMs === undefined) return false;
    if (nowMs - surface.lastOutputAtMs < config.idleTerminalTtlMs) return false;
    if (surface.lastFocusedAtMs !== undefined && nowMs - surface.lastFocusedAtMs < config.idleTerminalTtlMs) {
      return false;
    }
    return true;
  });
}

// ── (f) Test-artifact canvas debris ────────────────────────────────────

/** Matches the two REAL naming conventions this codebase's own e2e/soak
 *  scripts use for scratch canvas nodes — test artifacts never belong in a
 *  user's fleet (founder's own framing: "e2e-scratch artifacts"). */
const TEST_ARTIFACT_PATTERN = /^lazy-e2e-|-soak-scratch-/;

/** A canvas draft/note (or any other id+label canvas node) — `label` is
 *  whichever descriptive string the real node carries (`DraftSpec.title`,
 *  `NoteData.text`, ...); this module never imports canvasTypes.ts directly
 *  (see fleetHygiene.ts's own low-level-module convention), so callers map
 *  their real node onto this shape. */
export interface HygieneCanvasArtifact {
  id: string;
  label?: string;
}

/** True when either the artifact's id or its label matches the test-scratch
 *  naming convention. */
export function isTestCanvasArtifact(artifact: HygieneCanvasArtifact): boolean {
  return TEST_ARTIFACT_PATTERN.test(artifact.id) || (artifact.label !== undefined && TEST_ARTIFACT_PATTERN.test(artifact.label));
}

/** Rule (f): every artifact in `artifacts` that looks like e2e/soak test
 *  debris. */
export function findTestCanvasArtifacts<A extends HygieneCanvasArtifact>(artifacts: readonly A[]): A[] {
  return artifacts.filter(isTestCanvasArtifact);
}

// ── (f, extended) Test-scratch OPEN PROJECT closure ────────────────────
// 2026-07-22 memory-pressure incident: fleet hygiene's rule (f) only ever
// swept canvas artifacts — a leftover e2e/soak-scratch PROJECT (registered
// via AppContext.tsx's `registerProject`, tracked in Rust's `projects.json`)
// was never touched, so it stayed in `openProjects` indefinitely. The
// founder's own incident: the app woke from sleep with ~1.4GB free RAM and
// auto-spawned a dev server (devPreview.ts) into exactly such a leftover
// scratch project's cwd, which failed with a raw OS "not enough memory"
// error. This section closes the other half of that fix: sweep
// `openProjects` for the SAME test-scratch naming convention and close
// every match via the app's REAL removal primitive (AppContext.tsx's
// `closeProject`), never inventing a second deletion path.

/** A project entry this rule inspects — mirrors AppContext.tsx's
 *  `ProjectEntry` (`ProjectEntryOut`) structurally (every field here is
 *  also on that real type), so a caller can pass a real entry directly. */
export interface HygieneProject {
  id: string;
  root: string;
  /** Whether this is the currently ACTIVE project — see
   *  `planTestScratchProjectClosure`'s own doc comment: the hard safety
   *  floor this rule never relaxes is that the active project is never
   *  closed without switching away from it first. */
  active: boolean;
}

/** Rule (f, extended): every project in `projects` whose `root` matches the
 *  SAME test-scratch naming convention as `isTestCanvasArtifact` above
 *  (`TEST_ARTIFACT_PATTERN`) — e.g. a real e2e soak scratch dir like
 *  `...\lazy-e2e-soak-scratch-1784236548334`. The pattern's `-soak-scratch-`
 *  branch is unanchored, so it matches anywhere inside the full path —
 *  correct regardless of a Windows verbatim (`\\?\`) prefix or how deep the
 *  scratch folder sits. */
export function findTestScratchProjects<P extends HygieneProject>(projects: readonly P[]): P[] {
  return projects.filter((p) => TEST_ARTIFACT_PATTERN.test(p.root));
}

export interface ProjectClosurePlan {
  /**
   * Project ids to close, IN ORDER — a caller MUST close them sequentially
   * in this exact order (never in parallel, never reordered). This plan
   * always places the currently-active scratch project (if any) LAST,
   * specifically so a caller that just iterates in order and awaits each
   * `closeProject` call never hits the real registry's own safety rule
   * (`ProjectRegistry::close`, src-tauri/src/state.rs): closing the active
   * project while OTHER projects remain open is rejected — only closing
   * the active project once it is the LAST one open is allowed (it then
   * clears `active` back to none rather than erroring).
   */
  idsToClose: string[];
  /**
   * When present, the caller MUST switch the active project to this id
   * (AppContext.tsx's `switchProject`) BEFORE closing anything in
   * `idsToClose` — set only when the active project is itself scratch AND
   * a real, non-scratch project exists to switch to. Absent when either
   * the active project is not scratch (nothing to switch away from) or no
   * non-scratch project exists at all (see `planTestScratchProjectClosure`'s
   * own doc comment for that edge case — it still closes the active
   * scratch project, just last and with no explicit switch step, ending
   * with no active project rather than leaving scratch debris open).
   */
  switchActiveTo?: string;
}

/**
 * Rule (f, extended): plans which open projects to close, and whether the
 * caller must switch away from the active one first — the hard safety
 * floor this rule never relaxes: the active project is NEVER closed
 * without switching away from it first (never left "dangling" on a
 * since-removed id).
 *
 *  - No scratch project at all -> nothing to do (`{ idsToClose: [] }`).
 *  - The active project is NOT itself scratch -> close every scratch
 *    project directly (each is necessarily non-active, always safe per
 *    the registry's own "closing a non-active project is unconditional"
 *    rule) — no switch needed.
 *  - The active project IS scratch and a real non-scratch project exists
 *    -> switch there first (`switchActiveTo`), then close every scratch
 *    project (the formerly-active one is now safely non-active, ordered
 *    last defensively — see `idsToClose`'s own doc comment).
 *  - The active project IS scratch and NO non-scratch project exists
 *    anywhere in the fleet (every open project is scratch debris) -> there
 *    is nothing sane to switch to; close every OTHER scratch project first
 *    (always safe), which makes the active one the LAST project open — the
 *    registry then allows closing it directly (clears `active` to none)
 *    rather than rejecting, so this still closes it, just last and with no
 *    `switchActiveTo` step, honestly ending with zero open projects rather
 *    than leaving scratch debris open forever.
 */
export function planTestScratchProjectClosure(projects: readonly HygieneProject[]): ProjectClosurePlan {
  const scratch = findTestScratchProjects(projects);
  if (scratch.length === 0) return { idsToClose: [] };

  const activeScratch = scratch.find((p) => p.active);
  if (!activeScratch) {
    return { idsToClose: scratch.map((p) => p.id) };
  }

  const otherScratchIds = scratch.filter((p) => p.id !== activeScratch.id).map((p) => p.id);
  const nonScratch = projects.find((p) => !TEST_ARTIFACT_PATTERN.test(p.root));

  if (nonScratch) {
    return { idsToClose: [...otherScratchIds, activeScratch.id], switchActiveTo: nonScratch.id };
  }
  return { idsToClose: [...otherScratchIds, activeScratch.id] };
}

// ── (i) Autonomous-loop supervision (spec §4.4) — extracted to
// loopSupervision.ts (file-size convention); re-exported here so every
// existing import of these names from './fleetHygiene.js' keeps working.
export {
  planLoopSupervision,
  STALLED_OVERDUE_CADENCE_MULTIPLIER,
  REPEATED_FAILURE_THRESHOLD,
  type HygieneLoop,
  type LoopSupervisionReason,
  type LoopSupervisionAlert,
} from './loopSupervision.js';
import { planLoopSupervision, type HygieneLoop, type LoopSupervisionAlert } from './loopSupervision.js';

// ── (i) Orphan git worktree recovery/cleanup ──────────────────────────
// Verified on the founder's backoffice test repo (2026-08): 33 orphan
// worktrees (branches agent/* and M*-*), 24 completely EMPTY (pointing at
// the seed commit — a mission that was created/queued but never ran), and
// ONE carrying the entire Next.js scaffold the app had produced but NEVER
// merged into main (work lost from the user's perspective until a human
// manually merged the branch). Other agents never leave this
// debris: they edit the working tree directly. Lazy's worktree isolation
// must therefore be paired with an automatic sweep that:
//   (1) DETECTS every orphan branch (agent/* or M*-wt) not merged into the
//       current branch,
//   (2) CLASSIFIES it as `recoverable` (its HEAD commit is NOT reachable
//       from the target branch — real work exists) or `empty` (its HEAD is
//       already contained in the target — nothing to lose),
//   (3) returns BOTH lists so the caller can merge the recoverable work
//       into the target branch and delete the empty branches.
// The merge itself is deliberately NOT done here (pure rule, no git I/O —
// same convention as every other rule in this module); the caller applies
// `recoverable` through the app's real mergeWorktree and `empty` through
// discardWorktree. Safety floor: a branch whose HEAD equals the target's
// HEAD is always `empty` (nothing to merge), and a branch whose HEAD is NOT
// reachable is always `recoverable` — never guessed, both derived from real
// git reachability data the caller supplies.

/** Shape of one git branch the orphan sweep classifies. The caller gathers
 *  this from REAL git plumbing (branches + merge-base/reachability), never
 *  from mission metadata — the worktree on disk is the ground truth. */
export interface HygieneOrphanBranch {
  /** Branch name as git reports it (e.g. `agent/M12-brancher-la-page-...`). */
  name: string;
  /** HEAD sha of this branch (git rev-parse <branch>). */
  headSha: string;
  /** True when `headSha` is reachable from the target branch's HEAD (git
   *  merge-base --is-ancestor <headSha> <target>). */
  containedInTarget: boolean;
}

export type OrphanWorktreeClass = 'recoverable' | 'empty';

export interface OrphanWorktreePlan {
  /** Branches carrying REAL work not yet in the target branch — the caller
   *  should merge these (the app's mergeWorktree), never delete them. */
  recoverable: HygieneOrphanBranch[];
  /** Branches whose HEAD is already contained in the target — nothing to
   *  lose; the caller may delete them (the app's discardWorktree). */
  empty: HygieneOrphanBranch[];
}

/** Rule (i) — classify orphan agent worktree branches into recoverable vs
 *  empty. Pure over real git reachability data. Never throws. A branch with
 *  a head sha the caller could not resolve (missing headSha) is treated as
 *  `empty` — deleting a branch that has no commit is safe; merging one is
 *  meaningless. */
export function planOrphanWorktreeCleanup(branches: readonly HygieneOrphanBranch[]): OrphanWorktreePlan {
  const recoverable: HygieneOrphanBranch[] = [];
  const empty: HygieneOrphanBranch[] = [];
  for (const branch of branches) {
    if (!branch.headSha || branch.containedInTarget) {
      empty.push(branch);
    } else {
      recoverable.push(branch);
    }
  }
  return { recoverable, empty };
}


// ── Composition: one sweep, one honest summary ─────────────────────────

export type FleetHygieneEventReason = ArchiveReason;

export interface FleetHygieneInputs {
  missions: readonly HygieneMission[];
  /** Optional — a codebase with no persisted signal ledger simply omits
   *  this (defaults to none), which is honest: nothing to purge, not a
   *  fabricated zero-effort success. */
  signals?: readonly HygieneSignal[];
  previewSurfaces?: readonly HygienePreviewSurface[];
  canvasArtifacts?: readonly HygieneCanvasArtifact[];
  /** Optional — a caller with no open-projects registry to check (web mode,
   *  or a unit test not exercising this rule) simply omits this, which is
   *  honest: nothing to sweep, not a fabricated zero-effort success. */
  openProjects?: readonly HygieneProject[];
  /** Optional — rule (i)'s registered loops, when the caller tracks any
   *  (see agentsStore.tsx's `runFleetHygieneSweep` wiring). Absent is
   *  honest: no loops registered, nothing to supervise. */
  loops?: readonly HygieneLoop[];
  /** Optional — rule (j): orphan agent worktree branches gathered from real
   *  git plumbing (see `planOrphanWorktreeCleanup`). Absent is honest: no
   *  branch data supplied, nothing to classify (web mode, or a caller not
   *  yet wired). */
  orphanWorktreeBranches?: readonly HygieneOrphanBranch[];
}

export interface FleetHygieneSummary {
  archived: number;
  /** Stale signals purged (rule d) PLUS test-artifact canvas nodes deleted
   *  (rule f) — both are real REMOVALS (never a soft archive), so they
   *  share one bucket in the journaled summary (`fleet.hygiene`'s
   *  `purged` field — see journal/eventTypes.ts's `FleetHygienePayload`). PLUS
   *  transient preview surfaces removed by rule (g)'s TTL (Fix 4) — also a
   *  real removal, never a soft archive, same bucket for the same reason.
   *  PLUS idle terminal surfaces closed by rule (h) (Fix 2) — same reason. */
  purged: number;
  /** Duplicate preview surfaces removed (rule e). */
  deduped: number;
  /** Test-scratch open projects closed this sweep (rule f, extended — see
   *  `planTestScratchProjectClosure`). Deliberately its OWN bucket, not
   *  folded into `purged`: a project closure switches the active project
   *  and touches the Rust registry, a materially different kind of change
   *  than the in-memory removals `purged` already covers. */
  projectsClosed: number;
  /** Rule (i) — autonomous loops flagged for supervision this sweep (stalled,
   *  repeatedly failing, or a declining learned metric). Its own bucket, not
   *  folded into `purged`/`archived`: unlike those, a supervision alert is
   *  never itself a removal or an archival — the caller decides whether to
   *  pause the loop and/or just alert the user (see LoopSupervisionAlert). */
  loopsFlagged: number;
  /** Rule (j) — orphan worktree branches found carrying REAL work not yet in
   *  the target branch (`recoverable`). Its own bucket: unlike every other
   *  count here, this is WORK TO SAVE, not debris to remove — the caller
   *  surfaces it to the user and merges it (never silently discards). */
  orphanWorktreesRecoverable: number;
}

export interface FleetHygieneResult {
  missionsToArchive: MissionArchivePlan[];
  signalsToPurge: HygieneSignal[];
  previewSurfacesToRemove: HygienePreviewSurface[];
  /** Fix 4 (rule (g)) — never-configured preview placeholders past their
   *  TTL. Always disjoint from `previewSurfacesToRemove` above (a surface
   *  rule (e)'s dedup already claimed this same sweep is excluded here, so
   *  a caller applying both lists in sequence never double-removes or
   *  double-counts the same surface id). */
  transientSurfacesToRemove: HygienePreviewSurface[];
  /** Fix 2 (rule (h)) — idle terminal surfaces (no output, not focused,
   *  both past `config.idleTerminalTtlMs`) eligible for auto-close.
   *  Structurally disjoint from `previewSurfacesToRemove`/
   *  `transientSurfacesToRemove` above — those two are preview-only (see
   *  rule (e)'s and (g)'s own `kind === 'preview'` guards), this one is
   *  terminal-only (rule (h)'s own `kind === 'terminal'` guard) — so no
   *  surface can ever appear in both a preview list and this one. */
  terminalSurfacesToClose: HygienePreviewSurface[];
  canvasArtifactsToDelete: HygieneCanvasArtifact[];
  projectClosure: ProjectClosurePlan;
  /** Rule (i) — see `LoopSupervisionAlert` and `planLoopSupervision`. Always
   *  `[]` when the caller passed no `loops` input. */
  loopAlerts: LoopSupervisionAlert[];
  /** Rule (j) — see `planOrphanWorktreeCleanup`. Always empty lists when the
   *  caller passed no `orphanWorktreeBranches` input. */
  orphanWorktreePlan: OrphanWorktreePlan;
  summary: FleetHygieneSummary;
}

/**
 * Runs every rule (a)-(h) against one fleet snapshot and returns exactly
 * what should change plus the honest summary counts the sweep journals as
 * ONE `fleet.hygiene` event (see agentsStore.tsx's `runFleetHygieneSweep`).
 * Purely a plan — this function itself mutates nothing; the caller applies
 * each list through the app's REAL primitives (archiveMission,
 * canvasStoreVanilla's removeSurface/removeDraft/removeNote, AppContext's
 * switchProject/closeProject), so every change still goes through the exact
 * same audit trail a manual action would.
 *
 * A mission this sweep is ABOUT to archive is treated as no-longer-live for
 * rule (d)'s purposes too (its signals are purged in the SAME sweep that
 * archives it, not one sweep later).
 */
export function planFleetHygiene(
  inputs: FleetHygieneInputs,
  nowMs: number,
  config: FleetHygieneConfig = DEFAULT_HYGIENE_CONFIG,
): FleetHygieneResult {
  const missionsToArchive = planMissionArchival(inputs.missions, nowMs, config);
  const willBeArchived = new Set(missionsToArchive.map((p) => p.id));
  const liveMissionIds = new Set(
    inputs.missions.filter((m) => !m.archived && !willBeArchived.has(m.id)).map((m) => m.id),
  );

  const { purged: signalsToPurge } = purgeStaleSignals(inputs.signals ?? [], liveMissionIds);
  const { remove: previewSurfacesToRemove } = dedupePreviewSurfaces(inputs.previewSurfaces ?? []);
  // Excludes anything rule (e) already claimed THIS sweep — see
  // `transientSurfacesToRemove`'s own doc comment on `FleetHygieneResult`.
  const dedupedSurfaceIds = new Set(previewSurfacesToRemove.map((s) => s.id));
  const transientSurfacesToRemove = planTransientSurfaceTtl(inputs.previewSurfaces ?? [], nowMs, config).filter(
    (s) => !dedupedSurfaceIds.has(s.id),
  );
  const terminalSurfacesToClose = planIdleTerminalClosure(inputs.previewSurfaces ?? [], nowMs, config);
  const canvasArtifactsToDelete = findTestCanvasArtifacts(inputs.canvasArtifacts ?? []);
  const projectClosure = planTestScratchProjectClosure(inputs.openProjects ?? []);
  const loopAlerts = planLoopSupervision(inputs.loops ?? [], nowMs);
  const orphanWorktreePlan = planOrphanWorktreeCleanup(inputs.orphanWorktreeBranches ?? []);

  return {
    missionsToArchive,
    signalsToPurge,
    previewSurfacesToRemove,
    transientSurfacesToRemove,
    terminalSurfacesToClose,
    canvasArtifactsToDelete,
    projectClosure,
    loopAlerts,
    orphanWorktreePlan,
    summary: {
      archived: missionsToArchive.length,
      purged:
        signalsToPurge.length +
        canvasArtifactsToDelete.length +
        transientSurfacesToRemove.length +
        terminalSurfacesToClose.length,
      deduped: previewSurfacesToRemove.length,
      projectsClosed: projectClosure.idsToClose.length,
      loopsFlagged: loopAlerts.length,
      orphanWorktreesRecoverable: orphanWorktreePlan.recoverable.length,
    },
  };
}

/** Re-exported purely so a consumer can narrow on `MissionStatus` without a
 *  second import of './types' — no behavior of its own. */
export type { MissionStatus };
