import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// The inspector's model-capability hint reads host discovery; answer it locally.
vi.mock('../../../client/runsClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../client/runsClient.js')>()),
  getCapabilities: vi.fn(async () => ({})),
}));
// The AI node's API-key picker lists stored refs; answer it locally.
vi.mock('../../../byok/lib/byokClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../byok/lib/byokClient.js')>()),
  listStoredRefs: vi.fn(async () => []),
}));
// "Fill with AI" gates itself on the pair toggle; turn it on so its absence
// below means the field withheld it, not that the toggle was off.
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (importOriginal) => {
  const { makeFeatureAccess } = await import('../../../featureToggles/__testing__/makeFeatureAccess.js');
  return {
    ...(await importOriginal<typeof import('../../../featureToggles/FeatureAccessContext.js')>()),
    useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
  };
});

import { Inspector } from '../Inspector.js';
import { useBuilderStore } from '../../store/builderStore.js';

afterEach(cleanup);
beforeEach(() => {
  const s = useBuilderStore.getState();
  for (const n of [...s.nodes]) s.removeNode(n.id);
  s.selectNode(null);
});

/**
 * ADR 1117 (found in the CT-DAC-3 live check, 2026-11-14) — a deferred copy binds
 * `model` to a run variable. "Fill with AI" asks the Architect to fill a field,
 * which writes a fixed value; on a run-bound field that would overwrite the binding
 * and freeze the copy again. So the inspector does not offer it there, and still
 * offers it on the field next to it.
 */
describe('Inspector — run-bound config fields', () => {
  it('offers "Fill with AI" on an ordinary field and withholds it on a run-bound one', () => {
    const id = useBuilderStore.getState().addNode('chat', { x: 0, y: 0 });
    useBuilderStore.getState().updateNode(id, {
      config: { provider: 'anthropic', model: { type: 'variable', variableName: 'inbox_call_debrief_558ccabab666_model' } },
    });
    useBuilderStore.getState().selectNode(id);
    render(<Inspector />);

    expect(screen.getByRole('button', { name: 'Ask the Architect to fill Provider' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ask the Architect to fill Model' })).toBeNull();
    expect(screen.getByText('Set when the run starts (model)')).toBeTruthy();
  });
});
