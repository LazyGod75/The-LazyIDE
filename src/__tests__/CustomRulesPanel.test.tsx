import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { CustomRulesPanel } from '../components/agents/orchestrator/CustomRulesPanel';

function renderPanel() {
  return render(
    <I18nProvider>
      <CustomRulesPanel />
    </I18nProvider>,
  );
}

describe('CustomRulesPanel', () => {
  it('renders empty state "No custom rules" with an empty textarea', () => {
    renderPanel();
    expect(screen.getByText('No custom rules.')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('the example JSON is placeholder-only, never real value text', () => {
    renderPanel();
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toBe('');
    expect(textarea.placeholder).toContain('"id":"r1"');
    // Placeholder styling must visibly differ from real typed content.
    expect(textarea.className).toMatch(/placeholder:text-slate-600/);
  });

  it('typing a real (unsaved) rule does not claim "No custom rules"', () => {
    renderPanel();
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, {
      target: { value: JSON.stringify([{ id: 'r1', condition: 'action=launch_mission', action: 'ask' }]) },
    });
    expect(screen.queryByText('No custom rules.')).not.toBeInTheDocument();
    expect(screen.getByText(/Unsaved rule draft/)).toBeInTheDocument();
  });

  it('typing valid JSON rules and clicking "Save Rules" shows the rules', () => {
    renderPanel();
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify([
          { id: 'r1', condition: 'action=launch_mission', action: 'ask', message: 'Confirm launch' },
        ]),
      },
    });
    fireEvent.click(screen.getByText('Save Rules'));

    expect(screen.getByText('action=launch_mission')).toBeInTheDocument();
    expect(screen.getByText('Confirm launch')).toBeInTheDocument();
    expect(screen.queryByText('No custom rules.')).not.toBeInTheDocument();
  });

  it('clicking "Delete" on a rule removes it from the active list', () => {
    renderPanel();
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, {
      target: { value: JSON.stringify([{ id: 'r1', condition: 'action=launch_mission', action: 'ask' }]) },
    });
    fireEvent.click(screen.getByText('Save Rules'));
    expect(screen.getByText('action=launch_mission')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Delete'));
    expect(screen.queryByText('action=launch_mission')).not.toBeInTheDocument();
    // The editor still holds the (now stale) rule text, so the panel must
    // not claim "No custom rules" — it correctly flags it as an unsaved
    // draft instead (this is the same contradiction fix as defect #1).
    expect(screen.queryByText('No custom rules.')).not.toBeInTheDocument();
    expect(screen.getByText(/Unsaved rule draft/)).toBeInTheDocument();
  });

  it('restores "No custom rules" once the editor is cleared after a delete', () => {
    renderPanel();
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, {
      target: { value: JSON.stringify([{ id: 'r1', condition: 'action=launch_mission', action: 'ask' }]) },
    });
    fireEvent.click(screen.getByText('Save Rules'));
    fireEvent.click(screen.getByText('Delete'));

    fireEvent.change(textarea, { target: { value: '' } });
    expect(screen.getByText('No custom rules.')).toBeInTheDocument();
  });

  it('malformed JSON is rejected with an inline message and Save is disabled', () => {
    renderPanel();
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'not json' } });

    expect(screen.getByText(/Invalid JSON/)).toBeInTheDocument();
    expect(screen.getByText('Save Rules')).toBeDisabled();

    fireEvent.click(screen.getByText('Save Rules'));
    expect(screen.getByText('No custom rules.')).toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });

  it('an unknown rule field is reported and blocks saving', () => {
    renderPanel();
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify([
          { id: 'r1', condition: 'action=launch_mission', action: 'ask', priority: 5 },
        ]),
      },
    });

    expect(screen.getByText(/unknown field "priority"/)).toBeInTheDocument();
    expect(screen.getByText('Save Rules')).toBeDisabled();
  });

  it('a bad action value is reported and blocks saving', () => {
    renderPanel();
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, {
      target: { value: JSON.stringify([{ id: 'r1', condition: 'action=launch_mission', action: 'maybe' }]) },
    });

    expect(screen.getByText(/"action" must be allow, deny, or ask/)).toBeInTheDocument();
    expect(screen.getByText('Save Rules')).toBeDisabled();
  });

  it('accepts the legacy "cost>" condition spelling and the new "credits>" spelling', () => {
    renderPanel();
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify([
          { id: 'r1', condition: 'cost>100', action: 'ask' },
          { id: 'r2', condition: 'credits>100', action: 'ask' },
        ]),
      },
    });
    expect(screen.queryByText(/unrecognized condition/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Save Rules'));
    expect(screen.getByText('cost>100')).toBeInTheDocument();
    expect(screen.getByText('credits>100')).toBeInTheDocument();
  });

  it('flags an unrecognized condition clause', () => {
    renderPanel();
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, {
      target: { value: JSON.stringify([{ id: 'r1', condition: 'credit>100', action: 'ask' }]) },
    });
    expect(screen.getByText(/unrecognized condition "credit>100"/)).toBeInTheDocument();
    expect(screen.getByText('Save Rules')).toBeDisabled();
  });

  it('shows an "Unsaved changes" indicator after editing already-saved rules', () => {
    renderPanel();
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, {
      target: { value: JSON.stringify([{ id: 'r1', condition: 'action=launch_mission', action: 'ask' }]) },
    });
    fireEvent.click(screen.getByText('Save Rules'));
    expect(screen.queryByText(/Unsaved changes/)).not.toBeInTheDocument();

    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify([{ id: 'r1', condition: 'action=launch_mission', action: 'deny' }]),
      },
    });
    expect(screen.getByText(/Unsaved changes/)).toBeInTheDocument();
  });

  it('renders an Import button symmetric with Export', () => {
    renderPanel();
    expect(screen.getByText('Import')).toBeInTheDocument();
    const exportButton = screen.getByText('Export');
    expect(exportButton).toBeDisabled(); // no saved rules yet
  });
});
