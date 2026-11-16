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
 *      / reload works with no hub list in memory, and it owns Save and Delete.
 *
 * `/email` stays a HUB (provider status · sender · templates · campaigns) — this
 * pins the templates lane, not a dissolution of the page. EMAIL-1 (ADR 0019): the
 * hub's CREATE form has a multiline Body now; what must stay off the hub is the
 * stacked editor and any control inside a collection cell.
 *
 * The not-found case rejects with the message `asJson` builds for a 404 whose
 * body carries no `message`. The server's real 404 body DOES carry one
 * ("Template not found."), and the page classifies by `/\b404\b/` in the
 * message, so a real stale link renders the load-failed state instead
 * (`TST-NZP-1`, EM2-UX-7; BLOCKED-ON-PRODUCT, the case is titled for what it
 * exercises).
 *
 * Sabotage-witnessed (/grade-tests wave 9 `w9g4-tr-*`, wave 112 `w112g4-etr-*`):
 * dropping `?org=` from the href, a delete button beside or a control inside a
 * cell, a single-line create Body, loading a different id, the editor bound to
 * the wrong field, the 404 treated as a load failure or as an empty editor,
 * removing the detail Delete, deleting the wrong id, and leaving to the hub
 * without its workspace each turn a case red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type * as EC from '../emailClient.js';
import type { EmailTemplate, ProviderStatus } from '../emailClient.js';

// Typed against the real client, so a fixture drifting from `EmailTemplate` & co. fails tsc.
const client = vi.hoisted(() => ({
  listOrgs: vi.fn<typeof EC.listOrgs>(), listTemplates: vi.fn<typeof EC.listTemplates>(),
  getTemplate: vi.fn<typeof EC.getTemplate>(), createTemplate: vi.fn<typeof EC.createTemplate>(),
  updateTemplate: vi.fn<typeof EC.updateTemplate>(), deleteTemplate: vi.fn<typeof EC.deleteTemplate>(),
  previewMarkdown: vi.fn<typeof EC.previewMarkdown>(),
  listCampaigns: vi.fn<typeof EC.listCampaigns>(), createCampaign: vi.fn<typeof EC.createCampaign>(),
  deleteCampaign: vi.fn<typeof EC.deleteCampaign>(), sendCampaign: vi.fn<typeof EC.sendCampaign>(),
  listSends: vi.fn<typeof EC.listSends>(), listSegments: vi.fn<typeof EC.listSegments>(),
  listTopics: async () => ({ topics: [], max: 20 }),
  // ADR 0955 — the sending-health card and the SMS segment hint.
  getSendingHealth: async () => ({ state: null, window: { sent: 0, hardBounces: 0, complaints: 0 }, thresholds: { minSends: 500, complaintRate: 0.001, hardBounceRate: 0.02 }, canResume: false }),
  smsSegments: () => 1,
  listTemplateVersions: vi.fn<typeof EC.listTemplateVersions>(async () => []),
  diffTemplateVersion: vi.fn<typeof EC.diffTemplateVersion>(), restoreTemplateVersion: vi.fn<typeof EC.restoreTemplateVersion>(),
  TemplateVersionConflictError: class extends Error {},
  getEmailSettings: vi.fn<typeof EC.getEmailSettings>(), putEmailSettings: vi.fn<typeof EC.putEmailSettings>(),
  getProviderStatus: vi.fn<typeof EC.getProviderStatus>(),
  CONTACT_STAGES: ['lead', 'qualified', 'customer', 'churned'] as const,
}));
const confirmMock = vi.hoisted(() => vi.fn(async () => true));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../emailClient.js', () => client);
vi.mock('../../../ui/confirm.js', () => ({ confirm: confirmMock }));
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

/** Where a navigation away from the detail page landed (path + query). */
function HubLanding(): JSX.Element {
  const loc = useLocation();
  return <p data-testid="hub-landing">{loc.pathname + loc.search}</p>;
}

const renderDetail = (entry = '/email/templates/tpl1?org=o1') => render(
  <MemoryRouter initialEntries={[entry]}>
    <Routes>
      <Route path="/email/templates/:templateId" element={<EmailTemplateDetailPage />} />
      <Route path="/email" element={<HubLanding />} />
    </Routes>
  </MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  client.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Personal workspace' }]);
  client.listTemplates.mockResolvedValue([tpl()]);
  client.getTemplate.mockResolvedValue(tpl());
  client.deleteTemplate.mockResolvedValue(undefined);
  client.listCampaigns.mockResolvedValue([]);
  client.listSegments.mockResolvedValue([]);
  client.getEmailSettings.mockResolvedValue({ senderAddress: 'a@b.test', configured: true });
  // A real `ProviderStatus` — `getProviderStatus` never resolves null (that parked the
  // hub's provider card in "loading" forever).
  client.getProviderStatus.mockResolvedValue({ providers: [], defaultProvider: null, senderAddress: 'a@b.test' } satisfies ProviderStatus);
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

  it('keeps editing on the detail page while allowing a multiline create form', async () => {
    renderHub();
    const cell = await screen.findByRole('link', { name: /Welcome/ });
    // EMAIL-1: CREATE legitimately has a textarea now. The routing contract is
    // no editing controls in a collection cell or stacked detail editor on the
    // hub, not the obsolete page-wide absence of every textarea.
    const createBody = screen.getByRole('textbox', { name: 'Body' });
    if (!(createBody instanceof HTMLTextAreaElement)) throw new Error('Expected multiline create Body');
    expect(createBody.value).toBe('');
    expect(cell.querySelector('textarea,input,select,button')).toBeNull();
    expect(screen.queryByRole('heading', { level: 1, name: 'Welcome' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^save$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();
  });
});

describe('the template detail page', () => {
  it('loads its own template by id — no hub list in memory required', async () => {
    renderDetail();
    // Await the loaded editor itself, then read every value off that one render.
    const editorBody = await screen.findByRole('textbox', { name: 'Body' });
    expect(client.getTemplate).toHaveBeenCalledWith('o1', 'tpl1');
    // The entity name IS the page h1 (§4.5 rule 12).
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Welcome');
    expect(screen.getByRole('button', { name: /^save$/i }).hasAttribute('disabled')).toBe(false);
    if (!(editorBody instanceof HTMLTextAreaElement)) throw new Error('Expected detail Body editor');
    expect(editorBody.value).toBe('Hello!');
    expect(client.listTemplates).not.toHaveBeenCalled();
  });

  it('a 404 without a server message renders the not-found state instead of an empty editor', async () => {
    // What `asJson` throws for a 404 whose body has no `message` (TST-NZP-1:
    // the server's own 404 body has one, and that path renders load-failed).
    client.getTemplate.mockRejectedValue(new Error('getTemplate returned 404'));
    renderDetail('/email/templates/gone?org=o1');
    await waitFor(() => expect(client.getTemplate).toHaveBeenCalledWith('o1', 'gone'));
    // Let the rejection reach its catch before reading the settled page.
    await act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Template not found');
    // An empty editor would invite editing a template that does not exist and
    // 404 on save.
    expect(screen.queryByRole('button', { name: /^save$/i })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Body' })).toBeNull();
  });

  it('owns the delete action: Delete removes THIS template and returns to its workspace on the hub', async () => {
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    expect((await screen.findByTestId('hub-landing')).textContent).toBe('/email?org=o1');
    expect(client.deleteTemplate).toHaveBeenCalledExactlyOnceWith('o1', 'tpl1');
  });
});
