/* BrainContextBanner — shows injected brain context + savings.
   Calls platform.brain.recallScoped() for real citations.
   No mock data — if brain is unavailable, shows empty state.

   Also surfaces capture-retry give-up notices (FIX 1b): capture.ts's
   captureQueue.ts is a plain module with no React context, so it cannot
   call useToast() itself. It exposes onCaptureGiveUp(), a tiny module-level
   subscription (same pub-sub shape as lib/models/costStore.ts's
   subscribeCost()) that this component drains via useEffect and turns into
   a toast — the only user-facing signal that a note failed to save after
   every retry was exhausted. This is a live subscription, not a replay
   log: a give-up while this banner happens not to be mounted still logs
   via console.warn but produces no toast (known limitation — see
   captureQueue.ts's onCaptureGiveUp doc comment).
*/

import { useEffect, useState } from 'react';
import type React from 'react';
import type { Brain, BrainRecallResult, BrainSearchResult } from '../../lib/platform/types';
import type { BrainInfo } from '../../lib/platform/tauri';
import { emit } from '../../lib/bus';
import { getPlatform } from '../../lib/platform';
import { onCaptureGiveUp } from '../../lib/brain/captureQueue';
import { basename } from '../../lib/paths';
import { useToast } from '../ui/Toast';
import { useI18n } from '../../i18n';

// Used when recall returns null (no neurons found / brain not ready).
const EMPTY_RECALL: BrainRecallResult = {
  nodes: [],
  tokensSaved: 0,
  tokensInjected: 0,
  injectedContext: '',
};

// ── Env-override notice dismissal ────────────────────────────────
//
// The env-override notice (below) used to render on EVERY chat turn with no
// way to dismiss it — the same fact is already permanently visible in
// Settings > Memory (BrainPathSection's envOverrideWarning callout), so
// repeating it forever in the chat banner too is just noise once the user
// has seen it. Persisted in localStorage (same try/catch-guarded idiom as
// GettingStarted.tsx's readDismissed/writeDismissed) so the dismissal
// survives across sessions, not just this mount.

const ENV_OVERRIDE_NOTICE_DISMISSED_KEY = 'lazy.brain.envOverrideNoticeDismissed';

function readEnvOverrideNoticeDismissed(): boolean {
  try {
    return localStorage.getItem(ENV_OVERRIDE_NOTICE_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeEnvOverrideNoticeDismissed(): void {
  try {
    localStorage.setItem(ENV_OVERRIDE_NOTICE_DISMISSED_KEY, '1');
  } catch {
    // localStorage unavailable — silently ignore.
  }
}

// ── CitationChip ──────────────────────────────────────────────────

interface CitationChipProps {
  node: BrainSearchResult;
  onClick: (id: string) => void;
  onKeyDown: (e: React.KeyboardEvent, id: string) => void;
}

function CitationChip({ node, onClick, onKeyDown }: CitationChipProps) {
  const projectName = node.sourceProject ? basename(node.sourceProject) : null;

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={() => onClick(node.id)}
      onKeyDown={(e) => onKeyDown(e, node.id)}
      title={node.title ?? (node.sourceProject ? `from ${node.sourceProject}` : node.id)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        background: 'rgba(124,92,255,0.15)',
        border: '1px solid rgba(124,92,255,0.28)',
        borderRadius: 4,
        padding: '1px 6px',
        fontSize: 10,
        color: 'var(--color-accent-light)',
        fontWeight: 500,
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      {'#' + node.id}
      {projectName !== null && (
        <span
          style={{
            fontSize: 9,
            color: 'rgba(199,184,255,0.55)',
            fontWeight: 400,
            background: 'rgba(124,92,255,0.18)',
            borderRadius: 2,
            padding: '0 3px',
            letterSpacing: '0.02em',
          }}
        >
          {projectName}
        </span>
      )}
    </span>
  );
}

// ── Component ─────────────────────────────────────────────────────

interface BrainContextBannerProps {
  recall: BrainRecallResult | null;
  brainError?: string | null;
  brainEnabled?: boolean;
  /** "Réessayer" action — see assistantStore's retryBrain doc comment.
   *  Omitted (no button rendered) for callers that don't wire a retry path. */
  onRetryBrain?: () => void;
}

export function BrainContextBanner({ recall, brainError, brainEnabled = true, onRetryBrain }: BrainContextBannerProps) {
  const { t } = useI18n();
  const { toast } = useToast();

  // Subscribed unconditionally (before the brainEnabled early return below)
  // so capture-failure toasts still fire even while this banner's own
  // recall UI happens to be hidden — Rules of Hooks also require this: a
  // hook after a conditional return would be called on some renders and
  // not others.
  useEffect(() => {
    return onCaptureGiveUp((event) => {
      toast(t('brain.captureFailed', { title: event.title.slice(0, 60) }), 'warning', 6000);
    });
  }, [toast, t]);

  // ENV-OVERRIDE TRANSPARENCY (ambient, chat-side): LAZYBRAIN_BRAIN_PATH
  // silently outranks the opened project everywhere brain path resolution
  // happens (resolve_unified_brain_path) — Settings > Memory already warns
  // about this (BrainPathSection's envOverrideWarning callout), but a user
  // who never opens Settings gets zero signal that every recall in THIS
  // chat is answered from a shared/global brain, not this project's own.
  // Fetched once on mount (same narrow-cast idiom as assistantStore.tsx's
  // fetchBrainIsEmpty; get_brain_info is documented fast/filesystem-only,
  // independent of the sidecar) — the override is a standing per-session
  // fact (set via the shell/user environment), not something that changes
  // turn-to-turn, so a one-time check is enough. Never throws: resolves to
  // `false` on the web platform or any error, same fail-open convention as
  // every other brain:// signal in this component.
  const [envOverrideActive, setEnvOverrideActive] = useState(false);
  useEffect(() => {
    const platform = getPlatform();
    if (platform.name !== 'tauri') return;
    // Defensive: `info()` is intentionally NOT part of the shared `Brain`
    // interface (see tauri.ts's BRAIN-PATH TRANSPARENCY note) — guard for
    // it being absent (e.g. a test double, or a future platform variant)
    // rather than assuming every `platform.brain` has it.
    const brainWithInfo = platform.brain as (Brain & { info?: () => Promise<BrainInfo> }) | undefined;
    if (!brainWithInfo || typeof brainWithInfo.info !== 'function') return;
    let cancelled = false;
    brainWithInfo.info()
      .then((info) => {
        if (!cancelled) setEnvOverrideActive(info.source === 'env_override');
      })
      .catch(() => {
        // brain.info() unavailable — stay silent rather than guess.
      });
    return () => { cancelled = true; };
  }, []);

  // Initialized from localStorage so a dismissal from an earlier session
  // stays hidden — see the "Env-override notice dismissal" section above.
  const [envOverrideNoticeDismissed, setEnvOverrideNoticeDismissed] = useState(readEnvOverrideNoticeDismissed);

  function handleDismissEnvOverrideNotice() {
    writeEnvOverrideNoticeDismissed();
    setEnvOverrideNoticeDismissed(true);
  }

  // When the brain is toggled off, hide the banner entirely — regardless of any
  // recall left over from when it was on. (Previously this only hid on a fresh
  // panel with no prior recall, so toggling off mid-session left a stale banner.)
  if (!brainEnabled) return null;
  const activeRecall = recall ?? EMPTY_RECALL;
  const citationNodes = activeRecall.nodes.slice(0, 5);
  const tokensInjected = activeRecall.tokensInjected ?? 0;
  // RECALL LEVEL HONESTY: undefined when unknown (e.g. cold-CLI fallback,
  // web mock) — omitted rather than guessed. See classifyRecallLevel
  // (lib/brain/context.ts) for how raw LazyBrain level codes map here.
  const levelLabel = activeRecall.level ? t(`brain.level.${activeRecall.level}`) : null;
  // NOTE: do not prepend the label here — the label span below already
  // renders that prefix once; duplicating it here produced "Brain context:
  // Brain context: erreur" in the banner.
  const summaryText = brainError
    ? 'erreur'
    : `${t('assistant.brainContext.summary', {
      nodes: activeRecall.nodes.length.toLocaleString(),
      tokens: tokensInjected.toLocaleString(),
    })}${levelLabel ? ` · ${levelLabel}` : ''}`;
  const tokenText = `~${activeRecall.tokensSaved.toLocaleString()} tokens saved`;

  function handleCitationClick(nodeId: string) {
    emit('nav:focusBrainNode', nodeId);
  }

  function handleCitationKeyDown(e: React.KeyboardEvent, nodeId: string) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      emit('nav:focusBrainNode', nodeId);
    }
  }

  // BRAIN DISCOVERABILITY: routes to the Settings space (reuses the
  // existing 'nav:navigateSpace' bus event AppShell.tsx already handles for
  // the 'settings' space id — no new event type needed). Settings opens on
  // its default "general" tab; the copy in brain.emptyBrainCta tells the
  // user to click "Memory" once there, since navigateSpace's payload is
  // just a space id with no sub-tab.
  function handleConfigureBrainClick() {
    emit('nav:navigateSpace', 'settings');
  }

  return (
    <div
      style={{
        margin: '10px 12px 0',
        background: 'rgba(124,92,255,0.09)',
        border: '1px solid rgba(124,92,255,0.22)',
        borderRadius: 8,
        padding: '9px 11px',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 4,
          gap: 6,
          minWidth: 0,
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: 'rgba(199,184,255,0.9)',
            lineHeight: 1.5,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
            minWidth: 0,
          }}
        >
          <span style={{ fontWeight: 500 }}>{t('assistant.brainContext.label')}</span>{' '}
          {summaryText}
        </div>
      </div>

      {/* ENV-OVERRIDE TRANSPARENCY: reuses Settings > Memory's exact copy
          (settings.memory.brainPath.envOverrideWarning) so the same fact is
          worded identically wherever it appears — this chat banner is the
          ambient, dismissible surface; Settings > Memory keeps showing its
          own copy of this callout permanently regardless of this dismissal
          (see readEnvOverrideNoticeDismissed's doc comment above). */}
      {envOverrideActive && !envOverrideNoticeDismissed && (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 8,
            marginBottom: 6,
          }}
        >
          <div style={{ fontSize: 10, color: 'rgba(255,199,107,0.8)', lineHeight: 1.5, flex: 1, minWidth: 0 }}>
            {t('settings.memory.brainPath.envOverrideWarning')}
          </div>
          <button
            onClick={handleDismissEnvOverrideNotice}
            aria-label={t('common.close')}
            style={{
              background: 'none',
              border: 'none',
              color: 'rgba(255,199,107,0.6)',
              cursor: 'pointer',
              fontSize: 11,
              lineHeight: 1,
              padding: 0,
              flexShrink: 0,
              fontFamily: 'inherit',
            }}
          >
            ✕
          </button>
        </div>
      )}

      {brainError ? (
        <div style={{ marginBottom: 6 }}>
          <div
            style={{
              fontSize: 11,
              color: 'rgba(248,113,113,0.85)',
              fontWeight: 500,
              lineHeight: 1.5,
            }}
          >
            {t('assistant.brainContext.unreachable')} — {brainError}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 8,
              marginTop: 4,
            }}
          >
            <span style={{ fontSize: 10, color: 'rgba(248,113,113,0.6)' }}>
              {t('assistant.brainContext.unreachableHint')}
            </span>
            {onRetryBrain && (
              <button
                onClick={onRetryBrain}
                style={{
                  padding: '3px 8px',
                  background: 'rgba(248,113,113,0.12)',
                  border: '1px solid rgba(248,113,113,0.3)',
                  borderRadius: 5,
                  color: 'rgba(248,113,113,0.95)',
                  fontSize: 10,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {t('assistant.brainContext.retryButton')}
              </button>
            )}
          </div>
        </div>
      ) : activeRecall.tokensSaved > 0 ? (
        // Only shown once savings are revealed (with the finished answer), so the
        // "tokens saved" number never appears before the response.
        <div
          style={{
            fontSize: 11,
            color: 'var(--color-success-alt)',
            fontWeight: 500,
            marginBottom: 6,
          }}
        >
          {tokenText}
        </div>
      ) : null}

      {!brainError && (citationNodes.length === 0 ? (
        activeRecall.emptyBrain ? (
          // BRAIN DISCOVERABILITY: distinct, actionable state — the brain
          // itself has 0 notes (see BrainInfo.isEmpty), not just "nothing
          // relevant to this query". Points the user at where to fix it.
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <span style={{ fontSize: 10, color: 'rgba(255,199,107,0.85)', fontWeight: 500 }}>
              {t('brain.emptyBrainNotice')}
            </span>
            <button
              onClick={handleConfigureBrainClick}
              style={{
                padding: '3px 8px',
                background: 'rgba(255,199,107,0.12)',
                border: '1px solid rgba(255,199,107,0.3)',
                borderRadius: 5,
                color: 'rgba(255,199,107,0.95)',
                fontSize: 10,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {t('brain.emptyBrainCta')}
            </button>
          </div>
        ) : (
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', fontStyle: 'italic' }}>
            {t('assistant.brainContext.empty')}
          </div>
        )
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {citationNodes.map(node => (
            <CitationChip
              key={node.id}
              node={node}
              onClick={handleCitationClick}
              onKeyDown={handleCitationKeyDown}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
