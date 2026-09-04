/**
 * gettingStarted.test.tsx
 *
 * v0.1.5 W3.2 — "Bien démarrer" checklist on Accueil (Home). Three REAL
 * checks (never a scripted tour): a project is open, the AI engine is
 * ready (getEngineReadiness().ready), and the user launched a mission or
 * sent a first assistant message (agents store mission count OR the
 * lazy.firstAssistantSend flag set by the composer send path). Dismissible
 * ("Masquer") and auto-hides forever once all three are done — both
 * persisted per-account in localStorage. Tauri only.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { GettingStarted } from '../components/home/GettingStarted';
import { I18nProvider } from '../i18n';
import { fr } from '../i18n/locales/fr';
import { getEngineReadiness } from '../lib/models/entitlement';
import { emit } from '../lib/bus';

const mockOpenProject = vi.fn();
const mockSetActiveSpace = vi.fn();

vi.mock('../lib/models/entitlement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/entitlement')>();
  return { ...actual, getEngineReadiness: vi.fn() };
});

vi.mock('../app/AppContext', () => ({
  useAppContext: () => ({
    projectRoot: mockProjectRoot(),
    openProject: mockOpenProject,
    setActiveSpace: mockSetActiveSpace,
  }),
}));

vi.mock('../lib/auth/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-test-1' }, session: null, loading: false }),
}));

vi.mock('../lib/bus', () => ({
  emit: vi.fn(),
  on: vi.fn(() => () => {}),
}));

let projectRootValue = '';
function mockProjectRoot(): string {
  return projectRootValue;
}

const mockedReadiness = vi.mocked(getEngineReadiness);
const mockedEmit = vi.mocked(emit);

function setTauri(on: boolean): void {
  const win = window as unknown as Record<string, unknown>;
  if (on) win['__TAURI_INTERNALS__'] = {};
  else delete win['__TAURI_INTERNALS__'];
}

function renderCard(hasMissions = false) {
  render(
    <I18nProvider>
      <GettingStarted hasMissions={hasMissions} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('lazy.locale', 'fr');
  projectRootValue = '';
  mockedReadiness.mockReturnValue({ mode: 'cli', ready: false, reason: 'cli-not-found' });
  setTauri(true);
});

afterEach(() => {
  setTauri(false);
});

describe('GettingStarted — first-run checklist', () => {
  it('renders nothing outside Tauri (web)', () => {
    setTauri(false);
    renderCard();
    expect(screen.queryByText(fr['home.gettingStarted.title'])).toBeNull();
  });

  it('shows all three steps as undone with real action buttons when nothing is configured', () => {
    renderCard(false);

    expect(screen.getByText(fr['home.gettingStarted.title'])).toBeInTheDocument();
    expect(screen.getByText(fr['home.gettingStarted.step1'])).toBeInTheDocument();
    expect(screen.getByText(fr['home.gettingStarted.step2'])).toBeInTheDocument();
    expect(screen.getByText(fr['home.gettingStarted.step3'])).toBeInTheDocument();
    expect(screen.getByRole('button', { name: fr['home.action.openFolder'] })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: fr['engine.preflight.configure'] })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: fr['home.action.newMission'] })).toBeInTheDocument();
  });

  it('marks "open a project" done and hides its action once projectRoot is set', () => {
    projectRootValue = '/home/user/my-project';
    renderCard(false);

    expect(screen.queryByRole('button', { name: fr['home.action.openFolder'] })).toBeNull();
  });

  it('marks "connect your AI engine" done once getEngineReadiness().ready is true', () => {
    mockedReadiness.mockReturnValue({ mode: 'cli', ready: true });
    renderCard(false);

    expect(screen.queryByRole('button', { name: fr['engine.preflight.configure'] })).toBeNull();
  });

  it('marks the mission/assistant step done when the agents store already has a mission', () => {
    renderCard(true);

    expect(screen.queryByRole('button', { name: fr['home.action.newMission'] })).toBeNull();
  });

  it('marks the mission/assistant step done from the lazy.firstAssistantSend flag alone', () => {
    localStorage.setItem('lazy.firstAssistantSend', '1');
    renderCard(false);

    expect(screen.queryByRole('button', { name: fr['home.action.newMission'] })).toBeNull();
  });

  it('"Ouvrir un dossier" calls openProject()', () => {
    renderCard(false);
    fireEvent.click(screen.getByRole('button', { name: fr['home.action.openFolder'] }));
    expect(mockOpenProject).toHaveBeenCalled();
  });

  it('the engine action navigates to Settings > Modèles (same mechanism as the preflight notices)', () => {
    renderCard(false);
    fireEvent.click(screen.getByRole('button', { name: fr['engine.preflight.configure'] }));
    expect(mockedEmit).toHaveBeenCalledWith('nav:navigateSpace', 'models');
  });

  it('the mission action navigates to the Agents space', () => {
    renderCard(false);
    fireEvent.click(screen.getByRole('button', { name: fr['home.action.newMission'] }));
    expect(mockSetActiveSpace).toHaveBeenCalledWith('agents');
  });

  it('"Masquer" hides the card and persists the dismissal for this account', () => {
    renderCard(false);
    fireEvent.click(screen.getByRole('button', { name: fr['home.gettingStarted.dismiss'] }));

    expect(screen.queryByText(fr['home.gettingStarted.title'])).toBeNull();
    expect(localStorage.getItem('lazy.gettingStarted.dismissed:user-test-1')).toBe('1');
  });

  it('stays hidden on a later mount once dismissed', () => {
    localStorage.setItem('lazy.gettingStarted.dismissed:user-test-1', '1');
    renderCard(false);

    expect(screen.queryByText(fr['home.gettingStarted.title'])).toBeNull();
  });

  it('auto-hides forever once all three checks are real and done (and persists like an explicit dismiss)', () => {
    projectRootValue = '/home/user/my-project';
    mockedReadiness.mockReturnValue({ mode: 'cli', ready: true });
    renderCard(true);

    expect(screen.queryByText(fr['home.gettingStarted.title'])).toBeNull();
    expect(localStorage.getItem('lazy.gettingStarted.dismissed:user-test-1')).toBe('1');
  });
});
