/* useWorktreeReview.ts — real git diff loader for an arbitrary repo/worktree
   path (D12's diff drawer). Adapted from ReviewSpace.tsx's private
   useGitReview (which is always scoped to the ACTIVE project's working
   tree) to accept ANY absolute path that is itself a real git working
   directory — the Code space's worktree cards point at agent worktrees
   (`.lazy/worktrees/<branch>`), not the main project root, and the "main"
   worktree card points at the project root's own working-tree diff.
   ReviewSpace.tsx itself is left untouched; ReviewSpace's own future needs
   are not this hook's concern.

   Same real-vs-honest-empty discipline as the original: under Tauri, a
   read failure surfaces as an explicit error state; web/non-Tauri resolves
   to an honest 'unavailable' state — never mock data (repo convention). */

import { useEffect, useState } from 'react';
import { getPlatform } from '../platform/index.js';
import type { DiffLine } from './diffParse.js';
import { parseDiffLines, countDiffLines } from './diffParse.js';

export interface WorktreeReviewFile {
  path: string;
  status: string;
  added: number;
  removed: number;
  lines: DiffLine[];
}

export type WorktreeReviewState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'empty'; branch: string }
  | { kind: 'error'; message: string }
  | { kind: 'data'; branch: string; files: WorktreeReviewFile[]; added: number; removed: number };

/**
 * Loads the real git status + per-file diff for `worktreePath`. Pass `null`
 * while no worktree is selected (e.g. the drawer is closed) — the hook
 * stays in 'loading' and does no I/O until a real path is provided.
 */
export function useWorktreeReview(worktreePath: string | null): WorktreeReviewState {
  const platform = getPlatform();
  const [state, setState] = useState<WorktreeReviewState>({ kind: 'loading' });

  useEffect(() => {
    if (!worktreePath) {
      setState({ kind: 'loading' }); // eslint-disable-line react-hooks/set-state-in-effect
      return;
    }
    if (platform.name !== 'tauri') {
      setState({ kind: 'unavailable' }); // eslint-disable-line react-hooks/set-state-in-effect
      return;
    }

    let cancelled = false;
    setState({ kind: 'loading' });

    async function load() {
      try {
        const status = await platform.git.status(worktreePath!);
        if (cancelled) return;

        if (status.files.length === 0) {
          setState({ kind: 'empty', branch: status.branch });
          return;
        }

        const files: WorktreeReviewFile[] = [];
        let totalAdded = 0;
        let totalRemoved = 0;

        await Promise.all(
          status.files.map(async (f) => {
            let rawDiff = '';
            try {
              rawDiff = await platform.git.diff(worktreePath!, f.path);
            } catch {
              // rawDiff stays '' — show an empty diff for this file, not an error
            }
            const { added, removed } = countDiffLines(rawDiff);
            files.push({ path: f.path, status: f.status, added, removed, lines: parseDiffLines(rawDiff) });
            totalAdded += added;
            totalRemoved += removed;
          }),
        );

        if (!cancelled) {
          setState({ kind: 'data', branch: status.branch, files, added: totalAdded, removed: totalRemoved });
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, [worktreePath, platform]);

  return state;
}
