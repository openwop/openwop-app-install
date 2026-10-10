/**
 * DOCTPL-19 (review F5) — the PER-FORM origin renderer.
 *
 * `FormDef.originTemplate` is server-stamped at from-template instantiation and
 * the client type's docblock promised "the detail surface can render the
 * origin" — this pins that the promise is kept: a pack-instantiated form SAYS
 * so in the detail header, a hand-authored form claims nothing, and the
 * pack-authored identifier is bidi-ISOLATED (FSI/PDI) so a hostile pack name
 * cannot reorder the trusted copy around it (ADR 0516 §Provenance residual).
 *
 * Sabotages that redden it (grade-tests wave 8): rendering the pack identifier
 * without `bidiIsolate`, dropping the template id from the title, or rendering a
 * chip on a hand-authored form.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { FormDef } from '../formsClient.js';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

/**
 * The ONE typed formsClient double (grade-tests wave 8): the REAL module is
 * spread in — so `FormsRequestError`, `FIELD_TYPES` and the URL helpers are the
 * shipped ones, not hand-kept copies that had drifted (no `number` type, no
 * `reason` on the error) — and every network function is replaced by a
 * `vi.fn` typed against the real signature, so a fixture that contradicts the
 * client type is a compile error rather than a silent green.
 */
type FC = typeof import('../formsClient.js');
const client = vi.hoisted(() => ({
  listOrgs: vi.fn<FC['listOrgs']>(), listForms: vi.fn<FC['listForms']>(), getForm: vi.fn<FC['getForm']>(),
  createForm: vi.fn<FC['createForm']>(), updateForm: vi.fn<FC['updateForm']>(), deleteForm: vi.fn<FC['deleteForm']>(),
  setFormStatus: vi.fn<FC['setFormStatus']>(), listIntakeLists: vi.fn<FC['listIntakeLists']>(),
  listSubmissionsPage: vi.fn<FC['listSubmissionsPage']>(), listSubmissions: vi.fn<FC['listSubmissions']>(),
  deleteSubmission: vi.fn<FC['deleteSubmission']>(), releaseSubmission: vi.fn<FC['releaseSubmission']>(),
  listFormTemplates: vi.fn<FC['listFormTemplates']>(), createFormFromTemplate: vi.fn<FC['createFormFromTemplate']>(),
}));
vi.mock('../formsClient.js', async (orig) => ({ ...(await orig<FC>()), ...client }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));

const { FormDetailPage } = await import('../FormDetailPage.js');

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
  vi.resetAllMocks();
  client.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Org One' }]);
  client.listIntakeLists.mockResolvedValue([]);
  client.listSubmissionsPage.mockResolvedValue({ submissions: [], nextCursor: null, flaggedCount: 0, droppedCount: 0 });
  client.listSubmissions.mockResolvedValue([]);
});

describe('DOCTPL-19 — the per-form origin chip', () => {
  it('a pack-instantiated form names its source, pack identifier bidi-isolated', async () => {
    client.getForm.mockResolvedValue(form({
      originTemplate: { templateId: 'tpl-1', packName: 'vendor.acme.forms', packVersion: '2.1.0' },
    }));
    renderDetail();
    const chip = await screen.findByText((text) => text.includes('vendor.acme.forms@2.1.0'));
    // The pack-authored identifier rides inside FSI…PDI isolates — the
    // plain-string <bdi> equivalent. Assert the ISOLATION, not just presence.
    expect(chip.textContent).toContain('⁨vendor.acme.forms@2.1.0⁩');
    expect(chip.getAttribute('title')).toContain('tpl-1');
  });

  it('a hand-authored form makes NO origin claim', async () => {
    client.getForm.mockResolvedValue(form());
    renderDetail();
    await screen.findByDisplayValue('Contact Us');
    expect(screen.queryByText((text) => text.includes('⁨'))).toBeNull();
    // No chip AT ALL — not merely no isolate (an un-isolated chip passed the line above).
    expect(screen.queryByText(/From template/)).toBeNull();
  });
});
