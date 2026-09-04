/* SyncStatusBanner — single-line team sync status banner for the Brain space.
   Shows org id, last pull/push relative time, and last error (red, clickable
   to retry). Only renders when an active team brain config exists. */

import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../../i18n';
import { syncStatus, type SyncStatus } from '../../lib/teams/syncDaemon';
import { readActiveBrainConfig } from '../../lib/teams/activeBrainConfig';

interface SyncStatusBannerProps {
  onRetry?: () => void;
}

function relativeTime(ts: number | null): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export function SyncStatusBanner({ onRetry }: SyncStatusBannerProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<SyncStatus>(() => syncStatus());
  const [lastError, setLastError] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => {
      setStatus(syncStatus());
      setLastError(readActiveBrainConfig()?.lastError ?? null);
    };
    refresh();
    const interval = setInterval(refresh, 15_000);
    return () => clearInterval(interval);
  }, []);

  const handleRetry = useCallback(() => {
    if (onRetry) onRetry();
  }, [onRetry]);

  if (status.transport === 'none') return null;
  const repo = status.repo;
  const hasError = !!lastError;

  return (
    <div
      data-testid="sync-status-banner"
      onClick={hasError ? handleRetry : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '5px 16px',
        fontSize: 11,
        fontFamily: 'inherit',
        cursor: hasError ? 'pointer' : 'default',
        background: hasError ? 'rgba(239,68,68,0.08)' : 'rgba(124,92,255,0.06)',
        borderBottom: `1px solid ${hasError ? 'rgba(239,68,68,0.3)' : 'rgba(124,92,255,0.2)'}`,
        color: hasError ? '#FCA5A5' : 'rgba(255,255,255,0.6)',
        flexShrink: 0,
      }}
    >
      <span style={{ fontWeight: 600, color: hasError ? '#FCA5A5' : '#C4B5FD' }}>
        {t('brain.sync.brain')} · {repo.orgId}
      </span>
      <span>· {t('brain.sync.pulled')} {relativeTime(repo.lastPulledAt)}</span>
      {repo.lastPushedAt && (
        <span style={{ opacity: 0.7 }}>· {t('brain.sync.pushed')} {relativeTime(repo.lastPushedAt)}</span>
      )}
      {hasError && <span style={{ fontWeight: 600 }}>· {t('brain.sync.error')}: {lastError}</span>}
    </div>
  );
}
