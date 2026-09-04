/* CodeSidebarProjects — the "PROJETS" sidebar section (design-code.md §4.2):
   every open project stacked, collapsible, with a real per-project git
   branch, an alert badge derived from real fleet missions, and a shallow
   real filesystem tree per project. Per-file indicators (who's working on
   it + git status badge) are derived from real data — see
   codeFileActivity.ts / fileTree.ts. No canned content: an empty project
   (no files, no missions) renders its real empty tree, nothing fabricated.
*/

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Platform, GitFile } from '../../../lib/platform/types';
import type { ProjectEntry } from '../../../app/AppContext';
import type { FleetProject, FleetMission } from '../../../lib/agents/fleetMissions';
import { colorForProject } from '../../../lib/projectColors';
import { findFileActivity, fileActivityDotChrome, fileActivityWhoLine } from '../../../lib/agents/codeFileActivity';
import { basename, joinPath } from '../../../lib/paths';
import { orderActiveFirst } from '../../../lib/projectOrdering';
import { loadLevel, relativeToRoot, updateNodeAt, type CodeTreeNode } from './fileTree';
import { useI18n } from '../../../i18n';
import { useToast } from '../../ui';
import { emit } from '../../../lib/bus';
import { useAppContextOptional } from '../../../app/AppContext';

const GIT_POLL_MS = 8000;

// QA fix (branch-fetch can hang forever): a wedged `git` subprocess makes
// the Tauri `invoke()` behind platform.git.status() never settle — neither
// resolve nor reject — so without a bound the branch-fetch effect below
// would await it forever and `branch` would stay `undefined` (the "…"
// loading glyph) for the rest of the session, indistinguishable from a
// slow-but-healthy fetch. 5s (well under GIT_POLL_MS's 8s, so a timed-out
// refresh has resolved one way or another before the next poll tick fires)
// is generous headroom above what a real `git status` takes even on a
// large repo or under Windows AV-scan interference (typically <200ms,
// rarely into the low seconds) while still surfacing a genuine hang inside
// a single poll cycle rather than leaving the user staring at "…"
// indefinitely.
const GIT_STATUS_TIMEOUT_MS = 5000;

class GitStatusTimeoutError extends Error {
  constructor(ms: number) {
    super(`git.status timed out after ${ms}ms`);
    this.name = 'GitStatusTimeoutError';
  }
}

/** Races `promise` against a timer; rejects with GitStatusTimeoutError if
 *  `ms` elapses first. Same "never cancels the underlying promise — a late
 *  result is simply ignored by the caller's own `cancelled` guard" contract
 *  as the withTimeout helpers in BrainSpace.tsx/MemoryPanel.tsx/WikiTab.tsx
 *  (this codebase's established local-per-file pattern for this exact
 *  race, not a shared module — see those files' own doc comments). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new GitStatusTimeoutError(ms)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}

type FileBadge = 'M' | '✕' | '🔒' | null;

function gitStatusMap(files: GitFile[]): Map<string, GitFile['status']> {
  const map = new Map<string, GitFile['status']>();
  // path-lint-ignore: f.path is a git-status-relative path (git output),
  // never a raw canonicalize() path — no verbatim prefix to strip here.
  for (const f of files) map.set(f.path.replace(/\\/g, '/'), f.status);
  return map;
}

function badgeForFile(
  relPath: string,
  filename: string,
  statusMap: Map<string, GitFile['status']>,
  missions: readonly FleetMission[],
): FileBadge {
  const activity = findFileActivity(relPath, filename, missions);
  if (activity?.kind === 'failed') return '✕';
  const status = statusMap.get(relPath) ?? statusMap.get(filename);
  if (status === 'M' || status === 'A') return 'M';
  return null;
}

// ── Context menu (B23) ───────────────────────────────────────────
//
// The redesign's multi-project sidebar (this file) replaced the
// pre-redesign single-project FileExplorer.tsx, which already had a real,
// tested context menu wired to the real FileSystem (createFile/createDir/
// rename/remove) — but FileExplorer.tsx itself is no longer imported
// anywhere (verified: zero `<FileExplorer` usages in src/), so that menu
// was unreachable dead code. This ports the same real-fs pattern to the
// tree that's ACTUALLY rendered here.

interface ContextMenuState {
  x: number;
  y: number;
  node: CodeTreeNode;
  /** Directory the node lives in — where a New file/folder created via
   *  this menu lands, and what gets refreshed after any mutation. */
  parentPath: string;
}

interface RenameInputProps {
  initialValue: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

function RenameInput({ initialValue, onCommit, onCancel }: RenameInputProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit(value.trim());
        if (e.key === 'Escape') {
          cancelledRef.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        if (cancelledRef.current) return;
        onCommit(value.trim());
      }}
      style={{
        background: 'rgba(124,92,255,0.15)',
        border: '1px solid rgba(124,92,255,0.5)',
        color: 'var(--color-text)',
        borderRadius: 3,
        padding: '1px 5px',
        fontSize: 12,
        fontFamily: 'inherit',
        width: '100%',
        outline: 'none',
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

interface FileTreeContextMenuProps {
  x: number;
  y: number;
  node: CodeTreeNode;
  onNewFile: () => void;
  onNewFolder: () => void;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}

function FileTreeContextMenu({ x, y, node, onNewFile, onNewFolder, onRename, onDelete, onClose }: FileTreeContextMenuProps) {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  const items: Array<{ label: string; action: () => void; danger?: boolean }> = [
    ...(node.entry.isDir ? [
      { label: t('fileExplorer.newFile'), action: onNewFile },
      { label: t('fileExplorer.newFolder'), action: onNewFolder },
    ] : []),
    { label: t('fileExplorer.rename'), action: onRename },
    { label: t('common.delete'), action: onDelete, danger: true },
  ];

  return (
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        top: y,
        left: x,
        zIndex: 9000,
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 6,
        boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
        minWidth: 150,
        overflow: 'hidden',
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          onClick={() => { item.action(); onClose(); }}
          style={{
            display: 'block',
            width: '100%',
            padding: '7px 14px',
            textAlign: 'left',
            fontSize: 12,
            color: item.danger ? 'var(--color-danger)' : 'var(--color-text-secondary)',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(124,92,255,0.12)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

// ── File row ──────────────────────────────────────────────────────

interface FileRowProps {
  node: CodeTreeNode;
  depth: number;
  root: string;
  /** Directory this node lives in — passed straight through to
   *  onContextMenu so New file/folder land in the right place. */
  parentPath: string;
  activeTabPath: string | null;
  missions: readonly FleetMission[];
  statusMap: Map<string, GitFile['status']>;
  platform: Platform;
  renamingPath: string | null;
  onToggleDir: (path: string, wasExpanded: boolean) => void;
  onFileOpen: (path: string, filename: string) => void;
  onContextMenu: (e: React.MouseEvent, node: CodeTreeNode, parentPath: string) => void;
  onCommitRename: (node: CodeTreeNode, newName: string) => void;
  onCancelRename: () => void;
}

function FileRow({ node, depth, root, parentPath, activeTabPath, missions, statusMap, platform, renamingPath, onToggleDir, onFileOpen, onContextMenu, onCommitRename, onCancelRename }: FileRowProps) {
  const { t } = useI18n();
  const { entry } = node;
  const relPath = relativeToRoot(root, entry.path);
  const isActive = entry.path === activeTabPath;
  const isRenaming = renamingPath === entry.path;
  const activity = !entry.isDir ? findFileActivity(relPath, entry.name, missions) : null;
  const badge = !entry.isDir ? badgeForFile(relPath, entry.name, statusMap, missions) : null;
  const whoLine = activity ? fileActivityWhoLine(activity, t) : null;
  const dot = activity ? fileActivityDotChrome(activity.kind) : null;

  return (
    <div>
      <div
        role="button"
        tabIndex={isRenaming ? -1 : 0}
        onClick={() => {
          if (isRenaming) return;
          if (entry.isDir) onToggleDir(entry.path, node.isExpanded);
          else onFileOpen(entry.path, entry.name);
        }}
        onKeyDown={(e) => {
          if (isRenaming) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (entry.isDir) onToggleDir(entry.path, node.isExpanded);
            else onFileOpen(entry.path, entry.name);
          }
        }}
        onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, node, parentPath); }}
        title={whoLine ?? undefined}
        aria-label={whoLine ? `${entry.name} — ${whoLine}` : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: `7px 18px 7px ${18 + depth * 14}px`,
          cursor: 'pointer',
          background: isActive ? 'rgba(124,92,255,0.12)' : 'transparent',
          borderLeft: isActive ? '2px solid var(--color-accent)' : '2px solid transparent',
        }}
        onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.05)'; }}
        onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
      >
        {entry.isDir && (
          <span style={{ fontSize: 9, color: 'var(--color-text-disabled)', width: 8, flexShrink: 0 }}>
            {node.isExpanded ? '▼' : '▶'}
          </span>
        )}
        {isRenaming ? (
          <RenameInput
            initialValue={entry.name}
            onCommit={(name) => onCommitRename(node, name)}
            onCancel={onCancelRename}
          />
        ) : (
          <span
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 1,
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 13,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: isActive ? '#fff' : 'var(--color-text-secondary)',
                fontWeight: entry.isDir ? 600 : 400,
              }}
            >
              {entry.name}
            </span>
            {whoLine && (
              <span
                data-testid="code-file-activity-cursor"
                style={{
                  fontSize: 10.5,
                  color: 'var(--color-text-muted)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {whoLine}
              </span>
            )}
          </span>
        )}
        {!isRenaming && activity && dot && (
          <span
            data-testid="code-file-activity-dot"
            data-kind={activity.kind}
            aria-hidden
            style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}
          >
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot.color, animation: dot.animation }} />
          </span>
        )}
        {!isRenaming && badge && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              fontWeight: 700,
              flexShrink: 0,
              color: badge === '✕' ? 'var(--color-danger)' : badge === '🔒' ? 'var(--color-text-muted)' : 'var(--color-warning)',
            }}
          >
            {badge}
          </span>
        )}
      </div>
      {entry.isDir && node.isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <FileRow
              key={child.entry.path}
              node={child}
              depth={depth + 1}
              root={root}
              parentPath={entry.path}
              activeTabPath={activeTabPath}
              missions={missions}
              statusMap={statusMap}
              platform={platform}
              renamingPath={renamingPath}
              onToggleDir={onToggleDir}
              onFileOpen={onFileOpen}
              onContextMenu={onContextMenu}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Project row ───────────────────────────────────────────────────

interface ProjectRowProps {
  project: ProjectEntry;
  fleet: FleetProject | undefined;
  platform: Platform;
  activeTabPath: string | null;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  onFileOpen: (path: string, filename: string) => void;
}

export function ProjectRow({ project, fleet, platform, activeTabPath, isExpanded, onToggleExpanded, onFileOpen }: ProjectRowProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [tree, setTree] = useState<CodeTreeNode[]>([]);
  // F6 fix (post-e2e wave): a readDir failure (e.g. an unreadable/removed
  // project root, or a \\?\-prefixed path readDir can't resolve) used to be
  // silently swallowed here — the tree stayed permanently empty with the
  // exact same "Empty folder." copy as a genuinely empty project, with no
  // way to tell the two apart. Tracked separately so the row can show an
  // honest, distinct error state instead.
  const [treeError, setTreeError] = useState<string | null>(null);
  // `undefined` = not fetched yet (real "loading", shown as an explained "…"),
  // `null` = fetched and resolved to no branch (not a git repo, or the fetch
  // failed) — kept distinct from "loading" so a project this can never
  // resolve for doesn't keep showing a perpetual, unexplained "…" forever
  // (see this file's own branch-fetch effect below for the F7 fix this
  // distinction exists for: collapsed rows used to never even attempt the
  // fetch, so `branch` stayed at its old `null` initial value — visually
  // identical to "no branch" — for the entire session).
  const [branch, setBranch] = useState<string | null | undefined>(undefined);
  const [statusMap, setStatusMap] = useState<Map<string, GitFile['status']>>(new Map());
  const color = colorForProject(project.id);
  // F5 fix: ProjectEntry (the Rust ProjectRegistry wire shape) carries no
  // friendly display name at all — only `id` (an opaque registry id/hash,
  // e.g. "7f78bbcd6f353bd...") and `root` (the absolute path). Every project
  // label in this sidebar must derive its display name from basename(root),
  // the same shared helper fleetMissions.ts's FleetProject.name already uses
  // for the Cockpit's rows — never the raw registry id.
  const displayName = basename(project.root);
  const missions = fleet?.missions ?? [];
  const blockedCount = missions.filter((m) => m.status === 'running' && m.pendingQuestion).length;
  const failedCount = missions.filter((m) => m.status === 'failed').length;
  // Fix 3 (hidden-space poll gating) — AppShell.tsx keeps every VISITED
  // space mounted (`display: none` on the inactive ones, never unmounted),
  // so this row's git-status poll used to keep firing on GIT_POLL_MS forever
  // even while the user is looking at a completely different Space (Agents,
  // Brain, ...). useAppContextOptional (not the throwing useAppContext) so a
  // host with no AppProvider ancestor — this component's own existing
  // context-menu test suite renders ProjectRow standalone — keeps polling
  // exactly as before rather than crashing on a missing provider; only a
  // KNOWN, definitely-not-'code' active space actually gates the poll.
  const activeSpace = useAppContextOptional()?.activeSpace;
  const isCodeSpaceActive = activeSpace === undefined || activeSpace === 'code';

  useEffect(() => {
    if (!isExpanded || tree.length > 0 || treeError) return;
    let cancelled = false;
    loadLevel(platform, project.root)
      .then((nodes) => { if (!cancelled) setTree(nodes); })
      .catch((err: unknown) => {
        if (cancelled) return;
        setTreeError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, [isExpanded, tree.length, treeError, platform, project.root]);

  // F7 fix: this used to be gated on `isExpanded` entirely, so a COLLAPSED
  // project's branch (rendered in the header row, which is always visible —
  // unlike the file tree below it, which really is expand-gated) never got
  // fetched at all. The header's `branch ?? '…'` fallback then rendered a
  // permanently-unresolved "…" for the row's whole lifetime, indistinguishable
  // from a real loading state. Now every row does the one-shot fetch below
  // regardless of expansion; only the recurring GIT_POLL_MS poll (needed to
  // keep an EXPANDED row's file badges fresh) stays expand-gated.
  //
  // QA fix (hang guard): a REJECTED platform.git.status() already landed on
  // `null` here (distinguishable from the `undefined` loading state above)
  // — that part was already correct. What was missing: if the underlying
  // Tauri invoke() never settles at all (a wedged `git` subprocess, neither
  // resolving nor rejecting), `await` just hangs forever and `branch` stays
  // `undefined` — the same permanently-unresolved "…" F7 fixed for
  // collapsed rows, reintroduced through a different door. withTimeout
  // (GIT_STATUS_TIMEOUT_MS, see this file's top) bounds the await and
  // routes a hang into the exact same `catch` -> `setBranch(null)` path as
  // any other failure, so it resolves to the same honest "no branch" state
  // instead of an eternal ellipsis.
  //
  // Unmount audit (asked for alongside this fix): the `cancelled` flag
  // already guards every setState after both the resolve and reject paths,
  // and cleanup always sets it before the next effect run or on unmount —
  // this was already correct before this change; withTimeout's own timer
  // firing after unmount just hits the same `if (!cancelled)` no-op.
  useEffect(() => {
    if (platform.name !== 'tauri' || !isCodeSpaceActive) return;
    let cancelled = false;
    async function refresh() {
      try {
        const status = await withTimeout(platform.git.status(project.root), GIT_STATUS_TIMEOUT_MS);
        if (cancelled) return;
        setBranch(status.branch);
        setStatusMap(gitStatusMap(status.files));
      } catch {
        if (!cancelled) setBranch(null);
      }
    }
    refresh();
    if (!isExpanded) return () => { cancelled = true; };
    const interval = setInterval(refresh, GIT_POLL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, [isExpanded, platform, project.root, isCodeSpaceActive]);

  function handleToggleDir(path: string, wasExpanded: boolean) {
    setTree((prev) => {
      const next = updateNodeAt(prev, path, (node) => ({ ...node, isExpanded: !wasExpanded }));
      return next;
    });
    if (wasExpanded) return;
    loadLevel(platform, path).then((children) => {
      setTree((prev) => updateNodeAt(prev, path, (node) => ({ ...node, children, isExpanded: true })));
    }).catch(() => {});
  }

  // ── Context menu (B23) — real fs mutations against the real Platform,
  // never simulated. `refreshDir` reloads exactly the mutated directory's
  // children (the project root itself when dirPath === project.root, since
  // the root level's own children ARE `tree` — there is no wrapper node for
  // it — otherwise the matching nested node via updateNodeAt, same pattern
  // handleToggleDir above already uses for lazy-expand).
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  // Captured separately from `contextMenu` (not read from it at commit
  // time): the menu's own onClick handler calls onClose() — clearing
  // contextMenu — in the SAME tick as onRename() below, so by the time the
  // user actually commits the rename (a later render, on Enter/blur)
  // contextMenu is already null. Reading contextMenu?.parentPath there
  // would silently fall back to project.root for every nested file.
  const [renamingParentPath, setRenamingParentPath] = useState<string>(project.root);

  function handleContextMenu(e: React.MouseEvent, node: CodeTreeNode, parentPath: string) {
    setContextMenu({ x: e.clientX, y: e.clientY, node, parentPath });
  }

  async function refreshDir(dirPath: string) {
    const children = await loadLevel(platform, dirPath);
    if (dirPath === project.root) {
      setTree(children);
    } else {
      setTree((prev) => updateNodeAt(prev, dirPath, (node) => ({ ...node, children, isExpanded: true })));
    }
    emit('fs:changed', undefined);
  }

  async function handleNewFile(dirPath: string) {
    const name = window.prompt(t('fileExplorer.fileNamePrompt'));
    if (!name?.trim()) return;
    try {
      await platform.fs.createFile(joinPath(dirPath, name.trim()));
      await refreshDir(dirPath);
    } catch (err) {
      toast(t('code.palette.newFileFailed', { error: err instanceof Error ? err.message : String(err) }), 'error');
    }
  }

  async function handleNewFolder(dirPath: string) {
    const name = window.prompt(t('fileExplorer.folderNamePrompt'));
    if (!name?.trim()) return;
    try {
      await platform.fs.createDir(joinPath(dirPath, name.trim()));
      await refreshDir(dirPath);
    } catch (err) {
      toast(t('code.palette.newFolderFailed', { error: err instanceof Error ? err.message : String(err) }), 'error');
    }
  }

  async function handleCommitRename(node: CodeTreeNode, parentPath: string, newName: string) {
    setRenamingPath(null);
    if (!newName || newName === node.entry.name) return;
    try {
      await platform.fs.rename(node.entry.path, joinPath(parentPath, newName));
      await refreshDir(parentPath);
    } catch (err) {
      toast(t('code.palette.renameFailed', { error: err instanceof Error ? err.message : String(err) }), 'error');
    }
  }

  async function handleDelete(node: CodeTreeNode, parentPath: string) {
    const confirmed = window.confirm(t('code.confirmDelete', { name: node.entry.name }));
    if (!confirmed) return;
    try {
      await platform.fs.remove(node.entry.path);
      await refreshDir(parentPath);
    } catch (err) {
      toast(t('code.palette.deleteFailed', { error: err instanceof Error ? err.message : String(err) }), 'error');
    }
  }

  return (
    <div style={{ borderBottom: '1px solid var(--color-border-3)', paddingBottom: 6 }}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        onClick={onToggleExpanded}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggleExpanded();
          }
        }}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px 8px', cursor: 'pointer' }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.03)'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
      >
        <span style={{ fontSize: 10, color: 'var(--color-text-disabled)', width: 8 }}>{isExpanded ? '▼' : '▶'}</span>
        {/* Purely a per-project identity color (colorForProject — a stable hash
            of project.id, see projectColors.ts), reused across tabs/Cockpit/
            this sidebar so the same project always reads as the same hue. It
            carries NO status meaning (build/git/mission health lives in the
            blocked/failed badge to the right, and in each file row's own
            activity dot) — the tooltip exists so that isn't assumed. */}
        <span
          title={t('codespace.projects.colorDotTooltip', { name: displayName })}
          style={{ width: 10, height: 10, borderRadius: 3, background: color, flexShrink: 0 }}
        />
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text)' }}>{displayName}</span>
        {branch === undefined ? (
          <span
            title={t('codespace.projects.branchLoading')}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--color-text-disabled)' }}
          >
            …
          </span>
        ) : branch ? (
          <span
            title={t('codespace.projects.branchTooltip', { branch })}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--color-text-muted)' }}
          >
            {branch}
          </span>
        ) : null}
        {(blockedCount > 0 || failedCount > 0) && (
          <span
            style={{
              marginLeft: 'auto',
              background: 'var(--color-danger)',
              color: 'var(--color-panel)',
              borderRadius: 4,
              padding: '1px 7px',
              fontSize: 10.5,
              fontWeight: 700,
            }}
          >
            {blockedCount > 0 ? `⏸ ${blockedCount}` : `✕ ${failedCount}`}
          </span>
        )}
      </div>
      {isExpanded && (
        <div>
          {treeError ? (
            <div
              data-testid={`project-tree-error-${project.id}`}
              style={{ padding: '6px 18px', fontSize: 11.5, color: 'var(--color-danger-text)' }}
              title={treeError}
            >
              {t('codespace.projects.treeError')}
            </div>
          ) : tree.length === 0 ? (
            <div style={{ padding: '6px 18px', fontSize: 11.5, color: 'var(--color-text-disabled)' }}>
              {t('codespace.projects.emptyTree')}
            </div>
          ) : (
            tree.map((node) => (
              <FileRow
                key={node.entry.path}
                node={node}
                depth={0}
                root={project.root}
                parentPath={project.root}
                activeTabPath={activeTabPath}
                missions={missions}
                statusMap={statusMap}
                platform={platform}
                renamingPath={renamingPath}
                onToggleDir={handleToggleDir}
                onFileOpen={onFileOpen}
                onContextMenu={handleContextMenu}
                onCommitRename={(n, newName) => handleCommitRename(n, renamingParentPath, newName)}
                onCancelRename={() => setRenamingPath(null)}
              />
            ))
          )}
        </div>
      )}
      {contextMenu && (
        <FileTreeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          node={contextMenu.node}
          onNewFile={() => handleNewFile(contextMenu.node.entry.isDir ? contextMenu.node.entry.path : contextMenu.parentPath)}
          onNewFolder={() => handleNewFolder(contextMenu.node.entry.isDir ? contextMenu.node.entry.path : contextMenu.parentPath)}
          onRename={() => { setRenamingParentPath(contextMenu.parentPath); setRenamingPath(contextMenu.node.entry.path); }}
          onDelete={() => handleDelete(contextMenu.node, contextMenu.parentPath)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

// ── Section ───────────────────────────────────────────────────────

interface CodeSidebarProjectsProps {
  openProjects: ProjectEntry[];
  /** F6 fix (post-e2e wave): drives ordering (active project first) and the
   *  default expand state (active expanded, others collapsed by default —
   *  still individually toggleable). */
  activeProjectId: string | null;
  fleetProjects: FleetProject[];
  platform: Platform;
  activeTabPath: string | null;
  onFileOpen: (path: string, filename: string) => void;
  onOpenProject: () => void;
}

export function CodeSidebarProjects({ openProjects, activeProjectId, fleetProjects, platform, activeTabPath, onFileOpen, onOpenProject }: CodeSidebarProjectsProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // F6 fix: every open project must render as its own collapsible section —
  // active project FIRST and expanded by default; the rest keep their
  // openProjects order, collapsed by default (still individually
  // toggleable) so a multi-project sidebar doesn't default to N full trees
  // at once.
  const orderedProjects = useMemo(
    () => orderActiveFirst(openProjects, activeProjectId),
    [openProjects, activeProjectId],
  );

  function defaultExpanded(projectId: string): boolean {
    return projectId === activeProjectId;
  }

  return (
    <div>
      <div style={{ padding: '14px 18px 10px', display: 'flex', alignItems: 'center' }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 1.8, color: 'var(--color-text-muted)', textTransform: 'uppercase' }}>
          {t('codespace.projects.title')}
        </span>
        <button
          onClick={onOpenProject}
          style={{
            marginLeft: 'auto',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 12.5,
            fontFamily: 'inherit',
            color: 'var(--color-accent-pale)',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-accent-lighter)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-accent-pale)'; }}
        >
          {t('codespace.projects.open')}
        </button>
      </div>
      {openProjects.length === 0 ? (
        <div style={{ padding: '4px 18px 14px', fontSize: 12, color: 'var(--color-text-disabled)' }}>
          {t('codespace.projects.none')}
        </div>
      ) : (
        orderedProjects.map((project) => (
          <ProjectRow
            key={project.id}
            project={project}
            fleet={fleetProjects.find((p) => p.root === project.root)}
            platform={platform}
            activeTabPath={activeTabPath}
            isExpanded={expanded[project.id] ?? defaultExpanded(project.id)}
            onToggleExpanded={() => setExpanded((prev) => ({ ...prev, [project.id]: !(prev[project.id] ?? defaultExpanded(project.id)) }))}
            onFileOpen={(path, filename) => onFileOpen(path, filename)}
          />
        ))
      )}
    </div>
  );
}
