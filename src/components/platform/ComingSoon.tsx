interface ComingSoonProps {
  label: string;
}

export function ComingSoon({ label }: ComingSoonProps) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        background: 'rgba(14,14,18,0.92)',
        zIndex: 10,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          padding: '6px 14px',
          borderRadius: 6,
          background: 'rgba(124,92,255,0.12)',
          border: '1px solid rgba(124,92,255,0.2)',
          color: '#A78BFF',
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: '0.04em',
        }}
      >
        Coming Soon
      </div>
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>
        {label} integration is not yet available
      </div>
    </div>
  );
}
