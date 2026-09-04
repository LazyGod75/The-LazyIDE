import { useState, useCallback } from 'react';

interface PortForward {
  id: string;
  localPort: number;
  remotePort: number;
  remoteHost: string;
  status: 'active' | 'error' | 'connecting';
}

export function PortForwardingPanel() {
  const [forwards, setForwards] = useState<PortForward[]>([]);
  const [localPort, setLocalPort] = useState('');
  const [remotePort, setRemotePort] = useState('');
  const [remoteHost, setRemoteHost] = useState('localhost');

  const addForward = useCallback(() => {
    const lp = parseInt(localPort);
    const rp = parseInt(remotePort);
    if (!lp || !rp) return;
    const id = `fwd-${Date.now()}`;
    setForwards(prev => [...prev, {
      id,
      localPort: lp,
      remotePort: rp,
      remoteHost: remoteHost || 'localhost',
      status: 'connecting',
    }]);
    // Simulate connection
    setTimeout(() => {
      setForwards(prev => prev.map(f => f.id === id ? { ...f, status: 'active' } : f));
    }, 500);
    setLocalPort('');
    setRemotePort('');
  }, [localPort, remotePort, remoteHost]);

  const removeForward = useCallback((id: string) => {
    setForwards(prev => prev.filter(f => f.id !== id));
  }, []);

  const statusColor: Record<string, string> = {
    active: '#66E27A',
    error: '#F07178',
    connecting: '#FFC76B',
  };

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.7)' }}>Port Forwarding</div>
      
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          value={localPort}
          onChange={e => setLocalPort(e.target.value)}
          placeholder="Local"
          style={{ width: 60, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, padding: '4px 6px', color: '#D5D8E0', fontSize: 11, fontFamily: 'inherit', outline: 'none' }}
        />
        <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: 11 }}>→</span>
        <input
          value={remoteHost}
          onChange={e => setRemoteHost(e.target.value)}
          placeholder="Host"
          style={{ width: 80, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, padding: '4px 6px', color: '#D5D8E0', fontSize: 11, fontFamily: 'inherit', outline: 'none' }}
        />
        <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: 11 }}>:</span>
        <input
          value={remotePort}
          onChange={e => setRemotePort(e.target.value)}
          placeholder="Port"
          style={{ width: 60, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, padding: '4px 6px', color: '#D5D8E0', fontSize: 11, fontFamily: 'inherit', outline: 'none' }}
        />
        <button onClick={addForward} style={{ background: 'rgba(124,92,255,0.15)', border: '1px solid rgba(124,92,255,0.2)', borderRadius: 4, padding: '4px 10px', color: '#A78BFF', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}>
          Add
        </button>
      </div>

      {forwards.map(f => (
        <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'rgba(255,255,255,0.03)', borderRadius: 4, fontSize: 11 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor[f.status], flexShrink: 0 }} />
          <span style={{ color: '#D5D8E0' }}>localhost:{f.localPort}</span>
          <span style={{ color: 'rgba(255,255,255,0.3)' }}>→</span>
          <span style={{ color: '#D5D8E0' }}>{f.remoteHost}:{f.remotePort}</span>
          <span style={{ flex: 1 }} />
          <span style={{ color: statusColor[f.status], fontSize: 10, textTransform: 'uppercase' }}>{f.status}</span>
          <button onClick={() => removeForward(f.id)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.2)', cursor: 'pointer', fontSize: 14 }}>×</button>
        </div>
      ))}

      {forwards.length === 0 && (
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>No forwarded ports</div>
      )}
    </div>
  );
}
