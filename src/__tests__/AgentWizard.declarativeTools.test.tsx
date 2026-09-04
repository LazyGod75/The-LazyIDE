/**
 * AgentWizard.declarativeTools.test.tsx — W-PROVE "wizard authoring" proof
 * for the two safe-by-construction declarative BYO tool kinds
 * (lib/agents/declarativeTools.ts): a user can author a « lecture web »
 * (allowlisted-host HTTP GET) or a « lecture fichier projet » (project-
 * relative file read) tool from the SAME AgentWizard Capacités step
 * project-command tools already use, get rejected honestly on invalid
 * input, and attach/detach a saved tool to the agent being authored.
 *
 * Focuses on this feature's own authoring surface (DeclarativeToolsSection)
 * rather than re-proving the pre-existing StepIdentite/validateAgent save
 * flow, which project-command tools' own coverage already exercises via
 * projectCommandTools.test.ts + compile.test.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentWizard } from '../components/agents/library/AgentWizard';
import { I18nProvider } from '../i18n';
import { _resetDeclarativeToolsForTests, listDeclarativeTools } from '../lib/agents/declarativeTools';

function renderWizard() {
  return render(
    <I18nProvider>
      <AgentWizard onSave={async () => {}} onTestNow={() => {}} onClose={() => {}} />
    </I18nProvider>,
  );
}

async function openCapacitesStep(): Promise<void> {
  fireEvent.click(screen.getByTestId('wizard-step-tab-3'));
  await waitFor(() => expect(screen.getByTestId('declarative-tool-add-btn')).toBeInTheDocument());
}

beforeEach(() => {
  _resetDeclarativeToolsForTests();
});

describe('AgentWizard — declarative tools authoring (W-PROVE)', () => {
  it('rejects an off-allowlist-shaped host (with a scheme) and never saves it', async () => {
    renderWizard();
    await openCapacitesStep();

    fireEvent.click(screen.getByTestId('declarative-tool-add-btn'));
    fireEvent.click(screen.getByTestId('declarative-tool-kind-web_read'));

    const [nameInput, hostInput, descInput] = [
      screen.getAllByPlaceholderText(/API status|Statut de l|Estado de la|API-Status|API状态|APIステータス/)[0],
      screen.getByTestId('declarative-tool-host-input'),
      screen.getAllByPlaceholderText(/Description courte|Short description|Descripción breve|Kurze Beschreibung|简短描述|簡単な説明/)[0],
    ];
    fireEvent.change(nameInput, { target: { value: 'Bad host tool' } });
    fireEvent.change(hostInput, { target: { value: 'http://evil.com' } });
    fireEvent.change(descInput, { target: { value: 'Should never save' } });

    fireEvent.click(screen.getByTestId('declarative-tool-save-btn'));

    await waitFor(() => expect(screen.getByTestId('declarative-tool-error')).toBeInTheDocument());
    expect(await listDeclarativeTools()).toHaveLength(0);
  });

  it('authors a valid web_read tool, then attaches and detaches it', async () => {
    renderWizard();
    await openCapacitesStep();

    fireEvent.click(screen.getByTestId('declarative-tool-add-btn'));
    fireEvent.click(screen.getByTestId('declarative-tool-kind-web_read'));

    const nameInput = screen.getAllByPlaceholderText(/API status|Statut de l|Estado de la|API-Status|API状态|APIステータス/)[0];
    const hostInput = screen.getByTestId('declarative-tool-host-input');
    const descInput = screen.getAllByPlaceholderText(/Description courte|Short description|Descripción breve|Kurze Beschreibung|简短描述|簡単な説明/)[0];

    fireEvent.change(nameInput, { target: { value: 'API status' } });
    fireEvent.change(hostInput, { target: { value: 'api.example.com' } });
    fireEvent.change(descInput, { target: { value: 'Reads the public API status.' } });
    fireEvent.click(screen.getByTestId('declarative-tool-save-btn'));

    const tools = await waitFor(async () => {
      const list = await listDeclarativeTools();
      expect(list).toHaveLength(1);
      return list;
    });
    const toolId = tools[0].id;

    const toggle = await screen.findByTestId(`declarative-tool-toggle-${toolId}`);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId(`declarative-tool-toggle-${toolId}`)).toHaveAttribute('aria-pressed', 'true'));

    fireEvent.click(screen.getByTestId(`declarative-tool-toggle-${toolId}`));
    await waitFor(() => expect(screen.getByTestId(`declarative-tool-toggle-${toolId}`)).toHaveAttribute('aria-pressed', 'false'));
  });

  it('rejects an outside-project path for a file_read tool and never saves it', async () => {
    renderWizard();
    await openCapacitesStep();

    fireEvent.click(screen.getByTestId('declarative-tool-add-btn'));
    fireEvent.click(screen.getByTestId('declarative-tool-kind-file_read'));

    const pathInput = screen.getByTestId('declarative-tool-path-input');
    const nameInput = screen.getAllByPlaceholderText(/API status|Statut de l|Estado de la|API-Status|API状态|APIステータス/)[0];
    const descInput = screen.getAllByPlaceholderText(/Description courte|Short description|Descripción breve|Kurze Beschreibung|简短描述|簡単な説明/)[0];

    fireEvent.change(nameInput, { target: { value: 'Escape attempt' } });
    fireEvent.change(pathInput, { target: { value: '../../etc/passwd' } });
    fireEvent.change(descInput, { target: { value: 'Should never save' } });
    fireEvent.click(screen.getByTestId('declarative-tool-save-btn'));

    await waitFor(() => expect(screen.getByTestId('declarative-tool-error')).toBeInTheDocument());
    expect(await listDeclarativeTools()).toHaveLength(0);
  });

  it('authors a valid file_read tool inside the project root', async () => {
    renderWizard();
    await openCapacitesStep();

    fireEvent.click(screen.getByTestId('declarative-tool-add-btn'));
    fireEvent.click(screen.getByTestId('declarative-tool-kind-file_read'));

    const pathInput = screen.getByTestId('declarative-tool-path-input');
    const nameInput = screen.getAllByPlaceholderText(/API status|Statut de l|Estado de la|API-Status|API状态|APIステータス/)[0];
    const descInput = screen.getAllByPlaceholderText(/Description courte|Short description|Descripción breve|Kurze Beschreibung|简短描述|簡単な説明/)[0];

    fireEvent.change(nameInput, { target: { value: 'Changelog' } });
    fireEvent.change(pathInput, { target: { value: 'CHANGELOG.md' } });
    fireEvent.change(descInput, { target: { value: 'Reads the changelog.' } });
    fireEvent.click(screen.getByTestId('declarative-tool-save-btn'));

    const list = await waitFor(async () => {
      const l = await listDeclarativeTools();
      expect(l).toHaveLength(1);
      return l;
    });
    expect(list[0]).toMatchObject({ kind: 'file_read', name: 'Changelog', path: 'CHANGELOG.md' });
  });
});
