/* FluxFooter — persistent 38px activity ticker (design §9), replacing
   GlobalFeed's standalone page with the same real query (queryActivityFeed),
   polled and rendered as clickable, deduped, honestly-labeled entries.

   Sweep #7 / audit P07 fix: each rendered entry is its own clickable span
   (data-testid="flux-entry-<seq>") rather than one opaque joined string —
   clicking one with a mission id focuses that mission on the canvas via the
   same 'canvas:focus' bus event the manager itself uses (see
   useCanvasManagerEvents.ts's 'canvas:focus' handler and canvasTypes.ts's
   makeRef), so "see agents working" extends to the ticker too. Query limit
   bumped to MAX_FEED_ENTRIES (~50, per the boot-time "show the last ~50 real
   events, no synthetic replay burst" requirement) and entries are deduped
   via buildFeedEntries (see activityFeedFormat.ts's header for the full
   root-cause writeup of the boot-restamp bug this closes the read-side half
   of). */

import { useEffect, useState, useCallback, useMemo } from 'react';
import type { KeyboardEvent } from 'react';
import { useI18n } from '../../../i18n';
import { queryActivityFeed, type ActivityFeedItem } from '../../../lib/journal/projections';
import { buildFeedEntries, MAX_FEED_ENTRIES } from '../../../lib/journal/activityFeedFormat';
import { emit } from '../../../lib/bus';
import { makeRef } from '../canvas/canvasTypes';
import { getSystemPressure, subscribeSystemPressure, type SystemPressureSnapshot } from '../../../lib/agents/systemPressure';
import { SystemPressureBadge } from './SystemPressureBadge';

const POLL_MS = 8_000;

export function FluxFooter() {
  const { t } = useI18n();
  const [items, setItems] = useState<ActivityFeedItem[]>([]);
  // FOUNDER NORTH STAR — adaptation must be TOLD, not silent (see
  // SystemPressureBadge's own doc comment): read directly here (rather than
  // only inside that child) so the pill can keep this footer bar VISIBLE
  // even when there is no real activity yet (buildFeedEntries's own
  // `items.length === 0` early-return, just below, must not hide it).
  const [pressure, setPressure] = useState<SystemPressureSnapshot>(getSystemPressure);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      const rows = await queryActivityFeed(undefined, MAX_FEED_ENTRIES);
      if (!cancelled) setItems(rows);
    }
    void poll();
    const interval = setInterval(() => void poll(), POLL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  useEffect(() => subscribeSystemPressure(setPressure), []);

  /** Same choreography as every other manager-initiated canvas jump
   *  (LazyManagerRail.tsx's own canvas-focus chip): switch to the Agents
   *  space first (so the glide is actually visible regardless of which
   *  space the user is looking at), then focus_canvas onto the mission's
   *  node ref. */
  const focusMission = useCallback((missionId: string) => {
    emit('nav:navigateSpace', 'agents');
    emit('canvas:focus', { ref: makeRef('mission', missionId) });
  }, []);

  const handleEntryKeyDown = useCallback((e: KeyboardEvent<HTMLSpanElement>, missionId: string) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    focusMission(missionId);
  }, [focusMission]);

  // FOUNDER NORTH STAR — the pressure pill must stay visible even with zero
  // real activity (an idle project can still be under machine pressure);
  // only hide the WHOLE bar when there is neither activity nor pressure to
  // show, same as before this addition.
  const showPressure = pressure.level !== 'normal';

  // Memoised on its real dependencies (items, t — t is itself useCallback'd
  // on [locale] in i18n/index.tsx, so it's referentially stable across a
  // locale-less re-render). This footer is always mounted, polls every 8s,
  // and re-renders for unrelated reasons too (subscribeSystemPressure
  // firing on its own cadence) — recomputing buildFeedEntries's dedupe/
  // JSON-parse/regex work inline on every render was wasted work on every
  // render that didn't actually get fresh items. Called unconditionally,
  // above the early return below, per the rules of hooks.
  const entries = useMemo(
    () => (items.length > 0 ? buildFeedEntries(items, t) : []),
    [items, t],
  );

  if (items.length === 0 && !showPressure) return null;

  return (
    <div
      id="flux-footer"
      data-testid="flux-footer"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '8px 18px',
        fontSize: 12,
        color: 'var(--color-text-disabled)',
        fontFamily: 'var(--font-mono)',
        flexShrink: 0,
      }}
    >
      {items.length > 0 && (
        <>
          <span style={{ fontFamily: 'var(--font-ui)', fontWeight: 700, letterSpacing: 1.5, fontSize: 11.5, flexShrink: 0 }}>
            {t('cockpit.flux.label')}
          </span>
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, minWidth: 0 }}>
            {entries.map((entry, i) => (
              <span key={entry.seq}>
                {i > 0 && ' · '}
                {entry.missionId ? (
                  <span
                    data-testid={`flux-entry-${entry.seq}`}
                    role="button"
                    tabIndex={0}
                    title={t('feed.focusHint')}
                    onClick={() => focusMission(entry.missionId!)}
                    onKeyDown={(e) => handleEntryKeyDown(e, entry.missionId!)}
                    style={{ cursor: 'pointer' }}
                  >
                    {entry.text}
                  </span>
                ) : (
                  <span data-testid={`flux-entry-${entry.seq}`}>{entry.text}</span>
                )}
              </span>
            ))}
          </span>
        </>
      )}
      {showPressure && <SystemPressureBadge />}
    </div>
  );
}
