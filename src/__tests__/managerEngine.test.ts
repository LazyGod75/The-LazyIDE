/**
 * Tests for managerEngine: action parsing, action block stripping,
 * and system prompt building.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock getProviderMode so runManagerTurn routing tests control the active
// mode directly; everything else in models/index (getDefaultModelIdForMode,
// ALL_MODELS via resolveManagerModelId, etc.) stays real. ──
vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return {
    ...actual,
    getProviderMode: vi.fn(),
  };
});

// ── Mock the three streaming backends runManagerTurn can route to ──
vi.mock('../lib/models/claudeCodeProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/claudeCodeProvider')>();
  return {
    ...actual,
    streamClaudeCodeTurn: vi.fn(),
  };
});

vi.mock('../lib/models/managedProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/managedProvider')>();
  return {
    ...actual,
    streamManagedAgentTurn: vi.fn(),
  };
});

vi.mock('../lib/models/cliBackendProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/cliBackendProvider')>();
  return {
    ...actual,
    cliBackendProvider: vi.fn(),
  };
});

// ── Mock the BYOK live-key raw streamers (FIX 1 rail coverage) — everything
// else in byokProviders.ts (resolveByokDef, saveByokKey, BYOK_PROVIDER_DEFS,
// etc.) stays real so the existing BYOK-catalog tests below are unaffected. ──
vi.mock('../lib/models/byokProviders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/byokProviders')>();
  return {
    ...actual,
    streamOpenAICompatRaw: vi.fn(),
    streamAnthropicCompatRaw: vi.fn(),
  };
});

// ── Mock runtime.ts's mode-independent engine-readiness signals (BUG-2) —
// isManagedModelReady/isNativeModelReady default to their REAL implementation
// (both resolve false outside a Tauri runtime, matching every pre-existing
// resolveManagerModelId test's expectations unchanged); the new "BUG-2
// fallback" describe block below overrides them per-test. ──
vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    isManagedModelReady: vi.fn(actual.isManagedModelReady),
    isNativeModelReady: vi.fn(actual.isNativeModelReady),
  };
});

// ── Mock platform (brain recall) — runManagerTurn's recall is best-effort
// and swallowed on error, but stub it so tests are fast and deterministic. ──
vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(() => ({
    brain: {
      recall: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }),
    },
  })),
}));

import {
  parseManagerActions,
  stripActionBlock,
  sanitizeManagerDisplayText,
  dedupeRepeatedSegments,
  buildManagerSystemPrompt,
  buildManagerCorePrompt,
  buildManagerDynamicContext,
  createMessageId,
  formatMissionDetail,
  formatMissionNotFound,
  formatCreditsSummary,
  formatEntitlementsSummary,
  formatBrainStatus,
  resolveManagerModelId,
  buildCompactModelCatalog,
  MODEL_CATALOG_MAX_CHARS,
  UnknownManagerModelIdError,
  resolveBareRailModelId,
  findOpenRouterAliasHint,
  findByokHomeHint,
  findAlternateRailMatches,
  runManagerTurn,
  detectUserActionRequest,
  shouldSkipHeavyManagerContext,
  shouldUseCompactManagerCore,
  shouldBlockOnManagerStartupContext,
  stampOmittedBrainQuerySession,
  isClarifyingQuestion,
  MANAGER_TURN_TIMEOUT_MS,
  MANAGER_LLM_CALL_TIMEOUT_MS,
  estimatePlanStepCostUsd,
  estimatePlanStepDurationMs,
  ACTION_FORMAT_REMINDER,
  accumulateManagerChunks,
  ANNOUNCEMENT_NUDGE_MESSAGE,
} from '../lib/agents/managerEngine';
import type { ManagerContext, ManagerTurnOptions } from '../lib/agents/managerEngine';
import type { Mission, ManagerMessage } from '../lib/agents/types';
import type { StoredAgent } from '../lib/agents/agentsStorage';
import { DEFAULT_MODEL } from '../lib/models/registry';
import { DEFAULT_OPENROUTER_MODEL_ID, OPENROUTER_MODELS } from '../lib/models/openrouterCatalog';
import { getProviderMode } from '../lib/models/index';
import { streamClaudeCodeTurn } from '../lib/models/claudeCodeProvider';
import { streamManagedAgentTurn } from '../lib/models/managedProvider';
import { cliBackendProvider } from '../lib/models/cliBackendProvider';
import type { StreamChatRequest } from '../lib/models/types';
import { RECALL_TEACHING } from '../lib/models/systemPrompts';
import { formatCredits } from '../lib/billing/credits';
import { isManagedModelReady, isNativeModelReady } from '../lib/agents/runtime';
import { streamOpenAICompatRaw, streamAnthropicCompatRaw, saveByokKey } from '../lib/models/byokProviders';

const mockedGetProviderMode = getProviderMode as ReturnType<typeof vi.fn>;
const mockedStreamClaudeCodeTurn = streamClaudeCodeTurn as ReturnType<typeof vi.fn>;
const mockedStreamManagedAgentTurn = streamManagedAgentTurn as ReturnType<typeof vi.fn>;
const mockedCliBackendProvider = cliBackendProvider as ReturnType<typeof vi.fn>;
const mockedIsManagedModelReady = isManagedModelReady as ReturnType<typeof vi.fn>;
const mockedIsNativeModelReady = isNativeModelReady as ReturnType<typeof vi.fn>;
const mockedStreamOpenAICompatRaw = streamOpenAICompatRaw as ReturnType<typeof vi.fn>;
const mockedStreamAnthropicCompatRaw = streamAnthropicCompatRaw as ReturnType<typeof vi.fn>;

/** Yield each given chunk from an async generator — the shape every
 *  streaming backend (streamClaudeCodeTurn / streamManagedAgentTurn /
 *  cliBackendProvider(...).streamChat) returns. */
async function* fakeStream(...chunks: string[]): AsyncIterable<string> {
  for (const chunk of chunks) yield chunk;
}

// ── Tests ──────────────────────────────────────────────────────────

describe('parseManagerActions', () => {
  it('parses a single action from <lazy_actions> block', () => {
    const text = 'Sure! I will create that agent.\n<lazy_actions>\n[{"type": "info", "message": "done"}]\n</lazy_actions>';
    const actions = parseManagerActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('info');
  });

  it('parses multiple actions', () => {
    const text = '<lazy_actions>\n[{"type": "stop_all"}, {"type": "list_agents"}]\n</lazy_actions>';
    const actions = parseManagerActions(text);
    expect(actions).toHaveLength(2);
    expect(actions[0].type).toBe('stop_all');
    expect(actions[1].type).toBe('list_agents');
  });

  it('parses create_agent action with full payload', () => {
    const text = '<lazy_actions>\n[{"type": "create_agent", "agent": {"name": "my-agent", "displayName": "My Agent", "description": "A test agent that does things", "systemPrompt": "You are a test agent", "modelTier": "haiku", "color": "violet", "tags": ["test"]}}]\n</lazy_actions>';
    const actions = parseManagerActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('create_agent');
  });

  it('parses launch_mission action', () => {
    const text = '<lazy_actions>\n[{"type": "launch_mission", "agentName": "security-reviewer", "task": "Review auth module", "model": "haiku"}]\n</lazy_actions>';
    const actions = parseManagerActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('launch_mission');
  });

  it('parses launch_mission action with an explicit "engine" choice (STACK fix)', () => {
    const text = '<lazy_actions>\n[{"type": "launch_mission", "agentName": "security-reviewer", "task": "Review auth module", "model": "haiku", "engine": "cli"}]\n</lazy_actions>';
    const actions = parseManagerActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'launch_mission', engine: 'cli' });
  });

  it('parses create_loop action', () => {
    const text = '<lazy_actions>\n[{"type": "create_loop", "agentName": "lint-checker", "task": "Run lint", "cadence": "15m", "model": "haiku"}]\n</lazy_actions>';
    const actions = parseManagerActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('create_loop');
  });

  it('parses pause_loop action', () => {
    const text = '<lazy_actions>\n[{"type": "pause_loop", "loopId": "M12", "enabled": false}]\n</lazy_actions>';
    const actions = parseManagerActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('pause_loop');
  });

  it('parses delete_loop action', () => {
    const text = '<lazy_actions>\n[{"type": "delete_loop", "loopId": "M12"}]\n</lazy_actions>';
    const actions = parseManagerActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('delete_loop');
  });

  it('parses reassign_agent action', () => {
    const text = '<lazy_actions>\n[{"type": "reassign_agent", "missionId": "M12", "model": "opus"}]\n</lazy_actions>';
    const actions = parseManagerActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({ type: 'reassign_agent', missionId: 'M12', model: 'opus' });
  });

  it('parses answer_question action', () => {
    const text = '<lazy_actions>\n[{"type": "answer_question", "missionId": "M12", "answer": "use approach B"}]\n</lazy_actions>';
    const actions = parseManagerActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({ type: 'answer_question', missionId: 'M12', answer: 'use approach B' });
  });

  it('parses brain_query round-trip (regression guard: canvas catalog growth must never affect parsing)', () => {
    // The Agent Canvas waves grew the action CATALOG (system prompt) from 24
    // to 41 entries and widened the ManagerAction union — neither of which
    // may ever affect this parser, which only sees the model's RESPONSE.
    // Round-trips the exact reply shape of the reported regression ("je vais
    // lire dans le brain" + brain_query) to pin that invariant down.
    const text = 'Je vais lire dans le brain.\n<lazy_actions>\n[{"type": "brain_query", "query": "postgres sqlite migration"}]\n</lazy_actions>';
    const actions = parseManagerActions(text);
    expect(actions).toEqual([{ type: 'brain_query', query: 'postgres sqlite migration' }]);
  });

  it('returns empty array when no <lazy_actions> block', () => {
    expect(parseManagerActions('Just a regular response')).toEqual([]);
  });

  it('returns empty array on invalid JSON', () => {
    const text = '<lazy_actions>\n{not valid json}\n</lazy_actions>';
    expect(parseManagerActions(text)).toEqual([]);
  });

  it('returns empty array when parsed value is not an array', () => {
    const text = '<lazy_actions>\n{"type": "info"}\n</lazy_actions>';
    expect(parseManagerActions(text)).toEqual([]);
  });

  it('filters out entries without a type field and malformed actions', () => {
    // {"type": "info"} is now dropped by the validator (missing required
    // "message" field), {"notype": true} is dropped (no type), only
    // {"type": "list_agents"} survives.
    const text = '<lazy_actions>\n[{"type": "info", "message": "ok"}, {"notype": true}, {"type": "list_agents"}]\n</lazy_actions>';
    const actions = parseManagerActions(text);
    expect(actions).toHaveLength(2);
    expect(actions[0].type).toBe('info');
    expect(actions[1].type).toBe('list_agents');
  });

  // ── LAYER 1 salvage (2026-08-07, DeepSeek FORMAT-compliance fix) ──────
  // parseLazyActionsJson's block-aware parsing already tolerated an unclosed
  // <lazy_actions> block or one closed with a typo (trailing-prose salvage
  // within the opened tag) — these cover the dominant real repro instead: NO
  // <lazy_actions> wrapper anywhere at all, only a bare JSON array. Salvage
  // is deliberately conservative: a candidate is accepted only when EVERY
  // element passes validateManagerAction, never a partial guess.

  it('LAYER 1: salvages a bare ```json fenced array of valid actions with NO <lazy_actions> wrapper', () => {
    const text = 'Je lance la mission de review.\n\n```json\n[{"type": "stop_all"}]\n```';
    const actions = parseManagerActions(text);
    expect(actions).toEqual([{ type: 'stop_all' }]);
  });

  it('LAYER 1: salvages a naked (unfenced) JSON array of valid actions with NO <lazy_actions> wrapper', () => {
    const text = 'Je nettoie tout : [{"type": "archive_mission", "missionId": "M9"}] et je reviens vers toi.';
    const actions = parseManagerActions(text);
    expect(actions).toEqual([{ type: 'archive_mission', missionId: 'M9' }]);
  });

  it('LAYER 1: salvages a <lazy_actions> block closed with a typo\'d tag', () => {
    const text = 'Fait.\n<lazy_actions>\n[{"type": "info", "message": "M16 supprimée"}]\n</lazy_action>';
    const actions = parseManagerActions(text);
    expect(actions).toEqual([{ type: 'info', message: 'M16 supprimée' }]);
  });

  it('LAYER 1: does NOT salvage a bare array when even ONE element fails validation — conservative, never a partial guess', () => {
    // {"type": "stop_all"} alone would validate fine, but this whole
    // candidate must be rejected because {"type": "launch_mission"} (no
    // "task") does not — the zero-actions path applies, exactly as if no
    // JSON had been found at all.
    const text = 'Je lance ça : [{"type": "stop_all"}, {"type": "launch_mission"}]';
    const actions = parseManagerActions(text);
    expect(actions).toEqual([]);
  });

  it('LAYER 1: an unrelated JSON-looking blob in prose (no recognized action type) is never salvaged', () => {
    const text = 'Voici la config : [{"foo": "bar"}, {"baz": 1}]';
    expect(parseManagerActions(text)).toEqual([]);
  });

  it('LAYER 1: salvages a bare SINGLE action object (ox alpha free-tier shape) with NO array wrapper', () => {
    const text = 'Résumé du travail : {"type": "info", "message": "Je supervise tes missions."}';
    expect(parseManagerActions(text)).toEqual([
      { type: 'info', message: 'Je supervise tes missions.' },
    ]);
  });

  it('LAYER 1: does NOT salvage a single object whose type is not a real action (stays conservative)', () => {
    const text = 'Note : {"type": "not_a_real_action", "message": "hi"}';
    expect(parseManagerActions(text)).toEqual([]);
  });
});

describe('stripActionBlock', () => {
  it('removes the <lazy_actions> block from text', () => {
    const text = 'Hello!\n<lazy_actions>\n[{"type": "info"}]\n</lazy_actions>\nDone.';
    const result = stripActionBlock(text);
    expect(result).toContain('Hello!');
    expect(result).toContain('Done.');
    expect(result).not.toContain('lazy_actions');
  });

  it('returns text unchanged when no action block', () => {
    expect(stripActionBlock('Just text')).toBe('Just text');
  });

  it('removes multiple action blocks', () => {
    const text = 'A\n<lazy_actions>[1]</lazy_actions>\nB\n<lazy_actions>[2]</lazy_actions>\nC';
    const result = stripActionBlock(text);
    expect(result).toContain('A');
    expect(result).toContain('B');
    expect(result).toContain('C');
    expect(result).not.toContain('lazy_actions');
  });

  // ── 2026-08-12 QA: real, observed leak — verbatim from a live LazyManager
  // session. The model emitted the actions JSON with the wrapper's CLOSING
  // tag present but the OPENING tag missing/mismatched, and the raw JSON
  // plus the stray tag rendered as the ENTIRE visible assistant bubble:
  //   [{"type": "info", "message": "Règle confirmée : ..."}] </lazy_actions>
  // stripActionBlock previously only recognized a `<lazy_actions>...
  // </lazy_actions>` PAIR or an opened-but-unclosed block — neither regex
  // matched a closing tag with no opening tag anywhere, so it fell straight
  // through as untouched prose.
  describe('malformed <lazy_actions> wrapper — never leaks raw JSON or tag fragments (2026-08-12 QA)', () => {
    it('strips a bare JSON array followed by a stray closing tag with NO opening tag at all (the real repro, verbatim)', () => {
      const text =
        '[{"type": "info", "message": "Règle confirmée : toute refonte de la page d\'accueil doit préserver le SEO technique intact."}] </lazy_actions>';
      const result = stripActionBlock(text);
      expect(result).not.toContain('lazy_actions');
      expect(result).not.toContain('{"type"');
      expect(result).not.toContain('[{');
      // The action itself must still be extractable from the SAME raw text
      // — stripping display text must never regress action execution.
      expect(parseManagerActions(text)).toEqual([
        {
          type: 'info',
          message:
            "Règle confirmée : toute refonte de la page d'accueil doit préserver le SEO technique intact.",
        },
      ]);
    });

    it('strips a stray closing tag with prose BEFORE the bare JSON array', () => {
      const text = 'Je note la règle.\n[{"type": "info", "message": "ok"}] </lazy_actions>';
      const result = stripActionBlock(text);
      expect(result).toContain('Je note la règle.');
      expect(result).not.toContain('lazy_actions');
      expect(result).not.toContain('{"type"');
    });

    it('strips a stray closing tag alone, with no JSON immediately before it', () => {
      const text = 'Réponse propre.\n</lazy_actions>';
      const result = stripActionBlock(text);
      expect(result).toBe('Réponse propre.');
      expect(result).not.toContain('lazy_actions');
    });

    it('still strips a normal OPENED-but-never-closed block (regression guard)', () => {
      const text = 'Voilà :\n<lazy_actions>\n[{"type": "stop_all"}]';
      const result = stripActionBlock(text);
      expect(result).toBe('Voilà :');
      expect(result).not.toContain('lazy_actions');
    });

    it('tolerates extra whitespace/newlines around a stray closing tag', () => {
      const text = '[{"type": "info", "message": "ok"}]\n\n   \n</lazy_actions>\n\n';
      const result = stripActionBlock(text);
      expect(result).not.toContain('lazy_actions');
      expect(result).not.toContain('{"type"');
    });

    it('strips a bare JSON array of valid action objects with NO wrapper at all', () => {
      const text = 'Je nettoie tout.\n[{"type": "archive_mission", "missionId": "M9"}]';
      const result = stripActionBlock(text);
      expect(result).toBe('Je nettoie tout.');
      expect(result).not.toContain('{"type"');
      expect(parseManagerActions(text)).toEqual([{ type: 'archive_mission', missionId: 'M9' }]);
    });

    it('never strips an unrelated bare JSON blob that is NOT a real action array (conservative, matches extraction)', () => {
      const text = 'Voici la config : [{"foo": "bar"}, {"baz": 1}]';
      const result = stripActionBlock(text);
      expect(result).toBe(text);
    });

    it('is covered end-to-end through sanitizeManagerDisplayText (the actual display choke point)', () => {
      const text =
        '[{"type": "info", "message": "Règle confirmée."}] </lazy_actions>';
      const result = sanitizeManagerDisplayText(text);
      expect(result).not.toContain('lazy_actions');
      expect(result).not.toContain('{"type"');
    });
  });
});

// ── accumulateManagerChunks — streaming fragment duplication/splicing fix
// (2026-08-12 QA, real repro, Claude Sonnet 5 subscription route, verbatim):
//   "Je lance un agent haiku pour ajouter la fonction sum(a, b) dans
//   index.js avec l'affichage de sum(2,3) au démarrage.js(projet actif
//   uc-smoke-2026-08-12) et affichersum(2,3)` au lancement."
// See appendManagerChunk's own module doc comment in managerEngine.ts for
// the full root-cause story: a duplicate chunk delivery from the transport
// (the same event firing twice in a row) spliced two overlapping partial
// completions together via plain `rawResponse += chunk` concatenation.
// 2026-08-12 QA — REVISED after coordinator rejection of the first attempt:
// a >=8-char "drop an exact adjacent duplicate chunk" heuristic shipped
// initially, but (1) it is destructive — streamed code/markdown routinely
// contains a legitimate identical adjacent chunk (repeated indentation, a
// blank-line pair, a repeated identifier at a token boundary) that must
// never be silently deleted in an IDE, and (2) it does not even match the
// real repro: the two halves of the observed corruption are NOT
// byte-identical to each other, so a duplicate-chunk guard would never have
// fired on the real sequence anyway. See appendManagerChunk's own module
// doc comment in managerEngine.ts for the full investigation (three
// hypotheses checked against the real code path) and why the true root
// cause could not be proven/fixed from a JS unit test. This suite now
// verifies the corrected contract: NEVER drop or alter a chunk (always the
// exact concatenation of the deltas), with two non-destructive diagnostics
// (console.warn) that fire without changing the text.
describe('accumulateManagerChunks (lossless — never drops model output)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('reconstructs an ordinary chunk sequence exactly (plain concatenation, the common case)', () => {
    const chunks = ['Je lance ', 'un agent ', 'haiku pour ', 'ajouter sum(a, b).'];
    expect(accumulateManagerChunks(chunks)).toBe(chunks.join(''));
  });

  it('reconstructs a markdown code span split across two DIFFERENT chunk boundaries with no corruption', () => {
    const chunks = [
      'Je vais ajouter la fonction `sum',
      '(a, b)` dans index.js et afficher `sum(2,3)',
      '` au lancement.',
    ];
    expect(accumulateManagerChunks(chunks)).toBe(
      'Je vais ajouter la fonction `sum(a, b)` dans index.js et afficher `sum(2,3)` au lancement.',
    );
  });

  it('NEVER drops an exact, adjacent, retried/duplicated chunk — kept in full, diagnostic logged instead', () => {
    const chunks = [
      'Je lance un agent haiku pour ajouter la fonction sum(a, b) dans index',
      '.js avec l\'affichage de sum(2,3) au démarrage.',
      '.js avec l\'affichage de sum(2,3) au démarrage.', // exact repeat of the previous chunk
      ' Confirmé.',
    ];
    const result = accumulateManagerChunks(chunks);
    // Lossless: the result is the exact join of every chunk, duplicate
    // included — model output is never silently deleted.
    expect(result).toBe(chunks.join(''));
    expect(result.split('au démarrage.').length - 1).toBe(2);
    // Non-destructive diagnostic: the anomaly is logged, not acted on.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('chunk repeated identically'));
  });

  it('never silently touches a short, legitimately-repeated fragment (no drop, no log noise below the floor)', () => {
    const chunks = ['I said ', 'the ', 'the ', 'cat sat.'];
    expect(accumulateManagerChunks(chunks)).toBe('I said the the cat sat.');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('keeps a repeated code-indentation chunk in full — the exact real-world case the old heuristic would have corrupted', () => {
    const eightSpaces = '        ';
    const chunks = ['function foo() {\n', eightSpaces, eightSpaces, 'return 1;\n}'];
    // Two identical 8-space indentation chunks in a row is entirely
    // legitimate streamed code — both must survive intact.
    expect(accumulateManagerChunks(chunks)).toBe(chunks.join(''));
  });

  it('keeps a later, non-adjacent repeat of the same chunk (never a general "collapse repeats anywhere" pass)', () => {
    const chunks = ['Bonjour tout le monde, ', 'ça va bien ? ', 'Bonjour tout le monde, ', 'à bientôt.'];
    expect(accumulateManagerChunks(chunks)).toBe(chunks.join(''));
  });

  it('returns an empty string for an empty chunk sequence', () => {
    expect(accumulateManagerChunks([])).toBe('');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('flags an odd/unbalanced backtick count in the final text (the real repro\'s own stray backtick) without altering it', () => {
    const chunks = [
      'Je lance un agent haiku pour ajouter la fonction sum(a, b) dans index',
      '.js avec l\'affichage de sum(2,3) au démarrage.',
      '.js(projet actif uc-smoke-2026-08-12) et affichersum(2,3)', // note: no opening backtick here
      '` au lancement.',
    ];
    const result = accumulateManagerChunks(chunks);
    // Text kept EXACTLY as produced by the chunk sequence — never repaired.
    expect(result).toBe(chunks.join(''));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('odd backtick count'));
  });

  it('never logs the backtick diagnostic for balanced, ordinary code spans', () => {
    const chunks = ['Utilise `sum(a, b)` puis `console.log`.'];
    accumulateManagerChunks(chunks);
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('odd backtick count'));
  });
});

// ── LANGUAGE rule precedence (2026-08 fix): user's own message wins over
// the UI locale; the Locale line is a fallback hint, never a hardcoded
// French default. Regression coverage for the founder-reported bug: the
// manager replied in French to an English-speaking user inside an
// English-locale app. See managerEngine.ts's LANGUAGE rule and
// ManagerContext.locale's doc comment for the full history. ─────────────
describe('buildManagerDynamicContext — locale is worded as a fallback hint, never an override', () => {
  const baseCtx: ManagerContext = { agents: [], missions: [] };

  it('renders the Locale line explicitly labeled as a fallback, deferring to the user\'s own message', () => {
    const dynamic = buildManagerDynamicContext({ ...baseCtx, locale: 'en' });
    expect(dynamic).toMatch(/Locale \(fallback hint only — the user's own message this turn takes priority\): en\./);
  });

  it('omits the Locale line entirely when no locale is supplied (no hardcoded French insertion)', () => {
    const dynamic = buildManagerDynamicContext({ ...baseCtx, locale: undefined });
    expect(dynamic).not.toMatch(/Locale/);
  });
});

describe('buildManagerCorePrompt — LANGUAGE rule: user message is PRIMARY, locale is fallback only', () => {
  it('states the user\'s own message this turn is the PRIMARY signal', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/reply in the language of the user's OWN message THIS TURN — that is the PRIMARY signal/);
  });

  it('states the Locale line is a fallback hint used only when the user\'s language cannot be determined', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/is a FALLBACK HINT ONLY, used solely when the user's language cannot be determined this turn/);
  });

  it('never hardcodes French as the default language anywhere in the rule', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).not.toMatch(/[Dd]efault to French when no Locale line is present at all[.,;]/);
    expect(prompt).toMatch(/default to English/);
  });
});

describe('buildManagerSystemPrompt', () => {
  const mockAgents: StoredAgent[] = [
    {
      agent: {
        id: 'agent-1',
        name: 'my-agent',
        displayName: 'My Agent',
        description: 'A custom agent for testing purposes and validation',
        systemPrompt: 'You are a test agent',
        modelTier: 'sonnet',
        color: 'violet',
        tags: ['test'],
        scope: 'project',
        triggers: { manual: true },
        isolation: 'worktree',
        permissionMode: 'default',
        createdAt: new Date().toISOString(),
      },
      scope: 'project',
    },
  ];

  const mockMissions: Mission[] = [
    {
      id: 'M1',
      title: 'Test mission',
      status: 'running',
      model: 'Haiku 4.5',
      worktree: '.',
      progress: 50,
      planSteps: [],
      actionTimeline: [],
    } as unknown as Mission,
  ];

  it('includes agent list in the prompt', () => {
    const prompt = buildManagerSystemPrompt({ agents: mockAgents, missions: [] });
    expect(prompt).toContain('my-agent');
    expect(prompt).toContain('My Agent');
  });

  it('includes mission list in the prompt', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: mockMissions });
    expect(prompt).toContain('M1');
    expect(prompt).toContain('Test mission');
    expect(prompt).toContain('running');
  });

  it('includes brain recall when provided', () => {
    const prompt = buildManagerSystemPrompt({
      agents: [],
      missions: [],
      brainRecall: 'Brain context about the project',
    });
    expect(prompt).toContain('Brain context about the project');
  });

  it('includes action type descriptions', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
    expect(prompt).toContain('create_agent');
    expect(prompt).toContain('launch_mission');
    expect(prompt).toContain('create_loop');
    expect(prompt).toContain('stop_mission');
    expect(prompt).toContain('brain_query');
  });

  // MANAGER FALSE POSITIVE fix: create_loop had no delete/pause counterpart,
  // so the manager fell back to stop_all and falsely claimed a loop was
  // deleted while it stayed enabled:true, persisted, and still scheduled.
  it('documents pause_loop and delete_loop, and warns against faking deletion via stop_all', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
    expect(prompt).toContain('pause_loop');
    expect(prompt).toContain('delete_loop');
    expect(prompt).toMatch(/never use stop_mission or stop_all/i);
  });

  // P58 (automatic fleet hygiene) — founder's reflex rule: at the end of a
  // chain, or once clutter builds up, the manager must react (propose or
  // act) rather than stay silent about it, using its EXISTING tools —
  // never a new/invented action type.
  it('instructs the manager to propose or perform triage once non-actionable cards accumulate, via existing tools (never a new action)', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
    expect(prompt).toMatch(/fleet hygiene/i);
    expect(prompt).toContain('10');
    expect(prompt).toContain('delete_mission');
    expect(prompt).toContain('stop_all');
  });

  it('includes new action types: query_mission, get_agent_output, clone_mission', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
    expect(prompt).toContain('query_mission');
    expect(prompt).toContain('get_agent_output');
    expect(prompt).toContain('clone_mission');
  });

  it('documents the structural recall actions (brain_query_css + brain_neighbours) with a concrete selector', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
    expect(prompt).toContain('brain_query_css');
    expect(prompt).toContain('brain_neighbours');
    // The action doc must show at least one runnable data-cerveau-* selector.
    expect(prompt).toContain(':not([data-cerveau-valid-until])');
  });

  it('documents reassign_agent and answer_question, including the queued/paused-only and pending-question-only caveats', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
    expect(prompt).toContain('reassign_agent');
    expect(prompt).toMatch(/cannot hot-swap/i);
    expect(prompt).toContain('answer_question');
    expect(prompt).toMatch(/genuinely blocked|pending question/i);
  });

  it('includes mission progress and agent name in mission lines', () => {
    const mission = {
      id: 'M1',
      title: 'Test mission',
      status: 'running' as const,
      model: 'sonnet',
      progress: 50,
      agentName: 'code-reviewer',
    };
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [mission as Mission] });
    expect(prompt).toContain('50%');
    expect(prompt).toContain('@code-reviewer');
  });

  // ── P0-3 fix: "Current Missions" must mirror what the canvas actually
  // shows (real user test — the manager targeted missions already archived
  // and invisible on the board, then claimed a fabricated deletion count).
  describe('mission list — mirrors the canvas reconciler\'s real visibility (P0-3 fix)', () => {
    function missionAt(id: string, overrides: Partial<Mission> = {}): Mission {
      return {
        id,
        title: `Mission ${id}`,
        status: 'done',
        model: 'sonnet',
        ...overrides,
      } as Mission;
    }

    it('excludes an archived mission from the Current Missions list — it is already invisible on the real canvas', () => {
      const prompt = buildManagerSystemPrompt({
        agents: [],
        missions: [missionAt('M1'), missionAt('M2', { archived: true }), missionAt('M3')],
      });
      expect(prompt).toContain('M1');
      expect(prompt).toContain('M3');
      expect(prompt).not.toMatch(/-\s*M2:/);
    });

    it('keeps the MOST RECENT missions (not the oldest) once there are more than the cap', () => {
      const missions = Array.from({ length: 35 }, (_, i) => missionAt(`M${i + 1}`));
      const prompt = buildManagerSystemPrompt({ agents: [], missions });
      // The newest ones (what a user actively looking at the canvas sees)
      // must survive the cap...
      expect(prompt).toContain('M35');
      expect(prompt).toContain('M6');
      // ...while the oldest ones fall outside it — the opposite of the
      // pre-fix `missions.slice(0, 30)` behavior.
      expect(prompt).not.toMatch(/-\s*M1:/);
      expect(prompt).not.toMatch(/-\s*M5:/);
    });
  });

  // ── Continuation gap fix (2026-08-02 escalation) ─────────────────────
  // Real incident: M6 produced a real scaffold on branch
  // "agent/M6-integrer-le-scaffold-existant-"; M9/M10 continued that work as
  // standalone launch_mission calls with no way to see M6's branch, so both
  // started from an empty default branch and delivered nothing. The manager
  // must be able to SEE a mission's real result branch to set launch_mission/
  // retry_mission's "baseBranch" on a continuation.
  describe('mission list — exposes each mission\'s real result branch (continuation gap fix)', () => {
    function missionAt(id: string, overrides: Partial<Mission> = {}): Mission {
      return {
        id,
        title: `Mission ${id}`,
        status: 'done',
        model: 'sonnet',
        ...overrides,
      } as Mission;
    }

    it('includes "branch=<worktree>" on a mission line when the mission carries a real result branch', () => {
      const prompt = buildManagerSystemPrompt({
        agents: [],
        missions: [missionAt('M6', { worktree: 'agent/M6-integrer-le-scaffold-existant-' })],
      });
      expect(prompt).toContain('branch=agent/M6-integrer-le-scaffold-existant-');
    });

    it('omits the branch suffix entirely for a mission with no worktree/branch yet (never a fabricated placeholder)', () => {
      const prompt = buildManagerSystemPrompt({
        agents: [],
        missions: [missionAt('M9')],
      });
      const m9Line = prompt.split('\n').find((line) => line.startsWith('- M9:'));
      expect(m9Line).toBeDefined();
      expect(m9Line).not.toMatch(/branch=/);
    });
  });

  describe('Continuation Doctrine (base branch inheritance for standalone launches)', () => {
    it('names the doctrine and the real M6/M9/M10 incident it prevents', () => {
      const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
      expect(prompt).toContain('Continuation Doctrine');
      expect(prompt).toMatch(/98693e0/);
      expect(prompt).toMatch(/M6[\s\S]{0,80}scaffold/);
    });

    it('instructs setting "baseBranch" from a prior mission\'s branch=... line for launch_mission/retry_mission continuations', () => {
      const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
      expect(prompt).toMatch(/set "baseBranch"/);
      expect(prompt).toMatch(/branch=\.\.\./);
    });

    it('mandates REFUSING (asking, never guessing) when a continuation is referenced but no branch can be identified', () => {
      const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
      expect(prompt).toMatch(/GUARD RAIL/);
      expect(prompt).toMatch(/do NOT invent a plausible-looking branch name/);
      expect(prompt).toMatch(/Refuse the launch/);
      // Explicitly rejects the fuzzy-heuristic failure mode (real incident:
      // a project-name match relocated 50 canvas nodes) as the model to avoid.
      expect(prompt).toMatch(/never a silent name\/keyword-matching heuristic/);
    });

    it('documents "baseBranch" on the launch_mission and retry_mission action specs', () => {
      const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
      expect(prompt).toMatch(/"type": "launch_mission"[\s\S]{0,300}"baseBranch"/);
      expect(prompt).toMatch(/modifications.*may also carry.*"baseBranch"|"baseBranch".*same field\/contract as launch_mission/);
    });
  });

  // ── Brain-First Doctrine (brain-integration wave) ───────────────────
  // "les agents et le lazymanager doivent interagir avec le lazybrain de
  // manière optimale" — the manager must consult the brain BEFORE composite
  // creation orders (create_draft/chain_agents), say so honestly when recall
  // is thin, and surface real learning-loop counts after a mission completes.
  describe('Brain-First Doctrine', () => {
    it('instructs brain_query before create_draft/chain_agents composite creation orders', () => {
      const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
      expect(prompt).toContain('Brain-First Doctrine');
      expect(prompt).toMatch(/before emitting create_draft or chain_agents.*run brain_query/i);
    });

    it('instructs honest "thin recall" messaging and proposing indexing, without inventing an indexing action', () => {
      const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
      expect(prompt).toMatch(/thin or empty/i);
      expect(prompt).toMatch(/suggest indexing the project/i);
      expect(prompt).toMatch(/never emit an indexing\/reindex action/i);
      // No invented action type: this catalog has no index_project/reindex/seed action.
      expect(prompt).not.toContain('"type": "index_project"');
      expect(prompt).not.toContain('"type": "reindex"');
    });

    it('instructs surfacing real learning-loop counts via briefing_query, never a guessed number', () => {
      const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
      expect(prompt).toMatch(/briefing_query/);
      expect(prompt).toMatch(/never a guessed number/i);
    });

    it('includes a worked two-turn example (brain_query first turn, creation actions only on the grounded follow-up)', () => {
      const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
      expect(prompt).toContain('Worked example (brain-first)');
      const queryIdx = prompt.indexOf('"type": "brain_query", "query": "authentication strategy decisions"');
      const draftIdx = prompt.indexOf('"type": "create_draft", "alias": "auth"');
      expect(queryIdx).toBeGreaterThan(-1);
      expect(draftIdx).toBeGreaterThan(queryIdx);
    });
  });
});

// ── Graph Sizing — domain reasoning, not template imitation ─────────
// QA regression (2026-07-28): the manager produced the SAME 6-node graph
// (schema -> API -> 2x UI -> tests -> security review) for four unrelated
// domains (user tracking, notifications, referral program, even a
// performance complaint) because the prompt's sizing section carried a
// worked example naming a concrete domain ("build a user-tracking
// backoffice"), which the model copied instead of reasoning from the
// actual request. Fix: the sizing section now runs a deliverables-first
// reasoning procedure, an ABSTRACT fan-out shape (no domain named), and
// explicit anti-template guardrails — see FIX-BRIEF-domain-reasoning.md.
describe('buildManagerCorePrompt — Graph Sizing (domain reasoning, not template)', () => {
  it('no longer contains the concrete worked example that served as a copyable template', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).not.toContain('user-tracking backoffice');
    expect(prompt).not.toContain('list UI, detail UI');
    expect(prompt).not.toContain('Fan-out example');
    expect(prompt).not.toContain('Classify every request into ONE of four sizes');
  });

  it('replaces the concrete example with an abstract fan-out shape naming no domain', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toContain('A -> B -> {C, D}');
  });

  it('includes the deliverables-first reasoning procedure', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/name deliverables in the user's own words/i);
    expect(prompt).toMatch(/data, business logic, interaction surface, content, third-party integrations, verification/i);
    expect(prompt).toMatch(/merge shared parts, keep specific ones/i);
    expect(prompt).toMatch(/node count falls out of this, never decided upfront/i);
  });

  it('downgrades the size bands to an a-posteriori check, never a decision input', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/a posteriori check only, never used to decide/i);
  });

  it('includes the anti-template guardrails: copy detection, no shape-borrowing, diagnostic != build, domain-specificity', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toContain('ANTI-TEMPLATE GUARDRAILS');
    expect(prompt).toMatch(/matching an existing canvas chain within one word = a copy/i);
    expect(prompt).toMatch(/never derive a shape from another canvas feature/i);
    expect(prompt).toMatch(/diagnostic request \(broken\/slow\/failing\) isn't a build/i);
    expect(prompt).toMatch(/measure -> identify -> fix -> reverify, no data schema/i);
    expect(prompt).toMatch(/at least one step must resist translation to another domain/i);
  });

  it('does not regress rules proven in prior QA rounds (delegation, structuring question, honesty, archive/delete, language, info-message dedup)', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/MANDATORY DELEGATION/);
    expect(prompt).toMatch(/HARD RULE — never assume the SHAPE/);
    expect(prompt).toMatch(/THE MANAGER MUST NEVER LIE/);
    expect(prompt).toMatch(/CLEANUP DESTRUCTIVENESS/);
    // Updated deliberately (2026-08): the LANGUAGE rule no longer says
    // "always reply in the UI's current locale" — that phrasing, combined
    // with "default to French when no Locale line is present", is exactly
    // what made the manager answer an English-speaking user in French
    // inside an English-locale app. The rule now reads the user's OWN
    // message as the PRIMARY signal and treats the locale as a fallback
    // hint only — see managerEngine.ts's LANGUAGE rule and
    // ManagerContext.locale's doc comment for the full history.
    expect(prompt).toMatch(/LANGUAGE: reply in the language of the user's OWN message THIS TURN/);
    expect(prompt).toMatch(/is a FALLBACK HINT ONLY/);
    // The OLD rule's own imperative sentence (not merely the words "default
    // to French" — the new rule quotes that phrase in its own history note,
    // so a plain substring check would false-positive on the very sentence
    // explaining why it was removed) must be gone.
    expect(prompt).not.toMatch(/Default to French when no Locale line is present at all; switch away from it/);
    expect(prompt).toMatch(/NEVER REPEAT YOURSELF/);
  });
});

// ── NEVER NARRATE YOUR OWN MECHANICS (Défaut 3, qa-manager-2026-07-25/
// BILAN-NUIT.md): the manager repeatedly leaked meta-commentary about its
// own tool access/capabilities into the visible reply — e.g. "Je me
// recentre : en tant que LazyManager je n'agis que via le bloc
// lazy_actions, pas d'outils shell." The pre-existing NEVER REPEAT YOURSELF
// rule didn't cover this (it's not a repeat, it's a single self-referential
// aside) — this is a dedicated rule telling the manager to self-correct
// silently instead of narrating the correction.
describe('buildManagerCorePrompt — NEVER NARRATE YOUR OWN MECHANICS', () => {
  it('forbids commenting on own capabilities/tool access/internal limitations in the visible reply', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/NEVER NARRATE YOUR OWN MECHANICS/);
    expect(prompt).toMatch(/never comment on your own capabilities, tool access, or internal limitations/i);
  });

  it('quotes the real leaked verbatims as the bad example', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toContain('Je me recentre : en tant que LazyManager je n\'agis que via le bloc lazy_actions, pas d\'outils shell.');
    expect(prompt).toContain('Je corrige — en tant que LazyManager je n\'ai aucun accès outil direct (shell, fichiers) : tout passe uniquement par les actions structurées ci-dessous.');
  });

  it('instructs silent self-correction — show only the useful conclusion, never the correction narration', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/correct the plan SILENTLY/);
    expect(prompt).toMatch(/belongs? in your own reasoning only, never in the visible reply/);
  });
});

// ── Sizing Doctrine (UC-SCORECARD.md D/E fixes: measure before sizing,
// materialize by waves, ask on recipient ambiguity, never shrink a big ask) ──
// See qa-manager-2026-07-25/UC-SCORECARD.md — the manager had no way to
// inspect the project itself (scan_project closes that gap) and, on the two
// failing use cases, sized/decided from impression instead of a measured
// fact, or silently narrowed scope instead of asking.
describe('buildManagerCorePrompt — Sizing Doctrine (measure, then size, then materialize in waves)', () => {
  it('documents RECON BEFORE SIZING with the cheapest-first collection order', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/RECON BEFORE SIZING/);
    expect(prompt).toMatch(/brain_query.*canvas_overview\/current missions.*scan_project.*web_search/s);
    expect(prompt).toMatch(/MEASURED fact/);
  });

  it('documents MATERIALIZE IN WAVES: a sized recon wave first, graph completed from its results', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/MATERIALIZE IN WAVES, never all at once/);
    expect(prompt).toMatch(/wave 1 is a recon pass sized on scan_project's measurement/i);
    expect(prompt).toMatch(/COMPLETE the existing graph rather than starting fresh/i);
  });

  it('documents RECIPIENT AMBIGUITY: ask before assuming self vs customers', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/RECIPIENT AMBIGUITY/);
    expect(prompt).toMatch(/user's OWN account\/product.*THEIR customers/i);
    expect(prompt).toMatch(/facturation annuelle/);
    expect(prompt).toMatch(/ASK first/);
  });

  it('documents NEVER SHRINK A BIG ASK: ask scope, propose phases, name risk steps on high-risk domains', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/NEVER SHRINK A BIG ASK/);
    expect(prompt).toMatch(/occupe-toi de tout/);
    expect(prompt).toMatch(/propose PHASES \(each its own graph\), starting with recon/i);
    expect(prompt).toMatch(/fidelity bug/i);
    expect(prompt).toMatch(/compatibility with existing data\/users, migration of existing subscribers, communication to affected people, rollback plan/i);
  });

  it('does not regress rules proven in prior QA rounds alongside the new Sizing Doctrine', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/MANDATORY DELEGATION/);
    expect(prompt).toMatch(/HARD RULE — never assume the SHAPE/);
    expect(prompt).toMatch(/THE MANAGER MUST NEVER LIE/);
    expect(prompt).toMatch(/CLEANUP DESTRUCTIVENESS/);
    expect(prompt).toMatch(/ARCHIVE APPLIES TO MISSIONS ONLY/);
    // Same deliberate wording update as the earlier "does not regress rules"
    // test above — see that test's comment for the full rationale.
    expect(prompt).toMatch(/LANGUAGE: reply in the language of the user's OWN message THIS TURN/);
    expect(prompt).toMatch(/NEVER REPEAT YOURSELF/);
    expect(prompt).toMatch(/ANTI-TEMPLATE GUARDRAILS/);
    expect(prompt).toMatch(/Before emitting create_draft or chain_agents to assemble a multi-step plan, run brain_query/);
  });
});

describe('buildManagerCorePrompt — scan_project catalog documentation', () => {
  it('documents the action with its exact JSON signature (projectId/depth, both optional)', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/scan_project — Structural digest of a project's REAL size\/shape/);
    expect(prompt).toContain('{"type": "scan_project"}');
    expect(prompt).toContain('{"type": "scan_project", "projectId": "proj-id", "depth": "quick|deep"}');
    expect(prompt).toMatch(/"projectId" is optional \(omit for the active project/);
    expect(prompt).toMatch(/"depth" is optional, default "quick"/);
  });

  it('cross-references the Sizing Doctrine as the reason to use it', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/ONLY way to measure a project instead of guessing from the request text; see the Sizing Doctrine below/);
  });
});

// ── Mission Charter (charte de mission) ──────────────────────────────
// propose_mission_charter must be documented with its five blocks, decisions
// must be shown carrying a recommendation (not just a question), and the
// three distinct triggers (graph-proposal size, validation gates, trial
// mode) must never be conflated — see SPEC-CHARTE-DE-MISSION.md.
describe('buildManagerCorePrompt — Mission Charter (charte de mission)', () => {
  it('documents propose_mission_charter with its exact JSON signature (five blocks)', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toContain('propose_mission_charter');
    expect(prompt).toMatch(/"objective":/);
    expect(prompt).toMatch(/"nature":\s*{"kind": "unique\|recurring\|permanent"/);
    expect(prompt).toMatch(/"decisions":/);
    expect(prompt).toMatch(/"validationGates":/);
    expect(prompt).toMatch(/"learning":/);
  });

  it('documents decisions carrying a recommendation and rationale, not just a question', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/"recommended":/);
    expect(prompt).toMatch(/"rationale":/);
    expect(prompt).toMatch(/TAKE A STANCE, don't just ask/);
  });

  it('instructs the manager to warn and recommend better on a risky request instead of executing it silently', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/risky request \(e\.g\. too high a posting cadence\)/i);
    expect(prompt).toMatch(/never execute it silently/i);
  });

  it('documents design decisions searching the brain first, scan_project as fallback, honest when nothing found', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/Design: brain_query first, scan_project as fallback/);
    expect(prompt).toMatch(/name a found identity as an option, or say nothing was found and ask/);
  });

  it('documents the three distinct triggers and tells the manager never to conflate them', () => {
    const prompt = buildManagerCorePrompt();
    // Trigger 1: graph-proposal size (>=3 nodes)
    expect(prompt).toMatch(/>=3 nodes/);
    // Trigger 2: validation gates come from the charter, three tiers
    expect(prompt).toMatch(/frozenOnce/);
    expect(prompt).toMatch(/superviseFirstN/);
    // Trigger 3: trial mode restricted to recurring/permanent nature
    expect(prompt).toMatch(/recurring\/permanent (nature )?only/);
    expect(prompt).toMatch(/never conflate the three/i);
  });

  it('documents the recurring regime lifecycle (trial -> validated -> autonomous -> self-improving), gated to recurring/permanent only', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/Recurring regime lifecycle/);
    expect(prompt).toMatch(/trial \(every run approved, visible counter\)/);
    expect(prompt).toMatch(/validated \(promotion announced, never silent\)/);
    expect(prompt).toMatch(/autonomous \(you may pause\/adjust\/retry\/alert it yourself/);
    expect(prompt).toMatch(/self-improving \(adjusts its own choices/);
    expect(prompt).toMatch(/ONLY for a recurring\/permanent nature, never a unique task/);
    expect(prompt).toMatch(/First failure\/measure-drop demotes to trial or stops it/);
  });

  it('does not regress rules proven in prior QA rounds alongside the new Mission Charter section', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/MANDATORY DELEGATION/);
    expect(prompt).toMatch(/HARD RULE — never assume the SHAPE/);
    expect(prompt).toMatch(/THE MANAGER MUST NEVER LIE/);
    expect(prompt).toMatch(/NEVER DEGRADE IN SILENCE/);
    expect(prompt).toMatch(/RECON BEFORE SIZING/);
    expect(prompt).toMatch(/CLEANUP DESTRUCTIVENESS/);
    expect(prompt).toMatch(/NEVER REPEAT YOURSELF/);
  });
});

// Bug fix (FINDINGS-RUN-NUIT.md QA repro: "le libellé de l'option B change
// entre deux rendus (« Carte claire, style produit » puis « avec notre
// identité visuelle »)" — the manager re-emitted propose_artifact for the
// SAME design as if it were a brand-new ask, producing a second unsolicited
// chat card instead of revising the one already on screen). This section
// protects the prompt rule that closes it: a revision MUST reuse the same
// artifactId (upsertArtifactSurface's own canvas-side upsert-by-id already
// guarantees no duplicate on the canvas; this is the chat-card counterpart,
// enforced at the model-instruction level since a manager turn always
// appends a fresh ManagerMessage).
describe('buildManagerCorePrompt — propose_artifact revision (no duplicate proposal card)', () => {
  it('documents that a still-unanswered proposal is PENDING, never re-emitted as a fresh ask', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/propose_artifact/);
    expect(prompt).toMatch(/STILL PENDING|is PENDING, not closed/);
    expect(prompt).toMatch(/never re-emit propose_artifact for (it|what is really the same design) as if it were a (fresh|new) ask/);
  });

  it('documents that a genuine revision reuses the SAME artifactId and replaces the existing card/preview in place', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/REVISION/);
    expect(prompt).toMatch(/reus(e|ing) the (exact )?SAME artifactId/);
    expect(prompt).toMatch(/replaces the (pending proposal|existing card\/preview) in place/);
  });

  it('documents that selectedVariantId must never be set by the manager itself, only by the founder\'s own reply', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/Never set "selectedVariantId" (yourself|on your own initiative)/);
  });
});

// ── buildCompactModelCatalog + Pro Model Catalog prompt gating ───────
// The full catalog must only cost tokens when the Pro rail can actually use
// it — see ManagerContext.proRailActive's doc comment — and must stay
// compact (MODEL_CATALOG_MAX_CHARS) with every id kept EXACT (the manager
// copies one verbatim into a modelId field, so truncating an id would be
// actively harmful).

describe('buildCompactModelCatalog', () => {
  it(`stays within the ${MODEL_CATALOG_MAX_CHARS}-char budget`, () => {
    expect(buildCompactModelCatalog().length).toBeLessThanOrEqual(MODEL_CATALOG_MAX_CHARS);
  });

  it('lists every catalog id verbatim (never abbreviated)', () => {
    const catalog = buildCompactModelCatalog();
    for (const m of OPENROUTER_MODELS) {
      expect(catalog).toContain(m.id);
    }
  });

  it('groups by tier, not by provider', () => {
    const catalog = buildCompactModelCatalog();
    expect(catalog).toMatch(/^fast:/m);
    expect(catalog).toMatch(/^balanced:/m);
  });
});

describe('buildManagerSystemPrompt — Pro Model Catalog gating (modelId catalog wave)', () => {
  it('injects the compact catalog block when proRailActive is true', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [], proRailActive: true });
    expect(prompt).toContain('Pro Model Catalog');
    expect(prompt).toContain('anthropic/claude-sonnet-5');
  });

  it('omits the catalog block entirely when proRailActive is false or absent (CLI-only rail can never use it)', () => {
    const promptAbsent = buildManagerSystemPrompt({ agents: [], missions: [] });
    expect(promptAbsent).not.toContain('### Pro Model Catalog');

    const promptFalse = buildManagerSystemPrompt({ agents: [], missions: [], proRailActive: false });
    expect(promptFalse).not.toContain('### Pro Model Catalog');
  });
});

// ── Grounded mission-output querying ────────────────────────────────
// query_mission / get_agent_output must be answered from the mission's
// REAL actionTimeline/result/diff/metrics, never a guess. These tests
// cover the prompt-injection side (buildManagerSystemPrompt) and the
// pure formatting/truncation logic (formatMissionDetail/NotFound).

describe('buildManagerSystemPrompt — mission detail grounding', () => {
  it('includes a Mission Detail block with the real data when missionDetail is provided', () => {
    const prompt = buildManagerSystemPrompt({
      agents: [],
      missions: [],
      missionDetail: 'Mission M9: real transcript here — UNIQUE_MARKER_TEXT',
    });
    expect(prompt).toContain('UNIQUE_MARKER_TEXT');
    expect(prompt).toMatch(/Mission Detail/i);
  });

  it('omits the Mission Detail block entirely when missionDetail is absent', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
    // The Rules section permanently explains what to do *if* a Mission Detail
    // block shows up, so we assert the actual injected section heading/content
    // is absent rather than the bare phrase (which legitimately appears in Rules).
    expect(prompt).not.toContain('### Mission Detail (grounded');
    expect(prompt).not.toContain('real data fetched from the mission');
  });

  it('instructs the manager to resolve bare agent references via query_mission/get_agent_output', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
    expect(prompt.toLowerCase()).toContain('agent name');
  });

  it('instructs the manager not to repeat a query action once Mission Detail is present', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [], missionDetail: 'Mission M9: …' });
    expect(prompt).toMatch(/do not emit another query_mission/i);
  });
});

// ── buildManagerSystemPrompt — RECALL_TEACHING ──────────────────────
// The lazymanager's prompt used to describe brain_query as a bare action
// entry with no teaching on WHEN to use it, how to extract a TOPIC instead
// of the user's verbatim sentence, or how to interpret results. RECALL_
// TEACHING closes that gap — but is appended per provider-mode branch in
// runManagerTurn (see the describe block further below), NOT embedded
// directly in buildManagerSystemPrompt's own template: that template is
// threaded verbatim through rulesContext for the codex branch into
// cliBackendProvider's buildSystemPrompt('ask', ...) call, which already
// appends RECALL_TEACHING itself for any non-'transform' mode. Embedding it
// here too would silently duplicate it in the final codex-mode prompt.

describe('buildManagerSystemPrompt — RECALL_TEACHING', () => {
  it('does NOT embed RECALL_TEACHING directly (appended per-branch in runManagerTurn instead, to avoid duplicating it for codex)', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
    expect(prompt).not.toContain(RECALL_TEACHING);
  });

  it('still documents the brain_query action and its grounded follow-up', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
    expect(prompt).toContain('brain_query');
    expect(prompt).toMatch(/grounded follow-up turn/i);
  });
});

// ── buildManagerSystemPrompt — brain query result grounding ─────────
// brain_query used to be purely informational (see agentsStore.tsx's
// executeManagerAction, previously a no-op case) — these tests cover the
// prompt-injection side of making it real: a "Brain Query Result" block
// mirroring the existing "Mission Detail" grounding block.

describe('buildManagerSystemPrompt — brain query result grounding', () => {
  it('includes a Brain Query Result block with the real recall when brainQueryResult is provided', () => {
    const prompt = buildManagerSystemPrompt({
      agents: [],
      missions: [],
      brainQueryResult: 'UNIQUE_RECALL_MARKER — [#7] Decision: switched to SQLite',
    });
    expect(prompt).toContain('UNIQUE_RECALL_MARKER');
    expect(prompt).toMatch(/Brain Query Result/i);
  });

  it('omits the Brain Query Result block entirely when brainQueryResult is absent', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
    expect(prompt).not.toContain('### Brain Query Result (grounded');
  });

  it('instructs the manager not to repeat brain_query once a result is present', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [], brainQueryResult: 'Some recall text' });
    expect(prompt).toMatch(/do not emit another brain_query/i);
  });

  it('renders both Mission Detail and Brain Query Result blocks together when both are present', () => {
    const prompt = buildManagerSystemPrompt({
      agents: [],
      missions: [],
      missionDetail: 'MISSION_MARKER',
      brainQueryResult: 'BRAIN_MARKER',
    });
    expect(prompt).toContain('MISSION_MARKER');
    expect(prompt).toContain('BRAIN_MARKER');
  });
});

// ── buildManagerSystemPrompt — structural recall result grounding ───
// brain_query_css / brain_neighbours mirror brain_query: a grounded follow-up
// injects the REAL structural hits into a "Structural Recall Result" block so
// the manager answers from real data instead of guessing.

describe('buildManagerSystemPrompt — structural recall result grounding', () => {
  it('includes a Structural Recall Result block with the real hits when structuralQueryResult is provided', () => {
    const prompt = buildManagerSystemPrompt({
      agents: [],
      missions: [],
      structuralQueryResult: 'UNIQUE_STRUCT_MARKER — [#3] aside doc-warning: never do X',
    });
    expect(prompt).toContain('UNIQUE_STRUCT_MARKER');
    expect(prompt).toMatch(/Structural Recall Result/i);
  });

  it('omits the Structural Recall Result block entirely when structuralQueryResult is absent', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
    expect(prompt).not.toContain('### Structural Recall Result (grounded');
  });

  it('instructs the manager not to repeat a structural action once a result is present', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [], structuralQueryResult: 'Some hits' });
    expect(prompt).toMatch(/do not emit another brain_query_css/i);
  });
});

// ── buildManagerSystemPrompt — startup context snapshot ──────────────
// Mirrors systemPrompts.ts's opts.startupContext (main assistant chat):
// recent-sessions/salient-notes snapshot, injected on the manager's first
// turn only (see agentsStore.tsx's sendManagerMessage / isFirstTurn).

describe('buildManagerSystemPrompt — startup context snapshot', () => {
  it('includes the startup context block when provided', () => {
    const prompt = buildManagerSystemPrompt({
      agents: [],
      missions: [],
      startupContext: 'Recent session: refactored auth module.',
    });
    expect(prompt).toContain('<brain_startup_context>');
    expect(prompt).toContain('Recent session: refactored auth module.');
  });

  it('omits the startup context block when absent or blank', () => {
    const promptAbsent = buildManagerSystemPrompt({ agents: [], missions: [] });
    expect(promptAbsent).not.toContain('<brain_startup_context>');

    const promptBlank = buildManagerSystemPrompt({ agents: [], missions: [], startupContext: '   ' });
    expect(promptBlank).not.toContain('<brain_startup_context>');
  });
});

describe('formatMissionDetail', () => {
  function baseMission(overrides: Partial<Mission> = {}): Mission {
    return {
      id: 'M42',
      title: 'Implement OAuth2 PKCE flow',
      status: 'review',
      model: 'Sonnet 4.6',
      ...overrides,
    } as Mission;
  }

  it('includes the real status, agent and a faithful result extracted from the timeline', () => {
    const mission = baseMission({
      agentName: 'reviewer',
      progress: 100,
      actionTimeline: [
        { time: '10:00', text: 'Read auth.ts' },
        { time: '10:05', text: 'Résultat: PKCE flow implemented, 0 failing tests' },
      ],
    });
    const detail = formatMissionDetail(mission);
    expect(detail).toContain('M42');
    expect(detail).toContain('review');
    expect(detail).toContain('@reviewer');
    expect(detail).toContain('Résultat: PKCE flow implemented, 0 failing tests');
    expect(detail).toContain('Read auth.ts');
  });

  it('falls back to the latest timeline entry when there is no explicit Résultat: entry', () => {
    const mission = baseMission({
      actionTimeline: [
        { time: '10:00', text: 'Read auth.ts' },
        { time: '10:05', text: 'Edited auth.ts +40/-12' },
      ],
    });
    const detail = formatMissionDetail(mission);
    expect(detail).toContain('Result/output: Edited auth.ts +40/-12');
  });

  it('falls back gracefully when there is no timeline, result or liveAction', () => {
    const mission = baseMission();
    const detail = formatMissionDetail(mission);
    expect(detail).toContain('M42');
    expect(detail).toContain('no output recorded yet');
  });

  // ── M12 dogfood fix (MAJEUR #6c): an [eval] line must never be shown as
  // the mission's "Result/output" — it is a judge/evaluator status message
  // appended by runtime.ts's evaluation pipeline AFTER the agent's own work
  // finishes, not the agent's own summary. See missionOutput.ts's
  // extractFinalOutput for the shared DataInspector-facing twin of this fix.

  it('never surfaces a trailing [eval] line as the result — falls back to the agent\'s own latest entry instead', () => {
    const mission = baseMission({
      actionTimeline: [
        { time: '10:00', text: 'Read auth.ts' },
        { time: '10:05', text: 'Edited auth.ts +40/-12' },
        { time: '10:06', text: '[eval] Évaluation terminée — score: 85 — PASSÉ' },
      ],
    });
    const detail = formatMissionDetail(mission);
    expect(detail).toContain('Result/output: Edited auth.ts +40/-12');
    expect(detail).not.toContain('Result/output: [eval]');
  });

  it('still prefers an explicit Résultat: marker even when a LATER [eval] line exists', () => {
    const mission = baseMission({
      actionTimeline: [
        { time: '10:00', text: 'Read auth.ts' },
        { time: '10:05', text: 'Résultat: PKCE flow implemented, 0 failing tests' },
        { time: '10:06', text: '[eval] Évaluation terminée — score: 85 — PASSÉ' },
      ],
    });
    const detail = formatMissionDetail(mission);
    expect(detail).toContain('Result/output: Résultat: PKCE flow implemented, 0 failing tests');
    expect(detail).not.toContain('Result/output: [eval]');
  });

  it('falls back to liveAction when the ENTIRE timeline is eval-only', () => {
    const mission = baseMission({
      actionTimeline: [{ time: '10:06', text: '[eval] Évaluation en cours…' }],
      liveAction: 'En attente de revue',
    });
    const detail = formatMissionDetail(mission);
    expect(detail).toContain('Result/output: En attente de revue');
  });

  it('honours a small requested entry count exactly', () => {
    const timeline = Array.from({ length: 50 }, (_, i) => ({ time: `t${i}`, text: `MARK-${i}` }));
    const mission = baseMission({ actionTimeline: timeline });
    const detail = formatMissionDetail(mission, { maxTimelineEntries: 2 });
    expect(detail).toContain('MARK-49');
    expect(detail).toContain('MARK-48');
    expect(detail).not.toContain('MARK-47');
  });

  it('clamps an oversized requested entry count to a safe hard cap, never the full timeline', () => {
    const timeline = Array.from({ length: 50 }, (_, i) => ({ time: `t${i}`, text: `MARK-${i}` }));
    const mission = baseMission({ actionTimeline: timeline });
    const detail = formatMissionDetail(mission, { maxTimelineEntries: 9999 });
    expect(detail).toContain('MARK-49');
    expect(detail).not.toContain('MARK-0');
    expect(detail).not.toContain('MARK-10');
    expect(detail).toMatch(/truncated/i);
  });

  it('truncates an overly long result/output text with a marker', () => {
    const longText = 'x'.repeat(2000);
    const mission = baseMission({ actionTimeline: [{ time: '10:00', text: longText }] });
    const detail = formatMissionDetail(mission);
    expect(detail.length).toBeLessThan(longText.length);
    expect(detail).toMatch(/truncated/i);
  });

  it('includes diff summary, judge verdict and metrics when present', () => {
    const mission = baseMission({
      diffFiles: [{ filename: 'auth.ts', added: 40, removed: 12 }],
      diffAdded: 40,
      diffRemoved: 12,
      judgeVerdict: {
        score: 87,
        passed: true,
        risk: 'low',
        reviewers: [{ role: 'reviewer', verdict: 'approve', summary: 'Looks solid, good test coverage' }],
        createdAt: new Date().toISOString(),
      },
      agentMetrics: { durationMs: 12500, inputTokens: 4000, outputTokens: 800, costUsd: 0.12, toolCount: 7 },
    });
    const detail = formatMissionDetail(mission);
    expect(detail).toContain('auth.ts');
    expect(detail).toContain('87');
    expect(detail).toContain('approve');
    expect(detail).toContain('7 tool calls');
  });

  it('never throws on a minimal mission object', () => {
    expect(() => formatMissionDetail(baseMission())).not.toThrow();
  });
});

describe('formatMissionNotFound', () => {
  it('produces an honest not-found message that names the identifier', () => {
    const msg = formatMissionNotFound('@ghost-agent');
    expect(msg).toContain('@ghost-agent');
    expect(msg.toLowerCase()).toMatch(/no mission|not found|nothing/);
  });
});

describe('createMessageId', () => {
  it('creates a unique message id', () => {
    const id1 = createMessageId();
    const id2 = createMessageId();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^msg-\d+-[a-z0-9]+$/);
  });
});

// ── resolveManagerModelId ────────────────────────────────────────────
// launch_mission / create_loop actions carry a tier hint ("haiku" | "sonnet"
// | "opus", never a literal model id — see the action contract in
// buildManagerSystemPrompt). The resolved id must belong to the id family
// the CURRENT provider mode's backend accepts: this is what stopped mission
// M15 from dying at the execution layer with "Modèle non supporté".

describe('resolveManagerModelId', () => {
  const anthropicOpenRouterIds = OPENROUTER_MODELS.filter((m) => m.provider === 'Anthropic').map((m) => m.id);

  it('falls back to the mode default when no tier is given (managed mode -> OpenRouter id)', () => {
    expect(resolveManagerModelId(undefined, 'managed')).toBe(DEFAULT_OPENROUTER_MODEL_ID);
  });

  it('falls back to the mode default when no tier is given (claude-code mode -> native id)', () => {
    expect(resolveManagerModelId(undefined, 'claude-code')).toBe(DEFAULT_MODEL.id);
  });

  it('resolves "haiku" to a valid OpenRouter id in managed mode', () => {
    const id = resolveManagerModelId('haiku', 'managed');
    expect(id).toContain('/');
    expect(anthropicOpenRouterIds).toContain(id);
    expect(id.toLowerCase()).toContain('haiku');
  });

  it('resolves "sonnet" to a valid OpenRouter id in pro mode', () => {
    const id = resolveManagerModelId('sonnet', 'pro');
    expect(anthropicOpenRouterIds).toContain(id);
    expect(id.toLowerCase()).toContain('sonnet');
  });

  it('resolves "opus" to a valid OpenRouter id in managed mode', () => {
    const id = resolveManagerModelId('opus', 'managed');
    expect(anthropicOpenRouterIds).toContain(id);
    expect(id.toLowerCase()).toContain('opus');
  });

  it('resolves "haiku" to the native Anthropic id in claude-code mode', () => {
    expect(resolveManagerModelId('haiku', 'claude-code')).toBe('claude-haiku-4-5');
  });

  it('resolves "sonnet" to the native Anthropic id in claude-code mode', () => {
    expect(resolveManagerModelId('sonnet', 'claude-code')).toBe('claude-sonnet-5');
  });

  it('resolves "opus" to the native Anthropic id in claude-code mode', () => {
    expect(resolveManagerModelId('opus', 'claude-code')).toBe('claude-opus-5');
  });

  it('resolves a tier the same way in codex mode as in claude-code mode (native id family)', () => {
    expect(resolveManagerModelId('haiku', 'codex')).toBe(resolveManagerModelId('haiku', 'claude-code'));
  });

  it('never returns a native id for a managed-mode tier (would 400 "Modèle non supporté" at the ai-proxy)', () => {
    for (const tier of ['haiku', 'sonnet', 'opus']) {
      expect(resolveManagerModelId(tier, 'managed')).toContain('/');
    }
  });

  it('never returns an OpenRouter id for a claude-code-mode tier', () => {
    for (const tier of ['haiku', 'sonnet', 'opus']) {
      expect(resolveManagerModelId(tier, 'claude-code')).not.toContain('/');
    }
  });

  it('is case-insensitive on the tier hint', () => {
    expect(resolveManagerModelId('HAIKU', 'claude-code')).toBe('claude-haiku-4-5');
  });

  it('falls back to the mode default for an unrecognised tier string', () => {
    expect(resolveManagerModelId('turbo', 'managed')).toBe(DEFAULT_OPENROUTER_MODEL_ID);
  });
});

// ── resolveManagerModelId — BUG-2 fleet routing fallback ─────────────
// Fleet workers must not blindly land on the metered managed pool when the
// managed wallet is known-empty AND a native CLI subscription is detected —
// see managerEngine.ts's isManagedModelReady/isNativeModelReady import from
// runtime.ts (the same mode-independent readiness signals runtime.ts's own
// per-mission dispatch already uses).

describe('resolveManagerModelId — BUG-2 fallback to native when managed is unready', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves a tier hint to the NATIVE id family when mode is managed but Pro is not usable and a CLI subscription is detected', () => {
    mockedIsManagedModelReady.mockReturnValueOnce(false);
    mockedIsNativeModelReady.mockReturnValueOnce(true);

    const id = resolveManagerModelId('sonnet', 'managed');

    expect(id).toBe('claude-sonnet-5');
    expect(id).not.toContain('/');
  });

  it('resolves the no-tier default to the native id family under the same fallback conditions', () => {
    mockedIsManagedModelReady.mockReturnValueOnce(false);
    mockedIsNativeModelReady.mockReturnValueOnce(true);

    expect(resolveManagerModelId(undefined, 'pro')).toBe(DEFAULT_MODEL.id);
  });

  it('stays on the managed pool when Pro IS usable, even if a native CLI is also detected', () => {
    mockedIsManagedModelReady.mockReturnValueOnce(true);

    const id = resolveManagerModelId('haiku', 'managed');

    expect(id).toContain('/');
    expect(mockedIsNativeModelReady).not.toHaveBeenCalled();
  });

  it('stays on the managed pool when Pro is unready but no native CLI is detected either (nothing to fall back to)', () => {
    mockedIsManagedModelReady.mockReturnValueOnce(false);
    mockedIsNativeModelReady.mockReturnValueOnce(false);

    const id = resolveManagerModelId('opus', 'managed');

    expect(id).toContain('/');
  });

  it('never consults readiness signals for a non-managed mode (claude-code/codex are unaffected)', () => {
    resolveManagerModelId('sonnet', 'claude-code');

    expect(mockedIsManagedModelReady).not.toHaveBeenCalled();
    expect(mockedIsNativeModelReady).not.toHaveBeenCalled();
  });
});

// ── resolveManagerModelId — engineOverride (STACK fix, bidirectional) ──
// A user can hold both a Claude CLI subscription and an active Lazy Pro plan
// at once — the manager must be able to deliberately target EITHER family
// per mission via the action's own "engine" field, not just be rescued
// one-directionally out of managed by BUG-2 above.

describe('resolveManagerModelId — engineOverride (STACK fix)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('engine "cli" resolves to the native id family even while mode is managed', () => {
    const id = resolveManagerModelId('sonnet', 'managed', 'cli');
    expect(id).toBe('claude-sonnet-5');
    expect(id).not.toContain('/');
  });

  it('engine "pro" resolves to the managed (OpenRouter) id family even while mode is claude-code — the reverse direction BUG-2 alone could not do', () => {
    const id = resolveManagerModelId('haiku', 'claude-code', 'pro');
    expect(id).toContain('/');
    expect(id.toLowerCase()).toContain('haiku');
  });

  it('engine "cli" with no tier hint falls back to the native default model id', () => {
    expect(resolveManagerModelId(undefined, 'managed', 'cli')).toBe(DEFAULT_MODEL.id);
  });

  it('engine "pro" with no tier hint falls back to the managed default model id', () => {
    expect(resolveManagerModelId(undefined, 'codex', 'pro')).toBe(DEFAULT_OPENROUTER_MODEL_ID);
  });

  it('a deliberate engine choice is never second-guessed by the BUG-2 automatic rescue — readiness signals are not even consulted', () => {
    resolveManagerModelId('sonnet', 'managed', 'cli');

    expect(mockedIsManagedModelReady).not.toHaveBeenCalled();
    expect(mockedIsNativeModelReady).not.toHaveBeenCalled();
  });

  it('respects the configured CLI tool for engine "cli" — codex, not always claude-code', () => {
    // getDefaultModelIdForMode('codex') returns the '' sentinel (Codex CLI
    // picks its own model — see that function's doc comment), distinct from
    // 'claude-code''s DEFAULT_MODEL.id — the observable difference that
    // proves nativeEngineMode() actually read the configured cliTool instead
    // of hardcoding 'claude-code'. Restores the real localStorage entry
    // afterward so this test cannot leak into any other test in this file.
    const original = localStorage.getItem('lazy.accessSettings');
    try {
      localStorage.setItem('lazy.accessSettings', JSON.stringify({ cliTool: 'codex' }));
      expect(resolveManagerModelId(undefined, 'managed', 'cli')).toBe('');
    } finally {
      if (original === null) localStorage.removeItem('lazy.accessSettings');
      else localStorage.setItem('lazy.accessSettings', original);
    }
  });

  it('omitting engineOverride keeps today\'s default mode-based behavior unchanged', () => {
    expect(resolveManagerModelId('opus', 'managed')).toBe(resolveManagerModelId('opus', 'managed', undefined));
  });
});

// ── resolveManagerModelId — modelId (exact catalog id, catalog wave) ──
// The manager should be able to route to the BEST model for a task, not just
// a tier — a modelId (exact catalog id) must be checked BEFORE the tier hint,
// validated against the CURRENT effective rail's real catalog, and NEVER
// silently swapped for a default when it does not belong there (NEVER
// DEGRADE IN SILENCE).

describe('resolveManagerModelId — modelId (exact catalog id)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('an exact id is recognized and takes priority over a tier hint on the managed/Pro rail', () => {
    const id = resolveManagerModelId('haiku', 'managed', undefined, 'openai/gpt-5.6-luna');
    expect(id).toBe('openai/gpt-5.6-luna');
  });

  it('an exact id is recognized and takes priority over a tier hint on the native/CLI rail', () => {
    const id = resolveManagerModelId('opus', 'claude-code', undefined, DEFAULT_MODEL.id);
    expect(id).toBe(DEFAULT_MODEL.id);
  });

  it('the full OpenRouter catalog is now reachable on the Pro rail, not just the 4 Anthropic entries', () => {
    // Pre-fix, the managed pool was filtered to managedAnthropicModels() —
    // a non-Anthropic id like this one would have been unreachable even via
    // the tier-word path, let alone an exact modelId.
    const id = resolveManagerModelId(undefined, 'pro', undefined, 'deepseek/deepseek-v4-flash');
    expect(id).toBe('deepseek/deepseek-v4-flash');
  });

  it('an unknown modelId on the Pro rail throws instead of silently falling back to the default', () => {
    expect(() => resolveManagerModelId(undefined, 'managed', undefined, 'not-a-real/model-id')).toThrow(
      /not-a-real\/model-id/,
    );
  });

  it('an unknown modelId on the CLI rail throws instead of silently falling back to the default', () => {
    expect(() => resolveManagerModelId(undefined, 'claude-code', undefined, 'not-a-real-id')).toThrow(
      /not-a-real-id/,
    );
  });

  it('a same-rail id wearing an OpenRouter-style vendor prefix is tolerantly normalized on the CLI rail (real prod bug, night of 2026-08-04)', () => {
    // The manager routinely named a step "anthropic/claude-sonnet-5" while
    // the CLI rail was in effect — a trivially-safe rename (correct vendor,
    // real bare id underneath) that used to hard-fail the whole action. See
    // resolveBareRailModelId's own doc comment for the full incident.
    expect(resolveManagerModelId(undefined, 'claude-code', undefined, 'anthropic/claude-sonnet-5')).toBe(
      'claude-sonnet-5',
    );
  });

  it('a vendor-prefixed id with NO presence anywhere (same rail OR any other rail) is still honestly refused, never guessed', () => {
    // Genuinely unknown — stripping the vendor prefix finds no same-rail
    // match, and the inferred-rail-switch wave (see the dedicated describe
    // block below) finds no OTHER rail either, so this stays a plain,
    // unchanged rejection, never a silent guess. (A real OpenRouter id like
    // "openai/gpt-5.6-luna" requested on the CLI rail is now a SWITCH to the
    // Pro rail instead of a rejection — see "resolveManagerModelId —
    // inferred model rail switch" below; it is intentionally no longer an
    // example here.)
    expect(() => resolveManagerModelId(undefined, 'claude-code', undefined, 'openai/totally-bogus-model')).toThrow(
      /openai\/totally-bogus-model/,
    );
  });

  it('a vendor-prefixed id whose bare form IS real but whose vendor disagrees with the rail is an ambiguous collision, not a silent guess', () => {
    // "claude-sonnet-5" is real on the CLI rail, but nothing there is made
    // by "openai" — the mismatch is surfaced in the message, never resolved
    // by silently picking a side.
    expect(() => resolveManagerModelId(undefined, 'claude-code', undefined, 'openai/claude-sonnet-5')).toThrow(
      /does not match this rail's own provider/,
    );
  });

  it('a valid CLI-rail (native) id requested on the Pro rail now switches to CLI (inferred-rail-switch wave) instead of being rejected', () => {
    // Pre-inferred-rail-switch this threw ("never reinterpreted"); now that
    // DEFAULT_MODEL.id has exactly one other real home (the CLI rail, no
    // BYOK provider configured in this test), it silently switches there —
    // see "resolveManagerModelId — inferred model rail switch" below for
    // the dedicated coverage of this wave, including the ambiguous/
    // not-found-anywhere cases that DO still reject.
    expect(resolveManagerModelId(undefined, 'managed', undefined, DEFAULT_MODEL.id)).toBe(DEFAULT_MODEL.id);
  });

  it('an unknown modelId error is a typed UnknownManagerModelIdError naming the rail actually checked', () => {
    try {
      resolveManagerModelId(undefined, 'managed', undefined, 'nope');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownManagerModelIdError);
      expect((err as UnknownManagerModelIdError).rail).toBe('pro');
      expect((err as UnknownManagerModelIdError).modelId).toBe('nope');
    }
    try {
      resolveManagerModelId(undefined, 'claude-code', undefined, 'nope');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownManagerModelIdError);
      expect((err as UnknownManagerModelIdError).rail).toBe('cli');
    }
  });

  it('respects a deliberate engine override when validating modelId (engine "cli" checks the native catalog even while mode is managed)', () => {
    // Still checks the REAL native catalog, not "anything goes" — an id with
    // no presence ANYWHERE (same rail OR any other rail, so the
    // inferred-rail-switch wave finds nothing to rescue it with either)
    // stays rejected...
    expect(() => resolveManagerModelId(undefined, 'managed', 'cli', 'openai/totally-bogus-model')).toThrow();
    // ...while an OpenRouter-style id for a model that IS on this rail is
    // tolerated through the override path too (same resolveBareRailModelId
    // normalization as the ambient-mode case above).
    expect(resolveManagerModelId(undefined, 'managed', 'cli', 'anthropic/claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(resolveManagerModelId(undefined, 'managed', 'cli', DEFAULT_MODEL.id)).toBe(DEFAULT_MODEL.id);
  });

  it('omitting modelId keeps the existing tier-only behavior unchanged', () => {
    expect(resolveManagerModelId('sonnet', 'managed')).toBe(resolveManagerModelId('sonnet', 'managed', undefined, undefined));
  });
});

// ── Tolerant modelId normalization — pure helpers (2026-08-05 fix) ───────
// Unit-tested directly against SYNTHETIC catalogs (not the real ALL_MODELS/
// OPENROUTER_MODELS content), so these prove the normalization LOGIC in
// isolation; the resolveManagerModelId describe blocks above already prove
// the real-catalog wiring end-to-end (e.g. "anthropic/claude-sonnet-5" on
// the CLI rail).

describe('resolveBareRailModelId', () => {
  it('alias -> native: a matching-vendor prefixed id strips to a real catalog id and is accepted', () => {
    expect(resolveBareRailModelId('acme/widget-7', ['widget-7', 'widget-8'], 'acme')).toEqual({
      ok: true,
      id: 'widget-7',
    });
  });

  it('an exact match short-circuits before any stripping is attempted', () => {
    expect(resolveBareRailModelId('widget-7', ['widget-7'], 'acme')).toEqual({ ok: true, id: 'widget-7' });
  });

  it('vendor comparison is case/punctuation-insensitive (e.g. an "X-AI"-shaped prefix against an "x-ai" token)', () => {
    expect(resolveBareRailModelId('X-AI/widget-7', ['widget-7'], 'x-ai')).toEqual({ ok: true, id: 'widget-7' });
  });

  it('unknown -> rejection unchanged: no catalog entry at all, stripped or not, yields a bare hint-less rejection', () => {
    expect(resolveBareRailModelId('other/does-not-exist', ['widget-7'], 'acme')).toEqual({ ok: false });
    expect(resolveBareRailModelId('does-not-exist', ['widget-7'], 'acme')).toEqual({ ok: false });
  });

  it('ambiguous collision -> rejection WITH a message: the bare id is real, but the claimed vendor disagrees with this rail', () => {
    const result = resolveBareRailModelId('rival/widget-7', ['widget-7'], 'acme');
    expect(result.ok).toBe(false);
    expect((result as { hint?: string }).hint).toMatch(/does not match this rail's own provider/);
    expect((result as { hint?: string }).hint).toContain('widget-7');
  });
});

describe('findOpenRouterAliasHint', () => {
  it('proposes the real OpenRouter equivalent for the curated DeepSeek alias — the Pro-rail branch of the reported bug', () => {
    expect(findOpenRouterAliasHint('deepseek/deepseek-chat')).toContain('deepseek/deepseek-v4-flash');
  });

  it('works from the bare native id too (no vendor prefix supplied)', () => {
    expect(findOpenRouterAliasHint('deepseek-chat')).toContain('deepseek/deepseek-v4-flash');
  });

  it('returns undefined for deepseek-reasoner — R1 left the managed catalog, and a near-miss must not be proposed', () => {
    // The alias table maps ids that are the SAME model spelled differently.
    // Pointing 'deepseek-reasoner' at V4 Pro would propose a DIFFERENT model.
    expect(findOpenRouterAliasHint('deepseek-reasoner')).toBeUndefined();
  });

  it('returns undefined for an id with no curated alias — the "unknown -> unchanged" case for this helper', () => {
    expect(findOpenRouterAliasHint('not-a-real-id')).toBeUndefined();
  });
});

describe('findByokHomeHint', () => {
  it('finds a real id on its BYOK provider catalog and names the provider', () => {
    expect(findByokHomeHint('claude-haiku-4-5')).toContain('Anthropic BYOK rail');
  });

  it('strips a vendor prefix before searching', () => {
    expect(findByokHomeHint('deepseek/deepseek-chat')).toContain('DeepSeek BYOK rail');
  });

  it('returns undefined when the id is not on ANY BYOK provider catalog', () => {
    expect(findByokHomeHint('not-a-real-id')).toBeUndefined();
  });
});

describe('resolveManagerModelId — tolerant normalization integration (real catalogs)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Pro rail: "deepseek/deepseek-chat" is rejected but the message proposes the real OpenRouter equivalent', () => {
    expect(() => resolveManagerModelId(undefined, 'managed', undefined, 'deepseek/deepseek-chat')).toThrow(
      /deepseek\/deepseek-v4-flash/,
    );
  });

  it('BYOK rail: an OpenRouter-style id for the SAME selected provider strips and is silently accepted, tagged via console.warn', () => {
    const original = localStorage.getItem('lazy.accessSettings');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      localStorage.setItem('lazy.accessSettings', JSON.stringify({ byokProvider: 'deepseek' }));

      const id = resolveManagerModelId(undefined, 'live-key', undefined, 'deepseek/deepseek-chat');

      expect(id).toBe('deepseek-chat');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[manager-model-id-normalize]'));
    } finally {
      warnSpy.mockRestore();
      if (original === null) localStorage.removeItem('lazy.accessSettings');
      else localStorage.setItem('lazy.accessSettings', original);
    }
  });
});

// ── resolveManagerModelId — inferred model rail (2026-08-05 night 2) ──
// When a modelId is not on the rail actually requested but is real on
// EXACTLY ONE other rail the user can plausibly run on right now (a
// configured BYOK provider, the CLI rail, or the Pro rail), the effective
// rail is silently switched instead of rejecting. Two or more candidate
// rails, or none at all, still fall through to the honest rejection. Global
// afterEach (setup.ts) clears localStorage after every test, so each test
// below starts from a clean, unconfigured slate.

describe('resolveManagerModelId — inferred model rail switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deepseek-chat requested on the Pro/managed rail switches to the configured DeepSeek BYOK rail', () => {
    localStorage.setItem('lazy.apikey.deepseek', 'sk-test-key');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const id = resolveManagerModelId(undefined, 'managed', undefined, 'deepseek-chat');

    expect(id).toBe('deepseek-chat');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[manager-model-rail-switch]'));
    warnSpy.mockRestore();
  });

  it('claude-sonnet-5 requested on the BYOK DeepSeek rail switches to the CLI/native rail', () => {
    localStorage.setItem('lazy.accessSettings', JSON.stringify({ byokProvider: 'deepseek' }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const id = resolveManagerModelId(undefined, 'live-key', undefined, 'claude-sonnet-5');

    expect(id).toBe('claude-sonnet-5');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[manager-model-rail-switch]'));
    warnSpy.mockRestore();
  });

  it('a modelId real on 2 OTHER rails at once (Pro + a configured BYOK provider) is rejected as ambiguous, never guessed', () => {
    // "deepseek/deepseek-v4-flash" is a real Pro/OpenRouter catalog id AND a
    // real id on a configured BYOK OpenRouter rail — two equally valid other
    // homes, so this must stay a rejection.
    localStorage.setItem('lazy.apikey.openrouter', 'sk-test-key');

    expect(() => resolveManagerModelId(undefined, 'claude-code', undefined, 'deepseek/deepseek-v4-flash')).toThrow(
      /exists on 2 different rails/,
    );
  });

  it('a modelId with no home on ANY rail is rejected outright, even with a BYOK provider configured', () => {
    localStorage.setItem('lazy.apikey.deepseek', 'sk-test-key');

    expect(() => resolveManagerModelId(undefined, 'managed', undefined, 'totally-bogus-id')).toThrow(
      UnknownManagerModelIdError,
    );
  });

  it('never switches to an UNCONFIGURED BYOK provider (no key set) — 0 candidates stays a plain rejection', () => {
    // Same id as the first test above, but this time no DeepSeek key is
    // configured — the BYOK rail is not something the user can actually run
    // on right now, so it must never be silently offered as a switch target.
    expect(() => resolveManagerModelId(undefined, 'managed', undefined, 'deepseek-chat')).toThrow(
      UnknownManagerModelIdError,
    );
  });
});

describe('findAlternateRailMatches', () => {
  it('finds the CLI rail as the sole alternate for a native id requested on a configured BYOK rail', () => {
    const matches = findAlternateRailMatches('claude-sonnet-5', 'byok', undefined);
    expect(matches).toEqual([{ rail: 'cli', id: 'claude-sonnet-5', label: 'cli' }]);
  });

  it('excludes the anthropic BYOK def so a native id never manufactures a false cli/byok ambiguity', () => {
    // Even though BYOK_PROVIDER_DEFS has its own 'anthropic' entry carrying
    // 'claude-sonnet-5' too, it must never be offered as a second candidate.
    const matches = findAlternateRailMatches('claude-sonnet-5', 'pro', undefined);
    expect(matches).toEqual([{ rail: 'cli', id: 'claude-sonnet-5', label: 'cli' }]);
  });

  it('returns no candidates for a rail the caller already requested (never re-offers it to itself)', () => {
    expect(findAlternateRailMatches('claude-sonnet-5', 'cli', undefined)).toEqual([]);
  });

  it('returns no candidates when a matching BYOK provider exists but has no key configured', () => {
    expect(findAlternateRailMatches('deepseek-chat', 'pro', undefined)).toEqual([]);
  });
});

// ── runManagerTurn — provider-mode routing ──────────────────────────
// The manager's single planning turn must route to the backend matching the
// CURRENT provider mode: streamClaudeCodeTurn for claude-code,
// cliBackendProvider('codex').streamChat for codex, streamManagedAgentTurn
// (the managed/pro ai-proxy) otherwise. Regression coverage: codex used to
// fall into the "else" branch and silently hit the managed proxy, which
// requires a Supabase session and is unrelated to the codex CLI, so the
// LazyManager turn failed outright for codex-only users.

describe('runManagerTurn — provider mode routing', () => {
  function makeMessages(): ManagerMessage[] {
    return [
      {
        id: 'm1',
        role: 'user',
        content: 'où en est @reviewer sur le module auth ?',
        timestamp: new Date().toISOString(),
      },
    ];
  }

  function baseOpts(model: string) {
    return {
      messages: makeMessages(),
      context: { agents: [], missions: [] },
      model,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('claude-code mode routes to streamClaudeCodeTurn with a native model id, never the codex or managed backends (unchanged)', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    mockedStreamClaudeCodeTurn.mockImplementation(() => fakeStream('info from claude-code'));

    const result = await runManagerTurn(baseOpts('sonnet'));

    expect(mockedStreamClaudeCodeTurn).toHaveBeenCalledTimes(1);
    expect(mockedStreamClaudeCodeTurn.mock.calls[0][0].model).toBe('claude-sonnet-5');
    expect(result.rawResponse).toContain('info from claude-code');
    expect(mockedStreamManagedAgentTurn).not.toHaveBeenCalled();
    expect(mockedCliBackendProvider).not.toHaveBeenCalled();
  });

  it('managed mode routes to streamManagedAgentTurn, never the codex backend (unchanged)', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    mockedStreamManagedAgentTurn.mockImplementation(() => fakeStream('info from managed'));

    const result = await runManagerTurn(baseOpts('anthropic/claude-sonnet-5'));

    expect(mockedStreamManagedAgentTurn).toHaveBeenCalledTimes(1);
    expect(result.rawResponse).toContain('info from managed');
    expect(mockedStreamClaudeCodeTurn).not.toHaveBeenCalled();
    expect(mockedCliBackendProvider).not.toHaveBeenCalled();
  });

  it('pro mode also routes to streamManagedAgentTurn, never the codex backend (unchanged)', async () => {
    mockedGetProviderMode.mockReturnValue('pro');
    mockedStreamManagedAgentTurn.mockImplementation(() => fakeStream('info from pro'));

    await runManagerTurn(baseOpts('anthropic/claude-haiku-4.5'));

    expect(mockedStreamManagedAgentTurn).toHaveBeenCalledTimes(1);
    expect(mockedCliBackendProvider).not.toHaveBeenCalled();
  });

  it('web mock mode + GLM 5.2 still uses the managed proxy (needs a session, not the CLI)', async () => {
    mockedGetProviderMode.mockReturnValue('mock');
    mockedStreamManagedAgentTurn.mockImplementation(() => fakeStream('ok from ox'));

    const result = await runManagerTurn(baseOpts('z-ai/glm-5.2'));

    expect(mockedStreamManagedAgentTurn).toHaveBeenCalledTimes(1);
    expect(result.rawResponse).toContain('ok from ox');
    expect(mockedStreamClaudeCodeTurn).not.toHaveBeenCalled();
  });

  it('web mock mode + native Sonnet does not pretend to be managed — measured LazyManager error 2026-08-28', async () => {
    mockedGetProviderMode.mockReturnValue('mock');

    await expect(runManagerTurn(baseOpts('claude-sonnet-5'))).rejects.toThrow(/GLM 5\.2|desktop/i);
    expect(mockedStreamManagedAgentTurn).not.toHaveBeenCalled();
    expect(mockedStreamClaudeCodeTurn).not.toHaveBeenCalled();
  });

  // F1 regression (post-e2e fix wave): AnalysisDesk/LazyManagerRail's model
  // picker (buildModelPickerOptions) can offer a native-id option (claude-sub
  // entitlement group) at the same time as an OpenRouter-id option (Pro
  // entitlement group) — a user can hold both entitlements at once even
  // though getProviderMode() only ever resolves to ONE active backend (see
  // modelPickerOptions.ts's module doc comment). Selecting the native-id
  // option while the resolved mode is 'managed'/'pro' used to forward that
  // native id straight to the ai-proxy unmodified, which rejected it as an
  // unrecognized model: "ManagedUnavailableError: Modèle non supporté".
  it('managed mode normalizes a native-id model selection to a valid OpenRouter id — the "Modèle non supporté" bug this fixes', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    mockedStreamManagedAgentTurn.mockImplementation(() => fakeStream('ok'));

    await runManagerTurn(baseOpts('claude-haiku-4-5'));

    const sentModel = mockedStreamManagedAgentTurn.mock.calls[0][0].model as string;
    expect(sentModel).toBe('anthropic/claude-haiku-4.5');
    expect(sentModel).toContain('/');
  });

  it('pro mode also normalizes a native-id model selection to a valid OpenRouter id', async () => {
    mockedGetProviderMode.mockReturnValue('pro');
    mockedStreamManagedAgentTurn.mockImplementation(() => fakeStream('ok'));

    await runManagerTurn(baseOpts('claude-sonnet-5'));

    const sentModel = mockedStreamManagedAgentTurn.mock.calls[0][0].model as string;
    expect(sentModel).toBe('anthropic/claude-sonnet-5');
  });

  it('managed mode normalizes a bare tier word the same way as a native id', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    mockedStreamManagedAgentTurn.mockImplementation(() => fakeStream('ok'));

    await runManagerTurn(baseOpts('opus'));

    const sentModel = mockedStreamManagedAgentTurn.mock.calls[0][0].model as string;
    expect(sentModel).toBe('anthropic/claude-opus-5');
  });

  it('managed mode leaves an already-valid OpenRouter id untouched, including non-Anthropic managed models', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    mockedStreamManagedAgentTurn.mockImplementation(() => fakeStream('ok'));

    await runManagerTurn(baseOpts('deepseek/deepseek-v4-flash'));

    const sentModel = mockedStreamManagedAgentTurn.mock.calls[0][0].model as string;
    expect(sentModel).toBe('deepseek/deepseek-v4-flash');
  });

  it('managed mode falls back to the catalog default for an unrecognized model value', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    mockedStreamManagedAgentTurn.mockImplementation(() => fakeStream('ok'));

    await runManagerTurn(baseOpts('some-unknown-model'));

    const sentModel = mockedStreamManagedAgentTurn.mock.calls[0][0].model as string;
    expect(sentModel).toBe(DEFAULT_OPENROUTER_MODEL_ID);
  });

  it('codex mode routes to cliBackendProvider("codex"), never the managed proxy — the bug this fixes', async () => {
    const streamChatMock = vi.fn((_req: StreamChatRequest) =>
      fakeStream('Sure! ', '<lazy_actions>\n[{"type": "info", "message": "done"}]\n</lazy_actions>'),
    );
    mockedCliBackendProvider.mockReturnValue({
      id: 'cli-codex',
      label: 'Codex (CLI)',
      listModels: () => [],
      streamChat: streamChatMock,
    });
    mockedGetProviderMode.mockReturnValue('codex');

    const result = await runManagerTurn(baseOpts('haiku'));

    // Routes to codex — never the managed proxy (the bug) nor the
    // claude-code-specific helper.
    expect(mockedCliBackendProvider).toHaveBeenCalledWith('codex');
    expect(mockedStreamManagedAgentTurn).not.toHaveBeenCalled();
    expect(mockedStreamClaudeCodeTurn).not.toHaveBeenCalled();

    // The codex stream's output flows through the same parsing as every
    // other mode (rawResponse accumulation -> action parsing -> stripping).
    expect(result.rawResponse).toContain('Sure!');
    expect(result.actions).toEqual([{ type: 'info', message: 'done' }]);
    expect(result.responseText).toBe('Sure!');

    // The request handed to the codex backend.
    expect(streamChatMock).toHaveBeenCalledTimes(1);
    const req = streamChatMock.mock.calls[0][0] as StreamChatRequest;
    expect(req.mode).toBe('ask');
    expect(req.model.id).toBe('claude-haiku-4-5'); // same native id family as claude-code
    expect(req.messages).toEqual([
      { id: 'm1', role: 'user', content: 'où en est @reviewer sur le module auth ?' },
    ]);
    // cliBackendProvider has no dedicated "system" field on StreamChatRequest
    // (its streamChat always rebuilds the prompt internally via
    // buildSystemPrompt) — the manager's full system prompt (action schema +
    // live agent/mission state) is threaded through rulesContext instead, so
    // it still reaches the model. See buildCodexStreamRequest in
    // managerStreamCompletion.ts for the full rationale.
    expect(req.rulesContext).toContain('LazyManager');
    expect(req.rulesContext).toContain('<lazy_actions>');
  });

  it('resolves tier words to the native id family in codex mode, matching claude-code', async () => {
    const streamChatMock = vi.fn((_req: StreamChatRequest) => fakeStream('ok'));
    mockedCliBackendProvider.mockReturnValue({
      id: 'cli-codex',
      label: 'Codex (CLI)',
      listModels: () => [],
      streamChat: streamChatMock,
    });
    mockedGetProviderMode.mockReturnValue('codex');

    await runManagerTurn(baseOpts('opus'));

    const req = streamChatMock.mock.calls[0][0] as StreamChatRequest;
    expect(req.model.id).toBe('claude-opus-5');
  });
});

// ── runManagerTurn — PROMISE-STALL guard ─────────────────────────────
// Real prod repro (see the PROMISE-STALL section above runManagerTurn,
// managerEngine.ts): the manager replies with prose that announces an
// action ("Je supprime M16...") but emits no <lazy_actions> block — the
// exchange ends there, nothing executes. These tests cover the corrective
// nudge (one retry, never two in a row) and the honest grounding-failure
// context injection.

describe('detectUserActionRequest', () => {
  it('matches known FR/EN action verbs anywhere in the user message, not just at the start', () => {
    expect(detectUserActionRequest('supprime M16')).toBe(true);
    expect(detectUserActionRequest('Peux-tu lancer la mission de review ?')).toBe(true);
    expect(detectUserActionRequest('please run the tests again')).toBe(true);
  });

  it('catches phrasings the OLD response-side marker list used to miss (2026-08-05 night-2 fix)', () => {
    // These are all USER requests the manager might have silently failed to
    // action while replying in a shape the old ANNOUNCEMENT_MARKERS list
    // (checked against the MANAGER's own prose) never covered — "annule",
    // "merge"/"passe au merge", and "force" were never in that list at all.
    expect(detectUserActionRequest('annule le déploiement en cours')).toBe(true);
    expect(detectUserActionRequest('on passe au merge de la PR')).toBe(true);
    expect(detectUserActionRequest('force les approbations restantes')).toBe(true);
    expect(detectUserActionRequest('ferme M12')).toBe(true);
    expect(detectUserActionRequest('merge la PR stp')).toBe(true);
    expect(detectUserActionRequest('relance M9')).toBe(true);
    expect(detectUserActionRequest('refais ça')).toBe(true);
  });

  it('generalizes via "begins with a verb" for an imperative not in the curated list', () => {
    // "publie"/"redéploie" are not in USER_ACTION_VERBS — only the
    // start-of-message fallback catches these, proving the heuristic is not
    // just another fixed list.
    expect(detectUserActionRequest('Publie le rapport sur le canvas.')).toBe(true);
    expect(detectUserActionRequest('Redéploie le worker de staging.')).toBe(true);
  });

  it('does not match plain questions or informational statements', () => {
    expect(detectUserActionRequest("Quel est l'état du projet ?")).toBe(false);
    expect(detectUserActionRequest('Pourquoi M16 est bloquée ?')).toBe(false);
    expect(detectUserActionRequest('Merci beaucoup, à demain.')).toBe(false);
    expect(detectUserActionRequest('Le projet avance bien.')).toBe(false);
  });

  it('does not match "respond with words" imperatives (2026-08-15 false-positive fix, founder repro)', () => {
    // Real prod repro: a fresh conversation's ONLY message was exactly this
    // sentence. "Réponds" is verb-shaped and used to be missing from
    // NON_VERB_MESSAGE_STARTERS, so startsWithLikelyVerb wrongly classified
    // it as an imperative — detectUserActionRequest returned true for a
    // message that asked for a TEXT reply, not a system action.
    expect(detectUserActionRequest('Réponds uniquement par OK.')).toBe(false);
    expect(detectUserActionRequest('Dis-moi juste bonjour.')).toBe(false);
    expect(detectUserActionRequest('Explique-moi comment fonctionne le cache.')).toBe(false);
    expect(detectUserActionRequest('Please just answer with OK.')).toBe(false);
    expect(detectUserActionRequest('Tell me a joke.')).toBe(false);
  });

  it('does not treat a refused launch / analysis-only brief as an action order (2026-08-31 comparatif repro)', () => {
    expect(detectUserActionRequest("Ne lance pas d'agents : quota epuise.")).toBe(false);
    expect(detectUserActionRequest("Comparatif uniquement — n'implemente RIEN, ne lance AUCUNE mission code.")).toBe(false);
    expect(detectUserActionRequest('Continue maintenant. Colle le livrable comparatif OpenClaw vs LazyIDE.')).toBe(false);
    expect(detectUserActionRequest("Don't launch agents, just write the comparison.")).toBe(false);
    expect(detectUserActionRequest('lance M9')).toBe(true);
  });

  it('does not match a compound-past reference to something already done (2026-08-16 fix, real repro)', () => {
    // Real repro: a fresh LazyManager conversation, one question, verbatim —
    // "quel prop l'a corrigé ?" ("what prop fixed it?") is asking ABOUT a
    // past fix, not commanding one. "corrigé" without its accent (dropped
    // upstream — a real risk for any non-standard input path, not just the
    // one that surfaced this) collides byte-for-byte with the imperative
    // "corrige" already in USER_ACTION_VERBS — the OLD single-match .test()
    // could not tell the two grammatical forms apart, so the manager fired
    // its corrective nudge on a pure question, discarding its own correct
    // answer (see runManagerTurn's retry loop) in favor of "[système] Aucune
    // action exécutable...".
    expect(detectUserActionRequest(
      "D'après ton brain, quel composant capturait la molette de la souris "
      + "sur LazySite-internet et empêchait la page de scroller, et quel "
      + "prop l'a corrigé ?",
    )).toBe(false);
    // Same collision with the accent already dropped (the literal DOM text
    // observed live via the QA driver's argv path).
    expect(detectUserActionRequest(
      "D'apres ton brain, quel composant capturait la molette de la souris "
      + "sur LazySite-internet et empechait la page de scroller, et quel "
      + "prop l'a corrige ?",
    )).toBe(false);
    // Other avoir/être auxiliary forms, including the elided "n'a pas".
    expect(detectUserActionRequest("Qui a lancé ce déploiement hier ?")).toBe(false);
    expect(detectUserActionRequest("Il n'a pas supprimé le fichier, si ?")).toBe(false);
    expect(detectUserActionRequest("On avait fermé M12 la semaine dernière.")).toBe(false);
  });

  it('still detects a genuine imperative even alongside an unrelated compound-past mention', () => {
    // The exclusion above must never become a blanket "any auxiliary
    // anywhere disables detection" — a real order elsewhere in the same
    // message still has to fire the guard.
    expect(detectUserActionRequest("Il l'a corrigé hier, maintenant lance M9")).toBe(true);
  });

  it('is false for empty/whitespace-only input', () => {
    expect(detectUserActionRequest('')).toBe(false);
    expect(detectUserActionRequest('   ')).toBe(false);
  });

  it('never throws for non-string input (prod crash fix, 2026-08-05)', () => {
    expect(() => detectUserActionRequest(undefined as unknown as string)).not.toThrow();
    expect(detectUserActionRequest(undefined as unknown as string)).toBe(false);
    expect(detectUserActionRequest(null as unknown as string)).toBe(false);
  });
});

describe('ANNOUNCEMENT_NUDGE_MESSAGE', () => {
  it('shows a LazyBot Solari example, not only archive_mission, so a prose-only "je lance le bot" retry can copy the right type', () => {
    expect(ANNOUNCEMENT_NUDGE_MESSAGE).toContain('run_lazybot');
    expect(ANNOUNCEMENT_NUDGE_MESSAGE).toContain('launch_mission');
    expect(ANNOUNCEMENT_NUDGE_MESSAGE).toContain('archive_mission');
  });
});

describe('shouldUseCompactManagerCore', () => {
  it('compacts weak models regardless of the user text', () => {
    expect(shouldUseCompactManagerCore('deepseek-chat', 'salut')).toBe(true);
    expect(shouldUseCompactManagerCore('anthropic/claude-haiku-4.5', 'lance M9')).toBe(true);
  });

  it('compacts sonnet follow-ups (ok / continue / wakeup) without touching greetings', () => {
    expect(shouldUseCompactManagerCore('anthropic/claude-sonnet-5', 'ok')).toBe(true);
    expect(shouldUseCompactManagerCore('anthropic/claude-sonnet-5', 'continue')).toBe(true);
    expect(shouldUseCompactManagerCore('anthropic/claude-sonnet-5', '\u{1F514} mission M9 merged')).toBe(true);
    expect(shouldUseCompactManagerCore('anthropic/claude-sonnet-5', 'salut')).toBe(false);
    expect(shouldUseCompactManagerCore('anthropic/claude-sonnet-5', 'bonjour')).toBe(false);
  });
});

describe('stampOmittedBrainQuerySession', () => {
  it('stamps conversationId when the model omitted sessionId', () => {
    expect(stampOmittedBrainQuerySession(
      [{ type: 'brain_query', query: 'auth' }],
      'conv-abc',
    )).toEqual([{ type: 'brain_query', query: 'auth', sessionId: 'conv-abc' }]);
  });

  it('leaves an explicit sessionId untouched', () => {
    expect(stampOmittedBrainQuerySession(
      [{ type: 'brain_query', query: 'auth', sessionId: 'sess-1' }],
      'conv-abc',
    )).toEqual([{ type: 'brain_query', query: 'auth', sessionId: 'sess-1' }]);
  });

  it('is a no-op without a conversation id', () => {
    const actions = [{ type: 'brain_query' as const, query: 'auth' }];
    expect(stampOmittedBrainQuerySession(actions, undefined)).toBe(actions);
  });
});

describe('shouldSkipHeavyManagerContext', () => {
  it('skips digest/sidecar probes for a short greeting', () => {
    expect(shouldSkipHeavyManagerContext('bonjour')).toBe(true);
    expect(shouldSkipHeavyManagerContext('ok')).toBe(false);
    expect(shouldSkipHeavyManagerContext('relance ça')).toBe(false);
  });

  it('never skips a short action request — board state is required', () => {
    expect(shouldSkipHeavyManagerContext('lance M9')).toBe(false);
    expect(shouldSkipHeavyManagerContext('supprime M16')).toBe(false);
  });

  it('does not skip a long non-action question (digest still needed)', () => {
    const long = 'Quel est l\'état du projet et des missions en cours sur le canvas aujourd\'hui, s\'il te plaît ?';
    expect(long.trim().length).toBeGreaterThan(80);
    expect(shouldSkipHeavyManagerContext(long)).toBe(false);
  });

  it('skips the canvas digest for a long analysis-only brief (ox-alpha 502 repro)', () => {
    const brief = 'Comparatif uniquement. N implemente rien. Ne lance AUCUNE mission code. OpenClaw 2.0 vs LazyIDE, livrable structure gaps mieux synergies.';
    expect(brief.length).toBeGreaterThan(80);
    expect(shouldSkipHeavyManagerContext(brief)).toBe(true);
  });
});

describe('shouldBlockOnManagerStartupContext', () => {
  it('never waits 5s on a greeting — skipHeavy is enough', () => {
    expect(shouldBlockOnManagerStartupContext(true, false)).toBe(false);
  });

  it('waits on the first action turn that has not injected yet', () => {
    expect(shouldBlockOnManagerStartupContext(false, false)).toBe(true);
  });

  it('does not wait again once the snapshot was already injected', () => {
    expect(shouldBlockOnManagerStartupContext(false, true)).toBe(false);
  });
});

describe('isClarifyingQuestion', () => {
  it('is true when the last sentence is a question to the user', () => {
    expect(isClarifyingQuestion('Veux-tu que je supprime aussi le worktree associé ?')).toBe(true);
    expect(isClarifyingQuestion('Sonnet or Haiku for this one?')).toBe(true);
  });

  it('is false for plain declarative text with no question mark', () => {
    expect(isClarifyingQuestion('Fait. M16 est supprimée.')).toBe(false);
    expect(isClarifyingQuestion('Je lance M9 maintenant (voir le ticket #12?).')).toBe(false);
  });

  it('never throws for non-string input (prod crash fix, 2026-08-05)', () => {
    expect(() => isClarifyingQuestion(undefined as unknown as string)).not.toThrow();
    expect(isClarifyingQuestion(undefined as unknown as string)).toBe(false);
  });
});

describe('runManagerTurn — PROMISE-STALL guard (generalized user-driven nudge)', () => {
  function makeMessages(userContent = 'supprime M16'): ManagerMessage[] {
    return [
      { id: 'm1', role: 'user', content: userContent, timestamp: new Date().toISOString() },
    ];
  }

  function baseOpts(
    model: string,
    context: ManagerContext = { agents: [], missions: [] },
    userContent?: string,
  ): ManagerTurnOptions {
    return { messages: makeMessages(userContent), context, model };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetProviderMode.mockReturnValue('claude-code');
  });

  it('a clear user action request answered with zero actions gets ONE corrective nudge, then the real action on the second turn', async () => {
    mockedStreamClaudeCodeTurn
      .mockImplementationOnce(() => fakeStream('Je supprime M16 et je jette son worktree.'))
      .mockImplementationOnce(() =>
        fakeStream('Fait.\n<lazy_actions>\n[{"type": "info", "message": "M16 supprimée"}]\n</lazy_actions>'),
      );

    const result = await runManagerTurn(baseOpts('sonnet'));

    expect(mockedStreamClaudeCodeTurn).toHaveBeenCalledTimes(2);
    expect(result.actions).toEqual([{ type: 'info', message: 'M16 supprimée' }]);
    expect(result.announcementNudged).toBe(true);
    // QUIET RECOVERY (2026-08-07): the nudge fired (announcementNudged is
    // still true — console.warn above still logs it for developers) but the
    // retry recovered a real action, so responseText itself stays silent —
    // no "[système]"/"previous reply announced" notice. Founder-reported:
    // this exact notice, shown even on a successful retry, was cluttering
    // the chat with 8+ "problem already fixed" messages in one conversation.
    expect(result.responseText).not.toMatch(/previous reply announced/i);
    expect(result.responseText).toBe('Fait.');

    // The nudge instruction actually reached the model on the retry call.
    const secondCallArgs = mockedStreamClaudeCodeTurn.mock.calls[1][0] as { messages: ManagerMessage[] };
    expect(
      secondCallArgs.messages.some(
        (m) => m.role === 'user' && /no <lazy_actions> block/.test(m.content),
      ),
    ).toBe(true);
  });

  it('Bug 2a fix: an OPENED but unparseable <lazy_actions> block gets a SPECIFIC schema-error nudge, not the generic "no block" one', async () => {
    // The model DID try to comply — it opened the tag — but the JSON inside
    // is broken (trailing comma makes it neither directly parseable nor
    // salvageable by the naked-array regex, since that regex only needs
    // matching brackets, not valid JSON — trailing commas still fail
    // JSON.parse). This must get a nudge that acknowledges the block and
    // names the problem, not the generic announcement-only reminder (which
    // would confusingly claim no block was ever opened at all).
    mockedStreamClaudeCodeTurn
      .mockImplementationOnce(() =>
        fakeStream('Je supprime M16.\n<lazy_actions>[{"type": "archive_mission", "missionId": "M16",}]</lazy_actions>'),
      )
      .mockImplementationOnce(() =>
        fakeStream('<lazy_actions>[{"type": "archive_mission", "missionId": "M16"}]</lazy_actions>'),
      );

    const result = await runManagerTurn(baseOpts('sonnet'));

    expect(mockedStreamClaudeCodeTurn).toHaveBeenCalledTimes(2);
    expect(result.announcementNudged).toBe(true);
    expect(result.actions).toEqual([{ type: 'archive_mission', missionId: 'M16' }]);

    const secondCallArgs = mockedStreamClaudeCodeTurn.mock.calls[1][0] as { messages: ManagerMessage[] };
    const nudgeMsg = secondCallArgs.messages.find(
      (m) => m.role === 'user' && /lazy_actions/.test(m.content),
    );
    expect(nudgeMsg?.content).toMatch(/not valid JSON/i);
    // Never the generic "announced in prose... emitted no <lazy_actions>
    // block at all" wording — that would be actively misleading here, since
    // a block WAS opened.
    expect(nudgeMsg?.content).not.toMatch(/no <lazy_actions> block at all/i);
  });

  it('a phrasing the OLD response-side marker list used to miss ("je passe au merge") is now nudged via the user-driven heuristic', async () => {
    // The user clearly asked to merge; the reply narrates in a shape the OLD
    // ANNOUNCEMENT_MARKERS list never covered ("je passe au merge" was not
    // one of the curated openers) and emits zero actions. The new guard
    // never inspects the reply's phrasing at all — it fires because the USER
    // asked for an action and got none, which is exactly the miss this fix
    // closes.
    mockedStreamClaudeCodeTurn
      .mockImplementationOnce(() => fakeStream('Je passe au merge de la PR.'))
      .mockImplementationOnce(() =>
        fakeStream('Fait.\n<lazy_actions>\n[{"type": "info", "message": "PR mergée"}]\n</lazy_actions>'),
      );

    const result = await runManagerTurn(baseOpts('sonnet', undefined, 'merge la PR stp'));

    expect(mockedStreamClaudeCodeTurn).toHaveBeenCalledTimes(2);
    expect(result.announcementNudged).toBe(true);
    expect(result.actions).toEqual([{ type: 'info', message: 'PR mergée' }]);
  });

  it('never issues a second NUDGE in the same call — a reply that keeps announcing without acting falls through to the Layer 2 repair call, which ALSO fails, and is returned honestly', async () => {
    // Deliberately only 3 queued responses (never a 4th): mockImplementationOnce
    // entries are NOT drained by beforeEach's vi.clearAllMocks() (it clears
    // call history, not queued implementations), so a 4th, never-consumed
    // "should never be called" response here would silently leak into and
    // corrupt the NEXT test's first call instead of proving anything — the
    // toHaveBeenCalledTimes(3) assertion below already proves a 4th call
    // never happened. Call 1 = original attempt, call 2 = the ONE nudge
    // retry (never a second nudge — that invariant is what this test's name
    // still asserts), call 3 = the Layer 2 action-extraction repair call
    // (attemptActionExtractionRepair) — also prose-only, so it recovers
    // nothing and the existing honest failure notice still stands.
    mockedStreamClaudeCodeTurn
      .mockImplementationOnce(() => fakeStream('Je lance la mission.'))
      .mockImplementationOnce(() => fakeStream('Je lance quand même la mission.'))
      .mockImplementationOnce(() => fakeStream('Toujours pas de bloc structuré.'));

    const result = await runManagerTurn(baseOpts('sonnet'));

    // Exactly 3 calls: the original attempt + ONE nudge retry + ONE Layer 2
    // repair call. A 4th call would mean either a second nudge or a second
    // repair attempt in the same exchange — both forbidden budgets.
    expect(mockedStreamClaudeCodeTurn).toHaveBeenCalledTimes(3);
    expect(result.actions).toEqual([]);
    expect(result.announcementNudged).toBe(true);
    // BUG 1b fix (dogfood 2026-08-05, real repro with DeepSeek as manager
    // model): the model stayed prose-only even after the nudge AND the
    // repair call — this must never be silent. A distinct failure notice
    // (never just the "retry requested" notice, which alone reads as
    // success/in-progress) stands in for responseText.
    expect(result.responseText).toMatch(/no executable action was emitted/i);
    expect(result.responseText).toMatch(/nothing was done/i);
    // QUIET RECOVERY (2026-08-07) — "(e) true failure -> exactly one
    // failure notice": the old "retry requested" notice is now NEVER shown
    // (dropped unconditionally — see buildAnnouncementNudgeNotice's
    // removal), so a true failure carries ONLY buildAnnouncementNudgeFailureNotice,
    // never both stacked together, and never duplicated.
    expect(result.responseText).not.toMatch(/previous reply announced/i);
    expect(result.responseText.split('No executable action was emitted').length - 1).toBe(1);
    // REVERSED (2026-08-15, founder repro "Réponds uniquement par OK."): the
    // Bug 2b fix used to drop the model's own text entirely here, on the
    // assumption baseResponseText in this branch is always an unexecuted
    // announcement — but nudgeFailed can also fire on an honest, harmless
    // reply the guard misread as an unactioned command (see
    // NON_VERB_MESSAGE_STARTERS' 2026-08-15 fix note), and discarding a real
    // reply to show "nothing was done" instead is exactly the "announces
    // failure over a success" bug this whole guard exists to prevent. New
    // policy: the notice leads (so the honest status reads first) and the
    // model's own text follows it, never silently dropped.
    expect(result.responseText).toMatch(/no executable action was emitted/i);
    expect(result.responseText).not.toContain('Je lance quand même la mission.');
  });

  it('BUG 1b: the failure notice is French when the turn locale is French (Layer 2 repair call also fails)', async () => {
    mockedStreamClaudeCodeTurn
      .mockImplementationOnce(() => fakeStream('Je supprime M16.'))
      .mockImplementationOnce(() => fakeStream('Je supprime M16, vraiment.'))
      .mockImplementationOnce(() => fakeStream('Toujours rien de structuré.'));

    const result = await runManagerTurn(
      baseOpts('sonnet', { agents: [], missions: [], locale: 'fr' }),
    );

    expect(mockedStreamClaudeCodeTurn).toHaveBeenCalledTimes(3);
    expect(result.announcementNudged).toBe(true);
    expect(result.actions).toEqual([]);
    expect(result.responseText).toMatch(/aucune action exécutable n'a été émise/i);
    expect(result.responseText).toMatch(/rien n'a été fait/i);
  });

  it('BUG 1b / QUIET RECOVERY: no notice at all when the post-nudge reply is itself a clarifying question', async () => {
    mockedStreamClaudeCodeTurn
      .mockImplementationOnce(() => fakeStream('Je supprime M16.'))
      .mockImplementationOnce(() => fakeStream('Veux-tu que je supprime aussi le worktree associé ?'));

    const result = await runManagerTurn(baseOpts('sonnet'));

    expect(result.announcementNudged).toBe(true);
    expect(result.actions).toEqual([]);
    // QUIET RECOVERY (2026-08-07): a clarifying question is an honest
    // outcome, never a failure — nudgeFailed's own isClarifyingQuestion
    // carve-out already excludes it, so responseText carries NO notice at
    // all (neither the old "retry requested" notice, now dropped
    // unconditionally, nor the failure notice).
    expect(result.responseText).not.toMatch(/previous reply announced/i);
    expect(result.responseText).not.toMatch(/no executable action was emitted/i);
    expect(result.responseText).toBe('Veux-tu que je supprime aussi le worktree associé ?');
  });

  it('a reply that is itself a clarifying question is never nudged, even after a clear user action request', async () => {
    mockedStreamClaudeCodeTurn.mockImplementation(() =>
      fakeStream('Veux-tu que je supprime aussi le worktree associé ?'),
    );

    const result = await runManagerTurn(baseOpts('sonnet'));

    expect(mockedStreamClaudeCodeTurn).toHaveBeenCalledTimes(1);
    expect(result.announcementNudged).toBe(false);
    expect(result.actions).toEqual([]);
    expect(result.responseText).toBe('Veux-tu que je supprime aussi le worktree associé ?');
  });

  it('an informative reply to a non-action user message is never nudged', async () => {
    mockedStreamClaudeCodeTurn.mockImplementation(() => fakeStream("Voici un résumé de l'état actuel du projet."));

    const result = await runManagerTurn(baseOpts('sonnet', undefined, "Quel est l'état du projet ?"));

    expect(mockedStreamClaudeCodeTurn).toHaveBeenCalledTimes(1);
    expect(result.announcementNudged).toBe(false);
    expect(result.actions).toEqual([]);
    expect(result.responseText).toBe("Voici un résumé de l'état actuel du projet.");
  });

  // ── 2026-08-15 fix, founder repro (real packaged app, build 05:06) ──────
  // "Réponds uniquement par OK." produced "OK" from the model with no
  // <lazy_actions> block (correctly — there was nothing to execute), but
  // the product showed "[system] No executable action was emitted —
  // nothing was done" INSTEAD of "OK", and still billed the turn. Two
  // independent fixes, each locked down here: (a) the false-positive
  // detectUserActionRequest heuristic must not fire on this class of
  // message at all, so the honest "OK" reply passes straight through with
  // no nudge; (b) even when the guard genuinely (and correctly) detects an
  // unactioned request, the failure notice must stand ALONGSIDE the
  // model's real text, never replace it outright.

  it('(a) a plain text reply to a "respond with words" request is shown as a normal answer — no nudge, no failure notice', async () => {
    mockedStreamClaudeCodeTurn.mockImplementationOnce(() => fakeStream('OK'));

    const result = await runManagerTurn(baseOpts('sonnet', undefined, 'Réponds uniquement par OK.'));

    expect(mockedStreamClaudeCodeTurn).toHaveBeenCalledTimes(1);
    expect(result.announcementNudged).toBe(false);
    expect(result.actions).toEqual([]);
    expect(result.responseText).toBe('OK');
    expect(result.responseText).not.toMatch(/no executable action was emitted/i);
    expect(result.responseText).not.toMatch(/\[system\]|\[système\]/i);
  });

  it('(b) an explicit action request with nothing ultimately done still shows the failure notice, alongside whatever text the model produced', async () => {
    mockedStreamClaudeCodeTurn
      .mockImplementationOnce(() => fakeStream('Je supprime M16 tout de suite.'))
      .mockImplementationOnce(() => fakeStream('Je m\'en occupe.'))
      .mockImplementationOnce(() => fakeStream('Toujours pas de bloc structuré.'));

    const result = await runManagerTurn(baseOpts('sonnet', undefined, 'supprime M16'));

    expect(result.announcementNudged).toBe(true);
    expect(result.actions).toEqual([]);
    // The warning is still visible — the guard's real job (an unactioned
    // request must never go silent) is untouched by the 2026-08-15 fix.
    expect(result.responseText).toMatch(/no executable action was emitted/i);
    expect(result.responseText).toMatch(/nothing was done/i);
    // ...but it no longer discards the model's own (honest, if unhelpful)
    // text — both are present, notice first.
    expect(result.responseText).toContain("Je m'en occupe.");
  });

  it('a grounding-failure note in context is injected honestly and the turn still completes (never silently killed)', async () => {
    mockedStreamClaudeCodeTurn.mockImplementation(() =>
      fakeStream(
        'La recherche a échoué, mais je relance la mission M9 quand même.\n<lazy_actions>\n[{"type": "info", "message": "relance M9"}]\n</lazy_actions>',
      ),
    );

    const result = await runManagerTurn(
      baseOpts('sonnet', {
        agents: [],
        missions: [],
        groundingFailureNote:
          '(brain search timed out after 32s — this usually means the project brain is large and this particular query is slow, NOT that the brain is missing or broken.)',
      }),
    );

    // The round-trip failure never aborts or short-circuits the call — a
    // normal, complete turn still runs with real actions coming out of it.
    expect(mockedStreamClaudeCodeTurn).toHaveBeenCalledTimes(1);
    expect(result.actions).toEqual([{ type: 'info', message: 'relance M9' }]);

    const sentSystem = mockedStreamClaudeCodeTurn.mock.calls[0][0].system as string;
    expect(sentSystem).toContain('Grounding Failure');
    expect(sentSystem).toContain('brain search timed out after 32s');
    expect(sentSystem).toMatch(/still decide and act/i);
  });

  it('a turn with NO user-role message at all never crashes and never nudges (prod regression, 2026-08-05)', async () => {
    // Grounded/continuation turn shape: no 'user' entry in `messages` at
    // all (only an assistant entry, or the array could be empty) — used to
    // risk a crash deriving lastUserMessageContent. Now coerces to ''.
    mockedStreamClaudeCodeTurn.mockImplementation(() => fakeStream('Voici le résumé demandé.'));
    const opts: ManagerTurnOptions = {
      messages: [{ id: 'm0', role: 'assistant', content: 'contexte précédent', timestamp: new Date().toISOString() }],
      context: { agents: [], missions: [] },
      model: 'sonnet',
    };

    await expect(runManagerTurn(opts)).resolves.not.toThrow();
    const result = await runManagerTurn(opts);

    expect(result.announcementNudged).toBe(false);
    expect(result.actions).toEqual([]);
  });

  it('a user message with non-string content never crashes and is never treated as an action request (prod regression, 2026-08-05)', async () => {
    mockedStreamClaudeCodeTurn.mockImplementation(() => fakeStream('Voici le résumé demandé.'));
    const opts: ManagerTurnOptions = {
      messages: [
        // Simulates a malformed/synthetic message bypassing ManagerMessage's
        // static `content: string` at runtime (the coordinator's second
        // suspected cause, alongside "no user message at all" above).
        { id: 'm1', role: 'user', content: undefined as unknown as string, timestamp: new Date().toISOString() },
      ],
      context: { agents: [], missions: [] },
      model: 'sonnet',
    };

    const result = await runManagerTurn(opts);

    expect(result.announcementNudged).toBe(false);
    expect(result.actions).toEqual([]);
  });
});

// ── runManagerTurn — DeepSeek FORMAT-compliance fix (2026-08-07) ────────
// Founder-reported, real repro ~10x one night with DeepSeek as the manager
// model: prose announces an action ("Je lance start_preview...") with NO
// <lazy_actions> block at all, and the existing PROMISE-STALL nudge above
// (ONE corrective retry) still comes back prose-only roughly 60% of the
// time. LAYER 1 (parseLazyActionsJson's salvageBareActionsJson) recovers a
// bare JSON array with no wrapper BEFORE the nudge decision is even made.
// LAYER 2 (attemptActionExtractionRepair) is the last resort when the nudge
// itself still fails: one short, constrained completion that translates the
// already-failed prose into a real <lazy_actions> block.

describe('runManagerTurn — LAYER 1 salvage (bare JSON, no wrapper, no nudge)', () => {
  function makeMessages(userContent = 'supprime M16'): ManagerMessage[] {
    return [{ id: 'm1', role: 'user', content: userContent, timestamp: new Date().toISOString() }];
  }
  function baseOpts(model: string, context: ManagerContext = { agents: [], missions: [] }): ManagerTurnOptions {
    return { messages: makeMessages(), context, model };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetProviderMode.mockReturnValue('claude-code');
  });

  it('a bare ```json fenced array with NO <lazy_actions> wrapper at all is salvaged before the nudge decision — zero nudge, one call', async () => {
    // .mockImplementationOnce (not the persistent .mockImplementation): a
    // leftover persistent implementation would leak past THIS test's own
    // mockImplementationOnce queues in later describe blocks (vi.clearAllMocks
    // in beforeEach clears call history, never queued/persistent
    // implementations — see the PROMISE-STALL block's own comment on this).
    mockedStreamClaudeCodeTurn.mockImplementationOnce(() =>
      fakeStream('Je lance la mission.\n\n```json\n[{"type": "launch_mission", "task": "review the PR"}]\n```'),
    );

    const result = await runManagerTurn(baseOpts('sonnet'));

    expect(mockedStreamClaudeCodeTurn).toHaveBeenCalledTimes(1);
    expect(result.announcementNudged).toBe(false);
    expect(result.actions).toEqual([{ type: 'launch_mission', task: 'review the PR' }]);
    // QUIET RECOVERY: no nudge ever fired, so responseText was already
    // silent before this fix too — asserted here as a regression guard.
    expect(result.responseText).not.toMatch(/\[système\]|\[system\]/);
  });

  it('a naked (unfenced) JSON array with NO <lazy_actions> wrapper is salvaged the same way', async () => {
    mockedStreamClaudeCodeTurn.mockImplementationOnce(() =>
      fakeStream('Je nettoie tout de suite : [{"type": "stop_all"}] et je te tiens au courant.'),
    );

    const result = await runManagerTurn(baseOpts('sonnet'));

    expect(mockedStreamClaudeCodeTurn).toHaveBeenCalledTimes(1);
    expect(result.announcementNudged).toBe(false);
    expect(result.actions).toEqual([{ type: 'stop_all' }]);
    expect(result.responseText).not.toMatch(/\[système\]|\[system\]/);
  });

  // QUIET RECOVERY (2026-08-07) — the combined, previously-noisy case: a
  // nudge DOES fire (turn 1 is genuinely zero actions, no salvageable JSON
  // anywhere), and the RETRY is what gets salvaged (a bare array with no
  // <lazy_actions> wrapper) — this is "(c) salvage-recovered" from the fix's
  // own test list. Before this fix, announcementNudged being true alone was
  // enough to show the "[système] La réponse précédente annonçait..."
  // notice even though the retry fully recovered a real action.
  it('QUIET RECOVERY: a nudge fires, and the RETRY is recovered via LAYER 1 salvage (bare array, no wrapper) — no notice at all', async () => {
    mockedStreamClaudeCodeTurn
      .mockImplementationOnce(() => fakeStream('Je supprime M16.'))
      .mockImplementationOnce(() =>
        fakeStream('Fait, sans bloc structuré : [{"type": "archive_mission", "missionId": "M16"}]'),
      );

    const result = await runManagerTurn(baseOpts('sonnet'));

    expect(mockedStreamClaudeCodeTurn).toHaveBeenCalledTimes(2);
    expect(result.announcementNudged).toBe(true);
    expect(result.actions).toEqual([{ type: 'archive_mission', missionId: 'M16' }]);
    expect(result.responseText).not.toMatch(/\[système\]|\[system\]/);
    expect(result.responseText).not.toMatch(/previous reply announced/i);
    expect(result.responseText).not.toMatch(/no executable action was emitted/i);
    // 2026-08-12 QA fix (stripActionBlock): a bare JSON action array with no
    // <lazy_actions> wrapper at all is now ALSO stripped from the visible
    // text (previously only a tagged block was) — the raw JSON payload must
    // never leak into the bubble, tagged or not. See
    // stripBareActionsJsonForDisplay's own doc comment in managerEngine.ts.
    expect(result.responseText).toBe('Fait, sans bloc structuré :');
    expect(result.responseText).not.toContain('{"type"');
  });
});

describe('runManagerTurn — LAYER 2 action-extraction repair call', () => {
  function makeMessages(userContent = 'supprime M16'): ManagerMessage[] {
    return [{ id: 'm1', role: 'user', content: userContent, timestamp: new Date().toISOString() }];
  }
  function baseOpts(
    model: string,
    context: ManagerContext = { agents: [], missions: [] },
    extra: Partial<ManagerTurnOptions> = {},
  ): ManagerTurnOptions {
    return { messages: makeMessages(), context, model, ...extra };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetProviderMode.mockReturnValue('claude-code');
  });

  it('recovers real actions when the post-nudge reply is STILL prose-only — QUIET RECOVERY: no notice at all, either kind', async () => {
    mockedStreamClaudeCodeTurn
      .mockImplementationOnce(() => fakeStream('Je supprime M16.'))
      .mockImplementationOnce(() => fakeStream('Je supprime M16, vraiment, sans bloc structuré.'))
      .mockImplementationOnce(() =>
        fakeStream('<lazy_actions>[{"type": "archive_mission", "missionId": "M16"}]</lazy_actions>'),
      );

    const result = await runManagerTurn(baseOpts('sonnet'));

    expect(mockedStreamClaudeCodeTurn).toHaveBeenCalledTimes(3);
    expect(result.announcementNudged).toBe(true);
    expect(result.actions).toEqual([{ type: 'archive_mission', missionId: 'M16' }]);
    // QUIET RECOVERY (2026-08-07): the repair call DID recover real actions
    // (finalActions above proves it), so responseText must stay completely
    // silent — no "[système] Actions récupérées automatiquement..." notice
    // (that notice is now dead code, removed) and obviously no failure
    // notice either. responseText is just the last raw reply's own text.
    expect(result.responseText).not.toMatch(/automatically recovered/i);
    expect(result.responseText).not.toMatch(/no executable action was emitted/i);
    expect(result.responseText).toBe('Je supprime M16, vraiment, sans bloc structuré.');

    // Same engine/model path (streamClaudeCodeTurn), but a short, constrained
    // system prompt — never the ~112k-char core prompt — and the faulty
    // prose reply (not the original user message) as its own user turn.
    const repairCallArgs = mockedStreamClaudeCodeTurn.mock.calls[2][0] as {
      system: string;
      messages: ManagerMessage[];
    };
    expect(repairCallArgs.system).toMatch(/machine-actionable block/i);
    expect(repairCallArgs.system).not.toContain("LazyManager — the mission-control orchestrator");
    expect(repairCallArgs.messages).toHaveLength(1);
    expect(repairCallArgs.messages[0]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('sans bloc structuré'),
    });
  });

  it('the honest failure notice stands (existing behavior) when the repair call ALSO returns no valid actions', async () => {
    mockedStreamClaudeCodeTurn
      .mockImplementationOnce(() => fakeStream('Je supprime M16.'))
      .mockImplementationOnce(() => fakeStream('Je supprime M16, vraiment.'))
      .mockImplementationOnce(() => fakeStream("Désolé, je ne peux pas structurer ça pour l'instant."));

    const result = await runManagerTurn(baseOpts('sonnet'));

    expect(mockedStreamClaudeCodeTurn).toHaveBeenCalledTimes(3);
    expect(result.actions).toEqual([]);
    expect(result.responseText).toMatch(/no executable action was emitted/i);
    expect(result.responseText).toMatch(/nothing was done/i);
    expect(result.responseText).not.toMatch(/automatically recovered/i);
  });

  it('a repair call that throws (transport error) never crashes the turn — falls back to the honest failure notice', async () => {
    mockedStreamClaudeCodeTurn
      .mockImplementationOnce(() => fakeStream('Je supprime M16.'))
      .mockImplementationOnce(() => fakeStream('Je supprime M16, vraiment.'))
      .mockImplementationOnce(() => {
        throw new Error('network error');
      });

    // A single call — asserting the settled result already proves it never
    // threw (an unhandled rejection here would fail the test on its own).
    const result = await runManagerTurn(baseOpts('sonnet'));
    expect(mockedStreamClaudeCodeTurn).toHaveBeenCalledTimes(3);
    expect(result.actions).toEqual([]);
    expect(result.responseText).toMatch(/no executable action was emitted/i);
  });

  it('fires at most once per call, even with a larger maxTurns budget', async () => {
    mockedStreamClaudeCodeTurn
      .mockImplementationOnce(() => fakeStream('Je supprime M16.'))
      .mockImplementationOnce(() => fakeStream('Je supprime M16, vraiment.'))
      .mockImplementationOnce(() => fakeStream('Encore de la prose, toujours pas de bloc.'));

    const result = await runManagerTurn(baseOpts('sonnet', undefined, { maxTurns: 5 }));

    // 1 initial + 1 nudge retry + 1 repair call = 3, never a 4th even though
    // maxTurns would allow more main-loop iterations.
    expect(mockedStreamClaudeCodeTurn).toHaveBeenCalledTimes(3);
    expect(result.actions).toEqual([]);
  });

  it('budget: a single validation-retry before the nudge (3 calls total) still affords the repair call (Bug 2b fix, threshold raised 2 -> 3)', async () => {
    // Bug 2b fix (LazyManager QA, 2026-08-07, "contradictory outcome"
    // repro): this exact sequence — a validation-retry, THEN the nudge,
    // THEN a still-failed post-nudge reply (3 real completions) — used to
    // skip the repair call entirely (old threshold was 2), leaving the
    // model's own unexecuted claim of action standing next to the "nothing
    // was done" notice. MAX_LLM_CALLS_BEFORE_REPAIR_SKIPPED is now 3, so
    // this common within-budget sequence gets its repair attempt.
    mockedStreamClaudeCodeTurn
      .mockImplementationOnce(() =>
        // turn 0: a structurally invalid action (missing required
        // "missionId") — costs a validation-retry call, a DIFFERENT budget
        // line than the zero-action/nudge path below.
        fakeStream('<lazy_actions>\n[{"type": "stop_mission"}]\n</lazy_actions>'),
      )
      .mockImplementationOnce(() => fakeStream('Je supprime M16.'))
      .mockImplementationOnce(() => fakeStream('Je supprime M16, vraiment.'))
      .mockImplementationOnce(() =>
        fakeStream('<lazy_actions>[{"type": "archive_mission", "missionId": "M16"}]</lazy_actions>'),
      );

    const result = await runManagerTurn(baseOpts('sonnet'));

    // 3 main-loop calls (1 validation-retry + 1 nudge + 1 failed post-nudge
    // reply) + the 4th repair call, which now runs and recovers a real
    // action instead of being skipped.
    expect(mockedStreamClaudeCodeTurn).toHaveBeenCalledTimes(4);
    expect(result.actions).toEqual([{ type: 'archive_mission', missionId: 'M16' }]);
    expect(result.announcementNudged).toBe(true);
    expect(result.responseText).not.toMatch(/no executable action was emitted/i);
  });

  it('budget: 4 main-loop completions still afford the repair call (threshold raised 3 -> 6)', async () => {
    mockedStreamClaudeCodeTurn
      .mockImplementationOnce(() => fakeStream('<lazy_actions>\n[{"type": "stop_mission"}]\n</lazy_actions>'))
      .mockImplementationOnce(() => fakeStream('<lazy_actions>\n[{"type": "stop_mission"}]\n</lazy_actions>'))
      .mockImplementationOnce(() => fakeStream('Je supprime M16.'))
      .mockImplementationOnce(() => fakeStream('Je supprime M16, vraiment.'))
      .mockImplementationOnce(() =>
        fakeStream('<lazy_actions>[{"type": "archive_mission", "missionId": "M16"}]</lazy_actions>'),
      );

    const result = await runManagerTurn(baseOpts('sonnet', undefined, { maxTurns: 5 }));

    expect(mockedStreamClaudeCodeTurn).toHaveBeenCalledTimes(5);
    expect(result.actions).toEqual([{ type: 'archive_mission', missionId: 'M16' }]);
    expect(result.announcementNudged).toBe(true);
    expect(result.responseText).not.toMatch(/no executable action was emitted/i);
  });
});

// ── runManagerTurn — engineOverride (STACK fix) ──────────────────────
// agentsStore.tsx's sendManagerMessage preflight rescues the manager's OWN
// turn onto the CLI rail when the ambient mode is managed/pro with an empty
// Pro wallet but a native CLI subscription is ready (isNativeModelReady()) —
// instead of refusing the turn outright. This is a MODE-level override
// (never inspects `model`'s format), deliberately distinct from the
// classifyMissionModel(model)-based branching BUG-6's note above says was
// tried and reverted — see ManagerTurnOptions.engineOverride's doc comment.

describe('runManagerTurn — engineOverride (STACK fix)', () => {
  function makeMessages(): ManagerMessage[] {
    return [
      {
        id: 'm1',
        role: 'user',
        content: 'où en est @reviewer sur le module auth ?',
        timestamp: new Date().toISOString(),
      },
    ];
  }

  function baseOpts(model: string, engineOverride?: 'cli' | 'pro') {
    return {
      messages: makeMessages(),
      context: { agents: [], missions: [] },
      model,
      engineOverride,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('engineOverride "cli" routes to streamClaudeCodeTurn even though the ambient mode is "managed"', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    mockedStreamClaudeCodeTurn.mockImplementation(() => fakeStream('info from claude-code'));

    const result = await runManagerTurn(baseOpts('anthropic/claude-sonnet-5', 'cli'));

    expect(mockedStreamClaudeCodeTurn).toHaveBeenCalledTimes(1);
    expect(result.rawResponse).toContain('info from claude-code');
    expect(mockedStreamManagedAgentTurn).not.toHaveBeenCalled();
  });

  it('engineOverride "cli" routes to streamClaudeCodeTurn even though the ambient mode is "pro" (selected-but-inactive)', async () => {
    mockedGetProviderMode.mockReturnValue('pro');
    mockedStreamClaudeCodeTurn.mockImplementation(() => fakeStream('ok'));

    await runManagerTurn(baseOpts('haiku', 'cli'));

    expect(mockedStreamClaudeCodeTurn).toHaveBeenCalledTimes(1);
    expect(mockedStreamManagedAgentTurn).not.toHaveBeenCalled();
  });

  it('engineOverride "pro" routes to streamManagedAgentTurn even though the ambient mode is "claude-code"', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    mockedStreamManagedAgentTurn.mockImplementation(() => fakeStream('info from managed'));

    const result = await runManagerTurn(baseOpts('claude-sonnet-5', 'pro'));

    expect(mockedStreamManagedAgentTurn).toHaveBeenCalledTimes(1);
    expect(result.rawResponse).toContain('info from managed');
    expect(mockedStreamClaudeCodeTurn).not.toHaveBeenCalled();
  });

  it('engineOverride "cli" respects the configured CLI tool — routes to cliBackendProvider("codex") when cliTool is codex', async () => {
    const streamChatMock = vi.fn((_req: StreamChatRequest) => fakeStream('ok'));
    mockedCliBackendProvider.mockReturnValue({
      id: 'cli-codex',
      label: 'Codex (CLI)',
      listModels: () => [],
      streamChat: streamChatMock,
    });
    mockedGetProviderMode.mockReturnValue('managed');
    const original = localStorage.getItem('lazy.accessSettings');
    try {
      localStorage.setItem('lazy.accessSettings', JSON.stringify({ cliTool: 'codex' }));

      await runManagerTurn(baseOpts('haiku', 'cli'));

      expect(mockedCliBackendProvider).toHaveBeenCalledWith('codex');
      expect(mockedStreamManagedAgentTurn).not.toHaveBeenCalled();
      expect(mockedStreamClaudeCodeTurn).not.toHaveBeenCalled();
    } finally {
      if (original === null) localStorage.removeItem('lazy.accessSettings');
      else localStorage.setItem('lazy.accessSettings', original);
    }
  });

  it('omitting engineOverride keeps the unchanged, pure mode-based routing (managed stays managed)', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    mockedStreamManagedAgentTurn.mockImplementation(() => fakeStream('ok'));

    await runManagerTurn(baseOpts('anthropic/claude-haiku-4.5'));

    expect(mockedStreamManagedAgentTurn).toHaveBeenCalledTimes(1);
    expect(mockedStreamClaudeCodeTurn).not.toHaveBeenCalled();
  });
});

// ── runManagerTurn — RECALL_TEACHING wiring (per provider-mode branch) ──
// claude-code/managed send `system` straight to the model, so RECALL_
// TEACHING must be appended explicitly for those two. The codex branch
// threads `system` through rulesContext into cliBackendProvider's own
// buildSystemPrompt('ask', ...) call, which appends RECALL_TEACHING itself
// downstream (proven by systemPrompts.test.ts) — so runManagerTurn must NOT
// also append it there, or it would appear twice in the final prompt.

describe('runManagerTurn — RECALL_TEACHING wiring', () => {
  // Local equivalents of the "provider mode routing" describe block's
  // function-scoped helpers above (not accessible from this sibling block).
  function makeMessages(): ManagerMessage[] {
    return [
      {
        id: 'm1',
        role: 'user',
        content: 'où en est @reviewer sur le module auth ?',
        timestamp: new Date().toISOString(),
      },
    ];
  }

  function baseOpts(model: string) {
    return {
      messages: makeMessages(),
      context: { agents: [], missions: [] },
      model,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('claude-code mode: appends RECALL_TEACHING to the system prompt sent to streamClaudeCodeTurn', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    mockedStreamClaudeCodeTurn.mockImplementation(() => fakeStream('ok'));

    await runManagerTurn(baseOpts('sonnet'));

    const sentSystem = mockedStreamClaudeCodeTurn.mock.calls[0][0].system as string;
    expect(sentSystem).toContain(RECALL_TEACHING);
    // Exactly once — not duplicated.
    expect(sentSystem.split(RECALL_TEACHING).length - 1).toBe(1);
  });

  it('managed mode: appends RECALL_TEACHING to the system prompt sent to streamManagedAgentTurn', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    mockedStreamManagedAgentTurn.mockImplementation(() => fakeStream('ok'));

    await runManagerTurn(baseOpts('anthropic/claude-sonnet-5'));

    const sentSystem = mockedStreamManagedAgentTurn.mock.calls[0][0].system as string;
    expect(sentSystem).toContain(RECALL_TEACHING);
    expect(sentSystem.split(RECALL_TEACHING).length - 1).toBe(1);
  });

  it('codex mode: does NOT append RECALL_TEACHING to rulesContext — it is added exactly once, downstream, by cliBackendProvider', async () => {
    const streamChatMock = vi.fn((_req: StreamChatRequest) => fakeStream('ok'));
    mockedCliBackendProvider.mockReturnValue({
      id: 'cli-codex',
      label: 'Codex (CLI)',
      listModels: () => [],
      streamChat: streamChatMock,
    });
    mockedGetProviderMode.mockReturnValue('codex');

    await runManagerTurn(baseOpts('haiku'));

    const req = streamChatMock.mock.calls[0][0] as StreamChatRequest;
    // managerEngine.ts itself must not add it here — cliBackendProvider's
    // streamChatImpl rebuilds the prompt via buildSystemPrompt(req.mode, ...,
    // { rulesContext: req.rulesContext, ... }), which appends RECALL_TEACHING
    // for any non-'transform' mode. Appending it here too would duplicate it.
    expect(req.rulesContext).not.toContain(RECALL_TEACHING);
  });
});

// ── runManagerTurn — ACTION FORMAT reminder (FIX 1, 2026-08-07) ─────────
// First-turn format-failure rate stays high with a weaker manager model
// (DeepSeek) even though buildManagerCorePrompt's "### Action Types"
// section already documents the <lazy_actions> shape — that instruction is
// buried inside a ~28k-token prompt. ACTION_FORMAT_REMINDER is appended as
// the LITERAL LAST content of the system string each rail actually
// dispatches (streamManagerCompletion) so it benefits from recency instead.
// Every rail must carry it — this block is the "(a) every rail's captured
// system ends with the block" coverage.

describe('runManagerTurn — ACTION FORMAT reminder (FIX 1, last-position)', () => {
  function makeMessages(): ManagerMessage[] {
    return [{ id: 'm1', role: 'user', content: 'salut', timestamp: new Date().toISOString() }];
  }
  function baseOpts(model: string): ManagerTurnOptions {
    return { messages: makeMessages(), context: { agents: [], missions: [] }, model };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('claude-code mode: system sent to streamClaudeCodeTurn ends with ACTION_FORMAT_REMINDER', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    mockedStreamClaudeCodeTurn.mockImplementation(() => fakeStream('ok'));

    await runManagerTurn(baseOpts('sonnet'));

    const sentSystem = mockedStreamClaudeCodeTurn.mock.calls[0][0].system as string;
    expect(sentSystem.endsWith(ACTION_FORMAT_REMINDER)).toBe(true);
    // Still after RECALL_TEACHING, not replacing it.
    expect(sentSystem).toContain(RECALL_TEACHING);
  });

  it('managed mode: system AND cacheableSystem.dynamic sent to streamManagedAgentTurn both end with ACTION_FORMAT_REMINDER, core untouched', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    mockedStreamManagedAgentTurn.mockImplementation(() => fakeStream('ok'));

    await runManagerTurn(baseOpts('anthropic/claude-sonnet-5'));

    const call = mockedStreamManagedAgentTurn.mock.calls[0][0] as {
      system: string;
      cacheableSystem?: { core: string; dynamic: string };
    };
    expect(call.system.endsWith(ACTION_FORMAT_REMINDER)).toBe(true);
    expect(call.cacheableSystem).toBeDefined();
    expect(call.cacheableSystem!.dynamic.endsWith(ACTION_FORMAT_REMINDER)).toBe(true);
    expect(call.cacheableSystem!.core).toBe(buildManagerCorePrompt());
    // The core+dynamic reconstruction invariant (see the cacheableSystem
    // wiring describe block below) must still hold with the reminder in place.
    expect(`${call.cacheableSystem!.core}${call.cacheableSystem!.dynamic}`).toBe(call.system);
  });

  it('codex mode: rulesContext sent to cliBackendProvider ends with ACTION_FORMAT_REMINDER (RECALL_TEACHING still excluded — added downstream)', async () => {
    const streamChatMock = vi.fn((_req: StreamChatRequest) => fakeStream('ok'));
    mockedCliBackendProvider.mockReturnValue({
      id: 'cli-codex',
      label: 'Codex (CLI)',
      listModels: () => [],
      streamChat: streamChatMock,
    });
    mockedGetProviderMode.mockReturnValue('codex');

    await runManagerTurn(baseOpts('haiku'));

    const req = streamChatMock.mock.calls[0][0] as StreamChatRequest;
    expect((req.rulesContext as string).endsWith(ACTION_FORMAT_REMINDER)).toBe(true);
    // Unchanged existing behavior: RECALL_TEACHING is still not this file's
    // job for codex — only downstream cliBackendProvider adds it.
    expect(req.rulesContext).not.toContain(RECALL_TEACHING);
  });

  it('live-key mode: system sent to the BYOK raw streamer ends with ACTION_FORMAT_REMINDER', async () => {
    mockedGetProviderMode.mockReturnValue('live-key');
    localStorage.setItem('lazy.accessSettings', JSON.stringify({ byokProvider: 'deepseek' }));
    saveByokKey('deepseek', 'sk-test-key');
    mockedStreamOpenAICompatRaw.mockImplementation(() => fakeStream('ok'));

    await runManagerTurn(baseOpts('deepseek-chat'));

    expect(mockedStreamOpenAICompatRaw).toHaveBeenCalledTimes(1);
    expect(mockedStreamAnthropicCompatRaw).not.toHaveBeenCalled();
    const sentSystem = mockedStreamOpenAICompatRaw.mock.calls[0][0].system as string;
    expect(sentSystem.endsWith(ACTION_FORMAT_REMINDER)).toBe(true);
    expect(sentSystem).toContain(RECALL_TEACHING);
  });

  it('the LAYER 2 repair call also ends its own short system prompt with ACTION_FORMAT_REMINDER', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    mockedStreamClaudeCodeTurn
      .mockImplementationOnce(() => fakeStream('Je supprime M16.'))
      .mockImplementationOnce(() => fakeStream('Je supprime M16, vraiment.'))
      .mockImplementationOnce(() =>
        fakeStream('<lazy_actions>[{"type": "archive_mission", "missionId": "M16"}]</lazy_actions>'),
      );

    await runManagerTurn({
      messages: [{ id: 'm1', role: 'user', content: 'supprime M16', timestamp: new Date().toISOString() }],
      context: { agents: [], missions: [] },
      model: 'sonnet',
    });

    const repairCallArgs = mockedStreamClaudeCodeTurn.mock.calls[2][0] as { system: string };
    expect(repairCallArgs.system.endsWith(ACTION_FORMAT_REMINDER)).toBe(true);
  });
});

// ── runManagerTurn — BYOK-catalog model wins over the ambient mode ─────────
// Real repro (2026-08-12, live desktop app, authenticated Pro session, real
// BYOK DeepSeek key configured): picking "DeepSeek Chat (V4 Flash)"
// (deepseek-chat) from the LazyManager's own model picker and sending any
// message always failed with the Claude CLI's own "model may not exist"
// rejection (modelsIndex.test.ts:306-309 documents that exact wording).
//
// Root cause: modelPickerOptions.ts's detectModelEntitlements() computes
// "is a BYOK model selectable" INDEPENDENTLY of getProviderMode() on purpose
// (see that module's own header doc comment — a user can hold a Claude
// subscription/Pro plan AND a keyed BYOK provider at once, and the picker
// must offer both). But streamManagerCompletion's dispatch used to key
// PURELY off the ambient `mode` (getProviderMode()) — so a keyed BYOK model
// picked from that SAME independent picker was silently forwarded to
// whichever rail the ambient mode happened to resolve to instead (here,
// 'claude-code' — toNativeModelId('deepseek-chat') sent straight to the CLI,
// which of course has never heard of it).
//
// Fixed by resolveByokDefForModel: a keyed BYOK-catalog id now always wins
// over the ambient mode, checked BEFORE the mode branches — matching what
// the picker already promised the user it would do.
describe('runManagerTurn — BYOK-catalog model wins over the ambient mode (DeepSeek-always-fails fix)', () => {
  function makeMessages(): ManagerMessage[] {
    return [{ id: 'm1', role: 'user', content: 'salut', timestamp: new Date().toISOString() }];
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('claude-code mode + a keyed DeepSeek model: routes to the BYOK raw streamer, never the CLI', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    saveByokKey('deepseek', 'sk-test-key');
    mockedStreamOpenAICompatRaw.mockImplementation(() => fakeStream('ok'));

    await runManagerTurn({ messages: makeMessages(), context: { agents: [], missions: [] }, model: 'deepseek-chat' });

    expect(mockedStreamOpenAICompatRaw).toHaveBeenCalledTimes(1);
    expect(mockedStreamClaudeCodeTurn).not.toHaveBeenCalled();
    const call = mockedStreamOpenAICompatRaw.mock.calls[0][0] as { model: string; baseUrl: string };
    expect(call.model).toBe('deepseek-chat');
    expect(call.baseUrl).toBe('https://api.deepseek.com');
  });

  it('managed/Pro mode + a keyed DeepSeek model: still routes to the BYOK raw streamer, never the managed proxy', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    saveByokKey('deepseek', 'sk-test-key');
    mockedStreamOpenAICompatRaw.mockImplementation(() => fakeStream('ok'));

    await runManagerTurn({ messages: makeMessages(), context: { agents: [], missions: [] }, model: 'deepseek-reasoner' });

    expect(mockedStreamOpenAICompatRaw).toHaveBeenCalledTimes(1);
    expect(mockedStreamManagedAgentTurn).not.toHaveBeenCalled();
    const call = mockedStreamOpenAICompatRaw.mock.calls[0][0] as { model: string };
    expect(call.model).toBe('deepseek-reasoner');
  });

  it('claude-code mode + "deepseek-chat" with NO DeepSeek key configured: unchanged, still routes to the CLI', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    // No saveByokKey call — the picker would never have offered this model
    // in the first place, but the dispatch itself must degrade exactly as
    // before this fix when asked to anyway (no key = not a real BYOK route).
    mockedStreamClaudeCodeTurn.mockImplementation(() => fakeStream('ok'));

    await runManagerTurn({ messages: makeMessages(), context: { agents: [], missions: [] }, model: 'deepseek-chat' });

    expect(mockedStreamClaudeCodeTurn).toHaveBeenCalledTimes(1);
    expect(mockedStreamOpenAICompatRaw).not.toHaveBeenCalled();
  });

  it('claude-code mode + a native Anthropic id, DeepSeek key ALSO configured: still routes to the CLI (no false-positive hijack)', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    saveByokKey('deepseek', 'sk-test-key');
    mockedStreamClaudeCodeTurn.mockImplementation(() => fakeStream('ok'));

    await runManagerTurn({ messages: makeMessages(), context: { agents: [], missions: [] }, model: 'claude-sonnet-5' });

    expect(mockedStreamClaudeCodeTurn).toHaveBeenCalledTimes(1);
    expect(mockedStreamOpenAICompatRaw).not.toHaveBeenCalled();
  });
});

// ── runManagerTurn — cacheableSystem wiring (chantier 2, prompt caching) ──
// The managed branch must hand streamManagedAgentTurn a `cacheableSystem`
// split whose `core` is buildManagerCorePrompt()'s OWN output (stable
// across turns — the cache-control-eligible prefix) and whose `dynamic`
// reconstructs the exact same flat `system` text the claude-code branch
// still sends as one string — never a lossy or reordered rewrite.

describe('runManagerTurn — cacheableSystem wiring (chantier 2)', () => {
  function makeMessages(): ManagerMessage[] {
    return [
      { id: 'm1', role: 'user', content: 'salut', timestamp: new Date().toISOString() },
    ];
  }

  function baseOpts(model: string) {
    return { messages: makeMessages(), context: { agents: [], missions: [] }, model };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes a cacheableSystem whose core+dynamic reconstructs the exact flat system string sent as `system`', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    mockedStreamManagedAgentTurn.mockImplementation(() => fakeStream('ok'));

    await runManagerTurn(baseOpts('anthropic/claude-sonnet-5'));

    const call = mockedStreamManagedAgentTurn.mock.calls[0][0] as {
      system: string;
      cacheableSystem?: { core: string; dynamic: string };
    };
    expect(call.cacheableSystem).toBeDefined();
    const { core, dynamic } = call.cacheableSystem!;
    expect(`${core}${dynamic}`).toBe(call.system);
  });

  it('core is byte-identical to buildManagerCorePrompt() — the cache-eligible static prefix', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    mockedStreamManagedAgentTurn.mockImplementation(() => fakeStream('ok'));

    await runManagerTurn(baseOpts('anthropic/claude-sonnet-5'));

    const call = mockedStreamManagedAgentTurn.mock.calls[0][0] as {
      cacheableSystem?: { core: string; dynamic: string };
    };
    expect(call.cacheableSystem!.core).toBe(buildManagerCorePrompt());
  });

  it('core stays IDENTICAL across two turns with different mission/agent state (cache-hit precondition), while dynamic changes', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    mockedStreamManagedAgentTurn.mockImplementation(() => fakeStream('ok'));

    await runManagerTurn({
      messages: makeMessages(),
      context: { agents: [], missions: [] },
      model: 'anthropic/claude-sonnet-5',
    });
    const firstCall = mockedStreamManagedAgentTurn.mock.calls[0][0] as {
      cacheableSystem?: { core: string; dynamic: string };
    };

    await runManagerTurn({
      messages: makeMessages(),
      context: {
        agents: [],
        missions: [{ id: 'M1', title: 'Test mission', status: 'running', model: 'sonnet' } as Mission],
      },
      model: 'anthropic/claude-sonnet-5',
    });
    const secondCall = mockedStreamManagedAgentTurn.mock.calls[1][0] as {
      cacheableSystem?: { core: string; dynamic: string };
    };

    expect(secondCall.cacheableSystem!.core).toBe(firstCall.cacheableSystem!.core);
    expect(secondCall.cacheableSystem!.dynamic).not.toBe(firstCall.cacheableSystem!.dynamic);
  });

  it('claude-code branch has no cacheableSystem field (no block-level caching mechanism for the CLI rail)', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    mockedStreamClaudeCodeTurn.mockImplementation(() => fakeStream('ok'));

    await runManagerTurn(baseOpts('sonnet'));

    const call = mockedStreamClaudeCodeTurn.mock.calls[0][0] as { cacheableSystem?: unknown };
    expect(call.cacheableSystem).toBeUndefined();
  });

  it('follow-up "ok" on sonnet uses the compact core — greetings still keep the full cache prefix', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    mockedStreamManagedAgentTurn.mockImplementation(() => fakeStream('ok'));

    await runManagerTurn({
      messages: [{ id: 'm1', role: 'user', content: 'ok', timestamp: new Date().toISOString() }],
      context: { agents: [], missions: [] },
      model: 'anthropic/claude-sonnet-5',
    });
    const followUp = mockedStreamManagedAgentTurn.mock.calls[0][0] as {
      cacheableSystem?: { core: string };
    };
    expect(followUp.cacheableSystem!.core).toBe(buildManagerCorePrompt({ compact: true }));
    expect(followUp.cacheableSystem!.core).not.toBe(buildManagerCorePrompt());
  });
});

describe('runManagerTurn — D91 stamps omitted brain_query.sessionId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stamps conversationId when the model omits sessionId', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    mockedStreamManagedAgentTurn.mockImplementation(() =>
      fakeStream('Je lis.\n<lazy_actions>\n[{"type":"brain_query","query":"auth"}]\n</lazy_actions>'),
    );

    const result = await runManagerTurn({
      messages: [{ id: 'm1', role: 'user', content: 'quoi sur auth', timestamp: new Date().toISOString() }],
      context: { agents: [], missions: [], conversationId: 'conv-abc' },
      model: 'anthropic/claude-sonnet-5',
    });

    expect(result.actions).toEqual([{ type: 'brain_query', query: 'auth', sessionId: 'conv-abc' }]);
  });

  it('keeps an explicit sessionId', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    mockedStreamManagedAgentTurn.mockImplementation(() =>
      fakeStream('<lazy_actions>[{"type":"brain_query","query":"auth","sessionId":"sess-1"}]</lazy_actions>'),
    );

    const result = await runManagerTurn({
      messages: [{ id: 'm1', role: 'user', content: 'quoi sur auth', timestamp: new Date().toISOString() }],
      context: { agents: [], missions: [], conversationId: 'conv-abc' },
      model: 'anthropic/claude-sonnet-5',
    });

    expect(result.actions).toEqual([{ type: 'brain_query', query: 'auth', sessionId: 'sess-1' }]);
  });
});

// ── sanitizeManagerDisplayText (B13: raw tool-call XML leaks) ───────────
// The manager's <lazy_actions> block was already stripped for display
// (stripActionBlock), but a DIFFERENT leak class was not: when the
// underlying CLI transport emits its own native tool-calling XML
// (<function_calls>/<invoke>/<parameter> — Claude Code CLI's own
// function-calling protocol) as visible text, it used to render verbatim in
// every manager-facing surface (observed defect: the SWOT analysis overlay
// showed raw <function_calls> markup). sanitizeManagerDisplayText is the
// single centralized fix — see its use inside runManagerTurn below.

describe('sanitizeManagerDisplayText', () => {
  it('still strips the manager\'s own <lazy_actions> block (stripActionBlock behavior preserved)', () => {
    const text = 'Sure!\n<lazy_actions>\n[{"type": "info", "message": "done"}]\n</lazy_actions>\nDone.';
    const result = sanitizeManagerDisplayText(text);
    expect(result).toContain('Sure!');
    expect(result).toContain('Done.');
    expect(result).not.toContain('lazy_actions');
  });

  it('strips a complete leaked <function_calls> block', () => {
    const text = 'Here is my analysis.\n<function_calls>\n<invoke name="list_missions">\n</invoke>\n</function_calls>\nAll good.';
    const result = sanitizeManagerDisplayText(text);
    expect(result).toContain('Here is my analysis.');
    expect(result).toContain('All good.');
    expect(result).not.toContain('function_calls');
    expect(result).not.toContain('invoke');
  });

  it('strips a bare <invoke>...</invoke> block even without an outer <function_calls> wrapper', () => {
    const text = 'Checking...\n<invoke name="list_agents">\n<parameter name="x">1</parameter>\n</invoke>\nDone.';
    const result = sanitizeManagerDisplayText(text);
    expect(result).toContain('Checking...');
    expect(result).toContain('Done.');
    expect(result).not.toContain('invoke');
    expect(result).not.toContain('parameter');
  });

  it('strips an UNTERMINATED <function_calls> block (stream cut off before the closing tag)', () => {
    const text = 'Partial answer before the cut.\n<function_calls>\n<invoke name="brain_query">\n<parameter name="query">postgres';
    const result = sanitizeManagerDisplayText(text);
    expect(result).toBe('Partial answer before the cut.');
    expect(result).not.toContain('function_calls');
  });

  it('strips both a <lazy_actions> block AND a leaked <function_calls> block in the same response', () => {
    const text = [
      'I will check the SWOT.',
      '<function_calls>',
      '<invoke name="get_agent_output"></invoke>',
      '</function_calls>',
      'Here is the analysis.',
      '<lazy_actions>',
      '[{"type": "info", "message": "ok"}]',
      '</lazy_actions>',
    ].join('\n');
    const result = sanitizeManagerDisplayText(text);
    expect(result).toContain('I will check the SWOT.');
    expect(result).toContain('Here is the analysis.');
    expect(result).not.toContain('function_calls');
    expect(result).not.toContain('lazy_actions');
  });

  it('leaves clean text completely unchanged (idempotent, no false positives)', () => {
    const text = 'The mission is 60% complete and on track.';
    expect(sanitizeManagerDisplayText(text)).toBe(text);
    expect(sanitizeManagerDisplayText(sanitizeManagerDisplayText(text))).toBe(text);
  });

  it('is idempotent on already-sanitized leaky text', () => {
    const text = '<function_calls><invoke name="x"></invoke></function_calls>Answer.';
    const once = sanitizeManagerDisplayText(text);
    const twice = sanitizeManagerDisplayText(once);
    expect(twice).toBe(once);
  });

  // Real leak captured live from the "Standup du matin" reply: the managed
  // backend spilled its whole chain-of-thought as [reasoning]… lines before
  // the actual answer. Every reasoning line must be dropped; the answer kept.
  it('strips leaked [reasoning] channel lines (glued, empty, and ANSI-prefixed)', () => {
    const text = [
      '[reasoning]L\'utilisateur demande "Fais-moi le standup du matin".',
      '[reasoning]',
      '[reasoning]Je dois utiliser briefing_query pour un digest.',
      '\x1b[reasoning]context: demo-shop, 1427 credits',
      'Parfait. Voici ton standup du matin :',
      '- Crédits restants : 1 427',
    ].join('\n');
    const result = sanitizeManagerDisplayText(text);
    expect(result).not.toContain('[reasoning]');
    expect(result).toContain('Parfait. Voici ton standup du matin :');
    expect(result).toContain('- Crédits restants : 1 427');
  });

  it('keeps a legitimate prose mention of the word reasoning', () => {
    const text = 'Mon raisonnement : la mission est prête. On peut merger.';
    expect(sanitizeManagerDisplayText(text)).toBe(text);
  });

  // ── P2-13/P2-14 fix: self-repeated leading narration ──────────────────
  // Real user test, verbatim: the same clarifying question restated then
  // immediately extended with more detail, glued together with no separator.
  describe('collapses a self-repeated leading narration (P2-13 fix)', () => {
    it('drops a short restated opening followed by the SAME opening extended with more detail', () => {
      const short = "Carrousel d'images ou vraie vidéo Remotion rendue ?";
      const extended = `${short} Ça détermine tout le pipeline de production.`;
      const result = sanitizeManagerDisplayText(short + extended);
      expect(result).toBe(extended);
      // The doubled opening must not appear twice in the final text.
      expect(result.split(short).length - 1).toBe(1);
    });

    it('still collapses the repeat when a whitespace/newline separates the two passes', () => {
      const short = 'Je vais vérifier le mission M12 avant de répondre';
      const extended = `${short} et je te confirmerai le résultat exact.`;
      const result = sanitizeManagerDisplayText(`${short}\n\n${extended}`);
      expect(result).toBe(extended);
    });

    it('never touches a short reply (below the minimum repeat length) — no false positives', () => {
      const text = 'OK, je lance la mission.';
      expect(sanitizeManagerDisplayText(text)).toBe(text);
    });

    it('never touches unrelated text that merely shares a short common opening', () => {
      const text = 'Je lance la mission M12. Je te tiens au courant du résultat dans quelques minutes.';
      expect(sanitizeManagerDisplayText(text)).toBe(text);
    });

    it('is idempotent — running it twice yields the same result', () => {
      const short = 'Il me faut deux informations avant de lancer le script';
      const extended = `${short} : le pattern cible et le répertoire à traiter.`;
      const once = sanitizeManagerDisplayText(short + extended);
      const twice = sanitizeManagerDisplayText(once);
      expect(twice).toBe(once);
    });
  });

  // ── P0-2 fix: multi-pass stutter, real user test round 3 ────────────────
  // Verbatim (2026-07-28): "...ouvre le navigateur dessus.Je me corrige — en
  // tant que LazyManager je n'ai pas d'accès shell direct, seule la palette
  // d'actions structurées compte. Je lance donc le chaînage : ... Je pars
  // donc sur ce graphe : ..." — three formulations of the same plan glued in
  // one bubble with no separator. collapseLeadingSelfRepeat (P2-13/14, above)
  // only ever catches a literal repeat at the text's OWN leading edge; these
  // cover the general case (any position, self-correction markers, prefix
  // relations) — see dedupeRepeatedSegments' doc comment in managerEngine.ts
  // for the full root-cause trace.
  describe('collapses repeated/self-corrected segments anywhere in the text (P0-2 fix)', () => {
    it('drops a self-correction ("Je me corrige — ...") and keeps only the reformulation that follows', () => {
      const text = 'Je lance un agent pour créer le dashboard de suivi des utilisateurs. '
        + "Je me corrige — en tant que LazyManager je n'ai pas d'accès shell direct, seule la palette d'actions structurées compte. "
        + 'Je lance donc un agent structuré pour créer le dashboard de suivi des utilisateurs.';
      const result = dedupeRepeatedSegments(text);
      expect(result).toBe('Je lance donc un agent structuré pour créer le dashboard de suivi des utilisateurs.');
      expect(result).not.toContain('Je me corrige');
      // The discarded first draft must not survive either.
      expect(result.split('Je lance').length - 1).toBe(1);
    });

    it('collapses two EXACT duplicate segments down to one (word-for-word repeat)', () => {
      const question = 'Carrousel d\'images ou vraie vidéo Remotion rendue, et pour quelle audience cible ?';
      const text = `${question} ${question}`;
      const result = dedupeRepeatedSegments(text);
      expect(result).toBe(question);
      expect(result.split(question).length - 1).toBe(1);
    });

    it('collapses a segment that is a strict PREFIX of a later, more complete segment', () => {
      const shortSentence = 'Je lance le chaînage sur le dashboard admin du projet lazy-backoffice';
      const longSentence = `${shortSentence} pour ajouter le suivi des utilisateurs, puis un second crée le raccourci de bureau`;
      const text = `${shortSentence}. ${longSentence}.`;
      const result = dedupeRepeatedSegments(text);
      expect(result).toBe(`${longSentence}.`);
    });

    it('collapses a segment that is a strict prefix of an EARLIER, more complete segment (order-independent)', () => {
      const shortSentence = 'Je lance le chaînage sur le dashboard admin';
      const longSentence = `${shortSentence} du projet lazy-backoffice pour ajouter le suivi des utilisateurs`;
      const text = `${longSentence}. ${shortSentence}.`;
      const result = dedupeRepeatedSegments(text);
      expect(result).toBe(`${longSentence}.`);
    });

    it('never touches two legitimately DIFFERENT paragraphs — separator and both stay intact', () => {
      const text = 'Je lance la recherche produit et web, puis je définirai l\'angle.'
        + '\n\nEnsuite, une fois le résultat validé, je passerai à la production Remotion.';
      expect(dedupeRepeatedSegments(text)).toBe(text);
    });

    it('leaves clean, non-repeating text completely unchanged (idempotent, no false positives)', () => {
      const text = 'Je lance la mission M12 sur le module auth. Je te tiens au courant du résultat.';
      expect(dedupeRepeatedSegments(text)).toBe(text);
      expect(dedupeRepeatedSegments(dedupeRepeatedSegments(text))).toBe(text);
    });

    it('collapses a near-paraphrase below the previous 0.72 Jaccard (more aggressive)', () => {
      const a = 'Le bot SolariTest tourne maintenant sur exampleorg via le navigateur cloud.';
      const b = 'Le bot SolariTest tourne actuellement sur exampleorg dans le navigateur cloud.';
      const result = dedupeRepeatedSegments(`${a} ${b}`);
      expect(result).toBe(b);
      expect(result).not.toContain('maintenant');
    });

    it('A6 — collapses a 3rd paraphrase via char-trigram fingerprint (synonym dilution)', () => {
      // Extend the proven 2-sentence near-paraphrase case with a 3rd restatement.
      const a = 'Le bot SolariTest tourne maintenant sur exampleorg via le navigateur cloud.';
      const b = 'Le bot SolariTest tourne actuellement sur exampleorg dans le navigateur cloud.';
      const c = 'Le bot SolariTest tourne a present sur exampleorg dans le navigateur cloud.';
      const result = dedupeRepeatedSegments(`${a} ${b} ${c}`);
      expect(result).toBe(c);
      expect(result).not.toContain('maintenant');
      expect(result).not.toContain('actuellement');
    });

    it('never collapses two legitimate reprises that name different missions', () => {
      const text = 'Je relance la mission M12 sur le module auth maintenant. Je relance la mission M16 sur le module auth maintenant.';
      expect(dedupeRepeatedSegments(text)).toBe(text);
    });

    it('is wired into sanitizeManagerDisplayText end-to-end on the real round-3 verbatim shape', () => {
      const text = '...puis un second crée un raccourci qui lance le serveur local et ouvre le navigateur dessus.'
        + "Je me corrige — en tant que LazyManager je n'ai pas d'accès shell direct, seule la palette d'actions structurées compte. "
        + 'Je pars donc sur ce graphe : un agent reprend M53 pour y ajouter le suivi des utilisateurs, puis un second crée le raccourci de bureau qui lance le serveur local et ouvre le navigateur dessus.';
      const result = sanitizeManagerDisplayText(text);
      expect(result.match(/Je me corrige/g)).toBeNull();
      // Only the FINAL formulation should remain — the first draft's own
      // opening ("...puis un second crée un raccourci qui lance...") must be gone.
      expect(result).not.toContain('un raccourci qui lance le serveur local et ouvre le navigateur dessus.Je');
      expect(result).toContain('Je pars donc sur ce graphe');
    });

    // 2026-08 QA: raw <artifact> result-envelope leak (Cockpit manager panel,
    // live repro) — stripped via artifactEnvelopeLeak.ts's stripArtifactEnvelope,
    // wired into the sanitizeManagerDisplayText choke point. See
    // artifactEnvelopeLeak.test.ts for the full standalone coverage; this is
    // just proof the real choke point actually calls it.
    it('is wired into sanitizeManagerDisplayText end-to-end: strips a leaked <artifact> envelope', () => {
      const text =
        "Voici ce qui n'a pas fonctionné et ce qui doit être corrigé. " +
        '<artifact type="application/json" id="query-m7"> {"type": "query_miss...';
      const result = sanitizeManagerDisplayText(text);
      expect(result).toBe("Voici ce qui n'a pas fonctionné et ce qui doit être corrigé.");
      expect(result).not.toContain('artifact');
      expect(result).not.toContain('query_miss');
    });
  });
});

describe('runManagerTurn — responseText is sanitized end-to-end (B13)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('strips a leaked <function_calls> block from responseText but keeps it in rawResponse', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    mockedStreamClaudeCodeTurn.mockImplementation(() =>
      fakeStream(
        'Analyzing the project. ',
        '<function_calls>\n<invoke name="list_missions"></invoke>\n</function_calls>\n',
        'SWOT: strong test coverage, some tech debt in auth.',
      ),
    );

    const result = await runManagerTurn({
      messages: [{ id: 'm1', role: 'user', content: 'do a SWOT', timestamp: new Date().toISOString() }],
      context: { agents: [], missions: [] },
      model: 'sonnet',
    });

    expect(result.responseText).not.toContain('function_calls');
    expect(result.responseText).toContain('Analyzing the project.');
    expect(result.responseText).toContain('SWOT: strong test coverage');
    // rawResponse is the untouched transcript — still useful for debugging/logs.
    expect(result.rawResponse).toContain('function_calls');
  });
});

// ── formatCreditsSummary + buildManagerSystemPrompt credits grounding ───
// Orchestrator quality fix: "combien ai-je de crédits ?" must be answered
// from real subscription state (same source as the credits KPI tile /
// AccountChip), never guessed or claimed unavailable.

describe('formatCreditsSummary', () => {
  it('returns undefined when no snapshot is supplied (caller deliberately opted out)', () => {
    expect(formatCreditsSummary(undefined)).toBeUndefined();
  });

  it('reports an honest free-plan message when not Pro', () => {
    const summary = formatCreditsSummary({ isPro: false });
    expect(summary).toMatch(/free plan/i);
    expect(summary).not.toMatch(/\d/); // no fabricated number
  });

  it('reports the real remaining credits for an active Pro subscription', () => {
    const summary = formatCreditsSummary({
      isPro: true,
      status: 'active',
      creditsRemainingCents: 4200,
      creditsIncludedCents: 10000,
      periodEnd: '2026-08-01T00:00:00Z',
    });
    // formatCredits (billing/credits.ts) uses toLocaleString('fr-FR'), whose
    // thousands separator is a narrow no-break space (U+202F), not a plain
    // ASCII space — build the expected string via the real formatter rather
    // than hardcoding a literal to avoid a false failure on that glyph.
    expect(summary).toContain(formatCredits(4200));
    expect(summary).toContain(formatCredits(10000));
    expect(summary).toMatch(/pro plan/i);
    expect(summary).toContain('active');
    expect(summary).toContain('2026-08-01T00:00:00Z');
  });

  it('treats a Pro flag with no credits figure as the honest free-plan message (never fabricates a number)', () => {
    const summary = formatCreditsSummary({ isPro: true });
    expect(summary).toMatch(/free plan/i);
  });
});

// ── formatEntitlementsSummary — STACK fix ────────────────────────────
// A Claude CLI/BYOK subscription and Lazy Pro managed credits are two
// INDEPENDENT rails (modelPickerOptions.ts's ModelEntitlements) — this
// formatter reports BOTH, distinct from formatCreditsSummary's single
// "how many credits" answer (which stays unchanged, see the describe block
// above — every one of its existing assertions still passes untouched).

describe('formatEntitlementsSummary', () => {
  it('returns undefined when no entitlements snapshot is supplied', () => {
    expect(formatEntitlementsSummary(undefined, undefined)).toBeUndefined();
  });

  it('reports both rails ready — Claude subscription detected and Pro active with the real remaining credits', () => {
    const summary = formatEntitlementsSummary({ claudeSub: true, pro: 'active', codexManaged: false }, 4200);
    expect(summary).toMatch(/claude subscription.*ready/i);
    expect(summary).toMatch(/lazy pro.*active/i);
    expect(summary).toContain(formatCredits(4200));
  });

  it('reports Pro active with 0 credits distinctly from Pro inactive (the exact bug this fixes: 0 credits must never read as "no Pro")', () => {
    const noCredits = formatEntitlementsSummary({ claudeSub: true, pro: 'no-credits', codexManaged: false }, 0);
    const inactive = formatEntitlementsSummary({ claudeSub: true, pro: 'inactive', codexManaged: false }, undefined);
    expect(noCredits).toMatch(/0 credits left/i);
    expect(inactive).toMatch(/no active plan/i);
    expect(noCredits).not.toBe(inactive);
  });

  it('reports the Claude subscription as not detected when claudeSub is false', () => {
    const summary = formatEntitlementsSummary({ claudeSub: false, pro: 'active', codexManaged: false }, 100);
    expect(summary).toMatch(/claude subscription.*not detected/i);
  });

  it('reports both rails at once — a user can hold a Claude subscription AND active Pro credits simultaneously', () => {
    const summary = formatEntitlementsSummary({ claudeSub: true, pro: 'active', codexManaged: false }, 500);
    expect(summary).toContain('Claude subscription');
    expect(summary).toContain('Lazy Pro');
  });

  it('is compact — two short lines, no verbose explanation (token cost: injected every turn)', () => {
    const summary = formatEntitlementsSummary({ claudeSub: true, pro: 'no-credits', codexManaged: false }, 0);
    expect(summary?.split('\n')).toHaveLength(2);
  });
});

describe('buildManagerSystemPrompt — credits grounding', () => {
  it('includes an Account & Credits block with the real summary when creditsSummary is provided', () => {
    const prompt = buildManagerSystemPrompt({
      agents: [],
      missions: [],
      creditsSummary: 'Pro plan (active): 4 200 credits remaining of 10 000 included this billing period.',
    });
    expect(prompt).toContain('Account & Credits');
    expect(prompt).toContain('4 200 credits remaining');
  });

  it('omits the Account & Credits block entirely when creditsSummary is absent', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
    // The Rules section permanently explains what to do *if* an Account &
    // Credits block shows up (same convention as the Mission Detail /
    // Structural Recall Result rules above), so assert the actual injected
    // section heading is absent rather than the bare phrase (which
    // legitimately appears in Rules regardless).
    expect(prompt).not.toContain('### Account & Credits (real');
  });

  it('instructs the manager to answer credit questions from real data, never guess', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
    expect(prompt).toMatch(/combien ai-je de crédits/i);
    expect(prompt).toMatch(/never guess a number/i);
  });

  // STACK fix — the visible bug this task fixes: 0 Pro credits must never be
  // narrated as a reason to hold back a mission the Claude subscription can
  // serve on its own.
  it('instructs the manager that 0 Pro credits never blocks a mission on the Claude subscription, and documents the "engine" lever', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
    expect(prompt).toMatch(/never present a 0\/empty pro credit balance as a reason to hold back/i);
    expect(prompt).toContain('"engine": "cli"|"pro"');
  });
});

describe('buildManagerSystemPrompt — entitlements grounding (STACK fix)', () => {
  it('includes an Engines block with the real entitlements summary when entitlementsSummary is provided', () => {
    const prompt = buildManagerSystemPrompt({
      agents: [],
      missions: [],
      entitlementsSummary: '- Claude subscription (CLI/BYOK): ready\n- Lazy Pro (managed credits): active plan, 0 credits left',
    });
    expect(prompt).toContain('### Engines (real, live');
    expect(prompt).toContain('Claude subscription (CLI/BYOK): ready');
    expect(prompt).toContain('active plan, 0 credits left');
  });

  it('omits the Engines block entirely when entitlementsSummary is absent', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
    expect(prompt).not.toContain('### Engines (real, live');
  });

  it('documents the "engine" field on launch_mission, create_loop, create_draft and spawn_submissions', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
    expect(prompt).toMatch(/"type":\s*"launch_mission"[^}]*"engine":\s*"cli\|pro"/);
    expect(prompt).toMatch(/"type":\s*"create_loop"[^}]*"engine":\s*"cli\|pro"/);
    expect(prompt).toMatch(/"type":\s*"create_draft"[^}]*"engine":\s*"cli\|pro"/);
    expect(prompt).toMatch(/"engine":\s*"cli"/); // spawn_submissions' per-modification example
  });
});

// ── formatBrainStatus / Brain: status grounding (silent-degradation fix) ──
// Real QA finding (2026-07): a manager running an entire session on a
// 0-neuron test brain answered "le brain n'a rien de pertinent sur ce
// sujet" every turn — a phrasing indistinguishable from "brain works fine,
// nothing relevant here" — and never once said the brain itself was
// unavailable or unindexed for the project, then kept guessing task sizes
// instead of flagging it. formatBrainStatus is the fix: it turns a real
// BrainInfo snapshot (or its absence) into one of three DISTINCT states.

describe('formatBrainStatus', () => {
  it('reports "unavailable" when no info snapshot could be fetched (info() failed/timed out)', () => {
    const status = formatBrainStatus(undefined);
    expect(status).toMatch(/^Brain: unavailable/);
  });

  it('reports "NOT indexed for this project" when the brain resolved but has 0 notes — distinct from unavailable', () => {
    const status = formatBrainStatus({ noteCount: 0, isEmpty: true });
    expect(status).toMatch(/NOT indexed for this project/);
    expect(status).toContain('0 notes');
    expect(status).not.toMatch(/^Brain: unavailable/);
  });

  it('reports the real note count when the brain is indexed for this project', () => {
    const status = formatBrainStatus({ noteCount: 357, isEmpty: false });
    expect(status).toBe('Brain: indexed, 357 notes for this project.');
  });

  it('never confuses a genuinely empty brain (isEmpty: true, noteCount: 0) with an unavailable one', () => {
    const empty = formatBrainStatus({ noteCount: 0, isEmpty: true });
    const unavailable = formatBrainStatus(undefined);
    expect(empty).not.toBe(unavailable);
  });
});

// ── formatBrainStatus — GRAPH/RECALL DIVERGENCE FIX (sidecarReachable) ────
// Real-user report: the Brain space showed a live, 5254-neuron graph for
// the active project ("Ce projet", "brain live" badge) while the manager's
// info() snapshot for that SAME project read 0 notes and the manager told
// the user "no brain accessible" + "index the project" — a wrong remedy for
// an already-indexed project. `info()` resolves a brain path independently
// (filesystem-only, no sidecar contact) from the live sidecar the Brain
// space trusts, so the two CAN legitimately disagree. `sidecarReachable`
// lets formatBrainStatus surface that disagreement honestly instead of
// repeating the local snapshot's possibly-wrong verdict.

describe('formatBrainStatus — sidecarReachable disagreement (GRAPH/RECALL DIVERGENCE FIX)', () => {
  it('omitting sidecarReachable preserves the original unavailable wording exactly (no regression)', () => {
    expect(formatBrainStatus(undefined)).toBe('Brain: unavailable (no brain reachable right now).');
  });

  it('omitting sidecarReachable preserves the original NOT-indexed wording exactly (no regression)', () => {
    expect(formatBrainStatus({ noteCount: 0, isEmpty: true })).toBe(
      'Brain: NOT indexed for this project (0 notes) — offer to index it.',
    );
  });

  it('sidecarReachable: false behaves identically to omitting it (unavailable case)', () => {
    expect(formatBrainStatus(undefined, false)).toBe(formatBrainStatus(undefined));
  });

  it('sidecarReachable: false behaves identically to omitting it (NOT-indexed case)', () => {
    expect(formatBrainStatus({ noteCount: 0, isEmpty: true }, false)).toBe(
      formatBrainStatus({ noteCount: 0, isEmpty: true }),
    );
  });

  it('info undefined + sidecar reachable: never claims "no brain reachable" — the sidecar IS reachable', () => {
    const status = formatBrainStatus(undefined, true);
    expect(status).not.toMatch(/no brain reachable right now/);
    expect(status).toMatch(/sidecar IS reachable/);
    expect(status).toMatch(/brain_query/);
  });

  it('info.isEmpty + sidecar reachable: never claims the project is NOT indexed — the sidecar disagrees', () => {
    const status = formatBrainStatus({ noteCount: 0, isEmpty: true }, true);
    expect(status).not.toMatch(/NOT indexed for this project/);
    expect(status).toMatch(/sidecar IS reachable and answering/);
    expect(status).toMatch(/brain_query/);
  });

  it('a real, non-empty note count is reported the same regardless of sidecarReachable (no disagreement to surface)', () => {
    expect(formatBrainStatus({ noteCount: 357, isEmpty: false }, true)).toBe(
      'Brain: indexed, 357 notes for this project.',
    );
    expect(formatBrainStatus({ noteCount: 357, isEmpty: false }, false)).toBe(
      'Brain: indexed, 357 notes for this project.',
    );
  });
});

describe('buildManagerSystemPrompt — Brain: status grounding', () => {
  it('injects the real Brain: status line into Current State when brainStatus is provided', () => {
    const prompt = buildManagerSystemPrompt({
      agents: [],
      missions: [],
      brainStatus: formatBrainStatus({ noteCount: 357, isEmpty: false }),
    });
    expect(prompt).toContain('Brain: indexed, 357 notes for this project.');
  });

  it('injects the "NOT indexed" state distinctly so the manager can announce it instead of guessing', () => {
    const prompt = buildManagerSystemPrompt({
      agents: [],
      missions: [],
      brainStatus: formatBrainStatus({ noteCount: 0, isEmpty: true }),
    });
    expect(prompt).toMatch(/Brain: NOT indexed for this project/);
  });

  it('omits any Brain: status line when brainStatus is absent (no fabricated state)', () => {
    const prompt = buildManagerSystemPrompt({ agents: [], missions: [] });
    expect(prompt).not.toMatch(/^Brain: (unavailable|NOT indexed|indexed,)/m);
  });
});

describe('buildManagerCorePrompt — NEVER DEGRADE IN SILENCE rule (silent-degradation fix)', () => {
  it('documents the rule at the same rank as the anti-lie rule, referencing the Brain: three-state signal', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/NEVER DEGRADE IN SILENCE/);
    expect(prompt).toMatch(/same rank as the anti-lie rule/i);
  });

  it('documents the three Brain: states in the Brain-First Doctrine (unavailable / NOT indexed / N notes)', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/unavailable, NOT indexed for this project \(0 notes\), or N notes for this project/);
    expect(prompt).toMatch(/never speak them alike/i);
  });

  it('does not regress the existing thin/empty-recall doctrine (still says so, still suggests indexing, still never invents an action)', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/thin or empty/i);
    expect(prompt).toMatch(/suggest indexing the project/i);
    expect(prompt).toMatch(/never emit an indexing\/reindex action/i);
  });

  it('documents the UNCONFIRMED-state exception (GRAPH/RECALL DIVERGENCE FIX): never repeat "no brain accessible" while the sidecar is reachable but the local count disagrees', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/UNCONFIRMED state/);
    expect(prompt).toMatch(/brain sidecar IS reachable/);
    expect(prompt).toMatch(/Never repeat "no brain accessible"\/"indexer le projet" while this unconfirmed wording holds/);
  });

  it('does not regress prior QA rounds alongside the new silent-degradation rule', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/MANDATORY DELEGATION/);
    expect(prompt).toMatch(/THE MANAGER MUST NEVER LIE/);
    expect(prompt).toMatch(/NEVER REPEAT YOURSELF/);
    expect(prompt).toMatch(/CLEANUP DESTRUCTIVENESS/);
  });
});

describe('buildManagerCorePrompt — brain_query vs brain_query_css doctrine (structural queries)', () => {
  it('documents brain_query_css as the tool for STRUCTURE questions, distinct from brain_query for topic/history', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/brain_query_css.*STRUCTURE/s);
    expect(prompt).toMatch(/combien de parties\/modules a ce projet/);
    expect(prompt).toMatch(/NOT brain_query/);
  });

  it('includes a verified aggregate-neuron selector example for project module/part counts', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toContain('article[data-cerveau-type="aggregate-neuron"]');
  });

  it('teaches CSS-selectable file-neuron excerpts (#fn- / #bind- / data-cerveau-symbol)', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toContain('#fn-');
    expect(prompt).toContain('#bind-');
    expect(prompt).toContain('data-cerveau-symbol');
  });

  it('still documents the pre-existing decision/warning/file-path selector examples (no regression)', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toContain(':not([data-cerveau-valid-until])');
    expect(prompt).toContain('aside[role="doc-warning"]');
    expect(prompt).toContain('data[value*="src/auth"]');
  });
});

describe('buildManagerCorePrompt — Sizing Doctrine brain-primary / scan_project fallback ordering', () => {
  it('states the brain is PRIMARY for both structure and history in RECON BEFORE SIZING', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/brain PRIMARY for both structure and history/i);
  });

  it('documents scan_project as a REPLI (fallback) only when brain coverage is thin/absent/stale', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/scan_project — a REPLI only when brain coverage is thin\/absent\/stale/);
  });

  it('instructs the manager to state which source it used', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/State which source you used/);
  });

  it('preserves the cheapest-first collection order (brain -> canvas -> scan_project -> web_search)', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/brain_query.*canvas_overview\/current missions.*scan_project.*web_search/s);
  });
});

// ── MANAGER_LLM_CALL_TIMEOUT_MS / MANAGER_TURN_TIMEOUT_MS ────────────
// B12 fix: a single named, shared budget used by every manager entry point
// (sendManagerMessage's shared AbortController, AnalysisDesk's previously
// entirely unbounded call) instead of separate/duplicated/missing timeouts.
//
// P0-1 fix (real user test, 3/3 non-trivial requests timed out with 0 nodes
// created): B12's ONE shared ceiling for the whole exchange became the new
// bottleneck once a turn needed two sequential LLM calls (main + grounded
// follow-up) — each call now gets its OWN MANAGER_LLM_CALL_TIMEOUT_MS
// budget, and MANAGER_TURN_TIMEOUT_MS is widened into a purely defensive
// backstop for the WHOLE exchange (never meant to fire before either
// per-call budget would, in normal operation).

describe('MANAGER_LLM_CALL_TIMEOUT_MS', () => {
  it('is a positive, finite, reasonably-bounded per-call budget in milliseconds', () => {
    expect(MANAGER_LLM_CALL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(MANAGER_LLM_CALL_TIMEOUT_MS)).toBe(true);
    expect(MANAGER_LLM_CALL_TIMEOUT_MS).toBeLessThanOrEqual(600_000);
  });

  it('is strictly smaller than the exchange-wide MANAGER_TURN_TIMEOUT_MS backstop', () => {
    // The whole point of the P0-1 fix: a per-call budget alone should
    // recover an exchange well before the global backstop ever needs to
    // fire, whether the heavy call is the main turn or the follow-up.
    expect(MANAGER_LLM_CALL_TIMEOUT_MS).toBeLessThan(MANAGER_TURN_TIMEOUT_MS);
  });

  it('leaves enough room for the main call AND a grounded follow-up to each run their full budget within the global backstop', () => {
    expect(MANAGER_LLM_CALL_TIMEOUT_MS * 2).toBeLessThanOrEqual(MANAGER_TURN_TIMEOUT_MS);
  });
});

describe('MANAGER_TURN_TIMEOUT_MS', () => {
  it('is a positive, finite, reasonably-bounded wall-clock budget in milliseconds', () => {
    expect(MANAGER_TURN_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(MANAGER_TURN_TIMEOUT_MS)).toBe(true);
    // Sanity ceiling — this is meant to be a recovery bound, not a
    // near-infinite one (would defeat the purpose of the fix).
    expect(MANAGER_TURN_TIMEOUT_MS).toBeLessThanOrEqual(600_000);
  });
});

// ── Mission B: "draw before you build" — a graph reaching >=3 nodes must be
// PROPOSED (generate_plan → GraphProposalCard's mini-DAG) before it is ever
// materialized, never shortcut via direct create_draft/chain_agents. Real
// test finding: the manager went straight from a validated mission charter
// to "Draft : ..."/"Chainer agents" chips with no drawing shown at all —
// the founder validated a plan he had never seen. See DRAW BEFORE YOU BUILD
// in buildManagerCorePrompt.
describe('buildManagerCorePrompt — DRAW BEFORE YOU BUILD (>=3 nodes, no shortcut)', () => {
  it('documents the mandatory >=3-node gate naming generate_plan as the only compliant action', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/DRAW BEFORE YOU BUILD/);
    expect(prompt).toMatch(/3 or more nodes/);
    expect(prompt).toMatch(/you MUST emit generate_plan instead of create_draft\/chain_agents\/create_loop\/launch_best_of_n direct materialization/);
  });

  it('explicitly forbids the shortcut on a graph that completes/extends one already built or executed', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/whether the graph starts from scratch OR extends\/completes one you already built or executed earlier/);
    expect(prompt).toMatch(/completing\/extending a graph you already built or executed earlier is bound by it too/);
  });

  it('states the gate is never a courtesy — it is the only point a step can be unchecked before it costs anything', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/not a courtesy/);
    expect(prompt).toMatch(/the only point where a step can be unchecked before it costs anything/);
  });

  it('closes the "prefer create_draft + chain_agents" loophole by scoping it strictly below the threshold', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/Below the 3-node threshold \(see DRAW BEFORE YOU BUILD just below\), prefer create_draft \+ chain_agents/);
    expect(prompt).toMatch(/"prefer create_draft \+ chain_agents" just above applies ONLY strictly below this threshold/);
  });

  it('binds the Mission Charter post-validation build phase to the SAME threshold — no charter exemption', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/a Mission Charter's post-validation build phase \(propose_mission_charter, action 65 below\) is bound by the SAME threshold, never exempt from it just because the charter itself was already approved/);
    expect(prompt).toMatch(/the charter validates the PLAN'S SHAPE, not a green light to skip drawing the graph itself/);
  });

  it('never touches the pre-existing >=3-node literal the Mission Charter trigger docs depend on', () => {
    // Regression guard for the Mission Charter describe block above —
    // "Never conflate the three triggers" must still read literally
    // ">=3 nodes" (see that block's own 'documents the three distinct
    // triggers' test).
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/>=3 nodes/);
  });

  it('the Rules section restates the gate as a plain, unconditional bullet (not just prose in the Canvas section)', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/DRAW BEFORE YOU BUILD \(see the full rule above, Agent Canvas actions section\): a graph reaching >=3 nodes is ALWAYS proposed via generate_plan first, NEVER materialized via 3\+ create_draft\/chain_agents actions/);
  });

  it('below 3 nodes, direct create_draft/chain_agents/launch_mission remain frictionless — no generate_plan mandate', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/Below 3 nodes, act directly — do not add generate_plan friction to a single mechanical fix or an action\+its own verification/);
    expect(prompt).toMatch(/Below 3 nodes, create_draft\/chain_agents\/launch_mission stay direct — no proposal needed/);
  });

  it('the below-3-node worked example (draft A -> draft B) stays a direct create_draft/chain_agents pair, annotated as the exception', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/Worked example \(2 nodes — below the DRAW BEFORE YOU BUILD threshold, direct is correct here\)/);
  });

  it('the >=3-node video-promo worked example now proposes via generate_plan, never raw create_draft/chain_agents', () => {
    const prompt = buildManagerCorePrompt();
    // The 5-step pipeline is now a single generate_plan action...
    expect(prompt).toMatch(/"type": "generate_plan", "objective": "Produce a Remotion promo video for the Lazy app"/);
    expect(prompt).toMatch(/"id": "product".*"id": "web".*"dependsOn": \["product"\].*"id": "topics".*"dependsOn": \["web"\].*"id": "script".*"dependsOn": \["topics"\].*"id": "prod".*"dependsOn": \["script"\]/s);
    // ...and the narration explicitly names the threshold as the reason.
    expect(prompt).toMatch(/This graph is 5 nodes — at\/above the DRAW BEFORE YOU BUILD threshold \(>=3 nodes\) — so it is PROPOSED via generate_plan, never materialized directly with create_draft\/chain_agents/);
    // The old direct-materialization shape for this example must be gone —
    // regression guard against silently reverting to the pre-fix shortcut.
    expect(prompt).not.toMatch(/"type": "create_draft", "alias": "product", "agentName": "web-researcher"/);
  });

  it('the create_draft/chain_agents catalog rules point back to the threshold instead of reading as an unconditional default', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/Both stay BELOW the 3-node threshold — at or above it, use generate_plan instead/);
    expect(prompt).toMatch(/sequencing 3\+ new nodes goes through generate_plan's dependsOn instead/);
  });
});

describe('estimatePlanStepCostUsd / estimatePlanStepDurationMs — effort-aware plan estimate', () => {
  it('scales cost and duration up for "high" effort vs "medium" on the same tier', () => {
    const medium = estimatePlanStepCostUsd({ model: 'sonnet', effort: 'medium' });
    const high = estimatePlanStepCostUsd({ model: 'sonnet', effort: 'high' });
    expect(high).toBeGreaterThan(medium);
    const mediumMs = estimatePlanStepDurationMs({ model: 'sonnet', effort: 'medium' });
    const highMs = estimatePlanStepDurationMs({ model: 'sonnet', effort: 'high' });
    expect(highMs).toBeGreaterThan(mediumMs);
  });

  it('scales cost and duration down for "low" effort vs "medium" (default) on the same tier', () => {
    const low = estimatePlanStepCostUsd({ model: 'haiku', effort: 'low' });
    const medium = estimatePlanStepCostUsd({ model: 'haiku' }); // no effort -> 'medium' default
    expect(low).toBeLessThan(medium);
  });

  it('defaults to "medium" effort when omitted, matching the pre-existing flat per-tier estimate', () => {
    expect(estimatePlanStepCostUsd({ model: 'haiku' })).toBeCloseTo(0.5, 5);
    expect(estimatePlanStepCostUsd({ model: 'sonnet' })).toBeCloseTo(1.5, 5);
    expect(estimatePlanStepCostUsd({ model: 'opus' })).toBeCloseTo(3, 5);
    expect(estimatePlanStepDurationMs({ model: 'haiku' })).toBeCloseTo(3 * 60_000, 5);
    expect(estimatePlanStepDurationMs({ model: 'sonnet' })).toBeCloseTo(5 * 60_000, 5);
    expect(estimatePlanStepDurationMs({ model: 'opus' })).toBeCloseTo(8 * 60_000, 5);
  });

  it('multiplies by maxAttempts (retry/fix steps cost more than a single clean pass)', () => {
    const once = estimatePlanStepCostUsd({ model: 'haiku', maxAttempts: 1 });
    const thrice = estimatePlanStepCostUsd({ model: 'haiku', maxAttempts: 3 });
    expect(thrice).toBeCloseTo(once * 3, 5);
  });

  it('treats an unrecognized/absent model as the cheapest (haiku) tier, never throwing', () => {
    expect(() => estimatePlanStepCostUsd({})).not.toThrow();
    expect(estimatePlanStepCostUsd({})).toBeCloseTo(0.5, 5);
  });
});
