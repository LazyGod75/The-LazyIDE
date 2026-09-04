/* useLiveWorktreeTail — polls a REAL worktree file every ~1.5s and exposes
   which lines are new/changed since the previous poll (D9's "watch the
   agent write live" view). No scripted typing animation: every line shown
   is the file's actual current content on disk.
*/

import { useEffect, useRef, useState } from 'react';
import type { Platform } from '../../../lib/platform/types';

const POLL_INTERVAL_MS = 1500;

export interface LiveWorktreeTail {
  lines: string[];
  /** Index (0-based) of the first line considered part of the "growing
   *  edge" since the previous poll — everything from here to the end gets
   *  the violet highlight + trailing cursor. Equals lines.length when
   *  nothing changed on the last poll (no highlight). */
  changedFrom: number;
  loading: boolean;
  error: string | null;
}

/** Finds the first line index where `prev` and `next` diverge. Returns
 *  `next.length` when `next` is a pure unchanged prefix of a shorter or
 *  equal-length previous array (nothing new to highlight). */
export function firstDivergence(prev: string[], next: string[]): number {
  const max = Math.min(prev.length, next.length);
  let i = 0;
  while (i < max && prev[i] === next[i]) i++;
  return i;
}

export function useLiveWorktreeTail(platform: Platform, path: string | null, enabled: boolean): LiveWorktreeTail {
  const [lines, setLines] = useState<string[]>([]);
  const [changedFrom, setChangedFrom] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const prevLinesRef = useRef<string[]>([]);

  useEffect(() => {
    prevLinesRef.current = [];
    setLines([]);
    setChangedFrom(0);
    setError(null);
    if (!enabled || !path) { setLoading(false); return; }

    let cancelled = false;
    setLoading(true);

    async function poll() {
      try {
        const content = await platform.fs.readFile(path!);
        if (cancelled) return;
        const nextLines = content.split('\n');
        const divergedAt = firstDivergence(prevLinesRef.current, nextLines);
        prevLinesRef.current = nextLines;
        setLines(nextLines);
        setChangedFrom(divergedAt);
        setError(null);
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, [platform, path, enabled]);

  return { lines, changedFrom, loading, error };
}
