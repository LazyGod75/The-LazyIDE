import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { ProvisioningPanel } from '../components/agents/orchestrator/ProvisioningPanel';
import { provisionService } from '../lib/agents/provisioning';

vi.mock('../lib/agents/provisioning', () => ({
  provisionService: vi.fn(),
  teardownService: vi.fn(),
  estimateCost: vi.fn().mockReturnValue(0),
}));

const mockedProvisionService = vi.mocked(provisionService);

afterEach(() => {
  vi.clearAllMocks();
});

// Currency-leak fix (real user report, 2026-08-14) added `useI18n()` to
// ProvisioningPanel.tsx (cost estimates now render as credits via a
// translated string) — every render needs an I18nProvider ancestor now.
function renderPanel() {
  return render(
    <I18nProvider>
      <ProvisioningPanel />
    </I18nProvider>,
  );
}

describe('ProvisioningPanel', () => {
  it('renders empty state "No services provisioned" initially', () => {
    renderPanel();
    expect(screen.getByText('No services provisioned')).toBeInTheDocument();
  });

  it('clicking "+ Provision" shows the form with service type select', () => {
    renderPanel();
    fireEvent.click(screen.getByText('+ Provision'));
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.getByText('supabase-db')).toBeInTheDocument();
  });

  it('selecting a service type and clicking provision calls provisionService', async () => {
    mockedProvisionService.mockResolvedValue({
      ok: true,
      service: 'supabase-db',
      projectId: 'test-proj',
      credentials: { SUPABASE_URL: 'https://test.supabase.co' },
      endpoint: 'https://test.supabase.co',
      provisionedAt: Date.now(),
    });

    renderPanel();
    fireEvent.click(screen.getByText('+ Provision'));

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'supabase-db' } });
    fireEvent.click(screen.getByText('Provision'));

    await waitFor(() => {
      expect(mockedProvisionService).toHaveBeenCalledWith(
        expect.objectContaining({ service: 'supabase-db' }),
      );
    });
  });

  it('shows error state when provision fails', async () => {
    mockedProvisionService.mockResolvedValue({
      ok: false,
      service: 'supabase-db',
      projectId: 'test-proj',
      error: 'Connection failed',
      provisionedAt: Date.now(),
    });

    renderPanel();
    fireEvent.click(screen.getByText('+ Provision'));
    fireEvent.click(screen.getByText('Provision'));

    await waitFor(() => {
      expect(screen.getByText('Connection failed')).toBeInTheDocument();
    });
  });
});
