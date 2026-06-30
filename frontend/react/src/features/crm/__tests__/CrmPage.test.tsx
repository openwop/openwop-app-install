/**
 * FP-1 (CODEBASE-ASSESSMENT.md): the headline feature pages had no component
 * tests. Covers CrmPage's access-gate tri-state — loading → skeleton,
 * disabled → "not enabled" StateCard (the FE-is-never-the-authority gate), and
 * enabled → renders fetched data.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

const access = vi.hoisted(() => ({ value: { enabled: false, loading: false, variant: undefined as string | undefined } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => access.value,
}));
vi.mock('../crmClient.js', () => ({
  CONTACT_STAGES: ['lead', 'qualified', 'customer', 'churned'],
  TASK_STATUSES: ['todo', 'doing', 'done'],
  listContacts: vi.fn(async () => [{ contactId: 'c1', name: 'Ada Lovelace', stage: 'lead' }]),
  listOrgs: vi.fn(async () => [{ orgId: 'o1', name: 'Org One' }]),
  listCompanies: vi.fn(async () => []),
  listDeals: vi.fn(async () => []),
  listTasks: vi.fn(async () => []),
  listPipelines: vi.fn(async () => []),
  createContact: vi.fn(), deleteContact: vi.fn(), triageContact: vi.fn(),
  createCompany: vi.fn(), createDeal: vi.fn(), createTask: vi.fn(),
  deleteCompany: vi.fn(), deleteDeal: vi.fn(), deleteTask: vi.fn(),
  moveDeal: vi.fn(), setTaskStatus: vi.fn(),
}));

import { CrmPage } from '../CrmPage.js';

beforeEach(() => { access.value = { enabled: false, loading: false, variant: undefined }; });
afterEach(cleanup);

describe('CrmPage access gate', () => {
  it('renders a skeleton while access is loading (neither gate copy nor content)', () => {
    access.value = { enabled: false, loading: true, variant: undefined };
    render(<CrmPage />);
    // While loading we show neither the "not enabled" gate nor the CRM content.
    expect(screen.queryByText(/not enabled/i)).toBeNull();
    expect(screen.queryByText('CRM')).toBeNull();
  });

  it('shows the "not enabled" StateCard when the feature is off (server-gated)', () => {
    access.value = { enabled: false, loading: false, variant: undefined };
    render(<CrmPage />);
    expect(screen.getByText(/CRM is not enabled/i)).toBeTruthy();
  });

  it('renders the CRM page + fetched contacts when enabled', async () => {
    access.value = { enabled: true, loading: false, variant: undefined };
    render(<CrmPage />);
    // The header renders immediately…
    expect(screen.getAllByText('CRM').length).toBeGreaterThan(0);
    // …and the mocked contact lands after the async fetch.
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeTruthy());
  });
});
