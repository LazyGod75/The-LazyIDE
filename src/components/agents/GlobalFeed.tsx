/**
 * GlobalFeed — cockpit v2 surface showing a cross-project activity feed.
 *
 * Pulls from the journal projection query (T2.0 `queryActivityFeed`).
 * Shows recent events with type, actor, project, and payload preview.
 * Auto-refreshes every 30 seconds.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { useI18n } from '../../i18n';
import { queryActivityFeed, type ActivityFeedItem } from '../../lib/journal/projections';
import { EmptyState } from '../ui';
import { SparklesIcon } from '../icons';

const EVENT_TYPE_COLORS: Record<string, string> = {
  'mission.created': '#7C5CFF',
  'mission.started': '#7C5CFF',
  'mission.completed': '#22C55E',
  'mission.approved': '#22C55E',
  'mission.failed': '#F87171',
  'mission.review_requested': '#FBB924',
  'tool.called': 'rgba(255,255,255,0.4)',
  'agent.spawned': '#A78BFA',
  'agent.delegated': '#A78BFA',
};

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function GlobalFeed() {
  const { t } = useI18n();
  const [items, setItems] = useState<ActivityFeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  // B3.2: guards against a slow tick's result landing after (and
  // overwriting) a faster, more recent tick's result — a tick that takes
  // longer than the 30s interval would otherwise win the race regardless
  // of which one is actually newer.
  const tickRef = useRef(0);

  const refresh = useCallback(async () => {
    const tick = ++tickRef.current;
    const result = await queryActivityFeed(undefined, 100);
    if (tick !== tickRef.current) return; // superseded by a newer tick
    setItems(result);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(interval);
  }, [refresh]);

  if (!loading && items.length === 0) {
    return (
      <div
        data-testid="global-feed"
        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <EmptyState
          icon={SparklesIcon}
          title={t('agents.feed.emptyTitle')}
          subtitle={t('agents.feed.emptySubtitle')}
        />
      </div>
    );
  }

  return (
    <div
      data-testid="global-feed"
      style={{
        padding: '16px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        overflowY: 'auto',
        height: '100%',
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: 'rgba(255,255,255,0.45)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          marginBottom: 8,
        }}
      >
        {t('agents.feed.title')}
      </div>
      {items.map((item) => {
        const color = EVENT_TYPE_COLORS[item.event_type] ?? 'rgba(255,255,255,0.3)';
        return (
          <div
            key={item.seq}
            data-testid={`feed-item-${item.seq}`}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              padding: '8px 12px',
              borderRadius: 6,
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid rgba(255,255,255,0.04)',
            }}
          >
            <div
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: color,
                flexShrink: 0,
                marginTop: 5,
              }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  flexWrap: 'wrap',
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: '#E2E2F0',
                    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                  }}
                >
                  {item.event_type}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    color: 'rgba(255,255,255,0.35)',
                    padding: '1px 5px',
                    borderRadius: 3,
                    background: 'rgba(255,255,255,0.05)',
                  }}
                >
                  {item.project_id}
                </span>
                <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)' }}>
                  {item.actor}
                </span>
              </div>
              {item.payload_preview && (
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 11,
                    color: 'rgba(255,255,255,0.35)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                  }}
                >
                  {item.payload_preview}
                </div>
              )}
            </div>
            <div
              style={{
                fontSize: 10,
                color: 'rgba(255,255,255,0.25)',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              {timeAgo(item.ts_ms)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
