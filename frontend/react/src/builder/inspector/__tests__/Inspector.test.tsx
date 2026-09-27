import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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
 * Verifies the Field-primitive migration of the node Inspector: with a node
 * selected, the always-present Name + Artifact controls resolve by accessible
 * label and reflect the builder-store node. Uses the `noop` node (no config
 * fields) so only the migrated fields are under test.
 */
describe('Inspector node forms (Field migration)', () => {
  it('exposes Name + Artifact as label-associated controls for the selected node', () => {
    const id = useBuilderStore.getState().addNode('noop', { x: 0, y: 0 });
    useBuilderStore.getState().selectNode(id);
    render(<Inspector />);

    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
    expect(nameInput).toBeTruthy();
    const artifact = screen.getByLabelText('Artifact') as HTMLSelectElement;
    expect(artifact.tagName).toBe('SELECT');

    // Name reflects the node + writes back through the store.
    const node = useBuilderStore.getState().nodes.find((n) => n.id === id);
    expect(nameInput.value).toBe(node?.name ?? '');
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
    const id = useBuilderStore.getState().addNode('noop', { x: 0, y: 0 });
    useBuilderStore.getState().selectNode(id);
    render(<Inspector />);
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
    const id = useBuilderStore.getState().addNode('noop', { x: 0, y: 0 });
    useBuilderStore.getState().updateNode(id, { inputs: { to: 'someone@example.com' } });
    useBuilderStore.getState().selectNode(id);
    render(<Inspector />);
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
