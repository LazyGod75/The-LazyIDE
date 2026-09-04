/* CodeLiveFiles — Code sidebar strip of files agents are on right now.
   Honest fleet diffFiles only (collectCodeLiveFiles). Click opens the file. */

import { collectCodeLiveFiles } from '../../../lib/agents/codeLiveFiles';
import { fileActivityDotChrome, fileActivityWhoLine } from '../../../lib/agents/codeFileActivity';
import type { FleetProject } from '../../../lib/agents/fleetMissions';
import { useI18n } from '../../../i18n';

interface CodeLiveFilesProps {
  fleetProjects: FleetProject[];
  onFileOpen: (path: string, filename: string) => void;
}

export function CodeLiveFiles({ fleetProjects, onFileOpen }: CodeLiveFilesProps) {
  const { t } = useI18n();
  const files = collectCodeLiveFiles(fleetProjects);
  if (files.length === 0) return null;

  return (
    <div data-testid="code-live-files" style={{ padding: '12px 18px 4px' }}>
      <div
        style={{
          fontSize: 11.5,
          fontWeight: 700,
          letterSpacing: 1.8,
          color: 'var(--color-text-muted)',
          textTransform: 'uppercase',
          marginBottom: 8,
        }}
      >
        {t('codespace.liveFiles.title')}
      </div>
      {files.map((file) => {
        const chrome = fileActivityDotChrome(file.activity.kind);
        return (
          <button
            key={file.absPath}
            type="button"
            data-testid="code-live-file-row"
            data-kind={file.activity.kind}
            onClick={() => onFileOpen(file.absPath, file.filename)}
            title={fileActivityWhoLine(file.activity, t)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left',
              fontFamily: 'inherit',
              color: 'inherit',
              padding: '5px 0',
            }}
          >
            <span
              aria-hidden
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: chrome.color,
                animation: chrome.animation,
                flexShrink: 0,
              }}
            />
            <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
              <span
                style={{
                  fontSize: 12.5,
                  fontWeight: 650,
                  color: 'var(--color-text)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {file.filename}
              </span>
              <span
                data-testid="code-live-file-cursor"
                style={{
                  fontSize: 11,
                  color: 'var(--color-text-muted)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {fileActivityWhoLine(file.activity, t)}
                {' · '}
                {file.projectName}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
