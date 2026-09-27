/**
 * ADR 0520 — an email template opens at its OWN URL.
 *
 * Same three behaviours ADR 0519 pinned for Forms, because this is the same
 * defect and it hid the same way:
 *   1. template cells are real `<Link>`s to `/email/templates/:templateId` — the
 *      `onClick` selector they replaced rendered identically and silently broke
 *      cmd-click, middle-click, "copy link address", and browser history;
 *   2. NO delete control on a collection cell — it sat one mis-aimed click from
 *      the row you meant to open (§4.5 rule 12 puts it on the detail surface);
 *   3. the detail page loads its OWN template by id, so a bookmark / shared link
 *      / reload works with no hub list in memory.
 *
 * `/email` stays a HUB (provider status · sender · templates · campaigns) — this
 * pins the templates lane, not a dissolution of the page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { EmailTemplate } from '../emailClient.js';

const client = vi.hoisted(() => ({
  listOrgs: vi.fn(), listTemplates: vi.fn(), getTemplate: vi.fn(), createTemplate: vi.fn(),
  updateTemplate: vi.fn(), deleteTemplate: vi.fn(), previewMarkdown: vi.fn(),
  listCampaigns: vi.fn(), createCampaign: vi.fn(), deleteCampaign: vi.fn(), sendCampaign: vi.fn(),
  listSends: vi.fn(), listSegments: vi.fn(),
  getEmailSettings: vi.fn(), putEmailSettings: vi.fn(), getProviderStatus: vi.fn(),
  CONTACT_STAGES: ['lead', 'qualified', 'customer', 'churned'] as const,
}));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../emailClient.js', () => client);
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));

const { EmailPage } = await import('../EmailPage.js');
const { EmailTemplateDetailPage } = await import('../EmailTemplateDetailPage.js');

const tpl = (over: Partial<EmailTemplate> = {}): EmailTemplate => ({
  templateId: 'tpl1', orgId: 'o1', name: 'Welcome', subject: 'Hi there', body: 'Hello!',
  format: 'text', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
  ...over,
});

const renderHub = () => render(
  <MemoryRouter initialEntries={['/email?org=o1']}>
    <Routes><Route path="/email" element={<EmailPage />} /></Routes>
  </MemoryRouter>);

const renderDetail = (entry = '/email/templates/tpl1?org=o1') => render(
  <MemoryRouter initialEntries={[entry]}>
    <Routes><Route path="/email/templates/:templateId" element={<EmailTemplateDetailPage />} /></Routes>
  </MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  client.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Personal workspace' }]);
  client.listTemplates.mockResolvedValue([tpl()]);
  client.getTemplate.mockResolvedValue(tpl());
  client.listCampaigns.mockResolvedValue([]);
  client.listSegments.mockResolvedValue([]);
  client.getEmailSettings.mockResolvedValue({ senderAddress: 'a@b.test', configured: true });
  client.getProviderStatus.mockResolvedValue(null);
});

describe('the Email hub templates collection', () => {
  it('renders each template as a real link to its own URL', async () => {
    renderHub();
    const link = await screen.findByRole('link', { name: /Welcome/ });
    // `?org=` rides along so a shared link resolves the same workspace.
    expect(link.getAttribute('href')).toBe('/email/templates/tpl1?org=o1');
  });

  it('puts NO delete control on a template cell', async () => {
    renderHub();
    await screen.findByRole('link', { name: /Welcome/ });
    expect(screen.queryByRole('button', { name: /delete template/i })).toBeNull();
  });

  it('does not render the editor inline any more', async () => {
    const { container } = renderHub();
    await screen.findByRole('link', { name: /Welcome/ });
    // The editor's multi-line body was the hub's only <textarea> — the CREATE
    // form's body is a single-line <input> and legitimately stays here. If a
    // textarea reappears, the stacked editor is back and the URL has stopped
    // meaning anything.
    expect(container.querySelector('textarea')).toBeNull();
  });
});

describe('the template detail page', () => {
  it('loads its own template by id — no hub list in memory required', async () => {
    renderDetail();
    await waitFor(() => expect(client.getTemplate).toHaveBeenCalledWith('o1', 'tpl1'));
    // The entity name IS the page h1 (§4.5 rule 12).
    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome' })).toBeTruthy();
    expect(client.listTemplates).not.toHaveBeenCalled();
  });

  it('renders the not-found state for a stale link instead of an empty editor', async () => {
    client.getTemplate.mockRejectedValue(new Error('getTemplate returned 404'));
    renderDetail('/email/templates/gone?org=o1');
    expect(await screen.findByRole('heading', { level: 1, name: /template not found/i })).toBeTruthy();
    // An empty editor would invite editing a template that does not exist and
    // 404 on save.
    expect(screen.queryByRole('button', { name: /^save$/i })).toBeNull();
  });

  it('owns the delete action', async () => {
    renderDetail();
    expect(await screen.findByRole('button', { name: /delete/i })).toBeTruthy();
  });
});
