/**
 * Row 29 `/grade-ux` Blockers (ADR 0847, `ENT3UX-1..4`) — the Entities page:
 *  - offers only what the viewer may do (server-computed `viewer`);
 *  - edits an existing type's fields, and confirms a removal (hide, not delete);
 *  - confirms before making a type public, then shows where it is public;
 *  - shows a failed row read as an error, never as "no records yet".
 *
 * Sabotage-witnessed (w52): canWrite/canManageTypes swapped on a control (now
 * seen by the mixed viewers), the read-only hint dropped, the removal / public
 * confirms skipped, the public address hidden, the rows / relationships /
 * taxonomy failure states dropped, the stored-enum round-trip, the root filter.
 * ENT-TAX-ADD-ON-FAIL-1 is pinned below as `it.fails` (TaxonomyPanel.tsx:158).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

type Client = typeof import('../entitiesClient.js');
const m = vi.hoisted(() => ({
  listEntityTypesForViewer: vi.fn<Client['listEntityTypesForViewer']>(), listRelationships: vi.fn<Client['listRelationships']>(),
  listEntities: vi.fn<Client['listEntities']>(), updateEntityType: vi.fn<Client['updateEntityType']>(),
  listTaxonomies: vi.fn<Client['listTaxonomies']>(), getEntityLocaleContext: vi.fn<Client['getEntityLocaleContext']>(),
  confirm: vi.fn<typeof import('../../../ui/confirm.js')['confirm']>(),
}));
vi.mock('../entitiesClient.js', async (orig) => ({
  ...(await orig<typeof import('../entitiesClient.js')>()),
  listEntityTypesForViewer: m.listEntityTypesForViewer,
  listRelationships: m.listRelationships,
  listEntities: m.listEntities,
  updateEntityType: m.updateEntityType,
  listTaxonomies: m.listTaxonomies,
  getEntityLocaleContext: m.getEntityLocaleContext,
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: m.confirm }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, status: 'on', isBeta: false, variant: null }),
}));

import { EntitiesPage } from '../EntitiesPage.js';
import { TaxonomyPanel } from '../TaxonomyPanel.js';
import type { EntityRow, EntityType } from '../entitiesClient.js';

const TYPE: EntityType = {
  typeId: 'ws:x::article', tenantId: 'ws:x', projectId: '', name: 'article', displayName: 'Article',
  status: 'published', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  fields: [
    { key: 'title', label: 'Title', type: 'string', required: true },
    { key: 'notes', label: 'Notes', type: 'string', required: false },
  ],
};
const ROW: EntityRow = { entityId: 'e1', typeId: TYPE.typeId, values: { title: 'Hello' }, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };

const renderPage = (): void => { render(<MemoryRouter><EntitiesPage /></MemoryRouter>); };

beforeEach(() => {
  m.listRelationships.mockResolvedValue([]);
  m.listTaxonomies.mockResolvedValue([]);
  m.getEntityLocaleContext.mockResolvedValue({ enabled: false });
  m.listEntities.mockResolvedValue({ entities: [ROW] });
  m.updateEntityType.mockResolvedValue(TYPE);
  m.confirm.mockResolvedValue(true);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('ENT3UX-2 — a reader is offered no write', () => {
  it('a viewer with neither capability sees no write control and is told why', async () => {
    m.listEntityTypesForViewer.mockResolvedValue({ types: [TYPE], viewer: { canWrite: false, canManageTypes: false } });
    renderPage();
    await screen.findByText('Hello');
    for (const name of [/new record/i, /edit fields/i, /unpublish/i, /delete type/i, /enable public read/i, /import ndjson/i]) {
      expect(screen.queryByRole('button', { name }), String(name)).toBeNull();
    }
    expect(screen.queryByText(/import ndjson/i)).toBeNull();
    expect(screen.queryByRole('columnheader', { name: /actions/i })).toBeNull();
    expect(screen.getByText(/ask a workspace admin/i)).toBeTruthy();
  });

  it('an admin is offered them (the exit)', async () => {
    m.listEntityTypesForViewer.mockResolvedValue({ types: [TYPE], viewer: { canWrite: true, canManageTypes: true } });
    renderPage();
    await screen.findByText('Hello');
    expect(screen.getByRole('button', { name: /edit fields/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /enable public read/i })).toBeTruthy();
  });

  // The two capabilities gate DIFFERENT controls. With only both-false and
  // both-true viewers, swapping one flag for the other on a control could not
  // be seen (w52 probe ent-mixed was vacuous); the mixed viewers below can.
  it('canWrite only: records may be written, the content model may not', async () => {
    m.listEntityTypesForViewer.mockResolvedValue({ types: [TYPE], viewer: { canWrite: true, canManageTypes: false } });
    renderPage();
    await screen.findByText('Hello');
    expect(screen.getByRole('button', { name: /new record/i })).toBeTruthy();
    // (Per-RECORD publish/unpublish is a write, so `/unpublish/i` is not a type control here.)
    for (const name of [/edit fields/i, /delete type/i, /enable public read/i]) {
      expect(screen.queryByRole('button', { name }), String(name)).toBeNull();
    }
  });

  it('canManageTypes only: the content model may change, records may not', async () => {
    m.listEntityTypesForViewer.mockResolvedValue({ types: [TYPE], viewer: { canWrite: false, canManageTypes: true } });
    renderPage();
    await screen.findByText('Hello');
    expect(screen.getByRole('button', { name: /edit fields/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /enable public read/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /new record/i })).toBeNull();
  });
});

describe('ENT3UX-1 — the content model is editable, and removal is confirmed', () => {
  it('removing a field asks first, then saves the remaining fields', async () => {
    m.listEntityTypesForViewer.mockResolvedValue({ types: [TYPE], viewer: { canWrite: true, canManageTypes: true } });
    renderPage();
    await screen.findByText('Hello');
    fireEvent.click(screen.getByRole('button', { name: /edit fields/i }));
    const removes = await screen.findAllByRole('button', { name: /remove field/i });
    fireEvent.click(removes[1]!); // drop `notes`
    fireEvent.click(screen.getByRole('button', { name: /save fields/i }));
    await waitFor(() => expect(m.updateEntityType).toHaveBeenCalled());
    expect(m.confirm).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('Notes') }));
    expect(m.updateEntityType.mock.calls[0]![1].fields?.map((f) => f.key)).toEqual(['title']);
  });

  it('a declined confirm saves nothing', async () => {
    m.listEntityTypesForViewer.mockResolvedValue({ types: [TYPE], viewer: { canWrite: true, canManageTypes: true } });
    m.confirm.mockResolvedValue(false);
    renderPage();
    await screen.findByText('Hello');
    fireEvent.click(screen.getByRole('button', { name: /edit fields/i }));
    fireEvent.click((await screen.findAllByRole('button', { name: /remove field/i }))[1]!);
    fireEvent.click(screen.getByRole('button', { name: /save fields/i }));
    await waitFor(() => expect(m.confirm).toHaveBeenCalled());
    expect(m.updateEntityType).not.toHaveBeenCalled();
  });
});

describe('ENT3UX-3 — going public is confirmed, and the address is shown', () => {
  it('a declined confirm leaves the type private', async () => {
    m.listEntityTypesForViewer.mockResolvedValue({ types: [TYPE], viewer: { canWrite: true, canManageTypes: true } });
    m.confirm.mockResolvedValue(false);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /enable public read/i }));
    await waitFor(() => expect(m.confirm).toHaveBeenCalled());
    expect(m.updateEntityType).not.toHaveBeenCalled();
  });

  it('a public type shows its delivery address', async () => {
    m.listEntityTypesForViewer.mockResolvedValue({ types: [{ ...TYPE, publicRead: true }], viewer: { canWrite: true, canManageTypes: true } });
    renderPage();
    expect((await screen.findByText(/public-entities\/ws%3Ax\/types\/article\/entities/)).tagName).toBe('CODE');
  });
});

describe('ENT3UX-4 — a failed read is an error, never an empty state', () => {
  it('a failed row read shows the error and a retry, not "no records yet"', async () => {
    m.listEntityTypesForViewer.mockResolvedValue({ types: [TYPE], viewer: { canWrite: true, canManageTypes: true } });
    m.listEntities.mockRejectedValueOnce(new Error('boom'));
    renderPage();
    await screen.findByText(/could not load the records/i);
    expect(screen.queryByText(/no records yet/i)).toBeNull();
    m.listEntities.mockResolvedValue({ entities: [ROW] });
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await screen.findByText('Hello');
  });

  it('a failed relationships read says so', async () => {
    m.listEntityTypesForViewer.mockResolvedValue({ types: [TYPE], viewer: { canWrite: true, canManageTypes: true } });
    m.listRelationships.mockRejectedValue(new Error('down'));
    renderPage();
    await screen.findByText(/could not load relationships/i);
    // The Notice (and its Retry) sits inside the collapsed Relationships <details>.
    expect(screen.getAllByRole('button', { name: /try again/i, hidden: true }).length).toBeGreaterThan(0);
  });
});

describe('TaxonomyPanel — read-only for readers, error-first on a failed read', () => {
  it('without canManage there is no authoring control', async () => {
    m.listTaxonomies.mockResolvedValue([]);
    render(<TaxonomyPanel canManage={false} />);
    await screen.findByText(/no taxonomies/i);
    expect(screen.queryByRole('button', { name: /add taxonomy/i })).toBeNull();
  });

  it('a failed list read shows an error with a retry, not "no taxonomies"', async () => {
    m.listTaxonomies.mockRejectedValueOnce(new Error('down'));
    render(<TaxonomyPanel canManage />);
    await screen.findByText(/could not load taxonomies/i);
    expect(screen.queryByText(/no taxonomies/i)).toBeNull();
  });

  // ENT-TAX-ADD-ON-FAIL-1 (grade-code, w52) — PINNED DEFECT. TaxonomyPanel.tsx:158
  // renders the "Add taxonomy" form whenever `canManage`, even after the list read
  // FAILED — the form-on-failure family: a create made blind can duplicate a key
  // the user could not see. Round 1 asserted the control was PRESENT (pinning the
  // defect); this asserts the correct behaviour and is expected to fail until the
  // form is gated on `listFailed`. Fix-probe: w52g4-ent-tax-addfail-fix-r2.
  it.fails('does not offer Add taxonomy after a FAILED taxonomy read (ENT-TAX-ADD-ON-FAIL-1)', async () => {
    m.listTaxonomies.mockRejectedValueOnce(new Error('down'));
    render(<TaxonomyPanel canManage />);
    await screen.findByText(/could not load taxonomies/i);
    const add = screen.queryByRole('button', { name: /add taxonomy/i }) as HTMLButtonElement | null;
    expect(add === null || add.disabled).toBe(true);
  });
});

describe('grade-code ENT3CD-3/-4 — the field editor never corrupts a schema', () => {
  it('an unchanged enum whose option contains a comma round-trips as stored', async () => {
    const enumType: EntityType = { ...TYPE, fields: [...TYPE.fields, { key: 'shade', label: 'Shade', type: 'enum', required: false, options: ['Red, dark', 'Blue'] }] };
    m.listEntityTypesForViewer.mockResolvedValue({ types: [enumType], viewer: { canWrite: true, canManageTypes: true } });
    renderPage();
    await screen.findByText('Hello');
    fireEvent.click(screen.getByRole('button', { name: /edit fields/i }));
    fireEvent.click(await screen.findByRole('button', { name: /save fields/i }));
    await waitFor(() => expect(m.updateEntityType).toHaveBeenCalled());
    expect(m.confirm, 'nothing was removed, so nothing to confirm').not.toHaveBeenCalled();
    const shade = m.updateEntityType.mock.calls[0]![1].fields?.find((f) => f.key === 'shade');
    expect(shade?.options).toEqual(['Red, dark', 'Blue']);
  });

  it('the rail lists only workspace-root types (the page is root-scoped)', async () => {
    m.listEntityTypesForViewer.mockResolvedValue({
      types: [TYPE, { ...TYPE, typeId: 'ws:x:p1:secret', projectId: 'p1', name: 'secret', displayName: 'Secret project type' }],
      viewer: { canWrite: true, canManageTypes: true },
    });
    renderPage();
    await screen.findByText('Hello');
    expect(screen.queryByText('Secret project type')).toBeNull();
  });
});
