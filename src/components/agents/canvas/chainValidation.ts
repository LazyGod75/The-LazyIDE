/* chainValidation.ts — pure validation for creating a new Chain (spec §7,
   plan W2a deliverable #3 "Chaîner depuis…"). Split out of
   CanvasContextMenu.tsx so it is independently unit-testable (no React, no
   canvasStore) and reusable by W3's chainEngine.ts for the SAME rules at
   firing/persistence time, per the task's own instruction.

   Deliberately narrow: this only answers "is creating sourceRef -> targetRef
   structurally/semantically legal right now", given the chains that already
   exist. It does not know about React Flow, does not touch canvasStore, and
   never mutates its inputs.

   i18n (W5a sweep): this is a pure lib module with no `t()`/useI18n access,
   so a rejection carries a `reasonKey` (an i18n key, e.g.
   'canvas.chain.selfChain'), never pre-translated text — the SAME
   key-returning convention `lib/models/entitlement.ts`'s `engineReasonKey`
   already established for this exact "lib function decides WHY, the
   component decides HOW to say it" split. Every caller (agentsStore.tsx's
   executor, useCanvasChainConnect.ts) already has `t` in scope and applies
   it: `toast(t(result.reasonKey), 'error')`.
*/

import { makeRef, MIN_JOIN_SOURCES, type CanvasNodeKind, type Chain, type NodeRef } from './canvasTypes';
import type { MissionStatus } from '../../../lib/agents/types';

/** What the validator needs to know about a candidate TARGET node — kept
 *  minimal (kind + mission status when relevant) so callers can build it
 *  from whatever they already have (a React Flow node's `type`/`data`, or a
 *  reconciler ChildCandidate) without importing canvas React components. */
export interface ChainTargetInfo {
  kind: CanvasNodeKind;
  /** Only meaningful when `kind === 'mission'` — a loop's target check uses
   *  `kind === 'loop'` directly, never a mission status. */
  missionStatus?: MissionStatus;
}

export type ChainValidationResult = { ok: true } | { ok: false; reasonKey: string };

const OK: ChainValidationResult = { ok: true };

function reject(reasonKey: string): ChainValidationResult {
  return { ok: false, reasonKey };
}

/**
 * Walks `chains` (every existing edge, disabled or not — a disabled chain
 * is still a structural edge that could be re-enabled later, so cycles
 * through it are rejected too) from `from`, returning true if `target` is
 * reachable. Used to detect that adding `source -> target` would close a
 * cycle: that is true exactly when `target` can already reach `source`.
 */
function canReach(chains: readonly Chain[], from: NodeRef, target: NodeRef): boolean {
  const adjacency = new Map<NodeRef, NodeRef[]>();
  for (const chain of chains) {
    const list = adjacency.get(chain.sourceRef) ?? [];
    list.push(chain.targetRef);
    adjacency.set(chain.sourceRef, list);
  }

  const visited = new Set<NodeRef>();
  const stack: NodeRef[] = [from];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) stack.push(next);
  }
  return false;
}

/**
 * Validates a candidate `sourceRef -> targetRef` chain against the spec's
 * rules (§7 "Loop × chain", §5 "Cycles rejected"):
 *   - no self-chain (source === target)
 *   - a chain INTO a loop node is rejected ("loops self-schedule")
 *   - the target must be a draft, a router (W8c — chains into/out of a
 *     router are legal, including router-into-router within the normal
 *     cascade-depth guard sgrChainRunner.ts's fireChain enforces at fire
 *     time, via canvasChainOps.ts's computeCascadeDepth), a join (W-JOIN —
 *     same rule: a join is a legal chain source AND target, including
 *     join-into-join, within the same cascade-depth guard), or
 *     a mission whose status is 'queued' (spec §5: "hovering mid-drag
 *     highlights valid targets (Draft or queued mission; running/done
 *     targets rejected")
 *   - the new edge must not close a cycle with any existing chain
 *
 * `sourceRef` needs no router-specific check here: a router BRANCH source ref
 * (`router:<routerId>:<branchId>`, see canvasTypes.ts's
 * `parseRouterBranchRef`) is structurally just another `NodeRef` string as
 * far as `canReach`'s graph walk is concerned — the branch encoding is
 * transparent to cycle detection.
 */
export function validateChain(
  chains: readonly Chain[],
  sourceRef: NodeRef,
  targetRef: NodeRef,
  targetInfo: ChainTargetInfo,
): ChainValidationResult {
  if (sourceRef === targetRef) {
    return reject('canvas.chain.selfChain');
  }

  if (targetInfo.kind === 'loop') {
    return reject('canvas.chain.intoLoop');
  }

  if (targetInfo.kind === 'draft' || targetInfo.kind === 'router' || targetInfo.kind === 'join') {
    // fallthrough to the cycle check below — a draft/router/join target is
    // otherwise always a legal chain target.
  } else if (targetInfo.kind === 'mission') {
    if (targetInfo.missionStatus !== 'queued') {
      return reject('canvas.chain.invalidTarget');
    }
  } else {
    return reject('canvas.chain.invalidTarget');
  }

  // Adding source -> target closes a cycle exactly when target can already
  // reach source through the existing chain graph.
  if (canReach(chains, targetRef, sourceRef)) {
    return reject('canvas.chain.wouldCycle');
  }

  return OK;
}

// ── Join (fan-in) validation (W-JOIN) ──────────────────────────────────
//
// A join's fan-in links (`sourceRef -> join`) are NOT `Chain` objects —
// they live in `JoinSpec.sourceRefs` (canvasStore's `addChain` choke point
// keeps the two in sync, see its own doc comment) — so a cycle through a
// join's OWN sourceRefs is invisible to `canReach`'s `chains`-only walk
// above. `validateJoinSources` below extends that same walk with one
// synthetic edge per `(source, join)` pair so a join can never be wired
// into a cycle either directly (chains) or through its fan-in list.

/** Hard floor for a join to be meaningful (canvasTypes.ts's
 *  `MIN_JOIN_SOURCES` doc comment — re-exported here so every caller of
 *  join validation imports from ONE module). */
export { MIN_JOIN_SOURCES };

/** Minimal shape this module needs from a live/candidate join — kept
 *  narrower than the full `JoinSpec` so a not-yet-created join (validating
 *  BEFORE `addJoin`) can be checked with just an id + proposed sources. */
export interface JoinSourcesCandidate {
  id: string;
  sourceRefs: readonly NodeRef[];
}

/**
 * Validates a candidate set of fan-in sources for join `joinId` (either a
 * brand-new join being created with these sources, or an existing join
 * gaining one more): rejects fewer than {@link MIN_JOIN_SOURCES}, a
 * self-reference, and any source that can already reach this join through
 * the combined chain graph PLUS every OTHER join's own sourceRefs (the
 * synthetic edges this function adds) — i.e. wiring this source would close
 * a fan-in cycle even though no single `Chain` object embodies it.
 */
export function validateJoinSources(
  chains: readonly Chain[],
  joins: readonly JoinSourcesCandidate[],
  joinId: string,
  sourceRefs: readonly NodeRef[],
): ChainValidationResult {
  if (sourceRefs.length < MIN_JOIN_SOURCES) {
    return reject('canvas.join.tooFewSources');
  }

  const joinRef = makeRef('join', joinId);
  const adjacency = new Map<NodeRef, NodeRef[]>();
  for (const chain of chains) {
    const list = adjacency.get(chain.sourceRef) ?? [];
    list.push(chain.targetRef);
    adjacency.set(chain.sourceRef, list);
  }
  for (const join of joins) {
    if (join.id === joinId) continue; // this join's OWN prior sources are superseded by the candidate list being validated
    const targetRef = makeRef('join', join.id);
    for (const ref of join.sourceRefs) {
      const list = adjacency.get(ref) ?? [];
      list.push(targetRef);
      adjacency.set(ref, list);
    }
  }

  // Adding `ref -> joinRef` (ref is a NEW fan-in source) closes a cycle
  // exactly when `joinRef` can ALREADY reach `ref` walking FORWARD through
  // the combined graph (ref -> joinRef -> ... -> ref) — same "walk from the
  // proposed TARGET looking for the proposed SOURCE" direction validateChain's
  // own `canReach` above uses, just starting from `joinRef` instead of an
  // explicit targetRef parameter.
  function joinCanReach(target: NodeRef): boolean {
    const visited = new Set<NodeRef>();
    const stack: NodeRef[] = [joinRef];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === target) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const next of adjacency.get(current) ?? []) stack.push(next);
    }
    return false;
  }

  for (const ref of sourceRefs) {
    if (ref === joinRef) return reject('canvas.chain.selfChain');
    if (joinCanReach(ref)) return reject('canvas.chain.wouldCycle');
  }

  return OK;
}
