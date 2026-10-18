/**
 * ADR 0768 P1 — the three shared-seam upgrades: the Needs-you tray, the turn
 * receipt, and the composer sigil chips. Breaks if an open gate is missed,
 * mis-ordered or mis-named in the tray (or Review does not hand focus to the
 * inline card), a receipt hides a failed tool or invents a figure, or a chip
 * seeds the wrong text / position.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { count?: unknown }) => (o && o.count !== undefined ? `${k}:${String(o.count)}` : k),
  }),
}));

// The chips only SEED text; the pickers they open are exercised by their own
// suites. Stubbed so no picker fetches the agent/workflow catalog here.
// ADR 0784 — no effects known here, so the receipt keeps its neutral "N tools".
vi.mock('../lib/toolEffects.js', () => ({ useToolEffects: () => new Map() }));
vi.mock('../AgentMentionAutocomplete.js', () => ({ AgentMentionAutocomplete: () => null }));
vi.mock('../SlashAutocomplete.js', () => ({ SlashAutocomplete: () => null }));
vi.mock('../BoardMentionAutocomplete.js', () => ({ BoardMentionAutocomplete: () => null }));
// ChatInput warms the workflow cache on mount — not what these tests are about.
vi.mock('../lib/workflowMentions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/workflowMentions.js')>()),
  refreshWorkflowMentionCache: vi.fn(async () => undefined),
}));

import type { ChatMessage, WorkflowRunState } from '../types.js';
import type { OpenInterrupt } from '../../client/interruptsClient.js';
import { collectOpenInterrupts } from '../lib/openInterrupts.js';
import { NeedsYouTray } from '../NeedsYouTray.js';
import { TurnReceipt, summarizeTurn } from '../TurnReceipt.js';
import { ChatInput } from '../ChatInput.js';

function interrupt(id: string, nodeId: string): OpenInterrupt {
  return { interruptId: id, nodeId, kind: 'approval', data: {}, createdAt: '2026-09-28T10:00:00Z' };
}
function runMessage(id: string, interrupts: OpenInterrupt[]): ChatMessage {
  const workflowRun: WorkflowRunState = {
    slug: 'launch-plan', workflowName: 'Launch plan', workflowId: 'wf', runId: 'r1', status: 'running',
    totalNodes: 5, completedNodeIds: [], nodeOutputs: {}, failedNodeIds: [], currentNodeName: null,
    nodeNames: { send: 'Approve send' }, startedAt: '2026-09-28T10:00:00Z',
  };
  return { id, role: 'workflow_run', content: '', createdAt: '2026-09-28T10:00:00Z', activeInterrupts: interrupts, workflowRun };
}
function assistant(over: Partial<ChatMessage>): ChatMessage {
  return { id: 'a1', role: 'assistant', content: 'done', createdAt: '2026-09-28T10:00:00Z', ...over };
}
const call = (callId: string, error?: { code: string }) => ({ callId, toolName: 'documents.get', agentId: 'iris', startedAt: '2026-09-28T10:00:00Z', ...(error ? { error } : {}) });

describe('collectOpenInterrupts', () => {
  it('lists open interrupts newest message first, labelled with the gate name', () => {
    const out = collectOpenInterrupts([
      runMessage('m1', [interrupt('i1', 'send')]),
      assistant({ id: 'm2' }),
      runMessage('m3', [interrupt('i2', 'unnamed-node')]),
    ]);
    expect(out.map((e) => e.interruptId)).toEqual(['i2', 'i1']);
    expect(out[1]).toMatchObject({ messageId: 'm1', gateName: 'Approve send', workflowName: 'Launch plan' });
    expect(out[0]?.gateName).toBe('unnamed-node');
  });

  it('is empty when nothing is open', () => {
    expect(collectOpenInterrupts([assistant({}), runMessage('m', [])])).toEqual([]);
  });
});

describe('NeedsYouTray', () => {
  it('renders nothing without an open interrupt', () => {
    const { container } = render(<NeedsYouTray messages={[assistant({})]} />);
    expect(container.innerHTML).toBe('');
  });

  it('names the gate and moves focus to the inline card on Review', () => {
    render(
      <div>
        <div data-interrupt-id="i1" tabIndex={-1}>inline card</div>
        <NeedsYouTray messages={[runMessage('m1', [interrupt('i1', 'send')])]} />
      </div>,
    );
    expect(screen.getByRole('region', { name: 'needsYouRegion' })).toBeTruthy();
    expect(screen.getByText('Approve send')).toBeTruthy();
    expect(screen.getByText('needsYouEyebrow:1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'needsYouReview' }));
    expect(document.activeElement?.textContent).toBe('inline card');
  });

  it('counts the others when several gates are waiting', () => {
    render(<NeedsYouTray messages={[runMessage('m1', [interrupt('i1', 'send'), interrupt('i2', 'legal')])]} />);
    expect(screen.getByText('needsYouMore:1')).toBeTruthy();
  });
});

describe('TurnReceipt', () => {
  it('summarizes only what the turn can source', () => {
    const s = summarizeTurn(assistant({
      agentEvents: { toolCalls: [call('c1'), call('c2', { code: 'boom' })], handoffs: [], decisions: [] },
    }));
    expect(s).toMatchObject({ tools: 2, failedTools: 1, handoffs: 0, model: null, cost: null });
  });

  it('is absent on a plain turn with no events and no meta', () => {
    const { container } = render(<TurnReceipt message={assistant({})} />);
    expect(container.innerHTML).toBe('');
  });

  it('folds a healthy settled turn and unfolds on click', () => {
    render(<TurnReceipt message={assistant({ agentEvents: { toolCalls: [call('c1')], handoffs: [], decisions: [] } })} />);
    const toggle = screen.getByRole('button', { name: 'receiptShow' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('receiptTools:1')).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'receiptHide' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('never folds a failed tool away by default', () => {
    render(<TurnReceipt message={assistant({ agentEvents: { toolCalls: [call('c1', { code: 'boom' })], handoffs: [], decisions: [] } })} />);
    expect(screen.getByRole('button', { name: 'receiptHide' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('receiptFailed:1')).toBeTruthy();
  });

  it('keeps the source count for a turn with citations but no usage meta', () => {
    render(<TurnReceipt message={assistant({ meta: { citations: [{ url: 'https://example.com' }] } })} />);
    expect(screen.getByText('sources:1')).toBeTruthy();
  });

  it('labels a decisions-only turn instead of rendering a bare chevron', () => {
    render(<TurnReceipt message={assistant({ agentEvents: { toolCalls: [], handoffs: [], decisions: [{ agentId: 'iris', decision: 'go', at: '2026-09-28T10:00:00Z' }] } })} />);
    expect(screen.getByText('receiptDetails')).toBeTruthy();
  });

  it('stays open while the turn is streaming', () => {
    render(<TurnReceipt message={assistant({ isStreaming: true, agentEvents: { toolCalls: [call('c1')], handoffs: [], decisions: [] } })} />);
    expect(screen.getByRole('button', { name: 'receiptHide' }).getAttribute('aria-expanded')).toBe('true');
  });
});

describe('composer sigil chips', () => {
  const textarea = () => screen.getByRole('combobox', { name: 'composerAriaLabel' }) as HTMLTextAreaElement;

  it('seeds `/` on an empty message', async () => {
    render(<ChatInput onSend={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'sigilWorkflowAria' }));
    await waitFor(() => expect(textarea().value).toBe('/'));
  });

  it('seeds `/` after an @agent hand-off prefix', async () => {
    render(<ChatInput onSend={vi.fn()} />);
    fireEvent.change(textarea(), { target: { value: '@kai ' } });
    fireEvent.click(screen.getByRole('button', { name: 'sigilWorkflowAria' }));
    await waitFor(() => expect(textarea().value).toBe('@kai /'));
  });

  it('disables `/` once prose is typed, with a reason', () => {
    render(<ChatInput onSend={vi.fn()} />);
    fireEvent.change(textarea(), { target: { value: 'hello there' } });
    const btn = screen.getByRole('button', { name: 'sigilWorkflowAria' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe('sigilWorkflowBlockedTitle');
  });

  it('inserts `@` at the caret with a separating space', async () => {
    render(<ChatInput onSend={vi.fn()} />);
    // Caret mid-text (after "ask"), so insert-at-caret differs from append.
    fireEvent.change(textarea(), { target: { value: 'ask kai', selectionStart: 3, selectionEnd: 3 } });
    fireEvent.click(screen.getByRole('button', { name: 'sigilAgentAria' }));
    await waitFor(() => expect(textarea().value).toBe('ask @ kai'));
  });
});
