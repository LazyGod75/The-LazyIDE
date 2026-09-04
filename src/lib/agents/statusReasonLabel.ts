/* statusReasonLabel.ts — translates Mission.statusReason for display.

   Bug (real, confirmed live in the packaged app): mission card M26 rendered
   the literal machine token "consecutive_failures" instead of prose — the
   sibling card, for the same field, correctly showed "Mission interrompue
   au redémarrage" (agentsStore.tsx already calls t('agents.recoveredOnRestart')
   at the WRITE site for that one path). The write sites are inconsistent:
   some translate before ever setting Mission.statusReason (recoveredOnRestart,
   budgetExceededReason/durationExceededReason in runtime.ts, the silence
   watchdog's stopReason), others store the raw machine reason verbatim —
   runtime.ts's managed-loop failure branches (`managedOutcome.failed.reason`,
   `stepCapFallthroughReason`, both sourced from managedAgent.ts's emitMetrics
   calls), globalRuntime.ts's crash-recovery sweep ('interrupted_by_crash'),
   and agentsStore.tsx's launch-stall watchdog ('launch_stalled').

   Rather than translate at every one of those write sites (easy to miss the
   NEXT one that gets added), every render site funnels statusReason through
   this ONE function first — see missionCardReason.test.tsx-style call sites
   in MissionCard.tsx, MissionNode.tsx, ManagerSignalBubble.tsx and
   ContextualBanner.tsx. KNOWN_REASONS is the full enumerated list of every
   raw token found in the codebase (grepped every `statusReason:` assignment
   site — see this module's own test file for the sweep that keeps this
   list honest). Anything already-human (a translated sentence built at the
   write site, or free-form error text like "worktree_creation_failed: <err>"
   or a captured exception message) passes through unchanged; a genuinely
   unknown bare machine token — one this module has never seen, e.g. a
   future reason added to managedAgent.ts without updating KNOWN_REASONS —
   NEVER reaches the UI verbatim: it falls back to a generic, honest,
   translated sentence instead.

   `t` is optional (mirrors runtime.ts's TFunc convention throughout this
   codebase) — omitting it falls back to the original hardcoded French,
   never a behavior change for existing callers that predate i18n. */

import type { TFunc } from './runtime.js';

const WORKTREE_FAILED_PREFIX = 'worktree_creation_failed:';

interface ReasonEntry {
  key: string;
  fallback: string;
}

/** Every raw machine token a `statusReason` write site is known to store
 *  verbatim today. Keep this in sync with managedAgent.ts's emitMetrics
 *  reason strings, globalRuntime.ts's markInterruptedAfterCrash, and
 *  agentsStore.tsx's launch-stall watchdog — statusReasonLabel.test.ts
 *  cross-checks this list against managedAgent.ts's source so a new reason
 *  added there without a matching entry here fails the test, not silently
 *  leaks to the UI. */
const KNOWN_REASONS: Record<string, ReasonEntry> = {
  consecutive_failures: {
    key: 'agents.statusReason.consecutiveFailures',
    fallback: 'Mission arrêtée — trop d’échecs consécutifs, intervention requise.',
  },
  stuck_repeated_identical_failure: {
    key: 'agents.statusReason.stuckRepeatedIdenticalFailure',
    fallback: 'Mission arrêtée — boucle bloquée : le même échec se répète.',
  },
  stuck_repeated_action_observation: {
    key: 'agents.statusReason.stuckRepeatedActionObservation',
    fallback: 'Mission arrêtée — boucle bloquée : la même action se répète sans progrès.',
  },
  no_credits: {
    key: 'agents.statusReason.noCredits',
    fallback: 'Mission arrêtée — crédits Pro épuisés.',
  },
  provider_definitive_error: {
    key: 'agents.statusReason.providerDefinitiveError',
    fallback: 'Mission arrêtée — clé du fournisseur inutilisable.',
  },
  iteration_cap_exceeded: {
    key: 'agents.statusReason.iterationCapExceeded',
    fallback: 'Mission arrêtée — plafond de sécurité des itérations atteint.',
  },
  max_steps_exhausted: {
    key: 'agents.statusReason.maxStepsExhausted',
    fallback: 'Mission arrêtée — nombre maximum d’étapes atteint.',
  },
  budget_exceeded: {
    key: 'agents.statusReason.budgetExceeded',
    fallback: 'Mission arrêtée — budget dépassé.',
  },
  duration_exceeded: {
    key: 'agents.statusReason.durationExceeded',
    fallback: 'Mission arrêtée — délai maximum dépassé.',
  },
  interrupted_by_crash: {
    key: 'agents.statusReason.interruptedByCrash',
    fallback: 'Mission interrompue par un plantage de l’application.',
  },
  launch_stalled: {
    key: 'agents.statusReason.launchStalled',
    fallback: 'Mission bloquée en attente de lancement — aucun emplacement libre depuis un moment.',
  },
};

/** True only for a bare machine token: lowercase ascii letters/digits and
 *  underscores, no spaces, no punctuation. Every raw enum value above has
 *  exactly this shape; a translated sentence or free-form error message
 *  never does (spaces, accents, uppercase, punctuation). Used both to
 *  recognize the unknown-token fallback case and — in the test file — to
 *  assert the function's OWN output never has this shape. */
function looksLikeRawToken(value: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(value);
}

/**
 * Translates a Mission.statusReason for display. Never returns the raw
 * "worktree_creation_failed:"-prefixed detail unmodified, never returns a
 * KNOWN_REASONS token unmodified, and never returns an unrecognized bare
 * snake_case token unmodified — every one of those becomes prose. Anything
 * that isn't a bare machine token (already-translated prose, free-form
 * error text) passes through unchanged, since re-mangling it would lose
 * real information for no gain. undefined/empty input passes through as-is.
 */
export function translateStatusReason(reason: string | undefined, t?: TFunc): string | undefined {
  if (!reason) return reason;
  const trimmed = reason.trim();
  if (!trimmed) return reason;

  const translate = (entry: ReasonEntry, params?: Record<string, string | number>): string =>
    t ? t(entry.key, params) : entry.fallback;

  const known = KNOWN_REASONS[trimmed];
  if (known) return translate(known);

  if (trimmed.startsWith(WORKTREE_FAILED_PREFIX)) {
    const detail = trimmed.slice(WORKTREE_FAILED_PREFIX.length).trim();
    return translate(
      {
        key: 'agents.statusReason.worktreeCreationFailed',
        fallback: `Création du worktree impossible : ${detail}`,
      },
      { detail },
    );
  }

  if (!looksLikeRawToken(trimmed)) return reason;

  // A bare machine token this module has never seen (e.g. a new reason
  // added to managedAgent.ts's emitMetrics without a matching KNOWN_REASONS
  // entry) — the safe fallback: honest and human, never the raw identifier.
  return translate({
    key: 'agents.statusReason.unknown',
    fallback: 'Mission arrêtée — raison non reconnue.',
  });
}

// Exported for statusReasonLabel.test.ts's exhaustiveness sweep only.
export { KNOWN_REASONS as __KNOWN_REASONS_FOR_TEST__, looksLikeRawToken as __looksLikeRawToken_FOR_TEST__ };
