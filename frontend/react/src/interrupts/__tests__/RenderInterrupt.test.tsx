/**
 * CHAT-7 (docs/steward/CODEBASE-ASSESSMENT.md): the interrupt dispatcher routes each kind to
 * the right card and degrades gracefully on an unknown kind. Previously the
 * interrupts dir tested only a11y labels.
 *
 * Also owns (w51 r2, absorbed from the deleted interruptForms.test): each routed
 * card's answer field is label-associated (`Comment (optional)`, `Draft`, `Your
 * answer`), plus the two branches no case reached — the cancellation route and the
 * ADR 0755 D3 token-less interrupt (readable, never answerable).
 *
 * ADR 1109 D1/D7 + ADR 1125 D1 (#5843): an unknown kind says what the step asks
 * with no kind name and no buttons; an approval is headed by the gate's own title;
 * a `credential` request opens the HOST connect route — the exact URL, built from the
 * run and node ids, in a `noopener,noreferrer` window — never the `connectUrl` in its
 * data. Sabotage (`w118g4-ri-*`): following `data.connectUrl`, an outside base, an
 * unencoded run id, dropping `noopener`, routing a kind to the wrong card, dropping the
 * token check, or showing the kind each turns its case red.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { resolveByRun } = vi.hoisted(() => ({ resolveByRun: vi.fn() }));
vi.mock('../../client/interruptsClient.js', () => ({ resolveByRun }));
const { beginOAuth, listProviders } = vi.hoisted(() => ({ beginOAuth: vi.fn(), listProviders: vi.fn(() => Promise.resolve([])) }));
vi.mock('../../features/connections/connectionsClient.js', () => ({ beginOAuth, listProviders }));

import { RenderInterrupt } from '../RenderInterrupt.js';
import { config } from '../../client/config.js';
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

  it('degrades gracefully on an unknown kind (no crash, neutral copy, no kind name)', () => {
    render(<MemoryRouter><RenderInterrupt runId="r" active={mk('low-confidence', {})} onResolved={() => {}} /></MemoryRouter>);
    // DEMO-14: neutral user-facing copy, never instructs the user to edit source
    // files. ADR 1125 D1: the kind is an engine word, so it is not shown.
    expect(screen.getByText(/This request can't be answered here/i)).toBeTruthy();
    expect(screen.queryByText(/low-confidence/)).toBeNull();
    expect(screen.queryByText(/RenderInterrupt\.tsx/)).toBeNull();
    // ADR 1109 D7 — a customer has no administrator to ask.
    expect(screen.queryByText(/administrator/i)).toBeNull();
  });

  it('an unknown kind still says what the step asks, and offers no buttons (ADR 1109 D7)', () => {
    render(<MemoryRouter><RenderInterrupt runId="r" active={mk('low-confidence', { title: 'Confirm the supplier', prompt: 'The quote changed since Monday.' })} onResolved={() => {}} /></MemoryRouter>);
    expect(screen.getByText('Confirm the supplier')).toBeTruthy();
    expect(screen.getByText('The quote changed since Monday.')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('a credential request offers Connect to the HOST route, never the URL in its data (ADR 1125 D1)', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    try {
      render(<RenderInterrupt runId="run 1" active={mk('credential', { provider: 'Google', connectUrl: 'https://evil.example/login', reason: 'missing' })} onResolved={() => {}} />);
      expect(screen.getByText(/needs access to/).textContent).toBe('This needs access to Google before it can continue.');
      expect(screen.queryByText(/evil\.example/)).toBeNull();
      screen.getByRole('button', { name: 'Connect' }).click();
      expect(open).toHaveBeenCalledTimes(1);
      const url = String(open.mock.calls[0]![0]);
      // The WHOLE URL: the configured API base (whatever this env sets) + the host route.
      // A suffix match would pass any origin in front of the path.
      expect(url).toBe(`${config.baseUrl.replace(/\/+$/, '')}/host/openwop-app/connections/connect/run%201/n1`);
      expect(url).not.toContain('evil.example');
      expect(open).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer');
    } finally {
      open.mockRestore();
    }
  });

  it('a credential request without a provider still reads as a sentence', () => {
    render(<RenderInterrupt runId="r" active={mk('credential', { connectUrl: 'https://evil.example/' })} onResolved={() => {}} />);
    expect(screen.getByText(/needs access to/).textContent).toBe('This needs access to an account before it can continue.');
  });

  it('an approval card is headed by the gate\'s own title (ADR 1109 D1)', () => {
    render(<RenderInterrupt runId="r" active={mk('approval', { title: 'Approve the launch brief', prompt: 'Check the tone.' })} onResolved={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Approve the launch brief' })).toBeTruthy();
    expect(screen.getByText('Check the tone.')).toBeTruthy();
  });

  it('an approval with no title keeps the generic heading', () => {
    render(<RenderInterrupt runId="r" active={mk('approval', { prompt: 'Approve?' })} onResolved={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Approval required' })).toBeTruthy();
  });
});
