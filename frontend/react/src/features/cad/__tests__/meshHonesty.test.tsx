/**
 * UX_UPGRADE-cad ROUND 3 — CAD2-M5 + CAD2-M7 (two of R2's known-open items).
 *
 *  - M5: a mesh that failed to load rendered as a fabricated 40 mm cube with
 *    NO disclosure — `pending` was computed and never read, while the sibling
 *    `sampled` badge rendered. The viewer now badges loading (status) and
 *    failure (alert) beside the sampled badge. Both polarities: a ready mesh
 *    shows neither badge.
 *  - M7: `meshStore` took `orgs[0]` from the tenant-wide org list, so a
 *    member of only the SECOND org 403'd on every mesh read forever (and
 *    `??=` memoized even a failed org-list read for the session). `load` now
 *    tries every listed org — first 2xx wins — and a failed list read is
 *    retried on the next call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { __clearMeshCache, ensureMesh } from '../meshStore.js';
import { Cad3dView } from '../Cad3dView.js';

const ORGS = { orgs: [{ orgId: 'org-a' }, { orgId: 'org-b' }] };

/** A minimal binary STL: 80-byte header + uint32 triangle count (1) + one triangle record. */
function stlBytes(): ArrayBuffer {
  const buf = new ArrayBuffer(84 + 50);
  new DataView(buf).setUint32(80, 1, true);
  return buf;
}

const json = (body: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: async () => body, arrayBuffer: async () => stlBytes() }) as unknown as Response;

beforeEach(() => { fetchMock.mockReset(); __clearMeshCache(); });
afterEach(cleanup);

describe('CAD2-M7 — the mesh read works from the SECOND org, and failure is not a session verdict', () => {
  it('a mesh whose meta 403s in org-a is served from org-b', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/orgs') && !url.includes('/cad/')) return json(ORGS);
      if (url.includes('/cad/orgs/org-a/')) return json({ error: 'forbidden' }, 403);
      if (url.includes('/cad/orgs/org-b/meshes/')) return json({ assetId: 'm1', serveUrl: '/serve/m1', triangleCount: 1 });
      if (url.includes('/serve/m1')) return json(null);
      throw new Error(`unexpected ${url}`);
    });
    ensureMesh('m1');
    await waitFor(() => expect(ensureMesh('m1').status).toBe('ready'));
  });

  it('a failed org-list read is retried on the next load, not memoized for the session', async () => {
    fetchMock.mockImplementationOnce(async () => json({ error: 'down' }, 500)); // the org list fails once
    ensureMesh('m2');
    await waitFor(() => expect(ensureMesh('m2').status).toBe('error'));
    // Deliberately NO cache/session reset here — the SESSION memoization is what
    // is under test (the first version of this test cleared it via the seam and
    // passed against the sabotaged fix: a vacuous probe, caught and rewritten).
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/orgs') && !url.includes('/cad/')) return json(ORGS);
      if (url.includes('/cad/orgs/org-a/meshes/')) return json({ assetId: 'm2b', serveUrl: '/serve/m2b', triangleCount: 1 });
      if (url.includes('/serve/m2b')) return json(null);
      throw new Error(`unexpected ${url}`);
    });
    ensureMesh('m2b');
    await waitFor(() => expect(ensureMesh('m2b').status).toBe('ready'));
  });
});

describe('CAD2-M5 — the placeholder box is DISCLOSED, never presented as the part', () => {
  const meshSolid = { kind: 'mesh', assetRef: 'mesh-x', x: 0, y: 0, z: 0 } as never;

  it('a failed mesh renders the failure badge (alert), not a silent cube', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/orgs') && !url.includes('/cad/')) return json(ORGS);
      return json({ error: 'gone' }, 404);
    });
    render(<Cad3dView solids={[meshSolid]} label="scene" />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/placeholder, not the part/i);
  });

  it('while loading, the loading badge shows (status) and the failure badge does not', () => {
    fetchMock.mockImplementation(async () => new Promise<never>(() => { /* never settles */ }));
    render(<Cad3dView solids={[meshSolid]} label="scene" />);
    expect(screen.getByRole('status').textContent).toMatch(/still loading/i);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a ready mesh shows NEITHER badge', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/orgs') && !url.includes('/cad/')) return json(ORGS);
      if (url.includes('/meshes/')) return json({ assetId: 'mesh-x', serveUrl: '/serve/x', triangleCount: 1 });
      if (url.includes('/serve/x')) return json(null);
      throw new Error(`unexpected ${url}`);
    });
    render(<Cad3dView solids={[meshSolid]} label="scene" />);
    await waitFor(() => expect(screen.queryByText(/still loading/i)).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
