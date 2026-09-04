import { ComingSoon } from './ComingSoon';

export function DockerPanel() {
  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', background: '#0E0E12' }}>
      <ComingSoon label="Docker" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.7)' }}>Docker</span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ padding: 12, fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>No containers running</div>
      </div>
    </div>
  );
}
