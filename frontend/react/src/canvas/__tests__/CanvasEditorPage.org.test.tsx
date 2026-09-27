/**
 * GC-AB-1 — the editor opens the org the LINK names, not `orgs[0]`.
 *
 * The API is `/orgs/:orgId/canvases/:canvasId` but the route is only
 * `/app-builder/:canvasId`, so the org has to travel on the link. Every canvas
 * surface used to substitute `orgs[0]?.orgId`. For a member of one org that is
 * right by accident; for a member of several the editor asked the WRONG
 * workspace for the canvas, and the 404 surfaced as a generic "could not load"
 * — so the canvas they clicked in Documents was simply unreachable, with
 * nothing on screen to suggest the workspace was the problem.
 *
 * These assert on the ORG THE CLIENT WAS CALLED WITH, not on rendered chrome:
 * the defect is entirely in which workspace gets asked, and a render assertion
 * passes whether or not the right one was.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const state = vi.hoisted(() => ({
  orgs: [{ orgId: 'org1', name: 'Acme' }, { orgId: 'org2', name: 'Beta' }],
  getCanvas: vi.fn(),
  getCatalog: vi.fn(),
}));

vi.mock('../canvasClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../canvasClient.js')>();
  return {
    ...orig,
    listOrgs: vi.fn().mockImplementation(() => Promise.resolve(state.orgs)),
    createCanvasClient: () => ({
      root: '/test',
      getCatalog: state.getCatalog,
      getCanvas: state.getCanvas,
      seedFromArtifact: vi.fn(),
      deleteCanvas: vi.fn(),
      listVersions: vi.fn().mockResolvedValue([]),
      getVersion: vi.fn(),
      restoreVersion: vi.fn(),
      saveCanvas: vi.fn(),
    }),
  };
});

import { CanvasEditorPage } from '../CanvasEditorPage.js';
import { slidesDefinition } from '../../features/slides/definition.js';

afterEach(cleanup);
beforeEach(() => {
  state.orgs = [{ orgId: 'org1', name: 'Acme' }, { orgId: 'org2', name: 'Beta' }];
  state.getCatalog = vi.fn().mockResolvedValue({ canvasTypeId: 'canvas.slides', components: [], promptSchema: '' });
  state.getCanvas = vi.fn().mockResolvedValue({ canvasId: 'c1', canvasTypeId: 'canvas.slides', state: {}, version: 1 });
});

function mount(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/edit/:canvasId" element={<CanvasEditorPage definition={slidesDefinition} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CanvasEditorPage org resolution', () => {
  // THE DEFECT. Before the fix this asked org1 and the canvas was unreachable.
  it('opens the org named on the link, not the first one', async () => {
    mount('/edit/c1?org=org2');
    await waitFor(() => expect(state.getCanvas).toHaveBeenCalled());
    expect(state.getCanvas).toHaveBeenCalledWith('org2', 'c1');
    expect(state.getCatalog).toHaveBeenCalledWith('org2');
  });

  it('asks for nothing when the link omits the org and several are possible', async () => {
    mount('/edit/c1');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Beta' })).toBeTruthy());
    // The important half: it does not go and guess a workspace.
    expect(state.getCanvas).not.toHaveBeenCalled();
    expect(state.getCatalog).not.toHaveBeenCalled();
  });

  it('opens without a picker when the caller has exactly one org', async () => {
    state.orgs = [{ orgId: 'solo', name: 'Solo' }];
    mount('/edit/c1');
    await waitFor(() => expect(state.getCanvas).toHaveBeenCalledWith('solo', 'c1'));
    expect(screen.queryByRole('button', { name: 'Solo' })).toBeNull();
  });

  it('refuses an org the caller is not in, without probing it', async () => {
    mount('/edit/c1?org=org-not-mine');
    await waitFor(() => expect(screen.getByText(/not a member of/i)).toBeTruthy());
    expect(state.getCanvas).not.toHaveBeenCalled();
  });

  it('opens the chosen org after the picker is used', async () => {
    mount('/edit/c1');
    const pick = await screen.findByRole('button', { name: 'Beta' });
    pick.click();
    await waitFor(() => expect(state.getCanvas).toHaveBeenCalledWith('org2', 'c1'));
  });
});
