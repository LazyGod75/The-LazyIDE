/**
 * ApplyEditModal — shows a side-by-side diff preview between the current
 * editor content and the proposed content from an 'editor:applyEdit' bus event.
 * Accept applies the proposed content into the editor buffer + marks dirty.
 * Reject closes the modal without any change.
 */
import { useCallback, useEffect, useMemo } from 'react';
import { MergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { lineNumbers } from '@codemirror/view';
import { lazyTheme } from './lazyTheme';
import type { Extension } from '@codemirror/state';

interface ApplyEditModalProps {
  currentContent: string;
  proposedContent: string;
  filename: string;
  onAccept: (proposed: string) => void;
  onReject: () => void;
}

function getLanguageExtension(filename: string): Extension | null {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
      return javascript({ typescript: true, jsx: true });
    case 'json':
      return json();
    case 'md':
      return markdown();
    case 'css':
      return css();
    case 'html':
      return html();
    case 'py':
      return python();
    case 'rs':
      return rust();
    default:
      return null;
  }
}

/** Mounts a @codemirror/merge MergeView inside a div ref. */
function MergeViewPanel({
  original,
  modified,
  filename,
}: {
  original: string;
  modified: string;
  filename: string;
}) {
  const lang = useMemo(() => getLanguageExtension(filename), [filename]);
  const sharedExtensions = useMemo<Extension[]>(() => {
    const base: Extension[] = [lineNumbers(), ...lazyTheme];
    if (lang) base.push(lang);
    return base;
  }, [lang]);

  const containerRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return;
      // Remove any previous instance.
      el.innerHTML = '';
      new MergeView({
        parent: el,
        a: {
          doc: original,
          extensions: [...sharedExtensions, EditorState.readOnly.of(true)],
        },
        b: {
          doc: modified,
          extensions: [...sharedExtensions, EditorState.readOnly.of(true)],
        },
        gutter: true,
        collapseUnchanged: { margin: 3, minSize: 4 },
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [original, modified, filename],
  );

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        overflow: 'auto',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: '12px',
      }}
    />
  );
}

export function ApplyEditModal({
  currentContent,
  proposedContent,
  filename,
  onAccept,
  onReject,
}: ApplyEditModalProps) {
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onReject();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onReject]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={e => {
        // Close on backdrop click
        if (e.target === e.currentTarget) onReject();
      }}
    >
      <div
        style={{
          width: '90vw',
          maxWidth: 1200,
          height: '80vh',
          background: 'var(--color-panel, #1C1C2A)',
          borderRadius: 8,
          border: '1px solid rgba(255,255,255,0.07)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '10px 16px',
            borderBottom: '1px solid rgba(255,255,255,0.07)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexShrink: 0,
          }}
        >
          <span style={{ flex: 1, fontSize: 13, color: 'rgba(255,255,255,0.7)', fontWeight: 500 }}>
            Diff preview — {filename}
          </span>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>
            Current (left) vs Proposed (right)
          </span>
        </div>

        {/* Diff area */}
        <MergeViewPanel
          original={currentContent}
          modified={proposedContent}
          filename={filename}
        />

        {/* Action buttons */}
        <div
          style={{
            padding: '10px 16px',
            borderTop: '1px solid rgba(255,255,255,0.07)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            flexShrink: 0,
          }}
        >
          <button
            onClick={onReject}
            style={{
              padding: '6px 18px',
              fontSize: 12,
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.2)',
              color: 'rgba(255,255,255,0.6)',
              borderRadius: 5,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            <>Reject <kbd style={{ background: 'rgba(255,255,255,0.08)', borderRadius: 3, padding: '1px 5px', fontSize: 10, fontFamily: 'inherit', border: '1px solid rgba(255,255,255,0.12)' }}>Esc</kbd></>
          </button>
          <button
            onClick={() => onAccept(proposedContent)}
            style={{
              padding: '6px 18px',
              fontSize: 12,
              background: '#7C5CFF',
              border: 'none',
              color: '#fff',
              borderRadius: 5,
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontWeight: 500,
            }}
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
