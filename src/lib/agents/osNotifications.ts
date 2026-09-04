/* osNotifications.ts — P7.3 / QW1: OS notifications.

   Sends OS-level notifications for mission lifecycle events.
   Uses PowerShell toast notifications on Windows, osascript on macOS,
   and notify-send on Linux. Gracefully degrades when not in a Tauri runtime.
*/

import { isTauri } from '../platform/index.js';
import { invoke } from '@tauri-apps/api/core';
import type { TFunc } from './runtime.js';

export type NotificationKind = 'mission_done' | 'mission_failed' | 'contest_completed' | 'chain_fired' | 'info';

export interface OsNotificationOptions {
  kind: NotificationKind;
  title: string;
  body: string;
  missionId?: string;
  projectId?: string;
}

/** Send an OS notification. No-op outside Tauri. */
export async function sendOsNotification(opts: OsNotificationOptions): Promise<void> {
  if (!isTauri()) return;

  try {
    const script = buildNotificationScript(opts);
    if (!script) return;
    await invoke('run_shell', { command: script, cwd: null });
  } catch {
    // Shell not available — silent no-op
  }
}

function buildNotificationScript(opts: OsNotificationOptions): string | null {
  const title = escapeShell(opts.title);
  const body = escapeShell(opts.body);

  if (typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')) {
    return `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(5000, '${title}', '${body}', [System.Windows.Forms.ToolTipIcon]::Info); Start-Sleep -Seconds 6; $n.Dispose()"`;
  }

  if (typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')) {
    return `osascript -e 'display notification "${body}" with title "${title}"'`;
  }

  return `notify-send "${title}" "${body}"`;
}

function escapeShell(s: string): string {
  return s.replace(/'/g, "'\\''").replace(/"/g, '\\"');
}

/** Notification titles/bodies below are translated via `t` when supplied —
 *  fall back to the ORIGINAL hardcoded French otherwise, same optional-
 *  everywhere contract as runtime.ts's own TFunc (see its doc comment). */
export function notifyMissionDone(missionId: string, title: string, t?: TFunc): Promise<void> {
  return sendOsNotification({
    kind: 'mission_done',
    title: t ? t('cockpit.notification.missionDone.title') : 'Mission terminée',
    body: title,
    missionId,
  });
}

export function notifyMissionFailed(missionId: string, title: string, error?: string, t?: TFunc): Promise<void> {
  return sendOsNotification({
    kind: 'mission_failed',
    title: t ? t('cockpit.notification.missionFailed.title') : 'Mission échouée',
    body: error ? `${title}: ${error}` : title,
    missionId,
  });
}

export function notifyContestCompleted(winnerId: string, title: string, t?: TFunc): Promise<void> {
  return sendOsNotification({
    kind: 'contest_completed',
    title: t ? t('cockpit.notification.contestCompleted.title') : 'Concours terminé',
    body: t ? t('cockpit.notification.contestCompleted.body', { title }) : `Gagnant: ${title}`,
    missionId: winnerId,
  });
}
