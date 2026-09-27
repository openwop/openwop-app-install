/**
 * ADR 0516 FT-UX-2 — the editor must enforce the SERVER's caps on authored strings.
 *
 * The ADR claimed Phase 2a had already done this ("every other capped field now
 * does the same — title 200, field label 1000, submit message 2000"). Only
 * `description` actually had one. A cap the editor does not mirror is a UI that
 * silently disagrees with what saves: you type 2000 characters, the save
 * SUCCEEDS, and 1000 come back with no signal — succeeds-but-wrong, which is the
 * failure mode the caps exist to prevent.
 *
 * These assert the rendered DOM rather than the constant, because a constant that
 * is never passed to an input is exactly the bug this is pinning.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { FormDef } from '../formsClient.js';

const client = vi.hoisted(() => ({
  listOrgs: vi.fn(), listForms: vi.fn(), getForm: vi.fn(), createForm: vi.fn(),
  updateForm: vi.fn(), deleteForm: vi.fn(), setFormStatus: vi.fn(),
  listIntakeLists: vi.fn(), listSubmissionsPage: vi.fn(), listSubmissions: vi.fn(),
  listFormTemplates: vi.fn(), createFormFromTemplate: vi.fn(),
  publicFormUrl: (id: string) => `https://example.test/public-forms/${id}`,
  hostedFormUrl: (id: string) => `https://example.test/f/${id}`,
  FIELD_TYPES: ['text', 'email', 'textarea', 'select', 'checkbox'] as const,
}));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../formsClient.js', () => client);
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));

const { FormDetailPage } = await import('../FormDetailPage.js');

/** The SERVER's numbers (`formsService.ts`: MAX_TITLE, MAX_LABEL,
 *  MAX_SUBMIT_MESSAGE, MAX_DESCRIPTION). Written literally so a drift on either
 *  side is a red test rather than two constants agreeing with each other. */
const SERVER = { title: 200, label: 1000, submitMessage: 2000, description: 300 };

const form = (over: Partial<FormDef> = {}): FormDef => ({
  formId: 'f1', orgId: 'o1', title: 'Contact Us', status: 'draft',
  fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
  createToContact: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
  ...over,
});

const renderDetail = () => render(
  <MemoryRouter initialEntries={['/forms/f1?org=o1']}>
    <Routes><Route path="/forms/:formId" element={<FormDetailPage />} /></Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  client.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Org One' }]);
  client.getForm.mockResolvedValue(form());
  client.listIntakeLists.mockResolvedValue([]);
  client.listSubmissionsPage.mockResolvedValue({ submissions: [], nextCursor: null });
  client.listSubmissions.mockResolvedValue([]);
});

describe('ADR 0516 FT-UX-2 — the editor enforces the server caps', () => {
  it('does NOT hard-stop typing — maxLength would silently eat a paste', async () => {
    renderDetail();
    const title = await screen.findByDisplayValue('Contact Us');
    // The GOV.UK/NHS pattern: let people finish the thought, then tell them what
    // to cut. `maxLength` discards the tail of a paste with no signal, which
    // destroys content at paste time to avoid the server destroying it at save
    // time. The save guard below is what makes allowing overage safe.
    expect(title.getAttribute('maxlength')).toBeNull();
  });

  it('shows how far OVER the cap a value is, and blocks the save', async () => {
    client.getForm.mockResolvedValue(form({ title: 'x'.repeat(SERVER.title + 23) }));
    renderDetail();
    // TWO matches by design — the visible counter and the sr-only live region
    // both carry the over-count, so this asserts on the pair rather than
    // pretending only one exists.
    await waitFor(() => expect(screen.getAllByText(/23 characters too many/i).length).toBeGreaterThanOrEqual(2));
    const save = screen.getByRole('button', { name: /save/i });
    expect(save.hasAttribute('disabled')).toBe(true);
  });

  it('names the offending field rather than just disabling Save', async () => {
    client.getForm.mockResolvedValue(form({ title: 'x'.repeat(SERVER.title + 1) }));
    renderDetail();
    // A disabled control with no stated reason leaves the user hunting.
    await waitFor(() => expect(screen.getByText(/Fix these before saving/i)).toBeTruthy());
  });

  it('leaves Save enabled when everything is within its cap', async () => {
    renderDetail();
    await screen.findByDisplayValue('Contact Us');
    const save = screen.getByRole('button', { name: /save/i });
    // Guards the three assertions above from passing because Save is ALWAYS off.
    expect(save.hasAttribute('disabled')).toBe(false);
  });

  it('keeps the key-error live region MOUNTED so it can announce on transition', async () => {
    // A live region that mounts WITH content announces nothing. If this span were
    // rendered only once the key is invalid, it would be silent at exactly the
    // moment it matters. Mounted empty (sr-only) on a VALID key, filled later.
    renderDetail();
    await screen.findByDisplayValue('Contact Us');
    const region = document.querySelector('[id^="key-err-"]');
    expect(region, 'the key-error region must exist even when the key is valid').toBeTruthy();
    expect(region!.textContent).toBe('');
    expect(region!.getAttribute('role')).toBe('status');
  });

  it('blocks the save on an invalid field KEY — the server throws 400 on this one', async () => {
    client.getForm.mockResolvedValue(form({ fields: [{ key: 'First Name', label: 'Name', type: 'text', required: true }] }));
    renderDetail();
    // Unlike the prose caps this one does not truncate: `sanitizeFields` throws,
    // so an uncaught bad key failed the WHOLE save with a raw 400.
    await waitFor(() => expect(screen.getByText(/letters, numbers and underscores/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: /save/i }).hasAttribute('disabled')).toBe(true);
  });




  it('shows no counter while a value is far from its cap', async () => {
    renderDetail();
    await screen.findByDisplayValue('Contact Us');
    // "Contact Us" is 10 of 200. A counter on every field at all times would
    // clutter an editor that is almost never near a limit — the counter earns
    // its space only near the wall.
    expect(screen.queryByText(/\/\s*200/)).toBeNull();
  });

  it('shows the counter once a value nears its cap — the wall stops being invisible', async () => {
    client.getForm.mockResolvedValue(form({ title: 'x'.repeat(180) }));
    renderDetail();
    // 180 of 200 is past the 80% threshold. Without this the input simply stops
    // accepting characters with no explanation.
    await waitFor(() => expect(screen.getByText(/180\s*\/\s*200/)).toBeTruthy());
  });
});
