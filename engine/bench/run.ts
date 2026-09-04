import { route } from '../src/retrieval/router.js';
import { FIXTURES, type FixtureItem, type ScoreSummary } from './fixtures.js';

interface FixtureResult {
  fixture: FixtureItem;
  topIds: string[];
  hit_at_1: boolean;
  hit_at_5: boolean;
  level_used: string;
  latency_ms: number;
}

export async function runFixtures(): Promise<{ summary: ScoreSummary; details: FixtureResult[] }> {
  const details: FixtureResult[] = [];

  for (const fixture of FIXTURES) {
    const start = Date.now();
    let topIds: string[] = [];
    let level = 'L0';
    try {
      const r = await route({
        query: fixture.question,
        topK: 5,
        level: (fixture.mode?.toUpperCase() as 'L1' | 'L2' | 'L3' | 'L4' | undefined) ?? 'auto',
      });
      topIds = r.hits.map((h) => h.id);
      level = r.levelUsed;
    } catch {
      // record empty result
    }
    const top1 = topIds[0];
    const hit_at_1 = fixture.expected.includes(top1 ?? '');
    const hit_at_5 = fixture.expected.length === 0
      ? topIds.length === 0
      : fixture.expected.some((id) => topIds.includes(id));
    details.push({
      fixture,
      topIds,
      hit_at_1,
      hit_at_5,
      level_used: level,
      latency_ms: Date.now() - start,
    });
  }

  const byCat: Record<string, { n: number; r5: number; r1: number }> = {};
  let totalR5 = 0;
  let totalR1 = 0;
  let abstainCount = 0;
  let abstainCorrect = 0;
  for (const d of details) {
    const cat = d.fixture.category;
    byCat[cat] ??= { n: 0, r5: 0, r1: 0 };
    byCat[cat].n += 1;
    byCat[cat].r5 += d.hit_at_5 ? 1 : 0;
    byCat[cat].r1 += d.hit_at_1 ? 1 : 0;
    totalR5 += d.hit_at_5 ? 1 : 0;
    totalR1 += d.hit_at_1 ? 1 : 0;
    if (cat === 'abstain') {
      abstainCount += 1;
      if (d.topIds.length === 0) abstainCorrect += 1;
    }
  }
  for (const cat of Object.keys(byCat)) {
    byCat[cat].r5 = (byCat[cat].r5 / byCat[cat].n) * 100;
    byCat[cat].r1 = (byCat[cat].r1 / byCat[cat].n) * 100;
  }

  const summary: ScoreSummary = {
    total: details.length,
    recall_at_5: (totalR5 / details.length) * 100,
    recall_at_1: (totalR1 / details.length) * 100,
    by_category: byCat,
    abstention_rate_pct: abstainCount === 0 ? 0 : (abstainCorrect / abstainCount) * 100,
  };

  return { summary, details };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  let pretty = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === '--pretty') pretty = true;
  }
  runFixtures()
    .then(({ summary, details }) => {
      if (pretty) {
        process.stdout.write(
          [
            'LazyBrain — fixture benchmark',
            '─'.repeat(50),
            `Total: ${summary.total}`,
            `Recall@1: ${summary.recall_at_1.toFixed(1)}%`,
            `Recall@5: ${summary.recall_at_5.toFixed(1)}%`,
            `Abstention rate: ${summary.abstention_rate_pct.toFixed(1)}%`,
            '',
            'By category:',
            ...Object.entries(summary.by_category).map(
              ([cat, s]) => `  ${cat.padEnd(10)} n=${s.n}  R@1=${s.r1.toFixed(0)}%  R@5=${s.r5.toFixed(0)}%`,
            ),
            '',
            'Failures (R@5 miss):',
            ...details
              .filter((d) => !d.hit_at_5 && d.fixture.category !== 'abstain')
              .map((d) =>
                `  ${d.fixture.id}: "${d.fixture.question.slice(0, 40)}" → got [${d.topIds.slice(0, 3).join(',')}]  expected ${d.fixture.expected.join(',')}`,
              ),
          ].join('\n') + '\n',
        );
      } else {
        process.stdout.write(JSON.stringify({ summary, details }, null, 2) + '\n');
      }
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`bench/run failed: ${msg}\n`);
      process.exit(1);
    });
}
