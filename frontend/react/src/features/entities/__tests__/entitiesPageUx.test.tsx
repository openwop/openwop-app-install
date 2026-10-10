/**
 * Row 29 `/grade-ux` Blockers (ADR 0847, `ENT3UX-1..4`) — the Entities page:
 *  - offers only what the viewer may do (server-computed `viewer`);
 *  - edits an existing type's fields, and confirms a removal (hide, not delete);
 *  - confirms before making a type public, then shows where it is public;
 *  - shows a failed row read as an error, never as "no records yet".
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

const m = vi.hoisted(() => ({
  listEntityTypesForViewer: vi.fn(), listRelationships: vi.fn(), listEntities: vi.fn(), updateEntityType: vi.fn(),
  listTaxonomies: vi.fn(), getEntityLocaleContext: vi.fn(), confirm: vi.fn(),
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

const TYPE = {
  typeId: 'ws:x::article', tenantId: 'ws:x', projectId: '', name: 'article', displayName: 'Article',
  status: 'published' as const, createdAt: '', updatedAt: '',
  fields: [
    { key: 'title', label: 'Title', type: 'string' as const, required: true },
    { key: 'notes', label: 'Notes', type: 'string' as const, required: false },
  ],
};
const ROW = { entityId: 'e1', typeId: TYPE.typeId, values: { title: 'Hello' }, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };

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
    expect(m.updateEntityType.mock.calls[0]![1].fields.map((f: { key: string }) => f.key)).toEqual(['title']);
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
    expect(screen.getByRole('button', { name: /add taxonomy/i })).toBeTruthy();
  });
});

describe('grade-code ENT3CD-3/-4 — the field editor never corrupts a schema', () => {
  it('an unchanged enum whose option contains a comma round-trips as stored', async () => {
    const enumType = { ...TYPE, fields: [...TYPE.fields, { key: 'shade', label: 'Shade', type: 'enum' as const, required: false, options: ['Red, dark', 'Blue'] }] };
    m.listEntityTypesForViewer.mockResolvedValue({ types: [enumType], viewer: { canWrite: true, canManageTypes: true } });
    renderPage();
    await screen.findByText('Hello');
    fireEvent.click(screen.getByRole('button', { name: /edit fields/i }));
    fireEvent.click(await screen.findByRole('button', { name: /save fields/i }));
    await waitFor(() => expect(m.updateEntityType).toHaveBeenCalled());
    expect(m.confirm, 'nothing was removed, so nothing to confirm').not.toHaveBeenCalled();
    const shade = m.updateEntityType.mock.calls[0]![1].fields.find((f: { key: string }) => f.key === 'shade');
    expect(shade.options).toEqual(['Red, dark', 'Blue']);
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
