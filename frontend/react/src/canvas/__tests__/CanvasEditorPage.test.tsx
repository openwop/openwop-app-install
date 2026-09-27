/**
 * Grade pass GC-CV-1 — the chassis under test. Every canvas editor rides
 * `CanvasEditorPage`; until now only its PURE helpers were tested, never the
 * React composition (mode selection, trait wiring, dirty/save, conflict UI,
 * the PreviewPanel mount). These exercise the three trait modes with REAL
 * definitions (slides = frames-only, drawings = elements) plus a synthetic
 * tree definition and the RFC 0130 PreviewPanel path, over a mocked client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// ── the mocked wire (module-level so definitions import the same instance) ──
const state = vi.hoisted(() => ({
  catalog: { canvasTypeId: 'canvas.test', components: [] as unknown[], promptSchema: '' } as Record<string, unknown>,
  record: { canvasId: 'c1', canvasTypeId: 'canvas.test', state: {} as Record<string, unknown>, version: 1 } as {
    canvasId: string;
    canvasTypeId: string;
    state: Record<string, unknown>;
    version: number;
    name?: string;
  },
  saveCanvas: vi.fn(),
  loadError: null as unknown,
}));

vi.mock('../canvasClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../canvasClient.js')>();
  return {
    ...orig,
    listOrgs: vi.fn().mockResolvedValue([{ orgId: 'org1', name: 'Acme' }]),
    createCanvasClient: () => ({
      root: '/test',
      getCatalog: vi.fn().mockImplementation(() => Promise.resolve(state.catalog)),
      getCanvas: vi.fn().mockImplementation(() => (state.loadError ? Promise.reject(state.loadError) : Promise.resolve(state.record))),
      seedFromArtifact: vi.fn(),
      deleteCanvas: vi.fn(),
      listVersions: vi.fn().mockResolvedValue([]),
      getVersion: vi.fn(),
      restoreVersion: vi.fn(),
      saveCanvas: state.saveCanvas,
    }),
  };
});

import { CanvasEditorPage, type CanvasEditorDefinition } from '../CanvasEditorPage.js';
import { treeOps, type TreeNodeBase } from '../treeOps.js';
import { frameOps, type FrameBase } from '../frameOps.js';
import type { CanvasNode } from '../types.js';
import { slidesDefinition } from '../../features/slides/definition.js';
import { drawingsDefinition } from '../../features/drawings/definition.js';
import { cadDefinition } from '../../features/cad/definition.js';

afterEach(cleanup);
beforeEach(() => {
  state.saveCanvas = vi.fn().mockResolvedValue({ canvasId: 'c1', newVersion: 2, warnings: [] });
  state.catalog = { canvasTypeId: 'canvas.test', components: [], promptSchema: '' };
  state.loadError = null;
});

function mount<Doc extends object, F extends FrameBase, N extends TreeNodeBase>(
  definition: CanvasEditorDefinition<Doc, F, N>,
): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/edit/c1']}>
      <Routes>
        <Route path="/edit/:canvasId" element={<CanvasEditorPage definition={definition} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('frames mode (the real slides definition)', () => {
  beforeEach(() => {
    state.record = {
      canvasId: 'c1', canvasTypeId: 'canvas.slides', version: 1,
      state: { title: 'Pitch', slides: [{ layout: 'title', title: 'Hello' }, { layout: 'blank' }] },
    };
  });

  it('renders the frame strip, binds the panel to the active slide, and saves with the read version', async () => {
    const { container } = mount(slidesDefinition);
    // Two slide tabs (coerceDeck synthesized names) + doc name input.
    const tabs = await screen.findAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(container.querySelector('[data-canvas-layout="workbench"]')).toBeTruthy();
    expect(screen.getByLabelText('Canvas status').textContent).toContain('v1');
    expect(screen.getByDisplayValue('Pitch')).toBeTruthy(); // docNameKey='title'
    // Frames-only mode: the property panel is bound to the ACTIVE frame.
    expect(screen.getByLabelText(/Layout/)).toBeTruthy();

    // A discrete edit marks the doc dirty and enables Save.
    fireEvent.change(screen.getByLabelText(/Layout/), { target: { value: 'quote' } });
    const save = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(save);
    await waitFor(() => expect(state.saveCanvas).toHaveBeenCalledTimes(1));
    const [, , savedState, expectedVersion] = state.saveCanvas.mock.calls[0]!;
    expect(expectedVersion).toBe(1);
    expect((savedState as { slides: { layout: string }[] }).slides[0]!.layout).toBe('quote');
  });

  it('adds a frame via the strip and undo reverts it', async () => {
    mount(slidesDefinition);
    await screen.findAllByRole('tab');
    fireEvent.click(screen.getByRole('button', { name: 'Add slide' }));
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it('a stale save (409) surfaces the conflict notice with Reload latest', async () => {
    state.saveCanvas = vi.fn().mockRejectedValue(Object.assign(new Error('conflict'), { status: 409 }));
    mount(slidesDefinition);
    await screen.findAllByRole('tab');
    fireEvent.change(screen.getByLabelText(/Layout/), { target: { value: 'quote' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: 'Reload latest' });
  });

  it('typing in the doc-name input keeps the doc dirty (the GC-CV-2 editGen path)', async () => {
    mount(slidesDefinition);
    await screen.findAllByRole('tab');
    fireEvent.change(screen.getByDisplayValue('Pitch'), { target: { value: 'Pitch v2' } });
    expect(screen.getByText('Unsaved')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('elements mode (the real drawings definition)', () => {
  beforeEach(() => {
    state.record = {
      canvasId: 'c1', canvasTypeId: 'canvas.drawing', version: 1,
      state: { title: 'Scene', width: 400, height: 300, shapes: [{ kind: 'rect', x: 1, y: 2, width: 10, height: 10 }] },
    };
  });

  it('renders the collection list + adders; doc props show when nothing is selected', async () => {
    mount(drawingsDefinition);
    // The shapes section heading + one row (labelled by localized kind).
    expect((await screen.findAllByText('Shapes')).length).toBeGreaterThan(0);
    // Doc-level props (width/height) bound with nothing selected.
    expect(screen.getByLabelText(/Canvas width/)).toBeTruthy();
    // Adder adds + selects; the panel switches to the element's fields.
    fireEvent.click(screen.getByRole('button', { name: 'Circle' }));
    expect(screen.getByLabelText(/Radius/)).toBeTruthy();
    expect(screen.getAllByText(/Circle/).length).toBeGreaterThan(0);
  });

  it('the delete guard tracks the schema minItems (min 1)', async () => {
    const { container } = mount(drawingsDefinition);
    await screen.findAllByText('Shapes');
    // Select the only shape (the LIST row, not the same-named adder) → the
    // Delete element action is disabled at the min.
    fireEvent.click(container.querySelector('.cv-editor__tree-row')!);
    expect((screen.getByRole('button', { name: 'Delete element' }) as HTMLButtonElement).disabled).toBe(true);
    // Add one → the guard lifts (the adder auto-selects the new element).
    // Disambiguate from the same-named toolbar TOOL (ADR 0333 Phase 4): the
    // adder is a plain button (no aria-pressed), the tool is a toggle.
    const adder = screen.getAllByRole('button', { name: 'Line' }).find((b) => !b.hasAttribute('aria-pressed'))!;
    fireEvent.click(adder);
    expect((screen.getByRole('button', { name: 'Delete element' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('the element list is an ARIA-multiselectable listbox: Shift-click + Space build a keyboard multi-selection', async () => {
    state.record = {
      canvasId: 'c1', canvasTypeId: 'canvas.drawing', version: 1,
      state: { title: 'Scene', width: 400, height: 300, shapes: [
        { kind: 'rect', x: 0, y: 0, width: 10, height: 10 },
        { kind: 'circle', cx: 50, cy: 50, r: 10 },
        { kind: 'line', x1: 0, y1: 0, x2: 20, y2: 20 },
      ] },
    };
    mount(drawingsDefinition);
    await screen.findAllByText('Shapes');
    const listbox = screen.getByRole('listbox', { name: 'Shapes' });
    expect(listbox.getAttribute('aria-multiselectable')).toBe('true');
    // Scoped to the listbox — the doc-props panel's native <select> options
    // (ADR 0333 Phase 7 symmetry enum) also carry role=option.
    const opts = within(listbox).getAllByRole('option');
    expect(opts).toHaveLength(3);

    // Click row 0 → single-select (aria-selected + the panel edits it).
    fireEvent.click(opts[0]!);
    expect(opts[0]!.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByLabelText(/^X/)).toBeTruthy(); // single → element fields

    // Shift-click row 2 → added to the set; two selected, panel shows doc props.
    fireEvent.click(opts[2]!, { shiftKey: true });
    expect(opts[0]!.getAttribute('aria-selected')).toBe('true');
    expect(opts[2]!.getAttribute('aria-selected')).toBe('true');
    expect(opts[1]!.getAttribute('aria-selected')).toBe('false');
    expect(screen.getByLabelText(/Canvas width/)).toBeTruthy(); // N>1 → doc props, never blank

    // Space toggles the focused option out of the set.
    fireEvent.keyDown(opts[2]!, { key: ' ' });
    expect(opts[2]!.getAttribute('aria-selected')).toBe('false');
  });
});

// ── tree mode + PreviewPanel over small synthetic definitions ──

interface TDoc { name: string; frames: { id: string; name: string; nodes?: TreeNodeBase[] }[] }
type TFrame = TDoc['frames'][number] & FrameBase;

function syntheticTreeDefinition(): CanvasEditorDefinition<TDoc, TFrame, CanvasNode> {
  return {
    canvasTypeId: 'canvas.test',
    toggleId: 'test',
    clientBasePath: '/host/openwop-app/test',
    editorPath: '/edit',
    i18nNamespace: 'app-builder', // reuse a real ns so the type-contract keys resolve
    Renderer: ({ content }: { content: string }) => <div data-testid="renderer">{content.length}</div>,
    coerceDoc: (s) => ({ name: typeof s.name === 'string' ? s.name : 'Doc', frames: Array.isArray(s.frames) ? (s.frames as TDoc['frames']) : [{ id: 'f1', name: 'F1', nodes: [] }] }),
    frames: { ops: frameOps<TDoc, TFrame>({ key: 'frames', max: 10 }), key: 'frames', max: 10 },
    tree: { ops: treeOps<CanvasNode, TFrame>({ rootKey: 'nodes', childrenKey: 'children' }), rootKey: 'nodes', childrenKey: 'children' },
  };
}

describe('tree mode (synthetic definition + host catalog)', () => {
  beforeEach(() => {
    state.catalog = {
      canvasTypeId: 'canvas.test',
      components: [{ type: 'text', label: 'TextBlock', category: 'display', props: [{ name: 'text', type: 'string', label: 'Text' }] }],
      promptSchema: '',
    };
    state.record = { canvasId: 'c1', canvasTypeId: 'canvas.test', version: 1, state: { name: 'Doc', frames: [{ id: 'f1', name: 'F1', nodes: [] }] } };
  });

  it('renders the palette from the catalog; add via palette, select via outline', async () => {
    const { container } = mount(syntheticTreeDefinition());
    const paletteItem = await screen.findByRole('button', { name: 'TextBlock' });
    fireEvent.click(paletteItem); // palette click ADDS (drop/outline click selects)
    const row = container.querySelector('.cv-editor__tree-row');
    expect(row?.textContent).toContain('TextBlock');
    fireEvent.click(row!);
    // The property panel shows the catalog-driven field for the selection.
    expect(screen.getByLabelText(/^Text/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete component' })).toBeTruthy();
  });

  it('puts type workspaces in the dedicated mode strip, not the command bar', async () => {
    const definition = syntheticTreeDefinition();
    definition.workspaceTabs = [{
      id: 'data',
      labelKey: 'dataTab',
      Component: () => <p>Workspace data surface</p>,
    }];
    const { container } = mount(definition);
    const strip = await screen.findByRole('navigation', { name: 'Workspace modes' });
    expect(within(strip).getByRole('button', { name: 'Data' })).toBeTruthy();
    expect(container.querySelector('.cv-editor__bar')?.textContent).not.toContain('Data');
    fireEvent.click(within(strip).getByRole('button', { name: 'Data' }));
    expect(screen.getByText('Workspace data surface')).toBeTruthy();
  });

  it('palette favorites pin a group; adding feeds Recent; both persist across remount (audit polish P2)', async () => {
    localStorage.removeItem('cv-palette:canvas.test');
    const { container, unmount } = mount(syntheticTreeDefinition());
    // Star the item → a pinned Favorites group appears.
    fireEvent.click(await screen.findByRole('button', { name: 'Add TextBlock to favorites' }));
    expect(screen.getByRole('heading', { name: 'Favorites' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Remove TextBlock from favorites' })[0]!.getAttribute('aria-pressed')).toBe('true');
    // Adding a component records it (favorites win over Recent — no dup group).
    fireEvent.click(screen.getAllByRole('button', { name: 'TextBlock' })[0]!);
    expect(container.querySelector('.cv-editor__tree-row')).toBeTruthy();
    // Persists: remount re-reads localStorage.
    unmount();
    mount(syntheticTreeDefinition());
    expect(await screen.findByRole('heading', { name: 'Favorites' })).toBeTruthy();
    localStorage.removeItem('cv-palette:canvas.test');
  });

  it('the template gallery previews via the shared Renderer and Use adds the frame (audit gap #5)', async () => {
    state.catalog = {
      canvasTypeId: 'canvas.test',
      components: [{ type: 'text', label: 'TextBlock', category: 'display', props: [] }],
      promptSchema: '',
      templates: [{ id: 'hero', name: 'Hero', description: 'A hero screen.', components: [{ type: 'text', props: { text: 'Big' } }] }],
    };
    mount(syntheticTreeDefinition());
    fireEvent.click(await screen.findByRole('button', { name: 'Browse templates' }));
    // The gallery renders the template through the SHARED (test) Renderer.
    const dialog = await screen.findByRole('dialog', { name: 'Screen templates' });
    expect(dialog.textContent).toContain('Hero');
    expect(dialog.querySelector('[data-testid="renderer"]')).toBeTruthy();
    // Use adds a new frame (tab appears) and closes the gallery.
    // Per-template accessible name (grade UX-6) — now worded by the SHARED
    // gallery (DESIGN.md §4.5 rule 14), so every gallery's CTA reads alike.
    fireEvent.click(screen.getByRole('button', { name: 'Use template: Hero' }));
    expect(screen.queryByRole('dialog', { name: 'Screen templates' })).toBeNull();
    expect(screen.getByRole('tab', { name: /Hero/ })).toBeTruthy();
  });

  it('copy on one frame pastes onto ANOTHER — incl. an empty frame (audit gap #3)', async () => {
    state.record = {
      canvasId: 'c1', canvasTypeId: 'canvas.test', version: 1,
      state: { name: 'Doc', frames: [
        { id: 'f1', name: 'F1', nodes: [{ type: 'text', props: { text: 'hello' } }] },
        { id: 'f2', name: 'F2', nodes: [] },
      ] },
    };
    const { container } = mount(syntheticTreeDefinition());
    // Select the node on F1; Paste is disabled before any copy.
    const row = await waitFor(() => { const r = container.querySelector('.cv-editor__tree-row'); expect(r).toBeTruthy(); return r as Element; });
    fireEvent.click(row);
    expect((screen.getByRole('button', { name: 'Paste' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    // Switch to the EMPTY frame F2 — nothing selectable there, yet Paste is
    // offered in the no-selection panel (root paste; the primary use case).
    fireEvent.click(screen.getByRole('tab', { name: /F2/ }));
    expect(container.querySelector('.cv-editor__tree-row')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }));
    const pasted = container.querySelector('.cv-editor__tree-row');
    expect(pasted?.textContent).toContain('TextBlock');
    // The pasted copy is INDEPENDENT: it landed on F2 while F1 keeps its node.
    fireEvent.click(screen.getByRole('tab', { name: /F1/ }));
    expect(container.querySelector('.cv-editor__tree-row')?.textContent).toContain('TextBlock');
  });
});

describe('PreviewPanel (RFC 0130 seam)', () => {
  it('replaces the Renderer and receives content + selection + a working announce sink', async () => {
    const seen: { content?: string; selection?: unknown } = {};
    const def = syntheticTreeDefinition();
    def.PreviewPanel = ({ content, selection, onAnnounce }) => {
      seen.content = content;
      seen.selection = selection;
      return <button type="button" onClick={() => onAnnounce('from plugin')}>plugin-panel</button>;
    };
    state.record = { canvasId: 'c1', canvasTypeId: 'canvas.test', version: 1, state: { name: 'Doc', frames: [{ id: 'f1', name: 'F1', nodes: [] }] } };
    mount(def);
    const panel = await screen.findByRole('button', { name: 'plugin-panel' });
    expect(screen.queryByTestId('renderer')).toBeNull(); // Renderer replaced
    expect(typeof seen.content).toBe('string');
    expect(seen.selection).toMatchObject({ kind: 'frame', frameId: 'f1' });
    // The announce sink lands in the editor's polite live region.
    fireEvent.click(panel);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('from plugin'));
  });
});

describe('InteractivePreview seam (ADR 0310 Phase C follow-up)', () => {
  beforeEach(() => {
    state.record = {
      canvasId: 'c1', canvasTypeId: 'canvas.drawing', version: 1,
      state: { title: 'Scene', width: 400, height: 300, shapes: [{ kind: 'rect', x: 1, y: 2, width: 10, height: 10 }] },
    };
  });

  it('replaces the read-only Renderer and drives history/save through patchElement', async () => {
    // A test double for the interactive preview exposing the two seam calls.
    const def = { ...drawingsDefinition, InteractivePreview: ({ onSelect, patchElement }: {
      onSelect: (col: string, idx: number) => void;
      patchElement: (col: string, idx: number, patch: Record<string, unknown>, phase: 'start' | 'move' | 'end') => void;
    }) => (
      <div>
        <button type="button" onClick={() => onSelect('shapes', 0)}>tp-select</button>
        <button type="button" onClick={() => { patchElement('shapes', 0, { x: 99 }, 'start'); patchElement('shapes', 0, {}, 'end'); }}>tp-move</button>
      </div>
    ) };
    mount(def);

    // The interactive preview is mounted; the read-only shapes figure is NOT.
    await screen.findByRole('button', { name: 'tp-move' });
    expect(document.querySelector('.canvas-drawing')).toBeNull();

    // Selecting binds the property panel to the shape (its X field appears).
    fireEvent.click(screen.getByRole('button', { name: 'tp-select' }));
    expect(screen.getByLabelText(/^X/)).toBeTruthy();

    // A patch marks the doc dirty and saves the mutated coordinate.
    fireEvent.click(screen.getByRole('button', { name: 'tp-move' }));
    const save = screen.getByRole('button', { name: 'Save' });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(state.saveCanvas).toHaveBeenCalledTimes(1));
    const [, , savedState] = state.saveCanvas.mock.calls[0]!;
    expect((savedState as { shapes: { x: number }[] }).shapes[0]!.x).toBe(99);
  });

  it('patchElements batches a group move + deleteElements removes a set (respecting min)', async () => {
    state.record = {
      canvasId: 'c1', canvasTypeId: 'canvas.drawing', version: 1,
      state: { title: 'Scene', width: 400, height: 300, shapes: [
        { kind: 'rect', x: 0, y: 0, width: 10, height: 10 },
        { kind: 'rect', x: 50, y: 0, width: 10, height: 10 },
        { kind: 'rect', x: 90, y: 0, width: 10, height: 10 },
      ] },
    };
    const def = { ...drawingsDefinition, InteractivePreview: ({ patchElements, deleteElements }: {
      patchElements: (col: string, patches: { idx: number; patch: Record<string, unknown> }[], phase: 'start' | 'move' | 'end') => void;
      deleteElements: (col: string, idxs: number[]) => number;
    }) => (
      <div>
        <button type="button" onClick={() => { patchElements('shapes', [{ idx: 0, patch: { x: 5 } }, { idx: 1, patch: { x: 55 } }], 'start'); patchElements('shapes', [], 'end'); }}>tp-group-move</button>
        <button type="button" onClick={() => deleteElements('shapes', [0, 1])}>tp-group-del</button>
      </div>
    ) };
    mount(def);
    await screen.findByRole('button', { name: 'tp-group-move' });

    // Group move: BOTH shapes moved in one undo step (patchElement looping would lose one).
    fireEvent.click(screen.getByRole('button', { name: 'tp-group-move' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(state.saveCanvas).toHaveBeenCalledTimes(1));
    const moved = state.saveCanvas.mock.calls[0]![2] as { shapes: { x: number }[] };
    expect(moved.shapes[0]!.x).toBe(5);
    expect(moved.shapes[1]!.x).toBe(55);

    // Group delete: removes 2 of 3, leaving 1 (drawings min = 1 means it could
    // delete 2 here). One Save captures the new state.
    fireEvent.click(screen.getByRole('button', { name: 'tp-group-del' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(state.saveCanvas).toHaveBeenCalledTimes(2));
    const afterDel = state.saveCanvas.mock.calls[1]![2] as { shapes: unknown[] };
    expect(afterDel.shapes).toHaveLength(1);
  });
});

// ── Grade pass 2026-07-10 — the P7 FRAMES clipboard (copy → paste across decks). ──
describe('frames clipboard (ADR 0328 P7)', () => {
  it('copies the active slide to localStorage and pastes it as a NEW frame with re-minted identity', async () => {
    localStorage.removeItem('owp-frames-clip:canvas.slides');
    state.record = {
      canvasId: 'c1', canvasTypeId: 'canvas.slides', name: 'Deck', version: 1,
      state: { title: 'Deck', slides: [
        { id: 'orig', name: 'Original', layout: 'title-bullets', title: 'T', bullets: ['a', 'b'] },
      ] },
    };
    const r = mount(slidesDefinition);
    await screen.findByText('Original');

    // Copy via the frame menu.
    fireEvent.click(r.container.querySelector('.cv-editor__screen-menu, [aria-haspopup]') as HTMLElement);
    fireEvent.click(await screen.findByText('Copy to clipboard'));
    const clip = JSON.parse(localStorage.getItem('owp-frames-clip:canvas.slides') ?? 'null') as { name: string; content: Record<string, unknown> };
    expect(clip.name).toBe('Original');
    expect(clip.content.bullets).toEqual(['a', 'b']);
    expect('id' in clip.content).toBe(false); // identity never travels

    // Paste creates frame 2 with a fresh id.
    fireEvent.click(r.container.querySelector('[aria-haspopup]') as HTMLElement);
    fireEvent.click(await screen.findByText('Paste from clipboard'));
    const tabs = r.container.querySelectorAll('[role="tab"]');
    expect(tabs.length).toBe(2);
  });
});

// ── ADR 0337 — graph-first default + the Screens rail. ─────────────────────
function syntheticGraphDefinition(): CanvasEditorDefinition<TDoc, TFrame, CanvasNode> {
  const base = syntheticTreeDefinition();
  return {
    ...base,
    graph: {
      defaultView: 'graph',
      nodes: (d: TDoc) => d.frames.map((f, i) => ({ id: f.id, label: f.name, x: i * 220, y: 0, isHome: i === 0 })),
      edges: () => [],
      nodeSize: { w: 190, h: 360 },
      moveNode: () => {},
      connect: () => false,
      deleteEdge: () => {},
      renderNode: (n) => <div data-testid="graph-node">{n.label}</div>,
    },
  };
}

describe('graph-first default (ADR 0337)', () => {
  beforeEach(() => {
    state.catalog = { canvasTypeId: 'canvas.test', components: [{ type: 'text', label: 'TextBlock', category: 'display', props: [] }], promptSchema: '' };
    state.record = { canvasId: 'c1', canvasTypeId: 'canvas.test', version: 1, state: { name: 'Doc', frames: [
      { id: 'home', name: 'Home', nodes: [] },
      { id: 'settings', name: 'Settings', nodes: [] },
    ] } };
  });

  it('opens in the board view and shows a Screens rail (not the component palette)', async () => {
    const { container } = mount(syntheticGraphDefinition());
    // The board mounted (cv-graph), not the tree preview.
    await waitFor(() => expect(container.querySelector('.cv-graph')).not.toBeNull());
    expect(container.querySelector('.cv-editor__screens-rail')).not.toBeNull();
    // The rail lists both screens; the component palette (TextBlock) is hidden.
    const rail = container.querySelector('.cv-editor__screens-rail-list');
    expect(rail?.textContent).toContain('Home');
    expect(rail?.textContent).toContain('Settings');
    expect(screen.queryByRole('button', { name: 'TextBlock' })).toBeNull();
  });

  it('a graph-less type still opens in the tree editor (default unchanged)', async () => {
    const { container } = mount(syntheticTreeDefinition());
    await screen.findByRole('button', { name: 'TextBlock' }); // palette present
    expect(container.querySelector('.cv-graph')).toBeNull();
    expect(container.querySelector('.cv-editor__screens-rail')).toBeNull();
  });
});

// ── ADR 0337 — the narrow single-row toolbar (chassis). ────────────────────
describe('narrow editor toolbar', () => {
  beforeEach(() => {
    state.catalog = { canvasTypeId: 'canvas.test', components: [{ type: 'text', label: 'TextBlock', category: 'display', props: [] }], promptSchema: '' };
    state.record = { canvasId: 'c1', canvasTypeId: 'canvas.test', version: 3, state: { name: 'My Doc', frames: [{ id: 'f1', name: 'F1', nodes: [] }] } };
  });

  it('renders identity (name + version status) and a spacer that right-anchors the actions', async () => {
    const { container } = mount(syntheticTreeDefinition());
    await screen.findByRole('button', { name: 'TextBlock' });
    const bar = container.querySelector('.cv-editor__bar');
    expect(bar).not.toBeNull();
    // Identity: the editable name + the compact version status live in the bar.
    expect(bar!.querySelector('.cv-editor__name')).not.toBeNull();
    expect(bar!.querySelector('.cv-editor__status .cv-editor__version')?.textContent).toContain('3');
    // The flex spacer is present (identity left / actions right, one row).
    expect(bar!.querySelector('.cv-editor__spacer')).not.toBeNull();
    // Cluster hairline dividers group the action set.
    expect(bar!.querySelectorAll('.cv-editor__bar-sep').length).toBeGreaterThan(0);
  });
});

describe('CAD-G4 — the chassis WIRES the elements transformOnPropChange', () => {
  // A unit test of `cadDefinition.elements[].transformOnPropChange` proves the
  // function is correct, not that the editor ever calls it — the frames trait
  // has had this hook since ADR 0328 P3 and the elements trait did not, so the
  // wiring is the part that can be missing.
  beforeEach(() => {
    state.record = {
      canvasId: 'c1', canvasTypeId: 'canvas.cad', version: 1,
      state: {
        name: 'Bracket', units: 'mm',
        solids: [{ kind: 'box', x: 0, y: 0, z: 0, width: 40, height: 30, depth: 20 }],
        dimensions: [{ kind: 'linear', solid: 0, axis: 'x', tolType: 'asymmetric', tolA: 0.2, tolB: 0.1 }],
      },
    };
  });

  it('clearing the tolerance type drops the stored tol values through the panel', async () => {
    const { container } = mount(cadDefinition);
    await screen.findAllByText('Dimensions');
    // Select the dimension row (the second collection's only element).
    const rows = container.querySelectorAll('.cv-editor__tree-row');
    fireEvent.click(rows[rows.length - 1]!);
    const tol = screen.getByLabelText('Tolerance type') as HTMLSelectElement;
    expect(tol.value).toBe('asymmetric');
    fireEvent.change(tol, { target: { value: '' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(state.saveCanvas).toHaveBeenCalled());
    const saved = state.saveCanvas.mock.calls[0]![2] as { dimensions: Record<string, unknown>[] };
    // Without the wiring the hidden tolA/tolB would ride along and the server
    // would reject the save with "tolA/tolB require a tolType".
    expect(saved.dimensions[0]).toEqual({ kind: 'linear', solid: 0, axis: 'x' });
  });
});

describe('R2 CS-SP-7 — a load 404 is a DESIGNED outcome (chassis-wide)', () => {
  // The server 404s uniformly for deleted / foreign-org / toggle-off, so the
  // chassis must render the designed copy — not the raw error — and must not
  // offer a Retry that reloads into the same permanent 404. Both polarities:
  // a transport failure keeps its message AND its Retry.
  it('renders the designed not-available copy without a Retry button', async () => {
    state.loadError = Object.assign(new Error('Not Found'), { status: 404 });
    mount(slidesDefinition);
    await screen.findByText(/isn’t available/);
    expect(screen.queryByText('Not Found')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('a non-404 failure keeps its message and the Retry button', async () => {
    state.loadError = Object.assign(new Error('network down'), { status: 500 });
    mount(slidesDefinition);
    await screen.findByText(/network down/);
    expect(screen.queryByText(/isn’t available/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
