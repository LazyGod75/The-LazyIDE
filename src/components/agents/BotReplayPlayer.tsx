/* BotReplayPlayer — minimal UI for a Solari browser replay URL (C58). */

interface BotReplayPlayerProps {
  replayUrl: string;
  title?: string;
  onClose?: () => void;
}

export function BotReplayPlayer({ replayUrl, title, onClose }: BotReplayPlayerProps) {
  return (
    <div style={S.wrap} data-testid="bot-replay-player">
      <div style={S.bar}>
        <span style={S.title}>{title ?? 'Session replay'}</span>
        <a href={replayUrl} target="_blank" rel="noreferrer" style={S.link}>Open</a>
        {onClose && (
          <button type="button" onClick={onClose} style={S.close} aria-label="Close replay">✕</button>
        )}
      </div>
      <iframe
        title={title ?? 'Solari replay'}
        src={replayUrl}
        style={S.frame}
        sandbox="allow-scripts allow-same-origin allow-popups"
      />
    </div>
  );
}

const S = {
  wrap: {
    display: 'flex', flexDirection: 'column' as const, height: '100%', minHeight: 240,
    background: '#12121A', border: '1px solid rgba(124,92,255,0.35)', borderRadius: 10, overflow: 'hidden',
  },
  bar: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
    background: '#1A1A24', borderBottom: '1px solid rgba(255,255,255,0.06)',
  },
  title: { flex: 1, fontSize: 12, fontWeight: 600, color: '#C8C2E8' },
  link: { fontSize: 11, color: '#B8A9FF' },
  close: { background: 'none', border: 'none', color: '#9994B8', cursor: 'pointer', fontSize: 14 },
  frame: { flex: 1, width: '100%', border: 'none', background: '#000', minHeight: 200 },
};
