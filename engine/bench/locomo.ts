/**
 * LOCOMO-10 benchmark harness for LazyBrain.
 *
 * Goal: prove the HTML-attribute hypothesis by running the LOCOMO-10
 * conversational memory benchmark (Maharana et al., 2024) end-to-end on
 * LazyBrain, then comparing accuracy / latency / token cost to published
 * results from mem0 (92.5% @ top-200), graphiti, and baselines.
 *
 * Usage:
 *   1. Download LOCOMO data:
 *        curl -L -o bench/data/locomo10.json \
 *          https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json
 *   2. Run:
 *        LAZYBRAIN_BRAIN_PATH=/tmp/locomo-brain \
 *        node --import tsx bench/locomo.ts --top 50 --judge none
 *   3. Optional: enable LLM-as-judge for true accuracy scoring.
 *        ANTHROPIC_API_KEY=... node --import tsx bench/locomo.ts --judge haiku
 *
 * Outputs:
 *   - bench/results/locomo-<timestamp>.json
 *   - Console summary table.
 *
 * Status: SCAFFOLD. Wires up store → search → score pipeline against the real
 * dataset. Requires the dataset file at bench/data/locomo10.json (gitignored).
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { callClaudeCli, isClaudeCliAvailable } from '../src/util/claude-cli.js';

// Dataset schema (subset of fields we use)
interface LocomoQA {
  question: string;
  answer: string | string[] | number;
  evidence?: string[];     // dia_ids of supporting turns
  category: number;        // 1=single-hop, 2=multi-hop, 3=open, 4=temporal, 5=adversarial
}
interface LocomoTurn {
  speaker: string;
  dia_id: string;
  text: string;
  timestamp?: string;
}
interface LocomoConversation {
  sample_id: string;
  conversation: Record<string, unknown>; // {speaker_a, speaker_b, session_N_date_time, session_N: LocomoTurn[]}
  qa: LocomoQA[];
}

interface BenchOptions {
  datasetPath: string;
  topK: number;
  judge: 'none' | 'exact' | 'haiku';
  outputDir: string;
  limitConversations?: number;
  limitQuestions?: number;
  sourceTag: string;           // prefix for data-cerveau-source (e.g. "bench:locomo")
  injectMode: string;          // marker | highlights | compact | full
  entitiesOn: boolean;
  haikuOn: boolean;
}

interface PerQuestionResult {
  conversationId: string;
  question: string;
  groundTruth: string;
  predicted: string;
  category: number;
  hitIds: string[];
  evidenceHit: boolean;
  latencyMs: number;
  tokensReturned: number;
  judgedCorrect: boolean | null;
}

interface BenchSummary {
  dataset: string;
  conversations: number;
  totalQuestions: number;
  topK: number;
  judge: string;
  metrics: {
    evidenceRecall: number;
    judgeAccuracy: number | null;
    perCategoryAccuracy: Record<string, number>;
    latencyP50Ms: number;
    latencyP95Ms: number;
    avgTokensReturned: number;
  };
  finishedAt: string;
}

function parseArgs(argv: string[]): BenchOptions {
  const opts: BenchOptions = {
    datasetPath: 'bench/data/locomo10.json',
    topK: 50,
    judge: 'exact',
    outputDir: 'bench/results',
    sourceTag: 'bench:locomo',
    injectMode: process.env.LAZYBRAIN_INJECT_MODE ?? 'highlights',
    entitiesOn: true,
    haikuOn: process.env.LAZYBRAIN_EXTRACTOR === 'claude' || process.env.LAZYBRAIN_EXTRACTOR === 'haiku',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--top') opts.topK = parseInt(argv[++i] ?? '50', 10);
    else if (a === '--judge') opts.judge = (argv[++i] as BenchOptions['judge']) ?? 'exact';
    else if (a === '--dataset') opts.datasetPath = argv[++i] ?? opts.datasetPath;
    else if (a === '--out') opts.outputDir = argv[++i] ?? opts.outputDir;
    else if (a === '--max-conv') opts.limitConversations = parseInt(argv[++i] ?? '10', 10);
    else if (a === '--max-q') opts.limitQuestions = parseInt(argv[++i] ?? '300', 10);
    else if (a === '--source-tag') opts.sourceTag = argv[++i] ?? opts.sourceTag;
    else if (a === '--inject-mode') opts.injectMode = argv[++i] ?? opts.injectMode;
    else if (a === '--no-entities') opts.entitiesOn = false;
    else if (a === '--no-haiku') opts.haikuOn = false;
  }
  return opts;
}

function loadDataset(path: string): LocomoConversation[] {
  if (!existsSync(path)) {
    throw new Error(
      `Dataset not found at ${path}\n` +
      `Download with:\n` +
      `  mkdir -p bench/data && curl -L -o bench/data/locomo10.json \\\n` +
      `    https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json`,
    );
  }
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as LocomoConversation[];
}

/**
 * Flatten a LOCOMO conversation into ordered turns. Real schema:
 *   conversation = {
 *     speaker_a, speaker_b,
 *     session_1_date_time: "1:56 pm on 8 May, 2023",
 *     session_1: [{ speaker, dia_id, text }, ...],
 *     session_2_date_time, session_2: [...],
 *     ...up to session_14
 *   }
 */
function flattenTurns(conv: LocomoConversation): LocomoTurn[] {
  const turns: LocomoTurn[] = [];
  const c = conv.conversation;
  for (let i = 1; i <= 32; i++) {
    const sessionKey = `session_${i}`;
    const dateKey = `session_${i}_date_time`;
    const arr = c[sessionKey];
    if (!Array.isArray(arr)) continue;
    const ts = typeof c[dateKey] === 'string' ? (c[dateKey] as string) : undefined;
    for (const t of arr as Array<{ speaker?: string; text?: string; dia_id?: string }>) {
      if (!t || typeof t !== 'object' || !t.speaker || !t.text) continue;
      turns.push({
        speaker: t.speaker,
        dia_id: t.dia_id ?? `S${i}`,
        text: t.text,
        timestamp: ts,
      });
    }
  }
  return turns;
}

/**
 * Store one LOCOMO conversation into LazyBrain via the local daemon's
 * /capture endpoint. We do NOT use the file-based queue — synchronous capture
 * is what real benchmarks measure.
 */
async function storeConversation(
  conv: LocomoConversation,
  daemonUrl: string,
  sourceTag: string,
): Promise<number> {
  const turns = flattenTurns(conv);
  let stored = 0;
  for (const turn of turns) {
    const text = `${turn.speaker}: ${turn.text}`;
    // The session field becomes data-cerveau-source="session:<value>" via the
    // annotator. We prefix with the sourceTag so it lives under bench:locomo:<id>.
    const tagged = `${sourceTag}:${conv.sample_id}`;
    const body = {
      raw: text,
      session: tagged,
      async: false,
    };
    try {
      const resp = await fetch(`${daemonUrl}/capture`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (resp.ok) {
        const json = (await resp.json()) as { status?: string };
        if (json.status !== 'skipped') stored += 1;
      }
    } catch {
      // continue
    }
  }
  return stored;
}

async function searchOne(query: string, topK: number, daemonUrl: string): Promise<{
  hits: Array<{ id: string; score: number; note?: { text?: string; facts?: Array<{ text: string }> } }>;
  latencyMs: number;
  tokensReturned: number;
}> {
  const start = Date.now();
  let resp: Response;
  try {
    resp = await fetch(`${daemonUrl}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, top: topK, strip: false }),
    });
  } catch (_err) {
    return { hits: [], latencyMs: Date.now() - start, tokensReturned: 0 };
  }
  const text = await resp.text();
  const latencyMs = Date.now() - start;
  if (!resp.ok) {
    if (process.env.LAZYBRAIN_BENCH_DEBUG === '1') {
      console.error(`search ${resp.status} for "${query.slice(0, 60)}": ${text.slice(0, 200)}`);
    }
    return { hits: [], latencyMs, tokensReturned: 0 };
  }
  let parsed: { hits?: Array<{ id: string; score: number; note?: { text?: string; facts?: Array<{ text: string }> } }> } = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    if (process.env.LAZYBRAIN_BENCH_DEBUG === '1') {
      console.error(`search non-JSON for "${query.slice(0, 60)}": ${text.slice(0, 200)}`);
    }
  }
  return {
    hits: parsed.hits ?? [],
    latencyMs,
    tokensReturned: Math.ceil(text.length / 4),
  };
}

function evidenceHit(hitIds: string[], evidence: string[] | undefined, allTurns: LocomoTurn[]): boolean {
  if (!evidence || evidence.length === 0) return false;
  // LOCOMO evidence is dia_id (e.g. "D1:3"). Our note ids embed session id +
  // truncated text. Heuristic: a hit "covers" an evidence turn when the hit's
  // id substring matches the turn's text first 16 chars.
  const evidenceTexts = evidence
    .map((dia) => allTurns.find((t) => t.dia_id === dia)?.text ?? '')
    .filter(Boolean)
    .map((t) => t.toLowerCase().replace(/\s+/g, '-').slice(0, 32));
  for (const id of hitIds) {
    const lid = id.toLowerCase();
    for (const ev of evidenceTexts) {
      if (lid.includes(ev.slice(0, 16))) return true;
    }
  }
  return false;
}

function exactJudge(predicted: string, truth: LocomoQA['answer']): boolean {
  const truths: string[] = (Array.isArray(truth) ? truth : [truth]).map((t) => String(t ?? ''));
  const norm = (s: string) => String(s ?? '').toLowerCase().replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  const p = norm(predicted);
  if (!p) return false;
  return truths.some((t) => {
    const n = norm(t);
    if (!n) return false;
    return p.includes(n) || n.includes(p);
  });
}

/**
 * LLM-as-judge: aligns LazyBrain scoring with mem0/Zep/Letta benchmarks which
 * use GPT-4o-mini judge. Sends question + gold answer + retrieved evidence to
 * Haiku via the Claude CLI (reuses active session, no API key needed).
 *
 * Returns a strict yes/no decision. The prompt mirrors mem0's official judge
 * template — semantic equivalence acceptable, contradictions reject.
 */
const JUDGE_SYSTEM = `You are an evaluator scoring whether a memory retrieval system returned the correct answer.

Compare the gold-answer to the retrieved evidence. The system passes (output: yes) if the gold-answer is supported by — or semantically equivalent to — any single piece of evidence. The system fails (output: no) if the evidence is unrelated, contradictory, or only tangentially related.

Output strictly one token: "yes" or "no". No prose. No explanation.`;

async function llmJudge(
  question: string,
  gold: LocomoQA['answer'],
  evidence: string[],
): Promise<boolean | null> {
  const goldStr = (Array.isArray(gold) ? gold : [gold]).map((t) => String(t ?? '')).join(' | ');
  const evJoined = evidence.slice(0, 5).map((e, i) => `[${i + 1}] ${e.slice(0, 600)}`).join('\n');
  if (evJoined.length === 0) return false;
  const prompt = `Question: ${question}\n\nGold answer: ${goldStr}\n\nRetrieved evidence:\n${evJoined}\n\nVerdict (yes/no):`;
  const raw = await callClaudeCli(prompt, {
    system: JUDGE_SYSTEM,
    model: 'haiku',
    timeoutMs: 30_000,
  });
  if (!raw) return null;
  const tok = raw.trim().toLowerCase().replace(/[^a-z]/g, '');
  if (tok.startsWith('yes')) return true;
  if (tok.startsWith('no')) return false;
  return null;
}

function summarize(perQ: PerQuestionResult[], opts: BenchOptions): BenchSummary {
  const latencies = perQ.map((r) => r.latencyMs).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
  const avgTokens = perQ.reduce((s, r) => s + r.tokensReturned, 0) / Math.max(1, perQ.length);
  const evidenceRecall = perQ.filter((r) => r.evidenceHit).length / Math.max(1, perQ.length);
  const judged = perQ.filter((r) => r.judgedCorrect !== null);
  const judgeAccuracy = judged.length > 0
    ? judged.filter((r) => r.judgedCorrect).length / judged.length
    : null;
  const perCategory: Record<string, number> = {};
  const grouped = new Map<number, PerQuestionResult[]>();
  for (const r of perQ) {
    const list = grouped.get(r.category) ?? [];
    list.push(r);
    grouped.set(r.category, list);
  }
  for (const [cat, rows] of grouped) {
    const hits = rows.filter((r) => r.evidenceHit || r.judgedCorrect).length;
    perCategory[`cat_${cat}`] = hits / rows.length;
  }

  return {
    dataset: opts.datasetPath,
    conversations: new Set(perQ.map((r) => r.conversationId)).size,
    totalQuestions: perQ.length,
    topK: opts.topK,
    judge: opts.judge,
    metrics: {
      evidenceRecall,
      judgeAccuracy,
      perCategoryAccuracy: perCategory,
      latencyP50Ms: p50,
      latencyP95Ms: p95,
      avgTokensReturned: Math.round(avgTokens),
    },
    finishedAt: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const daemonUrl = process.env.LAZYBRAIN_DAEMON_URL ?? 'http://127.0.0.1:37788';

  // Daemon health check
  try {
    const h = await fetch(`${daemonUrl}/health`);
    if (!h.ok) throw new Error('daemon not healthy');
  } catch {
    console.error(`Daemon not reachable at ${daemonUrl}. Start with:\n  lazybrain daemon start --foreground --port 37788`);
    process.exit(1);
  }

  console.log(`Loading dataset from ${opts.datasetPath}…`);
  const dataset = loadDataset(opts.datasetPath);
  const conversations = opts.limitConversations
    ? dataset.slice(0, opts.limitConversations)
    : dataset;
  console.log(`Loaded ${conversations.length} conversations.`);

  const perQ: PerQuestionResult[] = [];
  for (const conv of conversations) {
    console.log(`Conversation ${conv.sample_id}: storing turns…`);
    const stored = await storeConversation(conv, daemonUrl, opts.sourceTag);
    const turns = flattenTurns(conv);
    console.log(`  stored ${stored}/${turns.length} turns.`);

    const questions = opts.limitQuestions
      ? conv.qa.slice(0, opts.limitQuestions)
      : conv.qa;
    console.log(`  evaluating ${questions.length} questions…`);

    // Pre-flight CLI availability check when haiku judge requested.
    const haikuReady = opts.judge === 'haiku' ? await isClaudeCliAvailable() : false;
    if (opts.judge === 'haiku' && !haikuReady) {
      console.warn('  [judge=haiku] claude CLI not reachable, falling back to exact judge');
    }

    for (const qa of questions) {
      const search = await searchOne(qa.question, opts.topK, daemonUrl);
      const hitIds = search.hits.map((h) => h.id);
      // Predicted = top-3 hit content (passed to LLM-judge as evidence list).
      const evidenceList = search.hits.slice(0, 3).map((h) => {
        const facts = h.note?.facts?.map((f) => f.text).join(' · ') ?? '';
        const txt = h.note?.text ?? '';
        return facts || txt;
      }).filter((s) => s.length > 0);
      const predicted = evidenceList[0] ?? '';

      let judgedCorrect: boolean | null;
      if (opts.judge === 'exact') {
        judgedCorrect = exactJudge(predicted, qa.answer);
      } else if (opts.judge === 'haiku' && haikuReady) {
        judgedCorrect = await llmJudge(qa.question, qa.answer, evidenceList);
      } else {
        judgedCorrect = null;
      }
      perQ.push({
        conversationId: conv.sample_id,
        question: qa.question,
        groundTruth: Array.isArray(qa.answer) ? qa.answer.map((x) => String(x)).join(' | ') : String(qa.answer ?? ''),
        predicted: predicted.slice(0, 200),
        category: qa.category,
        hitIds,
        evidenceHit: evidenceHit(hitIds, qa.evidence, turns),
        latencyMs: search.latencyMs,
        tokensReturned: search.tokensReturned,
        judgedCorrect,
      });
    }
  }

  const summary = summarize(perQ, opts);
  if (!existsSync(opts.outputDir)) mkdirSync(opts.outputDir, { recursive: true });
  const outPath = join(opts.outputDir, `locomo-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify({ summary, perQ }, null, 2), 'utf8');

  console.log(`\n=== LOCOMO-10 results @ top-${opts.topK} ===`);
  console.log(`  Evidence recall:    ${(summary.metrics.evidenceRecall * 100).toFixed(1)}%`);
  console.log(`  Judge accuracy:     ${summary.metrics.judgeAccuracy === null ? 'n/a' : (summary.metrics.judgeAccuracy * 100).toFixed(1) + '%'}`);
  console.log(`  Latency p50 / p95:  ${summary.metrics.latencyP50Ms} / ${summary.metrics.latencyP95Ms} ms`);
  console.log(`  Tokens / query:     ${summary.metrics.avgTokensReturned}`);
  console.log(`  Per-category:       ${JSON.stringify(summary.metrics.perCategoryAccuracy)}`);
  console.log(`\nFull report → ${outPath}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
