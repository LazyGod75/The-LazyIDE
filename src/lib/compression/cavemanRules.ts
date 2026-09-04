/* Caveman rules.
   Prose condensation rules: filler removal, context condensation,
   structural compression, multi-turn dedup, ultra abbreviations. */

import type { CavemanRule, CavemanIntensity } from './types.js';
import { intensityRank } from './types.js';

const CAVEMAN_RULES: CavemanRule[] = [
  // ── Category 1: Filler Removal ──────────────────────────────────────

  {
    name: 'redundant_phrasing',
    pattern:
      /\b(?:make sure to|be sure to|due to the fact that|the reason is because|it is important to|you should|remember to)\b\s*/gi,
    replacement: (match: string): string => {
      const map: Record<string, string> = {
        'make sure to': 'ensure ',
        'be sure to': 'ensure ',
        'due to the fact that': 'because ',
        'the reason is because': 'because ',
        'it is important to': '',
        'you should': '',
        'remember to': '',
      };
      return map[match.trim().toLowerCase()] ?? '';
    },
    context: 'all',
    category: 'structural',
    minIntensity: 'full',
    description: 'Replace verbose stock phrases with shorter equivalents.',
  },
  {
    name: 'pleasantries',
    pattern:
      /(?<!make\s)(?<!be\s)\b(?:i'?d be happy to|i would be happy to|i'?d be glad to|i would be glad to|glad to help|happy to|thank you|thanks|no problem|you'?re welcome|absolutely|certainly|of course|sure)\b[,.!?\s]*/gi,
    replacement: '',
    context: 'all',
    category: 'filler',
    minIntensity: 'lite',
    description: 'Drop conversational acknowledgements that do not change request meaning.',
  },
  {
    name: 'polite_framing',
    pattern:
      /\b(?:please|kindly|could you please|would you please|can you please|I would like you to|I want you to|I need you to)\b\s*/gi,
    replacement: '',
    context: 'all',
    category: 'filler',
    minIntensity: 'lite',
  },
  {
    name: 'hedging',
    pattern:
      /\b(?:it seems like|it appears that|I think that|I believe that|probably|possibly|maybe it)\b\s*/gi,
    replacement: '',
    context: 'all',
    category: 'filler',
    minIntensity: 'lite',
  },
  {
    name: 'verbose_instructions',
    pattern:
      /\b(?:provide a detailed explanation of|give me a comprehensive explanation of|write an in-depth explanation of|create a thorough explanation of|provide a detailed|give me a comprehensive|write an in-depth|create a thorough|explain in detail)\b/gi,
    replacement: (match: string): string => {
      const map: Record<string, string> = {
        'provide a detailed explanation of': 'explain ',
        'give me a comprehensive explanation of': 'explain ',
        'write an in-depth explanation of': 'explain ',
        'create a thorough explanation of': 'explain ',
        'provide a detailed': 'provide ',
        'give me a comprehensive': 'give ',
        'write an in-depth': 'write ',
        'create a thorough': 'create ',
        'explain in detail': 'explain ',
      };
      const lower = match.toLowerCase();
      return map[lower] ?? match;
    },
    context: 'all',
    category: 'filler',
    minIntensity: 'lite',
  },
  {
    name: 'filler_adverbs',
    pattern: /(?<![a-z])\b(?:basically|essentially|actually|literally|simply|currently)\b\s*/gi,
    replacement: '',
    context: 'all',
    category: 'filler',
    minIntensity: 'lite',
  },
  {
    name: 'articles',
    pattern: /\b(?:[Aa]n|[Aa]|[Tt]he)\s+(?=[a-z])/g,
    replacement: '',
    context: 'all',
    category: 'terse',
    minIntensity: 'full',
    description: 'Remove English articles from prose while protected technical tokens stay intact.',
  },
  {
    name: 'filler_phrases',
    pattern: /^(?:I want to|I need to|I'd like to|I'm looking for)\b\s*/gim,
    replacement: '',
    context: 'user',
    category: 'filler',
    minIntensity: 'lite',
  },
  {
    name: 'redundant_openers',
    pattern: /^(?:Hi there|Hello|Good morning|Hey)\s*[,.!?\s]?\s*/gim,
    replacement: '',
    context: 'user',
    category: 'filler',
    minIntensity: 'lite',
  },
  {
    name: 'verbose_requests',
    pattern: /\b(?:I was wondering if you could|Would it be possible to)\b\s*/gi,
    replacement: '',
    context: 'user',
    category: 'filler',
    minIntensity: 'lite',
  },
  {
    name: 'leader_phrases',
    pattern: /^(?:i'?ll|i will|i can|i'?d|let me|you can|we will|we can|let'?s)\s+(?=[a-z])/gim,
    replacement: '',
    context: 'all',
    category: 'terse',
    minIntensity: 'full',
    description: 'Remove leading helper phrases before the actual instruction or answer.',
  },
  {
    name: 'self_reference',
    pattern: /^(?:I am trying to|I am working on|I have been)\b\s*/gim,
    replacement: '',
    context: 'user',
    category: 'filler',
    minIntensity: 'lite',
  },
  {
    name: 'excessive_gratitude',
    pattern: /\b(?:Thank you so much|Thanks in advance|I really appreciate)\b[,.!?\s]*/gi,
    replacement: '',
    context: 'all',
    category: 'filler',
    minIntensity: 'lite',
  },
  {
    name: 'qualifier_removal',
    pattern: /\b(?:a bit|a little|somewhat|kind of|sort of)\b\s*/gi,
    replacement: '',
    context: 'all',
    category: 'filler',
    minIntensity: 'lite',
  },

  // ── Category 2: Context Condensation ────────────────────────────────

  {
    name: 'compound_collapse',
    pattern: /\band any potential\b/gi,
    replacement: '',
    context: 'all',
    category: 'context',
    minIntensity: 'full',
  },
  {
    name: 'explanatory_prefix',
    pattern:
      /\b(?:The function appears to be handling|The code seems to|The class is|This module is)\b/gi,
    replacement: (match: string): string => {
      const map: Record<string, string> = {
        'the function appears to be handling': 'Function:',
        'the code seems to': 'Code:',
        'the class is': 'Class:',
        'this module is': 'Module:',
      };
      return map[match.toLowerCase()] ?? match;
    },
    context: 'all',
    category: 'context',
    minIntensity: 'lite',
  },
  {
    name: 'question_to_directive',
    pattern:
      /\b(?:Can you explain why|Could you show me how|Would you tell me|Can you tell me)\b\s*/gi,
    replacement: (match: string): string => {
      const trimmed = match.trimEnd().toLowerCase();
      const map: Record<string, string> = {
        'can you explain why': 'Explain why ',
        'could you show me how': 'Show how ',
        'would you tell me': 'Tell me ',
        'can you tell me': 'Tell me ',
      };
      return map[trimmed] ?? match;
    },
    context: 'user',
    category: 'context',
    minIntensity: 'lite',
  },
  {
    name: 'context_setup',
    pattern: /\b(?:I have the following code|Here is my code|Below is the code)\b\s*[:.]?\s*/gi,
    replacement: 'Code:',
    context: 'user',
    category: 'context',
    minIntensity: 'lite',
  },
  {
    name: 'intent_clarification',
    pattern:
      /\b(?:What I'm trying to do is|My objective is to|What I need is|I'm aiming to)\b\s*/gi,
    replacement: 'Goal:',
    context: 'user',
    category: 'context',
    minIntensity: 'lite',
  },
  {
    name: 'background_removal',
    pattern: /\b(?:As you may know,?\s*|As we discussed earlier,?\s*)/gi,
    replacement: '',
    context: 'all',
    category: 'context',
    minIntensity: 'lite',
  },
  {
    name: 'meta_commentary',
    pattern: /^(?:Note that|Keep in mind that|Remember that)\b\s*/gim,
    replacement: '',
    context: 'all',
    category: 'context',
    minIntensity: 'lite',
  },
  {
    name: 'purpose_statement',
    pattern: /\b(?:for the purpose of|with the goal of|in an effort to|for every)\b/gi,
    replacement: (match: string): string => {
      const map: Record<string, string> = {
        'for the purpose of': 'for',
        'with the goal of': 'to',
        'in an effort to': 'to',
        'for every': 'per',
      };
      return map[match.toLowerCase()] ?? match;
    },
    context: 'all',
    category: 'context',
    minIntensity: 'lite',
  },

  // ── Category 3: Structural Compression ──────────────────────────────

  {
    name: 'list_conjunction',
    pattern: /,\s*and also\s+|,\s*as well as\s+/gi,
    replacement: ', ',
    context: 'all',
    category: 'structural',
    minIntensity: 'full',
  },
  {
    name: 'purpose_phrases',
    pattern: /\b(?:in order to|so as to)\b\s*/gi,
    replacement: 'to ',
    context: 'all',
    category: 'structural',
    minIntensity: 'lite',
  },
  {
    name: 'redundant_quantifiers',
    pattern: /\b(?:each and every single|each and every|any and all)\b/gi,
    replacement: (match: string): string => {
      const map: Record<string, string> = {
        'each and every single': 'each',
        'each and every': 'each',
        'any and all': 'all',
      };
      return map[match.toLowerCase()] ?? match;
    },
    context: 'all',
    category: 'structural',
    minIntensity: 'full',
  },
  {
    name: 'verbose_connectors',
    pattern: /\b(?:furthermore|additionally|moreover|in addition)\b\s*/gi,
    replacement: 'also ',
    context: 'all',
    category: 'structural',
    minIntensity: 'lite',
  },
  {
    name: 'transition_removal',
    pattern: /^(?:On the other hand,?\s*|In contrast,?\s*|However,?\s*)/gim,
    replacement: '',
    context: 'all',
    category: 'structural',
    minIntensity: 'lite',
  },
  {
    name: 'emphasis_removal',
    pattern: /\b(?:very|really|extremely|highly|quite)\s+(?=[a-z])/gi,
    replacement: '',
    context: 'all',
    category: 'structural',
    minIntensity: 'lite',
  },
  {
    name: 'passive_voice',
    pattern:
      /\b(?:is being used|is being called|is being generated|was created|was generated|was implemented)\b/gi,
    replacement: (match: string): string => {
      const map: Record<string, string> = {
        'is being used': 'uses',
        'is being called': 'calls',
        'is being generated': 'generated',
        'was created': 'created',
        'was generated': 'generated',
        'was implemented': 'implemented',
      };
      return map[match.toLowerCase()] ?? match;
    },
    context: 'all',
    category: 'structural',
    minIntensity: 'full',
  },

  // ── Category 4: Multi-Turn Dedup ────────────────────────────────────

  {
    name: 'repeated_context',
    pattern:
      /\b(?:As we discussed earlier|As mentioned before|As previously stated|As I said before)\b[,.]?\s*/gi,
    replacement: 'See above. ',
    context: 'all',
    category: 'dedup',
    minIntensity: 'lite',
  },
  {
    name: 'repeated_question',
    pattern:
      /\b(?:Same question as before|I asked this earlier|This is the same question)\b[,.]?\s*/gi,
    replacement: '[same question] ',
    context: 'user',
    category: 'dedup',
    minIntensity: 'lite',
  },
  {
    name: 'reestablished_context',
    pattern: /\b(?:Going back to the code above|Referring back to|Returning to)\b\s*/gi,
    replacement: 'Re: ',
    context: 'all',
    category: 'dedup',
    minIntensity: 'lite',
  },
  {
    name: 'summary_replacement',
    pattern:
      /\b(?:To summarize what we've discussed|In summary of our conversation|To recap)\b[,.]?\s*/gi,
    replacement: 'Summary: ',
    context: 'assistant',
    category: 'dedup',
    minIntensity: 'lite',
  },

  // ── Category 5: Ultra Abbreviations ─────────────────────────────────

  {
    name: 'ultra_abbreviations',
    pattern:
      /\b(?:database|configuration|function|request|response|implementation|authentication|authorization|application|dependency|dependencies)\b/gi,
    replacement: (match: string): string => {
      const map: Record<string, string> = {
        database: 'DB',
        configuration: 'config',
        function: 'fn',
        request: 'req',
        response: 'res',
        implementation: 'impl',
        authentication: 'auth',
        authorization: 'authz',
        application: 'app',
        dependency: 'dep',
        dependencies: 'deps',
      };
      return map[match.toLowerCase()] ?? match;
    },
    context: 'all',
    category: 'ultra',
    minIntensity: 'ultra',
  },
];

const RULE_KEYWORDS: Record<string, string[]> = {
  redundant_phrasing: ['make sure', 'be sure'],
  redundant_because: ['due to the fact', 'the reason is because'],
  redundant_directive: ['it is important', 'you should', 'remember to'],
  pleasantries: [
    'sure', 'certainly', 'of course', 'happy to', 'thanks', 'thank you',
    'glad to help', 'glad to', 'no problem', "you're welcome", 'youre welcome',
    'absolutely',
  ],
  polite_framing: [
    'please', 'kindly', 'could you please', 'would you please',
    'can you please', 'i would like you', 'i want you', 'i need you',
  ],
  hedging: ['it seems like', 'it appears that', 'i think that', 'i believe that', 'probably', 'possibly', 'maybe it'],
  verbose_instructions: [
    'provide a detailed', 'give me a comprehensive', 'write an in-depth',
    'create a thorough', 'explain in detail',
  ],
  filler_adverbs: ['basically', 'essentially', 'actually', 'literally', 'simply', 'currently'],
  filler_phrases: ['i want to', 'i need to', "i'd like to", "i'm looking for"],
  redundant_openers: ['hi there', 'hello', 'good morning', 'hey'],
  verbose_requests: ['i was wondering', 'would it be possible'],
  leader_phrases: ["i'll", 'i will', 'i can', "i'd", 'let me', 'you can', 'we will', 'we can', "let's"],
  self_reference: ['i am trying to', 'i am working on', 'i have been'],
  excessive_gratitude: ['thank you so much', 'thanks in advance', 'i really appreciate'],
  qualifier_removal: ['a bit', 'a little', 'somewhat', 'kind of', 'sort of'],
  softeners: ['if possible', 'when you get a chance', 'at your convenience', 'just wondering'],
  uncertainty_fillers: ['i guess', 'i suppose', 'more or less', 'in a way'],
  compound_collapse: ['and any potential'],
  explanatory_prefix: ['the function appears to be handling', 'the code seems to', 'the class is', 'this module is'],
  question_to_directive: ['can you explain why', 'could you show me how', 'would you tell me', 'can you tell me'],
  context_setup: ['i have the following code', 'here is my code', 'below is the code'],
  intent_clarification: ["what i'm trying to do", 'my objective is to', 'what i need is', "i'm aiming to"],
  background_removal: ['as you may know', 'as we discussed earlier'],
  meta_commentary: ['note that', 'keep in mind', 'remember that'],
  purpose_statement: ['for the purpose of', 'with the goal of', 'in an effort to', 'for every'],
  list_conjunction: ['and also', 'as well as'],
  purpose_phrases: ['in order to', 'so as to'],
  redundant_quantifiers: ['each and every', 'any and all'],
  verbose_connectors: ['furthermore', 'additionally', 'moreover', 'in addition'],
  transition_removal: ['on the other hand', 'in contrast', 'however'],
  emphasis_removal: ['very', 'really', 'extremely', 'highly', 'quite'],
  passive_voice: ['is being used', 'is being called', 'is being generated', 'was created', 'was generated', 'was implemented'],
  repeated_context: ['as we discussed earlier', 'as mentioned before', 'as previously stated', 'as i said before'],
  repeated_question: ['same question as before', 'i asked this earlier', 'this is the same question'],
  reestablished_context: ['going back to the code above', 'referring back to', 'returning to'],
  summary_replacement: ['to summarize', 'in summary of our conversation', 'to recap'],
  ultra_abbreviations: ['database', 'configuration', 'function', 'request', 'response', 'implementation', 'authentication', 'authorization', 'application', 'dependency', 'dependencies'],
};

const ARTICLE_HINT_RE = /\b(?:a|an|the)\b/;

function shouldAttemptRule(ruleName: string, lowerText: string): boolean {
  if (ruleName === 'articles') {
    ARTICLE_HINT_RE.lastIndex = 0;
    return ARTICLE_HINT_RE.test(lowerText);
  }
  const keywords = RULE_KEYWORDS[ruleName];
  return !keywords || keywords.some((keyword) => lowerText.includes(keyword));
}

export function applyRulesToText(
  text: string,
  rules: CavemanRule[],
): { text: string; appliedRules: string[] } {
  let result = text;
  const lowerResult = text.toLowerCase();
  const appliedRules: string[] = [];

  for (const rule of rules) {
    if (!shouldAttemptRule(rule.name, lowerResult)) continue;

    const before = result;
    const { pattern, replacement } = rule;
    if (typeof replacement === 'function') {
      const fn = replacement;
      result = result.replace(pattern, (...args) => {
        const match = args[0];
        return fn(match, ...args.slice(1, -2));
      });
    } else {
      result = result.replace(pattern, replacement);
    }
    if (result !== before) {
      appliedRules.push(rule.name);
    }
  }

  return { text: result, appliedRules };
}

export function getRulesForContext(
  context: string,
  intensity: CavemanIntensity = 'full',
): CavemanRule[] {
  const rank = intensityRank(intensity);
  return CAVEMAN_RULES.filter((rule) => {
    const minRank = intensityRank(rule.minIntensity ?? 'lite');
    return (rule.context === 'all' || rule.context === context) && minRank <= rank;
  });
}

export function getRuleByName(name: string): CavemanRule | undefined {
  return CAVEMAN_RULES.find((rule) => rule.name === name);
}

export { CAVEMAN_RULES };
