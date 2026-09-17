/* BrainEnrichmentPrompt — the deferred "you now have a real rail" toast.

   The onboarding brain step always offers "Faire plus tard" and always
   allows a heuristic-only seed, so a first-run user can end up with a
   heuristically-built (or never-built) brain while no LLM rail existed.
   When a rail LATER becomes available — Claude CLI connected, a BYOK key
   added, LazyPro activated, an account signed in — this component surfaces
   a one-shot toast deep-linking to Settings → Memory's history reimport,
   which now exposes the same rail picker.

   Firing rules (all enforced by seedExtractor.ts's flag helpers):
     - a past seed ran heuristic-only, OR the user deferred it;
     - at least one rail exists NOW that did not exist at seed/defer time
       (a genuinely new entitlement — never re-nags about already-seen ones);
     - once per app session at most; each rail gets ONE toast ever —
       markEnrichmentOffered folds shown rails into the snapshot so the
       same entitlement set can never re-trigger.

   Mounted once in AppShell next to OnboardingModal; renders nothing itself.
*/

import { useEffect } from 'react';
import { useAppContext } from '../../app/AppContext';
import { useI18n } from '../../i18n';
import { useToast } from '../ui';
import {
  clearHeuristicSeedFlag,
  listSeedRails,
  markEnrichmentOffered,
  shouldOfferEnrichment,
} from '../../lib/brain/seedExtractor';
import { subscribeSeedProgress } from '../../lib/brain/seedProgressStore';

/** Once-per-session guard — re-checked on window focus and on every seed
    completion, but the toast itself is only raised once no matter how many
    triggers fire. */
let shownThisSession = false;

export function BrainEnrichmentPrompt() {
  const { toast } = useToast();
  const { t } = useI18n();
  const { setActiveSpace } = useAppContext();

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      const kind = await shouldOfferEnrichment();
      if (cancelled || shownThisSession || !kind) return;
      shownThisSession = true;
      // Persist that these rails were offered — without this the toast
      // would re-fire every session for the same "new" rail the user
      // already saw and ignored.
      void listSeedRails()
        .then((rails) => markEnrichmentOffered(rails.map((r) => r.id)))
        .catch(() => {});
      toast(
        t(kind === 'deferred' ? 'brain.enrich.offerDeferred' : 'brain.enrich.offerHeuristic'),
        'info',
        15000,
        {
          label: t('brain.enrich.openSettings'),
          onClick: () => {
            clearHeuristicSeedFlag();
            // MemoryPanel's HistoryReimportSection lives on the 'memory'
            // settings tab — the deep-link keeps the toast actionable in
            // one click.
            setActiveSpace('settings', 'memory');
          },
        },
      );
    };

    void check();
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    const unsub = subscribeSeedProgress((s) => {
      if (!s.active && s.result) void check();
    });
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      unsub();
    };
  }, [toast, t, setActiveSpace]);

  return null;
}
