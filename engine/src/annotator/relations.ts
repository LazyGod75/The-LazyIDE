/**
 * Heuristic relation extractor — pulls (subject, predicate, object) triples,
 * causal links, and supersession from prose. No LLM. Outputs are encoded as
 * `data-cerveau-*` attributes that the retrieval router can filter on with
 * cheap CSS selectors, restoring graph-style reasoning for free.
 *
 * Patterns are intentionally conservative: we'd rather miss a relation than
 * emit a false one (false positives pollute the graph).
 */

export interface ExtractedRelations {
  triples: string[]; // "subj|pred|obj"
  causes: string[]; // "<reason text>" — outbound causal phrases
  replaces: string[]; // entity names this note explicitly replaces
  replacedBy: string[]; // entity names that replace this note
  supersedes: string[]; // older "fact subjects" this note overrides
}

// USES patterns
const USES_RE =
  /\b([A-Z][\w.-]{2,40}|[a-z][\w.-]{2,40})\s+(?:uses|relies on|depends on|is built on|runs on)\s+([A-Z][\w.-]{2,40}|"[^"]+"|'[^']+')/g;
const USING_RE =
  /\b(?:using|with)\s+([A-Z][\w.-]{2,40}|[a-z][\w.-]{2,40})(?:\s+(?:for|instead of)\s+([A-Z][\w.-]{2,40}|[a-z][\w.-]{2,40}))?/gi;

// REQUIRES/DEPENDS patterns
const REQUIRES_RE =
  /\b([A-Za-z][\w.-]{2,40})\s+(?:requires?|depends on|needs)\s+([A-Za-z][\w.-]{2,40})/gi;

// IS-A pattern
const IS_RE = /\b([A-Z][\w.-]{2,40})\s+is\s+(?:a|an|the)\s+([\w.-]{2,40})\b/g;

// CONFIGURED pattern — optional article (the/a/an) before entity name
const CONFIGURED_RE =
  /\b(?:configured?|set|set up)\s+(?:the\s+|a\s+|an\s+)?([A-Za-z][\w.-]{2,40})\s+(?:with|to|as)\s+([A-Za-z][\w.-]{2,40}|"[^"]+"|'[^']+')/gi;

// SWITCHED/MIGRATED patterns
const SWITCHED_RE =
  /\b(?:switched?|migrated?)\s+(?:from|to)\s+([A-Za-z][\w.-]{2,40})(?:\s+(?:to|from)\s+([A-Za-z][\w.-]{2,40}))?/gi;

// REPLACES patterns (original strict pattern)
const REPLACES_RE =
  /\b(?:replace[ds]?|switch(?:ed)? (?:from|away from)|moved? (?:from|away from)|deprecat(?:ed|ing))\s+(?:from\s+)?([A-Za-z][\w.-]{2,40})(?:\s+(?:to|with|by)\s+([A-Za-z][\w.-]{2,40}))?/gi;

// Additional REPLACES patterns (looser)
const REPLACES_EXPLICIT_RE =
  /\b(?:replaced|switched|migrated)\s+(?:the\s+)?(?:old\s+)?([A-Za-z][\w.-]{2,40})\s+(?:with|to|by)\s+([A-Za-z][\w.-]{2,40})/gi;
const INSTEAD_OF_RE =
  /instead\s+of\s+([A-Za-z][\w.-]{2,40}),?\s+(?:now\s+)?(?:using|going with)\s+([A-Za-z][\w.-]{2,40})/gi;
const DEPRECATED_IN_FAVOR_RE =
  /(?:deprecated|removed)(?:\s+the\s+old)?(?:\s+the\s+)?(?:\s+old)?\s+([A-Za-z](?:[\w.-]*\s+)?[\w.-]{1,40})\s+(?:in favor of|in favour of|for|replaced by|with)\s+([A-Za-z][\w.-]{2,40})/gi;

const REPLACED_BY_RE =
  /\b([A-Za-z][\w.-]{2,40})\s+(?:replaced by|superseded by|is replaced (?:by|with))\s+([A-Za-z][\w.-]{2,40})/gi;
const PICKED_OVER_RE =
  /\b(?:we |i )?(?:picked|chose|went with|selected)\s+([A-Za-z][\w.-]{2,40})\s+(?:over|instead of|rather than)\s+([A-Za-z][\w.-]{2,40})/gi;

// CAUSE patterns (original strict pattern)
const CAUSE_RE =
  /\b(?:because|reason:|caused by|due to|root cause:|since)\s+(.{6,160}?)(?:[.!?]|$)/gi;

// Additional CAUSE patterns (looser, conversational)
const BECAUSE_RE =
  /(?:the\s+)?(?:issue|problem|bug|error|failure|crash|reason)\s+(?:was|is|were)\s+(?:caused by|due to|because of|because)\s+([A-Za-z][^.!?\n]{5,120})/gi;
const FIXED_BY_RE =
  /(?:fixed|resolved|fixed it|solved)\s+(?:by|via|using|with)\s+([A-Za-z][^.!?\n]{5,100})/gi;
const PARCE_QUE_RE = /(?:parce que|car|en raison de|à cause de)\s+([A-Za-z][^.!?\n]{5,120})/gi;
const REASON_WAS_RE = /(?:the\s+)?reason\s+(?:was|is)\s+(.{6,120})/gi;

// X led to Y
const LED_TO_RE = /\b(.{6,80}?)\s+(?:led to|resulted in|caused)\s+(.{6,80}?)(?:[.!?]|$)/gi;

const STOPWORD_OBJECTS = new Set([
  'the',
  'a',
  'an',
  'it',
  'this',
  'that',
  'these',
  'those',
  'true',
  'false',
  'null',
  'undefined',
  'something',
  'nothing',
  'one',
  'two',
  'three',
  'good',
  'bad',
  'better',
  'fine',
]);

function normalize(s: string): string {
  return s
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function isMeaningful(token: string): boolean {
  const n = normalize(token);
  return n.length >= 2 && n.length <= 60 && !STOPWORD_OBJECTS.has(n);
}

export function extractRelations(text: string): ExtractedRelations {
  const triples = new Set<string>();
  const causes = new Set<string>();
  const replaces = new Set<string>();
  const replacedBy = new Set<string>();
  const supersedes = new Set<string>();

  // X uses Y (strict)
  USES_RE.lastIndex = 0;
  for (let m = USES_RE.exec(text); m !== null; m = USES_RE.exec(text)) {
    const subj = normalize(m[1]);
    const obj = normalize(m[2]);
    if (isMeaningful(subj) && isMeaningful(obj) && subj !== obj) {
      triples.add(`${subj}|uses|${obj}`);
    }
  }

  // Using X for Y or with X (looser)
  USING_RE.lastIndex = 0;
  for (let m = USING_RE.exec(text); m !== null; m = USING_RE.exec(text)) {
    const obj = normalize(m[1]);
    if (isMeaningful(obj)) {
      triples.add(`project|uses|${obj}`);
    }
  }

  // X is a/an Y
  IS_RE.lastIndex = 0;
  for (let m = IS_RE.exec(text); m !== null; m = IS_RE.exec(text)) {
    const subj = normalize(m[1]);
    const obj = normalize(m[2]);
    if (isMeaningful(subj) && isMeaningful(obj) && subj !== obj) {
      triples.add(`${subj}|is-a|${obj}`);
    }
  }

  // X requires/depends on Y
  REQUIRES_RE.lastIndex = 0;
  for (let m = REQUIRES_RE.exec(text); m !== null; m = REQUIRES_RE.exec(text)) {
    const subj = normalize(m[1]);
    const obj = normalize(m[2]);
    if (isMeaningful(subj) && isMeaningful(obj) && subj !== obj) {
      triples.add(`${subj}|requires|${obj}`);
    }
  }

  // Configured X with/to Y
  CONFIGURED_RE.lastIndex = 0;
  for (let m = CONFIGURED_RE.exec(text); m !== null; m = CONFIGURED_RE.exec(text)) {
    const entity = normalize(m[1]);
    const config = normalize(m[2]);
    if (isMeaningful(entity) && isMeaningful(config)) {
      triples.add(`${entity}|configured-with|${config}`);
    }
  }

  // Switched/migrated from X to Y
  SWITCHED_RE.lastIndex = 0;
  for (let m = SWITCHED_RE.exec(text); m !== null; m = SWITCHED_RE.exec(text)) {
    const first = normalize(m[1]);
    const second = m[2] ? normalize(m[2]) : '';
    if (isMeaningful(first)) {
      if (second && isMeaningful(second)) {
        // Assume pattern is "switched from X to Y"
        replaces.add(first);
        triples.add(`${second}|replaces|${first}`);
        supersedes.add(first);
      }
    }
  }

  // replaced / switched from X to Y (original strict pattern)
  REPLACES_RE.lastIndex = 0;
  for (let m = REPLACES_RE.exec(text); m !== null; m = REPLACES_RE.exec(text)) {
    const from = m[1] ? normalize(m[1]) : '';
    const to = m[2] ? normalize(m[2]) : '';
    if (from && isMeaningful(from)) {
      replaces.add(from);
      if (to && isMeaningful(to)) {
        triples.add(`${to}|replaces|${from}`);
        supersedes.add(from);
      }
    }
  }

  // Replaced the old X with Y (looser explicit pattern)
  REPLACES_EXPLICIT_RE.lastIndex = 0;
  for (let m = REPLACES_EXPLICIT_RE.exec(text); m !== null; m = REPLACES_EXPLICIT_RE.exec(text)) {
    const old = normalize(m[1]);
    const newOne = normalize(m[2]);
    if (isMeaningful(old) && isMeaningful(newOne)) {
      replaces.add(old);
      triples.add(`${newOne}|replaces|${old}`);
      supersedes.add(old);
    }
  }

  // Instead of X, now using Y
  INSTEAD_OF_RE.lastIndex = 0;
  for (let m = INSTEAD_OF_RE.exec(text); m !== null; m = INSTEAD_OF_RE.exec(text)) {
    const old = normalize(m[1]);
    const newOne = normalize(m[2]);
    if (isMeaningful(old) && isMeaningful(newOne)) {
      replaces.add(old);
      triples.add(`${newOne}|replaces|${old}`);
      supersedes.add(old);
    }
  }

  // Deprecated X in favor of Y
  DEPRECATED_IN_FAVOR_RE.lastIndex = 0;
  for (
    let m = DEPRECATED_IN_FAVOR_RE.exec(text);
    m !== null;
    m = DEPRECATED_IN_FAVOR_RE.exec(text)
  ) {
    const old = normalize(m[1]);
    const newOne = normalize(m[2]);
    if (isMeaningful(old) && isMeaningful(newOne)) {
      replaces.add(old);
      triples.add(`${newOne}|replaces|${old}`);
      supersedes.add(old);
    }
  }

  // X replaced/superseded by Y
  REPLACED_BY_RE.lastIndex = 0;
  for (let m = REPLACED_BY_RE.exec(text); m !== null; m = REPLACED_BY_RE.exec(text)) {
    const subj = normalize(m[1]);
    const by = normalize(m[2]);
    if (isMeaningful(subj) && isMeaningful(by)) {
      replacedBy.add(by);
      triples.add(`${by}|replaces|${subj}`);
    }
  }

  // picked X over Y
  PICKED_OVER_RE.lastIndex = 0;
  for (let m = PICKED_OVER_RE.exec(text); m !== null; m = PICKED_OVER_RE.exec(text)) {
    const picked = normalize(m[1]);
    const overOne = normalize(m[2]);
    if (isMeaningful(picked) && isMeaningful(overOne)) {
      triples.add(`${picked}|chosen-over|${overOne}`);
      supersedes.add(overOne);
    }
  }

  // because / due to / caused by (original strict pattern)
  CAUSE_RE.lastIndex = 0;
  for (let m = CAUSE_RE.exec(text); m !== null; m = CAUSE_RE.exec(text)) {
    const reason = m[1].trim();
    if (reason.length >= 6 && reason.length <= 160) {
      causes.add(reason);
    }
  }

  // "The issue was caused by X" or "The problem is X"
  BECAUSE_RE.lastIndex = 0;
  for (let m = BECAUSE_RE.exec(text); m !== null; m = BECAUSE_RE.exec(text)) {
    const reason = m[1].trim();
    if (reason.length >= 6 && reason.length <= 160) {
      causes.add(reason);
    }
  }

  // "Fixed by X" / "Resolved by X"
  FIXED_BY_RE.lastIndex = 0;
  for (let m = FIXED_BY_RE.exec(text); m !== null; m = FIXED_BY_RE.exec(text)) {
    const solution = m[1].trim();
    if (solution.length >= 6 && solution.length <= 160) {
      causes.add(solution);
    }
  }

  // "Parce que X" / "En raison de X" (French)
  PARCE_QUE_RE.lastIndex = 0;
  for (let m = PARCE_QUE_RE.exec(text); m !== null; m = PARCE_QUE_RE.exec(text)) {
    const reason = m[1].trim();
    if (reason.length >= 6 && reason.length <= 160) {
      causes.add(reason);
    }
  }

  // "The reason was X"
  REASON_WAS_RE.lastIndex = 0;
  for (let m = REASON_WAS_RE.exec(text); m !== null; m = REASON_WAS_RE.exec(text)) {
    const reason = m[1].trim();
    if (reason.length >= 6 && reason.length <= 160) {
      causes.add(reason);
    }
  }

  // X led to Y
  LED_TO_RE.lastIndex = 0;
  for (let m = LED_TO_RE.exec(text); m !== null; m = LED_TO_RE.exec(text)) {
    const subj = m[1].trim();
    const obj = m[2].trim();
    if (subj.length >= 6 && obj.length >= 6) {
      triples.add(
        `${normalize(subj.split(' ').slice(-3).join(' '))}|caused|${normalize(obj.split(' ').slice(0, 3).join(' '))}`,
      );
    }
  }

  return {
    triples: [...triples].slice(0, 6),
    causes: [...causes].slice(0, 3),
    replaces: [...replaces].slice(0, 3),
    replacedBy: [...replacedBy].slice(0, 3),
    supersedes: [...supersedes].slice(0, 3),
  };
}

/**
 * Encode extracted relations as a string suitable for the article's
 * data-cerveau-* attributes. Returns the attribute fragment to inject before
 * the closing `>` of the article opening tag.
 */
export function relationsToAttributes(rel: ExtractedRelations): string {
  const parts: string[] = [];
  if (rel.triples.length) {
    parts.push(`data-cerveau-triples="${htmlEscape(rel.triples.join(';'))}"`);
  }
  if (rel.causes.length) {
    parts.push(`data-cerveau-causes="${htmlEscape(rel.causes.join('|'))}"`);
  }
  if (rel.replaces.length) {
    parts.push(`data-cerveau-replaces="${htmlEscape(rel.replaces.join(','))}"`);
  }
  if (rel.replacedBy.length) {
    parts.push(`data-cerveau-replaced-by="${htmlEscape(rel.replacedBy.join(','))}"`);
  }
  if (rel.supersedes.length) {
    parts.push(`data-cerveau-supersedes="${htmlEscape(rel.supersedes.join(','))}"`);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
