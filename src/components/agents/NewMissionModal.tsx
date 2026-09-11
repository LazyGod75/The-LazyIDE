/* NewMissionModal — centered dialog for creating a new agent mission.
   Dark/violet theme. Esc + backdrop close. Focus trap. aria dialog.
*/

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { ALL_MODELS, DEFAULT_MODEL } from '../../lib/models/registry';
import { OPENROUTER_MODELS, findOpenRouterModel } from '../../lib/models/openrouterCatalog';
import type { ReasoningEffort } from '../../lib/models/openrouterCatalog';
import { getModelPickerOptions, noModelFallbackMessage, modelManagedByCodexMessage } from '../../lib/models/modelPickerOptions';
import { getEngineReadiness, engineReasonKey } from '../../lib/models/entitlement';
import type { EngineReadiness } from '../../lib/models/entitlement';
import { useAgentsStore, type NewMissionInput } from './agentsStore';
import type { PermissionMode } from '../../lib/agents/runtime';
import { classifyMissionModel } from '../../lib/agents/runtime';
import type { Mission, MissionContract, ProofRequirement } from '../../lib/agents/types';
import { quote, defaultBudgetCapUsd, type MissionQuote } from '../../lib/agents/estimator';
import { usdToCredits } from '../../lib/billing/credits';
import { checkConflicts } from '../../lib/agents/preflight';
import { classifyMissionFit } from '../../lib/agents/missionGuidance';
import { useI18n } from '../../i18n';
import { useAppContext } from '../../app/AppContext';
import { emit } from '../../lib/bus';
import { basename } from '../../lib/paths';
import { useFocusTrap } from '../../hooks/useFocusTrap';

// ── Types ─────────────────────────────────────────────────────────

interface NewMissionModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/** The 3 proof requirement kinds surfaced as checkboxes in this modal — a
    subset of ProofRequirement['kind'] (spec §8 also lists 'e2e_recording'
    and 'behavior_diff', not offered here as a manual toggle: e2e recordings
    and behavior diffs are produced by dedicated flows, not a checkbox at
    launch time). */
const PROOF_CHECKBOX_KINDS = ['screenshot', 'test_run', 'command_output'] as const;
type ProofCheckboxKind = (typeof PROOF_CHECKBOX_KINDS)[number];

interface FormState {
  title: string;
  description: string;
  agentPrompt: string;
  repo: string;
  modelId: string;
  orchestrator: boolean;
  permissionMode: PermissionMode;
  /** Raw comma/newline-separated scope paths textarea value — parsed via
      parseScopePaths() before use (quote computation, contract). */
  scopePathsRaw: string;
  /** Hard budget cap in USD; 0 = no cap. Auto-filled from the live quote
      (defaultBudgetCapUsd) until the user edits it directly. */
  budgetCapUsd: number;
  /** True once the user has directly edited budgetCapUsd — stops the
      auto-fill effect from overwriting their choice on the next quote. */
  budgetCapTouched: boolean;
  /** Wall-clock cap selection (W-GUARD UI); 'unlimited' writes nothing to
      the contract — see resolveMaxDurationMs. */
  maxDurationOption: DurationOptionId;
  proofs: Record<ProofCheckboxKind, boolean>;
  /** Reasoning effort for the selected model — 'off' disables it.
      Only meaningful when the selected model supports reasoning. */
  effort: 'off' | ReasoningEffort;
}

// ── Helpers ───────────────────────────────────────────────────────

const FALLBACK_REPOS = [
  { value: 'lazy-ide', label: 'lazy-ide' },
  { value: 'lazybrain', label: 'lazybrain' },
];

/** Stable fallback for useAgentsStore()'s `missions` — a module-level
 *  constant, NOT an inline `[]` destructuring default. An inline `[]`
 *  literal is re-evaluated on every render, producing a brand-new array
 *  reference each time; runningMissions' useMemo (keyed on `missions`) and
 *  the conflict-preflight effect (keyed on `runningMissions`) would then
 *  never see a stable dependency, re-running — and calling
 *  setConflictTitles([]) — on literally every render, forever (verified via
 *  newMissionPreflight.test.tsx: any useAgentsStore() stub that omits
 *  `missions`, e.g. `() => ({ addMission })`, spins an unbounded render loop
 *  that exhausts the process). Reusing ONE empty array for every render
 *  keeps the whole chain referentially stable when the store has no
 *  running missions to report. */
const EMPTY_MISSIONS: Mission[] = [];

/** Debounce window for the live pre-launch quote (spec §7.3) — recomputed
    this long after the last change to task text / model / orchestrator /
    scope paths, so a fast typist doesn't trigger a quote() call per
    keystroke. */
const QUOTE_DEBOUNCE_MS = 400;

/** Parses the scope-paths textarea into a trimmed, non-empty path list.
    Accepts either comma- or newline-separated input (or a mix). */
function parseScopePaths(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function deriveWorktree(title: string): string {
  const slug = slugify(title);
  return slug ? `wt/${slug}` : '';
}

/** The 3 autonomy levels — mapped 1:1 onto the PermissionMode values the
    runtime actually honors (agent_run's --permission-mode wiring): read-only
    plan, auto-accepted edits (safe default), full bypass. */
const PERMISSION_MODE_IDS: PermissionMode[] = ['plan', 'acceptEdits', 'full'];

/** Wall-clock cap options for the "Durée max" select (W-GUARD UI) — mirrors
    MissionContract.maxDurationMs (agents/types.ts) exactly. 'unlimited' is
    the default and resolves to `undefined` (see resolveMaxDurationMs below),
    so submitting the form unchanged writes no maxDurationMs at all — no
    behavior change for every mission created before this field existed. */
const DURATION_OPTIONS = [
  { id: 'unlimited', ms: undefined },
  { id: '15m', ms: 15 * 60_000 },
  { id: '30m', ms: 30 * 60_000 },
  { id: '1h', ms: 60 * 60_000 },
  { id: '2h', ms: 2 * 60 * 60_000 },
  { id: '4h', ms: 4 * 60 * 60_000 },
] as const;
type DurationOptionId = (typeof DURATION_OPTIONS)[number]['id'];

function resolveMaxDurationMs(optionId: DurationOptionId): number | undefined {
  return DURATION_OPTIONS.find((o) => o.id === optionId)?.ms;
}

/** Seeds the form's model field with the best default for the user's CURRENT
 *  entitlements (see modelPickerOptions.ts) — the managed catalog's default
 *  when Lazy Pro is actively usable, else the Claude subscription's default,
 *  else the same native fallback as before this fix. */
function getInitialModelId(): string {
  return getModelPickerOptions().defaultModelId;
}

function makeInitialForm(defaultRepo = 'lazy-ide'): FormState {
  return {
    title: '',
    description: '',
    agentPrompt: '',
    repo: defaultRepo,
    modelId: getInitialModelId(),
    orchestrator: false,
    permissionMode: 'acceptEdits',
    scopePathsRaw: '',
    budgetCapUsd: 0,
    budgetCapTouched: false,
    maxDurationOption: 'unlimited',
    // Test run checked by default — every mission created through this
    // modal is a code mission today (no docs-only mission type exists yet
    // to exempt, see spec §8's proof-of-work gate, T1.4).
    proofs: { screenshot: false, test_run: true, command_output: false },
    effort: 'medium',
  };
}

// ── Component ─────────────────────────────────────────────────────

export function NewMissionModal({ isOpen, onClose }: NewMissionModalProps) {
  // `missions` was already exposed by this same hook (AgentsStoreValue
  // extends AgentsState) — reading one more field off a store this
  // component already reads from, rather than threading a new prop through
  // any render site (T1.6's conflict notice, see conflictTitles below).
  // Defaulted defensively: several existing tests mock this hook down to
  // just `{ addMission }` (e.g. newMissionPreflight.test.tsx), which is
  // otherwise still a perfectly valid stub for everything BUT this feature.
  const { addMission, missions = EMPTY_MISSIONS } = useAgentsStore();
  const { t } = useI18n();
  const { projectRoot } = useAppContext();

  // F5 fix (post-e2e wave): reuse the single shared basename helper (see
  // paths.ts's doc comment) instead of a local re-derivation — this is the
  // repo/project selector's display name in the "+ Ouvrir" modal.
  const repoName = projectRoot ? basename(projectRoot) : 'lazy-ide';

  const repos = useMemo(() => {
    const current = { value: repoName, label: repoName };
    const rest = FALLBACK_REPOS.filter(r => r.value !== repoName);
    return [current, ...rest];
  }, [repoName]);

  const [form, setForm] = useState<FormState>(() => makeInitialForm(repoName));
  const [titleError, setTitleError] = useState(false);
  /** Engine preflight verdict from the last submit attempt (null = no attempt
      or engine ready). Re-checked on EVERY submit so the panel disappears as
      soon as readiness is fixed. */
  const [preflight, setPreflight] = useState<EngineReadiness | null>(null);
  /** Live pre-launch quote (spec §7.3) — recomputed debounced as the task
      text/model/orchestrator/scope change. Null until the first quote
      resolves (or the task is empty). */
  const [quoteResult, setQuoteResult] = useState<MissionQuote | null>(null);
  const [quoteComputing, setQuoteComputing] = useState(false);
  /** Conflict pre-flight notice (T1.6, spec §7.2) — titles of currently
      running missions this one's declared scope overlaps. Declared here
      (rather than next to the effect that computes it, further down, right
      after buildContract) so the reset-on-open effect below can clear it
      immediately, same as quoteResult/preflight. */
  const [conflictTitles, setConflictTitles] = useState<string[]>([]);

  // Grouped model options for the CURRENT entitlements — a Claude
  // subscription and a Lazy Pro plan are independent and can both be active,
  // so this offers both catalogs together instead of picking one from the
  // single resolved provider mode (see modelPickerOptions.ts's header for
  // the bug this replaces: #nm-model used to only ever render ALL_MODELS,
  // the 4-model native Claude catalog, unless accessMode alone resolved to
  // managed/pro — hiding the OpenRouter catalog from a Pro user whose
  // accessMode preference was 'cli').
  const pickerOptions = getModelPickerOptions(t);
  const firstInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const scopePaths = useMemo(() => parseScopePaths(form.scopePathsRaw), [form.scopePathsRaw]);

  // Task-selection guardrail (G8, missionGuidance.ts) — flags high-taste,
  // architecture, or open-ended tasks that don't suit an autonomous agent
  // loop. Recomputed as the user types; null (no banner) while the task
  // text is still empty, matching the live quote's own taskText source.
  const missionFitTaskText = form.agentPrompt.trim() || form.title.trim();
  const missionFitVerdict = useMemo(
    () => (missionFitTaskText ? classifyMissionFit(missionFitTaskText) : null),
    [missionFitTaskText],
  );
  const showMissionFitBanner =
    missionFitVerdict !== null && (missionFitVerdict.fit === 'risky' || missionFitVerdict.fit === 'poor-fit');

  // Reset form and focus on open
  useEffect(() => {
    if (isOpen) {
      setForm(makeInitialForm(repoName)); // eslint-disable-line react-hooks/set-state-in-effect
      setTitleError(false);
      setPreflight(null);
      setQuoteResult(null);
      setQuoteComputing(false);
      setConflictTitles([]);
      setTimeout(() => firstInputRef.current?.focus(), 30);
    }
  }, [isOpen, repoName]);

  // Focus trap + Esc close (shared hook — see hooks/useFocusTrap.ts).
  useFocusTrap(dialogRef, { onClose, isDisabled: !isOpen });

  // Live pre-launch quote (spec §7.3): recomputed QUOTE_DEBOUNCE_MS after
  // the last change to task text / model / orchestrator / scope, so a fast
  // typist doesn't trigger a quote() call per keystroke. Cleared when the
  // task is empty — no point quoting nothing.
  useEffect(() => {
    if (!isOpen) return;
    const taskText = form.agentPrompt.trim() || form.title.trim();
    if (!taskText) {
      // Synchronous resets mirroring the "clear derived state" pattern
      // already used by the reset-on-open effect above — not a derived
      // read of external state, so react-hooks/set-state-in-effect's
      // general cascading-render concern doesn't apply here.
      setQuoteResult(null); // eslint-disable-line react-hooks/set-state-in-effect
      setQuoteComputing(false);
      return;
    }

    let cancelled = false;
    setQuoteComputing(true);
    const timer = setTimeout(() => {
      quote(taskText, { scopePaths, model: form.modelId, orchestrator: form.orchestrator })
        .then((q) => {
          if (cancelled) return;
          setQuoteResult(q);
          setQuoteComputing(false);
        })
        .catch(() => {
          if (!cancelled) setQuoteComputing(false);
        });
    }, QUOTE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isOpen, form.agentPrompt, form.title, form.modelId, form.orchestrator, scopePaths]);

  // Prefill the budget cap from the quote's default (3x cost upper bound)
  // until the user directly edits the field — see handleBudgetCapChange.
  useEffect(() => {
    if (!quoteResult || form.budgetCapTouched) return;
    const nextCap = defaultBudgetCapUsd(quoteResult);
    // Derives budgetCapUsd from quoteResult (an external async result, not
    // a plain prop/state read) — same accepted synchronous-setState shape
    // as the reset-on-open effect above.
    setForm((prev) => // eslint-disable-line react-hooks/set-state-in-effect
      prev.budgetCapTouched ? prev : { ...prev, budgetCapUsd: nextCap },
    );
  }, [quoteResult, form.budgetCapTouched]);

  const updateField = useCallback(
    <K extends keyof FormState>(key: K, value: FormState[K]) => {
      setForm(prev => ({ ...prev, [key]: value }));
      if (key === 'title' && titleError) setTitleError(false);
    },
    [titleError],
  );

  const toggleProof = useCallback((kind: ProofCheckboxKind) => {
    setForm(prev => ({ ...prev, proofs: { ...prev.proofs, [kind]: !prev.proofs[kind] } }));
  }, []);

  /** Numeric input handler for the budget cap field — marks the field
      "touched" so the auto-fill effect above stops overwriting it. Falls
      back to the previous value on a non-numeric intermediate input
      (e.g. a bare "-" while typing) rather than coercing to NaN/0.

      Fix D (2026-08-19 dollar-kill incident, display half) — the field the
      user SEES and TYPES INTO is credits (see the input's own `value` at
      its render site below); `form.budgetCapUsd` stays USD internally
      (MissionContract.budgetCapUsd's own established unit — renaming it
      would ripple through every runtime.ts/managedAgent.ts consumer for no
      behavioral gain), so entered credits are converted back to USD here,
      the single boundary where that conversion happens for this field. */
  const handleBudgetCapChange = useCallback((value: string) => {
    const parsedCredits = value === '' ? 0 : Number(value);
    setForm(prev => ({
      ...prev,
      budgetCapUsd: Number.isFinite(parsedCredits) ? parsedCredits / 100 : prev.budgetCapUsd,
      budgetCapTouched: true,
    }));
  }, []);

  /** Assembles the spec §8 MissionContract from the current form state —
      used at submit time (see handleSubmit's attachment note below). */
  const buildContract = useCallback((): MissionContract => {
    const proofs: ProofRequirement[] = PROOF_CHECKBOX_KINDS.filter(
      (kind) => form.proofs[kind],
    ).map((kind) => ({ kind }));
    const maxDurationMs = resolveMaxDurationMs(form.maxDurationOption);

    return {
      objective: form.agentPrompt.trim() || form.title.trim(),
      scopePaths: scopePaths.length > 0 ? scopePaths : undefined,
      model: form.modelId,
      effort: form.effort === 'off' ? undefined : form.effort,
      permissionMode: form.permissionMode,
      quote: quoteResult ?? undefined,
      budgetCapUsd: form.budgetCapUsd,
      // Unlimited (default) resolves to undefined — spread-omitted so the
      // contract carries no maxDurationMs key at all, matching this field's
      // "absent -> unlimited, no behavior change" contract (types.ts).
      ...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
      proofs,
      // Root-cause fix (2026-08-02 zone audit — "review missions never
      // resolve despite 'Merge : auto si vert'"): this used to hardcode
      // humanApprove: true unconditionally, which approveGate.ts's
      // evaluateAutoMerge treats as an explicit PER-MISSION opt-out that
      // always wins over the project's own approval mode (by design — see
      // its own doc comment). With no UI toggle in this modal to ever set
      // it any other way, EVERY mission created through this normal launch
      // path silently opted itself out of auto-merge, making a project
      // configured for auto_green/full_auto permanently inert. false here
      // restores the safety matrix's real gate (judge verdict + proofs,
      // still enforced by checkApproveGate/evaluateAutoMerge) as the actual
      // decision-maker instead of this hardcoded floor.
      gates: { evaluators: true, humanApprove: false },
      shareToTeam: false,
    };
  }, [form, scopePaths, quoteResult]);

  const runningMissions = useMemo(
    () => missions.filter((m) => m.status === 'running'),
    [missions],
  );

  // Conflict pre-flight notice (T1.6, spec §7.2) — non-blocking: informs
  // the user upfront that this mission's declared scope overlaps a
  // currently running one, so an auto-sequenced-behind-it outcome is never
  // a surprise. Purely informational: the scheduler (scheduler.ts's
  // dispatch(), wired separately) re-runs the SAME preflight.ts check
  // against its own live running set at actual launch time and is what
  // really decides the auto-sequencing — this effect never blocks submit.
  // (conflictTitles/setConflictTitles declared earlier, alongside
  // quoteResult/preflight, so the reset-on-open effect can clear it too.)
  useEffect(() => {
    if (!isOpen || scopePaths.length === 0 || runningMissions.length === 0) {
      setConflictTitles([]); // eslint-disable-line react-hooks/set-state-in-effect
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      const candidate: Mission = {
        id: '__nm-preview__',
        title: form.title,
        status: 'queued',
        model: form.modelId,
        contract: buildContract(),
      };

      checkConflicts(candidate, runningMissions)
        .then(({ conflictsWith }) => {
          if (cancelled) return;
          const titles = conflictsWith.map(
            (id) => runningMissions.find((m) => m.id === id)?.title ?? id,
          );
          setConflictTitles(titles);
        })
        .catch(() => {
          if (!cancelled) setConflictTitles([]);
        });
    }, QUOTE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isOpen, scopePaths, runningMissions, buildContract, form.title, form.modelId]);

  const handleSubmit = useCallback(() => {
    if (!form.title.trim()) {
      setTitleError(true);
      firstInputRef.current?.focus();
      return;
    }

    // Engine preflight — never launch a mission into a void (v0.1.5 W2.2).
    // BUG-4: pass the model actually selected for this launch so a native
    // CLI-backed pick never gets false-blocked by a global mode that
    // happens to be pro/managed with an empty wallet.
    const readiness = getEngineReadiness(undefined, form.modelId);
    if (!readiness.ready && readiness.reason) {
      setPreflight(readiness);
      return;
    }
    setPreflight(null);

    // Resolve the label from the id's OWN catalog membership, not from the
    // currently resolved provider mode — the dropdown can now offer BOTH
    // catalogs at once (see pickerOptions above), so form.modelId may be an
    // OpenRouter id even while accessMode privileges CLI/BYOK for routing.
    // Mirrors Composer.tsx's handleModelSelect, which distinguishes the two
    // id families the same way (OpenRouter ids always carry a '/').
    const orModel = OPENROUTER_MODELS.find(m => m.id === form.modelId);
    const nativeModel = ALL_MODELS.find(m => m.id === form.modelId);
    const modelLabel = orModel ? orModel.id : (nativeModel ?? DEFAULT_MODEL).label;

    // T1.2 note: NewMissionInput (agentsStore.tsx, out of scope for this
    // task) has no `contract` field, and addMission's current
    // implementation copies known input fields one by one onto the Mission
    // it creates rather than spreading the whole input object — so
    // `contract` does not yet reach the persisted Mission. Attaching it
    // here via this widened local type is forward-compatible plumbing: the
    // object addMission receives DOES carry `.contract` on the wire; the
    // day addMission is updated to read/forward it, this wiring needs no
    // change on this side. See the T1.2 task report for the full
    // rationale (this was flagged upfront as a possible outcome given the
    // file-ownership split across the wave's parallel tasks).
    const missionInput: NewMissionInput & { contract?: MissionContract } = {
      title: form.title.trim(),
      description: form.description.trim() || undefined,
      agentTask: form.agentPrompt.trim() || form.title.trim(),
      // Real filesystem path, NOT form.repo (a display basename like 'alpha'
      // derived from it for the <select> — see repoName above). createWorktree
      // resolves relative to Rust's project-root jail; a bare basename gets
      // correctly rejected as outside that jail, silently crippling the
      // mission (root cause proven via instrumented run: get_project_root
      // timing out under contention made resolveProjectRoot fall back to
      // this same field). Falls back to form.repo only in the defensive case
      // projectRoot itself is unset (empty string default, see AppContext).
      repo: projectRoot || form.repo,
      worktree: deriveWorktree(form.title),
      modelLabel,
      orchestrator: form.orchestrator,
      permissionMode: form.permissionMode,
      contract: buildContract(),
      effort: form.effort === 'off' ? undefined : form.effort,
    };
    addMission(missionInput);
    onClose();
  }, [form, addMission, onClose, buildContract, projectRoot]);

  const goConfigureEngine = useCallback(() => {
    // Existing deep-link mechanism: space id 'models' renders SettingsSpace
    // with initialTab="models" (see AppShell.SpaceContent).
    emit('nav:navigateSpace', 'models');
    onClose();
  }, [onClose]);

  const goPro = useCallback(() => {
    // Same mechanism: space id 'account' -> SettingsSpace initialTab="account".
    emit('nav:navigateSpace', 'account');
    onClose();
  }, [onClose]);

  if (!isOpen) return null;

  const worktreePreview = deriveWorktree(form.title);
  const showProAction =
    preflight?.reason === 'pro-inactive' || preflight?.reason === 'pro-no-credits';

  return createPortal(
    <div
      role="presentation"
      style={S.backdrop}
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('agents.modal.title')}
        style={S.modal}
      >
        {/* Header */}
        <div style={S.header}>
          <span style={S.headerTitle}>{t('agents.modal.title')}</span>
          <button
            aria-label={t('agents.modal.close')}
            onClick={onClose}
            style={S.closeBtn}
          >
            ×
          </button>
        </div>

        <div style={S.divider} />

        {/* Body */}
        <div style={S.body}>
          {/* Title */}
          <div style={S.fieldGroup}>
            <label htmlFor="nm-title" style={S.label}>
              {t('agents.modal.labelTitle')} <span style={S.required}>*</span>
            </label>
            <input
              ref={firstInputRef}
              id="nm-title"
              type="text"
              value={form.title}
              onChange={e => updateField('title', e.target.value)}
              placeholder={t('agents.modal.titlePlaceholder')}
              style={{
                ...S.input,
                ...(titleError ? S.inputError : {}),
              }}
              aria-required="true"
              aria-invalid={titleError}
              aria-describedby={titleError ? 'nm-title-err' : undefined}
            />
            {titleError && (
              <span id="nm-title-err" style={S.errorMsg} role="alert">
                {t('agents.modal.titleRequired')}
              </span>
            )}
          </div>

          {/* Description */}
          <div style={S.fieldGroup}>
            <label htmlFor="nm-desc" style={S.label}>
              {t('agents.modal.labelDescription')}
            </label>
            <textarea
              id="nm-desc"
              value={form.description}
              onChange={e => updateField('description', e.target.value)}
              placeholder={t('agents.modal.descriptionPlaceholder')}
              rows={3}
              style={S.textarea}
            />
          </div>

          {/* Agent prompt / task */}
          <div style={S.fieldGroup}>
            <label htmlFor="nm-prompt" style={S.label}>
              {t('agents.modal.labelAgentPrompt')}
            </label>
            <textarea
              id="nm-prompt"
              value={form.agentPrompt}
              onChange={e => updateField('agentPrompt', e.target.value)}
              placeholder={t('agents.modal.agentPromptPlaceholder')}
              rows={5}
              style={S.textarea}
            />
            {/* Task-selection guardrail (G8) — discreet warning, never
                blocking: informs the user this task may not suit an
                autonomous agent loop before they launch it. */}
            {showMissionFitBanner && missionFitVerdict && (
              <span data-testid="mission-fit-banner" style={S.warnMsg}>
                {t('agents.modal.missionFitWarning')} {missionFitVerdict.reason} {missionFitVerdict.suggestion}
              </span>
            )}
          </div>

          {/* Repo + worktree preview */}
          <div style={S.fieldGroup}>
            <label htmlFor="nm-repo" style={S.label}>
              {t('agents.modal.labelRepo')}
            </label>
            <select
              id="nm-repo"
              value={form.repo}
              onChange={e => updateField('repo', e.target.value)}
              style={S.select}
            >
              {repos.map(r => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            {worktreePreview && (
              <span style={S.hint}>
                {t('agents.modal.worktreeHint')} <code style={S.code}>{worktreePreview}</code>
              </span>
            )}
          </div>

          {/* Scope paths — pre-flight conflict detection + non-dev lanes
              (spec §7.2/§7.3/§8's MissionContract.scopePaths). Optional;
              feeds both the live quote below and the launch contract. */}
          <div style={S.fieldGroup}>
            <label htmlFor="nm-scope-paths" style={S.label}>
              {t('agents.modal.labelScopePaths')}
            </label>
            <textarea
              id="nm-scope-paths"
              value={form.scopePathsRaw}
              onChange={e => updateField('scopePathsRaw', e.target.value)}
              placeholder={t('agents.modal.scopePathsPlaceholder')}
              rows={2}
              style={S.textarea}
            />
            {/* Conflict pre-flight notice (T1.6, spec §7.2) — non-blocking:
                the scheduler will still launch this mission, just behind
                whichever running mission(s) it overlaps. */}
            {conflictTitles.length > 0 && (
              <span data-testid="mission-conflict-notice" style={S.warnMsg}>
                {t('agents.modal.conflictNotice', { titles: conflictTitles.join(', ') })}
              </span>
            )}
          </div>

          {/* Model — grouped by entitlement (Claude subscription vs
              LazyPro/Managé) so a user holding both sees both catalogs
              together; disabled with guidance when neither is entitled. */}
          <div style={S.fieldGroup}>
            <label htmlFor="nm-model" style={S.label}>
              {t('agents.modal.labelModel')}
            </label>
            <select
              id="nm-model"
              value={form.modelId}
              onChange={e => updateField('modelId', e.target.value)}
              disabled={!pickerOptions.hasOptions}
              style={S.select}
            >
              {pickerOptions.groups.map(group => (
                <optgroup key={group.id} label={group.label}>
                  {group.models.map(m => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                      {m.description ? ` — ${m.description}` : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {!pickerOptions.hasOptions && (
              <span style={S.warnMsg}>
                {pickerOptions.emptyReadiness?.reason
                  ? t(engineReasonKey(pickerOptions.emptyReadiness.reason))
                  : pickerOptions.codexManaged
                    ? modelManagedByCodexMessage(t)
                    : noModelFallbackMessage(t)}
              </span>
            )}
            {pickerOptions.hasOptions && pickerOptions.proExhausted && (
              <span style={S.hint}>{t(engineReasonKey('pro-no-credits'))}</span>
            )}
          </div>

          {/* Reasoning effort — only shown when the selected model supports
              reasoning (OpenRouter catalog's `reasoning` flag). 'off' disables
              it; 'low'/'medium'/'high' control the model's reasoning depth. */}
          {(() => {
            const orModel = findOpenRouterModel(form.modelId);
            const supportsReasoning = orModel?.reasoning === true;
            if (!supportsReasoning) return null;
            const EFFORT_OPTIONS: Array<{ value: 'off' | ReasoningEffort; label: string }> = [
              { value: 'off', label: t('agents.modal.effort.off') },
              { value: 'low', label: t('agents.modal.effort.low') },
              { value: 'medium', label: t('agents.modal.effort.medium') },
              { value: 'high', label: t('agents.modal.effort.high') },
              ...(orModel?.maxEffort ? [{ value: 'max' as const, label: t('agents.modal.effort.max') }] : []),
            ];
            return (
              <div style={S.fieldGroup}>
                <span style={S.label}>{t('agents.modal.labelEffort')}</span>
                <div style={S.segmented} role="radiogroup" aria-label={t('agents.modal.labelEffort')}>
                  {EFFORT_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={form.effort === opt.value}
                      onClick={() => updateField('effort', opt.value)}
                      style={{
                        ...S.segmentBtn,
                        ...(form.effort === opt.value ? S.segmentBtnActive : {}),
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <span style={S.hint}>{t('agents.modal.effortHint')}</span>
              </div>
            );
          })()}

          {/* Live pre-launch quote (spec §7.3) — debounced QUOTE_DEBOUNCE_MS
              after the last relevant change; hidden until the task text is
              non-empty.

              Fix D (2026-08-19 dollar-kill incident, display half) — credits
              (usdToCredits), never €/$: the previous "~X-Y €" wording spoke
              in currency regardless of which rail the chosen model would
              actually route to, the exact "owner's standing rule" defect
              this modal's own header comment on estimatedCreditsByModel
              already documents for the manager's plan-proposal card
              (types.ts). A native-rail pick (classifyMissionModel ===
              'native') gets an explicit non-debited-equivalent qualifier;
              every other rail (managed/byok) shows the same credits figure
              as a real-spend estimate, unqualified. */}
          {(quoteComputing || quoteResult) && (
            <div style={S.fieldGroup}>
              <span data-testid="mission-quote-line" style={S.hint}>
                {quoteResult
                  ? t(
                      // 'devin' bills the user's own Devin account, never
                      // Lazy credits — same non-debited qualifier as native.
                      ['native', 'devin'].includes(classifyMissionModel(form.modelId) ?? '')
                        ? 'agents.modal.quote.lineNative'
                        : 'agents.modal.quote.line',
                      {
                        creditsLo: String(usdToCredits(quoteResult.costUsd[0])),
                        creditsHi: String(usdToCredits(quoteResult.costUsd[1])),
                        durLo: String(quoteResult.durationMin[0]),
                        durHi: String(quoteResult.durationMin[1]),
                        agents: String(quoteResult.agents),
                      },
                    )
                  : t('agents.modal.quote.computing')}
              </span>
            </div>
          )}

          {/* Budget cap — prefilled from the quote's default (3x cost upper
              bound) until the user edits it directly; 0 = no cap.

              Fix D — the field shows/accepts CREDITS (usdToCredits of the
              internal USD value; handleBudgetCapChange converts back on
              input) — see that handler's own doc comment for why the
              internal MissionContract.budgetCapUsd field itself stays USD.
              On the native rail this is purely an informational effort cap
              (runtime.ts's checkNativeBudget no longer stops a mission on
              it — see NATIVE_DEFAULT_MAX_DURATION_MS for the real runaway
              guard on that rail); the hint below says so. */}
          <div style={S.fieldGroup}>
            <label htmlFor="nm-budget-cap" style={S.label}>
              {t('agents.modal.labelBudgetCap')}
            </label>
            <input
              id="nm-budget-cap"
              type="number"
              min={0}
              step="10"
              value={usdToCredits(form.budgetCapUsd)}
              onChange={e => handleBudgetCapChange(e.target.value)}
              style={S.input}
            />
            <span style={S.hint}>
              {['native', 'devin'].includes(classifyMissionModel(form.modelId) ?? '')
                ? t('agents.modal.budgetCapHintNative')
                : t('agents.modal.budgetCapHint')}
            </span>
          </div>

          {/* Duration cap (W-GUARD UI) — mirrors the budget cap field's
              presentation exactly; 'unlimited' (default) writes nothing to
              the contract, see resolveMaxDurationMs. */}
          <div style={S.fieldGroup}>
            <label htmlFor="nm-duration-cap" style={S.label}>
              {t('agents.modal.labelDurationCap')}
            </label>
            <select
              id="nm-duration-cap"
              value={form.maxDurationOption}
              onChange={e => updateField('maxDurationOption', e.target.value as DurationOptionId)}
              style={S.select}
            >
              {DURATION_OPTIONS.map(opt => (
                <option key={opt.id} value={opt.id}>
                  {t(`agents.modal.duration.${opt.id}`)}
                </option>
              ))}
            </select>
            <span style={S.hint}>{t('agents.modal.durationCapHint')}</span>
          </div>

          {/* Proof requirements — required to reach Done (spec §8's
              proof-of-work gate, enforced by T1.4's approveGate.ts). */}
          <div style={S.fieldGroup}>
            <span style={S.label}>{t('agents.modal.labelProofs')}</span>
            <div style={S.checkboxRow}>
              {PROOF_CHECKBOX_KINDS.map((kind) => (
                <label key={kind} style={S.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={form.proofs[kind]}
                    onChange={() => toggleProof(kind)}
                  />
                  {t(`agents.modal.proof.${kind}`)}
                </label>
              ))}
            </div>
          </div>

          {/* Autonomy — segmented control mapped to the runtime's real
              permissionMode values (the old Ask/Plan/Edit/Agent row was
              captured but never honored — removed in v0.1.5 W2.6). */}
          <div style={S.fieldGroup}>
            <span style={S.label}>{t('agents.modal.labelAutonomy')}</span>
            <div style={S.segmented} role="radiogroup" aria-label={t('agents.modal.autonomyAriaLabel')}>
              {PERMISSION_MODE_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={form.permissionMode === id}
                  onClick={() => updateField('permissionMode', id)}
                  style={{
                    ...S.segmentBtn,
                    ...(form.permissionMode === id ? S.segmentBtnActive : {}),
                  }}
                >
                  {t(`agents.modal.autonomy.${id}`)}
                </button>
              ))}
            </div>
            <span style={S.hint}>
              {t(`agents.modal.autonomy.${form.permissionMode}.desc`)}
            </span>
            {form.permissionMode === 'full' && (
              <span style={S.warnMsg}>
                {t('agents.modal.permFullWarning')}
              </span>
            )}
          </div>

          {/* Orchestrator toggle */}
          <div style={S.toggleRow}>
            <div>
              <div style={S.toggleLabel}>{t('agents.modal.orchestratorLabel')}</div>
              {form.orchestrator && (
                <div style={S.toggleSubtext}>
                  {t('agents.modal.orchestratorSubtext')}
                </div>
              )}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={form.orchestrator}
              aria-label={t('agents.modal.orchestratorAriaLabel')}
              onClick={() => updateField('orchestrator', !form.orchestrator)}
              style={{
                ...S.toggle,
                ...(form.orchestrator ? S.toggleOn : {}),
              }}
            >
              <span
                style={{
                  ...S.toggleThumb,
                  ...(form.orchestrator ? S.toggleThumbOn : {}),
                }}
              />
            </button>
          </div>

        </div>

        <div style={S.divider} />

        {/* Engine preflight panel — shown when the last submit was blocked */}
        {preflight?.reason && (
          <div data-testid="mission-preflight-panel" role="alert" style={S.preflightPanel}>
            <span style={S.preflightText}>{t(engineReasonKey(preflight.reason))}</span>
            <div style={S.preflightActions}>
              <button
                type="button"
                data-testid="preflight-configure"
                onClick={goConfigureEngine}
                style={S.preflightBtn}
              >
                {t('engine.preflight.configure')}
              </button>
              {showProAction && (
                <button
                  type="button"
                  data-testid="preflight-go-pro"
                  onClick={goPro}
                  style={S.preflightBtnPrimary}
                >
                  {t('engine.preflight.goPro')}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Footer */}
        <div style={S.footer}>
          <button type="button" onClick={onClose} style={S.cancelBtn}>
            {t('agents.modal.cancel')}
          </button>
          <button type="button" onClick={handleSubmit} style={S.submitBtn}>
            {t('agents.modal.submit')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Styles ────────────────────────────────────────────────────────

const S = {
  backdrop: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(5, 5, 10, 0.75)',
    backdropFilter: 'blur(5px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9998,
    padding: '16px',
  },
  modal: {
    width: 540,
    maxWidth: 'calc(100vw - 32px)',
    maxHeight: 'calc(100vh - 32px)',
    background: '#16161D',
    border: '1px solid rgba(124, 92, 255, 0.3)',
    borderRadius: 12,
    boxShadow: '0 32px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(124,92,255,0.12)',
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 20px',
    flexShrink: 0,
  },
  headerTitle: {
    fontSize: 15,
    fontWeight: 600,
    color: '#E2E2F0',
    letterSpacing: '0.01em',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: 'rgba(255,255,255,0.4)',
    cursor: 'pointer',
    fontSize: 20,
    lineHeight: 1,
    padding: '2px 6px',
    borderRadius: 4,
  },
  divider: {
    height: 1,
    background: 'rgba(255,255,255,0.07)',
    flexShrink: 0,
  },
  body: {
    padding: '20px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 16,
    overflowY: 'auto' as const,
    flex: 1,
  },
  fieldGroup: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
  },
  label: {
    fontSize: 12,
    fontWeight: 600,
    color: 'rgba(255,255,255,0.55)',
    letterSpacing: '0.02em',
  },
  required: {
    color: '#7C5CFF',
  },
  input: {
    background: '#0E0E12',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 7,
    padding: '9px 12px',
    fontSize: 13,
    color: '#E6E8EF',
    fontFamily: 'inherit',
    outline: 'none',
    transition: 'border-color 0.15s',
    width: '100%',
  },
  // F10 fix (post-e2e wave): was `borderColor` alone, which — spread after
  // `input`'s `border` shorthand (see the `style={{...S.input, ...(titleError
  // ? S.inputError : {})}}` call site) — mixed a shorthand (`border`) and a
  // longhand (`borderColor`) property in the SAME final style object. React
  // warns "Updating a style property during rerender (border) when a
  // conflicting property is set (borderColor) can lead to styling bugs."
  // Overriding with the full `border` shorthand instead keeps both objects
  // on the same property name — same visual result, no console warning.
  inputError: {
    border: '1px solid rgba(239, 68, 68, 0.6)',
  },
  errorMsg: {
    fontSize: 11,
    color: '#F87171',
  },
  warnMsg: {
    fontSize: 11,
    color: '#FBBF24',
  },
  textarea: {
    background: '#0E0E12',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 7,
    padding: '9px 12px',
    fontSize: 13,
    color: '#E6E8EF',
    fontFamily: 'inherit',
    outline: 'none',
    resize: 'vertical' as const,
    lineHeight: 1.5,
    width: '100%',
    minHeight: 72,
  },
  select: {
    background: '#0E0E12',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 7,
    padding: '9px 12px',
    fontSize: 13,
    color: '#E6E8EF',
    fontFamily: 'inherit',
    outline: 'none',
    width: '100%',
    cursor: 'pointer',
    appearance: 'auto' as const,
  },
  hint: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.35)',
  },
  checkboxRow: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 14,
  },
  checkboxLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    color: 'rgba(255,255,255,0.75)',
    cursor: 'pointer',
  },
  code: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    color: '#A78BFF',
  },
  segmented: {
    display: 'flex',
    background: '#0E0E12',
    borderRadius: 8,
    border: '1px solid rgba(255,255,255,0.08)',
    padding: 2,
    gap: 2,
  },
  segmentBtn: {
    flex: 1,
    padding: '6px 8px',
    borderRadius: 6,
    border: 'none',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 500,
    fontFamily: 'inherit',
    lineHeight: 1.3,
    background: 'transparent',
    color: 'rgba(255,255,255,0.45)',
    transition: 'background 0.15s, color 0.15s',
    whiteSpace: 'nowrap' as const,
  },
  segmentBtnActive: {
    background: '#7C5CFF',
    color: '#fff',
  },
  toggleRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '10px 14px',
    borderRadius: 8,
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.07)',
  },
  toggleLabel: {
    fontSize: 13,
    fontWeight: 500,
    color: '#E2E2F0',
  },
  toggleSubtext: {
    fontSize: 11,
    color: '#A78BFF',
    marginTop: 2,
  },
  toggle: {
    position: 'relative' as const,
    width: 42,
    height: 24,
    borderRadius: 12,
    border: 'none',
    cursor: 'pointer',
    background: 'rgba(255,255,255,0.12)',
    flexShrink: 0,
    transition: 'background 0.2s',
    padding: 0,
  },
  toggleOn: {
    background: '#7C5CFF',
  },
  toggleThumb: {
    position: 'absolute' as const,
    top: 3,
    left: 3,
    width: 18,
    height: 18,
    borderRadius: '50%',
    background: 'rgba(255,255,255,0.6)',
    transition: 'left 0.2s, background 0.2s',
  },
  toggleThumbOn: {
    left: 21,
    background: '#fff',
  },
  preflightPanel: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
    margin: '12px 20px 0',
    padding: '12px 14px',
    borderRadius: 8,
    background: 'rgba(251,185,36,0.08)',
    border: '1px solid rgba(251,185,36,0.3)',
    flexShrink: 0,
  },
  preflightText: {
    fontSize: 12,
    lineHeight: 1.5,
    color: '#FBB924',
  },
  preflightActions: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap' as const,
  },
  preflightBtn: {
    padding: '6px 14px',
    borderRadius: 7,
    border: '1px solid rgba(124,92,255,0.4)',
    background: 'rgba(124,92,255,0.12)',
    color: '#C4B5FD',
    fontSize: 12,
    fontWeight: 500,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  preflightBtnPrimary: {
    padding: '6px 14px',
    borderRadius: 7,
    border: 'none',
    background: '#7C5CFF',
    color: '#fff',
    fontSize: 12,
    fontWeight: 600,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 10,
    padding: '14px 20px',
    flexShrink: 0,
  },
  cancelBtn: {
    padding: '8px 18px',
    borderRadius: 7,
    border: '1px solid rgba(255,255,255,0.12)',
    background: 'transparent',
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
    fontWeight: 500,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  submitBtn: {
    padding: '8px 20px',
    borderRadius: 7,
    border: 'none',
    background: '#7C5CFF',
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
} as const;
