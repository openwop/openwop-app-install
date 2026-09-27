/**
 * CADU-1 — the CAD 3D pane needs a CAD-LOCAL ErrorBoundary. `Cad3dView` is a
 * lazy orbit viewer inside a `<Suspense>` (which catches the lazy PROMISE, not a
 * render THROW). Without a boundary, a projection/render crash propagates to the
 * page boundary and blanks the WHOLE editor. This pins that a 3D render crash
 * degrades ONLY the 3D pane (a fallback in the pane) while the editor chrome (the
 * 2D/3D toggle, the rails) survives.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { InteractiveCad } from '../InteractiveCad.js';
import type { CadDoc } from '../definition.js';

vi.mock('../meshStore.js', async () => {
  const actual = await vi.importActual<typeof import('../meshStore.js')>('../meshStore.js');
  return { ...actual, cadOrgId: () => Promise.resolve(null) };
});
// The lazy 3D viewer throws on render — the CADU-1 boundary must catch it.
vi.mock('../Cad3dView.js', () => ({ Cad3dView: () => { throw new Error('boom-3d-render'); } }));

afterEach(cleanup);

const doc: CadDoc = {
  name: 'Bracket', units: 'mm',
  solids: [{ kind: 'box', x: 0, y: 0, z: 0, width: 40, height: 30, depth: 20 }],
};

function render3d(): void {
  const el = (
    <InteractiveCad
      doc={doc}
      selection={{ col: 'solids', idx: 0 }}
      onSelect={vi.fn()}
      onClearSelection={vi.fn()}
      selectedIndices={() => []}
      onSetSelection={vi.fn()}
      patchElement={vi.fn()}
      patchElements={vi.fn()}
      deleteElements={vi.fn(() => 0)}
    />
  );
  render(
    <MemoryRouter initialEntries={['/cad/c1']}>
      <Routes><Route path="/cad/:canvasId" element={el} /></Routes>
    </MemoryRouter>,
  );
}
const toggle = (): HTMLElement => screen.getByRole('group', { name: 'Model view' });

describe('CADU-1 — a CAD-local ErrorBoundary around the 3D pane', () => {
  it('a 3D render crash degrades ONLY the 3D pane; the editor chrome survives', async () => {
    render3d();
    fireEvent.click(within(toggle()).getByRole('button', { name: '3D' }));
    // The boundary catches the lazy viewer's render throw → the pane shows the fallback…
    expect(await screen.findByText(/could not be rendered/i)).toBeTruthy();
    // …the fallback offers a recovery action (not a dead end — check-failure-card-recovery)…
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
    // …and the editor chrome (the 2D/3D toggle) SURVIVES — the whole editor did not unmount.
    expect(within(toggle()).getByRole('button', { name: '2D' })).toBeTruthy();
  });
});
