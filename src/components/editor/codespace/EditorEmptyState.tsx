/* EditorEmptyState — what CenterEditor.tsx shows in place of a file when no
   tab is open (fresh Code space visit, or the last tab just closed). Replaces
   the previous single centered line of grey text with something a user can
   actually act on: the project's real recently-opened files (recentFiles.ts
   — an honest MRU, never fabricated placeholder rows), the real Mod+K/Mod+P
   shortcut that already opens the command palette (AppShell.tsx), and the
   existing "New file" action CenterEditor already implements for the
   command palette. No new capability is invented here — only surfaced.
*/

import { useI18n } from '../../../i18n';
import { isMacPlatform } from '../../../lib/shortcuts/platform';
import { relativeToRoot } from './fileTree';
import type { RecentFileEntry } from '../../../lib/editor/recentFiles';

interface EditorEmptyStateProps {
  recentFiles: RecentFileEntry[];
  projectRoot: string;
  onOpenRecentFile: (file: RecentFileEntry) => void;
  onNewFile: () => void;
}

export function EditorEmptyState({ recentFiles, projectRoot, onOpenRecentFile, onNewFile }: EditorEmptyStateProps) {
  const { t } = useI18n();
  const paletteCombo = isMacPlatform() ? '⌘K' : 'Ctrl+K';

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--color-bg)',
        overflow: 'auto',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18, maxWidth: 340, padding: 32 }}>
        <svg width="36" height="36" viewBox="0 0 36 36" fill="none" style={{ opacity: 0.15, flexShrink: 0 }}>
          <path d="M8 3h13l7 7v23H8z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M21 3v7h7" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        </svg>

        <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.35)', fontWeight: 500, textAlign: 'center' }}>
          {t('code.emptyState.title')}
        </div>

        {recentFiles.length > 0 && (
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: 1.4,
                textTransform: 'uppercase',
                color: 'var(--color-text-disabled)',
                padding: '0 4px 4px',
              }}
            >
              {t('code.emptyState.recentFiles')}
            </div>
            {recentFiles.map((file) => {
              const relPath = relativeToRoot(projectRoot, file.path);
              const dirEnd = Math.max(relPath.lastIndexOf('/'), relPath.lastIndexOf('\\'));
              // A top-level file (no separator in its relative path) has no
              // directory to show — dirEnd is -1, not "the whole relative
              // path", so it never falsely renders its own filename again as
              // a fake "directory" badge next to itself.
              const relDir = dirEnd === -1 ? '' : relPath.slice(0, dirEnd);
              const showDir = relDir.length > 0;
              return (
                <button
                  key={file.path}
                  onClick={() => onOpenRecentFile(file)}
                  title={file.path}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 8,
                    width: '100%',
                    textAlign: 'left',
                    background: 'transparent',
                    border: 'none',
                    borderRadius: 6,
                    padding: '6px 8px',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(124,92,255,0.1)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12.5,
                      color: 'rgba(255,255,255,0.65)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flexShrink: 1,
                    }}
                  >
                    {file.filename}
                  </span>
                  {showDir && (
                    <span
                      style={{
                        fontSize: 10.5,
                        color: 'var(--color-text-disabled)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        minWidth: 0,
                      }}
                    >
                      {relDir}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--color-text-disabled)' }}>
          <kbd
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              padding: '2px 6px',
              borderRadius: 4,
              border: '1px solid var(--color-border-2)',
              color: 'rgba(255,255,255,0.5)',
              background: 'rgba(255,255,255,0.04)',
            }}
          >
            {paletteCombo}
          </kbd>
          <span>{t('code.emptyState.paletteHint')}</span>
        </div>

        <button
          onClick={onNewFile}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 11.5,
            fontFamily: 'inherit',
            color: 'var(--color-accent-pale)',
            padding: 0,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-accent-lighter)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-accent-pale)'; }}
        >
          {t('code.emptyState.newFile')}
        </button>
      </div>
    </div>
  );
}
