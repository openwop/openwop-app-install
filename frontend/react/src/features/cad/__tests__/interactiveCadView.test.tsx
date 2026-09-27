/**
 * ADR 0388 §Correction — the CAD editor's view toggle + toolbar states.
 *
 * CAD-V1: the hand-rolled orbit viewer existed but was reachable ONLY from the
 * chat artifact card. `CanvasEditorPage` branches `InteractivePreview` BEFORE
 * `def.Renderer`, and cad supplies both, so `CadContentView` (which owns the
 * 2D/3D toggle) never mounts in the editor — the editing surface was 2D-only.
 *
 * CAD-V2: 3D is READ-ONLY by construction (an orbit camera can't drive
 * footprint dragging). The mode must therefore drop the direct-manipulation
 * chrome AND say it is read-only, rather than presenting a dead gizmo.
 *
 * CAD-V3: one `porting` boolean stamped `aria-busy` on all four export buttons,
 * so any single operation announced four busy controls and named none.
 *
 * CAD-V4: the import affordance is a <label> wrapping a disabled <input>. A
 * <label> can never match `:disabled`, so it rendered fully live while inert.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { InteractiveCad } from '../InteractiveCad.js';
import type { CadDoc } from '../definition.js';

/** A HANGING org-id lookup, so a started operation stays observably in-flight.
 *  The STL/GLB paths are synchronous inside their promise (no await before the
 *  `finally`), so React never commits a busy render for them — asserting on
 *  those would pass vacuously no matter what the component did. The BOM path
 *  awaits `cadOrgId()` first, so gating THAT pins the busy state for real. */
const h = vi.hoisted(() => ({ release: null as null | ((v: string | null) => void) }));
vi.mock('../meshStore.js', async () => {
  // Never enumerate a module mock — spread the real one and override the seam.
  const actual = await vi.importActual<typeof import('../meshStore.js')>('../meshStore.js');
  return { ...actual, cadOrgId: () => new Promise<string | null>((res) => { h.release = res; }) };
});

afterEach(() => { h.release = null; cleanup(); });

const doc: CadDoc = {
  name: 'Bracket',
  units: 'mm',
  solids: [
    { kind: 'box', x: 0, y: 0, z: 0, width: 40, height: 30, depth: 20 },
    { kind: 'sphere', x: 60, y: 0, z: 0, radius: 12 },
  ],
};

function view(): { container: HTMLElement; patchElement: ReturnType<typeof vi.fn> } {
  const patchElement = vi.fn();
  const el = (
    <InteractiveCad
      doc={doc}
      selection={{ col: 'solids', idx: 0 }}
      onSelect={vi.fn()}
      onClearSelection={vi.fn()}
      selectedIndices={() => []}
      onSetSelection={vi.fn()}
      patchElement={patchElement}
      patchElements={vi.fn()}
      deleteElements={vi.fn(() => 0)}
    />
  );
  const { container } = render(
    // A real route — `downloadBom` bails on a missing `:canvasId`, so a bare
    // MemoryRouter would make every BOM assertion below vacuous.
    <MemoryRouter initialEntries={['/cad/c1']}>
      <Routes><Route path="/cad/:canvasId" element={el} /></Routes>
    </MemoryRouter>,
  );
  return { container, patchElement };
}

const EXPORTS = ['Export STL', 'Export GLB', 'Export PNG', 'BOM (CSV)'] as const;
const busyNames = (): string[] =>
  EXPORTS.filter((n) => screen.getByRole('button', { name: n }).getAttribute('aria-busy') === 'true');

const toggle = (): HTMLElement => screen.getByRole('group', { name: 'Model view' });

describe('CAD-V1 — the editor reaches the 3D orbit view', () => {
  it('offers a 2D/3D toggle in the editor toolbar, defaulting to 2D', () => {
    view();
    const g = toggle();
    expect(within(g).getByRole('button', { name: '2D' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(g).getByRole('button', { name: '3D' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('switching to 3D swaps the interactive surface for the orbit view', async () => {
    const { container } = view();
    // The 2D surface is the direct-manipulation SVG.
    expect(container.querySelector('.cv-draw-interactive__svg')).toBeTruthy();

    fireEvent.click(within(toggle()).getByRole('button', { name: '3D' }));

    // Cad3dView is lazy — the wrapper mounts immediately, the SVG after resolve.
    const wrap = container.querySelector('.cv-draw-interactive__view3d');
    expect(wrap).toBeTruthy();
    expect(await screen.findByRole('img', { name: /orbit view/i })).toBeTruthy();
    // …and the 2D editing surface is gone (not merely hidden behind it).
    expect(container.querySelector('.cv-draw-interactive__svg')).toBeNull();
  });
});

describe('CAD-V2 — 3D is honestly presented as read-only', () => {
  it('drops the direct-manipulation chrome and says why', async () => {
    const { container } = view();
    // A selection is active, so 2D shows the hit layer + gizmo handles.
    expect(container.querySelector('.cv-draw-interactive__hit')).toBeTruthy();

    fireEvent.click(within(toggle()).getByRole('button', { name: '3D' }));
    await screen.findByRole('img', { name: /orbit view/i });

    // No dead affordances: no hit targets, no gizmo, no selection pill.
    expect(container.querySelector('.cv-draw-interactive__hit')).toBeNull();
    expect(container.querySelector('.cv-draw-interactive__handle')).toBeNull();
    expect(container.querySelector('.cv-selection-pill-anchor')).toBeNull();
    // And the mode states the constraint + names the editing path that remains.
    const note = screen.getByRole('note');
    expect(note.textContent).toMatch(/read-only/i);
    expect(note.textContent).toMatch(/property panel/i);
  });

  it('returning to 2D restores the editing surface', async () => {
    const { container } = view();
    fireEvent.click(within(toggle()).getByRole('button', { name: '3D' }));
    await screen.findByRole('img', { name: /orbit view/i });
    fireEvent.click(within(toggle()).getByRole('button', { name: '2D' }));
    expect(container.querySelector('.cv-draw-interactive__svg')).toBeTruthy();
    expect(container.querySelector('.cv-draw-interactive__hit')).toBeTruthy();
  });
});

describe('CAD-V3 — the busy state names which operation is running', () => {
  it('no export button is busy, and nothing is announced, at rest', () => {
    view();
    expect(busyNames()).toEqual([]);
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('marks ONLY the running control busy and announces it by name', () => {
    view();
    fireEvent.click(screen.getByRole('button', { name: 'BOM (CSV)' }));

    // The defect this pins: one `porting` boolean set aria-busy on all four.
    expect(busyNames()).toEqual(['BOM (CSV)']);
    // A bare "busy" names nothing — the live region carries the subject.
    expect(screen.getByRole('status').textContent).toBe('Generating the bill of materials…');
  });

  it('clears the busy state when the operation settles', async () => {
    view();
    fireEvent.click(screen.getByRole('button', { name: 'BOM (CSV)' }));
    expect(busyNames()).toEqual(['BOM (CSV)']);
    // Resolve with no org — downloadBom toasts and unwinds through its finally.
    h.release?.(null);
    await vi.waitFor(() => expect(busyNames()).toEqual([]));
    expect(screen.getByRole('status').textContent).toBe('');
  });
});

describe('CAD-V4 — the import label carries a disabled state a <label> can hold', () => {
  it('is interactive at rest', () => {
    const { container } = view();
    const label = container.querySelector('label.btn-ghost') as HTMLElement;
    expect(label).toBeTruthy();
    expect(label.getAttribute('aria-disabled')).toBeNull();
    expect(label.className).not.toContain('is-disabled');
    expect((label.querySelector('input') as HTMLInputElement).disabled).toBe(false);
  });

  it('reports disabled while another operation runs', () => {
    const { container } = view();
    fireEvent.click(screen.getByRole('button', { name: 'BOM (CSV)' }));

    const label = container.querySelector('label.btn-ghost') as HTMLElement;
    // The input's `disabled` is what actually blocks the file picker…
    expect((label.querySelector('input') as HTMLInputElement).disabled).toBe(true);
    // …and THESE are the only disabled signals a <label> can carry, because it
    // can never match `:disabled`. Without them the control rendered fully live
    // — undimmed, hover-lit — while silently eating the click.
    expect(label.getAttribute('aria-disabled')).toBe('true');
    expect(label.className).toContain('is-disabled');
  });
});
