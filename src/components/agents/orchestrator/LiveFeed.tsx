/* LiveFeed.tsx — Streaming mission/orchestrator events (Pillar E4). */

export interface LiveFeedEvent {
  id: string;
  ts: number;
  type: string;
  message: string;
}

export interface LiveFeedProps {
  events: LiveFeedEvent[];
}

export function LiveFeed({ events }: LiveFeedProps) {
  return (
    <div className="p-4 space-y-2 max-h-64 overflow-auto">
      <h3 className="text-sm font-semibold text-slate-200">Live Feed</h3>
      {events.length === 0 && <p className="text-xs text-slate-500">No recent events.</p>}
      {events.map((e) => (
        <div key={e.id} className="text-xs">
          <span className="text-slate-500">{new Date(e.ts).toLocaleTimeString()}</span>{' '}
          <span className="text-slate-300">{e.type}</span>:{' '}
          <span className="text-slate-400">{e.message}</span>
        </div>
      ))}
    </div>
  );
}
