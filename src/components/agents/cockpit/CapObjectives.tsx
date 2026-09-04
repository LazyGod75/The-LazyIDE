/* CapObjectives — "CAP — TES OBJECTIFS" block (design §6, D6): objective
   cards + inline "+ Fixer un cap" creation form. Honest empty state when
   there are none yet — no seeded/fake objectives. */

import { useEffect, useState } from 'react';
import { useI18n } from '../../../i18n';
import {
  addObjective,
  deleteObjective,
  ensureObjectivesLoaded,
  getObjectives,
  subscribeObjectives,
  updateObjective,
  type Objective,
} from '../../../lib/objectives/objectivesStore';
import { ObjectiveCard } from './ObjectiveCard';
import { useObjectivesAutoProgress } from '../../../lib/objectives/useObjectivesAutoProgress';
import type { FleetProject } from '../../../lib/agents/fleetMissions';

interface CreateFormState {
  title: string;
  deadline: string;
  target: string;
  projectId: string;
}

const EMPTY_FORM: CreateFormState = { title: '', deadline: '', target: '', projectId: '' };

interface CapObjectivesProps {
  projects: FleetProject[];
  onRequestRecoveryPlan: (objective: Objective) => void;
  onHoverObjective: (objective: Objective | null) => void;
  /** Screenshot/test-only seam — see Cockpit.tsx's CockpitProps doc comment
   *  and src/__screenshots__/cockpit-harness.tsx. When provided, replaces
   *  the real objectivesStore subscription so the harness can render fixed
   *  fixture objectives without a Tauri-backed project on disk. */
  objectivesOverride?: Objective[];
}

export function CapObjectives({ projects, onRequestRecoveryPlan, onHoverObjective, objectivesOverride }: CapObjectivesProps) {
  const { t } = useI18n();
  const [objectives, setObjectives] = useState<Objective[]>(objectivesOverride ?? getObjectives);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<CreateFormState>(EMPTY_FORM);

  useEffect(() => {
    if (objectivesOverride) {
      // Screenshot/test-only branch — syncs the harness's fixture array
      // into local state on the rare occasion its reference changes
      // (never in practice: the harness passes one stable module-level
      // constant for its whole lifetime). Real app code never reaches
      // this branch, so it's not the "external subscription" the
      // set-state-in-effect rule is guarding against below.
      setObjectives(objectivesOverride); // eslint-disable-line react-hooks/set-state-in-effect -- one-shot fixture sync, see comment above
      return;
    }
    void ensureObjectivesLoaded();
    return subscribeObjectives(setObjectives);
  }, [objectivesOverride]);

  // B9: keeps project-linked objectives' currentCount in sync with real
  // MERGED missions for their project. No-ops for the screenshot harness's
  // fixture objectives (objectivesOverride) since journalQuery fails soft
  // to [] for a projectId that isn't a real open project.
  useObjectivesAutoProgress(objectives);

  async function handleCreate() {
    const title = form.title.trim();
    if (!title) return;
    await addObjective({
      title,
      deadlineMs: form.deadline ? new Date(form.deadline).getTime() : null,
      targetCount: form.target ? Number(form.target) : null,
      projectId: form.projectId || null,
    });
    setForm(EMPTY_FORM);
    setShowForm(false);
  }

  async function handleShift(objective: Objective, newDeadlineMs: number) {
    await updateObjective(objective.id, { deadlineMs: newDeadlineMs });
  }

  async function handleOverrideCount(objective: Objective, newCount: number) {
    await updateObjective(objective.id, { currentCount: newCount, manualOverride: true });
  }

  async function handleResumeAuto(objective: Objective) {
    await updateObjective(objective.id, { manualOverride: false });
  }

  return (
    <div
      style={{
        background: 'var(--color-panel)',
        borderBottom: '1px solid var(--color-border)',
        padding: '14px 28px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: 1.8, color: 'var(--color-text-muted)' }}>
          {t('cockpit.cap.title')}
        </span>
        <button
          data-testid="cap-add-toggle"
          onClick={() => setShowForm((v) => !v)}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--color-accent-pale)',
            fontSize: 13,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {t('cockpit.cap.addLink')}
        </button>
      </div>

      {showForm && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            alignItems: 'center',
            background: 'var(--color-panel-2)',
            border: '1px solid rgba(255,255,255,0.09)',
            borderRadius: 10,
            padding: 10,
          }}
        >
          <input
            data-testid="cap-form-title"
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            placeholder={t('cockpit.cap.formTitlePlaceholder')}
            style={inputStyle}
          />
          <input
            type="date"
            value={form.deadline}
            onChange={(e) => setForm((f) => ({ ...f, deadline: e.target.value }))}
            style={{ ...inputStyle, width: 150 }}
          />
          <input
            type="number"
            min={1}
            value={form.target}
            onChange={(e) => setForm((f) => ({ ...f, target: e.target.value }))}
            placeholder={t('cockpit.cap.formTargetPlaceholder')}
            style={{ ...inputStyle, width: 110 }}
          />
          <select
            value={form.projectId}
            onChange={(e) => setForm((f) => ({ ...f, projectId: e.target.value }))}
            style={{ ...inputStyle, width: 160 }}
          >
            <option value="">{t('cockpit.cap.formNoProject')}</option>
            {projects.map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            data-testid="cap-form-submit"
            onClick={() => void handleCreate()}
            disabled={!form.title.trim()}
            style={{
              background: 'var(--color-accent)',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              padding: '7px 14px',
              fontSize: 13,
              fontWeight: 700,
              cursor: form.title.trim() ? 'pointer' : 'default',
              opacity: form.title.trim() ? 1 : 0.5,
              fontFamily: 'inherit',
            }}
          >
            {t('cockpit.cap.formSubmit')}
          </button>
        </div>
      )}

      {objectives.length === 0 ? (
        // fix/canvas-legibility — defensive `pointerEvents: 'none'`: this
        // banner contains no interactive element, so this can never break
        // anything, and it eliminates any future possibility of this div
        // intercepting a click meant for the canvas underneath if a
        // positioning regression reappears (Cockpit.layout.test.tsx already
        // regression-tests the underlying viewport race that historically
        // caused this — see that test file for the real root cause).
        <div data-testid="cap-empty-banner" style={{ fontSize: 13, color: 'var(--color-text-disabled)', padding: '4px 0', pointerEvents: 'none' }}>
          {t('cockpit.cap.empty')}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 12, alignItems: 'stretch', flexWrap: 'wrap' }}>
          {objectives.map((objective) => (
            <div key={objective.id} style={{ display: 'flex', flex: '1 1 260px', minWidth: 240, position: 'relative' }}>
              <ObjectiveCard
                objective={objective}
                onRequestRecoveryPlan={onRequestRecoveryPlan}
                onShift={(o, ms) => void handleShift(o, ms)}
                onHover={(id) => onHoverObjective(id ? objectives.find((o) => o.id === id) ?? null : null)}
                onOverrideCount={(o, n) => void handleOverrideCount(o, n)}
                onResumeAuto={(o) => void handleResumeAuto(o)}
              />
              <button
                data-testid={`objective-delete-${objective.id}`}
                onClick={() => void deleteObjective(objective.id)}
                title={t('cockpit.cap.delete')}
                style={{
                  position: 'absolute',
                  top: 6,
                  right: 8,
                  background: 'none',
                  border: 'none',
                  color: 'var(--color-text-disabled)',
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: 'var(--color-input)',
  border: '1px solid rgba(255,255,255,0.15)',
  borderRadius: 6,
  padding: '6px 9px',
  color: 'var(--color-text)',
  fontSize: 12.5,
  fontFamily: 'inherit',
  flex: '1 1 150px',
};
