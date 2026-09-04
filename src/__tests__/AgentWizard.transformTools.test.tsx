/**
 * AgentWizard.transformTools.test.tsx — W-CODE "wizard authoring" proof for
 * the sandboxed "transformation" tool kind (lib/agents/transformTools.ts):
 * a user can author a pure `(input) => output` JS function from the SAME
 * AgentWizard Capacités step the other two BYO tool kinds already use, gets
 * rejected honestly on invalid input (empty code, a syntax error), and can
 * attach/detach a saved tool to the agent being authored.
 *
 * Focuses on this feature's own authoring surface (TransformToolsSection)
 * rather than re-proving the pre-existing StepIdentite/validateAgent save
 * flow — that is already covered by projectCommandTools/declarativeTools'
 * own wizard tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentWizard } from '../components/agents/library/AgentWizard';
import { I18nProvider } from '../i18n';
import { _resetTransformToolsForTests, listTransformTools } from '../lib/agents/transformTools';

function renderWizard() {
  return render(
    <I18nProvider>
      <AgentWizard onSave={async () => {}} onTestNow={() => {}} onClose={() => {}} />
    </I18nProvider>,
  );
}

async function openCapacitesStep(): Promise<void> {
  fireEvent.click(screen.getByTestId('wizard-step-tab-3'));
  await waitFor(() => expect(screen.getByTestId('transform-tool-add-btn')).toBeInTheDocument());
}

beforeEach(() => {
  _resetTransformToolsForTests();
});

const NAME_PLACEHOLDER = /Double every item|Doubler chaque|Duplicar cada|Jedes Element verdoppeln|将每个元素翻倍|各項目を2倍/;
const DESC_PLACEHOLDER = /Short description|Description courte|Descripción breve|Kurze Beschreibung|简短描述|簡単な説明/;

describe('AgentWizard — transform tools authoring (W-CODE)', () => {
  it('rejects empty code and never saves it', async () => {
    renderWizard();
    await openCapacitesStep();

    fireEvent.click(screen.getByTestId('transform-tool-add-btn'));

    const nameInput = screen.getAllByPlaceholderText(NAME_PLACEHOLDER)[0];
    const descInput = screen.getAllByPlaceholderText(DESC_PLACEHOLDER)[0];
    fireEvent.change(nameInput, { target: { value: 'Empty transform' } });
    fireEvent.change(descInput, { target: { value: 'Should never save' } });
    // code textarea deliberately left blank

    fireEvent.click(screen.getByTestId('transform-tool-save-btn'));

    await waitFor(() => expect(screen.getByTestId('transform-tool-error')).toBeInTheDocument());
    expect(await listTransformTools()).toHaveLength(0);
  });

  it('rejects a syntax error in the code and never saves it', async () => {
    renderWizard();
    await openCapacitesStep();

    fireEvent.click(screen.getByTestId('transform-tool-add-btn'));

    const nameInput = screen.getAllByPlaceholderText(NAME_PLACEHOLDER)[0];
    const codeInput = screen.getByTestId('transform-tool-code-input');
    const descInput = screen.getAllByPlaceholderText(DESC_PLACEHOLDER)[0];
    fireEvent.change(nameInput, { target: { value: 'Broken code' } });
    fireEvent.change(codeInput, { target: { value: 'this is not valid js {{{' } });
    fireEvent.change(descInput, { target: { value: 'Should never save' } });

    fireEvent.click(screen.getByTestId('transform-tool-save-btn'));

    await waitFor(() => expect(screen.getByTestId('transform-tool-error')).toBeInTheDocument());
    expect(await listTransformTools()).toHaveLength(0);
  });

  it('authors a valid transform tool, then attaches and detaches it', async () => {
    renderWizard();
    await openCapacitesStep();

    fireEvent.click(screen.getByTestId('transform-tool-add-btn'));

    const nameInput = screen.getAllByPlaceholderText(NAME_PLACEHOLDER)[0];
    const codeInput = screen.getByTestId('transform-tool-code-input');
    const descInput = screen.getAllByPlaceholderText(DESC_PLACEHOLDER)[0];
    fireEvent.change(nameInput, { target: { value: 'Double items' } });
    fireEvent.change(codeInput, { target: { value: 'return input.items.map((x) => x * 2);' } });
    fireEvent.change(descInput, { target: { value: 'Doubles every number in input.items.' } });

    fireEvent.click(screen.getByTestId('transform-tool-save-btn'));

    const tools = await waitFor(async () => {
      const list = await listTransformTools();
      expect(list).toHaveLength(1);
      return list;
    });
    const toolId = tools[0].id;
    expect(tools[0].code).toBe('return input.items.map((x) => x * 2);');

    const toggle = await screen.findByTestId(`transform-tool-toggle-${toolId}`);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId(`transform-tool-toggle-${toolId}`)).toHaveAttribute('aria-pressed', 'true'));

    fireEvent.click(screen.getByTestId(`transform-tool-toggle-${toolId}`));
    await waitFor(() => expect(screen.getByTestId(`transform-tool-toggle-${toolId}`)).toHaveAttribute('aria-pressed', 'false'));
  });

  it('is available regardless of permissionMode (no gate — a pure computation has no side effects to bound)', async () => {
    renderWizard();
    await openCapacitesStep();
    // default permissionMode is unset/'default' at this point — the add
    // button must already be visible and enabled (unlike ProjectCommandsSection,
    // which greys out and requires acceptEdits/full).
    const addBtn = screen.getByTestId('transform-tool-add-btn');
    expect(addBtn).toBeEnabled();
  });
});
