/**
 * CHAT-7 (CODEBASE-ASSESSMENT.md): the interrupt dispatcher routes each kind to
 * the right card and degrades gracefully on an unknown kind. Previously the
 * interrupts dir tested only a11y labels.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('../../client/interruptsClient.js', () => ({ resolveByRun: vi.fn() }));

import { RenderInterrupt } from '../RenderInterrupt.js';
import type { OpenInterrupt } from '../../client/interruptsClient.js';

afterEach(cleanup);

/** Build a fully-typed OpenInterrupt fixture (no casts). */
function mk(kind: OpenInterrupt['kind'], data: unknown): OpenInterrupt {
  return { interruptId: 'int-1', nodeId: 'n1', token: 't', kind, data, createdAt: '2026-01-01T00:00:00Z' };
}

describe('RenderInterrupt dispatcher', () => {
  it('renders nothing when there is no active interrupt', () => {
    const { container } = render(<RenderInterrupt runId="r" active={null} onResolved={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('routes the approval kind to the ApprovalCard', () => {
    render(<RenderInterrupt runId="r" active={mk('approval', { prompt: 'Approve?' })} onResolved={() => {}} />);
    expect(screen.getByLabelText('Comment (optional)')).toBeTruthy();
  });

  it('routes the refinement kind to the RefinementForm', () => {
    render(<RenderInterrupt runId="r" active={mk('refinement', { current: 'x' })} onResolved={() => {}} />);
    expect(screen.getByLabelText('Draft')).toBeTruthy();
  });

  it('degrades gracefully on an unknown kind (no crash, names the kind)', () => {
    render(<RenderInterrupt runId="r" active={mk('low-confidence', {})} onResolved={() => {}} />);
    expect(screen.getByText(/unknown interrupt kind/i)).toBeTruthy();
    expect(screen.getByText('low-confidence')).toBeTruthy();
  });
});
