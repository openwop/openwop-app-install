/**
 * ADR 0314 — the creation gallery under test: canvas-type cards render only
 * for enabled toggles, creating a canvas lands in its editor, the From-canvas
 * picker materializes a real row (no raw-id input), and the project select
 * rides ownerSubject on document creation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const navSpy = vi.fn();
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('react-router-dom', async (importOriginal) => {
  const orig = await importOriginal<typeof import('react-router-dom')>();
  return { ...orig, useNavigate: () => navSpy };
});

const access = vi.hoisted(() => ({ enabled: new Set<string>(['documents']) }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: (id: string) => makeFeatureAccess({ enabled: access.enabled.has(id), status: 'on', isBeta: false, variant: null, loading: false }),
}));

const docsApi = vi.hoisted(() => ({
  createDocument: vi.fn(),
  materializeFromCanvas: vi.fn(),
  listCanvasSources: vi.fn(),
}));
vi.mock('../documentsClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../documentsClient.js')>();
  return {
    ...orig,
    createDocument: docsApi.createDocument,
    materializeFromCanvas: docsApi.materializeFromCanvas,
    listCanvasSources: docsApi.listCanvasSources,
    listTemplates: vi.fn().mockResolvedValue([]),
    listCatalog: vi.fn().mockResolvedValue([]),
  };
});

const canvasApi = vi.hoisted(() => ({
  basePaths: [] as string[],
  createCanvas: vi.fn(),
  listPackCanvasTypes: vi.fn(),
}));
vi.mock('../../../canvas/canvasClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../canvas/canvasClient.js')>();
  return {
    ...orig,
    listPackCanvasTypes: canvasApi.listPackCanvasTypes,
    createCanvasClient: (opts: { basePath: string }) => {
      canvasApi.basePaths.push(opts.basePath);
      return { createCanvas: canvasApi.createCanvas } as unknown as ReturnType<typeof orig.createCanvasClient>;
    },
  };
});

vi.mock('../../projects/projectsClient.js', () => ({
  listProjects: vi.fn().mockResolvedValue([{ id: 'proj-1', name: 'Apollo' }]),
}));

import { NewDocumentModal } from '../NewDocumentModal.js';

afterEach(cleanup);
beforeEach(() => {
  access.enabled = new Set(['documents']);
  navSpy.mockReset();
  canvasApi.basePaths = [];
  // Mutate the SAME fn instances the mock factories captured — reassigning the
  // properties would orphan the module's references.
  canvasApi.createCanvas.mockReset().mockResolvedValue({ canvasId: 'c-1', canvasTypeId: 'canvas.slides', state: {}, version: 1 });
  canvasApi.listPackCanvasTypes.mockReset().mockResolvedValue([]);
  docsApi.createDocument.mockReset().mockResolvedValue({ documentId: 'doc-1' });
  docsApi.materializeFromCanvas.mockReset().mockResolvedValue({ documentId: 'doc-2', versionId: 'v1', created: true });
  docsApi.listCanvasSources.mockReset().mockResolvedValue({ canvases: [], total: 0 });
});

function mount(onCreated = vi.fn(), onClose = vi.fn()): { onCreated: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> } {
  render(
    <MemoryRouter>
      <NewDocumentModal orgId="org1" onClose={onClose} onCreated={onCreated} />
    </MemoryRouter>,
  );
  return { onCreated, onClose };
}

describe('creation gallery (choose step)', () => {
  // DOCNEW-1 (grade-ux): every first-party type stays VISIBLE — enabled types
  // are interactive cards; off-toggle types render as non-interactive cards
  // with the "Off" chip, never silently hidden.
  it('renders enabled types as buttons and off-toggle types as inert Off cards', async () => {
    access.enabled = new Set(['documents', 'slides', 'drawings']);
    mount();
    expect(await screen.findByRole('button', { name: /Slide deck/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Drawing/ })).toBeTruthy();
    // Off types are visible but NOT buttons, and carry the Off chip.
    expect(screen.queryByRole('button', { name: /CAD model/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Campaign plan/ })).toBeNull();
    expect(screen.getByText('CAD model')).toBeTruthy();
    expect(screen.getByText('Campaign plan')).toBeTruthy();
    expect(screen.getAllByText('Off').length).toBeGreaterThanOrEqual(2);
    // The Write + Reuse groups are always present.
    expect(screen.getByRole('button', { name: /Text document/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /From a canvas/ })).toBeTruthy();
  });

  it('keeps the Design group visible (all cards Off) when no canvas type is enabled', () => {
    mount();
    expect(screen.getByText('Design')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Slide deck/ })).toBeNull();
    expect(screen.getByText('Slide deck')).toBeTruthy();
  });

  it('lists pack types as cards when canvas-packs is enabled', async () => {
    access.enabled = new Set(['documents', 'canvas-packs']);
    canvasApi.listPackCanvasTypes.mockResolvedValue([{ canvasTypeId: 'canvas.checklist', title: 'Checklist' }]);
    mount();
    expect(await screen.findByRole('button', { name: /Checklist/ })).toBeTruthy();
  });
});

describe('creating a canvas', () => {
  it('names it, creates against the type base path, and opens its editor', async () => {
    access.enabled = new Set(['documents', 'slides']);
    const { onClose } = mount();
    fireEvent.click(await screen.findByRole('button', { name: /Slide deck/ }));
    fireEvent.change(screen.getByPlaceholderText(/Q3 launch pitch/), { target: { value: 'Board pitch' } });
    fireEvent.click(screen.getByRole('button', { name: /Create and open/ }));
    await waitFor(() => expect(canvasApi.createCanvas).toHaveBeenCalledWith('org1', { name: 'Board pitch' }));
    expect(canvasApi.basePaths).toContain('/host/openwop-app/slides');
    expect(navSpy).toHaveBeenCalledWith('/slides/c-1');
    expect(onClose).toHaveBeenCalled();
  });

  it('passes the selected project as projectId', async () => {
    access.enabled = new Set(['documents', 'cad', 'projects']);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /CAD model/ }));
    fireEvent.change(screen.getByPlaceholderText(/Q3 launch pitch/), { target: { value: 'Bracket' } });
    const select = await screen.findByLabelText(/Add to project/);
    fireEvent.change(select, { target: { value: 'proj-1' } });
    fireEvent.click(screen.getByRole('button', { name: /Create and open/ }));
    await waitFor(() => expect(canvasApi.createCanvas).toHaveBeenCalledWith('org1', { name: 'Bracket', projectId: 'proj-1' }));
    expect(navSpy).toHaveBeenCalledWith('/cad/c-1');
  });
});

describe('from a canvas (the picker)', () => {
  it('lists the tenant canvases and materializes the clicked one', async () => {
    docsApi.listCanvasSources.mockResolvedValue({
      canvases: [{ canvasId: 'c-9', canvasTypeId: 'canvas.slides', name: 'Q3 deck', version: 4, updatedAt: '2026-07-01T10:00:00Z' }],
      total: 1,
    });
    const { onCreated } = mount();
    fireEvent.click(await screen.findByRole('button', { name: /From a canvas/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Q3 deck/ }));
    await waitFor(() => expect(docsApi.materializeFromCanvas).toHaveBeenCalledWith('org1', 'c-9'));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it('shows the empty-state invitation when there are no canvases', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /From a canvas/ }));
    expect(await screen.findByText('No canvases yet')).toBeTruthy();
  });
});

describe('blank document + project', () => {
  it('creates with ownerSubject when a project is selected', async () => {
    access.enabled = new Set(['documents', 'projects']);
    const { onCreated } = mount();
    fireEvent.click(await screen.findByRole('button', { name: /Text document/ }));
    fireEvent.change(screen.getByPlaceholderText(/Statement of Work/), { target: { value: 'SOW Alpha' } });
    const select = await screen.findByLabelText(/Add to project/);
    fireEvent.change(select, { target: { value: 'proj-1' } });
    fireEvent.click(screen.getByRole('button', { name: /New document/i }));
    await waitFor(() => expect(docsApi.createDocument).toHaveBeenCalledWith('org1', {
      title: 'SOW Alpha', kind: 'sow', ownerSubject: { kind: 'project', id: 'proj-1' },
    }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });
});
