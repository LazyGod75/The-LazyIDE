/* BrainTimeline — "since your last session" timeline for the Brain space.
   Shows notes created since the user's last visit, with counts by kind and
   the latest 10 items. Uses localStorage to track lastSeenAt per org. */

import { useState, useEffect, useMemo } from 'react';
import { useI18n } from '../../i18n';
import { readActiveBrainConfig } from '../../lib/teams/activeBrainConfig';
import { getPlatform } from '../../lib/platform';
import { isTauri } from '../../lib/platform';
import { parseAuthorsFromHtml, type AuthorInfo } from '../../lib/brain/queryCssParse';
import type { AdaptedNode } from '../../lib/brain/brainAdapter';
import { formatNeuronTitle } from '../../lib/brain/neuronTitle';
import { pluralKey } from '../../i18n/plural';

interface BrainTimelineProps {
  nodes: AdaptedNode[];
}

/** Above this, the headline count is shown as "{CAP}+" instead of the exact
    number — after a long absence the precise figure (e.g. 6702) stops being
    useful and reads as noise. The underlying data stays untouched; only the
    displayed digits are capped. */
const DISPLAY_CAP = 500;

function formatCappedCount(n: number): string {
  return n > DISPLAY_CAP ? `${DISPLAY_CAP}+` : String(n);
}

function lastSeenKey(orgId: string): string {
  return `lazy:brain-last-seen:${orgId}`;
}

export function BrainTimeline({ nodes }: BrainTimelineProps) {
  const { t, locale } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const [authors, setAuthors] = useState<Map<string, AuthorInfo>>(new Map());

  const orgId = useMemo(() => readActiveBrainConfig()?.orgId ?? 'solo', []);

  // `stored === null` means this profile has never recorded a visit to this
  // brain's timeline — NOT "last visited at the Unix epoch". Treating a
  // missing value as lastSeenAt=0 (the old behaviour) made every single note
  // ever created compare as "new", so a brand-new user with a 6702-neuron
  // brain saw "6702 new items". A first-time visit must never claim
  // anything is new; it only establishes the baseline for the *next* visit
  // (recorded by the effect below).
  const stored = useMemo(() => localStorage.getItem(lastSeenKey(orgId)), [orgId]);
  const isFirstVisit = stored === null;
  const lastSeenAt = stored ? Number(stored) : 0;

  const newNodes = useMemo(() => {
    if (isFirstVisit) return [];
    return nodes
      .filter((n) => {
        if (!n.created) return false;
        const ts = Date.parse(n.created);
        if (!Number.isFinite(ts)) return false;
        return ts > lastSeenAt;
      })
      .sort((a, b) => {
        const ta = a.created ? Date.parse(a.created) : 0;
        const tb = b.created ? Date.parse(b.created) : 0;
        return tb - ta;
      });
  }, [nodes, lastSeenAt, isFirstVisit]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const n of newNodes) c[n.type] = (c[n.type] ?? 0) + 1;
    return c;
  }, [newNodes]);

  const top10 = newNodes.slice(0, 10);

  useEffect(() => {
    if (!isTauri() || top10.length === 0) return;
    let cancelled = false;
    (async () => {
      const map = new Map<string, AuthorInfo>();
      for (const n of top10) {
        try {
          const html = await getPlatform().brain.noteHtml(n.id);
          if (html) {
            const parsed = parseAuthorsFromHtml(html);
            if (parsed.length > 0) map.set(n.id, parsed[0]);
          }
        } catch { /* skip */ }
      }
      if (!cancelled) setAuthors(map);
    })();
    return () => { cancelled = true; };
  }, [top10]);

  useEffect(() => {
    const key = lastSeenKey(orgId);
    localStorage.setItem(key, String(Date.now()));
  }, [orgId]);

  if (newNodes.length === 0) return null;

  return (
    <div
      style={{
        borderBottom: '1px solid rgba(255,255,255,0.07)',
        background: 'rgba(124,92,255,0.04)',
        flexShrink: 0,
      }}
    >
      <button
        onClick={() => setCollapsed((c) => !c)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 16px',
          background: 'transparent',
          border: 'none',
          color: 'rgba(255,255,255,0.6)',
          fontSize: 11,
          fontFamily: 'inherit',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ color: '#C4B5FD', fontWeight: 600 }}>
          {formatCappedCount(newNodes.length)} {t(pluralKey('brain.timeline.newSince', newNodes.length, locale))}
        </span>
        {counts['decision'] && <span>· {formatCappedCount(counts['decision'])} {t(pluralKey('brain.timeline.decisions', counts['decision'], locale))}</span>}
        {counts['bug'] && <span>· {formatCappedCount(counts['bug'])} {t(pluralKey('brain.timeline.bugs', counts['bug'], locale))}</span>}
        <span style={{ marginLeft: 'auto', opacity: 0.5 }}>{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && (
        <div style={{ padding: '4px 16px 8px', display: 'flex', flexDirection: 'column', gap: 3 }}>
          {top10.map((n) => {
            const a = authors.get(n.id);
            return (
              <div key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                <span style={{ color: 'rgba(255,255,255,0.4)', minWidth: 60 }}>{n.type}</span>
                <span style={{ color: 'rgba(255,255,255,0.7)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{formatNeuronTitle(n.name, 80)}</span>
                {a && <span style={{ color: '#A78BFA', fontSize: 10 }}>{a.author}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
