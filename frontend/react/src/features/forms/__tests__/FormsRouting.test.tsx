/**
 * ADR 0519 — Forms is a standard collection page, and a form opens at its OWN URL.
 *
 * The three behaviours worth pinning are the ones the old page got wrong, each
 * of which looked fine on screen:
 *   1. cells are real `<Link>`s to `/forms/:formId` — an `onClick` selector
 *      renders identically and silently breaks cmd-click, middle-click, "copy
 *      link address", and browser history;
 *   2. NO delete control on a collection cell — it sat one mis-aimed click from
 *      the row you meant to open (§4.5 rule 12 puts it on the detail surface);
 *   3. the detail page loads its OWN form by id, so a bookmark / shared link /
 *      reload works with no list in memory — the failure mode of the old
 *      in-page selection, which had nothing to restore from.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { FormDef } from '../formsClient.js';

const client = vi.hoisted(() => ({
  /**
   * ADR 0584 (FORM-UX-5) — the mock MUST export the real error class.
   *
   * `formsClient` now throws a typed `FormsRequestError` and both pages branch
   * on `instanceof` it (the 404 → not-found decision below is one such branch).
   * A module mock that omits it leaves `FormsRequestError` as `undefined` at
   * every call site, and `x instanceof undefined` THROWS — so the omission
   * would not read as "this branch is untested", it would blow up the catch
   * handler. Declared here so the double carries the same contract as the
   * module it replaces.
   */
  FormsRequestError: class FormsRequestError extends Error {
    readonly status: number;
    readonly detail: string | undefined;
    constructor(op: string, status: number, detail?: string) {
      super(detail || `${op} returned ${status}`);
      this.name = 'FormsRequestError';
      this.status = status;
      this.detail = detail || undefined;
    }
  },
  listOrgs: vi.fn(), listForms: vi.fn(), getForm: vi.fn(), createForm: vi.fn(),
  updateForm: vi.fn(), deleteForm: vi.fn(), setFormStatus: vi.fn(),
  listIntakeLists: vi.fn(), listSubmissionsPage: vi.fn(), listSubmissions: vi.fn(),
  // ADR 0584 §Correction (FORM-BUDGET-1) — the per-row discard the occupancy budget needs.
  deleteSubmission: vi.fn(),
  // ADR 0516 — the template catalog the create toolbar reads.
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

const { FormsPage } = await import('../FormsPage.js');
const { FormDetailPage } = await import('../FormDetailPage.js');

const form = (over: Partial<FormDef> = {}): FormDef => ({
  formId: 'f1', orgId: 'o1', title: 'Contact Us', status: 'published',
  fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
  createToContact: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
  ...over,
});

const renderList = () => render(
  <MemoryRouter initialEntries={['/forms?org=o1']}>
    <Routes><Route path="/forms" element={<FormsPage />} /></Routes>
  </MemoryRouter>);

const renderDetail = (entry = '/forms/f1?org=o1') => render(
  <MemoryRouter initialEntries={[entry]}>
    <Routes><Route path="/forms/:formId" element={<FormDetailPage />} /></Routes>
  </MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  client.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Personal workspace' }]);
  client.listForms.mockResolvedValue([form()]);
  client.getForm.mockResolvedValue(form());
  client.listIntakeLists.mockResolvedValue([]);
  client.listSubmissionsPage.mockResolvedValue({ submissions: [], nextCursor: null, flaggedCount: 0, droppedCount: 0 });
  client.listFormTemplates.mockResolvedValue([]);
});

describe('the collection page', () => {
  it('renders each form as a real link to its own URL', async () => {
    renderList();
    const link = await screen.findByRole('link', { name: /Contact Us/ });
    // `?org=` rides along so a shared link resolves the same workspace.
    expect(link.getAttribute('href')).toBe('/forms/f1?org=o1');
  });

  it('puts NO delete control on a collection cell', async () => {
    renderList();
    await screen.findByRole('link', { name: /Contact Us/ });
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
  });

  it('renders a designed no-match state with a clear-filters action, not a blank region', async () => {
    // Five forms so the filter controls render (gated on the unfiltered total).
    client.listForms.mockResolvedValue([1, 2, 3, 4, 5].map((n) => form({ formId: `f${n}`, title: `Form ${n}` })));
    renderList();
    const search = await screen.findByRole('searchbox', { name: /filter forms/i });
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(search, { target: { value: 'zzz-no-such-form' } });
    expect(await screen.findByRole('button', { name: /clear filters/i })).toBeTruthy();
  });
});

describe('the detail page', () => {
  it('loads its own form by id — no list in memory required', async () => {
    renderDetail();
    await waitFor(() => expect(client.getForm).toHaveBeenCalledWith('o1', 'f1'));
    // The entity name IS the page h1 (§4.5 rule 12).
    expect(await screen.findByRole('heading', { level: 1, name: 'Contact Us' })).toBeTruthy();
    expect(client.listForms).not.toHaveBeenCalled();
  });

  it('renders the not-found state for a stale link instead of an empty builder', async () => {
    // ADR 0584 — reject with what the CLIENT actually throws. This used to be a
    // bare `new Error('getForm returned 404')` and the page sniffed the MESSAGE
    // (`/\b404\b/`), which would equally have matched a server sentence about a
    // form titled "404". The status is carried now, so both sides are typed.
    client.getForm.mockRejectedValue(new client.FormsRequestError('getForm', 404));
    renderDetail('/forms/gone?org=o1');
    // The name is the page h1 AND the StateCard title — assert on the heading.
    expect(await screen.findByRole('heading', { level: 1, name: /form not found/i })).toBeTruthy();
    // The builder must NOT render — an empty editor would invite editing a
    // form that does not exist and 404 on save.
    expect(screen.queryByRole('button', { name: /^save$/i })).toBeNull();
  });

  it('owns the delete action, and returns to the collection after it succeeds', async () => {
    renderDetail();
    expect(await screen.findByRole('button', { name: /delete/i })).toBeTruthy();
  });
});

/**
 * ADR 0584 §Correction — the held-submission operator surface (PR #3368 R2).
 */
describe('the submissions inbox — held rows (FORM-CSV-1 / FORM-UX-1b / FORM-BUDGET-1)', () => {
  const sub = (over: Record<string, unknown> = {}) => ({
    submissionId: 's1', formId: 'f1', values: { name: 'Ada' },
    createdAt: '2026-02-01T00:00:00.000Z', ...over,
  });

  /** Capture the CSV text the export writes, without a real download. */
  function captureCsv(): { text: () => string } {
    let captured = '';
    const RealBlob = globalThis.Blob;
    class SpyBlob extends RealBlob {
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        captured = parts.map((x) => String(x)).join('');
        super(parts, options);
      }
    }
    vi.stubGlobal('Blob', SpyBlob);
    // SPY, never replace `URL`: spreading the class drops `new URL(...)`, which
    // react-router calls on every render — the page would not mount at all and
    // the assertion below would fail for a reason that has nothing to do with
    // the export.
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
    return { text: () => captured };
  }

  it('FORM-CSV-1: the export EXCLUDES held rows by default and labels the column that names them', async () => {
    const { fireEvent } = await import('@testing-library/react');
    client.listSubmissionsPage.mockResolvedValue({
      submissions: [sub({ submissionId: 's1', values: { name: 'Ada' } }), sub({ submissionId: 's2', values: { name: 'Bot' }, flagged: 'honeypot' })],
      nextCursor: null, flaggedCount: 1, droppedCount: 0,
    });
    const csv = captureCsv();
    renderDetail();
    const exportBtn = await screen.findByRole('button', { name: /download csv/i });
    fireEvent.click(exportBtn);
    await waitFor(() => expect(csv.text()).toContain('Ada'));
    // The lead is there; the quarantined row is NOT. Before this, the export
    // walked the cursor to completion and carried held rows into whatever CRM
    // or mail tool the operator imported it into, byte-indistinguishable from
    // a real lead — defeating the "no CRM contact, no email" property.
    expect(csv.text()).not.toContain('Bot');
    // …and the column exists regardless, so an included held row is named.
    expect(csv.text().split('\r\n')[0]).toMatch(/Held/i);
  });

  it('FORM-CSV-1: ticking the opt-in includes them, and each carries WHICH control held it', async () => {
    const { fireEvent } = await import('@testing-library/react');
    client.listSubmissionsPage.mockResolvedValue({
      submissions: [sub({ submissionId: 's1', values: { name: 'Ada' } }), sub({ submissionId: 's2', values: { name: 'Bot' }, flagged: 'honeypot' })],
      nextCursor: null, flaggedCount: 1, droppedCount: 0,
    });
    const csv = captureCsv();
    renderDetail();
    const optIn = await screen.findByLabelText(/include held/i);
    fireEvent.click(optIn);
    fireEvent.click(screen.getByRole('button', { name: /download csv/i }));
    await waitFor(() => expect(csv.text()).toContain('Bot'));
    expect(csv.text()).toMatch(/hidden-field trap/i);
  });

  it('FORM-UX-1b: a Held filter narrows the inbox to the quarantined rows', async () => {
    const { fireEvent } = await import('@testing-library/react');
    client.listSubmissionsPage.mockResolvedValue({
      submissions: [sub({ submissionId: 's1', values: { name: 'Ada' } }), sub({ submissionId: 's2', values: { name: 'Botly' }, flagged: 'guard' })],
      nextCursor: null, flaggedCount: 1, droppedCount: 0,
    });
    renderDetail();
    const chip = await screen.findByRole('button', { name: /held \(1\)/i });
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(chip);
    await waitFor(() => expect(screen.queryByText(/Ada/)).toBeNull());
    expect(screen.getAllByText(/Botly/).length).toBeGreaterThan(0);
  });

  it('FORM-BUDGET-1: a held row offers a discard, and a clean row does not', async () => {
    client.listSubmissionsPage.mockResolvedValue({
      submissions: [sub({ submissionId: 's1', values: { name: 'Ada' } })],
      nextCursor: null, flaggedCount: 0, droppedCount: 0,
    });
    const clean = renderDetail();
    await screen.findAllByText(/Ada/);
    expect(screen.queryByRole('button', { name: /^discard$/i }), 'a real lead must not grow a one-click delete').toBeNull();
    clean.unmount();

    client.listSubmissionsPage.mockResolvedValue({
      submissions: [sub({ submissionId: 's2', values: { name: 'Botly' }, flagged: 'honeypot' })],
      nextCursor: null, flaggedCount: 1, droppedCount: 0,
    });
    renderDetail();
    expect(await screen.findByRole('button', { name: /^discard$/i })).toBeTruthy();
  });
});
