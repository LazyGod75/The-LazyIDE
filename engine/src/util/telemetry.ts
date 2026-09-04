import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfig } from './config.js';

export type TelemetryEvent =
  | {
      event: 'capture';
      ts: string;
      session?: string;
      tool?: string;
      tokens_in?: number;
      tokens_out_html?: number;
      strip_ratio?: number;
      duration_ms?: number;
    }
  | { event: 'capture_skipped'; ts: string; session?: string; reason: string; tokens_in?: number }
  | { event: 'cache_hit'; ts: string; endpoint: string; key_hash: string }
  | {
      event: 'query';
      ts: string;
      level: 'L1' | 'L2' | 'L2_L3_HYBRID' | 'L3' | 'L4';
      latency_ms: number;
      results: number;
      query_hash?: string;
    }
  | { event: 'inject'; ts: string; tokens: number; sections: number; duration_ms: number }
  | { event: 'store'; ts: string; note_id: string; size_bytes: number; attrs_count: number }
  | {
      event: 'compress';
      ts: string;
      session?: string;
      in_count: number;
      out_size_bytes: number;
      compression_ratio: number;
      model?: string;
    }
  | { event: 'error'; ts: string; where: string; message: string }
  | {
      event: 'embed';
      ts: string;
      texts: number;
      duration_ms: number;
      cache_hit: number;
      cache_miss: number;
    }
  | { event: 'rerank_invalidation'; ts: string; penalized: number; boosted: number; hard: boolean }
  | { event: 'rerank_noise_penalty'; ts: string; penalized: number }
  | {
      /**
       * Logged every time rerank() (indexer/reranker.ts) degrades to
       * identity ranking instead of a real cross-encoder pass — i.e. L4
       * silently became "no rerank" for this query. `reason` is the
       * underlying error message (model not cached, disabled via
       * LAZYBRAIN_EMBEDDINGS, or an inference failure). See rerankFallback()
       * for why this must never be silent: a quality-degrading fallback that
       * looks identical to success is the exact failure this event exists
       * to catch.
       */
      event: 'rerank_fallback';
      ts: string;
      reason: string;
      candidates: number;
    }
  | {
      /**
       * Logged every time structural.ts's SQL-pushdown fast path is skipped
       * because indexIsTrustworthy() found the SQLite `notes` row count does
       * not match the on-disk `.html` file count — i.e. a `query` call
       * silently paid for a full-corpus scan instead of the indexed fast
       * path. Mirrors rerank_fallback: a correctness-preserving but
       * quality/perf-degrading fallback that looks identical to success from
       * the caller's point of view must never be silent. See structural.ts's
       * indexIsTrustworthy() for the guard this event reports on.
       */
      event: 'index_untrustworthy';
      ts: string;
      indexed_notes: number;
      disk_notes: number;
      missing: number;
    };

export function logTelemetry(event: TelemetryEvent): void {
  const cfg = getConfig();
  if (!cfg.telemetry) return;
  try {
    const path = join(cfg.cachePath, 'telemetry.jsonl');
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8');
  } catch {
    // Telemetry never throws
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
