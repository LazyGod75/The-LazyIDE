/* scheduleUtils.ts — Local cron helpers for the UI.
   No heavy cron library — we only need preset expansion + a simple "next run"
   preview for display in AgentCard and the wizard schedule step.
*/

/** Human-readable label for a cron expression (preset or raw). */
export function formatCron(cron: string): string {
  const presets: Record<string, string> = {
    '0 * * * *':     'Toutes les heures',
    '0 9 * * *':     'Chaque jour a 9h',
    '0 9 * * 1-5':   'Jours ouvrables a 9h',
    '0 9 * * 1':     'Chaque lundi a 9h',
    '*/30 * * * *':  'Toutes les 30 min',
  };
  return presets[cron.trim()] ?? cron;
}

/** Frequency presets for the wizard schedule step. */
export interface FrequencyPreset {
  label: string;
  cron: string;
}

export const FREQUENCY_PRESETS: FrequencyPreset[] = [
  { label: 'Toutes les heures',   cron: '0 * * * *' },
  { label: 'Chaque jour a 9h',    cron: '0 9 * * *' },
  { label: 'Jours ouvrables (9h)', cron: '0 9 * * 1-5' },
  { label: 'Chaque lundi a 9h',   cron: '0 9 * * 1' },
  { label: 'Personnalise',         cron: '' },
];

/**
 * Compute a human-readable "next run" string from a cron expression.
 * Pure JS — no cron library. Handles only the presets we define.
 * Falls back to a simple relative description for unknown crons.
 */
export function nextCronRun(cron: string): string {
  const now = new Date();

  try {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return nextRunFallback(cron);

    const [minPart, hourPart, , , dayOfWeekPart] = parts;

    const minute = minPart === '*' ? now.getMinutes() : parseInt(minPart, 10);
    const hour   = hourPart === '*' ? null : parseInt(hourPart, 10);

    if (isNaN(minute)) return nextRunFallback(cron);

    // Build candidate date
    const next = new Date(now);
    next.setSeconds(0, 0);

    if (hour === null) {
      // Every-minute or every-hour: advance to next minute boundary
      next.setMinutes(next.getMinutes() + 1);
    } else {
      // Advance to the next occurrence of this hour:minute
      next.setHours(hour, minute, 0, 0);
      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }

      // Day-of-week filter (e.g. "1-5" for weekdays, "1" for Monday)
      if (dayOfWeekPart !== '*') {
        const allowedDays = expandDayRange(dayOfWeekPart);
        if (allowedDays.length > 0) {
          let attempts = 0;
          while (!allowedDays.includes(next.getDay()) && attempts < 8) {
            next.setDate(next.getDate() + 1);
            next.setHours(hour, minute, 0, 0);
            attempts++;
          }
        }
      }
    }

    return formatRelative(next, now);
  } catch {
    return nextRunFallback(cron);
  }
}

function expandDayRange(part: string): number[] {
  // Handles "1-5", "1", "0,6", "*"
  if (part === '*') return [];
  if (part.includes('-')) {
    const [start, end] = part.split('-').map(Number);
    const days: number[] = [];
    for (let d = start; d <= end; d++) days.push(d);
    return days;
  }
  return part.split(',').map(Number).filter((n) => !isNaN(n));
}

function formatRelative(next: Date, now: Date): string {
  const diffMs = next.getTime() - now.getTime();
  const diffMin = Math.round(diffMs / 60000);

  if (diffMin < 1)   return 'dans moins de 1 min';
  if (diffMin < 60)  return `dans ${diffMin} min`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24)    return `dans ${diffH}h`;
  const diffD = Math.round(diffH / 24);
  return `dans ${diffD}j`;
}

function nextRunFallback(cron: string): string {
  return `cron: ${cron}`;
}
