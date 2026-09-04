/* approvalGate.ts — The blocking approval gate for cloud action tools.

   FAIL-CLOSED CONTRACT: a consequential action's promise never settles until
   a human verdict lands via resolveApproval. Read-only tools pass through
   untouched, manual mode blocks every non-readonly cloud tool, yolo blocks
   only credentials, supervised mode follows DEFAULT_CLASS_EFFECT plus
   persisted user rules. A second intercept for a mission that already has a
   pending approval rejects loudly instead of silently orphaning the first
   request.

   The module owns no timers, no network and no disk — rule persistence is
   delegated to approvalRules' API.
*/

import type { ActionClass, GateOutcome, GateVerdict, PageContext } from './approvalTypes.js';
import { CANCELLED_OBSERVATION, CLOUD_READONLY_TOOLS, DENIED_OBSERVATION } from './approvalTypes.js';
import { classifyAction } from './actionClassifier.js';
import { addRule, listRules, loadRules, resolveEffectDetailed, type NewApprovalRule } from './approvalRules.js';
import { emit } from '../../bus.js';

export interface PendingApproval {
  missionId: string;
  tool: string;
  args: Record<string, unknown>;
  klass: ActionClass;
  reason: 'class' | 'rule' | 'autonomy';
  page: PageContext;
  requestedAt: number;
}

export interface InterceptOptions {
  missionId: string;
  tool: string;
  args: Record<string, unknown>;
  page: PageContext;
  autonomy?: 'manual' | 'supervised' | 'yolo';   // default 'supervised'
  signal?: AbortSignal;                           // mission stop/kill
  onPending?: (pending: PendingApproval) => void; // sync hook (the bus emit lives here)
}

type PendingEntry = {
  pending: PendingApproval;
  resolve: (outcome: GateOutcome) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

const pendingByMission = new Map<string, PendingEntry>();

/** Best-effort hostname extraction for site-dimension rule matching. An
 *  unparsable or absent URL yields no site — rules then cannot match on the
 *  site dimension, which is the honest result. */
function hostFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Register a blocking approval: the returned promise stays pending until
 *  resolveApproval settles it, or until the abort signal fires. */
function blockAction(opts: InterceptOptions, klass: ActionClass, reason: 'class' | 'rule' | 'autonomy'): Promise<GateOutcome> {
  return new Promise<GateOutcome>((resolve) => {
    const pending: PendingApproval = {
      missionId: opts.missionId,
      tool: opts.tool,
      args: opts.args,
      klass,
      reason,
      page: opts.page,
      requestedAt: Date.now(),
    };
    const entry: PendingEntry = { pending, resolve };
    pendingByMission.set(opts.missionId, entry);
    opts.onPending?.(pending);
    emit('solari:approvalRequest', pending);

    if (opts.signal) {
      entry.signal = opts.signal;
      const onAbort = () => {
        if (pendingByMission.get(opts.missionId) !== entry) return;
        pendingByMission.delete(opts.missionId);
        if (entry.signal) entry.signal.removeEventListener('abort', onAbort);
        resolve({ kind: 'cancelled', observation: CANCELLED_OBSERVATION });
        emit('solari:approvalResolved', { missionId: opts.missionId, verdict: 'cancelled' });
      };
      entry.onAbort = onAbort;
      if (opts.signal.aborted) {
        onAbort();
      } else {
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  });
}

/** Intercept a cloud action tool call. Read-only tools pass through
 *  immediately; everything else is gated by autonomy mode then class/rules.
 *  A blocked action's promise does not settle until resolveApproval. */
export async function interceptAction(opts: InterceptOptions): Promise<GateOutcome> {
  // Invariant: at most ONE pending approval per mission. The agent loop is
  // sequential, so a second intercept while one is pending can only be a
  // wiring bug — fail loud rather than silently orphaning a request.
  if (pendingByMission.has(opts.missionId)) {
    throw new Error(
      `Approval already pending for mission '${opts.missionId}' — resolve it before intercepting another action.`,
    );
  }

  // Read-only cloud tools are observation-only: allow immediately in every
  // autonomy mode, with no pending and no bus event.
  if (CLOUD_READONLY_TOOLS.has(opts.tool)) {
    return { kind: 'allow' };
  }

  const klass = classifyAction(opts.tool, opts.args, opts.page);
  const autonomy = opts.autonomy ?? 'supervised';

  if (autonomy === 'manual') {
    // Manual: every non-readonly cloud tool is gated; the class is
    // irrelevant to the decision.
    return blockAction(opts, klass, 'autonomy');
  }

  if (autonomy === 'yolo') {
    // YOLO: only credentials are ever gated — an irreversible secret leak.
    if (klass === 'credentials') return blockAction(opts, klass, 'class');
    return { kind: 'allow' };
  }

  // Supervised: class default or persisted user rule decides.
  await loadRules();
  const { effect, source } = resolveEffectDetailed(klass, hostFromUrl(opts.page.url), opts.tool, listRules());
  if (effect === 'allow') return { kind: 'allow' };
  return blockAction(opts, klass, source === 'rule' ? 'rule' : 'class');
}

/** Settle a pending approval. Returns false (UI no-ops safely) when nothing
 *  was pending for that mission. */
export function resolveApproval(
  missionId: string,
  verdict: GateVerdict,
  editedArgs?: Record<string, unknown>,
): boolean {
  const entry = pendingByMission.get(missionId);
  if (!entry) return false;
  pendingByMission.delete(missionId);
  if (entry.signal && entry.onAbort) {
    entry.signal.removeEventListener('abort', entry.onAbort);
  }

  let outcome: GateOutcome;
  switch (verdict) {
    case 'approve':
      outcome = { kind: 'allow' };
      break;
    case 'edit':
      // edit requires editedArgs; a missing payload degrades to approve.
      outcome = editedArgs ? { kind: 'edited', args: editedArgs } : { kind: 'allow' };
      break;
    case 'deny':
      outcome = { kind: 'denied', observation: DENIED_OBSERVATION };
      break;
    case 'alwaysAllow': {
      const site = hostFromUrl(entry.pending.page.url);
      const rule: NewApprovalRule = {
        effect: 'allow',
        klass: entry.pending.klass,
        tool: entry.pending.tool,
        label: `Always allow ${entry.pending.klass}${site ? ` on ${site}` : ''}`,
      };
      if (site !== undefined) rule.site = site;
      // Fire-and-forget: addRule updates the in-memory store synchronously
      // before its first await, so the very next intercept sees the rule;
      // the disk write-through is best-effort.
      void addRule(rule).catch(() => { /* best-effort persist */ });
      outcome = { kind: 'allow' };
      break;
    }
  }

  entry.resolve(outcome);
  emit('solari:approvalResolved', {
    missionId,
    verdict,
    ...(editedArgs !== undefined ? { editedArgs } : {}),
  });
  return true;
}

export function getPendingApproval(missionId: string): PendingApproval | undefined {
  return pendingByMission.get(missionId)?.pending;
}

export function listPendingApprovals(): PendingApproval[] {
  return [...pendingByMission.values()].map((entry) => entry.pending);
}

