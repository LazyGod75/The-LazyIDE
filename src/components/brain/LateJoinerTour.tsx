/* LateJoinerTour — optional dismissible overlay shown when a user joins a
   team brain for the first time. Summarizes the last 30 days of
   decisions/bugs. Dismissal is persisted via localStorage so it never
   shows again for that org. */

import { useState, useEffect, useMemo } from 'react';
import { useI18n } from '../../i18n';
import { readActiveBrainConfig } from '../../lib/teams/activeBrainConfig';
import { getPlatform } from '../../lib/platform';
import { isTauri } from '../../lib/platform';
import { parseNoteIds } from '../../lib/brain/queryCssParse';

function tourKey(orgId: string): string {
  return `lazy.team-tour:${orgId}`;
}

interface TourItem {
  id: string;
  kind: string;
  title: string;
}

export function LateJoinerTour() {
  const { t } = useI18n();
  const [items, setItems] = useState<TourItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [visible, setVisible] = useState(false);

  const orgId = useMemo(() => readActiveBrainConfig()?.orgId ?? null, []);

  useEffect(() => {
    if (!orgId || !isTauri()) return;
    if (localStorage.getItem(tourKey(orgId))) return;
    let cancelled = false;
    (async () => {
      const platform = getPlatform();
      try {
        const [decRaw, bugRaw] = await Promise.all([
          platform.brain.queryCss('article[data-cerveau-type="decision"]:not([data-cerveau-valid-until])'),
          platform.brain.queryCss('article[data-cerveau-tags~="bug"]'),
        ]);
        if (cancelled) return;
        const decIds = parseNoteIds(decRaw);
        const bugIds = parseNoteIds(bugRaw);
        const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
        const all: TourItem[] = [];
        for (const id of decIds) all.push({ id, kind: 'decision', title: id });
        for (const id of bugIds) all.push({ id, kind: 'bug', title: id });
        const recent = all.filter((item) => {
          const ts = parseInt(item.id.replace(/\D/g, ''), 10);
          return !isNaN(ts) && ts >= thirtyDaysAgo;
        }).slice(0, 20);
        setItems(recent);
        setVisible(recent.length > 0);
      } catch { /* ignore */ }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [orgId]);

  function handleDismiss() {
    if (orgId) localStorage.setItem(tourKey(orgId), 'true');
    setVisible(false);
  }

  if (!visible || loading) return null;

  const decisions = items.filter((i) => i.kind === 'decision').length;
  const bugs = items.filter((i) => i.kind === 'bug').length;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) handleDismiss(); }}
    >
      <div
        style={{
          background: '#18181E',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 12,
          padding: '24px',
          width: 460,
          maxHeight: '70vh',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, color: '#E8E3FF' }}>
          {t('brain.tour.welcome')}
        </div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
          {t('brain.tour.last30')}: {decisions} {t('brain.timeline.decisions')}, {bugs} {t('brain.timeline.bugs')}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {items.slice(0, 15).map((item) => (
            <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: item.kind === 'bug' ? 'rgba(239,68,68,0.15)' : 'rgba(124,92,255,0.15)',
                  color: item.kind === 'bug' ? '#FCA5A5' : '#C4B5FD',
                }}
              >
                {item.kind}
              </span>
              <span style={{ color: 'rgba(255,255,255,0.6)', fontFamily: 'var(--font-mono, monospace)' }}>{item.id}</span>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            onClick={handleDismiss}
            style={{
              padding: '8px 18px',
              borderRadius: 7,
              border: 'none',
              background: '#7C5CFF',
              color: '#fff',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {t('brain.tour.gotIt')}
          </button>
        </div>
      </div>
    </div>
  );
}
