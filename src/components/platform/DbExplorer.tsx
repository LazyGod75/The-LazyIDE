import { ComingSoon } from './ComingSoon';

export function DbExplorer() {
  return (
    <div style={{ position: 'relative', display: 'flex', height: '100%', background: '#0E0E12' }}>
      <ComingSoon label="Database Explorer" />
      {/* Table list */}
      <div style={{ width: 200, borderRight: '1px solid rgba(255,255,255,0.07)', overflowY: 'auto', flexShrink: 0 }}>
        <div style={{ padding: '6px 10px', fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Tables
        </div>
        <div style={{ padding: 12, fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>No databases found</div>
      </div>

      {/* Data view */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <div style={{ padding: 12, fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>Select a table</div>
      </div>
    </div>
  );
}
