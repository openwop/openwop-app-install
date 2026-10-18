import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

// The node inspector's model-capability hint reads host discovery; answer it
// locally (no advertisement) so the file never issues a live fetch (ADR 0661).
vi.mock('../../../client/runsClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../client/runsClient.js')>()),
  getCapabilities: vi.fn(async () => ({})),
}));

import { Inspector } from '../Inspector.js';
import { useBuilderStore } from '../../store/builderStore.js';

afterEach(cleanup);
beforeEach(() => {
  // Reset to a clean builder state between tests.
  const s = useBuilderStore.getState();
  for (const n of [...s.nodes]) s.removeNode(n.id);
  s.selectNode(null);
});

/**
 * Field-primitive migration (#66 / #69) of the node Inspector: with a node
 * selected, the always-present Name + Artifact controls resolve by accessible
 * label, reflect the builder-store node, and Name writes back through the
 * store. Breaks if either control loses its label or its binding. Uses the
 * `noop` node (catalog label "Pass-through", no config fields) so only the
 * migrated fields are under test.
 */
describe('Inspector node forms (Field migration)', () => {
  it('exposes Name + Artifact as label-associated controls for the selected node', () => {
    const id = useBuilderStore.getState().addNode('noop', { x: 0, y: 0 });
    // Non-default output role, so "reflects the node" cannot pass on the '' default.
    useBuilderStore.getState().updateNode(id, { outputRole: 'secondary' });
    useBuilderStore.getState().selectNode(id);
    render(<Inspector />);

    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
    // Literal, not read back from the store (the noop catalog label).
    expect(nameInput.value).toBe('Pass-through');
    const artifact = screen.getByLabelText('Artifact') as HTMLSelectElement;
    expect(artifact.tagName).toBe('SELECT');
    expect(artifact.value).toBe('secondary');

    // Name writes back through the store.
    fireEvent.change(nameInput, { target: { value: 'Renamed node' } });
    expect(useBuilderStore.getState().nodes.find((n) => n.id === id)?.name).toBe('Renamed node');
  });
});

/**
 * ADR 0523 — preset inputs are VISIBLE, and the override caution is CONDITIONAL.
 *
 * The section exists because preserving preset inputs while leaving them
 * invisible would trade a silent LOSS for a silent OVERRIDE. But a blanket
 * "this overrides your edge" line would fire on every preset node and be correct
 * on none of them (measured: 0 of 187 shipped preset nodes currently have an
 * edge landing on a preset port), which is training to ignore cautions. So it is
 * shown per-port, only where an incoming edge actually feeds that port.
 */
describe('Inspector — preset inputs (ADR 0523)', () => {
  it('renders nothing when the node has no preset inputs', () => {
    // Both empty shapes: `inputs` absent, and `inputs: {}` — the state a CLEAR of
    // the last preset input leaves (presetInputsEditable.test.tsx).
    const id = useBuilderStore.getState().addNode('noop', { x: 0, y: 0 });
    useBuilderStore.getState().selectNode(id);
    const { unmount } = render(<Inspector />);
    expect(screen.getByLabelText('Name')).toBeTruthy(); // the inspector itself rendered
    expect(screen.queryByText('Preset inputs')).toBeNull();
    unmount();

    useBuilderStore.getState().updateNode(id, { inputs: {} });
    render(<Inspector />);
    expect(screen.getByLabelText('Name')).toBeTruthy();
    expect(screen.queryByText('Preset inputs')).toBeNull();
  });

  // §Correction (ADR 0524 Phase E): these values are now EDITABLE, so they live
  // in text inputs rather than as static text. The assertions moved from
  // `getByText` to `getByDisplayValue` — the value shown is the same, the
  // control around it is not. Deliberately NOT weakened to a substring match:
  // that would have hidden the change instead of recording it, and the envelope
  // unwrapping this test exists to pin is exactly what a display-value
  // assertion still proves.
  it('lists each port and its value, unwrapping the PortValue envelope', () => {
    const id = useBuilderStore.getState().addNode('noop', { x: 0, y: 0 });
    useBuilderStore.getState().updateNode(id, {
      inputs: {
        to: '{{params.recipientEmail}}',
        prompt: { type: 'static', value: 'Approve this?' },
      },
    });
    useBuilderStore.getState().selectNode(id);
    render(<Inspector />);

    expect(screen.getByText('Preset inputs')).toBeTruthy();
    expect(screen.getByText('to')).toBeTruthy();
    expect(screen.getByDisplayValue('{{params.recipientEmail}}')).toBeTruthy();
    // The envelope is unwrapped — a user reads the prompt, not the JSON around it.
    expect(screen.getByDisplayValue('Approve this?')).toBeTruthy();
    expect(screen.queryByText(/"type":"static"/)).toBeNull();
  });

  it('does NOT claim an override when no edge feeds the preset port', () => {
    // Asymmetric fixture: an edge DOES feed a `to` port — but on ANOTHER node —
    // and an edge feeds THIS node on a different port. Only an edge into this
    // node's `to` would make the preset an override.
    const id = useBuilderStore.getState().addNode('noop', { x: 0, y: 0 });
    const other = useBuilderStore.getState().addNode('noop', { x: 200, y: 0 });
    const src = useBuilderStore.getState().addNode('noop', { x: 400, y: 0 });
    useBuilderStore.getState().updateNode(id, { inputs: { to: 'someone@example.com' } });
    useBuilderStore.getState().updateNode(other, { inputs: { to: 'x@example.com' } });
    useBuilderStore.getState().addEdge({ source: id, sourcePort: 'out', target: other, targetPort: 'to' });
    useBuilderStore.getState().addEdge({ source: src, sourcePort: 'out', target: id, targetPort: 'in' });
    expect(useBuilderStore.getState().edges).toHaveLength(2); // both fixture edges landed
    useBuilderStore.getState().selectNode(id);
    render(<Inspector />);
    expect(screen.getByDisplayValue('someone@example.com')).toBeTruthy(); // the section rendered
    expect(screen.queryByText(/overrides the incoming edge/)).toBeNull();
  });

  it('DOES claim an override on the port an incoming edge actually feeds', () => {
    const src = useBuilderStore.getState().addNode('noop', { x: 0, y: 0 });
    const dst = useBuilderStore.getState().addNode('noop', { x: 200, y: 0 });
    useBuilderStore.getState().updateNode(dst, { inputs: { to: 'someone@example.com' } });
    useBuilderStore.getState().addEdge({ source: src, sourcePort: 'out', target: dst, targetPort: 'to' });
    useBuilderStore.getState().selectNode(dst);
    render(<Inspector />);
    expect(screen.getByText(/overrides the incoming edge/)).toBeTruthy();
  });
});
