/* approvalRules.ts — Persisted user rules + class defaults for the LazyBot
   approval gate.

   Rule storage mirrors loopEngine.ts: getPlatform().fs read/createDir/
   writeFile against `.lazy/approval-rules.json` under the active project
   root (same sandbox constraint approvalMode.ts documents — the generic fs
   commands are scoped to the open project). Missing or corrupt files are
   tolerated by starting empty; the fail-closed behaviour lives in
   DEFAULT_CLASS_EFFECT, never in a lucky file read.
*/

import { getPlatform } from '../../platform/index.js';
import { joinPath } from '../../paths.js';
import type { ActionClass } from './approvalTypes.js';

export interface ApprovalRule {
  id: string;                      // stable, generated at creation
  effect: 'require' | 'allow';
  klass?: ActionClass;             // optional match dimensions — all provided must match
  site?: string;                   // hostname, matched by exact host or suffix
  tool?: string;                   // exact tool name
  createdAt: number;
  label?: string;                  // human hint, e.g. "Always allow publish on x.com"
}

export interface NewApprovalRule {
  effect: 'require' | 'allow';
  klass?: ActionClass;
  site?: string;
  tool?: string;
  label?: string;
}

/** Default per-class effect. Drafting (compose) and pure observation
 *  (browse/read/screenshot) are allow; anything consequential — or
 *  unclassifiable — is require. */
export const DEFAULT_CLASS_EFFECT: Record<ActionClass, 'require' | 'allow'> = {
  browse: 'allow',
  read: 'allow',
  screenshot: 'allow',
  compose: 'allow',
  send: 'require',
  publish: 'require',
  pay: 'require',
  delete: 'require',
  credentials: 'require',
  exec: 'require',
  file_write: 'require',
  unknown: 'require',
};

const APPROVAL_RULES_FILE = '.lazy/approval-rules.json';

let _rules: ApprovalRule[] = [];
let _loaded = false;
let _loadPromise: Promise<void> | null = null;
let _cachedProjectRoot: string | null = null;
let _idSeq = 0;

function nextRuleId(): string {
  _idSeq += 1;
  return `rule-${Date.now().toString(36)}-${_idSeq.toString(36)}`;
}

/** Resolve the active project root once (approvalMode.ts pattern). In
 *  web/test environments the Tauri invoke is unavailable and we fall back to
 *  the working directory, which the platform fs mock is scoped to. The
 *  result is validated before caching — a non-string invoke result must
 *  never flow into joinPath. */
async function resolveProjectRoot(): Promise<string> {
  if (_cachedProjectRoot !== null) return _cachedProjectRoot;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const root = await invoke<string>('get_project_root');
    _cachedProjectRoot = typeof root === 'string' && root.length > 0 ? root : '.';
  } catch {
    _cachedProjectRoot = '.';
  }
  return _cachedProjectRoot;
}

async function rulesStorePath(): Promise<string> {
  return joinPath(await resolveProjectRoot(), APPROVAL_RULES_FILE);
}

async function persistRules(): Promise<void> {
  const platform = getPlatform();
  if (!platform?.fs) return;
  try {
    // joinPath (not a hardcoded '/') — see missionQueue.ts's writeQueue for
    // the full Windows verbatim-path bug-class rationale (paths.ts header).
    await platform.fs.createDir(joinPath(await resolveProjectRoot(), '.lazy'));
    await platform.fs.writeFile(await rulesStorePath(), JSON.stringify(_rules, null, 2));
  } catch (err) {
    console.warn('[approvalRules] Failed to persist approval rules:', err);
  }
}

function normalizeLoadedRules(raw: unknown): ApprovalRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: ApprovalRule[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as { id?: unknown; effect?: unknown; createdAt?: unknown };
    if (typeof rec.id !== 'string' || !rec.id) continue;
    if (rec.effect !== 'require' && rec.effect !== 'allow') continue;
    if (typeof rec.createdAt !== 'number') continue;
    rules.push(item as ApprovalRule);
  }
  return rules;
}

/** Idempotent load — missing/corrupt files start empty. The in-memory list
 *  becomes the session-authoritative rule set for the gate. */
export async function loadRules(): Promise<void> {
  if (_loaded) return Promise.resolve();
  if (!_loadPromise) {
    _loadPromise = (async () => {
      const platform = getPlatform();
      let parsed: unknown = null;
      if (platform?.fs) {
        try {
          parsed = JSON.parse(await platform.fs.readFile(await rulesStorePath())) as unknown;
        } catch {
          // Missing or corrupt file — start empty.
          parsed = null;
        }
      }
      _rules = normalizeLoadedRules(parsed);
      _loaded = true;
    })();
  }
  return _loadPromise;
}

/** Write-through persistence: replaces the whole rule list in one write (no
 *  partial states) and keeps the in-memory list authoritative for the
 *  session. */
export async function saveRules(rules: readonly ApprovalRule[]): Promise<void> {
  _rules = rules.map((rule) => ({ ...rule }));
  await persistRules();
}

/** Create a rule with a generated id. Requires at least one match dimension
 *  (klass, site, or tool) — a dimension-less rule would match everything,
 *  which would make it meaningless and dangerous. The in-memory list is
 *  updated BEFORE any await so a fire-and-forget addRule (the gate's
 *  alwaysAllow path) is visible to the very next intercept. */
export async function addRule(rule: NewApprovalRule): Promise<ApprovalRule> {
  const hasKlass = rule.klass !== undefined;
  const hasSite = rule.site !== undefined;
  const hasTool = rule.tool !== undefined;
  if (!hasKlass && !hasSite && !hasTool) {
    throw new Error('Approval rule requires at least one match dimension (klass, site, or tool).');
  }
  const created: ApprovalRule = {
    id: nextRuleId(),
    effect: rule.effect,
    createdAt: Date.now(),
    ...(hasKlass ? { klass: rule.klass } : {}),
    ...(hasSite ? { site: rule.site } : {}),
    ...(hasTool ? { tool: rule.tool } : {}),
    ...(rule.label !== undefined ? { label: rule.label } : {}),
  };
  _rules = [..._rules, created];
  await persistRules();
  return created;
}

/** Remove a rule by id; returns false when no such rule exists. */
export async function removeRule(id: string): Promise<boolean> {
  if (!_rules.some((rule) => rule.id === id)) return false;
  _rules = _rules.filter((rule) => rule.id !== id);
  await persistRules();
  return true;
}

export function listRules(): ApprovalRule[] {
  return _rules.map((rule) => ({ ...rule }));
}

/** A rule matches when every provided dimension matches. A rule with NO
 *  dimensions matches nothing (addRule rejects those at creation; loaded
 *  ones can never match either — same fail-closed semantics). Site matches
 *  by exact host or dotted suffix, so `www.x.com` matches site `x.com` while
 *  `notx.com` does not. */
function ruleMatches(rule: ApprovalRule, klass: ActionClass, site: string | undefined, tool: string): boolean {
  if (rule.klass === undefined && rule.site === undefined && rule.tool === undefined) return false;
  if (rule.klass !== undefined && rule.klass !== klass) return false;
  if (rule.site !== undefined) {
    if (site === undefined) return false;
    const host = site.toLowerCase();
    const pattern = rule.site.toLowerCase();
    if (host !== pattern && !host.endsWith('.' + pattern)) return false;
  }
  if (rule.tool !== undefined && rule.tool !== tool) return false;
  return true;
}

export interface ResolvedEffect {
  effect: 'require' | 'allow';
  /** 'rule' when a persisted rule forced the decision, 'default' when it
   *  came from DEFAULT_CLASS_EFFECT. */
  source: 'rule' | 'default';
}

/** resolveEffect with the source of the decision — the gate needs it to
 *  distinguish a user-rule block (reason 'rule') from a class-default block
 *  (reason 'class'). Semantics: any matching require beats any matching
 *  allow (Grok Bot), else the class default. */
export function resolveEffectDetailed(
  klass: ActionClass,
  site: string | undefined,
  tool: string,
  rules: readonly ApprovalRule[],
): ResolvedEffect {
  for (const rule of rules) {
    if (rule.effect === 'require' && ruleMatches(rule, klass, site, tool)) {
      return { effect: 'require', source: 'rule' };
    }
  }
  for (const rule of rules) {
    if (rule.effect === 'allow' && ruleMatches(rule, klass, site, tool)) {
      return { effect: 'allow', source: 'rule' };
    }
  }
  return { effect: DEFAULT_CLASS_EFFECT[klass], source: 'default' };
}

export function resolveEffect(
  klass: ActionClass,
  site: string | undefined,
  tool: string,
  rules: readonly ApprovalRule[],
): 'require' | 'allow' {
  return resolveEffectDetailed(klass, site, tool, rules).effect;
}

/** Test-only reset — mirrors approvalMode.ts's _resetApprovalModesForTests. */
export function _resetApprovalRulesForTests(): void {
  _rules = [];
  _loaded = false;
  _loadPromise = null;
  _cachedProjectRoot = null;
  _idSeq = 0;
}

