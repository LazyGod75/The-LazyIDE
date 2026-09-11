/* modelVariants — decomposes a concrete model id into a base model plus
   its orthogonal modifiers, so pickers can render ONE row per model family
   with an effort selector instead of one row per effort permutation.

   Why: the live Devin ACP catalog lists ~190 ids, most of which are the
   SAME model at different settings:
     claude-opus-5-{low,medium,high,xhigh,max}        (5 rows, 1 model)
     claude-opus-5-{…}-fast                            (fast modifier)
     gpt-5-6-sol-{none,…,max}[-priority]               (priority modifier)
     claude-opus-4-6[-thinking][-1m]                   (thinking, long ctx)
   Every other IDE (Cursor, Windsurf, Zed) renders these as "Claude Opus 5"
   + a reasoning-level dropdown + a fast toggle — same model, different
   dials. This module only decomposes/groupes; the SELECTED id stays the
   concrete catalog id (`claude-opus-5-high`), so nothing downstream —
   routing, billing, persistence — changes.

   Parse order matters: modifiers stack on the right of the effort suffix
   (`gpt-5-6-sol-low-priority`, `glm-5-2-max-1m`) or without an effort
   (`claude-opus-4-6-thinking-1m`). We strip known suffixes right-to-left
   until none match; whatever remains is the family base. Ids that carry no
   recognized suffix are their own family (swe-1-6, adaptive, MODEL_PRIVATE_*).
*/

export type ModelEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Ascending effort order used to sort a family's effort chips. */
export const EFFORT_ORDER: readonly ModelEffort[] = [
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
];

const EFFORT_SUFFIXES: ReadonlySet<string> = new Set(EFFORT_ORDER);

export interface DecomposedModel {
  /** Family base id — the id minus every recognized trailing modifier
   *  (e.g. 'claude-opus-5' for 'claude-opus-5-high-fast'). */
  base: string;
  effort?: ModelEffort;
  /** '-fast' speed variant (Devin catalog). */
  fast: boolean;
  /** '-priority' priority-tier variant (Devin catalog). */
  priority: boolean;
  /** '-thinking' extended-thinking variant (Devin catalog). */
  thinking: boolean;
  /** '-1m' long-context variant (Devin catalog). */
  longCtx: boolean;
  /** Every concrete catalog id belonging to this family was produced by
   *  recombineDecomposition — kept here so tests can assert round-trip. */
}

/** Split a catalog id into base + modifiers. The input is returned as
 *  `base` when no recognized suffix is present. Case-insensitive on the
 *  suffixes only — the base keeps its original casing (MODEL_GPT_5_2_HIGH
 *  decomposes to base MODEL_GPT_5_2). */
export function decomposeModelId(id: string): DecomposedModel {
  let rest = id;
  const out: DecomposedModel = { base: id, fast: false, priority: false, thinking: false, longCtx: false };

  // Right-to-left modifier peel — each pass takes at most one flag suffix
  // and at most one effort suffix (effort always sits leftmost of the
  // modifier stack: base-EFFORT-fast-priority-1m-thinking in any combo the
  // catalog actually emits, e.g. -max-1m, -thinking-1m, -low-priority).
  for (let guard = 0; guard < 6; guard++) {
    const lower = rest.toLowerCase();
    // Separator: '-' for kebab-case ids, '_' for the MODEL_* uppercase
    // family (MODEL_GPT_5_2_XHIGH) — take whichever comes last.
    const sep = Math.max(lower.lastIndexOf('-'), lower.lastIndexOf('_'));
    const suffix = sep >= 0 ? lower.slice(sep + 1) : '';
    if (suffix === 'fast') { out.fast = true; rest = rest.slice(0, sep); continue; }
    if (suffix === 'priority') { out.priority = true; rest = rest.slice(0, sep); continue; }
    if (suffix === 'thinking') { out.thinking = true; rest = rest.slice(0, sep); continue; }
    if (suffix === '1m') { out.longCtx = true; rest = rest.slice(0, sep); continue; }
    if (EFFORT_SUFFIXES.has(suffix) && out.effort === undefined) {
      out.effort = suffix as ModelEffort;
      rest = rest.slice(0, sep);
      continue;
    }
    break;
  }

  out.base = rest;
  return out;
}

/** Rebuild the concrete catalog id for a decomposition — the inverse of
 *  decomposeModelId for ids that follow the canonical suffix order
 *  (effort, then fast/priority/thinking/1m left-to-right as the catalog
 *  emits them). Used by the picker's effort chips: pick a family row, then
 *  a chip, and this produces the id to select. */
export function recombineModelId(
  base: string,
  effort: ModelEffort | undefined,
  mods: Pick<DecomposedModel, 'fast' | 'priority' | 'thinking' | 'longCtx'>,
): string {
  let id = base;
  if (effort) id += `-${effort}`;
  if (mods.fast) id += '-fast';
  if (mods.priority) id += '-priority';
  if (mods.thinking) id += '-thinking';
  if (mods.longCtx) id += '-1m';
  return id;
}

export interface ModelFamily<T extends { id: string; label: string }> {
  /** Base id shared by the family (the decomposeModelId base). */
  base: string;
  /** Display label — the family's cleanest label with effort words
   *  stripped (see familyLabel). */
  label: string;
  /** Concrete catalog ids in this family, in catalog order. */
  members: T[];
  /** Effort levels actually present in the catalog for this family. */
  efforts: ModelEffort[];
  /** Modifiers present on at least one member. */
  hasFast: boolean;
  hasPriority: boolean;
  hasThinking: boolean;
  hasLongCtx: boolean;
  /** The member a plain family click should select: the family's medium
   *  when present (catalog convention), else the bare base entry, else the
   *  first member. */
  defaultMember: T;
}

const EFFORT_LABEL_RE = /\b(none|minimal|low|medium|high|xhigh|max|fast|priority|thinking|1m)\b/gi;

/** Strip the effort/modifier words from a member label — 'Claude Opus 5
 *  Medium' → 'Claude Opus 5'. Only used for family labels; member rows keep
 *  their full label. */
export function familyLabel(label: string): string {
  return label.replace(EFFORT_LABEL_RE, '').replace(/\s{2,}/g, ' ').trim();
}

/** Group a catalog list into families, preserving catalog order for both
 *  the family list and each family's members. Families with a single member
 *  still return (pickers render them as plain rows — no chips). */
export function groupModelFamilies<T extends { id: string; label: string }>(
  models: readonly T[],
): ModelFamily<T>[] {
  const order: string[] = [];
  const byBase = new Map<string, T[]>();
  for (const m of models) {
    const { base } = decomposeModelId(m.id);
    let fam = byBase.get(base);
    if (!fam) {
      fam = [];
      byBase.set(base, fam);
      order.push(base);
    }
    fam.push(m);
  }
  return order.map((base) => {
    const members = byBase.get(base)!;
    const efforts = [
      ...new Set(
        members
          .map((m) => decomposeModelId(m.id).effort)
          .filter((e): e is ModelEffort => e !== undefined),
      ),
    ].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
    const decos = members.map((m) => decomposeModelId(m.id));
    const bare = members.find((_, i) => decos[i].effort === undefined && !decos[i].fast && !decos[i].priority && !decos[i].thinking && !decos[i].longCtx);
    const medium = members.find((_, i) => decos[i].effort === 'medium' && !decos[i].fast && !decos[i].priority && !decos[i].thinking && !decos[i].longCtx);
    const labelSrc = bare ?? medium ?? members[0];
    return {
      base,
      label: familyLabel(labelSrc.label) || labelSrc.label,
      members,
      efforts,
      hasFast: decos.some((d) => d.fast),
      hasPriority: decos.some((d) => d.priority),
      hasThinking: decos.some((d) => d.thinking),
      hasLongCtx: decos.some((d) => d.longCtx),
      defaultMember: medium ?? bare ?? members[0],
    };
  });
}

/** Find the family + decomposition of a concrete id inside a family's
 *  member list — used to mark which effort chip is active. */
export function locateInFamily<T extends { id: string; label: string }>(
  family: ModelFamily<T>,
  id: string,
): { member: T; deco: DecomposedModel } | undefined {
  const member = family.members.find((m) => m.id === id);
  return member ? { member, deco: decomposeModelId(id) } : undefined;
}

/** Resolve an effort-chip click to a concrete member id: prefer the exact
 *  match (same modifiers as the current selection, new effort), else the
 *  closest member carrying that effort (modifiers dropped), else undefined
 *  when the family has no member at that effort. */
export function memberForEffort<T extends { id: string; label: string }>(
  family: ModelFamily<T>,
  currentId: string,
  effort: ModelEffort,
): string | undefined {
  const current = locateInFamily(family, currentId)?.deco;
  const decos = family.members.map((m) => ({ m, d: decomposeModelId(m.id) }));
  const want = (fast: boolean, priority: boolean, thinking: boolean, longCtx: boolean) =>
    decos.find((x) => x.d.effort === effort && x.d.fast === fast && x.d.priority === priority && x.d.thinking === thinking && x.d.longCtx === longCtx)?.m.id;
  if (current) {
    const exact = want(current.fast, current.priority, current.thinking, current.longCtx);
    if (exact) return exact;
  }
  return want(false, false, false, false) ?? decos.find((x) => x.d.effort === effort)?.m.id;
}
