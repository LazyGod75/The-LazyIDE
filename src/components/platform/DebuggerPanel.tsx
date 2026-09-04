import { useState } from 'react';
import { ComingSoon } from './ComingSoon';

interface DebuggerPanelProps {
  onClose: () => void;
}

interface Breakpoint {
  id: string;
  file: string;
  line: number;
  enabled: boolean;
}

interface DebugFrame {
  id: string;
  file: string;
  line: number;
  function: string;
  variables: Array<{ name: string; value: string }>;
}

export function DebuggerPanel({ onClose }: DebuggerPanelProps) {
  const [breakpoints, setBreakpoints] = useState<Breakpoint[]>([]);
  const [running, setRunning] = useState(false);
  const [frames] = useState<DebugFrame[]>([]);
  const [output, setOutput] = useState<string[]>([]);

  function toggleBreakpoint(id: string) {
    setBreakpoints(prev => prev.map(b => b.id === id ? { ...b, enabled: !b.enabled } : b));
  }

  function removeBreakpoint(id: string) {
    setBreakpoints(prev => prev.filter(b => b.id !== id));
  }

  function startDebug() {
    setRunning(true);
    setOutput(prev => [...prev, '[Debug] Starting session...']);
    setTimeout(() => {
      setOutput(prev => [...prev, '[Debug] Session ended (no debugger attached)']);
      setRunning(false);
    }, 1000);
  }

  function stopDebug() {
    setRunning(false);
    setOutput(prev => [...prev, '[Debug] Session stopped']);
  }

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', background: '#0E0E12' }}>
      <ComingSoon label="Debugger" />
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
        <button onClick={startDebug} disabled={running} style={{ background: 'rgba(102,226,122,0.1)', border: '1px solid rgba(102,226,122,0.2)', borderRadius: 4, padding: '3px 10px', color: '#66E27A', cursor: running ? 'not-allowed' : 'pointer', fontSize: 11, fontFamily: 'inherit', opacity: running ? 0.5 : 1 }}>
          ▶ Run
        </button>
        <button onClick={stopDebug} disabled={!running} style={{ background: 'rgba(240,113,120,0.1)', border: '1px solid rgba(240,113,120,0.2)', borderRadius: 4, padding: '3px 10px', color: '#F07178', cursor: running ? 'pointer' : 'not-allowed', fontSize: 11, fontFamily: 'inherit', opacity: running ? 1 : 0.5 }}>
          ■ Stop
        </button>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: 14 }}>×</button>
      </div>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left: Breakpoints */}
        <div style={{ width: 250, borderRight: '1px solid rgba(255,255,255,0.07)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '6px 10px', fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Breakpoints
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {breakpoints.length === 0 && (
              <div style={{ padding: 12, fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>No breakpoints set</div>
            )}
            {breakpoints.map(bp => (
              <div key={bp.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 10px', fontSize: 11 }}>
                <button onClick={() => toggleBreakpoint(bp.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: bp.enabled ? '#F07178' : 'rgba(255,255,255,0.2)' }}>
                  {bp.enabled ? '🔴' : '⚪'}
                </button>
                <span style={{ flex: 1, color: 'rgba(255,255,255,0.5)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {bp.file}:{bp.line}
                </span>
                <button onClick={() => removeBreakpoint(bp.id)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.2)', cursor: 'pointer', fontSize: 12 }}>×</button>
              </div>
            ))}
          </div>
        </div>

        {/* Right: Call stack + variables + output */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '6px 10px', fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Call Stack
          </div>
          <div style={{ flex: 0, maxHeight: 120, overflowY: 'auto' }}>
            {frames.length === 0 && <div style={{ padding: 12, fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>Not paused</div>}
            {frames.map(f => (
              <div key={f.id} style={{ padding: '3px 10px', fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
                {f.function} <span style={{ color: 'rgba(255,255,255,0.3)' }}>at {f.file}:{f.line}</span>
              </div>
            ))}
          </div>
          <div style={{ padding: '6px 10px', fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.06em', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
            Variables
          </div>
          <div style={{ flex: 0, maxHeight: 120, overflowY: 'auto' }}>
            {frames.length === 0 && <div style={{ padding: 12, fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>No variables</div>}
          </div>
          <div style={{ padding: '6px 10px', fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.06em', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
            Output
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '4px 10px', fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
            {output.map((line, i) => (
              <div key={i} style={{ color: 'rgba(255,255,255,0.4)', whiteSpace: 'pre-wrap' }}>{line}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
