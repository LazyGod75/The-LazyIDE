/* CodeStatusBar — 36px mono status bar for the redesigned Code space
   (design-code.md §4.6): ■ project (colored) · worktree/branch · language ·
   Ln {n} · diff stat · cursor position. All values real — derived by the
   caller (CodeSpace) from the active tab/project/mission, never placeholders.

   B19: `projectName` is a display name (basename of the project root), NOT
   the raw registry id — that hash used to leak straight into this bar (and
   into the WORKTREES sidebar header — see CodeSidebarWorktrees.tsx).

   `cursorPosition` (1-based line/col, from EditorPane.tsx's
   cursorPositionFromState via the 'editor:cursor' bus event — see
   CodeSpace.tsx's own subscription) — the DEFECT #4 fix referenced in
   EditorPane.tsx's own comment: this bar had no consumer for that event at
   all (its predecessor StatusBar.tsx was removed in an earlier wave), so
   "Ln X, Col Y" never showed anywhere.

   Rendered as "Ln {line}, Col {col}" — VS Code's own convention, and the
   ONLY line/position readout in this bar. A prior version of this fix
   rendered it as "X:Y" right next to `totalLines` below, which despite
   being the document's total line COUNT (not a position) was ALSO labeled
   "Ln {n}" — two differently-sourced numbers both claiming to be "the
   line", disagreeing side by side (e.g. "1:1  Ln 2"). `totalLines` keeps
   its own distinct "{n} lines" label so it can never be mistaken for the
   cursor position again.
*/

interface CodeStatusBarProps {
  projectName: string | null;
  projectColor: string | null;
  branchOrWorktree: string | null;
  language: string | null;
  totalLines: number | null;
  diffStat: string | null;
  cursorPosition: { line: number; col: number } | null;
}

export function CodeStatusBar({ projectName, projectColor, branchOrWorktree, language, totalLines, diffStat, cursorPosition }: CodeStatusBarProps) {
  return (
    <div
      style={{
        height: 36,
        flexShrink: 0,
        background: 'var(--color-panel-3)',
        borderTop: '1px solid var(--color-border)',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '0 16px',
        fontFamily: 'var(--font-mono)',
        fontSize: 12.5,
        color: 'var(--color-text-muted)',
        userSelect: 'none',
      }}
    >
      {projectName && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span style={{ color: projectColor ?? 'var(--color-accent)' }}>■</span> {projectName}
        </span>
      )}
      {branchOrWorktree && (
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>{branchOrWorktree}</span>
      )}
      {language && <span>{language}</span>}
      <div style={{ flex: 1 }} />
      {cursorPosition && <span>Ln {cursorPosition.line}, Col {cursorPosition.col}</span>}
      {totalLines !== null && <span>{totalLines} {totalLines === 1 ? 'line' : 'lines'}</span>}
      {diffStat && <span style={{ color: 'var(--color-success)' }}>{diffStat}</span>}
    </div>
  );
}
