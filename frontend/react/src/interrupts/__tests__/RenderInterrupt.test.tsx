/**
 * CHAT-7 (docs/steward/CODEBASE-ASSESSMENT.md): the interrupt dispatcher routes each kind to
 * the right card and degrades gracefully on an unknown kind. Previously the
 * interrupts dir tested only a11y labels.
 *
 * Also owns (w51 r2, absorbed from the deleted interruptForms.test): each routed
 * card's answer field is label-associated (`Comment (optional)`, `Draft`, `Your
 * answer`), plus the two branches no case reached — the cancellation route and the
 * ADR 0755 D3 token-less interrupt (readable, never answerable).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const { resolveByRun } = vi.hoisted(() => ({ resolveByRun: vi.fn() }));
vi.mock('../../client/interruptsClient.js', () => ({ resolveByRun }));
const { beginOAuth, listProviders } = vi.hoisted(() => ({ beginOAuth: vi.fn(), listProviders: vi.fn(() => Promise.resolve([])) }));
vi.mock('../../features/connections/connectionsClient.js', () => ({ beginOAuth, listProviders }));

import { RenderInterrupt } from '../RenderInterrupt.js';
import type { OpenInterrupt } from '../../client/interruptsClient.js';

afterEach(() => { resolveByRun.mockReset(); cleanup(); });

/** Build a fully-typed OpenInterrupt fixture (no casts). */
function mk(kind: OpenInterrupt['kind'], data: unknown, token = 't'): OpenInterrupt {
  return { interruptId: 'int-1', nodeId: 'n1', token, kind, data, createdAt: '2026-01-01T00:00:00Z' };
}

describe('RenderInterrupt dispatcher', () => {
  it('renders nothing when there is no active interrupt', () => {
    const { container } = render(<RenderInterrupt runId="r" active={null} onResolved={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('routes the approval kind to the ApprovalCard', () => {
    render(<RenderInterrupt runId="r" active={mk('approval', { prompt: 'Approve?' })} onResolved={() => {}} />);
    expect(screen.getByLabelText('Comment (optional)').tagName).toBe('INPUT');
  });

  it('routes the refinement kind to the RefinementForm', () => {
    render(<RenderInterrupt runId="r" active={mk('refinement', { current: 'x' })} onResolved={() => {}} />);
    expect(screen.getByLabelText('Draft').tagName).toBe('TEXTAREA');
  });

  it('routes the cancellation kind to the CancellationBanner', () => {
    render(<RenderInterrupt runId="r" active={mk('cancellation', { reason: 'Budget exceeded' })} onResolved={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Cancellation requested' })).toBeTruthy();
    expect(screen.getByText('Budget exceeded')).toBeTruthy();
  });

  it('a token-less interrupt shows the read-only notice, never an answerable card (ADR 0755 D3)', () => {
    render(<RenderInterrupt runId="r" active={mk('approval', { prompt: 'Approve?' }, '')} onResolved={() => {}} />);
    expect(screen.getByRole('status').textContent).toBe("You can see this step, but you don't have permission to respond to it.");
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByLabelText('Comment (optional)')).toBeNull();
  });

  it('routes a clarification WITHOUT the connection profile to the free-text dialog', () => {
    render(<RenderInterrupt runId="r" active={mk('clarification', { question: 'Which region?' })} onResolved={() => {}} />);
    expect(screen.getByText('Which region?')).toBeTruthy();
    // The text-answer field is present and label-associated; no Connect/Skip actions.
    expect(screen.getByLabelText('Your answer').tagName).toBe('TEXTAREA');
    expect(screen.queryByText(/Skip this step/i)).toBeNull();
  });

  it('routes a clarification WITH the openwop-connection profile to the connect-to-continue dialog', () => {
    render(<RenderInterrupt runId="r" active={mk('clarification', { profile: 'openwop-connection', connection: { providerId: 'google', label: 'Google Workspace' } })} onResolved={() => {}} />);
    // Connect/Continue/Skip controls, NOT a free-text answer field.
    expect(screen.getByText(/Skip this step/i)).toBeTruthy();
    expect(screen.getByText(/I've connected — continue/i)).toBeTruthy();
  });

  it('the connection dialog resumes via resolveByRun with the typed action', async () => {
    const onResolved = vi.fn();
    resolveByRun.mockResolvedValue({});
    render(<RenderInterrupt runId="r" active={mk('clarification', { profile: 'openwop-connection', connection: { providerId: 'google', label: 'Google Workspace' } })} onResolved={onResolved} />);
    (await screen.findByText(/Skip this step/i)).click();
    await vi.waitFor(() => expect(resolveByRun).toHaveBeenCalledWith('r', 'n1', { action: 'skip' }));
  });

  it('degrades gracefully on an unknown kind (no crash, names the kind, neutral copy)', () => {
    render(<RenderInterrupt runId="r" active={mk('low-confidence', {})} onResolved={() => {}} />);
    // DEMO-14: neutral user-facing copy — carries the kind, never instructs
    // the user to edit source files.
    expect(screen.getByText(/can't be shown here/i)).toBeTruthy();
    expect(screen.getByText(/low-confidence/)).toBeTruthy();
    expect(screen.queryByText(/RenderInterrupt\.tsx/)).toBeNull();
  });
});
