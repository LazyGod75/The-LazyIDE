/* CanvasToolActivityOverlay — shows real-time visual notifications on the
   canvas when an agent uses a "visual" tool (browser, MCP, web/localhost).

   Subscribes to the 'canvas:toolActivity' bus event and renders a
   floating toast-like notification that slides in from the right edge,
   shows the tool name + detail, then auto-fades after ~4s.

   Multiple notifications stack vertically. Each shows an icon matching
   the tool category:
   - browser: a window/globe icon (Chromium actions)
   - mcp: a plug icon (MCP server calls)
   - web: a search/globe icon (web_fetch, web_search)
*/

import { useEffect, useState, useCallback } from 'react';
import { on, type BusEvents } from '../../../lib/bus';

interface ToolActivity {
  id: number;
  missionId: string;
  toolName: string;
  label: string;
  icon: 'browser' | 'mcp' | 'web';
  detail?: string;
  timestamp: number;
}

let nextId = 1;

function ToolIcon({ icon }: { icon: 'browser' | 'mcp' | 'web' }) {
  if (icon === 'browser') {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M2 7h20" />
        <circle cx="5" cy="5" r="0.5" fill="currentColor" />
        <circle cx="7" cy="5" r="0.5" fill="currentColor" />
      </svg>
    );
  }
  if (icon === 'mcp') {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 2v6" />
        <path d="M15 2v6" />
        <path d="M5 8h14" />
        <path d="M12 8v14" />
      </svg>
    );
  }
  // web
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function iconColor(icon: 'browser' | 'mcp' | 'web'): string {
  if (icon === 'browser') return '#7C5CFF';
  if (icon === 'mcp') return '#66E27A';
  return '#F0A050';
}

export function CanvasToolActivityOverlay() {
  const [activities, setActivities] = useState<ToolActivity[]>([]);

  const removeActivity = useCallback((id: number) => {
    setActivities((prev) => prev.filter((a) => a.id !== id));
  }, []);

  useEffect(() => {
    const unsub = on('canvas:toolActivity', (payload: BusEvents['canvas:toolActivity']) => {
      const activity: ToolActivity = {
        id: nextId++,
        missionId: payload.missionId,
        toolName: payload.toolName,
        label: payload.label,
        icon: payload.icon,
        detail: payload.detail,
        timestamp: Date.now(),
      };
      setActivities((prev) => [...prev.slice(-4), activity]);
      // Auto-remove after 4.5s
      setTimeout(() => removeActivity(activity.id), 4500);
    });
    return unsub;
  }, [removeActivity]);

  if (activities.length === 0) return null;

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 16,
        right: 70,
        display: 'flex',
        flexDirection: 'column-reverse',
        gap: 8,
        zIndex: 600,
        pointerEvents: 'none',
      }}
    >
      {activities.map((activity) => (
        <div
          key={activity.id}
          data-testid={`canvas-tool-activity-${activity.toolName}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 14px',
            borderRadius: 10,
            background: 'var(--color-panel-2)',
            border: `1px solid ${iconColor(activity.icon)}40`,
            boxShadow: `0 4px 16px rgba(0,0,0,0.35), 0 0 0 1px ${iconColor(activity.icon)}15`,
            color: '#E2E2F0',
            fontSize: 12,
            fontFamily: 'inherit',
            maxWidth: 320,
            animation: 'canvas-tool-slide-in 250ms ease-out',
            overflow: 'hidden',
          }}
        >
          {/* Icon with pulse animation */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: '50%',
              background: `${iconColor(activity.icon)}15`,
              color: iconColor(activity.icon),
              flexShrink: 0,
              animation: 'canvas-tool-pulse 1.5s ease-in-out infinite',
            }}
          >
            <ToolIcon icon={activity.icon} />
          </div>
          {/* Text */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontWeight: 600,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}>
              {activity.label}
            </div>
            {activity.detail && (
              <div style={{
                fontSize: 11,
                color: 'rgba(255,255,255,0.45)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}>
                {activity.detail}
              </div>
            )}
          </div>
        </div>
      ))}
      {/* Keyframes — injected once */}
      <style>{`
        @keyframes canvas-tool-slide-in {
          from { opacity: 0; transform: translateX(40px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes canvas-tool-pulse {
          0%, 100% { box-shadow: 0 0 0 0 currentColor; opacity: 1; }
          50% { box-shadow: 0 0 0 4px transparent; opacity: 0.7; }
        }
      `}</style>
    </div>
  );
}
