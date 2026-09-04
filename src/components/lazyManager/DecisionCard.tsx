/* DecisionCard — a single clickable decision with a recommendation and its
   reason (SPEC-CHARTE-DE-MISSION.md §2, lib/agents/types.ts's
   DecisionWithRecommendation). Same visual family as GraphProposalCard.tsx
   (this folder): bordered card, plain-language labels. Embedded inside
   MissionCharterCard's decisions block (the charter's block 3 — see that
   type's doc comment: decisions travel only inside a charter, there is no
   separate standalone-decision message field).

   The rationale is always rendered, never behind a disclosure — it is the
   part that carries the value (spec: "c'est elle qui porte la valeur").

   Clicking an option answers the manager exactly as if the user had typed
   that option (spec §2) — see this component's `onAnswer` contract and
   LazyManager.tsx's wiring site. `index` identifies this decision within
   its charter's `decisions` array (DecisionWithRecommendation carries no
   id of its own) — used for the data-testid and forwarded to `onAnswer`
   for any future dedicated store method that needs to address a specific
   decision. Resolution is tracked in local state so the chosen option
   stays visibly marked immediately on click, same defensive convention
   PendingApprovalCard.tsx already uses for its own optimistic state.

   FREE-TEXT ESCAPE HATCH (real founder feedback: "j'ai que 3 choix,
   j'aimerais bien avoir une quatrieme option ou j'ecris ce que je veux") —
   options are always suggestions, never an exhaustive menu. A final entry,
   "Autre — je precise", always renders after the real options (its
   data-testid follows the SAME decision-option-<index>-<j> convention, one
   past the last real option index) and opens a one-line free-text input.
   Submitting it calls `onAnswer` with the typed sentence UNCHANGED — same
   code path as a normal option (`choose()`), so the manager receives it
   exactly as if the user had typed it in the composer (managerEngine.ts's
   new rule: options never get forced back onto the user's real answer).
   Once answered, the free sentence renders through the exact same
   `decision-resolved-<index>` line as any other choice — no separate
   display path to keep in sync. */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type { DecisionWithRecommendation } from './missionCharter';
import type { ActionDispatchOutcome } from './useManagerActionQueue';

export interface DecisionCardProps {
  decision: DecisionWithRecommendation;
  index: number;
  onAnswer: (option: string, index: number) => ActionDispatchOutcome | void;
  /** NEVER DEGRADE IN SILENCE (useManagerActionQueue.ts) — true while this
   *  decision's own answer has been queued (manager busy at click time) but
   *  not yet actually sent. Never shows the final "Chosen: X" line while
   *  this holds — see `resolved` below. Optional, defaulting to false so
   *  every pre-existing caller/test keeps behaving exactly as before. */
  isQueued?: boolean;
  /** NEVER DEGRADE IN SILENCE, round 2 (real user test, 2026-07-28 — see
   *  useManagerActionQueue.ts's own doc comment for the full repro): true
   *  once this decision's own answer has settled and its real result says
   *  it did NOT reach the manager. Reverts `resolved` back to unanswered
   *  (re-arming the option buttons) instead of leaving a false "Chosen: X"
   *  standing. Optional, defaulting to false so every pre-existing caller/
   *  test keeps behaving exactly as before. */
  isFailed?: boolean;
}

const cardStyle: React.CSSProperties = {
  marginTop: 8,
  borderRadius: 9,
  border: '1px solid var(--color-border-2)',
  background: 'rgba(124,92,255,0.04)',
  padding: '10px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const otherOptionButtonStyle: React.CSSProperties = {
  padding: '5px 11px',
  fontSize: 11.5,
  fontWeight: 700,
  borderRadius: 7,
  fontFamily: 'inherit',
  cursor: 'pointer',
  border: '1px dashed var(--color-border-2)',
  background: 'transparent',
  color: 'var(--color-text-muted)',
};

const freeTextInputStyle: React.CSSProperties = {
  flex: '1 1 180px',
  minWidth: 0,
  fontSize: 11.5,
  fontFamily: 'inherit',
  padding: '5px 9px',
  borderRadius: 7,
  border: '1px solid var(--color-accent-border, rgba(124,92,255,0.5))',
  background: 'var(--color-panel)',
  color: 'var(--color-text-secondary)',
};

const freeTextSubmitButtonStyle: React.CSSProperties = {
  padding: '5px 11px',
  fontSize: 11.5,
  fontWeight: 700,
  borderRadius: 7,
  fontFamily: 'inherit',
  cursor: 'pointer',
  border: '1px solid var(--color-accent-border, rgba(124,92,255,0.5))',
  background: 'rgba(124,92,255,0.18)',
  color: 'var(--color-accent-pale)',
  flexShrink: 0,
};

export function DecisionCard({ decision, index, onAnswer, isQueued = false, isFailed = false }: DecisionCardProps) {
  const { t } = useI18n();
  const [resolved, setResolved] = useState<string | undefined>(undefined);
  const [freeTextMode, setFreeTextMode] = useState(false);
  const [freeText, setFreeText] = useState('');
  const freeTextInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (freeTextMode) freeTextInputRef.current?.focus();
  }, [freeTextMode]);

  // SILENT-FALSE-POSITIVE FIX (real user test, 2026-07-28, round 2 — see
  // useManagerActionQueue.ts's own doc comment for the full repro):
  // `useLayoutEffect` (not `useEffect`) so this correction commits BEFORE
  // paint — never a visible frame of the false "Chosen: X" state first.
  useLayoutEffect(() => {
    if (isFailed && resolved !== undefined) setResolved(undefined);
  }, [isFailed]);

  // NEVER DEGRADE IN SILENCE — `onAnswer` now goes through the manager
  // action queue (useManagerActionQueue.ts): 'idle' means the answer could
  // not be taken in charge at all, so the option list must stay actionable
  // instead of falsely marking a choice as resolved.
  function choose(option: string) {
    const outcome = onAnswer(option, index);
    if (outcome === 'idle') return;
    setResolved(option);
  }

  function submitFreeText() {
    const trimmed = freeText.trim();
    if (!trimmed) return;
    choose(trimmed);
    setFreeTextMode(false);
  }

  function cancelFreeText() {
    setFreeTextMode(false);
    setFreeText('');
  }

  return (
    <div data-testid={`decision-card-${index}`} style={cardStyle}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--color-text-secondary)', lineHeight: 1.4 }}>
        {decision.question}
      </div>
      <div
        data-testid={`decision-rationale-${index}`}
        style={{ fontSize: 11.5, color: 'var(--color-accent-pale)', lineHeight: 1.45 }}
      >
        {decision.rationale}
      </div>
      {freeTextMode ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2, alignItems: 'center' }}>
          <input
            ref={freeTextInputRef}
            data-testid={`decision-freetext-input-${index}`}
            type="text"
            value={freeText}
            placeholder={t('lazyManager.decision.otherPlaceholder')}
            onChange={(e) => setFreeText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitFreeText();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelFreeText();
              }
            }}
            style={freeTextInputStyle}
          />
          <button
            type="button"
            data-testid={`decision-freetext-submit-${index}`}
            onClick={submitFreeText}
            style={freeTextSubmitButtonStyle}
          >
            {t('lazyManager.decision.otherSubmit')}
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
          {decision.options.map((option, i) => {
            const isRecommended = option === decision.recommended;
            const isChosen = option === resolved;
            const disabled = resolved !== undefined;
            return (
              <button
                key={i}
                type="button"
                data-testid={`decision-option-${index}-${i}`}
                data-recommended={isRecommended || undefined}
                disabled={disabled}
                onClick={() => choose(option)}
                style={{
                  padding: '5px 11px',
                  fontSize: 11.5,
                  fontWeight: 700,
                  borderRadius: 7,
                  fontFamily: 'inherit',
                  cursor: disabled ? 'default' : 'pointer',
                  border: isChosen
                    ? '1px solid var(--color-success, #22c55e)'
                    : isRecommended
                      ? '1px solid var(--color-accent-border, rgba(124,92,255,0.5))'
                      : '1px solid var(--color-border-2)',
                  background: isChosen
                    ? 'rgba(34,197,94,0.16)'
                    : isRecommended
                      ? 'rgba(124,92,255,0.18)'
                      : 'transparent',
                  color: isChosen
                    ? 'var(--color-success, #22c55e)'
                    : isRecommended
                      ? 'var(--color-accent-pale)'
                      : 'var(--color-text-muted)',
                  opacity: disabled && !isChosen ? 0.5 : 1,
                }}
              >
                {option}
                {isRecommended && !isChosen && ` ★`}
                {isChosen && ` ✓`}
              </button>
            );
          })}
          {/* Free-text escape hatch — always the LAST entry, same
              decision-option-<index>-<j> testid convention as the real
              options above (j = options.length, one past the last real
              index), hidden once resolved just like every other option. */}
          {resolved === undefined && (
            <button
              type="button"
              data-testid={`decision-option-${index}-${decision.options.length}`}
              onClick={() => setFreeTextMode(true)}
              style={otherOptionButtonStyle}
            >
              {t('lazyManager.decision.otherOption')}
            </button>
          )}
        </div>
      )}
      {resolved && (
        <div data-testid={`decision-resolved-${index}`} style={{ fontSize: 10.5, color: isQueued ? 'var(--color-warning)' : 'var(--color-text-disabled)' }}>
          {isQueued ? t('lazyManager.decision.queued', { option: resolved }) : t('lazyManager.decision.resolved', { option: resolved })}
        </div>
      )}
      {/* SILENT-FALSE-POSITIVE FIX (real user test, 2026-07-28, round 2 —
          see useManagerActionQueue.ts's own doc comment): shown once the
          layout effect above has walked back a false "Chosen: X" — the
          user must see WHY the options re-armed, never a silent revert.
          Stays visible until the next click actually clears it (a fresh
          dispatch resets useManagerActionQueue's own isFailed(key)). */}
      {resolved === undefined && isFailed && (
        <div data-testid={`decision-send-error-${index}`} style={{ fontSize: 10.5, color: 'var(--color-danger, #dc2626)' }}>
          {t('lazyManager.decision.sendFailed')}
        </div>
      )}
    </div>
  );
}
