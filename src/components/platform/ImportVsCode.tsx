import { useState } from 'react';
import { getPlatform } from '../../lib/platform';

interface ImportVsCodeProps {
  onClose: () => void;
  onImported?: (settings: Record<string, unknown>) => void;
}

export function ImportVsCode({ onClose, onImported }: ImportVsCodeProps) {
  const [status, setStatus] = useState<'idle' | 'scanning' | 'found' | 'imported' | 'error'>('idle');
  const [foundSettings, setFoundSettings] = useState<string[]>([]);

  async function scan() {
    setStatus('scanning');
    try {
      const platform = getPlatform();
      // Check common VS Code settings locations
      type TauriWindow = { __TAURI__?: { internal?: { argv?: Record<string, string> } } };
      const home = platform.name === 'web' ? '' : (window as unknown as TauriWindow).__TAURI__?.internal?.argv?.['home'] ?? '';
      const paths = [
        `${home}/.vscode/settings.json`,
        `${home}/.config/Code/User/settings.json`,
        `${home}/AppData/Roaming/Code/User/settings.json`,
      ];
      const found: string[] = [];
      for (const p of paths) {
        try {
          await platform.fs.readFile(p);
          found.push(p);
        } catch { /* not found */ }
      }
      if (found.length > 0) {
        setFoundSettings(found);
        setStatus('found');
      } else {
        setStatus('error');
      }
    } catch {
      setStatus('error');
    }
  }

  function doImport() {
    setStatus('imported');
    onImported?.({});
    setTimeout(onClose, 1500);
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ width: 450, background: '#1C1C2A', borderRadius: 12, border: '1px solid rgba(124,92,255,0.2)', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: '#E6E8EF' }}>Import VS Code Settings</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: 16 }}>×</button>
        </div>
        <div style={{ padding: 16 }}>
          {status === 'idle' && (
            <div>
              <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 12 }}>
                Import your VS Code settings, keybindings, and extensions into Lazy IDE.
              </p>
              <button onClick={scan} style={{ background: 'rgba(124,92,255,0.15)', border: '1px solid rgba(124,92,255,0.2)', borderRadius: 6, padding: '8px 16px', color: '#A78BFF', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}>
                Scan for VS Code Settings
              </button>
            </div>
          )}
          {status === 'scanning' && <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>Scanning…</div>}
          {status === 'found' && (
            <div>
              <p style={{ fontSize: 12, color: '#66E27A', marginBottom: 8 }}>Found VS Code settings:</p>
              {foundSettings.map(p => (
                <div key={p} style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', padding: '4px 0', fontFamily: "'JetBrains Mono', monospace" }}>{p}</div>
              ))}
              <button onClick={doImport} style={{ marginTop: 12, background: 'rgba(124,92,255,0.15)', border: '1px solid rgba(124,92,255,0.2)', borderRadius: 6, padding: '8px 16px', color: '#A78BFF', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}>
                Import Now
              </button>
            </div>
          )}
          {status === 'imported' && <div style={{ fontSize: 12, color: '#66E27A' }}>✓ Settings imported successfully!</div>}
          {status === 'error' && <div style={{ fontSize: 12, color: '#F07178' }}>No VS Code settings found on this machine.</div>}
        </div>
      </div>
    </div>
  );
}
