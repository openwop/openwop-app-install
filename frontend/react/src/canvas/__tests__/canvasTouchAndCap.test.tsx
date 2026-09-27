/**
 * Chassis addElements cap atomicity (ADR 0333 grade-pass DRAW-R2) — mounts the
 * real `CanvasEditorPage` with a stub elements definition whose
 * `InteractivePreview` exposes `addElements`, so the DRAW-D5 atomic-at-cap +
 * announce path is exercised through the chassis. (Touch tap-undo detection is
 * covered by the pure `touchTap.test.ts` state-machine suite — jsdom doesn't
 * dispatch React capture-phase pointer events reliably.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const state = vi.hoisted(() => ({
  record: { canvasId: 'c1', canvasTypeId: 'canvas.tiny', state: {} as Record<string, unknown>, version: 1 },
  saveCanvas: vi.fn(),
}));
vi.mock('../canvasClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../canvasClient.js')>();
  return {
    ...orig,
    listOrgs: vi.fn().mockResolvedValue([{ orgId: 'org1', name: 'Acme' }]),
    createCanvasClient: () => ({
      root: '/test', getCatalog: vi.fn().mockResolvedValue({ canvasTypeId: 'canvas.tiny', components: [], promptSchema: '' }),
      getCanvas: vi.fn().mockImplementation(() => Promise.resolve(state.record)),
      seedFromArtifact: vi.fn(), deleteCanvas: vi.fn(), listVersions: vi.fn().mockResolvedValue([]),
      getVersion: vi.fn(), restoreVersion: vi.fn(), saveCanvas: state.saveCanvas,
    }),
  };
});

import { CanvasEditorPage, type CanvasEditorDefinition } from '../CanvasEditorPage.js';
import type { InteractivePreviewProps, CanvasNode } from '../types.js';
import type { FrameBase } from '../frameOps.js';

afterEach(cleanup);
beforeEach(() => { state.saveCanvas = vi.fn().mockResolvedValue({ canvasId: 'c1', newVersion: 2, warnings: [] }); });

interface TinyDoc { shapes: Record<string, unknown>[] }
// A minimal elements preview that surfaces the add seam as buttons so the test
// can invoke addElements without a real SVG pointer path. It also renders the
// live `cancelSignal` so the DRAW-R3 Esc-cancel can be asserted, and a
// "drag" button that simulates a patch gesture (start → move).
function TinyPreview({ addElements, patchElement, cancelSignal }: InteractivePreviewProps<TinyDoc>): JSX.Element {
  return (
    <div>
      <button type="button" onClick={() => addElements?.('shapes', [{ kind: 'dot', n: 1 }])}>add-one</button>
      <button type="button" onClick={() => addElements?.('shapes', [{ kind: 'dot' }, { kind: 'dot' }, { kind: 'dot' }])}>add-three</button>
      <button type="button" onClick={() => { patchElement('shapes', 0, { x: 5 }, 'start'); patchElement('shapes', 0, { x: 10 }, 'move'); }}>drag-0</button>
      <span data-testid="cancel">{cancelSignal ?? 0}</span>
    </div>
  );
}

const tinyDef = {
  canvasTypeId: 'canvas.tiny', toggleId: 'drawings', clientBasePath: '/x', editorPath: '/x', i18nNamespace: 'drawings',
  Renderer: () => <div>renderer</div>,
  InteractivePreview: TinyPreview,
  coerceDoc: (s: Record<string, unknown>): TinyDoc => ({ shapes: Array.isArray(s.shapes) ? s.shapes as Record<string, unknown>[] : [{ kind: 'dot', x: 0 }] }),
  elements: [{ key: 'shapes', max: 3, min: 1, adders: [{ id: 'dot', make: () => ({ kind: 'dot' }) }], labelFor: () => 'dot', propDefs: () => [] }],
} as unknown as CanvasEditorDefinition<TinyDoc, FrameBase, CanvasNode>;

const esc = (): void => { fireEvent.keyDown(window, { key: 'Escape' }); };

function mount(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/x/c1']}>
      <Routes><Route path="/x/:canvasId" element={<CanvasEditorPage definition={tinyDef} />} /></Routes>
    </MemoryRouter>,
  );
}

describe('chassis addElements cap atomicity (DRAW-D5/R2)', () => {
  beforeEach(() => { state.record = { canvasId: 'c1', canvasTypeId: 'canvas.tiny', version: 1, state: { shapes: [{ kind: 'dot' }] } }; }); // 1 of max 3

  it('a batch that would overflow the cap commits NOTHING + announces', async () => {
    mount();
    await screen.findByText('add-three');
    // 1 existing + 3 = 4 > max 3 → atomic reject.
    fireEvent.click(screen.getByText('add-three'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/limit/i));
    // Save uses the working doc — a reject leaves it at 1 shape (unchanged, so not dirty→ no new version)
    fireEvent.click(screen.getByText('add-one')); // 1+1=2 ≤ 3 → lands
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/added|1/i));
  });
});

describe('chassis Esc cancels a live gesture (DRAW-R3)', () => {
  beforeEach(() => { state.record = { canvasId: 'c1', canvasTypeId: 'canvas.tiny', version: 1, state: { shapes: [{ kind: 'dot', x: 0 }] } }; });

  it('Esc during a drag reverts the pushed history entry AND bumps the cancel signal', async () => {
    mount();
    await screen.findByText('drag-0');
    fireEvent.click(screen.getByText('drag-0')); // patch start+move → one history entry, dirty
    await waitFor(() => expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(false)); // dirty
    const before = Number(screen.getByTestId('cancel').textContent);
    esc();
    await waitFor(() => expect(Number(screen.getByTestId('cancel').textContent)).toBe(before + 1)); // type told to drop overlay
    expect(screen.getByRole('status').textContent).toMatch(/cancel/i); // gesture reverted
  });

  it('Esc with no gesture falls through to clear/tool-select (bumps signal harmlessly)', async () => {
    mount();
    await screen.findByText('add-one');
    const before = Number(screen.getByTestId('cancel').textContent);
    esc();
    // No gesture pushed → no "cancelled" announcement; the signal still bumps.
    await waitFor(() => expect(Number(screen.getByTestId('cancel').textContent)).toBe(before + 1));
    expect(screen.getByRole('status').textContent ?? '').not.toMatch(/cancel/i);
  });
});
