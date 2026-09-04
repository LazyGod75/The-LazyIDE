/* MemoryPressureIndicator — global, session-wide companion to
   SystemPressureBadge.tsx (src/components/agents/cockpit/). That badge is
   mounted inside FluxFooter, which only renders while the Agents space's
   canvas is on screen (see CanvasView.tsx) — so on any OTHER space (Code,
   Brain, Settings, Terminals) a user under real memory pressure gets no
   signal at all that systemPressureShedding.ts's release valve just fired.

   Deliberately narrower than SystemPressureBadge: only 'high' (not
   'elevated') and focused on the SHEDDING action ("freeing resources") that
   fires exactly at that transition (see systemPressureShedding.ts's
   shouldShed), rather than duplicating that badge's "pacing" copy. Mounted
   once at AppShell level (see AppShell.tsx) so it is visible regardless of
   the active space. No clean global status-bar host exists in AppShell
   today, so — per the same "fixed pill, minimal, no new dependency"
   allowance used elsewhere in this codebase — this is a fixed bottom-left
   pill (bottom-RIGHT is already Toast.tsx's corner; kept clear of it).

   COPY must match what is actually measured (fixed 2026-08): `level ===
   'high'` alone cannot say WHY — it is an OR of RAM being genuinely low and
   CPU spiking, either of which is reason enough to throttle
   (system_pressure.rs's `classify_pressure`). Showing "Mémoire faible" for
   a pure CPU spike on an unrelated process is a false alarm that trains the
   user to ignore this pill. `snapshot.ramLevel` (RAM's own classification,
   see systemPressure.ts) is what lets this component tell the two apart —
   this only ever shows the low-memory copy when RAM itself is confirmed
   High, and a distinct CPU-load copy otherwise. Also: even the low-memory
   copy no longer says "Lazy" is why memory is low — `available_ram_mb` is
   system-wide (every process on the machine, not this app's own usage), so
   blaming Lazy for someone else's memory pressure would itself be
   inaccurate; the copy now describes the MACHINE's memory as low and Lazy's
   own (real, but partial) response to it.

   QA fix (bottom-left overlap): this used to float over whatever a space
   already renders in that corner — the Brain space's cluster filter list
   and the Cockpit's FluxFooter activity bar both live there, so the pill
   sat on top of them and hid real interactive rows. The pill's own
   on-screen footprint is now reserved centrally: AppShellInner (see
   AppShell.tsx) reads `useMemoryPressureReservedHeight()` (see
   memoryPressureReservedHeight.ts, split into its own file for the same
   react-refresh/only-export-components reason ToastContext.ts is split out
   of Toast.tsx) and applies it as `<main>`'s paddingBottom whenever the
   pressure level is 'high', shrinking every space's content box by exactly
   that much so the pill always lands in genuinely empty space instead of
   over content — one central reservation instead of teaching every space
   about this pill.
*/

import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { getSystemPressure, subscribeSystemPressure, type SystemPressureSnapshot } from '../lib/agents/systemPressure';

export function MemoryPressureIndicator() {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<SystemPressureSnapshot>(getSystemPressure);

  useEffect(() => subscribeSystemPressure(setSnapshot), []);

  // Auto-hides the instant pressure drops back below 'high' — no dismiss
  // affordance needed, this is a live status, not a one-off notice.
  if (snapshot.level !== 'high') return null;

  // RAM confirmed High is a genuine low-memory condition; anything else
  // (including `ramLevel` undefined/unconfirmed — see systemPressure.ts's
  // doc comment on why that degrades to "not confirmed low", not "fine")
  // means this 'high' came from CPU alone, so the copy must say CPU, never
  // memory (see this file's own header comment).
  const memoryIsLow = snapshot.ramLevel === 'high';

  return (
    <div
      data-testid="memory-pressure-indicator"
      role="status"
      style={{
        position: 'fixed',
        bottom: 20,
        left: 20,
        zIndex: 9997,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 12px',
        background: '#16161D',
        border: '1px solid rgba(251,185,36,0.32)',
        borderLeft: '3px solid var(--color-warning-text)',
        borderRadius: 8,
        boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
        fontFamily: 'var(--font-ui)',
        fontSize: 11.5,
        color: '#E6E8EF',
        pointerEvents: 'none',
      }}
    >
      <span
        aria-hidden="true"
        style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-warning-text)', flexShrink: 0 }}
      />
      {memoryIsLow ? t('pressure.lowMemoryFreeing') : t('pressure.cpuHighFreeing')}
    </div>
  );
}
