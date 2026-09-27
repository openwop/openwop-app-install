/**
 * GraphSurface interaction proof (ADR 0323) — jsdom. Pointer-drag geometry needs
 * a real bounding rect (jsdom returns a 0-rect), so this exercises the paths that
 * matter for the a11y gate + wiring: keyboard node-move, the Connect affordance
 * (arm → target), activate, node selection, and keyboard edge-delete. The routing
 * geometry is proven separately in edgeRouting.test.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GraphSurface, rulerTicks, type GraphSurfaceProps } from '../GraphSurface.js';

const labels: GraphSurfaceProps['labels'] = {
  surface: 'Screen-flow graph',
  connectFrom: 'Connect from {label}',
  connectTo: 'Connect to {label}',
  cancelConnect: 'Cancel',
  minimap: 'Overview map — click to pan, Enter to fit',
  connectArmed: 'Connecting from {label}',
  connected: 'Connected {from} to {to}',
  deletedEdge: 'Connection deleted',
  home: 'Start',
  empty: 'No screens yet',
  addConnected: 'Add connected screen from {label}',
  edgeSelected: 'Connection {from} → {to} selected',
  deviceFrame: 'Device frame',
};

function setup(over: Partial<GraphSurfaceProps> = {}) {
  const props: GraphSurfaceProps = {
    nodes: [
      { id: 'home', label: 'Home', x: 0, y: 0, isHome: true },
      { id: 'next', label: 'Next', x: 400, y: 0 },
    ],
    edges: [{ id: 'e1', from: 'home', to: 'next' }],
    nodeSize: { w: 200, h: 360 },
    renderNode: (n) => <div>{n.label} body</div>,
    selectedNodeId: null,
    selectedEdgeId: null,
    onSelectNode: vi.fn(),
    onSelectEdge: vi.fn(),
    onMoveNode: vi.fn(),
    onConnect: vi.fn(),
    onDeleteEdge: vi.fn(),
    onActivateNode: vi.fn(),
    onAnnounce: vi.fn(),
    labels,
    ...over,
  };
  const utils = render(<GraphSurface {...props} />);
  return { props, ...utils };
}

describe('GraphSurface — derived-edge mode (ADR 0360 grade pass)', () => {
  it('without onConnect: no Connect buttons, no pointer handles; Delete on an edge is inert', () => {
    const props = {} as Partial<GraphSurfaceProps>;
    const { container } = (() => {
      const p: GraphSurfaceProps = {
        nodes: [
          { id: 'a', label: 'Awareness', x: 0, y: 0 },
          { id: 'b', label: 'Conversion', x: 300, y: 0 },
        ],
        edges: [{ id: 'chain-0', from: 'a', to: 'b' }],
        nodeSize: { w: 200, h: 120 },
        renderNode: (n) => <div>{n.label}</div>,
        selectedNodeId: null,
        selectedEdgeId: 'chain-0',
        onSelectNode: vi.fn(),
        onSelectEdge: vi.fn(),
        onMoveNode: vi.fn(),
        onActivateNode: vi.fn(),
        onAnnounce: vi.fn(),
        labels,
        ...props,
      };
      return render(<GraphSurface {...p} />);
    })();
    expect(screen.queryByRole('button', { name: /Connect from/ })).toBeNull();
    expect(container.querySelectorAll('.cv-graph__handle').length).toBe(0);
    // Delete on the selected edge: inert + silent (no dishonest announcement).
    fireEvent.keyDown(screen.getByRole('group', { name: 'Screen-flow graph' }), { key: 'Delete' });
  });
});

describe('GraphSurface', () => {
  it('renders the shared zoom cluster — out / % menu / in, all labeled (§7.3 / CV-3)', () => {
    setup();
    const group = screen.getByRole('group', { name: 'Zoom' });
    expect(group).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeTruthy();
    // The percent readout is the preset-menu trigger (starts at 100%).
    expect(screen.getByRole('button', { name: /Zoom 100%/ })).toBeTruthy();
  });

  it('renders each node as an accessible button + the node body', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Home' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next' })).toBeTruthy();
    expect(screen.getByText('Home body')).toBeTruthy();
    expect(screen.getByText('Start')).toBeTruthy(); // home badge
  });

  it('keyboard arrows move the focused node by one step (one undo entry: phase "start")', () => {
    const { props } = setup();
    const home = screen.getByRole('button', { name: 'Home' });
    fireEvent.keyDown(home, { key: 'ArrowRight' });
    expect(props.onMoveNode).toHaveBeenCalledWith('home', 8, 0, 'start');
    fireEvent.keyDown(home, { key: 'ArrowDown', shiftKey: true });
    // Grade UX-14: a burst of nudges coalesces — the second press is 'move',
    // so ten taps make ONE undo entry, not ten.
    expect(props.onMoveNode).toHaveBeenCalledWith('home', 0, 40, 'move'); // shift ×5
  });

  it('Enter activates a node (opens its editor)', () => {
    const { props } = setup();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Home' }), { key: 'Enter' });
    expect(props.onActivateNode).toHaveBeenCalledWith('home');
  });

  it('the Connect affordance connects source → target (keyboard/click a11y path)', () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Connect from Home' }));
    // Grade UX-13: arming announces once, via the role="status" connect-bar.
    expect(screen.getByRole('status').textContent).toContain('Connecting from Home');
    // now the other node's button reads "Connect to Next"
    fireEvent.click(screen.getByRole('button', { name: 'Connect to Next' }));
    expect(props.onConnect).toHaveBeenCalledWith('home', 'next');
    expect(props.onAnnounce).toHaveBeenCalledWith('Connected Home to Next', 'polite');
  });

  it('the "c" key arms a connection from the focused node', () => {
    setup();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Home' }), { key: 'c' });
    expect(screen.getByRole('status').textContent).toContain('Connecting from Home');
  });

  it('clicking a node selects it', () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(props.onSelectNode).toHaveBeenCalledWith('next');
  });

  it('Delete removes the selected edge', () => {
    const { props } = setup({ selectedEdgeId: 'e1' });
    fireEvent.keyDown(screen.getByLabelText('Screen-flow graph'), { key: 'Delete' });
    expect(props.onDeleteEdge).toHaveBeenCalledWith('e1');
    expect(props.onAnnounce).toHaveBeenCalledWith('Connection deleted', 'polite');
  });

  it('does not connect a node to itself', () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Connect from Home' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect from Home' })); // same node again
    expect(props.onConnect).not.toHaveBeenCalled();
  });

  it('shows the empty state (and no Fit button) when there are no nodes', () => {
    setup({ nodes: [], edges: [] });
    expect(screen.getByText('No screens yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Zoom 100%/ })).toBeNull();
  });

  it('virtualization cap: beyond LIVE_CAP bodies render ghosts; the selected node is always live (audit polish P3)', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, label: `S${i}`, x: i * 250, y: 0 }));
    const { container } = setup({ nodes: many, edges: [], selectedNodeId: 's29', renderNode: (n) => <div data-testid="live-body">{n.label}</div> });
    // jsdom is unmeasurable → culling fails open, but the cap holds: 24 + the selected.
    expect(container.querySelectorAll('[data-testid="live-body"]').length).toBe(25);
    expect(container.querySelectorAll('.cv-graph__node-ghost').length).toBe(5);
    // The selected node (index 29, past the cap) renders live.
    const sel = container.querySelector('.cv-graph__node--sel');
    expect(sel?.querySelector('[data-testid="live-body"]')).toBeTruthy();
  });

  it('offers Zoom-to-fit through the % preset menu when there are nodes', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /Zoom 100%/ }));
    expect(screen.getByRole('menuitem', { name: /Zoom to fit/ })).toBeTruthy();
  });

  it('the selected node offers an Add-connected button (audit gap #2); unselected nodes do not', () => {
    const onAddConnected = vi.fn();
    setup({ selectedNodeId: 'home', onAddConnected });
    fireEvent.click(screen.getByRole('button', { name: 'Add connected screen from Home' }));
    expect(onAddConnected).toHaveBeenCalledWith('home');
    expect(screen.queryByRole('button', { name: 'Add connected screen from Next' })).toBeNull();
  });
});

describe('grade-pass regressions', () => {
  it('a plain click on a node selects but NEVER moves it (no bogus undo entry)', () => {
    const { props } = setup();
    const node = screen.getByRole('button', { name: 'Home' });
    fireEvent.pointerDown(node, { button: 0 });
    fireEvent.pointerUp(node);
    fireEvent.click(node);
    expect(props.onSelectNode).toHaveBeenCalledWith('home');
    expect(props.onMoveNode).not.toHaveBeenCalled();
  });

  it('Enter on the Connect button is NOT hijacked into node activation', () => {
    const { props } = setup();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Connect from Home' }), { key: 'Enter' });
    expect(props.onActivateNode).not.toHaveBeenCalled();
  });

  it("'e' on a node cycles + selects its incident edge and announces it", () => {
    const { props } = setup();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Home' }), { key: 'e' });
    expect(props.onSelectEdge).toHaveBeenCalledWith('e1');
    expect(props.onAnnounce).toHaveBeenCalledWith('Connection Home → Next selected', 'polite');
  });

  it('every node is keyboard-focusable and focus selects it', () => {
    const { props } = setup();
    const second = screen.getByRole('button', { name: 'Next' });
    expect(second.getAttribute('tabindex')).toBe('0');
    fireEvent.focus(second);
    expect(props.onSelectNode).toHaveBeenCalledWith('next');
  });
});

// ── ADR 0337 P2b — device-frame selector + ruler. ─────────────────────────
describe('rulerTicks (pure)', () => {
  it('emits canvas-coord ticks at screen positions from pan/zoom, within the rail', () => {
    // zoom 1, pan 0, 500px rail, step 100 → ticks at 0,100,200,300,400 (500 is > len exclusive).
    const t = rulerTicks(0, 1, 500, 100);
    expect(t.map((x) => x.coord)).toEqual([0, 100, 200, 300, 400]);
    expect(t.map((x) => x.pos)).toEqual([0, 100, 200, 300, 400]);
  });
  it('shifts with pan and scales with zoom', () => {
    const t = rulerTicks(50, 2, 500, 100); // pan 50, zoom 2 → coord 0 at pos 50, coord 100 at 250...
    expect(t[0]).toEqual({ pos: 50, coord: 0 });
    expect(t[1]).toEqual({ pos: 250, coord: 100 });
  });
  it('hides when too dense (stepPx < 6) or the rail is empty', () => {
    expect(rulerTicks(0, 0.02, 500, 100)).toEqual([]); // 2px spacing → hidden
    expect(rulerTicks(0, 1, 0, 100)).toEqual([]);
  });
});

describe('GraphSurface device selector (ADR 0337 P2b)', () => {
  it('renders a labeled device select when the trait supplies frames, defaulting to defaultDevice', () => {
    // The fields are `width`/`height`. This fixture said `w`/`h`, so BOTH were
    // undefined and `activeDevice?.width ?? nodeSize.w` silently took the
    // FALLBACK — the device sizing this test is named for was never exercised.
    // Excess-property checking would normally catch that; it does not fire
    // through the `setup()` indirection, and unit tests are excluded from the
    // build's tsc, so it went green for as long as it existed.
    const { container } = setup({ deviceFrames: [
      { id: 'iphone15', label: 'iPhone 15 Pro', width: 190, height: 360 },
      { id: 'ipad', label: 'iPad', width: 300, height: 400 },
    ], defaultDevice: 'iphone15' });
    const sel = container.querySelector('.cv-graph__device-select');
    expect(sel).not.toBeNull();
    expect((sel as HTMLSelectElement).value).toBe('iphone15');
    expect([...(sel as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['iPhone 15 Pro', 'iPad']);
  });

  it('APPLIES the selected frame size — the path the `w`/`h` typo hid', () => {
    // Guards the regression above: with the wrong field names this assertion
    // fails, because every node falls back to the default nodeSize instead of
    // the 190-wide device frame.
    const { container } = setup({ deviceFrames: [
      { id: 'iphone15', label: 'iPhone 15 Pro', width: 190, height: 360 },
    ], defaultDevice: 'iphone15' });
    const node = container.querySelector('.cv-graph__node') as HTMLElement | null;
    expect(node, 'fixture guard: a node must render').not.toBeNull();
    expect(node!.style.width).toBe('190px');
    expect(node!.style.height).toBe('360px');
  });

  it('shows NO device selector when the trait supplies no frames (the default)', () => {
    const { container } = setup(); // base props carry no deviceFrames
    expect(container.querySelector('.cv-graph__device-select')).toBeNull();
  });
});
