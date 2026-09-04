/* MissionCharterCard — the mission charter (SPEC-CHARTE-DE-MISSION.md §1,
   lib/agents/types.ts's MissionCharter/propose_mission_charter): five
   blocks (objective, nature, decisions, validation gates, learning +
   kill-switch), each modifiable or disable-able directly in the card, plus
   one global validation. Same visual family as GraphProposalCard.tsx (this
   folder): bordered card, plain-language labels, real buttons; same
   expand/shrink-overlay behavior while pending.

   Edits to objective/nature/cadence/gates/learning stay LOCAL until
   "Valider" is clicked (same pattern GraphProposalCard uses for its step
   checkboxes) — only the final, possibly-edited charter is sent. Decisions
   (block 3) are the one exception: each answers immediately on click,
   independent of the global Validate button — see DecisionCard.tsx's doc
   comment and spec §2 ("un clic repond ... comme si l'utilisateur avait
   tape la reponse").

   Nothing here names a network, a content format, or a use case — every
   label is either a fixed i18n string (block titles, gate names) or a
   free-form value the manager supplied (objective, cadence, decision
   text, gate items, learning fields).

   BUG FIX (real founder feedback, 2026-07-28 test session: the card stayed
   "EN ATTENTE DE VALIDATION" after Validate and could be validated in a
   loop) — see `localResolution` below for the local-optimistic-resolution
   fix and its own doc comment for the root cause.

   SILENT-FALSE-POSITIVE FIX (real user test, 2026-07-28, round 2 — see
   useManagerActionQueue.ts's own doc comment for the full repro: a queued
   Validate click used to promote straight to "ACCEPTÉE" on the mere fact
   that the queue drained, even when the send never actually reached the
   manager): `isActionFailed`/`isDecisionFailed` are the real-result-based
   counterpart to `isActionQueued`/`isDecisionQueued` below — see
   `localResolution`'s reset effect for how the card reacts to a confirmed
   failure. */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { emit, _debugLogOverlayWidth } from '../../lib/bus';
import { DecisionCard } from './DecisionCard';
import type { CharterProposal, MissionCharter, MissionNature } from './missionCharter';
import type { ActionDispatchOutcome } from './useManagerActionQueue';

export interface MissionCharterCardProps {
  charterProposal: CharterProposal;
  onAnswerDecision: (option: string, index: number) => ActionDispatchOutcome | void;
  /** `answeredDecisions` (decision index → exact answer text) lets the
   *  caller restate every settled decision in the message the manager
   *  receives on Validate — see missionCharter.ts's
   *  formatCharterValidationMessage doc comment for the real repro (the
   *  manager re-asking an already-answered decision right after
   *  validation) this closes. */
  onValidate: (charter: MissionCharter, answeredDecisions: Record<number, string>) => ActionDispatchOutcome | void;
  onModify?: () => void;
  onReject: () => ActionDispatchOutcome | void;
  /** NEVER DEGRADE IN SILENCE (real founder feedback, 2026-07-28 — see
   *  useManagerActionQueue.ts's own doc comment for the full repro): true
   *  while THIS card's own Validate/Reject click has been queued (the
   *  manager was busy at click time) but not yet actually sent. The card
   *  must never show a final "Accepted"/"Rejected" state while this holds —
   *  only once it flips back to false (the queued send actually went out)
   *  does `localResolution` below take over. Optional, defaulting to false
   *  so every pre-existing caller/test that predates the queue keeps
   *  behaving exactly as before (immediate resolution on click). */
  isActionQueued?: boolean;
  /** Same contract as `isActionQueued`, per embedded decision (block 3) —
   *  see DecisionCard.tsx's own `isQueued` prop. */
  isDecisionQueued?: (index: number) => boolean;
  /** NEVER DEGRADE IN SILENCE, round 2 (real user test, 2026-07-28 — see
   *  useManagerActionQueue.ts's own doc comment for the full repro): true
   *  once THIS card's own Validate/Reject click has settled and its real
   *  result says it did NOT reach the manager (queue drained but the send
   *  was refused/threw). The card must revert to fully actionable and show
   *  why — never keep showing a resolved state it cannot back up. Optional,
   *  defaulting to false so every pre-existing caller/test keeps behaving
   *  exactly as before (no failure ever reported). */
  isActionFailed?: boolean;
  /** Same contract as `isActionFailed`, per embedded decision (block 3) —
   *  see DecisionCard.tsx's own `isFailed` prop. */
  isDecisionFailed?: (index: number) => boolean;
}

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 700, color: 'var(--color-text-disabled)',
  textTransform: 'uppercase', letterSpacing: '0.05em',
};

const textInputStyle: React.CSSProperties = {
  fontSize: 12, fontFamily: 'inherit', padding: '4px 8px', borderRadius: 6,
  border: '1px solid var(--color-border-2)', background: 'var(--color-panel)',
  color: 'var(--color-text-secondary)', width: '100%',
};

const segmentButtonStyle = (active: boolean): React.CSSProperties => ({
  padding: '4px 10px', fontSize: 11, fontWeight: 700, borderRadius: 7,
  fontFamily: 'inherit', cursor: 'pointer',
  border: active ? '1px solid var(--color-accent-border, rgba(124,92,255,0.5))' : '1px solid var(--color-border-2)',
  background: active ? 'rgba(124,92,255,0.18)' : 'transparent',
  color: active ? 'var(--color-accent-pale)' : 'var(--color-text-muted)',
});

const ghostButtonStyle: React.CSSProperties = {
  border: 'none', background: 'transparent', color: 'var(--color-text-disabled)',
  cursor: 'pointer', fontSize: 11, padding: '2px 4px', fontFamily: 'inherit',
};

const DEFAULT_SUPERVISE_COUNT = 3;

export function MissionCharterCard({
  charterProposal,
  onAnswerDecision,
  onValidate,
  onModify,
  onReject,
  isActionQueued = false,
  isDecisionQueued,
  isActionFailed = false,
  isDecisionFailed,
}: MissionCharterCardProps) {
  const { t } = useI18n();
  const { charter } = charterProposal;
  // Bug fix (real founder feedback, 2026-07-28: after clicking Validate the
  // card kept showing "EN ATTENTE DE VALIDATION" and could be validated in a
  // loop) — root cause: there is no dedicated store method yet that flips
  // `charterProposal.state` (see missionCharter.ts's own INTEGRATION GAP doc
  // comment: Validate/Reject go through the plain `store.send(text)`
  // primitive, which never touches this PROP), so the prop itself stays
  // 'pending' forever regardless of how many times the user clicks. Same
  // local-optimistic-resolution convention as DecisionCard.tsx's `resolved`/
  // PendingApprovalCard.tsx's `decisions` — the card's own state must never
  // stay actionable after the user has already acted, independent of
  // whether a future backend round-trip ever confirms it. `null` means "no
  // local decision yet, defer to the prop" so a genuinely fresh charter
  // proposal (a new message, hence a new mounted instance — see
  // LazyManagerMessageList.tsx's `key={msg.id}`) still starts pending.
  //
  // SILENT-DROP FIX (real founder feedback, 2026-07-28 test session — see
  // useManagerActionQueue.ts's own doc comment): `localResolution` alone
  // used to be enough, because Validate/Reject always called `onValidate`/
  // `onReject` synchronously. Now that a click made while the manager is
  // busy is QUEUED instead of sent immediately, `localResolution` records
  // WHAT the user chose, but `effectiveState` below only shows it once
  // `isActionQueued` confirms it actually went out — while queued, it shows
  // an explicit "queued" state instead, recomputed on every render (no
  // separate transition effect needed: the instant the prop flips to false,
  // the very next render already shows the final state).
  const [localResolution, setLocalResolution] = useState<'accepted' | 'rejected' | null>(null);
  const effectiveState: CharterProposal['state'] | 'queued' = localResolution
    ? (isActionQueued ? 'queued' : localResolution)
    : charterProposal.state;
  const isPending = effectiveState === 'pending';

  // SILENT-FALSE-POSITIVE FIX (real user test, 2026-07-28, round 2 — see
  // useManagerActionQueue.ts's own doc comment for the full repro): once the
  // queue confirms the send never actually reached the manager, the local
  // optimistic resolution above must be walked back — `charterProposal.state`
  // itself never flips (see the SILENT-DROP FIX comment above), so clearing
  // `localResolution` alone is enough to fall through to 'pending' again,
  // re-arming the Validate/Reject buttons. `useLayoutEffect` (not
  // `useEffect`) so this correction commits BEFORE paint — a plain effect
  // would let the browser paint one frame of the false "Accepted" state
  // first, which is exactly the "jamais de faux positif" this closes.
  useLayoutEffect(() => {
    if (isActionFailed && localResolution !== null) setLocalResolution(null);
  }, [isActionFailed]);

  const [objective, setObjective] = useState(charter.objective);
  const [editingObjective, setEditingObjective] = useState(false);
  const [nature, setNature] = useState<MissionCharter['nature']>(charter.nature);
  const [frozenOnceEnabled, setFrozenOnceEnabled] = useState(charter.validationGates.frozenOnce.length > 0);
  const [supervisedEnabled, setSupervisedEnabled] = useState(!!charter.validationGates.superviseFirstN);
  const [supervisedCount, setSupervisedCount] = useState(charter.validationGates.superviseFirstN ?? DEFAULT_SUPERVISE_COUNT);
  const [learning, setLearning] = useState(charter.learning);
  const [editingLearning, setEditingLearning] = useState(false);
  // Decision index -> exact answer text (preset option or free-text) —
  // recorded here (not just inside each DecisionCard's own local state) so
  // Validate can restate every settled decision in the message the manager
  // receives. See MissionCharterCardProps.onValidate's doc comment and
  // missionCharter.ts's formatCharterValidationMessage for the real repro.
  const [answeredDecisions, setAnsweredDecisions] = useState<Record<number, string>>({});

  // 2026-08 fifth verification pass (GraphProposalCard.tsx/ManagerOverlay.tsx
  // own headers, auto-expand investigation) — the SAME expand/shrink signal
  // GraphProposalCard emits, and the SAME stale-mount risk fixed there: a
  // charter card mounting FRESH already resolved (e.g. a conversation
  // switch revealing older history) must not fire a spurious shrink that
  // could race and win over a genuinely pending proposal elsewhere in the
  // same render pass — see GraphProposalCard.tsx's own `hasEmittedOnceRef`
  // doc comment for the full reasoning, mirrored here verbatim.
  const hasEmittedOnceRef = useRef(false);
  useEffect(() => {
    const isFirstRenderOfThisInstance = !hasEmittedOnceRef.current;
    hasEmittedOnceRef.current = true;
    const skippedAsStale = isFirstRenderOfThisInstance && !isPending;
    _debugLogOverlayWidth('MissionCharterCard emit', {
      charterProposalState: charterProposal.state,
      effectiveState,
      isFirstRenderOfThisInstance,
      skippedAsStale,
      event: isPending ? 'manager:expandOverlay' : 'manager:shrinkOverlay',
    });
    if (skippedAsStale) return;
    emit(isPending ? 'manager:expandOverlay' : 'manager:shrinkOverlay', undefined);
  }, [isPending]);

  // Records the answer locally AND forwards it to the caller — still sent
  // as its own turn (LazyManager.tsx's handleAnswerDecision), now via the
  // action queue (see useManagerActionQueue.ts), so a click made while the
  // manager is busy is queued rather than dropped. `outcome` is forwarded
  // unchanged so each DecisionCard can show its own queued-vs-resolved
  // state (see its own `isQueued` prop).
  function handleAnswerDecision(option: string, index: number): ActionDispatchOutcome | void {
    setAnsweredDecisions((prev) => ({ ...prev, [index]: option }));
    return onAnswerDecision(option, index);
  }

  const stateLabel = isPending
    ? t('lazyManager.charter.pending')
    : effectiveState === 'queued'
      ? t('lazyManager.charter.queued')
      : effectiveState === 'accepted'
        ? t('lazyManager.charter.accepted')
        : t('lazyManager.charter.rejected');
  const stateColor = isPending
    ? 'var(--color-warning)'
    : effectiveState === 'queued'
      ? 'var(--color-warning)'
      : effectiveState === 'accepted'
        ? 'var(--color-success, #22c55e)'
        : 'var(--color-danger, #dc2626)';

  function switchNatureKind(kind: MissionNature) {
    setNature(kind === 'recurring' ? { kind, cadence: nature.cadence } : { kind });
  }

  function handleValidate() {
    const outcome = onValidate(
      {
        objective,
        nature,
        decisions: charter.decisions,
        validationGates: {
          frozenOnce: frozenOnceEnabled ? charter.validationGates.frozenOnce : [],
          superviseFirstN: supervisedEnabled ? supervisedCount : undefined,
        },
        learning,
      },
      answeredDecisions,
    );
    if (outcome === 'idle') return; // could not be taken in charge — stay actionable
    setLocalResolution('accepted');
  }

  function handleReject() {
    const outcome = onReject();
    if (outcome === 'idle') return; // could not be taken in charge — stay actionable
    setLocalResolution('rejected');
  }

  return (
    <div
      data-testid="mission-charter-card"
      style={{
        marginTop: 10, borderRadius: 10, border: '1px solid var(--color-border-2)',
        background: 'rgba(124,92,255,0.06)', padding: '12px 14px',
        display: 'flex', flexDirection: 'column', gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text-secondary)' }}>
          {t('lazyManager.charter.title')}
        </span>
        <span data-testid="mission-charter-state" style={{ fontSize: 10, fontWeight: 600, color: stateColor, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {stateLabel}
        </span>
      </div>

      {/* Block 1: Objective */}
      <div data-testid="mission-charter-block-objective" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={sectionLabelStyle}>{t('lazyManager.charter.objective')}</span>
          {isPending && !editingObjective && (
            <button type="button" data-testid="mission-charter-edit-objective" style={ghostButtonStyle} onClick={() => setEditingObjective(true)}>
              {t('lazyManager.charter.editBlock')}
            </button>
          )}
        </div>
        {editingObjective ? (
          <input
            data-testid="mission-charter-objective-input"
            style={textInputStyle}
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            onBlur={() => setEditingObjective(false)}
            autoFocus
          />
        ) : (
          <span style={{ fontSize: 12.5, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>{objective}</span>
        )}
      </div>

      {/* Block 2: Nature */}
      <div data-testid="mission-charter-block-nature" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={sectionLabelStyle}>{t('lazyManager.charter.nature.label')}</span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {(['unique', 'recurring', 'permanent'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              data-testid={`mission-charter-nature-${kind}`}
              disabled={!isPending}
              style={segmentButtonStyle(nature.kind === kind)}
              onClick={() => switchNatureKind(kind)}
            >
              {t(`lazyManager.charter.nature.${kind}`)}
            </button>
          ))}
          {nature.kind === 'recurring' && (
            // Free-form cadence (real founder feedback on the sibling
            // decision options — same "options aren't a constraint" spirit):
            // this already accepted any string (LoopCadence is a literal
            // union widened by `| (string & {})`, and this input has always
            // been type="text"), but a fixed 160px width and a numeric-only
            // placeholder example both read as "short code only". flex-basis
            // lets it grow to fit a full sentence like "2 par semaine,
            // jamais le week-end" instead of clipping it.
            <input
              data-testid="mission-charter-cadence-input"
              style={{ ...textInputStyle, flex: '1 1 220px', minWidth: 160, width: 'auto' }}
              placeholder={t('lazyManager.charter.nature.cadencePlaceholder')}
              value={nature.cadence ?? ''}
              disabled={!isPending}
              onChange={(e) => setNature({ kind: 'recurring', cadence: e.target.value })}
            />
          )}
        </div>
      </div>

      {/* Block 3: Decisions */}
      {charter.decisions.length > 0 && (
        <div data-testid="mission-charter-block-decisions" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={sectionLabelStyle}>{t('lazyManager.charter.decisions')}</span>
          {charter.decisions.map((decision, i) => (
            <DecisionCard
              key={i}
              decision={decision}
              index={i}
              onAnswer={handleAnswerDecision}
              isQueued={isDecisionQueued?.(i) ?? false}
              isFailed={isDecisionFailed?.(i) ?? false}
            />
          ))}
        </div>
      )}

      {/* Block 4: Validation gates */}
      <div data-testid="mission-charter-block-gates" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={sectionLabelStyle}>{t('lazyManager.charter.gates.label')}</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--color-text-secondary)' }}>
          <input
            type="checkbox"
            data-testid="mission-charter-gate-frozen-toggle"
            checked={frozenOnceEnabled}
            disabled={!isPending}
            onChange={(e) => setFrozenOnceEnabled(e.target.checked)}
          />
          {t('lazyManager.charter.gates.frozenOnce')}
          {charter.validationGates.frozenOnce.length > 0 && (
            <span style={{ color: 'var(--color-text-disabled)', fontSize: 11 }}>
              ({charter.validationGates.frozenOnce.join(', ')})
            </span>
          )}
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--color-text-secondary)' }}>
          <input
            type="checkbox"
            data-testid="mission-charter-gate-supervised-toggle"
            checked={supervisedEnabled}
            disabled={!isPending}
            onChange={(e) => setSupervisedEnabled(e.target.checked)}
          />
          {t('lazyManager.charter.gates.supervisedFirstN')}
          <input
            type="number"
            min={1}
            data-testid="mission-charter-gate-supervised-count"
            style={{ ...textInputStyle, width: 50, padding: '2px 6px' }}
            value={supervisedCount}
            disabled={!isPending || !supervisedEnabled}
            onChange={(e) => setSupervisedCount(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
        <span style={{ fontSize: 11, color: 'var(--color-text-disabled)' }}>{t('lazyManager.charter.gates.thenFree')}</span>
      </div>

      {/* Block 5: Learning + kill-switch */}
      <div data-testid="mission-charter-block-learning" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={sectionLabelStyle}>{t('lazyManager.charter.learning.label')}</span>
          {isPending && !editingLearning && (
            <button type="button" data-testid="mission-charter-edit-learning" style={ghostButtonStyle} onClick={() => setEditingLearning(true)}>
              {t('lazyManager.charter.editBlock')}
            </button>
          )}
        </div>
        {editingLearning ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <input style={textInputStyle} value={learning.measure} placeholder={t('lazyManager.charter.learning.measure')} onChange={(e) => setLearning({ ...learning, measure: e.target.value })} />
            <input style={textInputStyle} value={learning.measureSource} placeholder={t('lazyManager.charter.learning.measureSource')} onChange={(e) => setLearning({ ...learning, measureSource: e.target.value })} />
            <input style={textInputStyle} value={learning.influences} placeholder={t('lazyManager.charter.learning.influences')} onChange={(e) => setLearning({ ...learning, influences: e.target.value })} />
            <input style={textInputStyle} value={learning.killSwitch} placeholder={t('lazyManager.charter.learning.killSwitch')} onChange={(e) => setLearning({ ...learning, killSwitch: e.target.value })} />
            <button type="button" style={ghostButtonStyle} onClick={() => setEditingLearning(false)}>{t('lazyManager.charter.doneEditing')}</button>
          </div>
        ) : (
          <div style={{ fontSize: 11.5, color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
            <div>{t('lazyManager.charter.learning.measure')}: {learning.measure}</div>
            <div>{t('lazyManager.charter.learning.measureSource')}: {learning.measureSource}</div>
            <div>{t('lazyManager.charter.learning.influences')}: {learning.influences}</div>
            <div>{t('lazyManager.charter.learning.killSwitch')}: {learning.killSwitch}</div>
          </div>
        )}
      </div>

      {/* SILENT-FALSE-POSITIVE FIX (real user test, 2026-07-28, round 2 —
          see useManagerActionQueue.ts's own doc comment): shown only once
          isPending is true again (i.e. after the useLayoutEffect above has
          already walked back the false "Accepted") — the user must see WHY
          the buttons reappeared, never just a silent re-arm. Stays visible
          until the next Validate/Reject attempt actually clears it (a fresh
          dispatch resets useManagerActionQueue's own isFailed(key)). */}
      {isPending && isActionFailed && (
        <div
          data-testid="mission-charter-send-error"
          style={{ fontSize: 11, color: 'var(--color-danger, #dc2626)', lineHeight: 1.4 }}
        >
          {t('lazyManager.charter.sendFailed')}
        </div>
      )}

      {/* Global validation */}
      {isPending && (
        <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
          <button
            type="button"
            data-testid="mission-charter-validate"
            onClick={handleValidate}
            style={{
              padding: '6px 14px', fontSize: 12, fontWeight: 700, borderRadius: 8,
              border: '1px solid var(--color-accent-border, rgba(124,92,255,0.4))',
              background: 'rgba(124,92,255,0.18)', color: 'var(--color-accent-pale)',
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            {t('lazyManager.charter.validate')}
          </button>
          <button
            type="button"
            data-testid="mission-charter-modify"
            onClick={() => (onModify ? onModify() : emit('manager:shrinkOverlay', undefined))}
            style={{
              padding: '6px 14px', fontSize: 12, fontWeight: 700, borderRadius: 8,
              border: '1px solid var(--color-border-2)', background: 'transparent',
              color: 'var(--color-text-muted)', cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            {t('lazyManager.charter.modify')}
          </button>
          <button
            type="button"
            data-testid="mission-charter-reject"
            onClick={handleReject}
            style={{
              padding: '6px 14px', fontSize: 12, fontWeight: 700, borderRadius: 8,
              border: '1px solid var(--color-border-2)', background: 'transparent',
              color: 'var(--color-text-muted)', cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            {t('lazyManager.charter.reject')}
          </button>
        </div>
      )}
    </div>
  );
}
