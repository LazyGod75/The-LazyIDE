const STORAGE_KEY = 'lazy.managerCharters.v1';

export type CharterDecision = 'accepted' | 'rejected';

interface CharterRecord {
  conversationId: string;
  charterId: string;
  decision: CharterDecision;
  at: number;
}

function readAll(): CharterRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as CharterRecord[] : [];
  } catch {
    return [];
  }
}

function writeAll(rows: CharterRecord[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rows.slice(-80)));
  } catch {
    /* ignore quota */
  }
}

export function recordCharterDecision(
  conversationId: string,
  charterId: string,
  decision: CharterDecision,
): void {
  if (!conversationId || !charterId) return;
  const rows = readAll().filter((r) => !(r.conversationId === conversationId && r.charterId === charterId));
  rows.push({ conversationId, charterId, decision, at: Date.now() });
  writeAll(rows);
}

export function getCharterDecision(conversationId: string, charterId: string): CharterDecision | undefined {
  const rows = readAll();
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.conversationId === conversationId && row.charterId === charterId) return row.decision;
  }
  return undefined;
}
