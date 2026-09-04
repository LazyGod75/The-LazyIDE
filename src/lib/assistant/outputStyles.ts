/* Output styles.
   Deterministic, cache-safe system-prompt additions that steer the model's
   output style (terse prose, less code, lazy senior dev).
   Instruction text is static per (id, level) — no timestamps, no per-request
   interpolation — so the injected prefix stays prompt-cache-stable. */

export type OutputStyleLevel = 'lite' | 'full' | 'ultra';

export interface OutputStyle {
  id: string;
  label: string;
  description?: string;
  levels: { lite: string; full: string; ultra: string };
}

export interface OutputStyleSelectionEntry {
  id: string;
  level: OutputStyleLevel;
}

/** Shared boundary clause appended to every style. */
export const SHARED_BOUNDARIES =
  'Code blocks, file paths, commands, errors, URLs: keep exact. ' +
  'Security warnings, irreversible action confirmations, multi-step ordered sequences: write normal. ' +
  'Resume terse style after. Active every response until user asks for normal mode.';

export const OUTPUT_STYLE_CATALOG: Record<string, OutputStyle> = {
  'terse-prose': {
    id: 'terse-prose',
    label: 'Terse prose',
    description: 'Drop filler/articles/hedging; keep technical substance exact.',
    levels: {
      lite: `Respond concise. Drop filler, pleasantries, hedging. Keep full sentences, technical terms, code, errors, URLs, and identifiers exact. ${SHARED_BOUNDARIES}`,
      full: `Respond terse like smart caveman. Drop articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries, hedging. Fragments OK. Short synonyms (big not extensive, fix not implement). Keep all technical substance, code, errors, URLs, identifiers exact. ${SHARED_BOUNDARIES}`,
      ultra: `Respond ultra terse. Maximum compression. Telegraphic. Abbreviate (DB/auth/config/req/res/fn/impl), strip conjunctions, arrows for causality (X → Y). One word when one word enough. Never abbreviate code symbols, API names, error strings, URLs, or identifiers. ${SHARED_BOUNDARIES}`,
    },
  },
  'less-code': {
    id: 'less-code',
    label: 'Less code',
    description: 'YAGNI ladder: smallest working change, no unrequested abstractions.',
    levels: {
      lite: `Write the smallest change that satisfies the request. Skip speculative abstractions. ${SHARED_BOUNDARIES}`,
      full: `Act like a lazy senior dev applying YAGNI. Smallest working change only. No unrequested abstractions, no premature generalization, no extra layers, no defensive scaffolding the request did not ask for. Reuse existing code over adding new code. ${SHARED_BOUNDARIES}`,
      ultra: `Minimal diff discipline. Touch the fewest lines that make it work. Zero new files, classes, or config unless strictly required. Inline over abstract. No "while we're here" extras. ${SHARED_BOUNDARIES}`,
    },
  },
  ponytail: {
    id: 'ponytail',
    label: 'Ponytail (lazy senior dev)',
    description:
      'Lazy senior-dev discipline: climb the YAGNI ladder, fix root cause, smallest working diff.',
    levels: {
      lite: `# Ponytail, lazy senior dev mode (lite)\n\nBefore writing any code: does it need to exist? Does it already exist here? Does the stdlib/installed dep cover it? Only then: write the minimum. Reuse over rewrite. ${SHARED_BOUNDARIES}`,
      full: `# Ponytail, lazy senior dev mode\n\nYou are a lazy senior developer. Lazy means efficient, not careless. The best code is the code never written.\n\nBefore writing any code, stop at the first rung that holds:\n\n1. Does this need to be built at all? (YAGNI)\n2. Does it already exist in this codebase? Reuse the helper, util, or pattern that's already here, don't re-write it.\n3. Does the standard library already do this? Use it.\n4. Does a native platform feature cover it? Use it.\n5. Does an already-installed dependency solve it? Use it.\n6. Can this be one line? Make it one line.\n7. Only then: write the minimum code that works.\n\n${SHARED_BOUNDARIES}`,
      ultra: `# Ponytail, lazy senior dev mode (ultra)\n\nMinimum viable diff. Zero new files unless strictly required. Zero new abstractions. Fix root cause, not symptom. Inline over extract. Delete over comment. If you must add code: one function, one purpose, one screen. ${SHARED_BOUNDARIES}`,
    },
  },
};

export const OUTPUT_STYLE_IDS = Object.keys(OUTPUT_STYLE_CATALOG);

export function outputStyleMeta(id: string): OutputStyle | undefined {
  return OUTPUT_STYLE_CATALOG[id];
}

/** Idempotency marker for the injection. */
export const OUTPUT_STYLE_MARKER = '[Lazy Output Styles]';

/**
 * Build the combined instruction text for a selection of styles.
 * Styles are resolved in catalog order; SHARED_BOUNDARIES is stripped from
 * each individual style and appended once at the end.
 */
function buildStyleInstructions(selection: OutputStyleSelectionEntry[]): string {
  const parts: string[] = [];
  for (const { id, level } of selection) {
    const meta = outputStyleMeta(id);
    if (!meta) continue;
    const text = meta.levels[level] ?? meta.levels.full;
    // Strip the shared boundary so it's appended exactly once below
    parts.push(text.replace(SHARED_BOUNDARIES, '').trim());
  }
  return parts.join('\n');
}

/**
 * Resolve a selection into the ordered, known styles in catalog order.
 * Drops unknown ids silently (forward-compatible).
 */
function resolveStyles(selection: OutputStyleSelectionEntry[]): OutputStyleSelectionEntry[] {
  const byId = new Map(selection.map((entry) => [entry.id, entry]));
  const resolved: OutputStyleSelectionEntry[] = [];
  for (const id of OUTPUT_STYLE_IDS) {
    const entry = byId.get(id);
    if (!entry) continue;
    resolved.push({ id, level: entry.level });
  }
  return resolved;
}

export interface OutputStylesResult {
  systemPrompt: string;
  applied: boolean;
  appliedStyles: OutputStyleSelectionEntry[];
}

/**
 * Inject output styles into a system prompt string.
 * Idempotent: if the marker is already present, returns the prompt unchanged.
 */
export function applyOutputStyles(
  systemPrompt: string,
  selection: OutputStyleSelectionEntry[],
): OutputStylesResult {
  const resolved = resolveStyles(selection ?? []);
  if (resolved.length === 0) {
    return { systemPrompt, applied: false, appliedStyles: [] };
  }

  if (systemPrompt.includes(OUTPUT_STYLE_MARKER)) {
    return { systemPrompt, applied: false, appliedStyles: [] };
  }

  const combined = `${buildStyleInstructions(resolved)} ${SHARED_BOUNDARIES}`;
  const instruction = `${OUTPUT_STYLE_MARKER}\n${combined}`;

  return {
    systemPrompt: `${systemPrompt}\n\n${instruction}`,
    applied: true,
    appliedStyles: resolved,
  };
}
