/* CanvasBrowserPanel — persistent browser state panel for the Agent Canvas.

   Subscribes to 'browser:stateChange' bus events (emitted by browserController)
   and renders a compact, always-visible panel showing the current browser
   state: open/closed, URL, page title, last action, and an optional
   screenshot thumbnail.

   When the browser is closed, the panel collapses to a minimal "Browser: idle"
   badge. When open, it expands to show the current URL + last action with a
   pulse animation while an action is in progress.

   Sits alongside CanvasToolActivityOverlay — that component shows ephemeral
   toasts for each tool call; this one shows the PERSISTENT state.
*/

import { useEffect, useState, useRef } from 'react';
import { on, type BusEvents } from '../../../lib/bus';

type BrowserState = BusEvents['browser:stateChange'];

const ACTION_LABELS: Record<string, string> = {
  open: 'Opening',
  navigate: 'Navigating',
  click: 'Clicking',
  fill: 'Filling',
  screenshot: 'Screenshot',
  snapshot: 'Snapshot',
  close: 'Closing',
};

export function CanvasBrowserPanel() {
  const [state, setState] = useState<BrowserState | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const actionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsub = on('browser:stateChange', (payload: BrowserState) => {
      setState(payload);
      // Auto-expand when browser opens, auto-collapse when closed
      if (payload.isOpen) setCollapsed(false);
      // Clear any pending "action done" timer
      if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
      // Set a timer to mark the action as "done" after 1.5s
      actionTimerRef.current = setTimeout(() => {
        setState((prev) => prev ? { ...prev, lastAction: `${prev.lastAction}:done` } : prev);
      }, 1500);
    });
    return () => {
      unsub();
      if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
    };
  }, []);

  const [now, setNow] = useState(0);

  useEffect(() => {
    if (state) setNow(Date.now());
  }, [state]);

  if (!state || (!state.isOpen && state.lastAction !== 'close')) {
    // Browser not open and no recent activity — show minimal badge
    if (!state || (!state.isOpen && now - state.lastActionAt > 5000)) {
      return null;
    }
  }

  const isClosed = !state.isOpen;
  const isActing = state.lastAction && !state.lastAction.endsWith(':done') && now - state.lastActionAt < 1500;

  if (isClosed && now - state.lastActionAt > 3000) return null;

  if (collapsed) {
    return (
      <div
        data-testid="canvas-browser-panel-collapsed"
        onClick={() => setCollapsed(false)}
        style={{
          position: 'absolute',
          bottom: 16,
          left: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 12px',
          borderRadius: 8,
          background: 'var(--color-panel-2)',
          border: '1px solid rgba(124, 92, 255, 0.2)',
          color: '#E2E2F0',
          fontSize: 11,
          fontFamily: 'inherit',
          cursor: 'pointer',
          zIndex: 600,
          pointerEvents: 'auto',
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7C5CFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <path d="M2 7h20" />
        </svg>
        Browser
      </div>
    );
  }

  return (
    <div
      data-testid="canvas-browser-panel"
      style={{
        position: 'absolute',
        bottom: 16,
        left: 16,
        width: 280,
        borderRadius: 12,
        background: 'var(--color-panel-2)',
        border: '1px solid rgba(124, 92, 255, 0.25)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
        overflow: 'hidden',
        zIndex: 600,
        pointerEvents: 'auto',
        fontFamily: 'inherit',
        animation: 'canvas-browser-slide-in 200ms ease-out',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          cursor: 'pointer',
        }}
        onClick={() => setCollapsed(true)}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            borderRadius: '50%',
            background: isClosed ? 'rgba(255,255,255,0.05)' : 'rgba(124, 92, 255, 0.15)',
            color: isClosed ? 'rgba(255,255,255,0.3)' : '#7C5CFF',
            flexShrink: 0,
            animation: isActing ? 'canvas-browser-pulse 1s ease-in-out infinite' : 'none',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <path d="M2 7h20" />
            <circle cx="5" cy="5" r="0.5" fill="currentColor" />
            <circle cx="7" cy="5" r="0.5" fill="currentColor" />
          </svg>
        </div>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#E2E2F0', flex: 1 }}>
          {isClosed ? 'Browser closed' : 'Browser'}
        </span>
        {isActing && (
          <span style={{ fontSize: 10, color: '#7C5CFF', fontWeight: 500 }}>
            {ACTION_LABELS[state.lastAction] ?? state.lastAction}…
          </span>
        )}
        {/* Collapse chevron */}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </div>

      {/* Body — only when open */}
      {state.isOpen && (
        <div style={{ padding: '8px 12px' }}>
          {/* URL */}
          {state.url && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginBottom: 2 }}>URL</div>
              <div
                style={{
                  fontSize: 11,
                  color: '#E2E2F0',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {state.url}
              </div>
            </div>
          )}
          {/* Title */}
          {state.title && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginBottom: 2 }}>Page</div>
              <div
                style={{
                  fontSize: 11,
                  color: 'rgba(255,255,255,0.7)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {state.title}
              </div>
            </div>
          )}
          {/* Last action */}
          <div>
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginBottom: 2 }}>Last action</div>
            <div style={{ fontSize: 11, color: isActing ? '#7C5CFF' : 'rgba(255,255,255,0.5)' }}>
              {ACTION_LABELS[state.lastAction.replace(':done', '')] ?? state.lastAction.replace(':done', '')}
              {state.lastActionDetail && ` — ${state.lastActionDetail}`}
            </div>
          </div>
          {/* Screenshot thumbnail */}
          {state.screenshotDataUrl && (
            <div style={{ marginTop: 8, borderRadius: 6, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}>
              <img
                src={state.screenshotDataUrl}
                alt="Browser screenshot"
                style={{ width: '100%', display: 'block' }}
              />
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes canvas-browser-slide-in {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes canvas-browser-pulse {
          0%, 100% { box-shadow: 0 0 0 0 #7C5CFF; opacity: 1; }
          50% { box-shadow: 0 0 0 4px transparent; opacity: 0.7; }
        }
      `}</style>
    </div>
  );
}
