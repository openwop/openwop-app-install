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
