/* usePersonalKpis — the Solo view's 4 right-rail KPI tiles, all sourced
   from REAL, already-wired data (no team/org required):

     1. agentsActive     — missions currently supervised (fleet-wide,
                            stage !== 'merged'), via useFleetMissions (D3).
     2. mergedThisWeek    — mission.approved journal events in the last 7
                            days (fleet-wide, no project filter).
     3. creditsRemaining — the signed-in user's own Pro credit balance
                            (useSubscriptionContext — same source as
                            AccountChip).
     4. brainNeurons     — node count of the currently active brain
                            (getPlatform().brain.graph(), same call as
                            HomeHealthCard).

   Every source degrades to 0/honest-empty on web or on any failure — no
   fabricated numbers. Tauri-only sources (fleet missions, brain graph) are
   already fail-soft in their own modules (see fleetMissions.ts, platform/*.ts).
*/

import { useEffect, useState } from 'react';
import { useFleetMissions } from '../agents/fleetMissions.js';
import { journalQuery } from '../journal/journal.js';
import { getPlatform } from '../platform/index.js';
import { useSubscriptionContext } from '../billing/index.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface PersonalKpis {
  agentsActive: number;
  mergedThisWeek: number;
  creditsRemaining: number | null;
  brainNeurons: number;
  loading: boolean;
}

export function usePersonalKpis(): PersonalKpis {
  const { projects } = useFleetMissions();
  const { subscription, isPro } = useSubscriptionContext();

  const [mergedThisWeek, setMergedThisWeek] = useState(0);
  const [brainNeurons, setBrainNeurons] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      journalQuery({ types: ['mission.approved'], sinceMs: Date.now() - WEEK_MS }),
      getPlatform().brain.graph().catch(() => ({ nodes: [] })),
    ]).then(([mergedEvents, graph]) => {
      if (cancelled) return;
      setMergedThisWeek(mergedEvents.length);
      setBrainNeurons(graph.nodes.length);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const agentsActive = projects
    .flatMap((p) => p.missions)
    .filter((m) => m.stage !== 'merged').length;

  const creditsRemaining = isPro && subscription ? subscription.credits_remaining_cents : null;

  return { agentsActive, mergedThisWeek, creditsRemaining, brainNeurons, loading };
}
