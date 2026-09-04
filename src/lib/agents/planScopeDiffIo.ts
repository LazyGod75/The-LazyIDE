/* planScopeDiffIo — Tauri git_diff for plan-approval review.

   Failures return ERROR:/No changes so usablePlanDiff drops them. Never
   fabricates a hunk.
*/

import { invoke } from '@tauri-apps/api/core';

export async function loadProjectFileDiff(root: string, filePath: string): Promise<string> {
  try {
    const diff = await invoke<string>('git_diff', { repoPath: root, filePath });
    if (!diff?.trim()) return 'No changes';
    return diff.slice(0, 2000);
  } catch (err) {
    return `ERROR: git_diff failed: ${String(err)}`;
  }
}

export function bindPlanFileDiff(
  root: string | undefined,
): ((path: string) => Promise<string>) | undefined {
  if (!root) return undefined;
  return (path) => loadProjectFileDiff(root, path);
}
