import { parseHTML } from 'linkedom';

export interface ScrubResult {
  cleaned: string;
  removedAttrs: string[];
  blockedReason?: string;
  warnings: string[];
  /** Patterns that triggered the block, if blockedReason is set */
  detectedPatterns: string[];
  /** Provenance attributes that were stripped (public-strict mode only) */
  strippedProvenanceAttrs: string[];
  /** Count of private paths replaced in attribute values */
  pathsScrubbed: number;
}

// Attributes considered safe for public publication.
// Anything else is stripped silently.
const PUBLIC_SAFE_ATTRS = new Set([
  'id',
  'class',
  'href',
  'src',
  'alt',
  'title',
  'lang',
  'dir',
  'datetime',
  'data-cerveau-version',
  'data-cerveau-created',
  'data-cerveau-updated',
  'data-cerveau-type',
  'data-cerveau-tier',
  'data-cerveau-tags',
  'data-cerveau-importance',
  'data-cerveau-source',
  'data-cerveau-valid-from',
  'data-cerveau-valid-until',
  'data-cerveau-fact',
  'data-cerveau-confidence',
  'data-cerveau-kind',
  'data-cerveau-link-type',
  'data-cerveau-link-strength',
  'data-cerveau-link-direction',
  'data-cerveau-link-auto',
  'data-cerveau-batch-size',
  'data-cerveau-batch-period',
  'data-cerveau-compression-ratio',
  // Relations and metadata
  'data-cerveau-entities',
  'data-cerveau-triples',
  'data-cerveau-causes',
  'data-cerveau-replaces',
  'data-cerveau-replaced-by',
  'data-cerveau-supersedes',
  // Extraction metadata
  'data-cerveau-extracted-by',
  'data-cerveau-saliency-kind',
  'data-cerveau-topic',
  'data-cerveau-tool',
  'data-cerveau-cwd',
  'data-cerveau-files-modified',
  'data-cerveau-files-read',
  // Provenance (multi-agent backends, v0.3.0)
  'data-cerveau-agent',
  'data-cerveau-source-kind',
  'data-cerveau-session-parent',
  'data-cerveau-git-commit',
  'data-cerveau-git-branch',
  'data-cerveau-session-id',
  // Access and validity tracking
  'data-cerveau-access-count',
  'data-cerveau-last-accessed',
  'data-cerveau-invalidated-by',
  // Attributes for links in infobox and semantic HTML
  'rel',
  'data-q',
  'data-error',
  'data-section',
  'data-primary',
  'aria-current',
  'aria-expanded',
  'value',
  'min',
  'max',
  'optimum',
  'role',
  'reversed',
]);

/**
 * Provenance attributes stripped in public-strict profile.
 * These reveal internal filesystem layout, git state, and session identifiers.
 */
export const PROVENANCE_ATTRS_STRICT = [
  'data-cerveau-cwd',
  'data-cerveau-files-modified',
  'data-cerveau-files-read',
  'data-cerveau-git-branch',
  'data-cerveau-git-commit',
  'data-cerveau-session-parent',
  'data-cerveau-session-id',
  'data-cerveau-source',
] as const;

export type PublishProfile = 'default' | 'public-strict';

const FORBIDDEN_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'iframe',
  'object',
  'embed',
  'template',
  'form',
  'input',
  'textarea',
  'button',
]);

/**
 * Patterns that block the entire note when matched anywhere in raw HTML.
 * Each entry includes a human-readable label for the report.
 */
const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  // Existing patterns
  { label: 'OpenAI/Anthropic key (sk-)', pattern: /sk-[A-Za-z0-9]{20,}/ },
  { label: 'Google API key (AIza)', pattern: /AIza[0-9A-Za-z\-_]{30,}/ },
  { label: 'GitHub PAT (ghp_)', pattern: /ghp_[A-Za-z0-9]{30,}/ },
  { label: 'PEM private key', pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----/ },
  { label: 'Slack token (xox)', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { label: 'Email address', pattern: /[A-Za-z0-9_]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  // New patterns
  { label: 'AWS access key id (AKIA)', pattern: /AKIA[0-9A-Z]{16}/ },
  {
    label: 'JWT token',
    pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  },
  { label: 'npm token (npm_)', pattern: /npm_[A-Za-z0-9]{36}/ },
  { label: 'GitLab PAT (glpat-)', pattern: /glpat-[A-Za-z0-9_-]{20}/ },
  { label: 'Supabase key (sbp_)', pattern: /sbp_[A-Za-z0-9]{40,}/ },
  {
    label: 'Bearer auth header',
    // Matches "Bearer <token>" where token is 20+ non-whitespace chars.
    // Excludes short words like "Bearer true" that appear in prose.
    pattern: /[Bb]earer\s+[A-Za-z0-9\-_.+/=]{20,}/,
  },
  {
    label: 'Private IPv4 (10.x / 192.168.x / 172.16-31.x)',
    pattern:
      /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/,
  },
  {
    label: 'International phone number',
    // Conservative: requires explicit country code prefix (+1..+999) followed by
    // at least two groups of 2+ digits with common separators (space, dash, dot).
    // Requires the match is not preceded by a dot or digit (avoids version strings).
    // Examples matched: +1-555-867-5309, +44 20 1234 5678, +49 30 1234 5678.
    // Examples NOT matched: +1.0.0, 2026-05-26, "version 0.2.0".
    pattern: /(?<![.\d])\+[1-9]\d{0,2}(?:[\s.-]\(?\d{2,4}\)?){2,5}(?!\d)/,
  },
];

const PRIVATE_PATH_PATTERN = /(?:[A-Z]:[\\/]|\/Users\/|\/home\/)/i;

export interface ScrubOptions {
  profile?: PublishProfile;
}

export function scrubForPublic(html: string, opts: ScrubOptions = {}): ScrubResult {
  const removed: string[] = [];
  const warnings: string[] = [];
  const detectedPatterns: string[] = [];
  const strippedProvenanceAttrs: string[] = [];
  let pathsScrubbed = 0;

  const profile = opts.profile ?? 'default';

  // Detect secrets in raw text first — block the whole note
  for (const { label, pattern } of SECRET_PATTERNS) {
    if (pattern.test(html)) {
      detectedPatterns.push(label);
    }
  }

  if (detectedPatterns.length > 0) {
    return {
      cleaned: '',
      removedAttrs: removed,
      warnings,
      detectedPatterns,
      strippedProvenanceAttrs,
      pathsScrubbed,
      blockedReason: `Secret/PII pattern detected: ${detectedPatterns.join('; ')}`,
    };
  }

  const { document } = parseHTML(`<!doctype html><body>${html}</body>`);

  for (const tag of Array.from(document.querySelectorAll([...FORBIDDEN_TAGS].join(',')))) {
    tag.remove();
    warnings.push(`Removed <${tag.tagName.toLowerCase()}>`);
  }

  const strictProvenanceSet =
    profile === 'public-strict' ? new Set(PROVENANCE_ATTRS_STRICT as readonly string[]) : null;

  for (const el of Array.from(document.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes) as Attr[]) {
      const name = attr.name.toLowerCase();

      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        removed.push(`${name} (event handler)`);
        continue;
      }

      // In public-strict mode, strip provenance attrs before the safe-list check
      if (strictProvenanceSet?.has(name)) {
        el.removeAttribute(attr.name);
        strippedProvenanceAttrs.push(name);
        continue;
      }

      if (!PUBLIC_SAFE_ATTRS.has(name)) {
        el.removeAttribute(attr.name);
        removed.push(name);
      } else if (name === 'data-cerveau-source' || name === 'href' || name === 'src') {
        const value = attr.value;
        if (PRIVATE_PATH_PATTERN.test(value)) {
          warnings.push(`Private path replaced in ${name}: ${value}`);
          el.setAttribute(attr.name, '[scrubbed]');
          pathsScrubbed += 1;
        }
      }
    }
  }

  const root = document.querySelector('article, section, memory-batch');
  return {
    cleaned: root?.outerHTML ?? document.body.innerHTML,
    removedAttrs: [...new Set(removed)],
    warnings,
    detectedPatterns,
    strippedProvenanceAttrs: [...new Set(strippedProvenanceAttrs)],
    pathsScrubbed,
  };
}
