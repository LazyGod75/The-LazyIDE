import { parseHTML } from 'linkedom';

export type ValidationLevel = 'error' | 'warn';

export interface ValidationIssue {
  level: ValidationLevel;
  code: string;
  message: string;
  element?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  attrsCount: number;
  factsCount: number;
}

const REQUIRED_ROOT_ATTRS = [
  'id',
  'data-cerveau-version',
  'data-cerveau-created',
  'data-cerveau-source',
] as const;

const TYPE_VALUES = new Set([
  // Core types (v0.1.0)
  'episodic',
  'semantic',
  'procedural',
  'decision',
  'reference',
  // Additional types from v0.1.0 dream generation
  'architecture',
  'design',
  'feature',
  'feature-set',
  'process',
  'configuration',
  'integration',
  'methodology',
  'project',
  'task-list',
  'workflow-example',
  'database',
  'tech-stack',
  'content-example',
  'challenge',
  'automation',
  'artifacts',
  // Synthesis page types (v0.2.0)
  'topic-overview',
  'project-summary',
  'brain-index',
  // Code-first neuron types (v0.3.0)
  'file-neuron',
  'aggregate-neuron',
  'concept',
]);

const TIER_VALUES = new Set(['working', 'archival']);

const LINK_TYPE_VALUES = new Set([
  'refines',
  'contradicts',
  'generalizes',
  'cites',
  'replaces',
  'follows-from',
]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;

// Keep in sync with src/schema/scrubber.ts SECRET_PATTERNS.
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/, // OpenAI / Anthropic-style
  /AIza[0-9A-Za-z\-_]{30,}/, // Google
  /ghp_[A-Za-z0-9]{30,}/, // GitHub personal access token
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/, // PEM keys
  /xox[baprs]-[A-Za-z0-9-]{10,}/, // Slack
  /AKIA[0-9A-Z]{16}/, // AWS access key id
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/, // JWT
  /npm_[A-Za-z0-9]{36}/, // npm token
  /glpat-[A-Za-z0-9_-]{20}/, // GitLab PAT
  /sbp_[A-Za-z0-9]{40,}/, // Supabase key
  /[Bb]earer\s+[A-Za-z0-9\-_.+/=]{20,}/, // Bearer auth header
];

export function validateNote(html: string): ValidationResult {
  const issues: ValidationIssue[] = [];
  const { document } = parseHTML(`<!doctype html><body>${html}</body>`);

  // memory-batch is a third valid root tag (compress's consolidated-batch
  // notes) — same convention already used by schema/scrubber.ts. Missing it
  // here would make writeNote() (store/writer.ts, which calls validateNote
  // before writing) reject any batch note routed through it.
  const root = document.querySelector('article, section, memory-batch');
  if (!root) {
    issues.push({
      level: 'error',
      code: 'NO_ROOT',
      message: 'No <article>, <section>, or <memory-batch> root element found.',
    });
    return { ok: false, issues, attrsCount: 0, factsCount: 0 };
  }

  // Required root attrs
  for (const attr of REQUIRED_ROOT_ATTRS) {
    if (!root.getAttribute(attr)) {
      issues.push({
        level: 'error',
        code: 'MISSING_REQUIRED_ATTR',
        message: `Required attribute missing: ${attr}`,
        element: root.tagName,
      });
    }
  }

  // ID validity: must be at least 5 chars, must not start with '$' (template variable),
  // must not be bare lowercase alpha (sub-topic name leaked as ID, e.g. "mobile", "nutrition")
  const noteId = root.getAttribute('id') ?? '';
  if (noteId) {
    if (noteId.length < 5) {
      issues.push({
        level: 'error',
        code: 'INVALID_ID_TOO_SHORT',
        message: `Note id "${noteId}" is too short (min 5 chars). Likely a template variable or sub-topic name.`,
        element: root.tagName,
      });
    } else if (noteId.startsWith('$')) {
      issues.push({
        level: 'error',
        code: 'INVALID_ID_TEMPLATE_VAR',
        message: `Note id "${noteId}" starts with '$', indicating an unresolved template variable.`,
        element: root.tagName,
      });
    } else if (/^[a-z]+$/.test(noteId)) {
      issues.push({
        level: 'error',
        code: 'INVALID_ID_BARE_ALPHA',
        message: `Note id "${noteId}" is bare lowercase letters only — likely a sub-topic name, not a real note ID. IDs must include digits, hyphens, or other characters.`,
        element: root.tagName,
      });
    }
  }

  // Type enum — forward-compat: unknown types produce a WARN and are preserved,
  // NOT rejected. Only missing required fields / malformed structure are errors.
  const type = root.getAttribute('data-cerveau-type');
  if (type && !TYPE_VALUES.has(type)) {
    issues.push({
      level: 'warn',
      code: 'INVALID_TYPE',
      message: `Unknown data-cerveau-type "${type}" — preserved for forward-compatibility. Known types: ${[...TYPE_VALUES].join(', ')}`,
    });
  }

  // Tier enum — forward-compat: unknown tiers produce a WARN and are preserved.
  const tier = root.getAttribute('data-cerveau-tier');
  if (tier && !TIER_VALUES.has(tier)) {
    issues.push({
      level: 'warn',
      code: 'INVALID_TIER',
      message: `Unknown data-cerveau-tier "${tier}" — preserved for forward-compatibility. Known tiers: ${[...TIER_VALUES].join(', ')}`,
    });
  }

  // ISO date attributes
  for (const dateAttr of [
    'data-cerveau-created',
    'data-cerveau-updated',
    'data-cerveau-valid-from',
    'data-cerveau-valid-until',
    'data-cerveau-last-accessed',
  ]) {
    const v = root.getAttribute(dateAttr);
    if (v && !ISO_DATE.test(v)) {
      issues.push({
        level: 'error',
        code: 'INVALID_DATE',
        message: `Invalid ISO 8601 date on ${dateAttr}: "${v}"`,
      });
    }
  }

  // Importance float [0,1]
  for (const fAttr of ['data-cerveau-importance', 'data-cerveau-confidence']) {
    const v = root.getAttribute(fAttr);
    if (v) {
      const n = Number.parseFloat(v);
      if (Number.isNaN(n) || n < 0 || n > 1) {
        issues.push({
          level: 'error',
          code: 'OUT_OF_RANGE_FLOAT',
          message: `${fAttr} must be a float in [0,1], got "${v}"`,
        });
      }
    }
  }

  // Link types
  for (const a of Array.from(root.querySelectorAll('a[data-cerveau-link-type]'))) {
    const lt = a.getAttribute('data-cerveau-link-type');
    if (lt && !LINK_TYPE_VALUES.has(lt)) {
      issues.push({
        level: 'warn',
        code: 'INVALID_LINK_TYPE',
        message: `Unknown link type "${lt}". Expected one of ${[...LINK_TYPE_VALUES].join(', ')}`,
      });
    }
  }

  // Count facts
  const factsCount = root.querySelectorAll('[data-cerveau-fact]').length;

  // Count cerveau attrs
  let attrsCount = 0;
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const a of Array.from(el.attributes)) {
      if (a.name.startsWith('data-cerveau-')) attrsCount += 1;
    }
  }

  // Secret detection (in text + attribute values)
  const fullText = `${root.outerHTML} ${root.textContent ?? ''}`;
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(fullText)) {
      issues.push({
        level: 'error',
        code: 'SECRET_DETECTED',
        message: `Potential secret detected (pattern ${pattern.source}). Refusing to store.`,
      });
    }
  }

  // Phase 6: MDN anti-pattern checks (10 banned misuses)
  checkMdnAntiPatterns(root, issues);

  const hasErrors = issues.some((i) => i.level === 'error');
  return { ok: !hasErrors, issues, attrsCount, factsCount };
}

/**
 * Walk parent chain to check if an element is nested inside a given tag name.
 * Avoids using closest() which may not be available in all linkedom versions.
 */
function isInsideTag(el: Element, ancestorTag: string): boolean {
  let current = el.parentElement;
  while (current) {
    if (current.tagName.toLowerCase() === ancestorTag) return true;
    current = current.parentElement;
  }
  return false;
}

/**
 * Reject MDN element anti-patterns at write-time.
 * These are semantically wrong uses identified by MDN audit.
 */
function checkMdnAntiPatterns(root: Element, issues: ValidationIssue[]): void {
  const allEls = Array.from(root.querySelectorAll('*'));

  for (const el of allEls) {
    const tag = el.tagName.toLowerCase();

    // 1. <address> containing a file path or code reference
    if (tag === 'address') {
      const text = el.textContent ?? '';
      if (/[/\\]/.test(text) || /\.(ts|py|js|go|rs|html)\b/.test(text)) {
        issues.push({
          level: 'error',
          code: 'MDN_MISUSE_ADDRESS',
          message: `<address> must not contain file paths or code references. Use <code> or <data> instead. Found: "${text.slice(0, 60)}"`,
          element: 'address',
        });
      }
    }

    // 2. <cite> containing a path or commit hash
    if (tag === 'cite') {
      const text = el.textContent ?? '';
      if (
        /[/\\]/.test(text) ||
        /\.(ts|py|js|go|rs)\b/.test(text) ||
        /\b[0-9a-f]{7,40}\b/.test(text)
      ) {
        issues.push({
          level: 'error',
          code: 'MDN_MISUSE_CITE',
          message: `<cite> is for creative work titles, not file paths or commits. Use <data value="path"> instead. Found: "${text.slice(0, 60)}"`,
          element: 'cite',
        });
      }
    }

    // 3. <map> — no use case in memory notes
    if (tag === 'map') {
      issues.push({
        level: 'error',
        code: 'MDN_MISUSE_MAP',
        message: '<map> (image map) has no use case in memory notes. Remove it.',
        element: 'map',
      });
    }

    // 4. <ruby> — CJK typography only
    if (tag === 'ruby') {
      issues.push({
        level: 'error',
        code: 'MDN_MISUSE_RUBY',
        message: '<ruby> is for CJK typography only. Use plain text or <abbr> for annotations.',
        element: 'ruby',
      });
    }

    // 5. <fieldset>/<legend> outside <form>
    if (tag === 'fieldset' || tag === 'legend') {
      const inForm = isInsideTag(el, 'form');
      if (!inForm) {
        issues.push({
          level: 'error',
          code: 'MDN_MISUSE_FIELDSET',
          message: `<${tag}> must only appear inside <form>. Use <section> or <aside> for grouping.`,
          element: tag,
        });
      }
    }

    // 6. <datalist> standalone (only valid as companion to <input list="...">)
    if (tag === 'datalist') {
      issues.push({
        level: 'error',
        code: 'MDN_MISUSE_DATALIST',
        message:
          '<datalist> is only valid as companion to <input list="...">. Use <ul> for option lists.',
        element: 'datalist',
      });
    }

    // 7. <search> (intended for search controls, not result sections)
    if (tag === 'search') {
      issues.push({
        level: 'error',
        code: 'MDN_MISUSE_SEARCH',
        message:
          '<search> is for search controls (form wrappers), not result content. Use <section> instead.',
        element: 'search',
      });
    }

    // 8. <track> outside <audio>/<video>
    if (tag === 'track') {
      const inMedia = isInsideTag(el, 'audio') || isInsideTag(el, 'video');
      if (!inMedia) {
        issues.push({
          level: 'error',
          code: 'MDN_MISUSE_TRACK',
          message: '<track> must be a child of <audio> or <video>.',
          element: 'track',
        });
      }
    }

    // 9. <ol reversed> — semantically misleading for change logs / memory
    if (tag === 'ol' && el.hasAttribute('reversed')) {
      issues.push({
        level: 'error',
        code: 'MDN_MISUSE_OL_REVERSED',
        message:
          '<ol reversed> is semantically misleading in memory notes. Use plain <ol> or <ul>.',
        element: 'ol[reversed]',
      });
    }

    // 10. <dialog open> outside modal context
    if (tag === 'dialog' && el.hasAttribute('open')) {
      issues.push({
        level: 'error',
        code: 'MDN_MISUSE_DIALOG',
        message:
          '<dialog open> is intended for modal UI, not memory note content. Use <aside> or <section>.',
        element: 'dialog[open]',
      });
    }

    // 11. Custom elements matching lb-* (force standard tags)
    if (tag.startsWith('lb-')) {
      issues.push({
        level: 'error',
        code: 'MDN_MISUSE_CUSTOM_ELEMENT',
        message: `Custom element <${tag}> is not allowed. Use standard HTML tags (aside, section, article, etc.).`,
        element: tag,
      });
    }
  }
}
