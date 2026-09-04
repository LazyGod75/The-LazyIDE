/* CustomRulesPanel.tsx — User-defined autonomy rules UI (Pillar C4).

   Duplicate-heading fix (real user report, 2026-08-14): this used to render
   its own "Custom Rules" <h3> directly under CockpitRailPopover's own
   "CUSTOM RULES" title — same redundant-nesting bug FleetMap.tsx/
   DecisionCenter.tsx already had fixed (see FleetMap.tsx's header comment:
   "the popover chrome IS the heading"). No heading rendered here now.

   Authoring-defects fix (real user report, 2026-08-15): the raw-JSON
   textarea is a deliberate, scoped-down authoring mechanism (a full visual
   rule builder is a separate product decision, not made here — see the
   PR description), but its feedback loop had five concrete bugs fixed in
   this pass:
    1. Contradictory empty state — "No custom rules" used to render
       unconditionally whenever `rules` was empty, even while the textarea
       held real unsaved text. The textarea's example JSON is a genuine
       HTML `placeholder` (never `value`), so it was never actually a
       contradiction for the *placeholder* case — but real typed-and-not-
       yet-saved input hit the same wrong copy. `hasUnsavedDraft` below now
       distinguishes "nothing typed, showing the placeholder example" from
       "something real is typed but not saved yet", and the placeholder
       itself gets an explicit, unmistakably-dimmer style so it can never
       be mistaken for saved content even before this fix.
    2. No validation feedback — `parseRules` (customRules.ts) is lenient by
       design (silently drops anything malformed). This panel now runs the
       strict `validateRulesInput` live on every keystroke and renders
       every problem found next to the editor; the Save path refuses to
       persist anything while errors exist (button disabled + defensive
       check in the handler), so a malformed batch can never overwrite the
       last-good rules.
    3. "Parse" renamed to "Save Rules" (developer jargon for what is, to
       the user, "apply/save my rules"), plus an explicit saved/unsaved
       indicator so it's always obvious whether the rail is running the
       rules currently visible in the editor.
    4. Import added, symmetric with the pre-existing Export — reads a
       dropped/selected JSON file back into the editor (not auto-applied;
       still goes through the same validate-then-Save path as pasted text).
    5. Bottom-content clipping — investigated and NOT this panel's own
       layout: the root here is an unconstrained `space-y-3` block with no
       fixed height or `overflow` of its own, so the clipping reported
       against the "Condition syntax" hint comes from the shared
       CockpitRailPopover shell's height measurement (see that file's own
       "Size-to-content fix" header comment, already being fixed there —
       not touched by this change). */

import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useI18n } from '../../../i18n';
import {
  validateRulesInput,
  type CustomRule,
  type RuleValidationError,
} from '../../../lib/agents/customRules';

type Translate = (key: string, params?: Record<string, string | number>) => string;

function formatValidationError(t: Translate, error: RuleValidationError): string {
  switch (error.type) {
    case 'invalidJson':
      return t('cockpit.rules.error.invalidJson', { message: error.message });
    case 'notArray':
      return t('cockpit.rules.error.notArray');
    case 'notObject':
      return t('cockpit.rules.error.notObject', { index: error.index + 1 });
    case 'unknownField':
      return t('cockpit.rules.error.unknownField', { index: error.index + 1, field: error.field });
    case 'missingId':
      return t('cockpit.rules.error.missingId', { index: error.index + 1 });
    case 'missingCondition':
      return t('cockpit.rules.error.missingCondition', { index: error.index + 1 });
    case 'unknownCondition':
      return t('cockpit.rules.error.unknownCondition', { index: error.index + 1, clause: error.clause });
    case 'invalidAction':
      return t('cockpit.rules.error.invalidAction', { index: error.index + 1 });
    case 'invalidMessage':
      return t('cockpit.rules.error.invalidMessage', { index: error.index + 1 });
    default:
      return error satisfies never;
  }
}

export function CustomRulesPanel() {
  const { t } = useI18n();
  const [rules, setRules] = useState<CustomRule[]>([]);
  const [input, setInput] = useState('');
  const [savedInput, setSavedInput] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const validation = useMemo(() => validateRulesInput(input), [input]);
  const hasErrors = validation.errors.length > 0;
  const hasUnsavedChanges = input !== savedInput;
  const hasUnsavedDraft = rules.length === 0 && input.trim().length > 0 && !hasErrors;

  function handleSave() {
    if (hasErrors) return; // defensive — Save is also disabled while invalid
    setRules(validation.rules);
    setSavedInput(input);
  }

  function handleDelete(id: string) {
    setRules(rules.filter((r) => r.id !== id));
  }

  function handleExport() {
    const blob = new Blob([JSON.stringify(rules, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'custom-rules.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleImportClick() {
    fileInputRef.current?.click();
  }

  function handleImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-importing the same filename later
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setInput(reader.result);
    };
    reader.readAsText(file);
  }

  return (
    <div className="p-4 space-y-3">
      {rules.length === 0 && !hasUnsavedDraft && (
        <p className="text-xs text-slate-500">{t('cockpit.rules.empty')}</p>
      )}
      {hasUnsavedDraft && <p className="text-xs text-amber-400">{t('cockpit.rules.unsavedDraft')}</p>}
      {rules.map((r) => (
        <div key={r.id} className="p-3 rounded bg-slate-800/60 space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono text-slate-300">{r.condition}</span>
            <button
              type="button"
              onClick={() => handleDelete(r.id)}
              className="text-xs text-red-400 hover:text-red-300"
            >
              {t('cockpit.rules.delete')}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-xs px-1.5 py-0.5 rounded ${actionColor(r.action)}`}>
              {r.action}
            </span>
            {r.message && <span className="text-xs text-slate-400">{r.message}</span>}
          </div>
        </div>
      ))}
      <textarea
        placeholder='[{"id":"r1","condition":"action=launch_mission and credits>100","action":"ask","message":"High-cost mission"}]'
        value={input}
        onChange={(e) => setInput(e.target.value)}
        rows={4}
        className="w-full text-xs bg-slate-900 text-slate-200 rounded px-2 py-1 border border-slate-700 font-mono placeholder:text-slate-600 placeholder:italic"
      />
      {hasErrors && (
        <ul className="text-xs text-red-400 space-y-0.5">
          {validation.errors.map((err, i) => (
            <li key={i}>{formatValidationError(t, err)}</li>
          ))}
        </ul>
      )}
      {!hasErrors && hasUnsavedChanges && rules.length > 0 && (
        <p className="text-xs text-amber-400">{t('cockpit.rules.unsavedChanges')}</p>
      )}
      <div className="flex gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          onChange={handleImportFile}
          className="hidden"
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={hasErrors}
          className="text-xs px-3 py-1 rounded bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50"
        >
          {t('cockpit.rules.save')}
        </button>
        <button
          type="button"
          onClick={handleImportClick}
          className="text-xs px-3 py-1 rounded bg-slate-800 text-slate-200 hover:bg-slate-700 border border-slate-700"
        >
          {t('cockpit.rules.import')}
        </button>
        <button
          type="button"
          onClick={handleExport}
          disabled={rules.length === 0}
          className="text-xs px-3 py-1 rounded bg-slate-800 text-slate-200 hover:bg-slate-700 border border-slate-700 disabled:opacity-50"
        >
          {t('cockpit.rules.export')}
        </button>
      </div>
      <p className="text-xs text-slate-500">
        {t('cockpit.rules.conditionSyntaxLabel')}{' '}
        <code className="text-slate-400">action=launch_mission and credits&gt;100</code>
      </p>
    </div>
  );
}

function actionColor(action: CustomRule['action']): string {
  if (action === 'allow') return 'bg-green-900/60 text-green-300';
  if (action === 'deny') return 'bg-red-900/60 text-red-300';
  return 'bg-amber-900/60 text-amber-300';
}
