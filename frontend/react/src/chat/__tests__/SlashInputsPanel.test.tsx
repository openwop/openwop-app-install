/**
 * ADR 0768 follow-up B2 — the inline `/workflow` inputs + "usually takes" line.
 * Pins: the form shows only for 2+ non-credential inputs; a credential input is
 * never a typed field; the estimate line comes from HISTORY only (a static
 * model-priced floor is never shown); the slug-keyed hand-off is one-shot.
 */
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k) }) }));
vi.mock('../lib/workflowMentions.js', () => ({
  detectWorkflowSlashMention: (text: string) => (/^\/brief\b/.test(text.trim())
    ? { entry: { slug: 'brief', workflowId: 'wf_brief', displayName: 'Brief', description: '', toolName: 'brief' }, trailing: null, agentSlug: null }
    : null),
}));
const inputs = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock('../../workflows/workflowsClient.js', () => ({ getWorkflowRunInputs: vi.fn(async () => inputs.value) }));
const est = vi.hoisted(() => ({ value: null as unknown, stats: { rowsConsidered: 0, truncated: false, sinceOldest: null, workflows: [] as unknown[] } }));
vi.mock('../../workflows/fleetInsightsClient.js', () => ({
  fetchWorkflowEstimate: vi.fn(async () => est.value),
  fetchFleetStats: vi.fn(async () => est.stats),
}));

import { SlashInputsPanel, type SlashInputsState } from '../SlashInputsPanel.js';
import { stageSlashInputs, takeStagedSlashInputs } from '../lib/slashInputs.js';

beforeEach(() => { inputs.value = []; est.value = null; est.stats = { rowsConsidered: 0, truncated: false, sinceOldest: null, workflows: [] }; });
afterEach(() => cleanup());

const two = [
  { name: 'topic', type: 'string', required: true },
  { name: 'audience', type: 'string', required: false },
  { name: 'credentialRef', type: 'string', required: false },
];

describe('SlashInputsPanel (ADR 0768 B2)', () => {
  it('renders the shared form for 2+ inputs, never the credential, and reports typed values', async () => {
    inputs.value = two;
    const onChange = vi.fn();
    render(<SlashInputsPanel text="/brief " onChange={onChange} />);
    const topic = await screen.findByLabelText(/Topic/);
    expect(screen.getByLabelText(/Audience/)).toBeTruthy();
    expect(screen.queryByLabelText(/Credential/i)).toBeNull();
    fireEvent.change(topic, { target: { value: 'tides' } });
    await waitFor(() => {
      const last = onChange.mock.calls.at(-1)![0] as SlashInputsState;
      expect(last.slug).toBe('brief');
      expect(last.values.topic).toBe('tides');
      expect(last.variables.map((v) => v.name)).toEqual(['topic', 'audience']);
    });
  });

  it('shows nothing for a one-input workflow with no history (trailing text still carries it)', async () => {
    inputs.value = [{ name: 'topic', type: 'string', required: true }, { name: 'credentialRef', required: false }];
    const onChange = vi.fn();
    const { container } = render(<SlashInputsPanel text="/brief " onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe('');
    expect(onChange.mock.calls.at(-1)![0]).toBeNull();
  });

  it('the usual line comes from history only — a static floor is never shown', async () => {
    inputs.value = [{ name: 'topic', required: true }];
    est.value = { static: { floorUsd: 0.02, aiNodes: 1, assumptions: {} } };
    const { container, unmount } = render(<SlashInputsPanel text="/brief" onChange={vi.fn()} />);
    await new Promise((r) => setTimeout(r, 10));
    expect(container.innerHTML).toBe('');
    unmount();

    est.value = { historical: { medianUsd: 0.04, p95Usd: 0.09, samples: 12 } };
    est.stats = { rowsConsidered: 12, truncated: false, sinceOldest: null, workflows: [{ workflowId: 'wf_brief', p50Ms: 42_000 }] };
    render(<SlashInputsPanel text="/brief" onChange={vi.fn()} />);
    const line = await screen.findByText(/slashUsualDuration/);
    expect(line.textContent).toContain('slashUsualCost');
    expect(line.textContent).toContain('"count":12');
  });

  it('is absent when the text is not a workflow command', () => {
    const { container } = render(<SlashInputsPanel text="hello" onChange={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('slashInputs hand-off', () => {
  it('is keyed by slug and one-shot', () => {
    stageSlashInputs('a', { x: 1 });
    expect(takeStagedSlashInputs('b')).toBeNull();
    expect(takeStagedSlashInputs('a')).toBeNull(); // a mismatched take still clears it
    stageSlashInputs('a', { x: 1 });
    expect(takeStagedSlashInputs('a')).toEqual({ x: 1 });
    expect(takeStagedSlashInputs('a')).toBeNull();
  });
});
