/**
 * ADR 1017 D2 — a chat turn shows the artifacts its tools saved, as cards under the
 * receipt that open in the Workbench.
 *
 * Why this exists: the Visualizer was told "the workbench renders it" and nothing in
 * the chat ever showed a chat-tool artifact; the only way to see one was /library.
 *
 * What breaks it: asking for the turn's artifacts with the wrong pair (not the turn's
 * own `turnRef`), asking while the turn still streams or when the chat tool failed
 * (a wasted read per bubble), rendering the cards INSIDE the collapsed fold, or a card
 * that does not open the artifact it shows.
 *
 * Sabotage-witnessed (wave 82): the swapped pair, each of the four gates of
 * "asks for nothing" (settled, tool error, tool id, Workbench), cards rendered only
 * when the fold is open, a card opening a different id, the raw subtitle, a failed
 * read folded into "ready, empty", and a retry that does not re-ask. The "asks for
 * nothing" case asserts `calls` after `waitFor`, whose act() scope flushes the
 * effect's dynamic import of the (mocked) client: each gate probe was red there, so
 * that wait is long enough as written.
 */
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: { count?: number }) => (o?.count !== undefined ? `${k}:${o.count}` : k) }) }));
vi.mock('../lib/toolEffects.js', () => ({ useToolEffects: () => new Map() }));
import type { RunArtifact } from '../RunArtifactCards.js';

const calls: Array<[string, string]> = [];
/** A production-shaped chat-viz row, as `GET /artifacts?conversationRunId=` answers it. */
const FLOW: RunArtifact = {
  artifactId: 'run-event:chat-viz:t:c:render:abc', tenantId: 't', orgId: 't', artifactTypeId: 'interactive.mermaid',
  source: 'run-event', sourceId: 'chat-viz:t:c:render:abc', title: 'Flow', kind: 'text', format: 'text/plain', status: 'final',
  createdBy: { kind: 'run', id: 'chat-viz:t:c' }, createdAt: '2026-10-31T10:00:01.000Z', provenance: { runId: 'chat-viz:t:c', nodeId: 'render:abc' },
  runNodeId: 'render:abc',
};
let failNext = false;
vi.mock('../artifacts/artifactClient.js', () => ({
  listChatTurnArtifacts: (runId: string, turnMessageId: string) => {
    calls.push([runId, turnMessageId]);
    if (failNext) { failNext = false; return Promise.reject(new Error('503')); }
    return Promise.resolve([FLOW]);
  },
}));

import { TurnReceipt } from '../TurnReceipt.js';
import { WorkbenchActionsContext } from '../workbench/workbenchActions.js';
import type { AgentToolCall, ChatMessage } from '../types.js';

const RENDER = 'openwop:interactive-artifacts.render';
const call = (toolName: string, extra: Partial<AgentToolCall> = {}): AgentToolCall => ({
  callId: 'c1', toolName, agentId: 'viz', startedAt: '2026-10-31T10:00:00.000Z', finishedAt: '2026-10-31T10:00:01.000Z', ...extra,
});
const TURN_REF = { conversationRunId: 'conv-run-1', turnMessageId: 'conv-run-1:gate:0:3:agent' };
const turn = (tc: AgentToolCall, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm', role: 'assistant', content: 'I made a flow diagram.', createdAt: '2026-10-31T10:00:02.000Z',
  turnRef: TURN_REF, agentEvents: { toolCalls: [tc], handoffs: [], decisions: [] }, ...extra,
});

let openArtifact: ReturnType<typeof vi.fn<(a: { artifactId: string }) => void>>;
const withWorkbench = (m: ChatMessage) => render(
  <WorkbenchActionsContext.Provider value={{ openSources: () => undefined, openArtifact }}>
    <TurnReceipt message={m} />
  </WorkbenchActionsContext.Provider>,
);

beforeEach(() => { calls.length = 0; failNext = false; openArtifact = vi.fn<(a: { artifactId: string }) => void>(); });
afterEach(cleanup);

describe('TurnReceipt — chat-tool artifacts (ADR 1017 D2)', () => {
  it('lists the turn\'s artifacts OUTSIDE the fold, asked for with the turn\'s own pair, and opens one in the Workbench', async () => {
    withWorkbench(turn(call(RENDER)));
    const card = await screen.findByText('Flow');
    expect(calls).toEqual([[TURN_REF.conversationRunId, TURN_REF.turnMessageId]]);
    // The receipt is collapsed for a healthy settled turn; the card is still visible.
    expect(screen.getByRole('button', { name: 'receiptShow' }).getAttribute('aria-expanded')).toBe('false');
    expect(card.closest('.turn-receipt')).toBeNull();
    // The subtitle is the localized TYPE, not the raw `kind · format` machine values.
    expect(screen.getByText('libraryType_diagram')).toBeTruthy();
    expect(screen.queryByText(/text\/plain/)).toBeNull();
    fireEvent.click(card);
    expect(openArtifact).toHaveBeenCalledWith({ artifactId: 'run-event:chat-viz:t:c:render:abc' });
  });

  it('asks for nothing while streaming, when the tool failed, for other tools, or without a Workbench', async () => {
    withWorkbench(turn(call(RENDER), { isStreaming: true }));
    withWorkbench(turn(call(RENDER, { error: { code: 'validation_error' } })));
    withWorkbench(turn(call('openwop:knowledge.search')));
    render(<TurnReceipt message={turn(call(RENDER))} />);
    await waitFor(() => expect(screen.getAllByText(/receiptTools/).length).toBeGreaterThan(0));
    expect(calls).toEqual([]);
    expect(screen.queryByText('Flow')).toBeNull();
  });

  it('a failed read is its own state with a retry, never a silently missing card', async () => {
    failNext = true;
    withWorkbench(turn(call(RENDER)));
    const retry = await screen.findByRole('button', { name: 'chatTurnArtifactsRetry' });
    expect(screen.getByText('chatTurnArtifactsFailed')).toBeTruthy(); // the failure is SAID, not just a button
    fireEvent.click(retry);
    expect(await screen.findByText('Flow')).toBeTruthy();
    expect(screen.queryByText('chatTurnArtifactsFailed')).toBeNull(); // and withdrawn once the retry lands
    expect(calls).toHaveLength(2);
  });
});
